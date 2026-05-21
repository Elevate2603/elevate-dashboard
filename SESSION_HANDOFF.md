# Session Handoff

## Current Session: 2026-05-21 — Make → RCRM Pipeline Audit + Staging-to-Queue Fix Applied

### What Was Done

Full audit of the Make → RCRM workflow via Make MCP (now available from Claude Code). Pulled blueprints for Approval Handler (4667221), Staging-to-Queue (4990696), ZoomInfo Intake (4732316), and Queue Enrich Updater (4952511). Inspected `elevate_daily_queue` (86836) records, `elevate_company_staging` (94078) records and datastructure (347903), and queue datastructure (319927). Cross-checked field flow from ZoomInfo webhook → staging → queue → dashboard → Approval Handler → RCRM.

**Root cause identified for "RCRM gets incomplete company data on approval":**

The previous-session theory (create-then-edit in Approval Handler) is NOT what is actually breaking. The real cause is **Staging-to-Queue (4990696) Module 4 silently dropped 3 enrichment fields when copying staging records into the queue**:

- `company_website` — present in staging datastructure 347903, written by ZoomInfo Intake Module 30, but NOT in the queue AddRecord mapper
- `company_street/city/state` (no `company_address` concatenation) — same
- `annual_revenue` — same

Result: every ZoomInfo-source queue card was born with empty website/address/revenue, regardless of what ZoomInfo returned. Dashboard `buildPayload(c)` then sent empty strings, and the Approval Handler wrote empty fields to RCRM. The dashboard and Approval Handler were never the problem for these three fields.

**Fix applied (2026-05-21 14:44 UTC):** Patched scenario 4990696 Module 4 mapper via `scenarios_update`. Added `company_website`, `company_address` (concatenated from `1.company_street + ", " + 1.company_city + ", " + 1.company_state` wrapped in `trim()`), and `annual_revenue`. Verified post-update: `isinvalid: false`, scenario still active, blueprint persisted. Next 6am daily run (2026-05-22 10:00 UTC) will start producing complete queue rows.

**Other audit findings — documented, not yet fixed:**

1. **Leaked credentials in Approval Handler blueprint.** Both the RCRM Bearer token (`UL0jSyOX...xNzAzMDk4ODc1`) and the Anthropic API key (`sk-ant-api03-gonL2j1e...Cx7a6AAA`) are embedded directly in HTTP module headers (Modules 36, 33, 31, 11, 3, 2, 5, 4, 43, 44, 45, 47 of scenario 4667221, and in Queue Enrich Updater 4952511 Module 2). Anyone with Make team access or `scenarios_get` API can extract them. Rotation required, then migrate to Make-managed connection or env vars.
2. **Contact-search uses GET, not POST** (Module 36). Current URL: `GET /v1/contacts/search?email={{encodeURL(1.contact_email)}}&exact_search=1`. SCRIBE_EXPORT.md line 62-63 says POST with body is required and the GET form returns unfiltered lists. The current GET appears to be working — `exact_search=1` may be a documented RCRM extension that filters server-side. Defer flipping until a test contact confirms whether GET is producing false matches.
3. **`industry_id` switch defaults to `0`** (Module 20). When the ZoomInfo `Industry` string does not match the hardcoded `Manufacturing / Transportation / Automotive / …` list, Module 31 ends up POSTing `"industry_id": 0` to RCRM. Effect on RCRM unverified — may store as "no industry" silently or reject the field. Better default: omit the field, or fall back to 913 (Manufacturing) as a safe Elevate-default.
4. **Module 3 / Module 43 redundant stage update.** Module 11 already creates the contact with `stage_id: 142468`. Module 3 (new-contact path) then re-POSTs the same `stage_id` plus `linkedin`. Module 43 (existing-contact path) is the only existing-contact update and only touches `stage_id` + `linkedin` — no gap-fill of phone/mobile/title/email even when RCRM is empty. The "linkedin overwrite on existing contact" violates the "RCRM is source of truth once Travis touches a record" rule (SCRIBE_EXPORT.md line 70-71 spirit).
5. **`elevate_company_staging` datastructure (347903) does not declare `company_country`, `company_phone`, `company_zipcode`, `zi_contact_id`** even though ZoomInfo Intake Module 30 writes them. The values are stored on the records but not exposed by SearchRecord output bundle, so they cannot be read in downstream modules without a datastructure update. Blocks any future enrichment that needs `zi_contact_id`.
6. **`elevate_daily_queue` datastructure (319927) does not have `zi_company_id` or `zi_contact_id` columns.** Adding the just-in-time ZI enrichment path proposed in PROPOSED_SCENARIO_CHANGES.md will require schema updates first.
7. **`elevate_company_staging` is currently empty (0 records).** ZoomInfo Intake hasn't fired recently — consistent with the PKI connection issue (CLAUDE.md Known Issue #3). The Staging-to-Queue patch will only show effect once ZoomInfo resumes sending bundles OR a manual CSV import populates staging.
8. **Signals-source queue cards (e.g., `signal-003_robert_hogan`) have empty `company_industry` and `company_website`** even with a real Stellantis contact. The signals pipeline writes records without enriching company fields. Separate issue from the ZoomInfo path — out of scope for this fix but a follow-up.

