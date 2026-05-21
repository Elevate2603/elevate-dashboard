# Scribe Knowledge Export

## Infrastructure & Hosting

[CONFIRMED] Netlify Site ID for elevate-sales-nav is a92ed0bc-d4dd-4f47-a50d-820a517f2d34 | tags: netlify, infrastructure
[CONFIRMED] Live dashboard URL is https://elevate-sales-nav.netlify.app | tags: netlify, deployment
[CONFIRMED] GitHub repo is Elevate2603/elevate-dashboard | tags: github, repo
[CONFIRMED] Netlify auto-deploys from main branch within ~30 seconds of git push | tags: netlify, deployment, automation
[CONFIRMED] Dashboard is a single index.html file with no build step | tags: architecture, frontend
[CONFIRMED] Drag-and-drop deploy at app.netlify.com/projects/elevate-sales-nav works as fallback | tags: netlify, deployment
[CONFIRMED] Build token convention: ELEVATE-YYYY-MMDD-X injected as HTML comment to force unique file hash for Netlify dedup | tags: netlify, deployment, convention
[CONFIRMED] Files dragged to Netlify must be selected individually, not as a folder | tags: netlify, deployment, gotcha
[CONFIRMED] _redirects file must be at root level alongside index.html for redirect rules to process | tags: netlify, deployment

## Make.com Platform

[CONFIRMED] Make.com region is us2 (us2.make.com), NOT eu2 — some MCP responses incorrectly reference eu2 | tags: make-com, infrastructure
[CONFIRMED] Make Team ID is 2053152, Org ID is 7033146 | tags: make-com, infrastructure
[CONFIRMED] Scenario editor URL pattern: https://us2.make.com/2053152/scenarios/{scenarioId}/edit | tags: make-com, infrastructure
[WARNING] Make scenarios with isinvalid:true ONLY clear via manual Save in Make UI — scenarios_update API alone cannot resolve | tags: make-com, gotcha, api
[SUPERSEDED] (Originally: "Make blueprints pushed via API with {{variable}} expressions in jsonStringBodyContent automatically trigger isinvalid:true.") — DISPROVEN 2026-05-21 across multiple test cases: scenarios_update with jsonStringBodyContent modifications including adding/removing {{var}} references does NOT trigger isinvalid:true in the patterns we've tested. See gotcha-superseded entries in Historical Debug Lessons section for details | tags: make-com, gotcha-superseded
[WARNING] scenarios_update silently rejects identical blueprints — always make a meaningful change or use scenarios_get to verify current state first | tags: make-com, gotcha, api
[WARNING] data-store-records_delete requires all keys passed in a single array call, not iterated individually | tags: make-com, gotcha, api
[WARNING] data-store-records_list defaults to 10 records — always specify limit:100+ for staging or queue inspection | tags: make-com, gotcha, api
[WARNING] Make bundle propagation rule: if any filter blocks a bundle at any point, ALL downstream modules stop regardless of their own filter conditions | tags: make-com, architecture, gotcha
[CONFIRMED] Make IML arrays are 1-based: data[1] is the first element, not data[0] | tags: make-com, syntax
[WARNING] Make webhook scenarios (instant triggers) cannot be tested via scenarios_run API — that method doesn't fire a real HTTP request | tags: make-com, testing, gotcha
[CONFIRMED] BasicAggregator module's Source Module must be set manually in the Make UI, cannot be reliably set via API blueprint | tags: make-com, gotcha, api
[WARNING] OR conditions in Make datastore filter arrays via API are unreliable — single-condition filters are more stable | tags: make-com, gotcha, api
[CONFIRMED] scenarios_update payload requires name, scheduling, and interface at top level or returns silent 500 — validator flags them as invalid but API requires them | tags: make-com, api, gotcha

## Make Scenario IDs

[CONFIRMED] Scenario A (ZoomInfo Intake) is 4732316 — live webhook trigger | tags: make-com, scenarios
[CONFIRMED] Scenario B (Morning BD Email) is 4669709 — daily 8am | tags: make-com, scenarios
[CONFIRMED] Scenario C (Approval Handler) is 4667221 — live webhook trigger | tags: make-com, scenarios
[CONFIRMED] Scenario D (Market Intel Engine) is 4688813 — daily 6am | tags: make-com, scenarios
[CONFIRMED] Staging-to-Queue is 4990696 — daily 6am | tags: make-com, scenarios
[CONFIRMED] Queue Fetch is 4734116 — live webhook trigger | tags: make-com, scenarios
[CONFIRMED] Hiring Signals Auto Pull is 4991665 — daily 5:30am | tags: make-com, scenarios
[CONFIRMED] Signal Writer is 4744089 | tags: make-com, scenarios
[CONFIRMED] Signal Fetch is 4744091 | tags: make-com, scenarios

## Make Datastore IDs

