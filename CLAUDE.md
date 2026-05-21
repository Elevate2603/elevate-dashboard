# Elevate Sales Intelligence Dashboard

## Overview

Single-page sales intelligence and approval dashboard for Elevate RS Corp, a staffing/recruitment agency in Windsor, Ontario focused on automotive Tier 1/2, EV/battery, manufacturing, and government/municipal sectors. The dashboard is the human-in-the-loop interface for an automated B2B lead pipeline that pulls contacts from ZoomInfo, enriches them via Make.com scenarios, and pushes approved leads into RecruitCRM (RCRM) sequences.

Owner: Travis Ouellette (touellette@teamelevate.ca)
Admin: admin@teamelevate.ca

## Tech Stack

- **Frontend:** Single `index.html` file — vanilla HTML/CSS/JS, no build step, no framework
- **Hosting:** Netlify (drag-and-drop or auto-deploy from GitHub main branch)
- **Backend automation:** Make.com (formerly Integromat) scenarios on us2 region
- **CRM:** RecruitCRM (RCRM) — REST API, Bearer token auth
- **Data source:** ZoomInfo (PKI connection + ICP Targeting webhook + MCP for enrichment)
- **AI:** Anthropic API called directly from the dashboard for signal generation (model: claude-sonnet-4-6 with web search tool)

## Hosting & Repo

- **Live URL:** https://elevate-sales-nav.netlify.app
- **Netlify Site ID:** `a92ed0bc-d4dd-4f47-a50d-820a517f2d34`
- **GitHub repo:** `Elevate2603/elevate-dashboard`
- **Deploy method:** Auto-deploy from `main` branch (Netlify watches GitHub). Live within ~30 seconds of push. Drag-and-drop at `app.netlify.com/projects/elevate-sales-nav` also works.
- **Build:** None. Single static `index.html`.

## Architecture

The dashboard is a single `index.html` file with 5 tabs:

1. **Approval Queue** — Cards rendered from `elevate_daily_queue` datastore. Each card has Submit Individually (gold button) + bulk Submit All Decisions. Submitting fires the Approval Handler webhook.
2. **Sales Intelligence** — 3-column layout: market pulse, signal refresh (calls Anthropic API directly with web search), predictive hiring windows.
3. **AI Sourcing** — Placeholder, build pending.
4. **CSV Import** — Manual ZoomInfo CSV upload, feeds Scenario A's webhook.
5. **Settings** — Visible to Travis only after login.

### Critical shared function

`buildPayload(c)` in `index.html` builds the JSON body sent to the Approval Handler webhook. It MUST be called by both `submitOne()` and `submitQueue()` — divergent inline payloads were the root cause of contacts coming through with missing phone/LinkedIn/city/etc.

The 28 fields buildPayload must include — 22 core spec fields plus 6 extras carried in current builds:

**Core 22 (required):**
`key`, `decision`, `sequence_id`, `contact_slug`, `contact_email`, `contact_name`, `contact_title`, `contact_phone`, `contact_mobile`, `contact_linkedin`, `contact_city`, `contact_state`, `contact_country`, `company_name`, `company_industry`, `company_website`, `company_address`, `employee_count`, `annual_revenue`, `persona`, `sequence_name`, `data_collection_source`

**Extras (6, currently shipped in build ELEVATE-2026-0521-A-BUILDPAYLOAD28):**
`company_linkedin`, `buying_signal`, `about_company`, `company_city`, `company_state`, `company_country`

The 3 new company-location fields (`company_city`, `company_state`, `company_country`) carry the company HQ location separately from contact location, enabling Approval Handler Module 31 to write the correct company city/state/country to RCRM (was previously writing contact location as a fallback).

When debugging "field X didn't reach RCRM," verify buildPayload first before touching downstream scenarios.

## Make.com Backend

- **Region:** us2 (us2.make.com — NOT eu2)
- **Team ID:** 2053152
- **Org ID:** 7033146

### Core scenarios

| Scenario | ID | Trigger | Purpose |
|---|---|---|---|
| ZoomInfo Intake (Scenario A) | 4732316 | Live webhook | Receives ZoomInfo contacts → writes to staging |
| Staging-to-Queue | 4990696 | Daily 6am | Promotes staged contacts to `elevate_daily_queue` |
| Hiring Signals Auto Pull | 4991665 | Daily 5:30am | Pulls hiring signals from sources |
| Market Intel Engine (Scenario D) | 4688813 | Daily 6am | Generates market intel for dashboard |
| Morning BD Email (Scenario B) | 4669709 | Daily 8am | Sends Travis the approval queue email |
| Approval Handler (Scenario C) | 4667221 | Live webhook | Receives dashboard approvals → creates RCRM company+contact, enrolls in sequence, writes note |
| Queue Fetch | 4734116 | Live webhook | Dashboard fetches pending queue cards |
| Signal Writer | 4744089 | Live webhook | Writes signals to datastore |
| Signal Fetch | 4744091 | Live webhook | Dashboard fetches signals |

