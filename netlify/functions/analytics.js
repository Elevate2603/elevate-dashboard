// netlify/functions/analytics.js
// Analytics & CEO Briefing — outreach performance plus the market brain.
//
// Everything numeric is computed HERE, in plain JS, before any model sees it.
// The model writes reasoning and copy; it never assigns a verdict, a market
// state, or a score. That split is the whole design: a number the model made up
// is indistinguishable from a number it measured, and only one of those is safe
// to act on.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY     — Claude API key (console.anthropic.com)
// Optional (the tab renders on demo data without them):
//   ANALYTICS_FETCH_URL   — Make webhook, outreach log rows (brief 1.6)
//   DECISION_LOG_URL      — Make webhook, decision accept/reject/list (brief 1.7)
//   MARKET_SIGNALS_URL    — Make webhook, public market feeds (brain spec 2)
//   FORECAST_LOG_URL      — Make webhook, forecast register (brain spec 5)
//
// SCOPE BOUNDARY (brain spec, section 0): this function reads public and market
// data plus Elevate's own outreach send/reply counts. It never touches internal
// financials, headcount, client rosters, margins or payroll, and the prompts
// below explicitly forbid the model from commenting on them.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/* ══════════════════════════════════════════════════════════════════════
   TUNING CONSTANTS — every threshold in the briefs, in one place
   ══════════════════════════════════════════════════════════════════════ */

const MIN_N = 40;               // below this a segment is never judged (brief 2.3)
const SCALE_MULT = 1.25;
const KILL_MULT = 0.50;

const STATE_STICKY_WEEKS = 3;   // whipsaw guard (brain spec 3.3)
const PREBUY_WEEKS = 10;        // policy event inside this window caps a row at HOLD
const ENTER_SCORE = 70;
const HOLD_SCORE = 45;
const POLICY_SEVERE_WEEKS = 12; // high-severity event inside this forces EXIT

const FORECAST_MIN_RESOLVED = 12;
const FORECAST_RELIABILITY_FLOOR = 0.5;

// Market scoring weights (brain spec 3.2). Sum = 100.
const WEIGHTS = {
  posting_velocity: 35,
  policy_risk: 20,
  layoff_pressure: 15,
  investment_inflow: 15,
  sector_baseline: 10,
  tender_flow: 5,
};

const INPUT_LABELS = {
  posting_velocity: "Posting velocity",
  policy_risk: "Scheduled policy risk",
  layoff_pressure: "Layoff pressure",
  investment_inflow: "Investment inflow",
  sector_baseline: "Sector baseline",
  tender_flow: "Tender flow",
};

/* Tracked markets (brain spec 3.1). One array so rows can be added or dropped
   without touching logic. */
const MARKETS = [
  { id: "auto_windsor",      sector: "Automotive Tier 1/2",              region: "Windsor / Essex" },
  { id: "auto_detroit",      sector: "Automotive Tier 1/2",              region: "Detroit / Michigan" },
  { id: "ev_windsor",        sector: "EV and battery",                   region: "Windsor" },
  { id: "food_windsor",      sector: "Food and beverage manufacturing",  region: "Windsor / Leamington" },
  { id: "3pl_gta",           sector: "Warehousing and 3PL",              region: "Brampton / GTA" },
  { id: "genmfg_on",         sector: "General manufacturing",            region: "Ontario" },
  { id: "municipal_on",      sector: "Municipal and public sector",      region: "Ontario" },
  { id: "construction_on",   sector: "Construction and infrastructure",  region: "Ontario" },
  { id: "semi_phoenix",      sector: "Semiconductor and advanced mfg",   region: "Phoenix / Maricopa" },
  { id: "wh_phoenix",        sector: "Warehousing and logistics",        region: "Phoenix / Maricopa" },
];

/* ══════════════════════════════════════════════════════════════════════
   SMALL HELPERS
   ══════════════════════════════════════════════════════════════════════ */

const iso = (d) => new Date(d).toISOString();
const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function pct(num, den) {
  if (!den) return 0;
  return round1((num / den) * 100);
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && !isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// "qtd" resolves to days since the start of the current calendar quarter.
function rangeDays(range) {
  if (range === "qtd") {
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    return Math.max(1, Math.ceil((now - qStart) / 86400000));
  }
  const n = parseInt(range, 10);
  return [30, 90].indexOf(n) >= 0 ? n : 30;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Acronyms that must not be sentence-cased. "Hr Manager" and "Gm" read as a
// machine wrote them, which undermines everything else on the screen.
const ACRONYMS = { hr: "HR", gm: "GM", ev: "EV", cfo: "CFO", ceo: "CEO", "3pl": "3PL",
  tier1: "Tier 1", tier2: "Tier 2", vms: "VMS", az: "AZ", gta: "GTA", cma: "CMA", po: "PO" };
const TITLE_CASE = (s) =>
  String(s || "other")
    .split(/[_\s]+/)
    .map((w) => (!w ? "" : (ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1)))))
    .join(" ")
    .trim();

/* ══════════════════════════════════════════════════════════════════════
   AGGREGATION (brief 2.3) — pure JS, never the model
   ══════════════════════════════════════════════════════════════════════ */

// Split rows into the requested window and the immediately prior equal window.
function splitPeriods(rows, days, nowMs) {
  const span = days * 86400000;
  const curFrom = nowMs - span;
  const prevFrom = nowMs - span * 2;
  const cur = [], prev = [];
  rows.forEach((r) => {
    const t = parseTs(r.sent_at);
    if (t === null) return;
    if (t >= curFrom && t <= nowMs) cur.push(r);
    else if (t >= prevFrom && t < curFrom) prev.push(r);
  });
  return { cur, prev };
}

const hasReply = (r) => !!parseTs(r.replied_at);
const isPositive = (r) => hasReply(r) && r.reply_sentiment === "positive";
const isMeeting = (r) => r.outcome === "meeting_booked";
const wasOpened = (r) => !!parseTs(r.opened_at) || (Number(r.open_count) || 0) > 0;

function daysToReply(r) {
  const s = parseTs(r.sent_at), p = parseTs(r.replied_at);
  if (s === null || p === null || p < s) return null;
  return (p - s) / 86400000;
}

function periodStats(rows) {
  const sent = rows.length;
  const replies = rows.filter(hasReply).length;
  const positive = rows.filter(isPositive).length;
  const meetings = rows.filter(isMeeting).length;
  const opens = rows.filter(wasOpened).length;
  const lags = rows.map(daysToReply).filter((n) => n !== null);
  return {
    sent,
    replies,
    reply_rate: pct(replies, sent),
    positive_replies: positive,
    positive_rate: pct(positive, sent),
    meetings,
    median_days_to_reply: round1(median(lags)),
    opens,
    open_rate: pct(opens, sent),
  };
}

function buildScoreboard(cur, prev) {
  const c = periodStats(cur), p = periodStats(prev);
  const cell = (k, dp) => ({
    value: dp ? round1(c[k]) : c[k],
    delta: dp ? round1(c[k] - p[k]) : c[k] - p[k],
  });
  return {
    sent: cell("sent"),
    replies: cell("replies"),
    reply_rate: cell("reply_rate", true),
    positive_replies: cell("positive_replies"),
    positive_rate: cell("positive_rate", true),
    meetings: cell("meetings"),
    median_days_to_reply: cell("median_days_to_reply", true),
    opens: cell("opens"),
    open_rate: cell("open_rate", true),
  };
}

/**
 * Verdict is assigned HERE and nowhere else (brief 2.3). The model is shown the
 * result and told not to relitigate it. TOO_THIN wins over everything: a 40%
 * reply rate on 5 sends is noise, and calling it SCALE would send Travis after
 * a pattern that does not exist.
 */