[CONFIRMED] elevate_daily_queue datastore ID is 86836 | tags: make-com, datastore
[CONFIRMED] digest datastore ID is 90196 — Morning BD Email reads from this with key "today" | tags: make-com, datastore
[CONFIRMED] company_intel datastore ID is 90393 | tags: make-com, datastore
[CONFIRMED] elevate_market_signals datastore ID is 91802 | tags: make-com, datastore
[CONFIRMED] elevate_pending_retrieval datastore ID is 97143 | tags: make-com, datastore

## Webhook URLs (hook.us2.make.com)

[CONFIRMED] Queue Fetch webhook token: fbwggrimbt2iidjeckvs25sk61hej2lh | tags: make-com, webhook
[CONFIRMED] Signal Writer webhook token: iavptl5ghkx1qinlyi7pb567mw1ccuk0 | tags: make-com, webhook
[CONFIRMED] Signal Fetch webhook token: tt27x57x9jlln7tjw4uvvb9d48hppp26 | tags: make-com, webhook
[CONFIRMED] Approval Handler webhook token: aq8yfoqv8itfhrewo1k6iib7u6rq4gm1 | tags: make-com, webhook

## RecruitCRM (RCRM)

[CONFIRMED] RCRM auth uses Bearer token, rate limit is 60 requests/minute | tags: rcrm, api
[CONFIRMED] RCRM contact search endpoint: GET /v1/contacts/search?email=X&exact_search=1 — query-param form (matches public /v1/jobs/search pattern), returns filtered list. The previously documented "POST /v1/contacts/search with body" was inherited from an older session and is not the form that works in production | tags: rcrm, api
[WARNING] GET /v1/contacts?email=X (without /search and without exact_search=1) returns unfiltered contact list — the email query param is ignored on the bare /contacts endpoint, only valid as a path-prefix on /v1/contacts/search | tags: rcrm, api, gotcha
[CONFIRMED] RCRM auto-dedups companies on website + LinkedIn URL match at create time (per help.recruitcrm.io). Acts as a second-layer safety net behind any explicit /v1/companies/search call — but bypassed when the inbound payload has no website or LinkedIn URL | tags: rcrm, dedup, gotcha
[CONFIRMED] 2026-05-21 empirical audit: RCRM /v1/companies/search accepts ONLY GET. POST returns HTTP 404 {"error":true,"errorCode":404,"errorMessage":"Company doesn't exist"} for every body shape tested (empty {}, {"company_name":X}, {"name":X}, {"website":X}, {"linkedin":X}). The Approval Handler Module 33 current production form (POST with body {"company_name": "X"}) has been returning 404 on every execution since 2026-04-07 — duplicate detection has been silently disabled, resulting in 18+ Stellantis duplicates, 3+ Cargojet duplicates, and likely many more across the company set | tags: rcrm, api, critical-defect, scenario-c
[CONFIRMED] 2026-05-21 empirical audit: RCRM /v1/companies/search GET form accepts ONLY company_name query param. name=X, website=X, linkedin=X, multi-field combinations all return HTTP 400 with body "UNSUPPORTED_SEARCH". No way to search companies by website or LinkedIn URL via this endpoint | tags: rcrm, api, limitation
[CONFIRMED] 2026-05-21 empirical audit: GET /v1/companies/search?company_name=X — without exact_search=1 → substring/contains match (case-insensitive, whitespace-trimmed at both ends). With exact_search=1 → strict full-field equality (still case-insensitive, still whitespace-trimmed). Tested with Stellantis (18 exact, 34 substring), Stellan (0 exact, 34 substring), single-letter S (0 exact, 100 substring — likely page-truncated) | tags: rcrm, api, search-semantics
[CONFIRMED] 2026-05-21 empirical audit: RCRM /v1/companies/search response shape DIFFERS by result count. Has-results: wrapped object {"current_page":1,"data":[...]}. No-results: BARE ARRAY []. Same endpoint, different top-level shape. Make HTTP modules with parseResponse:true handle both: IML 33.data.data[1].slug resolves correctly across has-results (wrapped → array[0]), no-results (array → .data on array undefined → empty), and 404-error (error object → .data undefined → empty) | tags: rcrm, api, response-shape, make-com
[CONFIRMED] 2026-05-21 empirical audit: safest Module 33 production form is GET /v1/companies/search?company_name={{encodeURL(1.company_name)}}&exact_search=1. Why exact_search (not substring): substring fallback risks wrong-company association (Stellantis contact attached to Stellantis Detroit when only Stellantis Canada exists), whereas exact-miss only creates 1 extra duplicate. Name-typo duplicates will still slip through — accept that tradeoff. Website/LinkedIn dedup is not available via this endpoint (HTTP 400) — RCRM's native create-time dedup on website+linkedin is the only safety net for those | tags: rcrm, scenario-c, implementation-strategy
[CONFIRMED] 2026-05-21 17:24 UTC: Module 33 GET fix deployed to Approval Handler (4667221). Pre-fix POST→404 silent-disabled dedup since 2026-04-07 (7 weeks). Post-fix end-to-end verified via curl against three input scenarios: (V1) known multi-duplicate "Stellantis" → wrapped response → Module 34 captures first slug → Module 31 skip-create → contact attaches to existing; (V2) nonexistent name → bare [] → Module 34 empty → Module 31 creates; (V3) special chars (React Tool & Mold with %26) → wrapped, 1 match, works correctly. Module 34/35/31 IML unchanged — no regression possible because their logic was already correct, only Module 33's input was wrong | tags: history, scenario-c, dedup-fix, applied
[CONFIRMED] 2026-05-21 audit revealed existing duplicate records in production RCRM caused by the pre-fix Module 33 defect: 18 exact-match "Stellantis" records, 3+ "Cargojet" records visible in the first 100 of /v1/companies, likely more across the broader set. Cleanup is a SEPARATE problem from prevention — the GET fix prevents future duplicates but does not merge existing. Recommended cleanup: RCRM admin UI manual merge for visible duplicate sets. Scripted cleanup via RCRM API is possible but requires empirical verification of contact-reassignment and company-delete endpoints (not done in this audit cycle) | tags: rcrm, duplicate-cleanup, separate-from-prevention
[CONFIRMED] 2026-05-21 empirical: RCRM `GET /v1/contacts/search?email=&exact_search=1` (empty email query param) returns HTTP 200 with the UNFILTERED contacts list (100-record default page) — DIFFERENT shape than `/v1/companies/search?company_name=&exact_search=1` which returns bare []. The two search endpoints have inconsistent empty-param semantics. This caused a latent silent-hijack: Approval Handler Module 36 with empty `1.contact_email` returned an unrelated existing RCRM contact's slug as Module 37's resolved_slug, which would have caused Modules 43/47 (Route B) to mutate the wrong contact's stage and write a wrong note. ~66% of the 1,071-record queue backlog carries this latent hazard (no contact_email field) | tags: rcrm, scenario-c, search-semantics, silent-defect
[CONFIRMED] 2026-05-21 19:51 UTC: Wave 4 prevention fix deployed — Approval Handler (4667221) Module 102 (Approve Only Router) filter extended from `decision == "approve"` (single condition) to `decision == "approve" AND contact_email != ""` (two AND conditions). When contact_email is empty/missing, the entire approve route is blocked at Module 102. Modules 99 + 100 (audit + delete) still fire because they live outside 102's router. Module 36 still fires (its own filter is just decision==approve, unchanged) and still issues a wasted RCRM GET, but the captured resolved_slug is never read. Empirically re-validated post-deploy: RCRM-side empty-email response unchanged (still 100 unfiltered records), valid-email response unchanged (bare [] for non-existing email), filter blocks the hijack consumer chain. Prevention-only — does not clean up the ~700 no-email backlog records | tags: history, scenario-c, wave-4, prevention, applied
[CONFIRMED] 2026-05-21 20:35 UTC: live curl-bypass approval of Troy English / Ross Video (queue key zi_91406862_9699846110) — webhook 200, Make execution status:1, 12 ops, 2032ms. Module 31 created Ross Video company (slug 17793957231420054787Ryx) with industry_id:913 (Wave 1 fallback VERIFIED — "Telecommunication Equipment" not in switch, defaulted to Manufacturing). Module 31 city="Ottawa"/state="Ontario"/country="Canada" populated via Wave 3 ifempty fallback from contact_X (queue had empty company_X). Module 11 contact create FAILED with HTTP 422 due to RCRM dropdown rejecting the data_collection_source value "zoominfo_intent" — only "ZoomInfo" is configured as a valid dropdown option. Wave 2 fix (variable replaces literal) was correct in intent but exposed this upstream queue-vs-RCRM value mismatch. Cascade: final_slug empty, Modules 5/13/4 (Anthropic note pipeline) skipped, Module 2 (enroll) was going to skip anyway (no sequence_id). Net result: orphan Ross Video company in RCRM, no Troy English contact, queue record deleted | tags: history, scenario-c, live-test, partial-pass, defect-exposed
[CONFIRMED] 2026-05-21 20:35 UTC: RCRM contact custom_field 5 ("Data Collection Source") is a DROPDOWN that rejects non-configured option values with HTTP 422 "[{"custom_field_3":"The custom dropdown field is invalid."}]". The error message labels the field as `custom_field_3` but the payload contained no field_id 3 — RCRM-side mislabeling. The actual rejecting field is 5. Only empirically-confirmed valid dropdown option is "ZoomInfo" (witnessed on existing Katie Martinovich contact). Sending "zoominfo_intent" (the value Staging-to-Queue Module 4 hardcodes) produces 422. Custom_field 12 (Buying Signal) is also a dropdown but empirically accepts empty string — different rejection logic per field | tags: rcrm, api, custom-fields, dropdown-validation, gotcha
[CONFIRMED] 2026-05-21 (afternoon): defensive error-suppressor deployed to live dashboard (build ELEVATE-2026-0521-B-DEFENSIVE) — catches uncaught errors from non-our-origin scripts (browser extensions like Grammarly inject index.bundle.js with their own keydown handlers throwing "Cannot read properties of undefined (reading toLowerCase)"). The suppressor calls preventDefault + stopImmediatePropagation. May not be sufficient if the extension corrupts shared state before throwing — full mitigation is to disable the extension on elevate-sales-nav.netlify.app or test in incognito | tags: dashboard, defensive, browser-extensions, gotcha
[CONFIRMED] 2026-05-21 20:45 UTC: Wave 5 deployed — added mapped_data_source variable to Module 20 SetVariables, switching queue's data_collection_source values to RCRM dropdown options. Module 11 jsonStringBodyContent now reads {{20.mapped_data_source}} for custom_fields[5].value. Maps "zoominfo_intent" → "ZoomInfo" (and "hiring_signals" → "ZoomInfo" plus a default of "ZoomInfo" for any other value). Forward-compatible for adding more dropdown options. Blueprint verified live. Behavioral validation (fresh contact POST) pending Travis go-ahead | tags: history, scenario-c, wave-5, dropdown-mapping, applied
[CONFIRMED] 2026-05-21 21:10 UTC: Wave 5 partially validated via Michael Besic / Town of Oakville curl bypass. Route A2 test (existing company). Module 11 dropdown 422 from Troy English test did NOT recur — Wave 5 fix is doing its job. BUT — execution showed only 8 ops (predicted 14). Module 35 errored, breaking the route chain. Root cause: Module 35 IML `if(34.existing_company_slug; 34.existing_company_slug; 31.data.slug)` — Make eagerly evaluates all if() arguments; when Module 31 is filtered out (Route A2), the dead reference `31.data.slug` causes Module 35 to error → Modules 11/38/5/13/4 all skip. Town of Oakville count stayed at 1 (no duplicate); no DLQ. Latent defect was hidden pre-Wave-1 because Module 33's broken POST always forced Module 31 to fire | tags: history, scenario-c, wave-5, partial-validation, latent-defect-exposed
[CONFIRMED] 2026-05-21 21:32 UTC: Wave 6 deployed — Module 35 IML changed from `if(34.existing_company_slug; 34.existing_company_slug; 31.data.slug)` to `ifempty(34.existing_company_slug; 31.data.slug)`. Make's ifempty() short-circuits — when first arg is non-empty (Route A2), second arg is never evaluated, removing the dead-reference error. Same observable semantics for Route A1 (Module 31 fires, slug captured, ifempty falls through to second arg). Blueprint verified live. Behavioral validation pending — Michael Besic curl re-run authorized but not yet executed | tags: history, scenario-c, wave-6, ifempty-fix, applied
[SUPERSEDED] (Originally: "Make IML if() appears to use eager argument evaluation, causing dead-reference errors") — DISPROVEN 2026-05-21 21:37: Wave 6 changed Module 35's if() to ifempty() and the test STILL failed with same 8-op signature. The actual root cause is NOT IML evaluation; it's Make's bundle propagation rule (already documented at CLAUDE.md Known Issues / Make Operation Gotchas line ~7). When Module 31's filter blocks, all downstream modules in the same flow chain stop, regardless of their own filters. Module 35 doesn't error — it doesn't fire because the bundle never reaches it. The if/ifempty distinction was irrelevant | tags: make-com, iml, gotcha-superseded, diagnosis-error
[CONFIRMED] 2026-05-21 21:37: Wave 6 (Module 35 if() → ifempty()) was a NULL CHANGE. Same 8-op failure as Wave 5 test. Real root cause: Module 31's filter `existing_company_slug == ""` blocking on Route A2 stops the bundle from reaching downstream modules (35, 11, 38, 5, 13, 4). This is Make's bundle propagation rule, already documented as a known gotcha. The conditional company-create design is fundamentally incompatible with the linear-chain topology — needs router restructure (Wave 7 candidate) to handle existing-company case without breaking the chain | tags: history, scenario-c, wave-6, null-change, real-root-cause
[CONFIRMED] RCRM notes endpoint: POST /v1/notes | tags: rcrm, api
[CONFIRMED] RCRM stage updates use the exact stage name as a text string, not a numeric ID | tags: rcrm, api
[CONFIRMED] Sequence IDs 15307-15327 are configured for persona × variant combinations (12 sequences) | tags: rcrm, sequences
[CONFIRMED] Note type 195663 = "Emailed", 213194 = "Sales Lead" | tags: rcrm, notes
[WARNING] List 166186 (Active Client) and list 198202 (DNU) must never be touched by automation | tags: rcrm, lists, safety
[CONFIRMED] RCRM contact custom field 1 = Office Direct Line, 2 = Mobile, 5 = Data Source | tags: rcrm, custom-fields
[CONFIRMED] RCRM company custom field 1 = Employees, 2 = Revenue, 9 = Locations, 10/11 = Funding, 12 = Buying Signal | tags: rcrm, custom-fields
[CONFIRMED] RCRM company association on contact creation uses Slug field, not numeric company ID | tags: rcrm, api, gotcha