### Webhook URLs (hook.us2.make.com/...)

- Queue Fetch: `fbwggrimbt2iidjeckvs25sk61hej2lh`
- Signal Writer: `iavptl5ghkx1qinlyi7pb567mw1ccuk0`
- Signal Fetch: `tt27x57x9jlln7tjw4uvvb9d48hppp26`
- Approval Handler: `aq8yfoqv8itfhrewo1k6iib7u6rq4gm1`

### Datastores

- `elevate_daily_queue` — 86836
- `digest` — 90196
- `company_intel` — 90393
- `elevate_market_signals` — 91802
- `elevate_pending_retrieval` — 97143

### Signals subsystem (currently high error rates — needs fix)

- Signals-Enrich Contacts — 4957200 (~62% error)
- Signals-Email Drafter — 4955815 (~46% error)
- Signals-Outlook Send & Log — 4955828 (~88% error)
- ZI Search & Enrich Worker — 4964850 (~57% error)

### Deactivated (do not re-enable without fixing)

- Auto-Enrich Pending Signals — 4978011, 4990702 (isinvalid:true)
- Queue Loader — 4904126
- Signals-Add to Retrieval Queue — 4953405

## RCRM (RecruitCRM)

- **Auth:** Bearer token (stored in environment, never in repo)
- **Rate limit:** 60 requests / minute
- **Contact search endpoint:** `POST /v1/contacts/search` with body `{"email":"X"}` — NOT `GET /v1/contacts?email=X` (that returns unfiltered list)
- **Stage updates:** Use exact stage name as text string, not numeric ID
- **Notes endpoint:** `POST /v1/notes`

### Sequence IDs

`15307` through `15327` (12 sequences for persona × variant combinations)

### Note types

- Emailed: `195663`
- Sales Lead: `213194`

### Lists — DO NOT TOUCH

- Active Client: `166186`
- DNU (Do Not Use): `198202`

### Custom field IDs

**Contact:**
- `1` = Office Direct Line
- `2` = Mobile
- `5` = Data Source

**Company:**
- `1` = Employees
- `2` = Revenue
- `9` = Locations
- `10`, `11` = Funding
- `12` = Buying Signal

## ZoomInfo

- **ICP filter:** "Contact's Office AND Company HQ" = Ontario only
- **PKI connection:** Client ID `ca97f380-d6be-42bc-a788-2b3a8454f495`. Private key stored in environment variable (NEVER in this repo). Connection has been intermittent — escalated to ZoomInfo support.
- **Interim workflow:** Travis says "process today's queue" each morning until PKI is stable.
- **Credit efficiency:** Previously enriched companies don't consume credits again for one year.

## Environment Variables

The following must be set locally (in a `.env` file that is gitignored) and in any deployment environment. Never commit values.

| Variable | Description | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | For dashboard's direct Claude API calls | console.anthropic.com |
| `RCRM_BEARER_TOKEN` | RCRM REST API auth | RecruitCRM settings |
| `ZOOMINFO_CLIENT_ID` | `ca97f380-d6be-42bc-a788-2b3a8454f495` | ZoomInfo admin |
| `ZOOMINFO_PRIVATE_KEY` | PKCS#8 PEM private key | ZoomInfo admin (rotate periodically) |
| `MAKE_API_TOKEN` | For Make scenario blueprint updates | make.com → profile → API tokens |
| `NETLIFY_AUTH_TOKEN` | For CLI deploys | netlify.com → user settings |

**SECURITY NOTE:** Anthropic API key was previously hardcoded in `index.html` — confirmed REMOVED as of 2026-05-21 (live HTML line 1482 = `ANTHROPIC_KEY_REMOVED` literal). Side-effect: the Sales Intelligence tab's signal-refresh feature is broken (calls Anthropic with the placeholder string). To restore: build a Netlify function proxy (`netlify/functions/anthropic-proxy.js`) that holds the key server-side in Netlify env, and update the Sales Intelligence tab to call the proxy. Remaining Anthropic key exposure is in Make scenario 4667221 blueprint headers (Modules 5, 45) — extractable via `scenarios_get`. Rotate during the Make Connections migration (Issue 2.6 of the remediation plan).

## Branding

- **Primary gold:** `#C8820A` (deep amber, NOT bright yellow)
- **Theme:** Dark luxury
- **Background:** `Financial_rise_in_golden_light.png` as real background asset, base64-embedded in HTML
- **Pillars (ACD):** Accountability, Consistency, Discipline — displayed as three equal-width glass bubbles in hero section

## Development & Deployment