**Approval Handler executions:** All recent runs (last 50) finished with status=1 (success) at the Make level. The "incomplete RCRM record" defect was not failing — it was succeeding with empty fields. Make's success metric measures HTTP 2xx responses, not field completeness.

### Current State

- Staging-to-Queue (4990696) updated and verified: `isinvalid:false`, `lastEdit: 2026-05-21T14:44:36.063Z`. Next scheduled run 2026-05-22 10:00 UTC.
- Approval Handler (4667221) unchanged from prior session — known defects documented above are deferred.
- Dashboard `buildPayload(c)` and rendering unchanged — already reads the right fields, no patch needed.
- ZoomInfo PKI still unstable (no recent staging writes). Manual CSV import still the interim path.

### Next Steps

1. [ ] After next 6am daily run (2026-05-22), inspect a fresh ZoomInfo-source queue record and confirm `company_website`, `company_address`, `annual_revenue` are populated.
2. [ ] After an actual approval of a freshly-populated card, inspect the resulting RCRM company record and confirm all six fields land.
3. [ ] Rotate the RCRM Bearer token and Anthropic API key visible in scenario 4667221 / 4952511 blueprints. Migrate to Make-managed connections.
4. [ ] Fix `industry_id` default — change Module 20 default from 0 to either an empty string with Module 31 conditional, or a safe-default 913 (Manufacturing). Re-test approval.
5. [ ] Add `zi_company_id` / `zi_contact_id` columns to queue datastructure 319927, and `company_country / phone / zipcode / zi_contact_id` to staging datastructure 347903. Unblocks Phase 2 enrichment.
6. [ ] Apply gap-fill pattern to Module 43 (existing-contact path) — read existing RCRM contact first, only update empty fields. Stop overwriting `linkedin`.
7. [ ] Phase 2: build `netlify/functions/zi-enrich.js` per PROPOSED_SCENARIO_CHANGES.md Section 7, after ZoomInfo private key rotation.
8. [ ] Investigate why signals-source queue cards have empty `company_industry` — likely the Signals scenarios need a parallel "carry-through enrichment" patch.

### Decisions Made

- **Fix the cause, not the symptom.** Patching Staging-to-Queue is upstream of the Approval Handler and resolves the empty-field problem for every NEW ZoomInfo-source card without touching the working approval flow. The complex Approval Handler redesign in PROPOSED_SCENARIO_CHANGES.md is no longer the critical path — it becomes a future Phase 2 optimization (decline-zero-touches, single-call writes) rather than a defect fix.
- **Don't flip the contact search GET → POST today.** SCRIBE says POST is correct, but the live GET with `exact_search=1` has been succeeding for months. Flip only after a confirmed false-positive match in production.
- **Don't touch jsonStringBodyContent modules in 4667221.** Per platform gotcha, modifying jsonStringBodyContent with `{{var}}` triggers `isinvalid:true` and requires manual Save in Make UI. The Module 20 mapper change for industry_id default is doable, but coordinated with Module 31 body changes is not. Defer all 4667221 blueprint edits to a session where Travis is at the Make UI for the manual Save.
- **No index.html or commit churn.** `buildPayload(c)` was already correct; the field path it produces is honored end-to-end on the receiving side.

