// netlify/functions/scribe.js
// SCRIBE — reads RCRM (and later Outlook) to compute the four follow-up lists:
//   A. In sequence, awaiting first reply       (partial without Outlook)
//   B. Live conversations, waiting on them     (needs Outlook — empty for now)
//   C. Clients gone quiet                      (RCRM only — works today)
//   D. Stalled prospects to revive             (needs Outlook — empty for now)
//
// Pulled by the dashboard once on load (and on refresh). Cached in jrvState.followUps,
// fed to the brain as context, surfaced in the daily report's CLIENT FOLLOW-UPS section.
//
// Required Netlify env vars:
//   RCRM_BEARER_TOKEN  — RecruitCRM REST API token (same one used by Make Approval Handler)
//
// Optional (Phase 3 Chunk 1 — when Travis sets up Microsoft Entra):
//   OUTLOOK_CLIENT_ID, OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_SECRET

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const RCRM_BASE = "https://api.recruitcrm.io/v1";
const STALE_DAYS = 21;     // List C threshold — clients gone quiet
const ACTIVE_CLIENT_LIST = "166186"; // per CLAUDE.md — Active Client list ID in RCRM
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;       // safety cap so a single call doesn't burn all rate budget

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (!process.env.RCRM_BEARER_TOKEN) {
    return jsonResp(500, {
      error: "RCRM_BEARER_TOKEN not configured",
      hint: "Add RCRM_BEARER_TOKEN in Netlify → Site configuration → Environment variables. Same token Make scenarios use. Trigger a redeploy after saving.",
      ok: false,
    });
  }
  try {
    const asOf = new Date().toISOString();
    const [listC, listAPartial] = await Promise.all([
      computeListC_clientsGoneQuiet(),
      computeListA_inSequencePartial(),
    ]);
    return jsonResp(200, {
      ok: true,
      asOf,
      lists: {
        A: listAPartial, // partial — accurate count, no reply detection yet
        B: { items: [], note: "Live conversations require Outlook integration (Phase 3 Chunk 1)." },
        C: listC,
        D: { items: [], note: "Stalled-prospect revive list requires Outlook integration (Phase 3 Chunk 1)." },
      },
    });
  } catch (e) {
    return jsonResp(500, { error: "SCRIBE failed", detail: String(e && e.message || e), ok: false });
  }
};

// ── List C: Clients gone quiet ─────────────────────────────────────────
// Active-Client list members where last RCRM activity is older than STALE_DAYS.
async function computeListC_clientsGoneQuiet() {
  const contacts = await rcrmListContacts({ listId: ACTIVE_CLIENT_LIST });
  const now = Date.now();
  const thresholdMs = STALE_DAYS * 86400000;
  const items = [];
  for (const c of contacts) {
    const lastTs = parseLastActivity(c);
    if (lastTs == null) continue;
    const ageDays = Math.floor((now - lastTs) / 86400000);
    if (ageDays < STALE_DAYS) continue;
    items.push({
      contact_id: c.id || c.slug || null,
      slug: c.slug || null,
      name: composeName(c),
      email: c.email || null,
      company_name: (c.related_company && c.related_company.company_name) || c.company_name || null,
      last_activity_date: c.last_activity_date || c.last_communication || c.updated_at || null,
      days_since: ageDays,
    });
  }
  items.sort((a, b) => b.days_since - a.days_since);
  return {
    items: items.slice(0, 50),
    total: items.length,
    threshold_days: STALE_DAYS,
    note: items.length ? "Clients with no activity logged in 3+ weeks" : "All clear — every active client has been touched within 3 weeks",
  };
}

// ── List A: In sequence, awaiting first reply (partial) ────────────────
// Without Outlook we can't confirm "no reply" — but we CAN list everyone currently
// in a sequence as a rough A-list. Full filtering to "no human reply yet" comes
// once Outlook is wired.
async function computeListA_inSequencePartial() {
  // Pull contacts. RCRM doesn't expose "in_sequence" as a top-level list filter
  // in the public REST, so we filter client-side off the contact records.
  const contacts = await rcrmListContacts({});
  const items = contacts
    .filter(c => c.current_active_sequence || c.in_sequence || c.sequence_id)
    .map(c => ({
      contact_id: c.id || c.slug || null,
      slug: c.slug || null,
      name: composeName(c),
      email: c.email || null,
      company_name: (c.related_company && c.related_company.company_name) || c.company_name || null,
      active_sequence: c.current_active_sequence || c.active_sequence_name || null,
      enrolled_at: c.sequence_enrolled_at || c.last_sequence_event_at || null,
    }));
  return {
    items: items.slice(0, 50),
    total: items.length,
    note: "Counts of contacts currently in a sequence. Real 'no human reply' filtering arrives with Outlook (Phase 3 Chunk 2).",
  };
}

// ── RCRM helpers ───────────────────────────────────────────────────────
async function rcrmListContacts({ listId } = {}) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
    if (listId) params.set("list_id", String(listId));
    const url = `${RCRM_BASE}/contacts?${params.toString()}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
    if (!r.ok) {
      // First-page failure is fatal; later-page failure is treated as "end of pagination"
      if (page === 1) throw new Error(`RCRM /contacts returned ${r.status}: ${(await r.text()).slice(0, 240)}`);
      break;
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.data || data.results || data.contacts || []);
    if (!arr.length) break;
    all.push(...arr);
    if (arr.length < PAGE_LIMIT) break; // no more pages
  }
  return all;
}

function parseLastActivity(c) {
  const raw = c.last_activity_date || c.last_communication || c.updated_at || c.last_engagement_at;
  if (!raw) return null;
  const t = Date.parse(raw);
  return isNaN(t) ? null : t;
}

function composeName(c) {
  const first = c.first_name || c.firstname || "";
  const last = c.last_name || c.lastname || "";
  const full = (first + " " + last).trim();
  return full || c.full_name || c.name || "(no name)";
}

function jsonResp(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) };
}
