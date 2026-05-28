// netlify/edge-functions/jarvis-stream.js
// JARVIS brain — STREAMING variant. Runs on Netlify's Deno-based Edge runtime so the
// response body can flow back to the client token-by-token (regular Functions buffer).
//
// Identical contract to /jarvis (the Node function) but emits SSE:
//   event: speak_delta     data: { "text": "...partial prose..." }   (many)
//   event: speak_done      data: {}                                   (when speak value closes)
//   event: final           data: { agent, action, ui, memory, full }  (when JSON complete)
//   event: error           data: { error: "..." }
//   event: done            data: {}                                   (always last)
//
// The Python voice loop (voice/brain.py) consumes these events. The existing browser
// dashboard still hits /jarvis (non-streaming) so nothing in index.html breaks.
//
// Required Netlify env: ANTHROPIC_API_KEY
// Optional: JARVIS_MODEL (defaults to claude-haiku-4-5-20251001)

const MODEL_DEFAULT = "claude-haiku-4-5-20251001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "jarvis-brain-stream",
        hasKey: Boolean(Netlify.env.get("ANTHROPIC_API_KEY")),
        model: Netlify.env.get("JARVIS_MODEL") || MODEL_DEFAULT,
        runtime: "edge",
      }),
      { headers: { ...CORS, "content-type": "application/json" } }
    );
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } }
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }

  const transcript = (body.transcript || "").trim();
  if (!transcript) {
    return new Response(JSON.stringify({ error: "No transcript" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const context = body.context || {};
  const pipelineSummary = summarizePipeline(context.records || [], context.counts || {});
  const signalsSummary = summarizeSignals(context.hiringSignals || []);
  const styleSamples = summarizeStyleSamples(context.styleSamples || []);
  const memoryFacts = summarizeMemoryFacts(context.memoryFacts || []);
  const followUpsSummary = summarizeFollowUps(context.followUps);
  const recentTurns = (Array.isArray(context.history) ? context.history : []).slice(-20);

  const messages = buildClaudeMessages({
    transcript, context, recentTurns,
    pipelineSummary, signalsSummary, styleSamples, memoryFacts, followUpsSummary,
  });

  const maxTokens = /\b(report|brief|rundown|briefing|recap)\b/i.test(transcript) ? 700 : 350;
  const model = Netlify.env.get("JARVIS_MODEL") || MODEL_DEFAULT;

  // Open the Anthropic stream
  let claudeStream;
  try {
    claudeStream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        // Prompt cache the ~3 KB system prompt. With a warm cache, time-to-first-token
        // drops from ~1.5–2 s to ~300–500 ms and we're billed at 10% the input-token rate
        // for the cached portion. Ephemeral TTL is 5 minutes, refreshed on every hit.
        system: [{ type: "text", text: ROUTING_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });
  } catch (e) {
    return errorEvent(`Claude API unreachable: ${e && e.message || e}`);
  }

  if (!claudeStream.ok) {
    const detail = await claudeStream.text();
    return errorEvent(`Claude returned ${claudeStream.status}: ${detail.slice(0, 400)}`);
  }

  // Transform Anthropic SSE → our SSE with prose-only deltas
  const transformed = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const reader = claudeStream.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";          // raw SSE chunks from Anthropic
      let claudeText = "";         // accumulated decoded text from Claude
      let speakExtractor = makeSpeakExtractor();
      let firedSpeakDone = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          // Split on blank-line boundaries (SSE event delimiter)
          let idx;
          while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
            const rawEvent = sseBuffer.slice(0, idx);
            sseBuffer = sseBuffer.slice(idx + 2);
            const dataLines = rawEvent.split("\n").filter(l => l.startsWith("data: "));
            if (!dataLines.length) continue;
            const payload = dataLines.map(l => l.slice(6)).join("");
            if (payload === "[DONE]") continue;
            let evt;
            try { evt = JSON.parse(payload); } catch { continue; }

            if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
              claudeText += evt.delta.text;
              const out = speakExtractor.feed(evt.delta.text);
              if (out.delta) send("speak_delta", { text: out.delta });
              if (out.closed && !firedSpeakDone) {
                firedSpeakDone = true;
                send("speak_done", {});
              }
            }
          }
        }
      } catch (e) {
        send("error", { error: `Stream read failed: ${e && e.message || e}` });
      }

      if (!firedSpeakDone) send("speak_done", {});

      // Parse the final decision JSON (for action/ui/memory)
      let decision;
      try {
        let cleaned = claudeText.replace(/```json|```/g, "").trim();
        const first = cleaned.indexOf("{");
        const last = cleaned.lastIndexOf("}");
        if (first !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
        decision = JSON.parse(cleaned);
      } catch {
        decision = { agent: "jarvis", action: null, ui: null, memory: null };
      }

      // Fire action webhooks if requested (same logic as non-streaming function)
      let actionResult = null;
      if (decision.action && typeof decision.action === "object" && decision.action.type) {
        const webhooks = {
          pull_queue: Netlify.env.get("MAKE_QUEUE_WEBHOOK"),
          source_companies: Netlify.env.get("MAKE_SCOUT_WEBHOOK"),
          log_note: Netlify.env.get("MAKE_SCRIBE_WEBHOOK"),
          enrich_contacts: Netlify.env.get("MAKE_ENRICH_WEBHOOK"),
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

      send("final", {
        agent: decision.agent || "jarvis",
        speak: typeof decision.speak === "string" ? sanitizeSpeakText(decision.speak) : "",
        action: actionResult,
        ui: decision.ui || null,
        memory: Array.isArray(decision.memory) ? decision.memory.slice(0, 5) : null,
      });
      send("done", {});
      controller.close();
    },
  });

  return new Response(transformed, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "connection": "keep-alive",
    },
  });
};