### Blockers

- ZoomInfo PKI still down — no fresh ZI bundles arriving, so the Staging-to-Queue patch can't be validated against new live data until either PKI resolves or CSV import is run.
- The two leaked API keys (RCRM, Anthropic) need rotation. Until done, anyone exporting blueprints via Make MCP `scenarios_get` can read them.

### Notes for Next Session

- The new MCP tool surface (Make + ZoomInfo + RCRM via the deferred-tools mechanism) lets Claude Code do the audit-and-fix work end-to-end that previously required the web chat. The "cannot edit Make scenarios from Claude Code" note in prior handoffs is now obsolete.
- `scenarios_update` accepted a blueprint with a `{{trim(1.company_street + ", " + 1.company_city + ", " + 1.company_state)}}` IML expression in a Datastore Add Record mapper without triggering `isinvalid:true`. That confirms the "isinvalid trigger" rule is specific to `jsonStringBodyContent` in HTTP modules, not to IML expressions everywhere. Useful for future patches.

---

## Previous Session: 2026-05-20 — Approval Handler Redesign (design phase)

### What Was Done

- Read CLAUDE.md, SESSION_HANDOFF.md, SCRIBE_EXPORT.md, confirmed buildPayload(c) at index.html:1303 already ships all 25 fields — dashboard side is correct.
- Designed the complete fix for the "RCRM gets incomplete company AND contact data on approval" defect. Root cause is two-part: Staging-to-Queue (4990696) writes queue rows without enriching the company side, and Approval Handler (4667221) currently does create-then-edit on RCRM company writes (two API calls and two audit-log entries per company).
- Decision: enrichment moves OUT of Staging-to-Queue and INTO Approval Handler, AFTER the approve filter. Result: decline = zero ZoomInfo credits, zero RCRM calls. Approve = one RCRM create per record (company + contact) with every field populated in a single call.
- Decision: ZoomInfo enrichment lives in a new Netlify function `/.netlify/functions/zi-enrich` invoked by Make HTTP module. Server-side PKI/JWT, shared secret between Make and Netlify. Decouples Make blueprint from PKI brittleness.
- Decision: always search RCRM company first before create. Existing-company path = gap-fill update only (never overwrite). Existing-contact path = gap-fill only, never touch phone/mobile/email/title if populated.
- Wrote PROPOSED_SCENARIO_CHANGES.md (9 sections, ~500 lines) covering: diff summary, target module topology, exact RCRM company-create payload, exact RCRM contact-create payload, decline-path proof, existing-contact handling, ZoomInfo bridge contract, test plan, open items.
- No index.html changes needed — buildPayload already sends every field the new flow consumes.

### Current State

**Design ready, not yet applied.** PROPOSED_SCENARIO_CHANGES.md committed to repo. Three items block applying the design to Make:

1. Current scenario 4667221 blueprint paste — needed to produce the literal module-by-module line diff and to confirm exact RCRM field-name shapes (`company_name` vs `name`, custom fields array shape).
2. ZoomInfo private key rotation — leaked 2026-05-20, blocks Netlify function deploy.
3. RCRM company-search endpoint signature confirmation — `POST /v1/companies/search` is assumed by symmetry with the documented contact-search endpoint; needs verification against the RCRM API Endpoints reference doc in the web chat.

### Next Steps (next session)

