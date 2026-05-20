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
[WARNING] Make blueprints pushed via API with {{variable}} expressions in jsonStringBodyContent automatically trigger isinvalid:true | tags: make-com, gotcha, api
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
[CONFIRMED] RCRM contact search endpoint: POST /v1/contacts/search with body {"email":"X"} | tags: rcrm, api
[WARNING] GET /v1/contacts?email=X returns unfiltered contact list — the email query param is ignored | tags: rcrm, api, gotcha
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
[CONFIRMED] buildPayload includes 25 fields as of build ELEVATE-2026-0520-B: the 22 spec fields (key, decision, sequence_id, contact_slug, contact_email, contact_name, contact_title, contact_phone, contact_mobile, contact_linkedin, contact_city, contact_state, contact_country, company_name, company_industry, company_website, company_address, employee_count, annual_revenue, persona, sequence_name, data_collection_source) plus 3 extras (company_linkedin, buying_signal, about_company). CLAUDE.md still lists 22 — extras are in code but not yet promoted to spec | tags: dashboard, critical, payload
[WARNING] Divergent inline payloads in submitOne() vs submitQueue() is the root cause pattern when fields don't reach RCRM — always check buildPayload first before debugging downstream scenarios | tags: dashboard, critical, debugging
[CONFIRMED] Sales Intelligence tab calls Anthropic API directly using model claude-sonnet-4-6 with web search tool | tags: dashboard, anthropic, ai
[WARNING] Anthropic API key is hardcoded in live index.html — security debt, needs Netlify function proxy | tags: dashboard, security, tech-debt
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

## Historical Debug Lessons

[CONFIRMED] 2026-04-30: Rob Davidson and similar contacts came through with no phone/LinkedIn/website because buildPayload was missing 10 fields — divergent inline payloads in submitOne vs submitQueue | tags: history, debugging, dashboard
[CONFIRMED] 2026-05-20: buildPayload(c) shared function actually shipped in commit d68bf01 (build ELEVATE-2026-0520-B-BUILDPAYLOAD25) with 25 fields, called by both submitOne() and submitQueue(), deploy verified via live HTML fetch from elevate-sales-nav.netlify.app. NOTE: an earlier handoff claimed this was patched same-day but the function was never actually present in index.html — both call sites had divergent inline payload objects in sync by coincidence only. The structural fix landed today | tags: history, dashboard, fix
[CONFIRMED] Scenario A null-email filter added at Module 3 to block ZoomInfo records with no email | tags: history, scenario-a, fix
[CONFIRMED] Scenario A Module 18 uses only {{21.data.slug}} from create response — broken ifempty fallback removed | tags: history, scenario-a, fix
[CONFIRMED] Scenario C Module 99 (UpdateRecord for decision audit) must be at position 2 immediately after webhook, not at end of flow, due to bundle propagation rules | tags: history, scenario-c, architecture
[CONFIRMED] Queue Fetch filters to only pending records (decision IS NULL or = "pending") | tags: scenarios, queue-fetch

## Security Notes

[WARNING] Never commit API keys, bearer tokens, or private keys to this repo — use environment variables only | tags: security, critical
[WARNING] ZoomInfo private key (PKCS#8) for Client ID ca97f380-d6be-42bc-a788-2b3a8454f495 was leaked in a chat 2026-05-20 — rotate before deploying | tags: security, urgent, zoominfo
[WARNING] Anthropic API key currently hardcoded in live index.html — known tech debt | tags: security, tech-debt, dashboard