export const config = { path: "/jarvis-stream" };

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

// Stream a one-shot error event back to the client as SSE so the Python client
// can render it uniformly with successful streams.
function errorEvent(message) {
  const body = `event: error\ndata: ${JSON.stringify({ error: message })}\n\nevent: done\ndata: {}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { ...CORS, "content-type": "text/event-stream; charset=utf-8" },
  });
}

// State-machine that scans Claude's accumulating JSON output, locks onto the
// "speak":"…" string value, and emits JSON-unescaped prose deltas to the client.
// Markdown stripping happens downstream in the Python client at sentence boundaries.
function makeSpeakExtractor() {
  let buffer = "";
  let phase = "PRE_SPEAK";   // PRE_SPEAK | IN_SPEAK | POST_SPEAK
  let cursor = 0;
  let escapePending = false;

  return {
    feed(chunk) {
      buffer += chunk;
      let out = "";
      let closed = false;

      if (phase === "PRE_SPEAK") {
        const m = buffer.match(/"speak"\s*:\s*"/);
        if (!m) return { delta: "", closed: false };
        cursor = m.index + m[0].length;
        phase = "IN_SPEAK";
      }
      if (phase === "IN_SPEAK") {
        while (cursor < buffer.length) {
          const ch = buffer[cursor];
          if (escapePending) {
            escapePending = false;
            if (ch === "n" || ch === "t" || ch === "r" || ch === "b" || ch === "f") out += " ";
            else if (ch === '"') out += '"';
            else if (ch === "\\") out += "";        // drop literal backslash → quiet TTS
            else if (ch === "/") out += "/";
            else out += ch;
            cursor++;
            continue;
          }
          if (ch === "\\") {
            escapePending = true;
            cursor++;
            continue;
          }
          if (ch === '"') {
            closed = true;
            phase = "POST_SPEAK";
            cursor++;
            break;
          }
          out += ch;
          cursor++;
        }
      }
      return { delta: out, closed };
    },
  };
}

function buildClaudeMessages({ transcript, context, recentTurns, pipelineSummary, signalsSummary, styleSamples, memoryFacts, followUpsSummary }) {
  const msgs = [];
  for (const t of recentTurns) {
    if (!t || !t.text || !t.role) continue;
    msgs.push({ role: t.role === "assistant" ? "assistant" : "user", content: String(t.text).slice(0, 1200) });
  }
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

function summarizeMemoryFacts(facts) {
  if (!Array.isArray(facts) || !facts.length) return "";
  return facts.slice(-30).map((f, i) => `${i + 1}. ${String(f).replace(/[\r\n]+/g, " ").trim()}`).join("\n");
}

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

function summarizeStyleSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) return "";
  return samples.slice(-20).map((s, i) => `${i + 1}. "${String(s).replace(/[\r\n]+/g, " ").trim()}"`).join("\n");
}

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

function sanitizeSpeakText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\\"/g, '"')
    .replace(/\\\\/g, "")
    .replace(/\\/g, "")
    .replace(/```[a-z]*|```/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<![a-z])_([^_]+)_(?![a-z])/gi, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ════════════════════════════════════════════════════════════════════════
// Routing prompt — kept in sync with netlify/functions/jarvis.js
// (If you edit one, edit both. Or wait for the planned shared-module refactor.)
// ════════════════════════════════════════════════════════════════════════
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
When you learn something durable about Travis — a preference, a goal, an ongoing campaign, a person/account he cares about, a rule he's stated — emit a "memory" array on the response with 1-3 short fact strings. They get persisted and given back to you on every future call.

═══ ACTIONS ═══
Set "action" when Travis explicitly asks for one:
- "enrich those contacts" → { type: "enrich_contacts", payload: { signal_key: "<key>" } }
- "refresh the queue" → { type: "pull_queue", payload: {} }
- "find me companies like X" → { type: "source_companies", payload: { criteria: "<text>" } }
- "log a note that..." → { type: "log_note", payload: { text: "<note>" } }

═══ OUTPUT FORMAT — strict ═══
Reply with ONLY a JSON object. No markdown fences, no preamble, no trailing text.
{
  "agent": "jarvis" | "sarah" | "scout" | "queue" | "intel" | "scribe",
  "speak": "what to say out loud — in Travis's voice, specific, names names, no fluff",
  "ui": null | { "type": "stats_modal" | "daily_report", "title": "...", "metrics": [...], "rows": [...], "sections": [...] },
  "action": null | { "type": "pull_queue" | "source_companies" | "log_note" | "enrich_contacts", "payload": {} },
  "memory": null | [ "short durable fact 1", "fact 2" ]
}

═══ RULES ═══
- Ground every answer in the snapshots. Name real companies. Use real numbers.
- Never invent. If a fact isn't in the snapshot, say so plainly.
- "speak" gets heard out loud — punchy, 25–45 words.
- "speak" must be PLAIN PROSE. No markdown, no backslashes, no asterisks, no code fences, no JSON.
- No em dashes. No "I'd be happy to." No "let me know if you need anything else."
- IMPORTANT: Put the "speak" key FIRST in your JSON output. This minimizes time-to-first-word in streaming mode.
`.trim();
