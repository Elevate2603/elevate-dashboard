// netlify/functions/signal-scan.js
// Daily Mon-Fri Ontario hiring-signal scanner.
//
// Pre-fetches Job Bank Canada listing pages for high-signal role families
// (mgmt, engineering, production/skilled trades), strips HTML to text, then
// has Claude Haiku group postings by employer and score "hiring surge"
// signals — multiple roles, multiple locations, fresh dates.
//
// Why pre-fetch: tried web_search route first (3 rounds, Haiku) — kept
// returning 0 signals because the model bailed when extracting structured
// data from search snippets. Same fix tender-scan needed. Pre-fetching
// gives Claude clean tabular data to extract from, ~6-12s wall time.
//
// Returns: { ok, fetched_at, source, count, signals: [...] }
// Called by Make scenario 5323960, which iterates `signals` and upserts
// into datastore 97143 (elevate_pending_retrieval) with overwrite:false.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MODEL = process.env.SIGNAL_SCAN_MODEL || "claude-haiku-4-5-20251001";

// Job Bank Canada Ontario listings, last 7 days, sorted by date desc.
// Each page returns ~25 postings with employer + title + city + date — perfect
// for grouping by company to detect hiring surges.
// Elevate staffs EVERY role type, so scan across blue- AND white-collar families,
// not just production/warehouse. Score decides priority, not sector.
const SOURCES = [
  { name: "JobBank-Mgmt-Sup",     url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=manager+OR+supervisor+OR+director&locationstring=Ontario&fage=7&sort=D" },
  { name: "JobBank-Production",   url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=production+OR+assembler+OR+operator&locationstring=Ontario&fage=7&sort=D" },
  { name: "JobBank-Trades",       url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=millwright+OR+electrician+OR+welder+OR+maintenance&locationstring=Ontario&fage=7&sort=D" },
  { name: "JobBank-Warehouse",    url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=warehouse+OR+logistics+OR+shipping&locationstring=Ontario&fage=7&sort=D" },
  { name: "JobBank-Office-Admin", url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=administrative+OR+office+OR+clerk&locationstring=Ontario&fage=7&sort=D" },
  { name: "JobBank-Sales-CSR",    url: "https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=customer+service+OR+sales+OR+account+manager&locationstring=Ontario&fage=7&sort=D" },
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).health === "1") {
    return {
      statusCode: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        service: "signal-scan",
        hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
        model: MODEL,
        sources: SOURCES.map(s => s.name),
      }),
    };
  }
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: "Method not allowed" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonError(500, "ANTHROPIC_API_KEY not configured");
  }

  // Pre-fetch all source pages in parallel; strip to text; cap each page at
  // 18KB to keep total prompt under ~80KB.
  const fetched = await Promise.all(SOURCES.map(async (s) => {
    try {
      const r = await fetch(s.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Elevate signal-scan)" },
      });
      if (!r.ok) return { name: s.name, text: "", error: `HTTP ${r.status}` };
      const html = await r.text();
      return { name: s.name, text: stripHtml(html).slice(0, 11000) };
    } catch (e) {
      return { name: s.name, text: "", error: String(e && e.message || e) };
    }
  }));

  const context = fetched
    .filter(f => f.text)
    .map(f => `=== ${f.name} (${f.text.length} chars) ===\n${f.text}`)
    .join("\n\n");

  if (!context) {
    return jsonError(502, "All source pages failed to fetch", { fetched });
  }

  const prompt = buildPrompt(context);

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return jsonError(502, `Anthropic API unreachable: ${e && e.message || e}`);
  }

  if (!resp.ok) {
    const txt = await resp.text();
    return jsonError(502, `Anthropic returned ${resp.status}: ${txt.slice(0, 500)}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || []).filter(b => b.type === "text");
  const finalText = textBlocks.map(b => b.text).join("\n").trim();

  let parsed;
  try {
    let cleaned = finalText.replace(/```json|```/g, "").trim();
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
    parsed = JSON.parse(cleaned);
  } catch {
    return jsonError(502, "Could not parse signals JSON", { raw: finalText.slice(0, 800) });
  }

  if (!parsed || !Array.isArray(parsed.signals)) {
    return jsonError(502, "Signals JSON missing required shape", { got: Object.keys(parsed || {}) });
  }

  const signals = parsed.signals
    .filter(s => s && s.company_name)
    .map(s => {
      const slug = String(s.company_name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      return {
        signal_key: `signal-${slug}`,
        company_name: String(s.company_name || "").trim(),
        company_website: String(s.company_website || "").trim(),
        industry: String(s.industry || "").trim(),
        geography: String(s.geography || "Ontario").trim(),
        role_family: String(s.role_family || "").trim(),
        target_titles_json: String(s.target_titles_json || s.target_titles || "Plant Manager OR Operations Manager OR General Manager OR HR Manager OR Office Manager").trim(),
        signal_tag: String(s.signal_tag || "").trim(),
        pitch_angle: String(s.pitch_angle || "").trim(),
        why_now: String(s.why_now || "").trim(),
        score: Number(s.score) || 60,
        urgency: String(s.urgency || "immediate").trim(),
        action_deadline: String(s.action_deadline || "Within 14 days").trim(),
        trigger_phrase: `retrieve contacts for signal-${slug}`,
        requested_at: new Date().toISOString(),
        status: "pending",
        contacts_retrieved: 0,
      };
    })
    .slice(0, 12);

  const tokensUsed = (data.usage || {});
  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: SOURCES.map(s => s.name).join(" + "),
      model: MODEL,
      input_tokens: tokensUsed.input_tokens || 0,
      output_tokens: tokensUsed.output_tokens || 0,
      pages_fetched: fetched.filter(f => f.text).length,
      pages_failed: fetched.filter(f => !f.text).length,
      count: signals.length,
      signals,
    }),
  };
};

function jsonError(status, error, extra) {
  return {
    statusCode: status,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({ ok: false, error, ...(extra || {}) }),
  };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPrompt(context) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a labour-market analyst for Elevate Recruitment, a Windsor ON staffing agency. Today is ${today}.

Below are six pre-fetched Job Bank Canada Ontario listing pages from the last 7 days. Each lists ~25 currently-open postings with employer + title + city + date.

YOUR JOB: Group the postings by EMPLOYER. Identify companies showing a "hiring surge" — 2+ open postings, or a single strong role — and return up to 12 as JSON signals Elevate can pursue.

═══════════ WHAT ELEVATE STAFFS — ALL of it ═══════════
Elevate fills EVERY role type, in ANY sector. Blue-collar AND white-collar:
- Production, assembly, machine operators, general labour
- Skilled trades (millwright, electrician, welder, maintenance)
- Warehouse, logistics, shipping/receiving, drivers
- Customer service reps, call centre, sales, account management
- Administration, office, reception, clerical, data entry
- Supervisors, managers, plant/ops/general managers, directors, C-suite (CEO/COO/CFO/VP)
Our current sweet spot is production / warehouse / industrial / skilled trades, so weight those slightly higher — BUT DO NOT drop office, sales, customer service, professional, or leadership roles. A strong hiring surge in ANY of these is a real, valuable signal. Never discard a high-scoring company just because it isn't manufacturing.

═══════════ GEOGRAPHY (Ontario only) ═══════════
Anywhere in Ontario. Preferred corridors: Windsor-Essex, Brampton, Mississauga, Vaughan, Markham, Oakville, Bolton, Caledon, Halton Hills, Toronto, Hamilton, Kitchener-Waterloo-Cambridge, London, Niagara, Ottawa. Far-north (Thunder Bay, Sudbury, North Bay, Kenora, Timmins) is lower priority but still allowed if the signal is strong.

═══════════ ONLY skip these ═══════════
- Staffing agencies / recruiters (Randstad, Adecco, Aerotek, ASAP, Quantum, etc.) — they are competitors, never target them.
- A single generic franchise shift job with no real surge (one Tim Hortons / McDonald's / gas-station posting).
Everything else is fair game — including tech, finance, retail head offices, healthcare, professional services, public sector. INCLUDE them, especially with a strong surge. Let the SCORE reflect fit; do not exclude on sector.

═══════════ SCORING (0-100) — surge strength first, sector fit second ═══════════
- 80-100: 3+ open roles at one employer (ANY sector), OR a senior/leadership role at a strong-fit company, in a priority corridor.
- 65-79: 2 open roles at one employer, OR 1 senior role (manager / supervisor / director), any sector.
- 55-64: 1 solid role at a clear employer, any sector (production, warehouse, CSR, sales, admin, office, etc.).
- Core industrial / production / warehouse / trades fit: add a +5 to +10 bonus (our sweet spot) — but this is a bonus, NEVER the gate.
- Below 55: skip.

═══════════ OUTPUT — JSON object only ═══════════

{
  "signals": [
    {
      "company_name": "exact employer name from listing",
      "company_website": "leave blank if not in listing",
      "industry": "specific industry (e.g. 'Automotive Tier 1', 'Food Processing', '3PL Logistics', 'Financial Services', 'Retail HQ')",
      "geography": "City, Ontario",
      "role_family": "one of: Production, Skilled Trades, Warehouse/Logistics, Customer Service, Sales, Administration/Office, Management, Executive, Other",
      "target_titles_json": "who to EMAIL — the hiring decision-maker for that role family, joined with OR. Examples: production surge -> 'Plant Manager OR Production Manager OR Operations Manager'; customer-service surge -> 'Customer Service Manager OR Operations Manager OR HR Manager'; sales surge -> 'Sales Manager OR General Manager OR VP Sales'; office/admin -> 'Office Manager OR Operations Manager OR HR Manager'. NOT the posted role itself.",
      "signal_tag": "concise — e.g. 'Job Bank 3 open roles last 7d | Customer Service + Sales'",
      "pitch_angle": "2-3 sentence pitch — which roles Elevate fills for them, why now",
      "why_now": "concrete one-sentence catalyst (e.g. '4 postings last week across CSR and sales')",
      "score": 75,
      "urgency": "immediate or watch",
      "action_deadline": "Within 14 days OR Within 30 days"
    }
  ]
}

═══════════ RULES ═══════════
- Return 6-12 signals ordered by score descending. Include the strong non-industrial signals too — do NOT return an all-manufacturing list if the data has strong office/sales/service surges.
- company_name must be the exact specific real employer from a listing (no "various", no agencies/staffing firms).
- target_titles_json = the decision-maker to EMAIL for that function, NOT the posted role.
- Already-active in pipeline (prefer NOT but include if fresh signal): Stellantis, Magna, Martinrea, Multimatic, NEXTSTAR, Vuteq, Litens, Almag, Kromet, Mevotech, Husky Injection, Cyclic Materials, Quarterhill, Reliance Home Comfort, IESO

========== JOB BANK LISTINGS ==========

${context}

========== END LISTINGS ==========

Output ONLY the JSON. Start with { and end with }.`;
}
