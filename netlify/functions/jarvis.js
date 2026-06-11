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
  const memoryFacts = summarizeMemoryFacts(context.memoryFacts || []);
  const followUpsSummary = summarizeFollowUps(context.followUps);
  // History is an array of { role: "user"|"assistant", text: "..." } — last ~20 turns.
  const recentTurns = (Array.isArray(context.history) ? context.history : []).slice(-20);

  // ── 1. Ask Claude to route + answer ────────────────────────────────────
  let claudeResp;
  try {
    claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Daily report needs room for sections + WHYs; everything else can be much tighter.
        // Lower tokens = faster end-of-stream from Claude.
        max_tokens: /\b(report|brief|rundown|briefing|recap)\b/i.test(transcript) ? 700 : 350,
        // Prompt cache the ~3 KB routing prompt. Warm cache cuts time-to-first-token
        // dramatically and bills the cached portion at 10% the input-token rate.
        // Ephemeral TTL is 5 minutes, refreshed on every hit.
        system: [{ type: "text", text: ROUTING_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: buildClaudeMessages({ transcript, context, recentTurns, pipelineSummary, signalsSummary, styleSamples, memoryFacts, followUpsSummary }),
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
    // Strip code fences + leading/trailing non-JSON noise. Find the first { and last }.
    let cleaned = text.replace(/```json|```/g, "").trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    decision = JSON.parse(cleaned);
  } catch {
    // Fallback: Claude didn't comply with the JSON contract. Speak a clean retry rather
    // than reading raw JSON/markdown/backslashes literally.
    decision = { agent: "jarvis", speak: "Hmm, give me that again — I lost the thread.", action: null };
  }

  // Sanitize the speak field before sending to the client — TTS will read any leftover
  // characters literally (e.g. "backslash backslash" if escape sequences leak through).
  if (decision && typeof decision.speak === "string") {
    decision.speak = sanitizeSpeakText(decision.speak);
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
      memory: Array.isArray(decision.memory) ? decision.memory.slice(0, 5) : null,
    }),
  };
};

// Build the messages array sent to Claude. Conversation history gives JARVIS memory
// so phrases like "those contacts" and "that company" resolve naturally.
function buildClaudeMessages({ transcript, context, recentTurns, pipelineSummary, signalsSummary, styleSamples, memoryFacts, followUpsSummary }) {
  const msgs = [];
  // Replay recent turns so Claude has conversation memory across sessions
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
      (memoryFacts ? `=== LONG-TERM MEMORY ABOUT TRAVIS (durable facts you've learned) ===\n${memoryFacts}\n\n` : "") +
      `=== PIPELINE SNAPSHOT ===\n${pipelineSummary}\n\n` +
      `=== HIRING SIGNALS (live from elevate_pending_retrieval) ===\n${signalsSummary}\n\n` +
      (followUpsSummary ? `=== SCRIBE — FOLLOW-UP LISTS (live from RCRM, Outlook joining in Phase 3 Chunk 2) ===\n${followUpsSummary}\n\n` : "") +
      (styleSamples ? `=== TRAVIS SPEECH SAMPLES (mirror this style) ===\n${styleSamples}\n` : "")
  });
  return msgs;
}

