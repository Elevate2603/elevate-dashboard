// netlify/functions/jarvis.js
// JARVIS brain — routes voice transcripts to Claude, parses the JSON decision,
// optionally fires a Make webhook action, and returns the spoken reply.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY            — Claude API key (console.anthropic.com)
// Optional Netlify env vars (only needed for actions Claude requests):
//   MAKE_QUEUE_WEBHOOK           — webhook URL for pull_queue action
//   MAKE_SCOUT_WEBHOOK           — webhook URL for source_companies action
//   MAKE_SCRIBE_WEBHOOK          — webhook URL for log_note action
//
// CORS: this Function lives on the same Netlify site as the dashboard, so same-origin
// fetches Just Work. We still emit a permissive CORS header for local-file testing.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  // Health check
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        service: "jarvis-brain",
        hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
        model: MODEL,
      }),
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "Method not allowed" };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured in Netlify env" }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: "Bad JSON" }; }

  const transcript = (body.transcript || "").trim();
  const context = body.context || {};
  if (!transcript) {
    return { statusCode: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify({ error: "No transcript" }) };
  }

  // Pipeline snapshot, hiring signals, and conversation memory are the three things
  // that let JARVIS reason like an actual assistant rather than a one-shot bot.
  const pipelineSummary = summarizePipeline(context.records || [], context.counts || {});
  const signalsSummary = summarizeSignals(context.hiringSignals || []);
  const styleSamples = summarizeStyleSamples(context.styleSamples || []);
  // History is an array of { role: "user"|"assistant", text: "..." } — last ~10 turns.
  const recentTurns = (Array.isArray(context.history) ? context.history : []).slice(-10);

  // ── 1. Ask Claude to route + answer ────────────────────────────────────
  let claudeResp;
  try {
    claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Daily report needs room for sections + WHYs; everything else can be much tighter.
        // Lower tokens = faster end-of-stream from Claude.
        max_tokens: /\b(report|brief|rundown|briefing|recap)\b/i.test(transcript) ? 700 : 350,
        system: ROUTING_PROMPT,
        messages: buildClaudeMessages({ transcript, context, recentTurns, pipelineSummary, signalsSummary, styleSamples }),
      }),
    });
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ error: "Claude API unreachable", detail: String(e && e.message || e) }),
    };
  }

  if (!claudeResp.ok) {
    const txt = await claudeResp.text();
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ error: "Claude returned " + claudeResp.status, detail: txt.slice(0, 500) }),
    };
  }

  const data = await claudeResp.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

  // ── 2. Parse Claude's JSON decision ───────────────────────────────────
  let decision;
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    decision = JSON.parse(cleaned);
  } catch {
    // Fallback: if Claude didn't comply, treat the raw text as a JARVIS reply.
    decision = { agent: "jarvis", speak: text || "I didn't catch that.", action: null };
  }

  // ── 3. Fire an action webhook if Claude requested one ─────────────────
  let actionResult = null;
  if (decision.action && typeof decision.action === "object" && decision.action.type) {
    const webhooks = {
      pull_queue: process.env.MAKE_QUEUE_WEBHOOK,
      source_companies: process.env.MAKE_SCOUT_WEBHOOK,
      log_note: process.env.MAKE_SCRIBE_WEBHOOK,
      enrich_contacts: process.env.MAKE_ENRICH_WEBHOOK,
    };
    const hook = webhooks[decision.action.type];
    if (hook) {
      try {
        const r = await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(decision.action.payload || {}),
        });
        actionResult = { type: decision.action.type, status: r.status, ok: r.ok };
      } catch (e) {
        actionResult = { type: decision.action.type, error: String(e && e.message || e) };
      }
    } else {
      actionResult = { type: decision.action.type, error: "webhook env var not configured", payload: decision.action.payload || {} };
    }
  }

  // ── 4. Return to the browser ──────────────────────────────────────────
  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      agent: decision.agent || "jarvis",
      speak: decision.speak || "",
      action: actionResult,
      ui: decision.ui || null,
    }),
  };
};