## ZoomInfo

[CONFIRMED] ZoomInfo Client ID: ca97f380-d6be-42bc-a788-2b3a8454f495 | tags: zoominfo, credentials
[WARNING] ZoomInfo private key was leaked in a chat on 2026-05-20 — must be rotated with James Gervais before production use | tags: zoominfo, security, urgent
[CONFIRMED] ZoomInfo ICP filter must be "Contact's Office AND Company HQ" set to Ontario only — OR variant causes wrong-region contacts | tags: zoominfo, configuration
[WARNING] ZoomInfo ICP Targeting workflow sends ONLY contact bundles to webhook, never company bundles — company names never arrive automatically | tags: zoominfo, gotcha, platform-limit
[CONFIRMED] Previously enriched ZoomInfo companies do not consume credits again for one year | tags: zoominfo, billing
[CONFIRMED] ZoomInfo enrich_companies MCP accepts companyId and returns name, city, state, street, zipCode, website, revenue, employeeCount, primaryIndustry | tags: zoominfo, mcp
[CONFIRMED] ZoomInfo enrich_contacts MCP accepts personId (maps to ZoomInfoContactId from webhook payload) and returns companyName directly — viable alternative to separate company lookup | tags: zoominfo, mcp
[WARNING] Make credential request flow for ZoomInfo PKI is unreliable — prefilled credentials via credential-requests_create-by-credentials appear in inbox but fail authorization with "bad request, 1 parameter failed" — escalate to ZoomInfo support, do not retry through Make UI | tags: zoominfo, make-com, gotcha
[WARNING] ZoomInfo HTTP authenticate endpoint (api.zoominfo.com/authenticate) returns non-JSON on credential rejection, causing Make HTTP module "Response body is not a valid JSON" error — this is a response error, not request formatting | tags: zoominfo, make-com, gotcha