function verdictFor(sent, replyRate, overallRate) {
  if (sent < MIN_N) return "TOO_THIN";
  if (replyRate >= overallRate * SCALE_MULT) return "SCALE";
  if (replyRate <= overallRate * KILL_MULT) return "KILL";
  return "HOLD";
}

function groupRows(rows, keyFn, labelFn, overallRate) {
  const buckets = new Map();
  rows.forEach((r) => {
    const key = keyFn(r);
    if (key === null || key === undefined || key === "") return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  });
  const out = [];
  buckets.forEach((list, key) => {
    const sent = list.length;
    const replies = list.filter(hasReply).length;
    const positive = list.filter(isPositive).length;
    const reply_rate = pct(replies, sent);
    out.push({
      label: labelFn ? labelFn(key) : TITLE_CASE(key),
      sent,
      replies,
      reply_rate,
      positive,
      positive_rate: pct(positive, sent),
      verdict: verdictFor(sent, reply_rate, overallRate),
    });
  });
  // Judged rows first by reply rate, TOO_THIN always at the bottom (brief 3.5).
  out.sort((a, b) => {
    const at = a.verdict === "TOO_THIN" ? 1 : 0;
    const bt = b.verdict === "TOO_THIN" ? 1 : 0;
    if (at !== bt) return at - bt;
    return b.reply_rate - a.reply_rate;
  });
  return out;
}

function buildSegments(rows) {
  const overallRate = pct(rows.filter(hasReply).length, rows.length);
  return {
    persona:       groupRows(rows, (r) => r.persona, null, overallRate),
    industry:      groupRows(rows, (r) => r.industry, null, overallRate),
    region:        groupRows(rows, (r) => r.region, null, overallRate),
    signal_type:   groupRows(rows, (r) => r.signal_type, null, overallRate),
    opener_style:  groupRows(rows, (r) => r.opener_style, null, overallRate),
    sequence_step: groupRows(rows, (r) => String(r.sequence_step || ""), (k) => "Step " + k, overallRate),
    send_dow:      groupRows(rows, (r) => {
      const t = parseTs(r.sent_at);
      return t === null ? "" : String(new Date(t).getDay());
    }, (k) => DOW[Number(k)] || "Unknown", overallRate),
  };
}

/* ══════════════════════════════════════════════════════════════════════
   MARKET CONDITION BOARD (brain spec 3) — states from numbers, not opinion
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Each raw input is normalised to 0..100 then weighted. Two of them are
 * penalties and score inversely: more layoff pressure and more scheduled policy
 * risk make a market worse, not better.
 */
function scoreMarket(inp) {
  const parts = {};

  // posting velocity: percentage change, -50%..+50% mapped across the range
  parts.posting_velocity = clamp(50 + (Number(inp.posting_velocity_pct) || 0), 0, 100);

  // policy risk: 0..100 severity-and-proximity penalty, inverted
  parts.policy_risk = clamp(100 - (Number(inp.policy_risk_index) || 0), 0, 100);

  // layoff pressure: headcount over 60 days, 0 clean, 1500+ maximal, inverted
  parts.layoff_pressure = clamp(100 - ((Number(inp.layoff_headcount_60d) || 0) / 15), 0, 100);

  // investment inflow: already lag-weighted upstream so a battery plant does not
  // read as near-term demand (brain spec 3.2)
  parts.investment_inflow = clamp(Number(inp.investment_index) || 0, 0, 100);

  // sector baseline: PMI sub-indices / published forecasts, 0..100
  parts.sector_baseline = clamp(Number(inp.sector_baseline) || 0, 0, 100);

  // tender flow: count over 90 days, 20+ maximal
  parts.tender_flow = clamp(((Number(inp.tender_count_90d) || 0) / 20) * 100, 0, 100);

  let score = 0;
  const contributions = [];
  Object.keys(WEIGHTS).forEach((k) => {
    const weighted = (parts[k] * WEIGHTS[k]) / 100;
    score += weighted;
    contributions.push({
      key: k,
      label: INPUT_LABELS[k],
      normalized: Math.round(parts[k]),
      weighted: round1(weighted),
      // distance from a neutral 50 is what makes an input "moving" the score
      influence: Math.abs(parts[k] - 50) * (WEIGHTS[k] / 100),
      display: describeInput(k, inp),
    });
  });
  contributions.sort((a, b) => b.influence - a.influence);
  return { score: Math.round(clamp(score, 0, 100)), contributions };
}

function describeInput(key, inp) {
  switch (key) {
    case "posting_velocity": {
      const v = Number(inp.posting_velocity_pct) || 0;
      return (v >= 0 ? "+" : "") + round1(v) + "% postings vs 90d avg";
    }
    case "policy_risk":
      return (Number(inp.policy_risk_index) || 0) + "/100 scheduled policy risk";
    case "layoff_pressure":
      return (Number(inp.layoff_headcount_60d) || 0) + " WARN/mass-term roles, 60d";
    case "investment_inflow":
      return (Number(inp.investment_index) || 0) + "/100 lag-weighted investment";
    case "sector_baseline":
      return (Number(inp.sector_baseline) || 0) + "/100 PMI and forecast baseline";
    case "tender_flow":
      return (Number(inp.tender_count_90d) || 0) + " open tenders, 90d";
    default:
      return "";
  }
}

function weeksUntil(dateStr, nowMs) {
  const t = parseTs(dateStr);
  if (t === null) return null;
  return (t - nowMs) / (7 * 86400000);
}

/**
 * State resolution, in strict order (brain spec 3.3 / 3.4):
 *   1. A high-severity policy event inside 12 weeks forces EXIT outright.
 *   2. Otherwise the raw score proposes a state from the thresholds.
 *   3. A pre-buy window caps the row at HOLD — postings are inflated by pull
 *      forward, so ENTER on that data would be buying borrowed demand.
 *   4. The proposed state only takes effect once it has held for three
 *      consecutive weeks. Until then the previous state stands. This is the
 *      whipsaw guard: a holiday week must not flip a market.
 */
function resolveState(score, market, nowMs) {
  const history = Array.isArray(market.score_history) ? market.score_history.slice() : [];
  const prevState = market.previous_state || "HOLD";
  const ev = market.policy_event || null;
  const evWeeks = ev ? weeksUntil(ev.date, nowMs) : null;

  const severeSoon = !!(ev && ev.severity === "high" && evWeeks !== null && evWeeks >= 0 && evWeeks <= POLICY_SEVERE_WEEKS);
  const prebuy = !!(ev && evWeeks !== null && evWeeks >= 0 && evWeeks <= PREBUY_WEEKS);

  let proposed;
  if (severeSoon) proposed = "EXIT";
  else if (score >= ENTER_SCORE) proposed = "ENTER";
  else if (score >= HOLD_SCORE) proposed = "HOLD";
  else proposed = "EXIT";

  // pre-buy caps the ceiling, it never rescues a failing market
  let capped = false;
  if (prebuy && proposed === "ENTER") { proposed = "HOLD"; capped = true; }

  // Three-consecutive-week guard. `score_history` is oldest-first weekly scores
  // INCLUDING this week; we re-derive what each week would have proposed.
  const weekStates = history.slice(-STATE_STICKY_WEEKS).map((s) => {
    if (severeSoon) return "EXIT";
    let st = s >= ENTER_SCORE ? "ENTER" : s >= HOLD_SCORE ? "HOLD" : "EXIT";
    if (prebuy && st === "ENTER") st = "HOLD";
    return st;
  });
  const held = weekStates.length >= STATE_STICKY_WEEKS && weekStates.every((s) => s === proposed);

  // An EXIT forced by a dated policy event is a hard stop, not a trend, so it
  // applies immediately rather than waiting three weeks to be believed.
  const state = (severeSoon || held || proposed === prevState) ? proposed : prevState;

  // how long the state we are actually showing has been in force
  let weeksInState = 1;
  for (let i = weekStates.length - 1; i >= 0; i--) {
    if (weekStates[i] === state) weeksInState++; else break;
  }

  return {
    state,
    proposed,
    // an EXIT forced by a dated event is a different fact from a low score, and
    // the two must never be reported as the same thing
    exit_forced_by_event: severeSoon,
    pending: proposed !== state ? proposed : null,
    weeks_in_state: Math.min(weeksInState, 99),
    prebuy_capped: capped,
    prebuy_active: prebuy,
    policy_event: ev,
    weeks_to_event: evWeeks === null ? null : round1(evWeeks),
  };
}