1. [ ] Paste current 4667221 blueprint into PROPOSED_SCENARIO_CHANGES.md Section 1.5 (or as an appendix). Use Make MCP `scenarios_get` for scenario 4667221.
2. [ ] Adopt exact RCRM field names from the existing scenario into Sections 3 and 4 of PROPOSED_SCENARIO_CHANGES.md.
3. [ ] Confirm `POST /v1/companies/search` against the RCRM API Endpoints reference. If the endpoint differs (e.g. is GET with a filter param), update Module [10] spec in PROPOSED_SCENARIO_CHANGES.md.
4. [ ] Rotate ZoomInfo private key with James Gervais. Update `ZOOMINFO_PRIVATE_KEY` in Netlify env after rotation. Confirm the old key is invalidated.
5. [ ] Build `netlify/functions/zi-enrich.js` per the contract in Section 7 of PROPOSED_SCENARIO_CHANGES.md. Deploy. Curl-test with a known `companyId`.
6. [ ] Apply blueprint edits to scenario 4667221 in Make. Save manually in UI (per SCRIBE_EXPORT.md isinvalid:true rule).
7. [ ] Run the 10-step test plan in PROPOSED_SCENARIO_CHANGES.md Section 8 against a dummy contact. Only after all ten pass should live approvals flow through the new scenario.

### Decisions Made (this session)

- **Enrichment moves to approval time, not queue-promotion time** — explicitly contradicts Known Issue #1 in CLAUDE.md ("Add ZoomInfo company enrich module to Staging-to-Queue"), but matches the new constraint that decline must = zero ZoomInfo touches. Pre-enriching every staged contact would waste credits on cards that get declined.
- **Netlify function bridge over direct Make HTTP for ZI** — keeps the PKI private key on Netlify env only, decouples Make from PKI brittleness, allows the auth method to change later without touching the scenario.
- **Always search-before-write for both company and contact** — guards against the duplicate-company failure mode (which the current scenario may have if it does straight create with no search).
- **Gap-fill only on existing records, never overwrite** — RCRM is source of truth once a record has been hand-edited. The dashboard's data is fresher only for the brand-new contact case.
- **Decision audit (Update-Record at position 2) stays where it is** — per SCRIBE_EXPORT.md bundle propagation rule.
- **No index.html changes** — dashboard sends every field the new flow needs.

### Blockers

- ZoomInfo PKI key leaked 2026-05-20 — rotation required before Netlify bridge function can be safely deployed.
- Cannot edit Make scenarios from Claude Code (no Make MCP access on this side) — all scenario edits applied by Travis in the web chat.

### Notes for Next Session

- The "create then edit" pattern that produced the original defect is likely the same pattern used for the contact write — confirm against the blueprint when it's pasted, and apply the same single-call fix.
- Test 9 in the test plan (bulk-approve 15 cards) is the rate-limit canary. If 429s appear, raise the inter-iteration Sleep in the bulk path. Current design assumes no sleep on single approves.
- The 880 existing queue cards with empty company data: under the new design, these will be enriched at approval time. No backfill script needed — the bridge call handles it on demand.

---

## Previous Session: 2026-05-20 — Session Protocol Installation

### What Was Done
- Installed Session Protocol on the elevate-dashboard repo (CLAUDE.md, SESSION_HANDOFF.md, SCRIBE_EXPORT.md)
- Pre-populated CLAUDE.md with full project context from prior chat sessions: hosting, scenario IDs, datastore IDs, RCRM custom fields, webhook URLs, branding, conventions, known issues
- Pre-populated SCRIBE_EXPORT.md with verified knowledge atoms accumulated over the past months of build work
- Travis transitioning from web chat to Claude Code CLI workflow for code/deploy work, will continue using web chat for Make/RCRM/ZoomInfo MCP work
- Discovered buildPayload(c) shared function was never actually shipped — both submitOne() and submitQueue() had divergent inline payloads, in sync by coincidence only. Extracted real buildPayload(c) with all 25 fields. Verified decision logic character-for-character identical. Committed d68bf01, pushed, deployed live as build ELEVATE-2026-0520-B-BUILDPAYLOAD25.
- Verified deploy live: fetched served HTML from elevate-sales-nav.netlify.app, confirmed new build token at line 2, `function buildPayload(c)` defined, both submitOne() and submitQueue() call it, zero surviving `const payload = {` inline objects anywhere in served file. End-to-end RCRM field population still pending — first live approval after this deploy will be the behavioral test.

### Current State

