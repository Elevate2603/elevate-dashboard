# Proposed Scenario Changes — Approval Handler (4667221)

**Author:** Claude Code session 2026-05-20
**Goal:** On approve, RCRM receives exactly one company record and one contact record, both fully populated, in the minimum number of API calls. On decline, RCRM and ZoomInfo are not touched at all.
**Status:** Design v1 — literal module-by-module line diff requires current scenario blueprint via Make MCP. Functional spec below is complete and ready to apply.

---

## 0. Problem Recap

Two defects compound to produce RCRM records with empty fields after approval:

**(a) Upstream enrichment gap.** Staging-to-Queue (4990696) writes queue rows from staged ZoomInfo contact bundles without enriching the company side. ZoomInfo's ICP Targeting workflow sends contact bundles only (never company bundles — known platform limit, see SCRIBE_EXPORT.md line 78). Result: ~880 existing queue cards arrive at the dashboard with empty `company_website`, `company_address`, `company_linkedin`, `annual_revenue`, `employee_count`, `about_company`.

**(b) Downstream create-then-edit.** Approval Handler (4667221) currently creates the RCRM company with a minimal field set, then issues a second update to fill the remaining fields. Two API calls, two audit-log entries, two consumption units against the 60 req/min rate limit per company. Same pattern likely exists for the contact.

The dashboard already sends all 25 fields via `buildPayload(c)` (index.html:1303) — verified live in build `ELEVATE-2026-0520-B-BUILDPAYLOAD25`. The fix is entirely server-side: enrich missing fields just-in-time, then write each RCRM record in one call.

---

## 1. Diff Summary — Current vs New

