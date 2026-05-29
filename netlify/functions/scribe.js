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
// Active Client signal — value of the off_limit_status_id field on the contact
// or related company record. NOT a List ID (we tried that — RCRM's API ignores
// list_id query params anyway). 166186 = "Active Client" off-limit status.
const ACTIVE_CLIENT_OFF_LIMIT_ID = "166186";
// Match RCRM whether the field comes back as a string or a number, on either
// the contact directly or via its related_company nesting.
function isActiveClient(c) {
  if (!c) return false;
  const wanted = ACTIVE_CLIENT_OFF_LIMIT_ID;
  const candidates = [
    c.off_limit_status_id,
    c.off_limit_status && c.off_limit_status.id,
    c.related_company && c.related_company.off_limit_status_id,
    c.related_company && c.related_company.off_limit_status && c.related_company.off_limit_status.id,
    c.current_position && c.current_position.off_limit_status_id,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    if (String(v) === wanted) return true;
  }
  return false;
}
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;       // safety cap so a single call doesn't burn all rate budget

const OUTLOOK_USER = process.env.OUTLOOK_USER_EMAIL || "touellette@teamelevate.ca";
const OUTLOOK_LOOKBACK_DAYS = 90; // pull last 90 days of mail to merge with RCRM activity

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
    // ?debug=fields=1 returns just the field NAMES on the first contact — useful for finding
    //   the right list-membership field once we hit the live data.
    const params = new URLSearchParams(event.rawQuery || (event.queryStringParameters ? new URLSearchParams(event.queryStringParameters).toString() : ""));
    if (params.get("debug") === "1") {
      const r = await fetch(`${RCRM_BASE}/contacts?page=1&limit=2`, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
      const body = await r.text();
      return jsonResp(200, { ok: true, status: r.status, body: safeJSON(body) });
    }
    if (params.get("debug") === "fields") {
      const r = await fetch(`${RCRM_BASE}/contacts?page=1&limit=1`, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
      const data = await r.json();
      const first = (Array.isArray(data) ? data : (data.data || data.results || data.contacts || []))[0];
      if (!first) return jsonResp(200, { ok: true, fields: [] });
      const fieldShape = {};
      for (const k of Object.keys(first)) {
        const v = first[k];
        fieldShape[k] = Array.isArray(v) ? `array(len=${v.length})` : (v === null ? "null" : typeof v);
      }
      return jsonResp(200, { ok: true, fields: fieldShape, sample_keys: Object.keys(first).sort() });
    }
    if (params.get("debug") === "fields-co") {
      const r = await fetch(`${RCRM_BASE}/companies?page=1&limit=1`, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
      const data = await r.json();
      const first = (Array.isArray(data) ? data : (data.data || data.results || data.companies || []))[0];
      if (!first) return jsonResp(200, { ok: true, fields: [] });
      const fieldShape = {};
      for (const k of Object.keys(first)) {
        const v = first[k];
        fieldShape[k] = Array.isArray(v) ? `array(len=${v.length})` : (v === null ? "null" : typeof v);
      }
      // Also dump the actual values for the off_limit-ish fields so we can see what they hold
      const offLimitValues = {};
      for (const k of Object.keys(first)) if (/off.?limit/i.test(k)) offLimitValues[k] = first[k];
      return jsonResp(200, { ok: true, fields: fieldShape, sample_keys: Object.keys(first).sort(), off_limit_values: offLimitValues });
    }
    if (params.get("debug") === "active") {
      // Run the full active-client pull and return diagnostic info only — no rollup
      const cos = await rcrmListCompanies();
      const sample = cos.find(c => isActiveClient(c)) || cos[0] || null;
      const flagged = cos.filter(c => isActiveClient(c));
      return jsonResp(200, {
        ok: true,
        total_companies: cos.length,
        active_client_companies: flagged.length,
        sample_active: flagged.slice(0, 3).map(c => ({ slug: c.slug, name: c.company_name || c.name, off_limit_status_id: c.off_limit_status_id })),
        first_company_off_limit_fields: sample ? Object.keys(sample).filter(k => /off.?limit/i.test(k)).reduce((acc, k) => { acc[k] = sample[k]; return acc; }, {}) : null,
      });
    }

    const asOf = new Date().toISOString();
    // off_limit_status_id lives on the COMPANY record (not the contact), so we pull
    // both endpoints. Companies give us the authoritative Active-Client membership;
    // contacts give us the activity history we roll up per company.
    const [allContacts, allCompanies, outlookActivity] = await Promise.all([
      rcrmListContacts({}),
      rcrmListCompanies().catch(e => { console.warn("[SCRIBE] companies pull failed:", e && e.message); return []; }),
      pullOutlookActivity().catch(e => ({ error: String(e && e.message || e), byEmail: new Map() })),
    ]);
    const outlookByEmail = outlookActivity.byEmail || new Map();
    const outlookErr = outlookActivity.error || null;

    // Build slug → activeClient lookup from companies
    const activeBySlug = new Map();
    const activeByName = new Map();
    for (const co of allCompanies) {
      if (!isActiveClient(co)) continue;
      if (co.slug) activeBySlug.set(co.slug, co);
      const name = (co.company_name || co.name || "").trim().toLowerCase();
      if (name) activeByName.set(name, co);
    }

    const listC = computeListC_clientsGoneQuiet(allContacts, outlookByEmail);
    const listAPartial = computeListA_inSequencePartial(allContacts);
    const activeClientResult = computeActiveClients(allContacts, outlookByEmail, { activeBySlug, activeByName });

    return jsonResp(200, {
      ok: true,
      asOf,
      totalContactsScanned: allContacts.length,
      activeClientsScanned: activeClientResult.scanned,
      outlook: {
        connected: !outlookErr && outlookActivity.totalMessages > 0,
        totalMessagesPulled: outlookActivity.totalMessages || 0,
        lookbackDays: OUTLOOK_LOOKBACK_DAYS,
        error: outlookErr,
      },
      lists: {
        A: listAPartial,
        B: { items: [], note: "Live conversations: pending Outlook reply-detection layer (next pass)." },
        C: listC,
        D: { items: [], note: "Stalled-prospect revive list: pending Outlook reply-detection layer." },
      },
      activeClients: activeClientResult.rows,
      activeClientsDiagnostic: activeClientResult.diagnostic,
    });
  } catch (e) {
    return jsonResp(500, { error: "SCRIBE failed", detail: String(e && e.message || e), ok: false });
  }
};

function safeJSON(s) { try { return JSON.parse(s); } catch { return s; } }

// ── List C: Companies gone quiet ───────────────────────────────────────
// Company-level aggregation — a company only counts as "gone quiet" if its
// MOST RECENT contact activity (across ALL its contacts) is older than
// STALE_DAYS. As long as Travis has talked to anyone at the company recently,
// the company is fine. Returns company-centric rows, not contact rows.
function computeListC_clientsGoneQuiet(contacts, outlookByEmail) {
  const now = Date.now();
  outlookByEmail = outlookByEmail || new Map();
  const byCompany = new Map();

  function registerActivity(company, contactInfo) {
    if (!byCompany.has(company)) byCompany.set(company, { company_name: company, contacts: [], most_recent: null });
    const bucket = byCompany.get(company);
    bucket.contacts.push(contactInfo);
    if (!bucket.most_recent || contactInfo.activity_ts > bucket.most_recent.activity_ts) {
      bucket.most_recent = {
        contact_name: contactInfo.name,
        contact_email: contactInfo.email,
        contact_slug: contactInfo.slug || null,
        activity_ts: contactInfo.activity_ts,
        activity_type: contactInfo.activity_type,
        activity_source: contactInfo.activity_source, // "RCRM" or "Outlook"
      };
    }
  }

  for (const c of contacts) {
    const company = extractCompany(c);
    if (!company) continue;
    const email = (c.email || "").toLowerCase().trim();

    // RCRM logged activity
    const parsed = parseActivity(c);
    if (parsed.ts != null) {
      registerActivity(company, {
        name: composeName(c), email, slug: c.slug || null,
        activity_ts: parsed.ts, activity_type: parsed.type, activity_source: "RCRM",
      });
    }

    // Outlook activity for this contact's email (sent OR received-from)
    if (email && outlookByEmail.has(email)) {
      const ob = outlookByEmail.get(email);
      registerActivity(company, {
        name: composeName(c), email, slug: c.slug || null,
        activity_ts: ob.ts, activity_type: ob.direction === "out" ? "Outlook-sent" : "Outlook-received",
        activity_source: "Outlook",
      });
    }
  }

  const items = [];
  for (const bucket of byCompany.values()) {
    if (!bucket.most_recent) continue;
    const ageDays = Math.floor((now - bucket.most_recent.activity_ts) / 86400000);
    if (ageDays < STALE_DAYS) continue;
    items.push({
      company_name: bucket.company_name,
      contacts_count: bucket.contacts.length,
      most_recent_contact: bucket.most_recent.contact_name,
      most_recent_email: bucket.most_recent.contact_email,
      most_recent_activity_type: bucket.most_recent.activity_type,
      most_recent_activity_source: bucket.most_recent.activity_source,
      most_recent_activity_ts: bucket.most_recent.activity_ts,
      days_since: ageDays,
    });
  }
  items.sort((a, b) => b.days_since - a.days_since);
  return {
    items: items.slice(0, 30),
    total: items.length,
    threshold_days: STALE_DAYS,
    note: items.length
      ? `Companies where MAX(RCRM activity, Outlook activity) is ${STALE_DAYS}+ days old. Joins RCRM + Outlook so an unlogged Outlook email still counts as touching the company.`
      : "All clear — every company touched recently across RCRM + Outlook",
  };
}

// Active Client traffic-light feed — one row per company with days_since_last_contact
// and the most recent contact's name/role/channel. Drives the jrv-ac- component on
// the dashboard. Filters by off_limit_status_id == 166186 (Active Client) on each
// contact or its related_company. Joins Outlook activity so an unlogged email
// still counts as a recent touch on the company.
function computeActiveClients(allContacts, outlookByEmail, lookup) {
  outlookByEmail = outlookByEmail || new Map();
  lookup = lookup || { activeBySlug: new Map(), activeByName: new Map() };
  const now = Date.now();
  const byCompany = new Map();
  let matched = 0;

  // Pre-seed buckets from the companies endpoint so every Active Client appears
  // even if there are no logged contacts/activity yet (otherwise they'd be invisible).
  for (const co of lookup.activeBySlug.values()) {
    const key = co.slug.toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, {
      slug: co.slug,
      name: (co.company_name || co.name || "(no name)").trim(),
      most_recent: null,
    });
  }

  for (const c of allContacts) {
    const companySlug = (c.related_company && c.related_company.slug) || c.company_slug || null;
    const companyName = (extractCompany(c) || "").trim();
    // A contact counts if EITHER it carries off_limit_status_id directly, OR its
    // company is in the active-client lookup we built from /v1/companies.
    const companyMatch = (companySlug && lookup.activeBySlug.has(companySlug))
                      || (companyName && lookup.activeByName.has(companyName.toLowerCase()));
    if (!isActiveClient(c) && !companyMatch) continue;
    matched++;
    if (!companyName) continue;
    const key = (companySlug || companyName).toLowerCase();

    if (!byCompany.has(key)) byCompany.set(key, { slug: companySlug, name: companyName, most_recent: null });
    const bucket = byCompany.get(key);
    if (!bucket.slug && companySlug) bucket.slug = companySlug;

    const rcrm = parseActivity(c);
    if (rcrm.ts != null) {
      registerContact(bucket, {
        firstName: c.first_name || c.firstname || "",
        lastName:  c.last_name  || c.lastname  || "",
        role: c.designation || c.position || c.title || "",
        channel: (rcrm.type || "").toLowerCase() || "note",
        ts: rcrm.ts,
      });
    }
    const email = (c.email || "").toLowerCase().trim();
    if (email && outlookByEmail.has(email)) {
      const ob = outlookByEmail.get(email);
      registerContact(bucket, {
        firstName: c.first_name || c.firstname || "",
        lastName:  c.last_name  || c.lastname  || "",
        role: c.designation || c.position || c.title || "",
        channel: "email",
        ts: ob.ts,
      });
    }
  }

  function registerContact(bucket, candidate) {
    if (!bucket.most_recent || candidate.ts > bucket.most_recent.ts) bucket.most_recent = candidate;
  }

  const rows = [];
  for (const bucket of byCompany.values()) {
    const mr = bucket.most_recent;
    const daysSinceContact = mr ? Math.floor((now - mr.ts) / 86400000) : null;
    rows.push({
      slug: bucket.slug,
      name: bucket.name,
      daysSinceContact,
      lastContact: mr ? { firstName: mr.firstName, lastName: mr.lastName, role: mr.role, channel: mr.channel } : null,
    });
  }
  rows.sort((a, b) => {
    const da = (typeof a.daysSinceContact === "number") ? a.daysSinceContact : -1;
    const db = (typeof b.daysSinceContact === "number") ? b.daysSinceContact : -1;
    return db - da;
  });
  return {
    rows,
    scanned: matched,
    diagnostic: `companies-flagged=${lookup.activeBySlug.size} · contacts-matched=${matched} · unique-companies-shown=${rows.length}. If still empty, hit /scribe?debug=fields-co to inspect company shape.`,
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
async function rcrmListCompanies() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${RCRM_BASE}/companies?page=${page}&limit=${PAGE_LIMIT}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.RCRM_BEARER_TOKEN}` } });
    if (!r.ok) {
      if (page === 1) throw new Error(`RCRM /companies returned ${r.status}: ${(await r.text()).slice(0, 240)}`);
      break;
    }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.data || data.results || data.companies || []);
    if (!arr.length) break;
    all.push(...arr);
    if (arr.length < PAGE_LIMIT) break;
  }
  return all;
}

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

// ── Outlook via Microsoft Graph (Phase 3 Chunk 1) ──────────────────────
// App-only token via client credentials. Pulls SENT items (Travis's outreach) and
// RECEIVED items (replies + auto-replies). Returns a per-email map of the most
// recent activity timestamp + direction — joined into List C aggregation so
// unlogged Outlook activity still counts as touching a company.
async function pullOutlookActivity() {
  const tenant = process.env.OUTLOOK_TENANT_ID;
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const secret = process.env.OUTLOOK_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) {
    return { byEmail: new Map(), totalMessages: 0, error: null }; // silent skip when not configured
  }
  // Token
  const tokenResp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    throw new Error(`Outlook token request failed (${tokenResp.status}): ${errBody.slice(0, 240)}`);
  }
  const tokenData = await tokenResp.json();
  const token = tokenData.access_token;
  if (!token) throw new Error("Outlook token response had no access_token");

  const cutoffIso = new Date(Date.now() - OUTLOOK_LOOKBACK_DAYS * 86400000).toISOString();
  // Pull SENT items (outbound) — these are Travis touching companies
  const sentMsgs = await graphFetchAll(token, `/v1.0/users/${encodeURIComponent(OUTLOOK_USER)}/mailFolders/SentItems/messages?$top=200&$select=toRecipients,subject,sentDateTime&$filter=sentDateTime ge ${cutoffIso}&$orderby=sentDateTime desc`);
  // Pull INBOX messages (received) — count only human, not auto-replies
  const inboxMsgs = await graphFetchAll(token, `/v1.0/users/${encodeURIComponent(OUTLOOK_USER)}/mailFolders/Inbox/messages?$top=200&$select=from,subject,receivedDateTime,internetMessageHeaders&$filter=receivedDateTime ge ${cutoffIso}&$orderby=receivedDateTime desc`);

  const byEmail = new Map(); // email (lower) -> { ts, direction, subject }
  function note(email, ts, direction, subject) {
    if (!email) return;
    const key = email.toLowerCase().trim();
    const prev = byEmail.get(key);
    if (!prev || ts > prev.ts) byEmail.set(key, { ts, direction, subject });
  }
  for (const m of sentMsgs) {
    const ts = Date.parse(m.sentDateTime || "");
    if (isNaN(ts)) continue;
    const recipients = Array.isArray(m.toRecipients) ? m.toRecipients : [];
    for (const r of recipients) {
      const addr = r && r.emailAddress && r.emailAddress.address;
      if (addr) note(addr, ts, "out", m.subject || "");
    }
  }
  for (const m of inboxMsgs) {
    if (isAutoReply(m)) continue; // auto-replies don't count as touching activity
    const ts = Date.parse(m.receivedDateTime || "");
    if (isNaN(ts)) continue;
    const fromAddr = m.from && m.from.emailAddress && m.from.emailAddress.address;
    if (fromAddr) note(fromAddr, ts, "in", m.subject || "");
  }
  return { byEmail, totalMessages: sentMsgs.length + inboxMsgs.length, error: null };
}

async function graphFetchAll(token, path) {
  let url = `https://graph.microsoft.com${path}`;
  const all = [];
  for (let i = 0; i < 5; i++) { // cap pages so a single call can't run away
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Graph ${path.slice(0, 60)}... returned ${r.status}: ${t.slice(0, 240)}`);
    }
    const data = await r.json();
    if (Array.isArray(data.value)) all.push(...data.value);
    if (!data["@odata.nextLink"]) break;
    url = data["@odata.nextLink"];
  }
  return all;
}

// Auto-reply heuristic — headers first (most reliable), then subject patterns.
// Body patterns + Claude judging are saved for a future pass.
function isAutoReply(msg) {
  const headers = Array.isArray(msg.internetMessageHeaders) ? msg.internetMessageHeaders : [];
  for (const h of headers) {
    const name = (h.name || "").toLowerCase();
    const value = (h.value || "").toLowerCase();
    if (name === "auto-submitted" && /auto-(replied|generated)/.test(value)) return true;
    if (name === "x-autoreply" || name === "x-autorespond") return true;
    if (name === "precedence" && /(auto_reply|bulk)/.test(value)) return true;
  }
  const subj = (msg.subject || "").toLowerCase();
  if (/automatic reply|out of office|out-of-office|autoresponder|away from (the )?office/i.test(subj)) return true;
  return false;
}

function jsonResp(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) };
}