## Dashboard Architecture

[CONFIRMED] Dashboard has 5 tabs: Approval Queue, Sales Intelligence, AI Sourcing, CSV Import, Settings | tags: dashboard, architecture
[CONFIRMED] buildPayload(c) is the SINGLE source of truth for dashboard → Approval Handler payload — must be called by both submitOne() and submitQueue() | tags: dashboard, critical, pattern
[CONFIRMED] buildPayload includes 25 fields as of build ELEVATE-2026-0520-B: the 22 core spec fields (key, decision, sequence_id, contact_slug, contact_email, contact_name, contact_title, contact_phone, contact_mobile, contact_linkedin, contact_city, contact_state, contact_country, company_name, company_industry, company_website, company_address, employee_count, annual_revenue, persona, sequence_name, data_collection_source) plus 3 extras (company_linkedin, buying_signal, about_company). CLAUDE.md spec section reflects all 25 | tags: dashboard, critical, payload
[WARNING] Divergent inline payloads in submitOne() vs submitQueue() is the root cause pattern when fields don't reach RCRM — always check buildPayload first before debugging downstream scenarios | tags: dashboard, critical, debugging
[CONFIRMED] Sales Intelligence tab calls Anthropic API directly using model claude-sonnet-4-6 with web search tool | tags: dashboard, anthropic, ai
[CONFIRMED] 2026-05-21: Anthropic API key was REMOVED from live index.html — line 1482 now reads `const ANTHROPIC_KEY = 'ANTHROPIC_KEY_REMOVED';` literal. Side-effect: Sales Intelligence tab signal-refresh is currently non-functional (calls Anthropic with the placeholder string). Restoration requires Netlify function proxy + env var + dashboard call-site swap. Remaining Anthropic key exposure is in Make scenario 4667221 blueprint (Modules 5, 45 only) | tags: dashboard, security, status-update
[CONFIRMED] Per-card "Submit Individually" buttons are gold #C8820A, 130px min-width | tags: dashboard, ui
[CONFIRMED] After individual submit, card fades to 45% opacity; bulk Submit All Decisions skips already-individually-submitted records | tags: dashboard, ui
[CONFIRMED] initQueue() expects JSON array, not single object — Scenario B must wrap digest body in [ ] before URL encoding | tags: dashboard, scenario-b, gotcha
[CONFIRMED] Login uses hardcoded credentials for touellette@teamelevate.ca and admin@teamelevate.ca | tags: dashboard, auth