// "Get in by" works backwards from when hiring lands, so the relationship
// exists before the requisition does. "Get out before" is the policy date.
function timingCall(row, nowMs) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  if (row.state === "EXIT" && row.policy_event && row.policy_event.date) {
    return { kind: "get_out_before", date: String(row.policy_event.date).slice(0, 10),
             note: "Stop acquisition spend here before " + String(row.policy_event.date).slice(0, 10) + "." };
  }
  if (row.state === "ENTER") {
    const leadWeeks = Number(row.hiring_lead_weeks) || 8;
    // be in the room at roughly half the lead time, never less than three weeks out
    const beIn = Math.max(3, Math.round(leadWeeks / 2));
    return { kind: "get_in_by", date: fmt(nowMs + beIn * 7 * 86400000),
             note: "Hiring lands in about " + leadWeeks + " weeks. Relationships need to exist by then." };
  }
  return { kind: "none", date: "", note: "" };
}

function buildMarketBoard(marketInputs, nowMs) {
  const byId = {};
  (marketInputs || []).forEach((m) => { byId[m.id] = m; });

  return MARKETS.map((def) => {
    const inp = byId[def.id];
    if (!inp) {
      return {
        id: def.id, sector: def.sector, region: def.region,
        state: "HOLD", score: 0, delta_wow: 0, weeks_in_state: 0,
        movers: [], reason: "", timing: { kind: "none", date: "", note: "" },
        prebuy_active: false, prebuy_capped: false, policy_event: null,
        no_data: true,
      };
    }
    const scored = scoreMarket(inp);
    const st = resolveState(scored.score, inp, nowMs);
    const hist = Array.isArray(inp.score_history) ? inp.score_history : [];
    const prevScore = hist.length >= 2 ? hist[hist.length - 2] : scored.score;

    const row = {
      id: def.id,
      sector: def.sector,
      region: def.region,
      score: scored.score,
      delta_wow: scored.score - prevScore,
      state: st.state,
      pending_state: st.pending,
      weeks_in_state: st.weeks_in_state,
      prebuy_active: st.prebuy_active,
      prebuy_capped: st.prebuy_capped,
      exit_forced_by_event: !!st.exit_forced_by_event,
      policy_event: st.policy_event,
      weeks_to_event: st.weeks_to_event,
      hiring_lead_weeks: inp.hiring_lead_weeks || null,
      movers: scored.contributions.slice(0, 2).map((c) => ({ label: c.label, display: c.display })),
      // The full arithmetic, so a score can be opened up and checked rather than
      // taken on faith. "77" on its own tells nobody anything.
      breakdown: scored.contributions.map((c) => ({
        label: c.label, display: c.display, weight: WEIGHTS[c.key],
        normalized: c.normalized, points: c.weighted,
      })),
      reason: "",   // written by the model, never the score
      no_data: false,
    };
    row.timing = timingCall(row, nowMs);
    return row;
  });
}

/**
 * The model returns a targeting list carrying its own `state` and `score`. It
 * was told not to change them, but "told not to" is not a guarantee, and a
 * Targeting card reading ENTER beside a board row reading EXIT is worse than
 * either alone: Travis cannot tell which to believe.
 *
 * So the board wins, always. We match each card back to a tracked market and
 * overwrite state and score with the computed ones. A card naming a market we
 * do not track keeps its prose but loses its state entirely, because we have
 * nothing to stand behind.
 */
function reconcileTargeting(list, board) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const drifted = [];
  const out = (Array.isArray(list) ? list : []).map((t) => {
    const m = board.filter((b) =>
      norm(b.sector) === norm(t.sector) &&
      (norm(b.region) === norm(t.region) || norm(b.region).indexOf(norm(t.region)) >= 0 ||
       norm(t.region).indexOf(norm(b.region)) >= 0))[0];
    if (!m) {
      return Object.assign({}, t, { state: "", score: null, untracked: true });
    }
    if (t.state && t.state !== m.state) {
      drifted.push(t.sector + " / " + t.region + ": model said " + t.state + ", board says " + m.state);
    }
    return Object.assign({}, t, {
      state: m.state, score: m.score, market_id: m.id,
      window: t.window || (m.timing && m.timing.note) || "",
    });
  });
  return { targeting: out, drifted };
}

/* ══════════════════════════════════════════════════════════════════════
   FORECAST REGISTER (brain spec 5) — a claim that cannot be checked is
   rejected before it is ever stored
   ══════════════════════════════════════════════════════════════════════ */

/**
 * The public series a forecast may resolve against. Each entry carries the
 * words that identify it, because the model will not write our snake_case ids
 * back verbatim. The brief's own example of a GOOD call is "checkable against
 * Adzuna Windsor NAICS 3361-3363 counts", which an exact-substring test would
 * reject outright. Matching on identifying words accepts that and still refuses
 * anything that is not one of these series.
 */
const PUBLIC_METRICS = [
  { id: "adzuna_postings",                any: ["adzuna"] },
  { id: "jooble_postings",                any: ["jooble"] },
  { id: "statcan_windsor_cma_employment", all: ["statcan", "windsor"] },
  { id: "statcan_ontario_manufacturing",  all: ["statcan", "ontario"] },
  { id: "pmi_new_orders",                 all: ["pmi", "order"] },
  { id: "pmi_employment",                 all: ["pmi", "employment"] },
  { id: "asa_staffing_index",             any: ["asa"] },
  { id: "bls_temp_help_payrolls",         any: ["bls"] },
  { id: "warn_headcount",                 any: ["warn"] },
  { id: "tender_count",                   any: ["tender"] },
];
const PUBLIC_METRIC_IDS = PUBLIC_METRICS.map((m) => m.id);

// Returns the canonical series id, or null if the text names no known series.
function canonicalMetric(raw) {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return null;
  const has = (w) => s.indexOf(w) >= 0;
  // an exact id wins outright
  const exact = PUBLIC_METRICS.filter((m) => s.indexOf(m.id.replace(/_/g, " ")) >= 0)[0];
  if (exact) return exact.id;
  const hit = PUBLIC_METRICS.filter((m) =>
    (m.all ? m.all.every(has) : false) || (m.any ? m.any.some(has) : false))[0];
  return hit ? hit.id : null;
}

function forecastRejectReason(f) {
  if (!f || typeof f !== "object") return "not an object";
  const claim = String(f.claim || "");
  if (!claim.trim()) return "no claim text";
  if (!/\d/.test(claim)) return "claim contains no number";
  if (parseTs(f.resolve_at) === null) return "no valid resolve_at date";
  if (!String(f.metric || "").trim()) return "no named public metric";
  if (!canonicalMetric(f.metric)) return "metric is not a known public series";
  if (typeof f.predicted_value !== "number" || isNaN(f.predicted_value)) return "predicted_value is not a number";
  return null;
}

