// netlify/functions/market-hotspots.js
// Live Ontario hiring intel — Claude w/ web_search tool researches Job Bank Canada,
// Indeed, and recent news to surface real hiring hotspots and the roles in demand.
//
// Returns:
//   { ok: true, fetched_at, source, areas: [...], roles: [...] }
//
// Frontend caches result in localStorage for 24h. This function only needs to run
// on a manual refresh or when the cache is cold/stale.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Haiku 4.5 has higher TPM rate limits than Sonnet/Opus at the same tier, and the
// task is essentially "extract + format" — web_search returns the actual data, the
// model just needs to organize it into the JSON shape. Haiku is fine for that and
// keeps cost down for daily refreshes.
const MODEL = process.env.MARKET_INTEL_MODEL || "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).health === "1") {
    return {
      statusCode: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        service: "market-hotspots",
        hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
        model: MODEL,
      }),
    };
  }
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS, body: "Method not allowed" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
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
        max_tokens: 2500,
        // Web search results are large (~3-5K tokens each). Capping at 3 keeps us
        // under the org's 30K input-tokens-per-minute limit while still giving Claude
        // enough live data to compose the rankings.
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
  // Claude's response after tool-use is a sequence of content blocks. The final
  // text block is the JSON we want; web_search tool_use/tool_result blocks come before.
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
    return jsonError(502, "Could not parse market intel JSON", { raw: finalText.slice(0, 800) });
  }

  if (!parsed || !Array.isArray(parsed.areas) || !Array.isArray(parsed.roles)) {
    return jsonError(502, "Market intel JSON missing required shape", { got: Object.keys(parsed || {}) });
  }

  // Normalize area keys to match the frontend pin dictionary (lowercase city name)
  parsed.areas = parsed.areas.map(a => ({
    ...a,
    key: (a.key || a.name || "").toString().toLowerCase().trim(),
  }));

  const tokensUsed = (data.usage || {});
  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: "Job Bank Canada + news + Indeed (via Claude web search)",
      model: MODEL,
      input_tokens: tokensUsed.input_tokens || 0,
      output_tokens: tokensUsed.output_tokens || 0,
      areas: parsed.areas,
      roles: parsed.roles,
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
  // Compact prompt — keep the input token count down so we stay under the per-minute
  // rate limit even when combined with web_search result tokens.
  return `You are a labor-market analyst for a recruitment firm in Windsor, Ontario. Search the web (Job Bank Canada at jobbank.gc.ca, recent Ontario hiring/expansion news from the last 30 days) and return ONLY a JSON object — no markdown, no preamble.

Shape:
{
  "areas": [ { "name": "Windsor", "key": "windsor", "job_count": 1247, "top_industries": ["EV/Battery","Automotive"], "top_roles": ["Industrial Electrician","Plant Manager"], "why_now": "Concrete one-sentence catalyst — name the company/contract." } ],
  "roles":  [ { "title": "Industrial Electrician", "job_count": 234, "top_areas": ["Windsor","Brampton"], "why_now": "Concrete one-sentence driver." } ]
}

Rules:
- "areas": exactly 5 entries, ranked by job_count descending.
- "roles": exactly 10 entries, ranked by job_count descending.
- Specific Ontario CITIES only (Windsor, Toronto, Mississauga, Brampton, Hamilton, Ottawa, London, Kitchener, Waterloo, Cambridge, Guelph, Burlington, Oakville, Markham, Vaughan, Oshawa, Barrie, Kingston, Sudbury, Niagara Falls, St. Catharines, etc.) — never "Ontario", "GTA", or region labels.
- key = city lowercase.
- job_count = realistic recent estimate from Job Bank / Indeed.
- why_now must name a real catalyst (specific company, contract, sector shift). Never generic.
- If a slot lacks live data, infer from broader Ontario labor context — don't return fewer than 5/10.

Output ONLY the JSON. Start with { and end with }.`;
}