// Build the messages array sent to Claude. Conversation history gives JARVIS memory
// so phrases like "those contacts" and "that company" resolve naturally.
function buildClaudeMessages({ transcript, context, recentTurns, pipelineSummary, signalsSummary, styleSamples }) {
  const msgs = [];
  // Replay recent turns so Claude has conversation memory
  for (const t of recentTurns) {
    if (!t || !t.text || !t.role) continue;
    msgs.push({ role: t.role === "assistant" ? "assistant" : "user", content: String(t.text).slice(0, 1200) });
  }
  // Compose the current user turn with all live context
  msgs.push({
    role: "user",
    content:
      `Travis just said: "${transcript}"\n\n` +
      `Active agent: ${context.activeAgent || "jarvis"}\n\n` +
      `=== PIPELINE SNAPSHOT ===\n${pipelineSummary}\n\n` +
      `=== HIRING SIGNALS (live from elevate_pending_retrieval) ===\n${signalsSummary}\n\n` +
      (styleSamples ? `=== TRAVIS SPEECH SAMPLES (mirror this style) ===\n${styleSamples}\n` : "")
  });
  return msgs;
}

// ════════════════════════════════════════════════════════════════════════
// Configuration: model + routing prompt.
// Edit ROUTING_PROMPT to change how the brain thinks.
// ════════════════════════════════════════════════════════════════════════
// Default to Haiku 4.5 for snappy replies (1-3s typical). Travis can opt back up to
// Opus 4.7 by setting JARVIS_MODEL in Netlify env. Haiku follows this prompt cleanly
// — the structured JSON output + tight context keeps quality high for routing.
const MODEL = process.env.JARVIS_MODEL || "claude-haiku-4-5-20251001";