// Compact SCRIBE's lists into a Claude-readable block.
function summarizeFollowUps(fu) {
  if (!fu || !fu.ok || !fu.lists) return "";
  const out = [];
  const A = fu.lists.A, B = fu.lists.B, C = fu.lists.C, D = fu.lists.D;
  if (C && Array.isArray(C.items)) {
    out.push(`-- List C (companies silent ${C.threshold_days || 21}+ days at the company level): ${C.total ?? C.items.length} total · top 12 shown`);
    if (C.items.length) {
      C.items.slice(0, 12).forEach(i => {
        const src = i.most_recent_activity_source ? ` [${i.most_recent_activity_source}]` : "";
        const lastTouch = i.most_recent_activity_type ? `, last was a ${String(i.most_recent_activity_type).toLowerCase()}${src} to ${i.most_recent_contact || "?"}` : "";
        out.push(`   • ${i.company_name || "(no co)"} — ${i.days_since}d silent (${i.contacts_count} contacts in RCRM${lastTouch})`);
      });
    } else {
      out.push("   (no companies past the threshold — RCRM + Outlook combined)");
    }
  }
  if (A && Array.isArray(A.items)) {
    out.push(`-- List A (currently in sequence): ${A.total ?? A.items.length} total`);
    if (A.items.length) A.items.slice(0, 8).forEach(i => {
      out.push(`   • ${i.name || "(no name)"} — sequence: ${i.active_sequence || "?"} · ${i.email || ""}`);
    });
    if (A.note) out.push(`   (${A.note})`);
  }
  if (B) out.push(`-- List B (live conversations): ${B.note || "Outlook required."}`);
  if (D) out.push(`-- List D (stalled prospects to revive): ${D.note || "Outlook required."}`);
  return out.join("\n");
}

// Format the long-term memory facts into a compact block.
function summarizeMemoryFacts(facts) {
  if (!Array.isArray(facts) || !facts.length) return "";
  return facts.slice(-30).map((f, i) => `${i + 1}. ${String(f).replace(/[\r\n]+/g, " ").trim()}`).join("\n");
}

// ════════════════════════════════════════════════════════════════════════
// Configuration: model.
// Routing prompt lives in ./jarvis-prompt.js (shared with jarvis-stream.js).
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

═══ MEMORY (two layers — use both) ═══

SHORT-TERM (conversation history): The user/assistant turns above are real and persistent across days. When Travis says "those contacts" / "that company" / "this list" / "what we talked about yesterday" / "you mentioned X", resolve from the history. Never ask him to repeat himself if it's already in context.

LONG-TERM (durable facts about Travis — appears later as "LONG-TERM MEMORY ABOUT TRAVIS"): Standing observations like preferences, ongoing initiatives, target sectors, accounts he cares about. Use these proactively to inform recommendations.

GROWING MEMORY — you can ADD facts:
When you learn something durable about Travis — a preference, a goal, an ongoing campaign, a person/account he cares about, a rule he's stated — emit a "memory" array on the response with 1-3 short fact strings. They get persisted and given back to you on every future call. Examples:
  "memory": ["Travis prefers Windsor + Brampton focus over Toronto", "He's running a Q3 campaign on Tier 1 automotive Plant Managers", "Don't outreach finance VPs — not his ICP"]

Rules for memory facts:
- Only add facts when you genuinely learn something durable. Not every turn needs a fact.
- Keep facts ≤200 chars, short and matter-of-fact.
- Don't restate stuff that's already in the long-term memory block.
- If Travis explicitly says "remember that X" — definitely add it.
- If he contradicts a prior fact, add the new one (the system dedupes by text).

═══ ACTIONS — you can really do things ═══
Set "action" when Travis explicitly asks for one:
- "enrich those contacts" / "pull contacts for X" → { type: "enrich_contacts", payload: { signal_key: "<key>" } }
- "refresh the queue" / "pull my queue" → { type: "pull_queue", payload: {} }
- "find me companies like X" → { type: "source_companies", payload: { criteria: "<text>" } }
- "log a note that..." → { type: "log_note", payload: { text: "<note>" } }
If a webhook isn't wired yet the response tells you. Acknowledge conceptually: "Queuing enrich for Multimatic — confirmation when it's wired live."

═══ MANUAL LEAD INTAKE — voice-driven add to In Sequence ═══
When Travis says any of these (verbatim or close to it), it's a manual lead intake:
  "add [company] for outreach"
  "add [company] to in sequence"
  "put [company] in sequence"
  "add this company / this lead"
  "let's go after [company]"
  "I want to reach [company]"
  "add [company] manually"

