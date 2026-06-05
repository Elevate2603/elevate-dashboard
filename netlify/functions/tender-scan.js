// netlify/functions/tender-scan.js
// Live Ontario tender scanner. Pre-fetches MERX Ontario + Wonable Canadian
// tenders directly (these aggregator pages render server-side, unlike the
// bidsandtenders.ca municipal portals which need JS), strips HTML to text,
// then asks Claude Haiku to extract structured tender records.
//
// This pattern is FAR more reliable than letting Claude orchestrate
// web_search itself — that approach kept either bailing with 0 tenders or
// timing out under Netlify's 26s free-tier cap. With pre-fetched content,
// Claude only does extraction (no browsing) and lands in ~6-10s.
//
// Returns: { ok, fetched_at, source, count, tenders: [...] }
// Called by Make scenario "Elevate - Tender Scan (daily web sweep)" (5291896).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MODEL = process.env.TENDER_SCAN_MODEL || "claude-haiku-4-5-20251001";

const SOURCES = [
  { name: "MERX",    url: "https://www.merx.com/public/solicitations/ontario-355" },
  { name: "Wonable", url: "https://wonable.io/canadian-tenders" },
];

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

  // Pre-fetch all aggregator pages in parallel and strip HTML to text.
  const fetched = await Promise.all(SOURCES.map(async (s) => {
    try {
      const r = await fetch(s.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Elevate tender-scan)" },
      });
      if (!r.ok) return { name: s.name, text: "", error: `HTTP ${r.status}` };
      const html = await r.text();
      return { name: s.name, text: stripHtml(html).slice(0, 18000) };
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
        max_tokens: 3000,
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
      source: SOURCES.map(s => s.name).join(" + "),
      model: MODEL,
      input_tokens: tokensUsed.input_tokens || 0,
      output_tokens: tokensUsed.output_tokens || 0,
      pages_fetched: fetched.filter(f => f.text).length,
      pages_failed: fetched.filter(f => !f.text).length,
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

// Quick-and-dirty HTML strip — drops script/style blocks, then tags, then
// collapses whitespace. Good enough for the listing pages we care about.
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
  return `You are extracting Ontario procurement opportunities for Elevate Recruitment, a STAFFING AGENCY in Windsor, Ontario. Today is ${today}.

Elevate's business model: they PLACE PEOPLE in ongoing services jobs (recurring labour contracts). They do NOT build, install, design, supply equipment, or do one-off project work.

Below are two pre-fetched listing pages from MERX and Wonable. Extract ONLY tenders that match Elevate's actual business — return as JSON.

═══════════ STRICT INCLUSION TEST ═══════════
A tender is INCLUDED only if ALL FOUR of these are true:

1. **Ongoing labour/services contract** — the deliverable is people doing recurring work (not building a thing, not installing equipment, not supplying goods)
2. **Work performed in Ontario** — work site is in Ontario (NOT just the agency being Ontario-based; Embassy contracts abroad are OUT even if the agency is in Ottawa)
3. **Within Elevate's geography** — Windsor-Essex, GTA, Brampton corridor, Toronto core, London, Hamilton, Kitchener-Waterloo-Cambridge, Niagara, Ottawa. SKIP: Thunder Bay, Sudbury, North Bay, Smooth Rock Falls, Kenora, Timmins, any far-north Ontario
4. **Labour categories Elevate places**: custodial/janitorial, security guards, snow removal/landscaping, waste collection drivers, food services/dietary, healthcare support (PSW/dietary/housekeeping), general labour, customer service/call centre, office/admin temp, warehouse, traffic control flagging, parking enforcement, courier, school bus drivers, paratransit drivers, fleet maintenance (mechanics/drivers)

═══════════ HARD SKIPS — DO NOT INCLUDE ═══════════
- **Construction or capital projects** (anything with build, install, upgrade, repair, renovation, sidewalk, road, paving, waterworks, lagoon, exhaust fan access, signage installation, HVAC, electrical install, plumbing)
- **Equipment/goods supply** (fire trucks, vehicles, uniforms, clothing supply, IT equipment, machinery — even if there's a "services" wrapper)
- **Technology installation** (CCTV install, access controls install, network install, software deployment, system integration)
- **Professional/credentialed services** (legal, accounting, architecture, engineering design, consulting, audit, financial advisory)
- **IT/SaaS** subscriptions
- **One-shot projects** (study, assessment, plan, design, research)
- **Work outside Ontario** even if posted by an Ontario agency (e.g., Embassy cleaning abroad)
- **Far-north Ontario** (see geography list above)

═══════════ OUTPUT ═══════════
JSON object only, no markdown, no preamble:

{
  "tenders": [
    {
      "title": "exact title from listing",
      "agency": "buyer/agency name",
      "bid_number": "official reference, or derive from title if none shown",
      "category": "one of: Office/Admin, General Labour, Skilled Trades, Warehouse/Logistics, Custodial, Healthcare Support, Security, Other",
      "region": "city, ON",
      "source_portal": "merx or wonable",
      "posted_date": "YYYY-MM-DD or blank",
      "questions_due": "YYYY-MM-DD or blank",
      "closing_date": "YYYY-MM-DD",
      "bid_url": "direct https URL",
      "relevance_score": "60-100 integer"
    }
  ]
}

═══════════ RULES ═══════════
- relevance_score must be ≥ 60. If a tender doesn't clear 60, EXCLUDE it entirely (don't lower the score, just skip)
- closing_date must be after ${today}
- Be SELECTIVE — better to return 5 great matches than 20 with junk. Empty array is acceptable if no listing meets the 4-criteria test.
- Apply the hard-skip list strictly. When in doubt, SKIP.

========== LISTING PAGES ==========

${context}

========== END LISTINGS ==========

Output ONLY the JSON. Start with { and end with }.`;
}
