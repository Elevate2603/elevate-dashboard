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
  // Today's date in YYYY-MM-DD so Claude can filter for tenders that haven't closed
  const today = new Date().toISOString().slice(0, 10);
  return `You are extracting currently-open procurement opportunities for Elevate Recruitment (Windsor ON staffing agency). Today is ${today}.

YOUR TASK: Use web_search to find AT LEAST 15 currently-open Ontario tenders/RFPs/RFQs where Elevate could supply labour or services. Then return them as JSON.

USE web_search 3 TIMES with these exact queries (one per round):
1. site:merx.com Ontario open tenders cleaning OR janitorial OR security OR custodial OR landscaping OR transportation OR waste OR food
2. site:wonable.io Canadian tenders Ontario open 2026 services cleaning security custodial
3. Ontario municipal open tenders 2026 services labour staffing custodial security waste transportation closing date

EXTRACT from search results — every tender shown in the listings, not just the first few. The MERX Ontario page alone typically shows 20-50 open services tenders; the Wonable cleaning tenders page lists 8-15. Pull all relevant ones.

INCLUDE — any tender where Elevate could supply labour or services:
- Sectors: public sector (municipal, school board, health), manufacturing, transportation/logistics, waste management, private-sector RFQs
- Labour types: custodial/janitorial, security, snow removal, landscaping, waste collection, transit, food services/dietary, healthcare support (PSW/dietary/housekeeping), staffing/temp, general labour, CSR/call centre, office/admin temp, warehouse, traffic control, parking enforcement, courier, school bus, paratransit, fleet maintenance services

SKIP ONLY: pure construction/capital build, IT software/SaaS, equipment-only purchases, professional consulting (legal/accounting/architecture/engineering design).

Geography priority: Ontario, especially Windsor-Essex, GTA, Brampton corridor. Toronto/London/Ottawa acceptable. Skip far-north Ontario unless very strong fit.

RETURN FORMAT — JSON object only, no markdown, no preamble:

{
  "tenders": [
    {
      "title": "exact title from listing",
      "agency": "buyer/agency name",
      "bid_number": "official reference if shown, else derive from title",
      "category": "one of: Office/Admin, General Labour, Skilled Trades, Warehouse/Logistics, Custodial, Healthcare Support, Security, Other",
      "region": "city, ON or 'Ontario' if general",
      "source_portal": "merx or wonable or biddingo or canadabuys or bidsandtenders.ca",
      "posted_date": "YYYY-MM-DD or blank",
      "questions_due": "YYYY-MM-DD or blank",
      "closing_date": "YYYY-MM-DD — must be after ${today}",
      "bid_url": "direct https URL to the bid detail page",
      "relevance_score": "0-100 integer (Elevate fit + geo proximity)"
    }
  ]
}

CRITICAL — DO NOT return empty array. If your search results contain ANY services/labour tender in Ontario that hasn't closed, INCLUDE IT. When uncertain whether Elevate could staff it, INCLUDE it and use relevance_score to grade. Target 15-25 tenders, minimum 10.

Output ONLY the JSON. Start with { and end with }.`;
}
