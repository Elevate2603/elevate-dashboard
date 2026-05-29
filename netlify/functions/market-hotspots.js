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

const MODEL = process.env.MARKET_INTEL_MODEL || "claude-sonnet-4-6";

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
        max_tokens: 4096,
        // Web search lets Claude pull live counts from Job Bank, Indeed, news.
        // max_uses caps cost — 8 searches is enough to cover top regions + roles.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
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
  return `You are a labor-market analyst for a recruitment firm in Windsor, Ontario.

Research current hiring demand across Ontario, Canada. Use web search to pull data from:
- Job Bank Canada (jobbank.gc.ca) — official Canadian government job board
- Indeed Canada
- Recent news articles from the last 30 days about plant openings, expansions, layoffs, government contracts
- Statistics Canada labor data if relevant

Focus on real, specific catalysts (named companies, announced contracts, sector trends) — not generic descriptions.

Return ONLY a valid JSON object in this exact shape, no markdown, no preamble:

{
  "areas": [
    {
      "name": "Windsor",
      "key": "windsor",
      "job_count": 1247,
      "top_industries": ["EV/Battery", "Automotive Tier 1", "Logistics"],
      "top_roles": ["Industrial Electrician", "Plant Manager", "Warehouse Associate"],
      "why_now": "One-sentence concrete reason — name the specific catalyst (NextStar Energy ramp, Stellantis EV transition, etc.)."
    }
  ],
  "roles": [
    {
      "title": "Industrial Electrician",
      "job_count": 234,
      "top_areas": ["Windsor", "Brampton", "Hamilton"],
      "why_now": "One-sentence concrete reason — name the specific driver."
    }
  ]
}

Rules:
- "areas" must have exactly 5 entries, ranked by job_count descending.
- "roles" must have exactly 10 entries, ranked by job_count descending.
- ONLY name specific Ontario cities — never "Ontario", "GTA", "Southern Ontario", or province/region labels.
- Use real cities like: Windsor, Toronto, Mississauga, Brampton, Hamilton, Ottawa, London, Kitchener, Waterloo, Cambridge, Guelph, Burlington, Oakville, Markham, Vaughan, Oshawa, Barrie, Kingston, Sudbury, Niagara Falls, St. Catharines, Thunder Bay, Sault Ste. Marie.
- key must be the city name in lowercase, no punctuation (e.g. "windsor", "st. catharines" → "st. catharines", "thunder bay").
- job_count should be a realistic estimate of currently posted jobs in that city for that area/role from recent Job Bank or Indeed counts.
- why_now must name a real, specific driver — never generic ("growing market", "in demand").
- If you cannot find data for a particular slot, still fill it with your best estimate based on the broader Ontario labor market context — don't return fewer than 5 areas or 10 roles.

Return ONLY the JSON object. No preamble, no markdown code fences, no closing remarks.`;
}
