// netlify/functions/signal-scan.js
// Daily Mon-Fri Ontario hiring-signal scanner for Elevate Recruitment.
// Uses Claude Haiku 4.5 + web_search to identify companies in Travis's geo
// (Windsor-Essex + 30km Brampton + GTA corridor) showing fresh hiring activity
// signals — job posting surges, expansion announcements, scoop-style 12-month
// highs in operations/engineering hiring.
//
// Returns: { ok, fetched_at, source, count, signals: [...] }
// Called by Make scenario "Elevate - Hiring Signal Scan (Mon-Fri)" which
// iterates the signals array and upserts into datastore 97143
// (elevate_pending_retrieval) with overwrite:false for dedup.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Haiku 4.5 fits comfortably under Netlify's 26s free-tier cap with web_search.
// Same model that powers market-hotspots and tender-scan reliably.
const MODEL = process.env.SIGNAL_SCAN_MODEL || "claude-haiku-4-5-20251001";

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
      }),
    };
  }
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: "Method not allowed" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonError(500, "ANTHROPIC_API_KEY not configured");
  }

  const prompt = buildPrompt();

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
        // 3 search rounds × ~4-5s + 3000 output tokens with Haiku = ~15-20s
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
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

  // Normalize for downstream Make scenario — signal_key derived from company slug
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
        target_titles_json: String(s.target_titles_json || s.target_titles || "Plant Manager OR Production Manager OR Operations Manager OR HR Manager OR Engineering Manager").trim(),
        signal_tag: String(s.signal_tag || "").trim(),
        pitch_angle: String(s.pitch_angle || "").trim(),
        why_now: String(s.why_now || "").trim(),
        score: Number(s.score) || 70,
        urgency: String(s.urgency || "immediate").trim(),
        action_deadline: String(s.action_deadline || "Within 14 days").trim(),
        trigger_phrase: `retrieve contacts for signal-${slug}`,
        requested_at: new Date().toISOString(),
        status: "pending",
        contacts_retrieved: 0,
      };
    })
    .slice(0, 10);

  const tokensUsed = (data.usage || {});
  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: "Job Bank Canada + Indeed + news (via Claude web search)",
      model: MODEL,
      input_tokens: tokensUsed.input_tokens || 0,
      output_tokens: tokensUsed.output_tokens || 0,
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

function buildPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a labour-market analyst for Elevate Recruitment, a Windsor ON staffing agency. Today is ${today}.

YOUR TASK: Use web_search (3 rounds) to identify CURRENT Ontario companies showing fresh HIRING SIGNALS — surging job posting counts, expansion announcements, plant ramps, leadership hiring pushes. Return up to 10 as JSON signals Elevate can pursue.

SEARCH STRATEGY — use these 3 queries (one per web_search round):
1. Ontario manufacturing hiring expansion 2026 site:linkedin.com OR site:thespec.com OR site:windsorstar.com OR site:cbc.ca
2. site:ca.indeed.com Ontario plant manager OR production manager OR engineering manager posted last 7 days
3. "now hiring" OR "hiring surge" OR "expanding workforce" Ontario auto manufacturing OR food processing OR logistics 2026

GEOGRAPHY PRIORITY: Windsor-Essex, Brampton corridor (Mississauga, Vaughan, Markham, Oakville, Bolton, Caledon, Halton Hills), Toronto core, Hamilton, Kitchener-Waterloo, London. SKIP far-north Ontario (Thunder Bay, Sudbury, Smooth Rock Falls, etc.).

INCLUDE these sectors: automotive Tier 1/2, EV/battery manufacturing, food & beverage processing, industrial machinery, logistics/warehousing/distribution, plastics/metal forming, aerospace, transportation services, waste management.

LABOUR TYPES Elevate places: skilled trades (electricians, millwrights, welders), production supervisors, plant/production managers, HR managers, engineering managers (mechanical, controls, manufacturing), warehouse/logistics, general labour, CSR/call centre, office/admin temp, custodial, food-mfg HACCP operators, AZ drivers, dispatchers.

SKIP COMPLETELY: pure tech/SaaS companies, financial services, healthcare clinics, retail stores, professional services (consulting/legal/accounting), construction firms, mining, oil & gas, anything outside Ontario.

OUTPUT — JSON object only, no markdown, no preamble:

{
  "signals": [
    {
      "company_name": "exact company name",
      "company_website": "https://...",
      "industry": "specific industry (e.g. 'Automotive Tier 1 / Metal Forming')",
      "geography": "City, Ontario",
      "target_titles_json": "Plant Manager OR Production Manager OR Operations Manager OR HR Manager OR Engineering Manager OR ...",
      "signal_tag": "concise tag — e.g. 'Indeed posting surge 2026-06 | 8+ active production roles | EV battery ramp'",
      "pitch_angle": "2-3 sentence pitch on how Elevate fits — what labour types, why now",
      "why_now": "concrete one-sentence catalyst (specific company event, contract, news)",
      "score": "0-100 integer (sector fit + geo + signal strength)",
      "urgency": "immediate or watch",
      "action_deadline": "Within 14 days OR Within 30 days"
    }
  ]
}

CRITICAL:
- Return up to 10 signals, ordered by score descending
- Score ≥ 55 minimum — anything below is junk
- Geography must be Ontario AND within the priority corridor above
- company_name must be a specific real company (NO generic "various manufacturers")
- BETTER TO RETURN 5 SOLID SIGNALS than 0 perfect ones. Travis triages on the dashboard — don't be over-conservative.
- Prefer companies NOT in this already-active list, but if a clearly fresh signal appears on one of these, still include it: Stellantis, Magna, Martinrea, Multimatic, NEXTSTAR, Vuteq, Litens, Almag, Kromet, Mevotech, Eclipse Automation, Husky Injection, Cyclic Materials, Quarterhill, Reliance Home Comfort, IESO.

Output ONLY the JSON. Start with { and end with }.`;
}
