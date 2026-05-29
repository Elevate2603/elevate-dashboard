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
        // 4500 tokens covers areas (5) + roles (10) + news (8 with impact analysis).
        // Output cost at Haiku 4.5: ~4500 × $5/M = $0.022 — still trivial monthly.
        max_tokens: 4500,
        // Web search results are large (~3-5K tokens each). 4 searches gives Claude
        // enough live coverage for hot spots + news without blowing the per-minute rate limit.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
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

  // News array is optional — older deploys won't have it, default to empty
  const news = Array.isArray(parsed.news) ? parsed.news : [];

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
      news,
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
  return `You are a labor-market analyst for ELEVATE RS Corp, a staffing & recruitment agency in Windsor, Ontario specializing in automotive Tier 1/2, EV/battery, manufacturing, warehouse/logistics, and skilled-trades placements across Ontario.

Search the web (Job Bank Canada at jobbank.gc.ca, recent Ontario hiring/expansion/layoff news from the last 30 days, Indeed Canada) and return ONLY a JSON object — no markdown, no preamble.

Shape:
{
  "areas": [ { "name": "Windsor", "key": "windsor", "job_count": 1247, "top_industries": ["EV/Battery","Automotive"], "top_roles": ["Industrial Electrician","Plant Manager"], "why_now": "Concrete one-sentence catalyst — name the company/contract." } ],
  "roles":  [ { "title": "Industrial Electrician", "job_count": 234, "top_areas": ["Windsor","Brampton"], "why_now": "Concrete one-sentence driver." } ],
  "news":   [ { "title": "Stellantis announces 1,400-job Windsor expansion", "summary": "One-sentence factual summary of the event.", "source": "CBC News", "date": "2026-05-20", "category": "expansion|layoff|contract|policy|merger|other", "impact": "Two-to-three sentences on how this affects Elevate's staffing/recruitment business — does it create demand for specific roles (which?), open new client accounts, threaten existing placements, or shift the competitive landscape? Be specific and actionable." } ]
}

Rules for areas + roles:
- "areas": exactly 5 entries, ranked by job_count descending. Specific Ontario CITIES only (Windsor, Toronto, Mississauga, Brampton, Hamilton, Ottawa, London, Kitchener, Waterloo, Cambridge, Guelph, Burlington, Oakville, Markham, Vaughan, Oshawa, Barrie, Kingston, Sudbury, Niagara Falls, St. Catharines, etc.) — never "Ontario", "GTA", or region labels.
- "roles": exactly 10 entries, ranked by job_count descending.
- key = city lowercase. job_count = realistic recent estimate. why_now = real catalyst (specific company, contract, sector shift). Never generic.

Rules for news:
- "news": exactly 8 entries, ordered by recency (newest first).
- Each item is a SPECIFIC EVENT from the last 30 days affecting Ontario manufacturing / EV / battery / automotive / logistics / skilled trades — plant opening or closure, layoffs, government contract, M&A, expansion announcement, policy shift, major hiring spree.
- impact field is the MOST IMPORTANT field — write 2-3 sentences as if briefing Travis personally. Address what it means for HIM:
    * Does it open hiring demand for which roles?
    * Does it create a new account opportunity (name the company)?
    * Does it threaten or improve existing placements?
    * Does it shift competitive positioning for Elevate?
  Be concrete. "Watch this space" is not an impact analysis.
- If you cannot find 8 real news items, pad with the most relevant Canadian / Ontario sector trends — but mark date as "ongoing" rather than fabricate a specific date.

Output ONLY the JSON. Start with { and end with }.`;
}