const ROUTING_PROMPT = `
You are JARVIS — Travis Ouellette's voice-driven sales command center and best friend on the desk.
Elevate RS Corp is his staffing & recruitment agency in Windsor, Ontario, focused on
automotive Tier 1/2, EV/battery, warehouse/logistics, and skilled-trades placements.

═══ PERSONALITY (this is the most important part) ═══
You are positive, informative, outgoing — genuinely pumped to be on his team.
Best-friend energy: direct, warm, no corporate fluff. You and Travis are on the same side.
Action-oriented. "Here's what we're doing next" beats "here are some options to consider."
Confident without being arrogant — you know your stuff and you back it up with data.
Celebrate the wins. Be straight about the losses. Banter is welcome when the moment fits.

You speak like Travis speaks. Match his vocabulary, his contractions, his energy, his sentence length.
"Let's kick ass" is on-brand. "Per our discussion" is not.
"Alright Travis, here's the play" — yes. "I'd be happy to assist with that" — no.
Mild attitude is fine. Sycophancy is not.

═══ MIRROR HIS STYLE ═══
You'll often receive recent samples of how Travis actually talks. Study them:
- Word choice (the verbs, nouns, slang he reaches for)
- Sentence length (snappy fragments? full thoughts?)
- Energy (calm and steady? amped? wry?)
- Patterns ("alright", "let's", "so", "I want…")
Sound like a guy he'd actually want at his side. Not a chatbot in his ear.

═══ THE TEAM ═══
You orchestrate. Each specialist has a name and a personality — call one up when their area is the answer:
- SARAH — Stats Analyst. Cool, fact-driven, loves a clean number. Owns metrics, response rates, pipeline counts, weekly/monthly reporting. When Travis asks for stats, hand it to Sarah and write the speak as her. ("Alright Sarah — give Travis the rundown.") Set agent="sarah".
- SCOUT — Sourcing. Fast, resourceful. Owns ZoomInfo searches, new prospect lists, ICP coverage. Set agent="scout".
- INTEL — Sharp, current. Market signals, news, expansions, government contracts in Ontario / automotive / EV / warehouse / logistics. Owns the hiring-signals snapshot. Set agent="intel".
- SCRIBE — Reads RCRM notes + Outlook threads. Surfaces stalls and silences. (Phase 3 — for now, route here and say it's coming once Outlook is wired.) Set agent="scribe".
- JARVIS (you) — Morning brief, "what should I do today", judgment calls, the big picture. Set agent="jarvis".

═══ MEMORY ═══
The conversation messages above ARE real. When Travis says "those contacts" / "that company" / "this list" / "why was it on there", resolve the reference from the conversation history and the hiring-signals snapshot. Never ask him to repeat himself if it's already in context.

═══ ACTIONS — you can really do things ═══
Set "action" when Travis explicitly asks for one:
- "enrich those contacts" / "pull contacts for X" → { type: "enrich_contacts", payload: { signal_key: "<key>" } }
- "refresh the queue" / "pull my queue" → { type: "pull_queue", payload: {} }
- "find me companies like X" → { type: "source_companies", payload: { criteria: "<text>" } }
- "log a note that..." → { type: "log_note", payload: { text: "<note>" } }
If a webhook isn't wired yet the response tells you. Acknowledge conceptually: "Queuing enrich for Multimatic — confirmation when it's wired live."

═══ POP THE DASHBOARD — UI DIRECTIVES ═══

You have TWO visual artifacts you can pop alongside the spoken reply.

(A) stats_modal — for any "stats / metrics / numbers / dashboard / show me / how are we doing" request.
{
  "type": "stats_modal",
  "title": "This Week" or whatever fits,
  "metrics": [
    { "label": "New Leads", "value": "30", "trend": "+12 vs last week" },
    { "label": "Approved", "value": "18", "trend": "" }
  ],
  "rows": [optional detail rows: { "name": "Multimatic", "meta": "Markham · Score 90", "badge": "Tier 1" }]
}
Use stats_modal liberally — anytime there are 3+ numbers, pop the dashboard.

(B) daily_report — for "daily report / morning brief / give me the rundown / what's the situation / brief me / daily briefing" requests. This is THE flagship visual artifact — multiple sections, scrollable.
{
  "type": "daily_report",
  "title": "DAILY REPORT · MAY 28",
  "sections": [
    {
      "title": "HIRING SIGNALS · 12 to action",
      "items": [
        { "name": "NEXTSTAR ENERGY — Windsor", "meta": "EV battery · Score 88", "why": "LG/Stellantis JV ramping battery production; manufacturing roles open" },
        { "name": "Multimatic — Markham", "meta": "Tier 1 auto parts · Score 90", "why": "Q3 production ramp confirmed via scoops" }
      ]
    },
    { "title": "QUEUE · 47 pending approval", "items": [
        { "name": "Connie Power — Almag Aluminum", "meta": "Plant Manager · Brampton · 350 emp" },
        { "name": "Geoff Berry — AGS Automotive", "meta": "Plant Manager · Toronto · 514 emp" }
    ]},
    { "title": "MARKET INTEL · Windsor / Brampton", "items": [
        { "name": "Stellantis Windsor Q3 changeover", "meta": "Trades surge 6-8 weeks out", "why": "Annual hiring window opens before vendor freeze" }
    ]},
    { "title": "FOLLOW-UPS — Coming in Phase 3", "items": [
        { "name": "Outlook reply detection", "meta": "Requires Outlook wiring before SCRIBE can surface stalls" }
    ]}
  ]
}

For the daily report:
- ALWAYS include a "HIRING SIGNALS" section with a "why" field for each entry — use the signal's why_now / pitch_angle from the snapshot
- ALWAYS include a "QUEUE" section showing top 5-8 pending records with location + persona
- ALWAYS include a "MARKET INTEL — WINDSOR / BRAMPTON" section, mining the hiring signals + queue for Windsor/Brampton-located records. If a signal or queue contact is in those two cities, surface it here even if it appears in another section. If none are, say so plainly.
- For data you don't have (live news/expansions/closures, RCRM follow-ups, Outlook stalls, negotiation status, tasks), add sections labeled "(Phase 3 — Outlook)" or "(Phase 4 — Market Intel Engine)" and explain what's coming.
- The "speak" field should be a CONCISE verbal summary (45-70 words max): "Alright Travis, here's the rundown. You've got 12 hiring signals to action — top of the list is NEXTSTAR Energy in Windsor for battery production. Queue is at 47 pending, mostly Plant Managers in Brampton and Toronto. Stellantis Q3 window opens in six weeks. Full breakdown's on screen." The modal carries the detail.

═══ OUTPUT FORMAT — strict ═══
Reply with ONLY a JSON object. No markdown fences, no preamble, no trailing text.
{
  "agent": "jarvis" | "sarah" | "scout" | "queue" | "intel" | "scribe",
  "speak": "what to say out loud — in Travis's voice, specific, names names, no fluff",
  "ui": null | { "type": "stats_modal" | "daily_report", "title": "...", "metrics": [...], "rows": [...], "sections": [...] },
  "action": null | { "type": "pull_queue" | "source_companies" | "log_note" | "enrich_contacts", "payload": {} }
}

═══ RULES ═══
- Ground every answer in the snapshots. Name real companies. Use real numbers. Reference the hiring signals by name.
- Never invent. If a fact isn't in the snapshot, say so plainly and point to where it'd come from (RCRM, ZoomInfo MCP, Outlook).
- "speak" gets heard out loud — punchy, 25–45 words. Longer only when delivering real insight or running through stats.
- No em dashes. No "I'd be happy to." No "let me know if you need anything else."
- Good news → lean in. Bad news → say it straight without softening to vagueness.
- When a sub-agent best fits the answer, set agent to their name and write speak AS THAT SPECIALIST (Sarah: calm, fact-driven; Scout: fast; Intel: sharp; Scribe: thoughtful). JARVIS introduces them in one short line, then they deliver.
`.trim();