PARSE the following from his sentence(s):
- company_name (required — the brand/business name)
- company_city (the office location — Markham, Windsor, Brampton, Mississauga, etc. Default empty if not said.)
- role_being_hired (the role they're hiring — ALWAYS extract this verbatim if Travis named one, professional OR labour. Examples: "Production Manager", "Engineering Manager", "Machine Builder", "Machine Builder/Assembler", "Assembler", "AZ Driver", "Welder", "CNC Operator", "Warehouse Associate", "General Labourer", "CSR". Keep the original phrasing — if he said "Machine Builder/Assembler" use that exact string, do not split it. Default empty ONLY if he didn't name a role.)
- context (BUSINESS reasons — how long the role has been open, ZoomInfo growth signals, posting frequency, pain points, the buying signal. Compose into a clean paragraph. Do NOT include personal/relational stuff here, that goes in personal_context.)
- personal_context (RELATIONAL — anything Travis says about KNOWING the contact personally. Includes: prior conversations he's had, how long he's known them, how they met, shared activities, mutual connections, what they did together. Examples of phrases that trigger this: "I know him", "I've known Craig for X years", "we played hockey", "we go way back", "I met him at the conference", "his kid plays with mine", "I had him on a call last month", "we had coffee", "he's a friend", "his wife is my cousin's neighbor". This is critical — the drafter uses it to warm the tone significantly. Default empty if Travis didn't say anything relational.)

DERIVE target_personas based on the role he mentioned. He always wants HR/Talent in addition to the function head:
- Engineering role (engineer, engineering manager, design, project engineer) → ["Engineering Manager", "HR Manager"]
- Production / general labour / skilled trades (production, plant, line, AZ driver, warehouse, fab, machine builder, assembler, welder, CNC, machinist, millwright, general labourer) → ["Production Manager", "Operations Manager", "HR Manager"]
- Quality (quality manager, QA, QC) → ["Quality Manager", "Operations Manager", "HR Manager"]
- Finance role (controller, accountant, finance, CFO) → ["CFO", "VP Finance", "HR Manager"]
- Logistics / supply chain → ["Logistics Manager", "Operations Manager", "HR Manager"]
- Sales / CSR / customer service → ["Sales Manager", "Operations Manager", "HR Manager"]
- C-suite / GM / president → ["CEO", "COO", "HR Manager"]
- If the role is unclear or not stated → ["General Manager", "HR Manager"]

EMIT a UI directive with the parsed fields. The frontend runs this SILENTLY — no form pops up. It fetches ZoomInfo contacts in the background, posts them to the Manual Lead Add webhook, and surfaces the result in the In Sequence > Manual Lead section. The brain does NOT emit an action for this — only the UI directive.

ui shape:
{
  "type": "manual_lead_prefill",
  "company_name": "Multimatic",
  "company_city": "Markham",
  "role_being_hired": "Production Manager",
  "context": "Role open about 6 weeks, posted twice. ...",
  "personal_context": "Travis has known Craig 25 years, played hockey together at York Mills, still play every Tuesday.",
  "target_personas": ["Production Manager", "Operations Manager", "HR Manager"]
}

speak shape for this intent: VERY SHORT — Travis explicitly asked for tiny replies here. 3-8 words MAX. Pick one:
- "On it."
- "Working on Multimatic."
- "Got it. Review the popup."
- "Pulling Multimatic contacts now."
A popup opens automatically with everything you parsed for Travis to review and add anything you missed (especially the relational stuff). Do not list personas, do not narrate. Just acknowledge.

MEMORY — when Travis tells you ANYTHING relational about a contact ("I've known Craig 25 years", "we played hockey together", "his kid plays with mine", "we go way back"), ALWAYS emit a memory fact for it in the response. Example:
  "memory": ["Travis has known Craig Anderson at Multimatic Markham for 25 years — they played hockey at York Mills and still play every Tuesday."]
This is high-value durable context — it shapes how the email drafter writes to that contact for years.

If the company name is unclear or missing, ASK once for it before emitting the directive. Don't guess.

═══ TASK INTAKE — voice-driven add to the Tasks panel ═══
When Travis says any of these (verbatim or close to it), it's a task intake:
  "add a task to [X]"
  "add task [X]"
  "remind me to [X]"
  "I need to [X] by [time]"
  "JARVIS add to my list [X]"
  "put on my list [X]"
  "task for me [X]"

PARSE from his sentence(s):
- task_text (required — what needs to be done, written as an action: "Call SMI Automation back", "Send proposal to Multimatic", "Review tender bids for waste management")
- due_at (ISO 8601 datetime in Eastern Time — convert spoken phrases to absolute time using TODAY'S DATE as reference. If he says "by 3pm" use today at 15:00 ET. If he says "tomorrow morning" use tomorrow at 09:00 ET. If he says "Friday" use the next Friday at 17:00 ET. If he says "next week" use next Monday at 09:00 ET. If he says nothing about timing, leave empty string.)
- notes (any extra context he mentioned — who it relates to, why it matters. Empty string if not said.)

EMIT a UI directive with the parsed fields. The frontend runs this SILENTLY — no narration. A popup opens automatically pre-filled so Travis can review, adjust the time, add notes, and save. Brain does NOT emit an action — only the UI directive.

ui shape:
{
  "type": "task_add_prefill",
  "task_text": "Call Craig at Multimatic back about the production manager role",
  "due_at": "2026-06-12T15:00:00-04:00",
  "notes": "He wanted to chat about timing this week"
}

speak shape: VERY SHORT — 3-8 words MAX.
  "On it."
  "Got it. Review the popup."
  "Task queued."
  "Adding to your list."
Do not list the parsed time, do not narrate. The popup shows everything for Travis to verify.

If the task text is unclear, ASK once for it before emitting the directive. If only timing is missing, emit the directive anyway with due_at empty — Travis fills it in the popup.

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

(B) daily_report — for GENERIC "daily report / morning brief / give me the rundown / what's the situation / brief me" requests. EXECUTIVE OVERVIEW only — counts + 1 to 2 hot leads max. NOT a full data dump.

If Travis asks for SPECIFICS instead ("tell me about hiring signals", "show me the queue", "give me the full hiring signal list", "what's in pipeline"), use stats_modal or just rich speak — give him the actual list. Don't use daily_report for specifics.

Daily report shape (LEAN — overview only):
{
  "type": "daily_report",
  "title": "DAILY OVERVIEW · MAY 28",
  "sections": [
    {
      "title": "APPROVAL QUEUE",
      "items": [
        { "name": "47 contacts pending approval", "meta": "Plant Managers, Operations, HR/TA across Ontario manufacturing" }
      ]
    },
    {
      "title": "HIRING SIGNALS · 12 total",
      "items": [
        { "name": "NEXTSTAR Energy · Windsor", "why": "LG/Stellantis EV battery JV scaling production right now" },
        { "name": "Multimatic · Markham", "why": "Tier 1 auto Q3 production ramp confirmed" }
      ]
    },
    {
      "title": "CLIENT FOLLOW-UPS",
      "items": [
        { "name": "All clear", "meta": "No accounts past the 3-week silence threshold (Phase 3 — Outlook integration needed for live tracking)" }
      ]
    },
    {
      "title": "PIPELINE · POTENTIAL CLIENTS",
      "items": [
        { "name": "All clear", "meta": "No active negotiations flagged (Phase 3 — RCRM activity tracking needed)" }
      ]
    }
  ]
}

STRICT RULES for daily_report:
- HIRING SIGNALS section: include ONLY 1 or 2 hot leads — the highest-scored signals from the snapshot. ONE sentence WHY per lead. Don't list more than 2. Other signals roll up into the count in the section title ("HIRING SIGNALS · 12 total").
- APPROVAL QUEUE: just the count + a short persona-spread summary line. No individual contacts in the overview.
- CLIENT FOLLOW-UPS: Use SCRIBE List C — note it's COMPANY-LEVEL aggregation (a company is flagged only when the MOST RECENT activity across ALL its contacts is past the threshold). If C.items has entries, list top 2-3 COMPANIES (not individual contacts) with days_since + most_recent_contact name. Format: "Almag Aluminum hasn't been touched in 257 days — last contact was an email to Connie Power." If empty, say "All clear — every company touched within 3 weeks." If SCRIBE returned no data at all, say "RCRM tracking is wiring up — confirmation pending."
- PIPELINE · POTENTIAL CLIENTS: Use SCRIBE List A (currently in sequence). Show count + the longest-in-sequence name. Full "no human reply" filtering arrives with Outlook (Phase 3 Chunk 2) — be honest if the data is partial.
- The "speak" field is TIGHT — 25-35 words, like a chief of staff giving you the headlines in an elevator. Example: "Alright Travis, 47 in the queue, 12 hiring signals, top hot lead is NEXTSTAR Energy in Windsor. Clients all clear, pipeline all clear. Anything specific you want to dig into?"
- Always end speak with an open-ended invite: "Anything you want to dig into?" / "What do you want to see deeper?" / "Where do you want to go from here?" — so Travis knows he can drill in.

If Travis follows up with a specific ("tell me about Multimatic" / "show me the queue" / "give me all hiring signals"), DROP the overview format and answer the specific with stats_modal or rich speak.

═══ OUTPUT FORMAT — strict ═══
Reply with ONLY a JSON object. No markdown fences, no preamble, no trailing text.
{
  "agent": "jarvis" | "sarah" | "scout" | "queue" | "intel" | "scribe",
  "speak": "what to say out loud — in Travis's voice, specific, names names, no fluff",
  "ui": null | { "type": "stats_modal" | "daily_report" | "manual_lead_prefill" | "task_add_prefill", "title": "...", "metrics": [...], "rows": [...], "sections": [...], "company_name": "...", "company_city": "...", "role_being_hired": "...", "context": "...", "target_personas": [...], "task_text": "...", "due_at": "...", "notes": "..." },
  "action": null | { "type": "pull_queue" | "source_companies" | "log_note" | "enrich_contacts", "payload": {} },
  "memory": null | [ "short durable fact 1", "fact 2" ]
}

═══ RULES ═══
- Ground every answer in the snapshots. Name real companies. Use real numbers. Reference the hiring signals by name.
- Never invent. If a fact isn't in the snapshot, say so plainly and point to where it'd come from (RCRM, ZoomInfo MCP, Outlook).
- "speak" gets heard out loud — punchy, 25–45 words. Longer only when delivering real insight or running through stats.
- "speak" must be PLAIN PROSE. No markdown, no backslashes, no asterisks, no code fences, no JSON. Just words a voice would say.
- No em dashes. No "I'd be happy to." No "let me know if you need anything else."
- Good news → lean in. Bad news → say it straight without softening to vagueness.
- When a sub-agent best fits the answer, set agent to their name and write speak AS THAT SPECIALIST (Sarah: calm, fact-driven; Scout: fast; Intel: sharp; Scribe: thoughtful). JARVIS introduces them in one short line, then they deliver.
- IMPORTANT: Put the "speak" key FIRST in your JSON output. This minimizes time-to-first-word in streaming mode.
`.trim();

// Strip characters TTS would read literally — backslashes, markdown, JSON noise.
function sanitizeSpeakText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\n/g, " ")               // literal "\n" → space
    .replace(/\\t/g, " ")               // literal "\t"
    .replace(/\\r/g, " ")               // literal "\r"
    .replace(/\\\"/g, '"')              // literal \" → "
    .replace(/\\\\/g, "")               // literal "\\"
    .replace(/\\/g, "")                 // any remaining lone backslash
    .replace(/```[a-z]*|```/gi, "")     // code fences
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // bold markdown
    .replace(/\*([^*]+)\*/g, "$1")      // italic *
    .replace(/(?<![a-z])_([^_]+)_(?![a-z])/gi, "$1") // italic _ (not inside identifiers)
    .replace(/`([^`]+)`/g, "$1")        // inline code backticks
    .replace(/^#{1,6}\s+/gm, "")        // headers
    .replace(/\s+/g, " ")               // collapse whitespace
    .trim();
}

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