| Aspect | Current | New |
|---|---|---|
| Decline path | Webhook hits scenario, decision is recorded, ZoomInfo not touched, RCRM touched only if filter is wrong | Webhook hits scenario, Module 99 records decision, hard filter routes ONLY approves past this point. Zero RCRM, zero ZoomInfo, zero risk |
| Enrichment trigger | Attempted in Staging-to-Queue (not currently wired; known issue #1) | Triggered in Approval Handler **after** approve filter, **only** if company fields are missing |
| Enrichment source | Was planned: ZoomInfo PKI direct from Make HTTP | Netlify function bridge `/.netlify/functions/zi-enrich` — Make → Netlify (shared secret) → ZoomInfo (server-side PKI/JWT). Decouples Make from PKI brittleness |
| Company write | Two RCRM calls: minimal create, then full edit | One call per record. If new: `POST /v1/companies` with full payload including all custom fields (1, 2, 9, 10, 11, 12). If existing: single `POST /v1/companies/{slug}` update populating only fields that are empty in RCRM |
| Contact write | Likely also create-then-edit pattern (TBC against blueprint) | One call per record. `POST /v1/contacts` with company slug + all custom fields (1, 2, 5) in one payload. Existing contact: `POST /v1/contacts/{slug}` update, gap-fill only |
| Company dedup | Unknown (TBC against blueprint) — may be creating duplicates if no search step | Always search RCRM first by `company_website`, fall back to `company_name`. Only create if not found |
| Contact dedup | Per scribe, search is done via `POST /v1/contacts/search {"email":"X"}` | Unchanged — already correct in current scenario |
| Rate-limit safety | Unknown | Add 1.5-second Sleep between per-card iterations when bulk submit fires multiple approvals; single approves: no sleep |

**LITERAL MODULE-BY-MODULE DIFF — PENDING BLUEPRINT PASTE.**
To produce a line-precise diff (module IDs, parameter mappings, position numbers, IML expressions), the current blueprint of scenario 4667221 must be retrieved via the Make MCP in the web chat and pasted into this file. Until then, the module-by-module section below specifies the **target** state in module-functional terms; the diff against current is constructable mechanically once the blueprint is in hand.

---

## 2. Module-by-Module — Target Scenario

Target topology of the new Approval Handler. Module numbers are illustrative; actual IDs preserved from current blueprint where the function is the same. Per SCRIBE_EXPORT.md line 138, the decision-audit Update-Record must remain at position 2 immediately after the webhook for bundle propagation safety.

```
[1]  Webhook (instant trigger)
       URL: hook.us2.make.com/aq8yfoqv8itfhrewo1k6iib7u6rq4gm1
       Body: 25-field JSON (see index.html:1303 buildPayload)

[2]  Update Record — elevate_daily_queue (datastore 86836)            ← keeps Module 99 role
       Key: {{1.key}}
       Operation: update
       Fields: { decision: {{1.decision}}, decided_at: now }
       (Audit. Fires for BOTH approve and decline.)

[3]  Router — split on decision
       │
       ├─ Route A: decision = "decline"
       │     [4] (terminate — no further modules; bundle ends)
       │
       └─ Route B: decision = "approve"
             │
             [5] Get Record — elevate_daily_queue
                   Key: {{1.key}}
                   Purpose: pull original ZI fields (zoominfo_company_id, zoominfo_contact_id, etc.) that the dashboard payload does not carry
             │
             [6] Set Variables — merged_company_data
                   For each field (website, address, linkedin, revenue, employee_count, industry, about_company, locations):
                     merged.X = ifempty({{1.X}}, {{5.X}})        ← webhook first, queue fallback
                   compute needs_enrich = if(any merged.X is empty AND {{5.zoominfo_company_id}} present) true else false
             │
             [7] Filter — needs_enrich = true
                   │
                   ├─ TRUE branch:
                   │     [8] HTTP — POST https://elevate-sales-nav.netlify.app/.netlify/functions/zi-enrich
                   │           Headers: { x-elevate-secret: {{env.ZI_BRIDGE_SECRET}}, Content-Type: application/json }
                   │           Body: { "companyId": "{{5.zoominfo_company_id}}", "personId": "{{5.zoominfo_contact_id}}" }
                   │           Parse: yes (JSON)
                   │           Timeout: 20s
                   │     [9] Set Variables — overwrite merged.X with ifempty(merged.X, {{8.company.X}})
                   │           (only fill empties; never overwrite dashboard-supplied data)
                   │
                   └─ FALSE branch: skip [8] and [9]
             │
             [10] Search Records — RCRM company search
                    Method: POST https://api.recruitcrm.io/v1/companies/search
                    Body: { "website": "{{merged.company_website}}" }
                    OR (if website empty): { "name": "{{1.company_name}}" }
                    Auth: Bearer {{env.RCRM_BEARER_TOKEN}}
             │
             [11] Router — company_exists?
                    │
                    ├─ NEW COMPANY (search returned 0 results)
                    │     [12] HTTP — POST /v1/companies
                    │           Body: see Section 3 (full payload, all custom fields)
                    │           Capture: response.data.slug → company_slug
                    │
                    └─ EXISTING COMPANY (search returned ≥1 result)
                          [13] Set Variables — company_slug = first result's slug
                          [14] Filter — any of merged.X are non-empty AND not equal to existing RCRM value
                                │
                                ├─ TRUE: [15] HTTP — POST /v1/companies/{{company_slug}}
                                │              Body: gap-fill only (only fields where RCRM is empty)
                                │
                                └─ FALSE: skip [15]
             │
             [16] Search Records — RCRM contact search
                    Method: POST /v1/contacts/search
                    Body: { "email": "{{1.contact_email}}" }
             │
             [17] Router — contact_exists?
                    │
                    ├─ NEW CONTACT
                    │     [18] HTTP — POST /v1/contacts
                    │           Body: see Section 4 (full payload, all custom fields, company association by slug)
                    │           Capture: response.data.slug → contact_slug
                    │
                    └─ EXISTING CONTACT
                          [19] Set Variables — contact_slug = first result's slug
                          [20] HTTP — POST /v1/contacts/{{contact_slug}}
                                Body: gap-fill only (only fields where RCRM is empty), DO NOT overwrite phone/mobile/email if present
                                Guardrail: DO NOT touch lists. NEVER add to list 166186 (Active Client) or 198202 (DNU). (See CLAUDE.md.)
             │
             [21] HTTP — POST /v1/contacts/{{contact_slug}}/assigned-sequences   ← enroll in sequence
                    Body: { "sequence_id": "{{1.sequence_id}}" }
                    (Endpoint name TBC against blueprint — current scenario already does this; preserve exact endpoint and body shape)
             │
             [22] HTTP — POST /v1/notes
                    Body: see Section 8 of this doc (sales-lead note)
             │
             [23] Update Record — elevate_daily_queue
                    Key: {{1.key}}
                    Fields: { rcrm_company_slug: {{company_slug}}, rcrm_contact_slug: {{contact_slug}}, submitted_at: now, status: "submitted" }
```

Notes on the topology:

- The audit Update-Record [2] stays at position 2 per the bundle-propagation rule (SCRIBE_EXPORT.md line 138).
- All RCRM mutations sit behind the approve route. Decline = audit-only.
- The ZoomInfo bridge call [8] is optional and conditional — if `zoominfo_company_id` is absent from the queue row (older cards without it), enrichment is skipped and the scenario proceeds with whatever the dashboard supplied. Graceful degradation.
- Search-before-write at [10] and [16] prevents the duplicate-company / duplicate-contact failure mode.
- Existing-contact path [19][20] does gap-fill, never overwrite — critical because RCRM holds the source of truth for contacts that have been hand-edited by Travis.
- Lists 166186 and 198202 are not referenced anywhere in this topology. Per CLAUDE.md and SCRIBE_EXPORT.md line 68, automation must never touch them.

---

## 3. Exact RCRM Payload — New Company Create (POST /v1/companies)

Body JSON sent by Module [12] when search returns zero. All 25 fields from the dashboard payload, merged with ZoomInfo enrichment where applicable, mapped to RCRM company schema.

```json
{
  "company_name": "{{merged.company_name}}",
  "website": "{{merged.company_website}}",
  "industry": "{{merged.company_industry}}",
  "address": "{{merged.company_address}}",
  "linkedin": "{{merged.company_linkedin}}",
  "about_us": "{{merged.about_company}}",
  "custom_fields": [
    { "field_id": 1,  "value": "{{merged.employee_count}}" },
    { "field_id": 2,  "value": "{{merged.annual_revenue}}" },
    { "field_id": 9,  "value": "{{merged.company_address}}" },
    { "field_id": 10, "value": "{{merged.funding_total}}" },
    { "field_id": 11, "value": "{{merged.funding_stage}}" },
    { "field_id": 12, "value": "{{1.buying_signal}}" }
  ]
}
```

Field-by-field source notes:

| RCRM field | Source | Notes |
|---|---|---|
| company_name | dashboard `company_name` | Required. Never empty. |
| website | dashboard `company_website` → merged → ZI enrichment fallback | Used as company-search key. |
| industry | dashboard `company_industry` → ZI | |
| address | dashboard `company_address` → ZI | Single street/city/state string. ZI returns city/state/street/zip separately; bridge concatenates. |
| linkedin | dashboard `company_linkedin` → ZI | LinkedIn URL string. |
| about_us | dashboard `about_company` → ZI | Free text. |
| custom_field 1 (Employees) | dashboard `employee_count` → ZI | Per CLAUDE.md. Numeric or band string. |
| custom_field 2 (Revenue) | dashboard `annual_revenue` → ZI | Per CLAUDE.md. Numeric string. |
| custom_field 9 (Locations) | dashboard `company_address` → ZI | Per CLAUDE.md. Single-location case = same as address; multi-location lookup left to future ZI extension. |
| custom_field 10 / 11 (Funding) | ZI only | Dashboard payload does not carry funding. If ZI returns it, populate; else empty. |
| custom_field 12 (Buying Signal) | dashboard `buying_signal` | Per CLAUDE.md. Never populated from ZI — Elevate-curated. |

**RCRM endpoint exact field names (`company_name` vs `name`, `about_us` vs `description`, custom field shape `[{field_id,value}]` vs `{custom_fields:{1:val}}`) — PENDING BLUEPRINT PASTE.** The current Approval Handler already writes these fields successfully (just split across two calls); the exact field names and the custom-fields shape are encoded in the current module mapping. Once the blueprint is pasted I will adopt the exact existing names. The shape above is the conservative best-guess form.

---

## 4. Exact RCRM Payload — New Contact Create (POST /v1/contacts)

Body JSON sent by Module [18] when contact search returns zero. Company slug must be captured from Module [12] or [13] before this call.

```json
{
  "first_name": "{{splitFirst(1.contact_name)}}",
  "last_name":  "{{splitRest(1.contact_name)}}",
  "email":      "{{1.contact_email}}",
  "title":      "{{1.contact_title}}",
  "linkedin":   "{{1.contact_linkedin}}",
  "city":       "{{1.contact_city}}",
  "state":      "{{1.contact_state}}",
  "country":    "{{1.contact_country}}",
  "company_slug": "{{company_slug}}",
  "custom_fields": [
    { "field_id": 1, "value": "{{1.contact_phone}}"  },
    { "field_id": 2, "value": "{{1.contact_mobile}}" },
    { "field_id": 5, "value": "{{1.data_collection_source}}" }
  ]
}
```

Field-by-field source notes:

| RCRM field | Source | Notes |
|---|---|---|
| first_name / last_name | dashboard `contact_name` split on first space | `contact_name` is a single string from ZoomInfo. Make `split(name, " ")` → first = first_name, rest joined = last_name. |
| email | dashboard `contact_email` | Required. Search key. |
| title | dashboard `contact_title` | |
| linkedin | dashboard `contact_linkedin` | LinkedIn URL. |
| city / state / country | dashboard `contact_city`/`contact_state`/`contact_country` | |
| company_slug | from Module [12] or [13] | Per SCRIBE_EXPORT.md line 71: company association on contact creation uses **slug**, not numeric ID. |
| custom_field 1 (Office Direct Line) | dashboard `contact_phone` | Per CLAUDE.md. |
| custom_field 2 (Mobile) | dashboard `contact_mobile` | Per CLAUDE.md. |
| custom_field 5 (Data Source) | dashboard `data_collection_source` | Per CLAUDE.md. |

**Same blueprint-pending caveat as Section 3.** The current scenario already creates contacts; the exact field-name shape will be adopted from the existing module once the blueprint is pasted. The above represents the conservative target structure.

---

## 5. Decline Path — Zero Touches

On `decision = "decline"`, the scenario executes exactly two operations and stops:

1. Module [1]: webhook accepts the payload (HTTP 200).
2. Module [2]: Update-Record on `elevate_daily_queue` (datastore 86836), key = `c.key`, sets `decision = "decline"` and `decided_at = now`.

Module [3] router has a single edge for `decision = "decline"` that leads to a terminal node — no further modules. Specifically:

- No RCRM contact search.
- No RCRM company search.
- No RCRM POST of any kind.
- No call to the Netlify ZoomInfo bridge.
- No sequence enrollment.
- No note write.
- No second queue update — the audit write already happened.

ZoomInfo credits remain at zero touches on decline because the bridge call [8] sits exclusively inside the approve route, after the decision filter at [3]. RCRM rate-limit budget is preserved for approvals.

**Verification:** after deployment, decline a known card and inspect (a) Make execution log — should show only Modules 1 and 2 ran, (b) RCRM audit log for the company and contact — no new entries, (c) ZoomInfo usage page — no enrichment events that minute.

---

## 6. Existing-Contact Path — Stays Correct

When `POST /v1/contacts/search {"email": ...}` returns ≥1 record at Module [16]:

1. Module [19] captures the first result's slug as `contact_slug`.
2. Module [20] PATCHes (`POST /v1/contacts/{slug}`) with gap-fill only:
   - For each field, send the new value **only if** the existing RCRM value for that field is empty.
   - Phone, mobile, email, title: never overwrite if RCRM already has a value. RCRM is source of truth once Travis has touched a record.
   - `data_collection_source` (custom field 5): only write if empty.
   - Lists not touched. Stage not touched.
3. Module [21] enrolls the contact in the new sequence regardless — a contact may legitimately be in multiple sequences over time.
4. Module [22] writes a fresh note tagged "Sales Lead" (note type 213194 per CLAUDE.md) summarising the trigger.

If the contact's existing company on RCRM differs from the inbound `company_name`, no automatic re-association. The mismatch is logged in the note body so Travis can decide. Auto-reassociation is risky (could move a contact away from a company he hand-curated) and is explicitly out of scope.

This is also the path that triggers the "is_client" suppression — `buildPayload(c)` sets `decision = "decline"` when `c.is_client` is true (index.html:1304), so a contact already on the Active Client list (166186) never even reaches the approve route.

---

## 7. ZoomInfo Integration — Auth and Placement

**Decision:** ZoomInfo enrichment lives in a new Netlify function — `/.netlify/functions/zi-enrich` — invoked by the Make HTTP module at [8]. Not direct from Make. Not from the dashboard.

**Rationale:**

- Make's HTTP module needs ZoomInfo JWT auth, which requires PKI signing. PKI in Make is unstable (CLAUDE.md known issue #3 — ZoomInfo support escalation open, leaked key 2026-05-20). Putting the JWT generation in a Netlify function keeps the private key on Netlify env (server-side only), keeps the Make blueprint readable, and lets us replace the auth method later (PKI → bearer → OAuth) without touching the scenario.
- ZoomInfo MCP runs only in the web chat — cannot be invoked from a Make scenario. Discount.
- The existing `elevate-zi-bridge.zip` (signal-aggregator) — CLAUDE.md known issue #2, deployment unverified — is the closest thing we have. Reuse the same Netlify project (or extend it) with a new function endpoint. If the deploy was never done, this fix forces it.
- Direct dashboard → ZoomInfo would leak the private key into the browser. Hard no.

**Auth between Make and Netlify:** shared secret in `x-elevate-secret` header. Set `ZI_BRIDGE_SECRET` env var in both Make (custom variable on the connection) and Netlify (site env). Rotate after any leak.

**Auth between Netlify and ZoomInfo:** server-side JWT generation using the PKCS#8 private key stored in Netlify env (`ZOOMINFO_PRIVATE_KEY`). Client ID `ca97f380-d6be-42bc-a788-2b3a8454f495` per CLAUDE.md. **Blocker noted: private key was leaked 2026-05-20 — must be rotated with James Gervais before this function ships.**

**Function contract:**

```
POST /.netlify/functions/zi-enrich
Headers:
  x-elevate-secret: <shared>
  Content-Type: application/json
Body:
  { "companyId": "...", "personId": "..." }   // either or both

Response 200:
  {
    "company": {
      "name": "...", "website": "...", "industry": "...",
      "address": "...", "linkedin": "...", "about_us": "...",
      "employee_count": ..., "annual_revenue": ...,
      "funding_total": ..., "funding_stage": "..."
    },
    "credits_used": 1,
    "cache_hit": true|false
  }

Response 4xx/5xx:
  { "error": "...", "code": "..." }
  Make should treat any non-200 as "skip enrichment, proceed with what we have"
```

**Where the function code lives:** `netlify/functions/zi-enrich.js` (new file, not part of this scope — implement after blueprint changes land). For this design, the contract above is the binding spec.

**Credit efficiency:** Per SCRIBE_EXPORT.md line 79, previously enriched ZoomInfo companies do not consume credits again for one year — so a cache hit on the ZI side is free. No additional Make-side caching needed.

**Fallback when bridge is down:** Module [8] timeout = 20s. On timeout or non-200, Module [9] is skipped (the `ifempty` merges in [6] already used dashboard + queue data). Scenario proceeds. Result: RCRM record may have fewer fields than ideal, but the approval does not fail.

---

## 8. Test Plan

Pre-deploy (no live approvals):

1. Paste the current scenario 4667221 blueprint into this doc as Section 1.5 (literal diff section). Hand-verify the proposed topology aligns with what's there. Resolve any unresolved field-name questions in Sections 3, 4 from the existing modules.
2. Confirm `ZI_BRIDGE_SECRET` and `ZOOMINFO_PRIVATE_KEY` (rotated) are set in Netlify env. Confirm `ZI_BRIDGE_SECRET` is set as a Make custom variable.
3. Confirm the `netlify/functions/zi-enrich.js` function is deployed and returns 200 on a hand-curl with a known `companyId`.

Post-deploy with a dedicated test contact (do NOT use a live BD lead):

4. **Decline test.** Create a dummy queue row with `key = test-decline-001`, partially populated. From dashboard, click Decline + Submit Individually. Verify:
   - Make execution log: only Modules 1 and 2 ran. Total modules in execution = 2.
   - RCRM: search for `test-decline-001@example.com` → 0 results. Search for the dummy company name → 0 results.
   - ZoomInfo usage dashboard: no enrichment events at the timestamp.
   - Queue datastore: row shows `decision = "decline"`, `decided_at` populated.

5. **New-company-new-contact test.** Create a dummy queue row with a contact email that does not exist in RCRM and a company website that does not exist in RCRM. Populate the queue with ALL fields (no empties — bypasses enrichment). From dashboard, approve. Verify:
   - Make execution log: company search returned 0, contact search returned 0, both creates ran exactly once each.
   - RCRM company record: every field populated in ONE create event (check audit log shows one "company created" entry, zero "company updated" entries).
   - RCRM contact record: every field populated in ONE create event.
   - Sequence enrollment confirmed.
   - Note attached, type 213194.
   - Queue row shows `status = "submitted"`, both slugs captured.

6. **New-company-new-contact-with-enrichment test.** Same as test 5 but with `company_website`, `company_address`, `company_linkedin`, `annual_revenue` cleared in the queue row. Populate `zoominfo_company_id`. Approve. Verify:
   - Bridge call ran (HTTP 200).
   - Final RCRM company record has the enriched fields populated.
   - Total create event count on RCRM still = 1 per record.

7. **Existing-company-new-contact test.** Use a real RCRM company slug; create a dummy contact in the queue with that company's name and website. Approve. Verify:
   - Company search returned 1 (existing slug found).
   - No company create event in RCRM.
   - Company gap-fill update fired only if the existing record had empty fields.
   - Contact created with `company_slug` matching the existing company.

8. **Existing-contact test.** Use a real RCRM contact's email. Approve. Verify:
   - Contact search returned 1.
   - No contact create event.
   - Gap-fill update did not overwrite any populated field on the existing contact (manually compare before/after).
   - Sequence enrollment ran (contact joined the new sequence even though existing).

9. **Rate-limit test.** Bulk-approve 15 cards from the queue at once. Watch Make execution log for any 429 responses from RCRM. If observed, raise the inter-iteration Sleep duration.

10. **Lists guard.** After every test above, query RCRM lists 166186 and 198202. Their membership must be unchanged from before each test. If any test added a row to either list, the scenario has a bug — halt rollout.

Each test produces a one-line pass/fail entry in SESSION_HANDOFF.md. Only flip from staging to production approvals after all ten pass.

---

## 9. Open Items Before This Can Ship

1. **Blueprint paste required** — current state of scenario 4667221 modules so the literal diff in Section 1.5 can be written and Section 3/4 field names finalised.
2. **ZoomInfo private key rotation** — leaked 2026-05-20, blocks Netlify function deploy.
3. **`netlify/functions/zi-enrich.js` implementation** — out of scope for this design doc; build after key rotation.
4. **RCRM company-search endpoint exact path/body shape** — CLAUDE.md documents `POST /v1/contacts/search`; equivalent company endpoint is assumed (`POST /v1/companies/search`) but should be confirmed against the RCRM API Endpoints reference in the web chat before scenario edits land.
5. **Custom field shape on RCRM create** — assumed `custom_fields: [{field_id, value}]`; confirm against existing module bodies.

When 1, 4, and 5 are resolved, this doc upgrades from design to applied-change record.