## Branding & Visual

[CONFIRMED] Primary brand gold is #C8820A (deep amber), NOT #FFB800 (too bright/yellow) | tags: branding, color
[CONFIRMED] ACD pillars are Accountability, Consistency, Discipline — displayed as three equal-width glass bubbles | tags: branding, ui
[CONFIRMED] Hero background uses Financial_rise_in_golden_light.png as real background asset, base64-embedded in HTML | tags: branding, ui

## Business Rules

[CONFIRMED] Elevate RS Corp serves automotive Tier 1/2, EV/battery, manufacturing, government/municipal sectors | tags: business, sectors
[CONFIRMED] Korean clients get +30% markup on pricing | tags: business, pricing
[CONFIRMED] Travis Ouellette is owner, email touellette@teamelevate.ca | tags: business, contacts
[CONFIRMED] Admin email is admin@teamelevate.ca | tags: business, contacts
[CONFIRMED] Company is in Windsor, Ontario | tags: business, location

## Email & Outreach Rules

[CONFIRMED] Lead Gen emails: persona-based, first name, 3-4 sentences max, lead with noticed pain point, one Elevate solution, soft ask | tags: outreach, style
[CONFIRMED] Email format: SUBJECT: / BODY: with line breaks, signed "Travis" | tags: outreach, style
[WARNING] Never use em dashes, marketing buzzwords, scheduler links, or clickbait subjects in outreach | tags: outreach, style
[CONFIRMED] Outreach sent via RCRM sequences, Claude drafts at approval time, Travis reviews before send (no auto-send) | tags: outreach, workflow
[CONFIRMED] Target personas: HR Manager, Production Manager, Plant Manager, Warehouse Manager, General Manager, Director of Finance, CFO, Engineering Manager | tags: outreach, personas
[CONFIRMED] CASL B2B implied consent applies — no unsubscribe link required on cold outreach | tags: outreach, compliance, canada

