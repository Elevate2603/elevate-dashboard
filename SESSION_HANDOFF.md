# Session Handoff

## Current Session: 2026-05-20 — Approval Handler Redesign (design phase)

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