```bash
# Local preview (just open the file)
start index.html

# Or run a local server
npx http-server .

# Deploy via Git (preferred)
git add index.html
git commit -m "[dashboard] description"
git push                              # Netlify auto-deploys from main

# Deploy directly via Netlify CLI
netlify deploy --prod --dir=.

# Drag-and-drop fallback
# Open app.netlify.com/projects/elevate-sales-nav → Deploys tab → drag index.html
```

### Build token convention

Every deploy injects a unique build token comment at the top of `index.html` to force Netlify to recognize a new hash:
```html
<!-- BUILD: ELEVATE-YYYY-MMDD-X -->
```
Format: `ELEVATE-{year}-{month}{day}-{letter}` where letter increments per same-day deploy (A, B, C...).

## Conventions

- **Commit format:** `[scope] description` — scopes: `dashboard`, `scenario-a`, `scenario-c`, `setup`, `fix`
- **Branch:** Work directly on `main` for hotfixes. Use `feature/description` for larger work.
- **Pre-deploy check:** Always run `node -c` (syntax check) on any HTML containing JS before delivery.
- **Verify before changing:** Read current file/scenario state before modifying. Never assume past patches are live.
- **No rebuilds from scratch:** Continue from existing code.
- **Widget preview first:** Show UI in a widget/preview before writing the live file.

## Integration Points

- **GitHub → Netlify:** Auto-deploy on push to main
- **Dashboard → Make webhooks:** Approval, Queue Fetch, Signal Writer, Signal Fetch (hook.us2.make.com)
- **Dashboard → Anthropic API:** Direct fetch() for signal generation
- **Make → RCRM:** Approval Handler creates company + contact, enrolls sequence, writes note
- **Make → ZoomInfo:** PKI connection for enrich (when working), MCP fallback for manual enrich
- **ZoomInfo ICP Targeting → Scenario A webhook:** Contact bundles only (company bundles never arrive — known platform limitation)

## Known Issues / Tech Debt

1. **Staging-to-Queue (4990696) enrichment gap** — Scenario doesn't enrich company data before writing to queue. 880 existing cards have empty website/address/LinkedIn/revenue. **Fix:** Add ZoomInfo company enrich module between GetRecord and AddRecord steps.

2. **Netlify zip `elevate-zi-bridge.zip` deployment unverified** — signal-aggregator function. Auto-Enrich and Hiring Signals Auto Pull both call it; both have 1 execution / 1 error. Need to confirm the zip was ever dragged to Netlify.

3. **ZoomInfo PKI connection unstable** — escalated to ZoomInfo support. Interim workflow is manual "process today's queue" trigger each morning.

4. **Ontario Recruitment Lead Gen dashboard tab** — Architecture agreed (Indeed + LinkedIn + news weighted signals, Claude drafts at approval time, persona-based emails). Test 1 passed on signal-003 Stellantis Windsor. Dashboard tab integration pending.

5. **Sales Intelligence tab non-functional** — Anthropic key was redacted from HTML at some prior point (live line 1482 = literal `ANTHROPIC_KEY_REMOVED`). Signal refresh button hits Anthropic with the placeholder and fails. Fix path: build `netlify/functions/anthropic-proxy.js`, set `ANTHROPIC_API_KEY` in Netlify env, swap dashboard call-site to proxy URL.

6. **Signals subsystem error rates 46-88%** — Signals-Enrich Contacts, Email Drafter, Outlook Send, ZI Search Worker all bleeding errors. Needs systematic debug.

7. **Make.com platform limitation:** `isinvalid:true` flag on scenarios only clears via manual Save in Make UI, never via API. `jsonStringBodyContent` with `{{variable}}` expressions triggers this. `scenarios_update` silently rejects identical blueprints.

## Make.com Operation Gotchas (Reference)

- `isinvalid:true` only clears via manual UI save
- `data-store-records_delete` requires all keys in a single array call
- `data-store-records_list` defaults to 10 records — always specify `limit: 100+`
- Bundle propagation: if any filter blocks a bundle, ALL downstream modules stop
- IML arrays are 1-based (`data[1]` = first element)
- Always run `scenarios_get` before `scenarios_update` to avoid silent rejects
- Make webhook scenarios (instant triggers) cannot be tested via `scenarios_run` API

## Email Style Rules (for Lead Gen drafts)

- First name only, 3-4 sentences max
- Lead with noticed pain point
- One concrete Elevate solution
- Soft ask (no scheduler links)
- NO em dashes, NO marketing buzzwords, NO clickbait subjects
- Format: `SUBJECT: ...\nBODY: ...` with line breaks
- Signed simply "Travis"
- Sent via RCRM sequences (15307-15327)

## Target Personas (Lead Gen)

HR Manager, Production Manager, Plant Manager, Warehouse Manager, General Manager, Director of Finance, CFO, Engineering Manager

## Pricing Rule

Korean clients get +30% markup.
