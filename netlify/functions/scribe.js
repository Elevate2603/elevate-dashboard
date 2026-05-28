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
    // ?debug=1 returns the raw first-page RCRM response so we can see the actual contact shape
    const params = new URLSearchParams(event.rawQuery || (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : ""));
    if (params.get("debug") === "1") {
      const r = await fetch(`${RCRM_BASE}/contacts?page=1&limit=2`, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
      const body = await r.text();
      return jsonResp(200, { ok: true, status: r.status, body: safeJSON(body) });
    }

    const asOf = new Date().toISOString();
    const allContacts = await rcrmListContacts({});
    const [listC, listAPartial] = await Promise.all([
      Promise.resolve(computeListC_clientsGoneQuiet(allContacts)),
      Promise.resolve(computeListA_inSequencePartial(allContacts)),
    ]);
    return jsonResp(200, {
      ok: true,
      asOf,
      totalContactsScanned: allContacts.length,
      lists: {
        A: listAPartial,
        B: { items: [], note: "Live conversations require Outlook integration (Phase 3 Chunk 1)." },
        C: listC,
        D: { items: [], note: "Stalled-prospect revive list requires Outlook integration (Phase 3 Chunk 1)." },
      },
    });
  } catch (e) {
    return jsonResp(500, { error: "SCRIBE failed", detail: String(e && e.message || e), ok: false });
  }
};

function safeJSON(s) { try { return JSON.parse(s); } catch { return s; } }

// ── List C: Clients gone quiet ─────────────────────────────────────────
// Contacts where last RCRM activity is older than STALE_DAYS. Note: RCRM's
// /v1/contacts?list_id= filter doesn't reliably honor list scoping in the public
// REST, so this currently scans all contacts. Brain prompt limits output to top 2-3
// in the daily report so noise doesn't matter much in practice.
function computeListC_clientsGoneQuiet(contacts) {
  const now = Date.now();
  const items = [];
  for (const c of contacts) {
    const parsed = parseActivity(c);
    if (parsed.ts == null) continue;
    const ageDays = Math.floor((now - parsed.ts) / 86400000);
    if (ageDays < STALE_DAYS) continue;
    items.push({
      contact_id: c.id || c.slug || null,
      slug: c.slug || null,
      name: composeName(c),
      email: c.email || null,
      company_name: extractCompany(c),
      last_activity_type: parsed.type, // "Email" / "Call" / "Note" / etc
      last_activity_date: c.last_activity_date || c.last_communication || c.updated_at || null,
      days_since: ageDays,
    });
  }
  items.sort((a, b) => b.days_since - a.days_since);
  return {
    items: items.slice(0, 30),
    total: items.length,
    threshold_days: STALE_DAYS,
    note: items.length
      ? `Contacts with no activity in ${STALE_DAYS}+ days (top 30 returned, sorted by silence length). Note: includes prospects, not just active clients — RCRM list filter doesn't reliably scope in the REST API yet.`
      : "All clear — every contact touched recently",
  };
}

function computeListA_inSequencePartial(contacts) {
  const items = contacts
    .filter(c => c.current_active_sequence || c.in_sequence || c.sequence_id || c.active_sequence)
    .map(c => ({
      contact_id: c.id || c.slug || null,
      slug: c.slug || null,
      name: composeName(c),
      email: c.email || null,
      company_name: extractCompany(c),
      active_sequence: c.current_active_sequence || c.active_sequence_name || c.active_sequence || null,
      enrolled_at: c.sequence_enrolled_at || c.last_sequence_event_at || null,
    }));
  return {
    items: items.slice(0, 30),
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

// Parse the activity field which RCRM returns as "Email on 2025-10-21 15:28:22".
// Returns { type, ts } — type is "Email"/"Call"/"Note"/"" and ts is unix ms or null.
function parseActivity(c) {
  const raw = c.last_activity_date || c.last_communication || c.updated_at || c.last_engagement_at || "";
  if (!raw) return { type: "", ts: null };
  // Match e.g. "Call on 2024-09-13 13:30:00" or just "2024-09-13T..."
  const m = String(raw).match(/^([A-Za-z]+)\s+on\s+(.+)$/);
  if (m) {
    const t = Date.parse(m[2]);
    return { type: m[1], ts: isNaN(t) ? null : t };
  }
  const t = Date.parse(raw);
  return { type: "", ts: isNaN(t) ? null : t };
}

function composeName(c) {
  const first = c.first_name || c.firstname || "";
  const last = c.last_name || c.lastname || "";
  const full = (first + " " + last).trim();
  return full || c.full_name || c.name || "(no name)";
}

// Try many candidate company fields. Falls back to capitalized email domain so
// records aren't shown as "(no co)" when company isn't returned by the API.
function extractCompany(c) {
  const candidates = [
    c.company_name,
    c.company,
    c.current_company,
    c.current_employee_company_name,
    c.position_company,
    c.related_company && c.related_company.company_name,
    c.related_company && c.related_company.name,
    c.organization_name,
    c.organization && c.organization.name,
  ];
  for (const v of candidates) if (v && typeof v === "string" && v.trim()) return v.trim();
  // Email-domain fallback
  if (c.email) {
    const m = String(c.email).match(/@([^.]+)\./);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  }
  return null;
}

function jsonResp(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) };
}