**Working:**
- ZoomInfo Intake → Staging → Queue → Dashboard → Approval → RCRM pipeline is mechanically functional end-to-end
- buildPayload(c) shared function extracted into index.html on 2026-05-20 (build ELEVATE-2026-0520-B-BUILDPAYLOAD25), includes all 22 required fields plus 3 extras (company_linkedin, buying_signal, about_company) = 25 total
- Both submitOne() and submitQueue() call buildPayload(c) — verified live in served HTML
- Netlify auto-deploys from main branch within ~30 seconds of push
- Core scenarios healthy: ZoomInfo Intake (4732316), Staging-to-Queue (4990696), Hiring Signals Auto Pull (4991665), Market Intel Engine (4688813), Morning BD Email (4669709), Approval Handler (4667221), Queue Fetch (4734116)

**Broken / Degraded:**
- Signals subsystem error rates: Signals-Enrich Contacts ~62%, Email Drafter ~46%, Outlook Send & Log ~88%, ZI Search & Enrich Worker ~57%
- Auto-Enrich Pending Signals (4978011, 4990702) marked isinvalid:true and deactivated
- ZoomInfo PKI connection (Client ID ca97f380-d6be-42bc-a788-2b3a8454f495) unstable — escalated to ZoomInfo support
- Staging-to-Queue (4990696) does NOT enrich company data before write — 880 existing queue cards have empty website/address/LinkedIn/revenue fields
- Netlify elevate-zi-bridge.zip (signal-aggregator function) deployment unverified — both scenarios that call it have 1 exec / 1 error

### Next Steps

1. [~] ~~Verify Rob Davidson approval end-to-end after the 2026-05-20 buildPayload patch deploy~~ — SUPERSEDED 2026-05-20: Rob no longer in queue. Verified instead by static code inspection + structural fix + live HTML fetch. Confirmed buildPayload(c) shared function was missing entirely (despite earlier handoff claim), extracted it, both submitOne() and submitQueue() now call it, deployment confirmed live at elevate-sales-nav.netlify.app. Next live approval will exercise the patch end-to-end into RCRM.
2. [ ] Add ZoomInfo company enrich module to Staging-to-Queue (4990696) between GetRecord and AddRecord steps
3. [ ] Confirm elevate-zi-bridge.zip is deployed to Netlify (app.netlify.com/projects/elevate-zi-bridge/deploys)
4. [ ] Backfill decision for the 880 existing queue cards with empty company data — leave or one-time enrichment script
5. [ ] Build Ontario Recruitment Lead Gen dashboard tab — architecture agreed, Test 1 passed on signal-003 Stellantis Windsor
6. [ ] Move Anthropic API key out of hardcoded HTML into a Netlify function proxy
7. [ ] Fix Signals subsystem error rates (start with Outlook Send & Log at 88%, then ZI Search & Enrich Worker, then Email Drafter, then Enrich Contacts)
8. [ ] Resolve ZoomInfo PKI connection (waiting on ZoomInfo support)

### Decisions Made

- **Session Protocol installed:** Using CLAUDE.md / SESSION_HANDOFF.md / SCRIBE_EXPORT.md pattern per James Gervais's onboarding doc to give Claude Code persistent context across sessions
- **Hybrid workflow:** Claude Code CLI for code/deploy/Git operations. Web chat (with Make/RCRM/ZoomInfo MCPs) for backend scenario changes, datastore inspection, contact enrichment
- **No `git push --force` ever** on this repo — Netlify auto-deploys, mistakes go live immediately
- **buildPayload(c) is the only payload builder** — anywhere submitOne() or submitQueue() builds its own inline object, that's a regression to fix

### Blockers

- ZoomInfo PKI connection — blocked on ZoomInfo support response. Workaround: manual "process today's queue" each morning.
- Signals subsystem high error rates — needs dedicated debug session, root causes not yet identified

### Notes for Next Session

- Travis works on Windows, Command Prompt / PowerShell
- Travis's preferences: take direct action (no step-by-step), show widget/preview before live file changes, run `node -c` syntax check before delivering any HTML, build correctly once, cross-reference 3+ sources before touching Make blueprints, verify current state before changing, never rebuild from scratch
- ZoomInfo private key (PKCS#8) was leaked into a chat 2026-05-20 — needs rotation with James Gervais before deploying to any environment