## Workflow & Conventions

[CONFIRMED] Travis's preference: take direct action, no step-by-step instructions | tags: workflow, preference
[CONFIRMED] Travis's preference: show widget/preview before applying changes to live files | tags: workflow, preference
[CONFIRMED] Travis's preference: run node -c JavaScript syntax validation before delivering any HTML | tags: workflow, preference, quality
[CONFIRMED] Travis's preference: build correctly once, no iterative patching | tags: workflow, preference
[CONFIRMED] Travis's preference: cross-reference 3+ sources before touching Make blueprints | tags: workflow, preference, make-com
[CONFIRMED] Travis's preference: verify current state before changing — never assume past patches are live | tags: workflow, preference
[CONFIRMED] Travis's preference: never rebuild from scratch — continue from existing | tags: workflow, preference
[CONFIRMED] Commit format: [scope] description where scope is dashboard, scenario-a, scenario-c, setup, fix, etc. | tags: convention, git

## Pipeline Field Flow (verified 2026-05-21)

[CONFIRMED] ZoomInfo Intake (4732316) Module 30 writes 24 fields to staging datastore 94078 including company_website, company_street, company_city, company_state, company_zipcode, company_country, company_phone, annual_revenue, zi_company_id, zi_contact_id | tags: pipeline, scenario-a, fields
[CONFIRMED] elevate_company_staging datastructure (347903) only declares 20 fields — undeclared but written fields (company_country, company_phone, company_zipcode, zi_contact_id) cannot be read by downstream SearchRecord output bundle | tags: pipeline, datastructure, gotcha
[CONFIRMED] elevate_daily_queue datastructure (319927) does NOT have zi_company_id or zi_contact_id columns — adding them is required before any "enrich at approval time" design can use them | tags: pipeline, datastructure, blocker
[CONFIRMED] As of 2026-05-21, Staging-to-Queue (4990696) Module 4 mapper writes: added_at, decision, queue_date, in_sequence, lead_source, company_name, contact_city, contact_name, contact_email, contact_phone, contact_state, contact_title, annual_revenue, contact_mobile, employee_count, company_address (concatenated street+city+state via trim()), company_website, contact_country, company_industry, contact_linkedin, contact_exists_in_rcrm, data_collection_source | tags: pipeline, staging-to-queue, fields
[CONFIRMED] Approval Handler Module 31 (company create) sends: company_name, about_company (from sanitized_about), website, linkedin, city (uses contact_city!), state (contact_state!), country (contact_country!), address (company_address), industry_id (from switch), custom_fields[field_id 1 employees, 2 revenue, 12 buying_signal] | tags: scenario-c, fields, gotcha
[WARNING] Approval Handler Module 31 sets company city/state/country from CONTACT location, not company HQ location — when contact works in a different city than the company HQ, the RCRM company record gets the contact's city stored as the company city | tags: scenario-c, gotcha, data-quality
[CONFIRMED] Approval Handler Module 11 (contact create) sends: first_name, last_name (from split-on-space), email, contact_number (= contact_phone), designation (= title), linkedin (sanitized to http://), city, state, country, address (uses company_address!), current_organization (= company_name), company_slug, stage_id: 142468, custom_fields[1 phone, 2 mobile, 5 "ZoomInfo" hardcoded] | tags: scenario-c, fields
[WARNING] Approval Handler Module 11 hardcodes custom_field 5 (Data Source) to the literal string "ZoomInfo" — does NOT pass through the dashboard's data_collection_source payload field. Signals-source approvals get tagged as ZoomInfo in RCRM | tags: scenario-c, bug, data-source

## Approval Handler Detailed Topology (4667221, verified 2026-05-21)

[CONFIRMED] Approval Handler module IDs and roles: 1=webhook, 20=SetVariables (first_name, last_name, linkedin_url, industry_id, sanitized_about), 99=UpdateRecord queue (decision+processed_at), 100=DeleteRecord queue (deletes after processing), 36=HTTP GET contact search (NOT POST), 37=SetVariables resolved_slug, 102=Router (Approve Only), Route1: 33=HTTP POST company search, 34=existing_company_slug, 31=POST /v1/companies create, 35=resolved_company_slug, 11=POST /v1/contacts create, 38=final_slug, 3=POST /v1/contacts/{slug} update stage+linkedin (redundant), 2=POST /v1/contacts/{slug}/enroll, 5=Anthropic note generation, 13=claude_note, 4=POST /v1/notes log. Route2 (existing contact): 39=final_slug=resolved, 43=POST /v1/contacts/{slug} update stage+linkedin only (no gap-fill), 44=enroll, 45=Anthropic, 46=claude_note, 47=POST /v1/notes log | tags: scenario-c, topology
[WARNING] Approval Handler Module 36 uses GET /v1/contacts/search?email={url}&exact_search=1 — contradicts the documented "POST /v1/contacts/search with body" pattern but appears to work in production. exact_search=1 may be the live RCRM behavior | tags: scenario-c, rcrm, gotcha
[WARNING] Approval Handler Module 20 industry_id switch hardcodes 12 industries and defaults to 0 — unmatched ZoomInfo industry strings get industry_id: 0 sent to RCRM company create | tags: scenario-c, bug, data-quality
[WARNING] Approval Handler deletes the queue record (Module 100) immediately after marking decision — no post-approval audit row remains in elevate_daily_queue 86836 | tags: scenario-c, behavior
[WARNING] Approval Handler existing-contact path (Module 43) only updates stage_id and linkedin — does NOT gap-fill phone/mobile/email/title from the incoming dashboard payload. ALSO overwrites linkedin even when RCRM already has one populated | tags: scenario-c, bug, data-preservation
[WARNING] RCRM Bearer token and Anthropic API key are embedded literally in the Approval Handler (4667221) and Queue Enrich Updater (4952511) blueprints — anyone with Make team access or scenarios_get can extract them | tags: scenario-c, security, urgent
[CONFIRMED] Make scenarios_update accepts blueprint changes to Datastore Add Record mapper with IML expressions like trim(1.X + ", " + 1.Y) without triggering isinvalid:true — the isinvalid trigger is specific to jsonStringBodyContent in HTTP modules | tags: make-com, api, gotcha-resolved

## Historical Debug Lessons

[CONFIRMED] 2026-04-30: Rob Davidson and similar contacts came through with no phone/LinkedIn/website because buildPayload was missing 10 fields — divergent inline payloads in submitOne vs submitQueue | tags: history, debugging, dashboard
[CONFIRMED] 2026-05-20: buildPayload(c) shared function actually shipped in commit d68bf01 (build ELEVATE-2026-0520-B-BUILDPAYLOAD25) with 25 fields, called by both submitOne() and submitQueue(), deploy verified via live HTML fetch from elevate-sales-nav.netlify.app. NOTE: an earlier handoff claimed this was patched same-day but the function was never actually present in index.html — both call sites had divergent inline payload objects in sync by coincidence only. The structural fix landed today | tags: history, dashboard, fix
[CONFIRMED] 2026-05-21: Patched Staging-to-Queue (4990696) Module 4 mapper via Make MCP scenarios_update to stop dropping company_website / company_address (concatenated street+city+state with trim()) / annual_revenue when copying staging records into elevate_daily_queue. Prior session theory (Approval Handler create-then-edit) was not the actual root cause for these three fields; the staging-to-queue copy was the actual cause. dashboard buildPayload and Approval Handler were already correct downstream | tags: history, scenario-staging-to-queue, fix
[CONFIRMED] 2026-05-21 (afternoon revalidation): elevate_daily_queue (86836) has 1,071 records, of which a 100-record sample shows 100% empty company_address/annual_revenue, 99% empty company_website, 64% empty company_name (oldest cohort from 2026-05-08 was added by a much-earlier-broken Staging-to-Queue version writing only 8 fields). The 2026-05-21 patch only stops new garbage, does not backfill the 1,071-card backlog | tags: history, datastore, audit
[CONFIRMED] 2026-05-21 (afternoon revalidation): Approval Handler webhook interface declares 24 fields, not the 25 buildPayload sends — contact_slug arrives but is undeclared (Make webhooks accept undeclared keys). No functional impact today, just cosmetic interface drift | tags: scenario-c, webhook, audit
[WARNING] Make MCP executions_get-detail returns ONLY {status: "SUCCESS"} — no module-level bundle data, no request/response bodies. To see what an Approval Handler actually sent to RCRM or what RCRM actually returned, must use the Make UI execution viewer. Limits API-only debugging | tags: make-com, api, gotcha
[CONFIRMED] data-store-records_list max limit is 100 (server-enforced). Calls with limit > 100 return MakeError, not silent truncation. For datastores with > 100 records, sample-and-summary is the workable Claude-side approach unless the MCP exposes pagination | tags: make-com, api, gotcha
[CONFIRMED] 2026-05-21 (evening): pushed Approval Handler (4667221) blueprint via scenarios_update WITH all 10+ jsonStringBodyContent modules present unchanged. isinvalid stayed false. The `isinvalid:true` gotcha applies to MODIFYING jsonStringBodyContent strings — round-tripping them unchanged inside a scenarios_update payload does NOT trip the flag. Useful when bundling SetVariables/URL/webhook-interface edits in scenarios that also contain jsonStringBodyContent | tags: make-com, api, gotcha-refinement
[CONFIRMED] 2026-05-21 (evening): three Approval Handler edits applied via single scenarios_update — (1) added contact_slug to webhook interface, (2) Module 20 industry_id switch default 0 → 913 (Manufacturing safe-default for unmatched industries), (3) Module 36 contact-search URL wrapped contact_email in lower() for case-insensitive dedup. Plus datastructures 319927 and 347903 extended with zi_company_id / zi_contact_id / company_country / company_zipcode / company_phone. Plus Staging-to-Queue Module 4 carries zi_company_id and zi_contact_id forward. All pre-edit state snapshotted to .backups/ (gitignored) | tags: history, remediation, api-fixes, applied
[CONFIRMED] 2026-05-21 (evening): Module 3 (redundant new-contact stage update — POST /v1/contacts/{slug} with stage_id+linkedin already set by Module 11) deleted from Approval Handler Route A via scenarios_update. usedPackages count dropped 24→23, no isinvalid trip, no broken downstream references (all consumers reference Module 38 final_slug). Saves one RCRM API call per new-contact approval. Existing-contact Route B Module 43 still does stage_id+linkedin update there since Route B doesn't pass through Module 11 — separate defect (no gap-fill, overwrites linkedin) tracked as Issue 2.1 | tags: history, remediation, scenario-c, module-deletion, applied
[CONFIRMED] 2026-05-21 (evening): structural deletion of a module from a router-route flow (Approval Handler Route A, removed Module 3) succeeded via scenarios_update without triggering isinvalid:true, even though the same blueprint contains 10+ unchanged jsonStringBodyContent modules. The isinvalid trigger is specifically about MODIFYING jsonStringBodyContent strings — adding/removing modules and round-tripping unchanged body content is safe via API | tags: make-com, api, gotcha-refinement
[CONFIRMED] 2026-05-21 (late evening): MODIFYING jsonStringBodyContent strings via scenarios_update also does NOT trigger isinvalid:true — at least not in the patterns tested. Pushed two body changes in one update: (a) Module 11 body changed `\"value\": \"ZoomInfo\"` to `\"value\": \"{{1.data_collection_source}}\"` (added a new {{var}} reference inside jsonStringBodyContent), (b) Module 43 body shrank from `{\"stage_id\": 142468, \"linkedin\": \"{{20.linkedin_url}}\"}` to `{\"stage_id\": 142468}` (removed a {{var}} reference). Post-push isinvalid:false, scenario live, no Make UI Save needed. The SCRIBE entries at lines 20-21 about "jsonStringBodyContent with {{variable}} triggers isinvalid:true" are SIGNIFICANTLY OUTDATED — at minimum it does not apply to all such edits. Hypothesis: the gotcha may have been a Make platform bug that has since been fixed, OR it triggers only on malformed JSON / unbalanced braces / specific patterns not yet characterized. Behavior worth re-testing periodically but no longer treated as a hard blocker | tags: make-com, api, gotcha-superseded
[CONFIRMED] Scenario A null-email filter added at Module 3 to block ZoomInfo records with no email | tags: history, scenario-a, fix
[CONFIRMED] Scenario A Module 18 uses only {{21.data.slug}} from create response — broken ifempty fallback removed | tags: history, scenario-a, fix
[CONFIRMED] Scenario C Module 99 (UpdateRecord for decision audit) must be at position 2 immediately after webhook, not at end of flow, due to bundle propagation rules | tags: history, scenario-c, architecture
[CONFIRMED] Queue Fetch filters to only pending records (decision IS NULL or = "pending") | tags: scenarios, queue-fetch

## Security Notes

[WARNING] Never commit API keys, bearer tokens, or private keys to this repo — use environment variables only | tags: security, critical
[WARNING] ZoomInfo private key (PKCS#8) for Client ID ca97f380-d6be-42bc-a788-2b3a8454f495 was leaked in a chat 2026-05-20 — rotate before deploying | tags: security, urgent, zoominfo
[CONFIRMED] Anthropic API key already removed from live index.html — see "Dashboard Architecture" section status update for current state. Remaining exposure is Make blueprint only | tags: security, status-update, dashboard