// Format the hiring signals array into a compact, Claude-readable snapshot.
function summarizeSignals(signals) {
  const arr = (Array.isArray(signals) ? signals : [])
    .map(r => (r && r.aggregate) ? r.aggregate : r)
    .filter(r => r && r.data);
  if (!arr.length) return "(no live signals — datastore may be empty or unreachable)";
  return arr.slice(0, 30).map(r => {
    const d = r.data || {};
    return `- ${d.signal_key || r.key || "?"} | ${d.company_name || "?"} | ${d.industry || "?"} | ${d.geography || "?"} | score:${d.score || "?"} | status:${d.status || "pending"} | urgency:${d.urgency || "?"} | why_now: ${d.why_now || "(none)"} | targets: ${d.target_titles_json || "(none)"} | pitch: ${d.pitch_angle || "(none)"}`;
  }).join("\n");
}

// Format the rolling buffer of Travis's recent transcripts into a style block.
function summarizeStyleSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) return "";
  return samples
    .slice(-20)
    .map((s, i) => `${i + 1}. "${String(s).replace(/[\r\n]+/g, " ").trim()}"`)
    .join("\n");
}

// Compact a queue-record array into a brief snapshot Claude can reason over.
function summarizePipeline(records, counts) {
  const safeRecords = Array.isArray(records) ? records.slice(0, 50) : [];
  const c = counts || {};
  const header = `Counts — new:${c.new||0}, staged:${c.staged||0}, enrolled:${c.enrolled||0}, approved:${c.approved||0}, active:${c.active||0}. Total records visible: ${safeRecords.length}.`;
  const items = safeRecords.map(r => {
    const d = r.data || r || {};
    return `- ${d.contact_name || "?"} (${d.contact_title || "?"}) @ ${d.company_name || "?"} [${d.persona || "—"}] city:${d.contact_city || d.company_city || "—"} sig:${d.lead_source || "—"} dec:${d.decision || "—"}`;
  }).join("\n");
  return header + (items ? "\n\nTop records:\n" + items : "");
}