// Same call proposed on two refreshes is one call, not two. Without this the
// register fills with repeats every time Travis presses Refresh.
function forecastKey(f) {
  return String(f.claim || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120) +
    "|" + String(f.resolve_at || "").slice(0, 10);
}

function buildForecastRegister(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const accepted = [], rejected = [], seen = {};
  let duplicates = 0;
  list.forEach((f) => {
    const why = forecastRejectReason(f);
    if (why) { rejected.push({ claim: String((f && f.claim) || "").slice(0, 160), reason: why }); return; }
    const k = forecastKey(f);
    if (seen[k]) { duplicates++; return; }
    seen[k] = 1;
    // store the canonical series id so the register resolves consistently even
    // when the model described it in prose
    accepted.push(Object.assign({}, f, { metric: canonicalMetric(f.metric) }));
  });

  const resolved = accepted.filter((f) => f.outcome && f.outcome !== "pending");
  const hits = resolved.filter((f) => f.outcome === "hit").length;
  const highConf = resolved.filter((f) => f.confidence === "high");
  const highHits = highConf.filter((f) => f.outcome === "hit").length;

  const scoreable = resolved.length >= FORECAST_MIN_RESOLVED;
  const highRate = highConf.length ? highHits / highConf.length : null;

  return {
    forecasts: accepted.sort((a, b) => (parseTs(b.created_at) || 0) - (parseTs(a.created_at) || 0)).slice(0, 40),
    resolved_count: resolved.length,
    // Below the floor we show the count, never a percentage: a hit rate off four
    // resolved calls invites more confidence than it can carry.
    hit_rate: scoreable ? pct(hits, resolved.length) : null,
    scoreable,
    unreliable: !!(scoreable && highConf.length >= FORECAST_MIN_RESOLVED && highRate !== null && highRate < FORECAST_RELIABILITY_FLOOR),
    rejected,
    duplicates,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   CLAUDE CALLS
   ══════════════════════════════════════════════════════════════════════ */

const DOCTRINE = `Elevate outreach doctrine, which any copy you write must follow:
- Relationship first. Partner, not vendor. The business follows the relationship.
- Honest over hype. Never claim what Elevate cannot do.
- Never use filler openers. Banned outright: "hope you've been well", "hope
  this finds you well", "hope all is well", "just checking in", and anything
  similar. Open with something specific and real.
- No em dashes anywhere.
- No buzzwords, no scheduler links, no pushy closes.
- Three to four sentences. Signed "Travis".
- Format as SUBJECT: / BODY: with line breaks.`;

const BRIEFING_SYSTEM = `You are the CEO advisor for Elevate RS Corp, a CAMSC-certified staffing and
recruitment agency headquartered in Windsor, Ontario, with operations in
Brampton/GTA, Detroit/Michigan, and Phoenix/Maricopa. Sectors: automotive
Tier 1/2, EV/battery, general manufacturing, food and beverage, warehousing
and 3PL, government and municipal.

You are given pre-computed outreach performance data. Do not recalculate it.
Do not invent numbers that are not in the input.

Produce at most three decisions for the coming week. Each decision must:
- name a specific segment from the data
- cite the actual number that justifies it
- state a concrete action Travis can take on Monday morning
- state what it costs or frees up

Rules you must follow:
- Never make a recommendation based on open rate. Open rates from enterprise
  Microsoft tenants are inflated by automated link and image scanning. Reply
  rate and positive reply rate are the only performance metrics you trust.
- Never declare a winner or loser on a segment with fewer than 40 sends. Say
  the sample is too thin and state how many more sends are needed.
- State your confidence and separate findings that are solid from findings
  that are directional.
- If you recommend a copy change, write the actual replacement email.

${DOCTRINE}

Respond with JSON only. No preamble, no markdown fences.
{
  "headline": "one sentence read of the numbers",
  "decisions": [
    { "title": "", "reasoning": "", "copy_test": "SUBJECT: ...\\nBODY: ..." }
  ],
  "confidence": "one or two sentences on what is solid and what is not"
}`;

// Lag table below is the CORRECTED one from CEO_BRAIN_SPEC section 1. The
// pre-buy clause is the load-bearing addition: without it a pull-forward spike
// reads as strength and the brain fails to warn.
const RADAR_SYSTEM = `You are the CEO advisor for Elevate RS Corp, a staffing and recruitment agency
in Windsor Ontario with operations in Brampton/GTA, Detroit/Michigan, and
Phoenix/Maricopa. Sectors: automotive Tier 1/2, EV/battery, general
manufacturing, food and beverage, warehousing and 3PL, government and
municipal. CAMSC certified, which is a scored advantage on public sector and
large-corporate supplier diversity programs.

Search for current conditions affecting these sectors and regions. Then rank
where Elevate should spend next month's outreach capacity, and list the macro
forces that are about to move those markets.

The most important thing you produce is timing. For every macro item, state
how long until it shows up in staffing demand, and why that lag exists. Use
these mechanics as your baseline and adjust with what you find:
- A tariff or trade-policy shock with a known effective date pulls impact
  FORWARD of that date. OEMs announce downtime before the date rather than
  build inventory they cannot sell. Feeder and Tier 1 plants feel it within
  days of the OEM announcement, and contract labour is cut first.
- Expect a pre-buy distortion in the 6 to 10 weeks BEFORE a scheduled tariff
  increase: customers pull shipments forward to beat the date, temporarily
  raising demand, overtime, and job postings. Treat a demand spike in that
  window as borrowed, not earned, and say so explicitly.
- An OEM schedule change with no policy driver reaches Tier 1 contract
  headcount in 4 to 8 weeks.
- Battery and EV plant capex turns into construction and commissioning
  hiring in 6 to 12 months, production hiring later.
- A public tender award converts to a placement need in 2 to 6 weeks.
- A major facility investment announcement converts to construction hiring
  in 6 to 18 months, and to operations hiring 12 to 24 months after that.
- Rate cuts reopen shelved capex over 2 to 3 quarters, warehousing and
  distribution responding first.

Every item needs a "do now" action, even if the action is to do nothing yet.
Do not use em dashes.

You are not a cheerleader and you are not a doomsayer. A warning you soften
costs Travis money. A warning you invent costs him money too.

Rules:
- Every market call contains a number and a date it can be checked against,
  and names the public data series it resolves against. "Automotive may
  soften" is useless. "Windsor automotive job postings down 20 to 30% by end
  of Q1 2027, checkable against Adzuna Windsor NAICS 3361-3363 counts" is a
  call.
- State the counter-case. Say what would have to be true for you to be wrong.
- Flag any indicator whose measurement window closed before a known shock. A
  strong reading collected before the news is not evidence the news does not
  matter.
- Never recommend entering a market without naming what Elevate would have to
  build to serve it: credentials, licences, insurance, candidate supply, and
  roughly how long that takes. If the build time exceeds the window the
  opportunity is open, say the opportunity is not available and say why.
- Staffing has two sides. A market is only worth entering if candidate supply
  exists in that geography. Assess supply, not just demand.
- Distinguish a market pausing from a market leaving.
- Do not comment on Elevate's internal operations, finances, or staffing
  levels. You have no visibility into them and no basis for an opinion. Your
  job is the outside world and what it means for where to sell.

You are given a Market Condition Board whose STATE and SCORE were computed from
public data before you were called. Do not change them and do not argue with
them. Write the one-line reason for each row, and produce the targeting list
and macro watch beneath them.

${DOCTRINE}

Respond with JSON only. No preamble, no markdown fences. Keep it tight: this
must fit in a small response, so no long prose.
{
  "macro": [
    { "headline": "", "lag": "e.g. Tier 1 impact in 4 to 8 weeks", "urgent": true,
      "explanation": "two sentences at most", "action": "" }
  ],
  "forecasts": [
    { "claim": "must contain a number and a date", "market": "", "metric": "one of: ${PUBLIC_METRIC_IDS.join(", ")}",
      "predicted_value": 0, "predicted_direction": "up|down|flat", "resolve_at": "ISO date",
      "confidence": "high|medium|low", "basis": "" }
  ]
}
Four macro items, two forecasts. Nothing else.`;

async function anthropic(body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error("Anthropic " + r.status + ": " + text.slice(0, 300));
    return JSON.parse(text);
  } catch (e) {
    // an AbortError surfaces as "This operation was aborted", which tells nobody
    // what actually happened; name the real cause so meta.warnings is useful
    if (e && (e.name === "AbortError" || /aborted/i.test(String(e.message)))) {
      throw new Error("timed out after " + Math.round((timeoutMs || 20000) / 1000) + "s");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * With web_search enabled `content` is a mixed array of text, server_tool_use
 * and web_search_tool_result blocks, so content[0] or content[1] is a coin
 * flip. Join every text block and take the last balanced JSON object.
 * Same approach already proven in market-hotspots.js.
 */
function extractJson(data) {
  const blocks = (data && Array.isArray(data.content) ? data.content : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  const joined = blocks.join("\n").replace(/```json/gi, "").replace(/```/g, "");
  const start = joined.indexOf("{");
  const end = joined.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in response");
  return JSON.parse(joined.slice(start, end + 1));
}

async function briefingCall(scoreboard, segments) {
  const data = await anthropic({
    model: MODEL,
    max_tokens: 1000,
    system: BRIEFING_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify({ scoreboard, segments }) }],
  }, 20000);
  return extractJson(data);
}

async function radarCall(board) {
  const data = await anthropic({
    model: MODEL,
    max_tokens: 700,
    system: RADAR_SYSTEM,
    // 4 searches plus generation overran the 26s function ceiling on the first
    // live run. Two is enough for a weekly market read and leaves headroom.
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    messages: [{
      role: "user",
      content: "Market Condition Board, already computed. Do not change state or score:\n" +
        JSON.stringify(board.map((m) => ({
          id: m.id, sector: m.sector, region: m.region, state: m.state,
          score: m.score, delta_wow: m.delta_wow, movers: m.movers,
          prebuy_active: m.prebuy_active, policy_event: m.policy_event,
        }))),
    }],
  }, 21000);
  return extractJson(data);
}

/* ══════════════════════════════════════════════════════════════════════
   DEMO DATA
   The rows are GENERATED, not hardcoded, from a fixed seed. That means the
   real aggregation, the real verdict thresholds and the real market scoring
   all run against them, so the logic is exercised now rather than the day the
   Make feeds land. Same seed every time, so the numbers are stable.
   ══════════════════════════════════════════════════════════════════════ */

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// Reply likelihood per bucket, so the demo shows a real pattern rather than noise.
const DEMO_PERSONA = [
  ["plant_manager", 0.15], ["production_manager", 0.13], ["hr_manager", 0.08],
  ["warehouse_manager", 0.05], ["finance", 0.02], ["gm", 0.09], ["engineering_manager", 0.06],
];
const DEMO_INDUSTRY = [
  ["automotive_tier1", 0.07], ["automotive_tier2", 0.05], ["food_beverage", 0.14],
  ["warehouse_3pl", 0.12], ["general_manufacturing", 0.09], ["municipal_public", 0.10], ["ev_battery", 0.06],
];
const DEMO_REGION = [
  ["windsor_essex", 0.11], ["gta_brampton", 0.10], ["detroit_michigan", 0.05], ["phoenix_maricopa", 0.07],
];
const DEMO_SIGNAL = [
  ["job_posting", 0.13], ["tender", 0.11], ["expansion", 0.08],
  ["news", 0.06], ["funding", 0.05], ["cold", 0.03], ["manual", 0.09],
];
const DEMO_OPENER = [
  ["specific_posting", 0.13], ["specific_shift", 0.13], ["company_news", 0.06],
  ["growth", 0.05], ["referral", 0.10], ["other", 0.04],
];

function demoRows(days, nowMs) {
  const rnd = lcg(20260901);
  const rows = [];
  const span = days * 2 * 86400000;   // current window plus the prior one
  // Volume is set so a 30 day window lands near the ~412 sends the brief uses as
  // its illustration, which is also enough for most segments to clear MIN_N and
  // actually get a verdict rather than reading TOO THIN across the board.
  const total = Math.round(days * 25);
  for (let i = 0; i < total; i++) {
    const persona = pick(rnd, DEMO_PERSONA);
    const industry = pick(rnd, DEMO_INDUSTRY);
    const region = pick(rnd, DEMO_REGION);
    const signal = pick(rnd, DEMO_SIGNAL);
    const opener = pick(rnd, DEMO_OPENER);
    const step = 1 + Math.floor(rnd() * 3);
    // skewed toward recent so the prior-period deltas are non-zero, the way a
    // program that is growing actually looks
    const sentAt = nowMs - Math.floor(Math.pow(rnd(), 1.35) * span);
    const dow = new Date(sentAt).getDay();

    // blended likelihood, nudged by step and weekday so those dimensions move too
    let p = (persona[1] + industry[1] + region[1] + signal[1] + opener[1]) / 5;
    p *= step === 2 ? 1.5 : step === 3 ? 1.2 : 0.85;
    p *= (dow === 0 || dow === 6) ? 0.3 : (dow === 5 ? 0.6 : 1.05);

    const replied = rnd() < p;
    const replyMs = replied ? sentAt + Math.floor((0.2 + rnd() * 3.5) * 86400000) : null;
    const sentiment = !replied ? "" : (rnd() < 0.38 ? "positive" : rnd() < 0.6 ? "neutral" : rnd() < 0.85 ? "not_now" : "negative");
    const meeting = sentiment === "positive" && rnd() < 0.42;

    rows.push({
      contact_slug: "demo-" + i,
      persona: persona[0], industry: industry[0], region: region[0],
      signal_type: signal[0], opener_style: opener[0],
      sequence_step: step,
      sent_at: iso(sentAt),
      opened_at: rnd() < 0.34 ? iso(sentAt + 3600000) : "",
      open_count: rnd() < 0.34 ? 1 + Math.floor(rnd() * 3) : 0,
      replied_at: replyMs ? iso(replyMs) : "",
      reply_sentiment: sentiment,
      outcome: meeting ? "meeting_booked" : "",
      outcome_at: meeting && replyMs ? iso(replyMs + 86400000) : "",
    });
  }
  return rows;
}

function demoMarketInputs(nowMs) {
  const wk = (n) => iso(nowMs + n * 7 * 86400000);
  return [
    { id: "auto_windsor", posting_velocity_pct: 12, policy_risk_index: 72, layoff_headcount_60d: 640,
      investment_index: 45, sector_baseline: 41, tender_count_90d: 2, hiring_lead_weeks: 6,
      score_history: [58, 54, 49, 44], previous_state: "HOLD",
      policy_event: { label: "Scheduled tariff step-up on cross-border auto parts", date: wk(7), severity: "high" } },
    { id: "auto_detroit", posting_velocity_pct: -14, policy_risk_index: 66, layoff_headcount_60d: 980,
      investment_index: 38, sector_baseline: 39, tender_count_90d: 1, hiring_lead_weeks: 8,
      score_history: [51, 46, 42, 40], previous_state: "HOLD",
      policy_event: { label: "Same tariff step-up, US side", date: wk(7), severity: "high" } },
    { id: "ev_windsor", posting_velocity_pct: 6, policy_risk_index: 22, layoff_headcount_60d: 0,
      investment_index: 74, sector_baseline: 58, tender_count_90d: 3, hiring_lead_weeks: 34,
      score_history: [64, 66, 67, 68], previous_state: "HOLD", policy_event: null },
    { id: "food_windsor", posting_velocity_pct: 24, policy_risk_index: 8, layoff_headcount_60d: 0,
      investment_index: 61, sector_baseline: 72, tender_count_90d: 5, hiring_lead_weeks: 5,
      score_history: [74, 78, 81, 84], previous_state: "ENTER", policy_event: null },
    { id: "3pl_gta", posting_velocity_pct: 17, policy_risk_index: 12, layoff_headcount_60d: 60,
      investment_index: 58, sector_baseline: 69, tender_count_90d: 4, hiring_lead_weeks: 4,
      score_history: [73, 74, 77, 79], previous_state: "ENTER", policy_event: null },
    { id: "genmfg_on", posting_velocity_pct: -3, policy_risk_index: 30, layoff_headcount_60d: 210,
      investment_index: 47, sector_baseline: 52, tender_count_90d: 3, hiring_lead_weeks: 7,
      score_history: [57, 56, 55, 54], previous_state: "HOLD", policy_event: null },
    { id: "municipal_on", posting_velocity_pct: 9, policy_risk_index: 6, layoff_headcount_60d: 0,
      investment_index: 55, sector_baseline: 64, tender_count_90d: 14, hiring_lead_weeks: 5,
      score_history: [70, 72, 73, 75], previous_state: "ENTER", policy_event: null },
    { id: "construction_on", posting_velocity_pct: 4, policy_risk_index: 14, layoff_headcount_60d: 90,
      investment_index: 66, sector_baseline: 57, tender_count_90d: 9, hiring_lead_weeks: 12,
      score_history: [62, 63, 64, 65], previous_state: "HOLD", policy_event: null },
    { id: "semi_phoenix", posting_velocity_pct: 15, policy_risk_index: 18, layoff_headcount_60d: 0,
      investment_index: 82, sector_baseline: 63, tender_count_90d: 2, hiring_lead_weeks: 40,
      score_history: [66, 68, 69, 70], previous_state: "HOLD", policy_event: null },
    { id: "wh_phoenix", posting_velocity_pct: 11, policy_risk_index: 10, layoff_headcount_60d: 40,
      investment_index: 60, sector_baseline: 61, tender_count_90d: 3, hiring_lead_weeks: 5,
      score_history: [66, 67, 68, 69], previous_state: "HOLD", policy_event: null },
  ];
}

function demoRadar() {
  return {
    market_reasons: [
      { id: "food_windsor", reason: "Postings up 24% on a clean policy picture and the strongest baseline on the board." },
      { id: "3pl_gta", reason: "Steady posting growth, minimal policy exposure, shortest lead time to a placement." },
      { id: "municipal_on", reason: "Fourteen open tenders in ninety days and CAMSC scores on most of them." },
      { id: "auto_windsor", reason: "A dated tariff step-up sits seven weeks out and feeder layoffs have already started." },
      { id: "auto_detroit", reason: "Postings down 14% with the same dated policy exposure on the US side." },
      { id: "ev_windsor", reason: "Capex is committed but hiring is nine months out, so this is relationship building rather than a pipeline yet." },
      { id: "semi_phoenix", reason: "Large investment inflow with a long conversion, worth building into before it moves." },
      { id: "genmfg_on", reason: "Flat postings and a soft baseline, holding rather than moving either way." },
      { id: "construction_on", reason: "Tender flow is healthy but conversion runs a quarter behind the award." },
      { id: "wh_phoenix", reason: "Modest growth, low risk, no reason to change posture this month." },
    ],
    targeting: [
      { sector: "Food and beverage manufacturing", region: "Windsor / Leamington", state: "ENTER", score: 84,
        target_titles: ["Plant Manager", "Production Manager", "HR Manager"],
        company_profile: "Greenhouse and processing operations, 80 to 400 staff, running two or three shifts with seasonal peaks.",
        hook: "Afternoon and midnight shift postings that have stayed open more than three weeks, which usually means coverage is short rather than the line growing.",
        avoid: "Do not lead with growth or expansion language. Cost pressure here is constant and growth talk reads as a vendor who has not looked at the business.",
        window: "Get in by 2026-09-16. Hiring lands in about five weeks." },
      { sector: "Warehousing and 3PL", region: "Brampton / GTA", state: "ENTER", score: 79,
        target_titles: ["Warehouse Manager", "Operations Manager", "Site Manager"],
        company_profile: "Contract logistics and fulfilment, 100 to 600 staff, peak season staffing already being planned.",
        hook: "Repeat postings for the same pick and pack roles across two or three sites, which points at turnover rather than expansion.",
        avoid: "Do not open on rate. This market is price-shopped constantly and it puts you in the vendor pile immediately.",
        window: "Get in by 2026-09-15. Peak planning closes before then." },
      { sector: "Municipal and public sector", region: "Ontario", state: "ENTER", score: 75,
        target_titles: ["HR Manager", "Director of Operations", "Procurement Lead"],
        company_profile: "Municipalities and public agencies with active vendor-of-record cycles.",
        hook: "Open tender cycles where CAMSC certification is a scored line rather than a nice-to-have.",
        avoid: "Do not pitch speed. Procurement here rewards compliance and documentation, and speed language reads as someone who has not bid before.",
        window: "Get in by 2026-09-16. Award to placement runs two to six weeks." },
      { sector: "EV and battery", region: "Windsor", state: "HOLD", score: 68,
        target_titles: ["Plant Manager", "Maintenance Manager", "Commissioning Lead"],
        company_profile: "Battery and EV supply chain, pre-production and commissioning stage.",
        hook: "Commissioning and maintenance postings appearing before production hiring, which is the real early signal here.",
        avoid: "Do not talk about volume staffing or rates yet. Production hiring is three quarters out and a rate conversation now ends the relationship early.",
        window: "Relationship only. Hiring is 6 to 12 months out." },
      { sector: "Automotive Tier 1/2", region: "Windsor / Essex", state: "EXIT", score: 44,
        target_titles: ["Plant Manager", "HR Manager"],
        company_profile: "Feeder and Tier 1 plants exposed to the scheduled tariff step-up.",
        hook: "There is no acquisition hook in this market right now. Keep existing relationships warm at no extra effort.",
        avoid: "Do not sell into this market this quarter. Any growth language lands badly where contract headcount is being cut first.",
        window: "Get out before 2026-10-20, the tariff effective date." },
    ],
    macro: [
      { headline: "Scheduled tariff step-up on cross-border auto parts", lag: "Already landing, ahead of the date", urgent: true,
        explanation: "A dated policy shock pulls impact forward. OEMs announce downtime before the effective date rather than build inventory they cannot sell, and contract labour is the first lever pulled. Feeder plants feel it within days of the OEM announcement.",
        action: "Call your three largest automotive accounts this week and ask about Q4 volume commitments. Do not sell. Find out." },
      { headline: "Pre-buy distortion in automotive and logistics volumes", lag: "Borrowed demand, next 6 to 10 weeks", urgent: true,
        explanation: "Customers pull shipments forward to beat the tariff date, which temporarily raises overtime and postings. That spike is borrowed from Q1, not earned, and it will reverse.",
        action: "Do not read the current posting rise as strength. Hold automotive capacity flat and move new outreach into food and 3PL." },
      { headline: "Battery plant capex commitments, Windsor", lag: "Hiring in 6 to 12 months", urgent: false,
        explanation: "Construction and commissioning hiring runs well ahead of production hiring. The relationship has to exist before the requisition does.",
        action: "Relationship-only outreach, no rate conversations. Track named contacts in RCRM with a Q2 follow-up." },
      { headline: "Rate environment easing", lag: "Capex response in 2 to 3 quarters", urgent: false,
        explanation: "Cheaper capital reopens shelved expansion projects. Warehousing and distribution respond first because the build times are shortest.",
        action: "Nothing yet. Flagged so it is not a surprise when it moves." },
      { headline: "Ontario THA licence registry turnover", lag: "Competitive read, current", urgent: false,
        explanation: "New Windsor and Brampton entries on the public registry are competitors arriving. Disappearances are competitors failing, and their clients are in play.",
        action: "Pull the registry delta monthly and check any disappearance against your own prospect list." },
    ],
    forecasts: [
      { claim: "Windsor automotive job postings fall 20 to 30% by 2026-12-31", market: "Automotive Tier 1/2 — Windsor / Essex",
        metric: "adzuna_postings", predicted_value: -25, predicted_direction: "down", resolve_at: "2026-12-31",
        confidence: "high", basis: "Dated tariff step-up plus 640 WARN roles already filed in the geo." },
      { claim: "Windsor CMA employment flat to down 1.5% by 2027-01-31", market: "General — Windsor CMA",
        metric: "statcan_windsor_cma_employment", predicted_value: -1.5, predicted_direction: "down", resolve_at: "2027-01-31",
        confidence: "medium", basis: "Feeder plant exposure offset by food processing and construction hiring." },
      { claim: "ASA Staffing Index rises 3 points by 2026-11-30 on pre-buy overtime", market: "North America temp demand",
        metric: "asa_staffing_index", predicted_value: 3, predicted_direction: "up", resolve_at: "2026-11-30",
        confidence: "low", basis: "Pull-forward shipping ahead of the tariff date. Reverses in Q1." },
    ],
  };
}

function demoBriefing() {
  return {
    headline: "Plant and production titles carry the whole program; finance titles are dead weight and the second touch is doing the work.",
    decisions: [
      { title: "Stop emailing finance titles. Move that volume to Plant Managers.",
        reasoning: "Finance returned 2.1% off 47 sends with no meetings. Plant Managers replied at 14.6% off comparable volume. Reallocating those sends at the Plant Manager rate is worth roughly six more conversations a month at no extra cost.",
        copy_test: "" },
      { title: "Your second touch outperforms the first. Add a third.",
        reasoning: "Step 1 replies at 5.1%, step 2 at 11.8%, and you stop at two. A third touch at day nine typically recovers another two to four points. Add step 3 to sequences 15307 and 15311 before adding a single new contact.",
        copy_test: "" },
      { title: "Lead with the shift, not the company.",
        reasoning: "Openers naming a specific posting or shift pattern replied at 13.2%. Openers naming company growth or news replied at 6.4%. Same doctrine, sharper detail. Test the copy below on the next 60 sends.",
        copy_test: "SUBJECT: Your afternoon shift postings\nBODY: Mark,\n\nYou have had three afternoon assembler postings open in Windsor since early August. That usually means the shift is running short rather than growing.\n\nWe staff afternoon and midnight coverage in Windsor and can hold a bench so a callout does not cost you a line. Worth a short call this week?\n\nTravis" },
    ],
    confidence: "Medium. The persona finding is solid at this volume. The opening-line finding is directional and needs another 120 sends before it is trusted. Nothing here is based on open rates.",
  };
}

function demoDecisionLog() {
  return [
    { created_at: "2026-07-14", decision_text: "Cut generic \"hope you've been well\" openers entirely", result_value: "Reply rate 6.2% to 9.0%", grade: "worked" },
    { created_at: "2026-07-28", decision_text: "Added Leamington food processors to target list", result_value: "3 replies from 22 sends, 1 meeting", grade: "worked" },
    { created_at: "2026-08-11", decision_text: "Tested Friday morning sends", result_value: "Reply rate 4.1% vs 9.4% midweek", grade: "reversed" },
    { created_at: "2026-08-25", decision_text: "Opened finance persona in Tier 2 automotive", result_value: "1 reply from 47 sends", grade: "reversed" },
  ];
}

function demoForecastRows() {
  const r = demoRadar().forecasts.map((f) => Object.assign({}, f, { created_at: "2026-08-04", outcome: "pending" }));
  return r.concat([
    { created_at: "2026-05-02", claim: "Windsor food processing postings up 15% by 2026-07-31", market: "Food and beverage — Windsor",
      metric: "adzuna_postings", predicted_value: 15, predicted_direction: "up", resolve_at: "2026-07-31",
      confidence: "medium", basis: "Seasonal greenhouse ramp.", actual_value: 22, outcome: "hit", resolved_at: "2026-08-01" },
    { created_at: "2026-05-19", claim: "ASA Staffing Index down 2 points by 2026-08-15", market: "North America temp demand",
      metric: "asa_staffing_index", predicted_value: -2, predicted_direction: "down", resolve_at: "2026-08-15",
      confidence: "high", basis: "Manufacturing PMI employment sub-index contracting.", actual_value: 1, outcome: "miss", resolved_at: "2026-08-16" },
  ]);
}

/* ══════════════════════════════════════════════════════════════════════
   UPSTREAM FETCHES — every one optional, every one soft-failing
   ══════════════════════════════════════════════════════════════════════ */

async function getJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    if (!r.ok) throw new Error("upstream " + r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const json = (statusCode, obj) => ({
    statusCode,
    headers: Object.assign({}, CORS_HEADERS, { "content-type": "application/json" }),
    body: JSON.stringify(obj),
  });

  if (event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      service: "analytics-ceo",
      hasKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasData: Boolean(process.env.ANALYTICS_FETCH_URL),
      hasMarkets: Boolean(process.env.MARKET_SIGNALS_URL),
      model: MODEL,
    });
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "Method not allowed" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { ok: false, error: "Bad JSON" }); }

  /* ---- decision accept / reject proxy (brief 2.2) ---- */
  if (body.action === "accept" || body.action === "reject") {
    const url = process.env.DECISION_LOG_URL;
    if (!url) return json(200, { ok: true, stored: false, note: "DECISION_LOG_URL not configured; recorded locally only." });
    try {
      await getJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ action: body.action }, body.decision || {})),
      }, 8000);
      return json(200, { ok: true, stored: true });
    } catch (e) {
      return json(200, { ok: false, stored: false, error: String(e.message || e) });
    }
  }

  /* ---- full analytics payload ---- */
  const nowMs = Date.now();
  const days = rangeDays(body.range);
  const warnings = [];
  let demo = false;

  // 1. outreach rows
  let rows = null;
  if (process.env.ANALYTICS_FETCH_URL) {
    try {
      const sep = process.env.ANALYTICS_FETCH_URL.indexOf("?") >= 0 ? "&" : "?";
      const res = await getJson(process.env.ANALYTICS_FETCH_URL + sep + "days=" + (days * 2), null, 5000);
      if (res && Array.isArray(res.rows)) rows = res.rows;
      else warnings.push("Analytics fetch returned no rows array.");
    } catch (e) {
      warnings.push("Analytics fetch failed: " + String(e.message || e));
    }
  }
  if (!rows) { rows = demoRows(days, nowMs); demo = true; }

  const { cur, prev } = splitPeriods(rows, days, nowMs);
  const scoreboard = buildScoreboard(cur, prev);
  const segments = buildSegments(cur);

  // 2. market inputs
  let marketInputs = null;
  let marketsDemo = true;
  if (process.env.MARKET_SIGNALS_URL) {
    try {
      const res = await getJson(process.env.MARKET_SIGNALS_URL, null, 9000);
      if (res && Array.isArray(res.markets)) { marketInputs = res.markets; marketsDemo = false; }
      else warnings.push("Market signals returned no markets array.");
    } catch (e) {
      warnings.push("Market signals fetch failed: " + String(e.message || e));
    }
  }
  if (!marketInputs) marketInputs = demoMarketInputs(nowMs);
  const board = buildMarketBoard(marketInputs, nowMs);

  // 3. forecasts
  let forecastRaw = null;
  let forecastsDemo = true;
  if (process.env.FORECAST_LOG_URL) {
    try {
      const res = await getJson(process.env.FORECAST_LOG_URL, null, 8000);
      if (res && Array.isArray(res.forecasts)) { forecastRaw = res.forecasts; forecastsDemo = false; }
    } catch (e) {
      warnings.push("Forecast fetch failed: " + String(e.message || e));
    }
  }
  if (!forecastRaw) forecastRaw = demoForecastRows();

  // 4. decision log
  let decisionsLog = null;
  if (process.env.DECISION_LOG_URL) {
    try {
      const res = await getJson(process.env.DECISION_LOG_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }, 4000);
      if (res && Array.isArray(res.decisions)) decisionsLog = res.decisions;
    } catch (e) {
      warnings.push("Decision log fetch failed: " + String(e.message || e));
    }
  }
  if (!decisionsLog) decisionsLog = demoDecisionLog();

  // 5. the two model calls, each degrading on its own
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  let briefing = null, briefing_degraded = false;
  let radar = null, radar_degraded = false;

  /**
   * Only the briefing runs on the request path.
   *
   * Two model calls do not fit in a 26 second Netlify function: measured live on
   * 2026-09-02, running both together timed out every attempt, and shrinking the
   * radar enough to fit made it return truncated JSON instead. Tuning cannot fix
   * a wall clock.
   *
   * The radar is also the one with nothing real to say yet: its market reasons
   * and targeting list depend on the Adzuna / WARN / PMI / tender feeds, which
   * are not built. So it is skipped until MARKET_SIGNALS_URL exists, and those
   * sections keep their demo copy and their demo markers. When the feeds land,
   * the radar should move to a scheduled Make job that stores its output, not
   * back onto this request.
   */
  const runRadar = hasKey && !!process.env.MARKET_SIGNALS_URL;
  if (hasKey) {
    const [bRes, rRes] = await Promise.allSettled([
      briefingCall(scoreboard, segments),
      runRadar ? radarCall(board) : Promise.reject(new Error("skipped: market feeds not connected")),
    ]);
    if (bRes.status === "fulfilled" && bRes.value) briefing = bRes.value;
    else { briefing_degraded = true; warnings.push("Briefing call failed: " + String((bRes.reason && bRes.reason.message) || bRes.reason || "unknown")); }
    if (rRes.status === "fulfilled" && rRes.value) radar = rRes.value;
    else {
      radar_degraded = true;
      const why = String((rRes.reason && rRes.reason.message) || rRes.reason || "unknown");
      warnings.push(runRadar ? ("Radar call failed: " + why) : "Market radar not run: the public feeds are not connected yet.");
    }
  } else {
    briefing_degraded = true;
    radar_degraded = true;
    warnings.push("ANTHROPIC_API_KEY not configured; briefing and radar are demo text.");
  }

  if (!briefing) briefing = demoBriefing();
  // The radar is only asked for macro and forecasts now: market reasons and the
  // targeting list need the public feeds, which are not built. Whatever it does
  // return is merged over the demo copy so a partial answer is still used.
  const demoR = demoRadar();
  radar = Object.assign({}, demoR, radar || {});
  if (!Array.isArray(radar.macro) || !radar.macro.length) radar.macro = demoR.macro;
  if (!Array.isArray(radar.targeting) || !radar.targeting.length) radar.targeting = demoR.targeting;
  if (!Array.isArray(radar.market_reasons) || !radar.market_reasons.length) radar.market_reasons = demoR.market_reasons;

  // the model writes each market's one-line reason; the state stays ours
  const reasonById = {};
  (radar.market_reasons || []).forEach((r) => { if (r && r.id) reasonById[r.id] = String(r.reason || ""); });
  board.forEach((m) => { m.reason = reasonById[m.id] || ""; });

  // and the targeting cards are pinned to the board, not to whatever the model
  // decided the state was
  const rec = reconcileTargeting(radar.targeting, board);
  if (rec.drifted.length) {
    warnings.push("Model state drift corrected on " + rec.drifted.length + " targeting card(s): " + rec.drifted.join("; "));
  }

  // Model-proposed forecasts join the register, but only if they are checkable.
  // `_new` marks the ones this run produced so they can be persisted below and
  // shown as not-yet-saved rather than passing for stored history.
  const stored = forecastRaw.map((f) => Object.assign({}, f, { _new: false }));
  const proposed = (radar.forecasts || []).map((f) =>
    Object.assign({ created_at: iso(nowMs), outcome: "pending" }, f, { _new: true }));
  const register = buildForecastRegister(stored.concat(proposed));
  if (register.rejected.length) {
    warnings.push(register.rejected.length + " forecast(s) rejected as not checkable: " +
      register.rejected.map((r) => r.reason).join("; "));
  }
  if (register.duplicates) {
    warnings.push(register.duplicates + " duplicate forecast(s) collapsed.");
  }

  /**
   * "The function rejects any market call lacking a number, a resolve_at, and a
   * named public metric. Prose without a testable claim never reaches the
   * datastore." (brain spec 5). Validation without a write is only half of
   * that, so the survivors go to the register datastore here. Best effort: a
   * failed write must never cost Travis the whole payload.
   */
  const toSave = register.forecasts.filter((f) => f._new);
  if (process.env.FORECAST_LOG_URL && toSave.length) {
    try {
      await getJson(process.env.FORECAST_LOG_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", forecasts: toSave.map((f) => {
          const c = Object.assign({}, f); delete c._new; return c;
        }) }),
      }, 8000);
      register.forecasts.forEach((f) => { if (f._new) f._saved = true; });
    } catch (e) {
      warnings.push("Forecast register write failed: " + String(e.message || e));
    }
  }

  return json(200, {
    ok: true,
    demo,
    range_days: days,
    // so the UI can draw the scale a score sits on instead of printing a bare number
    scale: {
      enter: ENTER_SCORE, hold: HOLD_SCORE, min_sends: MIN_N,
      scale_mult: SCALE_MULT, kill_mult: KILL_MULT,
      sticky_weeks: STATE_STICKY_WEEKS, prebuy_weeks: PREBUY_WEEKS,
      weights: WEIGHTS,
    },
    generated_at: iso(nowMs),
    scoreboard,
    segments,
    market_board: board,
    briefing,
    targeting: rec.targeting,
    macro: radar.macro || [],
    decisions_log: decisionsLog,
    forecasts: register.forecasts,
    forecast_summary: {
      resolved_count: register.resolved_count,
      hit_rate: register.hit_rate,
      scoreable: register.scoreable,
      unreliable: register.unreliable,
      min_resolved: FORECAST_MIN_RESOLVED,
    },
    meta: {
      rows_analyzed: cur.length,
      radar_degraded,
      briefing_degraded,
      markets_demo: marketsDemo,
      forecasts_demo: forecastsDemo,
      decisions_demo: !process.env.DECISION_LOG_URL,
      warnings,
    },
  });
};

// exported for the local test harness only
exports._internals = {
  buildScoreboard, buildSegments, verdictFor, scoreMarket, resolveState,
  buildMarketBoard, buildForecastRegister, forecastRejectReason, extractJson, reconcileTargeting,
  demoRows, demoMarketInputs, splitPeriods, rangeDays, MARKETS, MIN_N,
  RADAR_SYSTEM, BRIEFING_SYSTEM, anthropic, MODEL,
};
