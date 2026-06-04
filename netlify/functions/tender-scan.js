// netlify/functions/tender-scan.js
// Live Ontario tender scanner — Claude w/ web_search tool researches MERX,
// Wonable, biddingo, canadabuys, and major bidsandtenders.ca municipal
// subdomains for open public-sector + private-sector services tenders
// Elevate Recruitment (Windsor ON staffing agency) could pursue.
//
// Returns:
//   { ok: true, fetched_at, source, tenders: [...] }
//
// Called daily by Make scenario "Elevate - Tender Scan (daily)" which
// iterates the tenders array and writes each into the elevate_tenders
// datastore (105264). The dashboard reads from the existing Tender Fetch
// webhook so this function does not need to be hit from the browser.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Haiku 4.5 fits comfortably under Netlify's 26s free-tier cap with web_search.
// We tried Sonnet 4.6 first and it timed out at 30s. Triage of "could Elevate
// staff this" is more pattern-matching than deep reasoning — Haiku is fine.
const MODEL = process.env.TENDER_SCAN_MODEL || "claude-haiku-4-5-20251001";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).health === "1") {
    return {
      statusCode: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        service: "tender-scan",
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
        // 3 search rounds × ~3-4s + 2500 output tokens with Haiku = ~12-18s, well under 26s
        max_tokens: 2500,
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
    return jsonError(502, "Could not parse tender JSON", { raw: finalText.slice(0, 800) });
  }

  if (!parsed || !Array.isArray(parsed.tenders)) {
    return jsonError(502, "Tender JSON missing required shape", { got: Object.keys(parsed || {}) });
  }

  // Sanitize + add tender_id (bid_number + agency) so the downstream Make
  // scenario can use it as the datastore key and dedup naturally.
  const tenders = parsed.tenders
    .filter(t => t && t.title && t.agency)
    .map(t => {
      const bidNumber = (t.bid_number || t.title || "").toString().trim();
      const agency = (t.agency || "").toString().trim();
      return {
        tender_id: `${bidNumber}_${agency}`.slice(0, 250),
        title: String(t.title || "").trim(),
        agency: agency,
        category: String(t.category || "").trim(),
        bid_number: bidNumber,
        region: String(t.region || "Ontario").trim(),
        source_portal: String(t.source_portal || "tender-scan").trim(),
        posted_date: String(t.posted_date || "").trim(),
        questions_due: String(t.questions_due || "").trim(),
        closing_date: String(t.closing_date || "").trim(),
        bid_url: String(t.bid_url || "").trim(),
        relevance_score: Number(t.relevance_score) || 50,
      };
    });

  const tokensUsed = (data.usage || {});
  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      fetched_at: new Date().toISOString(),
      source: "MERX + Wonable + bidsandtenders.ca + biddingo + canadabuys (via Claude web search)",
      model: MODEL,
      input_tokens: tokensUsed.input_tokens || 0,
      output_tokens: tokensUsed.output_tokens || 0,
      count: tenders.length,
      tenders,
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
  return `You are a procurement analyst for Elevate Recruitment, a staffing agency in Windsor, Ontario. Your job: surface CURRENTLY OPEN tenders/RFPs/RFQs across Ontario that Elevate could pursue.

Search these portals via web_search:
1. MERX Ontario solicitations (merx.com/public/solicitations/ontario-355)
2. Wonable Canadian tenders (wonable.io/canadian-tenders) — Ontario filter
3. Biddingo (biddingo.com) — Ontario services
4. CanadaBuys (canadabuys.canada.ca) — Ontario open opportunities
5. Major bidsandtenders.ca municipal portals (windsor, essex, brampton, mississauga, peel, toronto, london, ottawa subdomains)

Geography priority: Ontario, especially Windsor-Essex, GTA, Brampton corridor. Toronto core acceptable. Far-north Ontario only if very strong fit.

INCLUDE any tender where Elevate could supply LABOUR or SERVICES, across ALL sectors:
- Sectors: public sector (municipal, school boards, health), manufacturing (auto, EV/battery, food, industrial), transportation/logistics (warehousing, distribution, transit), waste management (collection, recycling), private-sector RFQs from large companies
- Labour types: custodial/janitorial, security guards, snow removal, landscaping/grounds, waste collection, transit/transportation, food services/dietary, healthcare support (PSW, dietary, housekeeping), staffing/temp services, general labour, customer service/call centre, office/admin temp, warehouse/distribution, traffic control flagging, parking enforcement, courier/delivery, school bus, paratransit, fleet maintenance services

SKIP ONLY:
- Pure construction / capital build projects
- IT software / SaaS subscriptions
- Equipment-only purchases (no labour component)
- Professional consulting (legal, accounting, architecture, engineering design — these are credentialed professional services, not staffing)

Return ONLY a JSON object — no markdown, no preamble, no explanation. Shape:

{
  "tenders": [
    {
      "title": "RFB - Provision of Janitorial Services for Double Stack",
      "agency": "Toronto Transit Commission",
      "bid_number": "T57DL26355",
      "category": "Custodial",
      "region": "Toronto, ON",
      "source_portal": "merx",
      "posted_date": "2026-05-15",
      "questions_due": "2026-06-03",
      "closing_date": "2026-06-12",
      "bid_url": "https://www.merx.com/...",
      "relevance_score": 90
    }
  ]
}

Rules:
- Up to 25 tenders, ordered by relevance_score descending
- category must be one of: Office/Admin, General Labour, Skilled Trades, Warehouse/Logistics, Custodial, Healthcare Support, Security, Other
- Dates YYYY-MM-DD or blank
- relevance_score 0-100 — score on (a) labour-intensiveness fit for Elevate, (b) geography proximity to Windsor/GTA, (c) contract size/recurrence
- bid_url must be the direct link to the bid detail page
- bid_number: use the official agency reference if shown; otherwise derive from title
- Only currently OPEN tenders (closing_date in the future). Exclude closed/awarded/cancelled.

Output ONLY the JSON. Start with { and end with }.`;
}
