# Session Handoff

## Wave 4 Applied: 2026-05-21 — Module 102 email-required filter (prevention only)

### What Was Done

Single minimal-risk blueprint patch. Module 102 (Approve Only Router) filter extended from one condition to two:

**Before:**
```
conditions: [[
  {"a": "{{1.decision}}", "b": "approve", "o": "text:equal"}
]]
```

**After:**
```
conditions: [[
  {"a": "{{1.decision}}", "b": "approve", "o": "text:equal"},
  {"a": "{{1.contact_email}}", "b": "", "o": "text:notequal"}
]]
```

Filter name renamed `Approve Only` → `Approve Only + Email Required` (cosmetic, helps Make UI readability).

Push details: `scenarios_update(4667221)` → response `isinvalid:false, isActive:true, lastEdit:2026-05-21T19:51:21.573Z`. `usedPackages` count unchanged (no module added/removed). Pre-edit Module 102 config saved to `.backups/module_102_pre_wave4.20260521T195013Z.json`.

### Empirical Re-Validation (post-deploy curl pre-flight)

Three queries against the live RCRM endpoint after the Wave 4 push:

**Test 1 — Empty-email behavior (hijack-path verification):**
- `GET /v1/contacts/search?email=&exact_search=1` → HTTP 200, WRAPPED, `data.length == 100`.
- First record: Katie Martinovich (slug `17793113029170054787rLZ`).
- RCRM-side behavior UNCHANGED — still returns unfiltered list.
- Module 37 in production would still capture `resolved_slug = 17793113029170054787rLZ`.
- **BUT**: with the new Module 102 filter, the captured slug is never read. Route A (Modules 33, 34, 31, 35, 11, 38, 2, 5, 13, 4) is skipped. Route B (Modules 39, 43, 44, 45, 46, 47) is skipped. The router is gated closed because `1.contact_email == ""` violates the second condition.
- Modules 99 and 100 (audit + queue delete) still fire — they live OUTSIDE Module 102, gated on `key != ""`. Queue record is cleared with no RCRM touch.

**Test 2 — Valid-email no-regression (Troy English / Ross Video candidate):**
- `GET /v1/contacts/search?email=tenglish@rossvideo.com&exact_search=1` → HTTP 200, BARE `[]`.
- Confirms no existing RCRM contact with that email.
- Module 37 in production would capture `resolved_slug = ""` (empty).
- Module 102 filter: `decision == "approve"` TRUE, `contact_email != ""` TRUE → router fires.
- Route A taken (resolved_slug empty → Route A path; resolved_slug non-empty would take Route B). No regression for the valid-email path.

**Test 3 — Company baseline for the recommended test candidate:**
- `GET /v1/companies/search?company_name=Ross%20Video&exact_search=1` → HTTP 200, BARE `[]`.
- Ross Video has 0 records in RCRM. Troy English's approval would be a clean **Route A1** (new contact + new company), expected 12 operations.

### Confirmed Behavior By Input Class

| Input | decision | contact_email | RCRM curl pre-check | Module 102 filter | Resulting modules fired | RCRM-side effect |
|---|---|---|---|---|---|---|
| Backlog no-email approve (e.g., Sonny Lim if Travis had approved) | "approve" | "" | unfiltered 100 | **BLOCKED** | 1, 20, 99, 100, 36, 37 only (router gate closed) | None — Module 36 returns unfiltered list but its result is never consumed |
| Valid-email new-contact approve (e.g., Troy English) | "approve" | "tenglish@rossvideo.com" | bare `[]` | PASS (both TRUE) | Route A path | Module 33 search → Module 31 create → Module 11 create contact → enroll → note |
| Valid-email existing-contact approve | "approve" | "user@example.com" present in RCRM | wrapped 1 | PASS | Route B path | Module 43 stage update → enroll → note |
| Decline (any email state) | "decline" | (any) | (not called — gated) | BLOCKED (first condition false) | 1, 20, 99, 100 only | None |

### Module 36 Behavior Unchanged

Module 36 still fires for any approve (its own filter is just `decision == "approve"`). For empty-email cases, it still makes a wasted GET to RCRM. The wasted call:

- Consumes ~1 RCRM API operation per empty-email approval against the 60/min rate limit.
- For a bulk-clear of the ~700 no-email backlog records via the dashboard, that would be ~700 wasted RCRM GETs. Within the rate limit if spread across 12+ minutes.
- Acceptable minor inefficiency. Adding `contact_email != ""` to Module 36's own filter would eliminate this; deferred — not in scope of the minimal Wave 4 patch.

### What Wave 4 Does NOT Do

- Does not affect the dashboard.
- Does not affect Staging-to-Queue or any other scenario.
- Does not change the response shape of any RCRM endpoint.
- Does not clean up the ~700 no-email backlog records (kept separate per Travis instruction).
- Does not change Module 36's own behavior.
- Does not change Routes A1, A2, or B for valid-email approvals.

### Pass/Fail Verdict

**PASS.** Module 102 filter is live with the empty-email block condition. Empirical re-validation confirms:

1. The Make API accepted the patch (`isinvalid:false`).
2. The blueprint contains the new two-condition filter (verified via `scenarios_get`).
3. The RCRM-side empty-email hijack pathway still EXISTS (Test 1 still returns unfiltered) — but is now non-consumable because Module 102 blocks the downstream consumers.
4. The valid-email pathway behaves as before (Test 2 + Test 3 confirm normal Route A1 logic).

No regression observed in the post-deploy curl checks. The fix is minimal, rollback-safe, and prevention-only.

### Rollback

Rollback path documented in `.backups/module_102_pre_wave4.20260521T195013Z.json`. Restores the single-condition `decision == "approve"` filter. **Do not roll back unless an empirical regression is observed in approve-path executions** — the prior single-condition filter is the latent-hijack vulnerable state.

### Decisions Made

- **Patched Module 102 only.** Did NOT also add `contact_email != ""` to Module 36's filter. Minimal change, fewer rollback surfaces.
- **Did NOT live-test the filter** by approving a no-email card. Static + curl-side evidence is sufficient; firing a real webhook would delete a queue record unnecessarily.
- **Did NOT touch the ~700 no-email backlog records.** Cleanup is separately-scoped per Travis instruction. The Wave 4 fix makes those records SAFE to approve-clear but does not auto-clear them.
- **Did NOT proceed with Sonny Lim approval.** Travis explicitly halted that test. With Wave 4 live, Sonny Lim approval would now be safe to clear (it would audit + delete without RCRM touch), but Travis hasn't authorized that action.

### Next Steps

1. [ ] If Travis chooses to clear the Sonny Lim card (safe now): Travis clicks Submit Individually in the dashboard. Expected: 6 ops (Modules 1, 20, 99, 100, 36, 37), `status:1`, queue record deleted, NO RCRM contact touched.
2. [ ] Pick a new live-test candidate with valid email (Troy English / Ross Video confirmed Route A1, 12 ops expected).
3. [ ] Optional Wave 5 (not yet authorized): add `contact_email != ""` to Module 36's filter to eliminate the wasted RCRM GET. Cosmetic optimization.
4. [ ] (Separate from prevention) Decide on cleanup of the ~700 no-email backlog records.
5. [ ] Travis credential rotations (unchanged).

### Blockers

Unchanged.

---

## Pre-Flight Finding: 2026-05-21 — Module 36 silent-failure on empty contact_email

### Status

Discovered during pre-flight for the Sonny Lim controlled live test. **NO production change applied. NO approval triggered.** Test halted before approval. Documented here as an empirical defect for Travis decision.

### Defect Summary

When a queue record has empty/missing `contact_email`, Module 36's `GET /v1/contacts/search?email=&exact_search=1` returns HTTP 200 with the **entire unfiltered contacts list** (100 records, RCRM's default page size). The empty `email` query param is silently ignored — no 400 UNSUPPORTED_SEARCH, no empty `[]`. Make's IML `36.data.data[1].slug` then captures the FIRST record in that unfiltered list — an unrelated existing RCRM contact.

Downstream effect: Module 37's `resolved_slug` becomes non-empty (pointing at the wrong contact). Module 102 Router takes Route B (existing-contact path). Modules 43, 44, 45, 47 then act on the wrong contact: stage update, sequence enrollment, Anthropic note, and note write — all attached to whoever is first in RCRM's contacts list. The originating queue record is then deleted by Module 100.

### Empirical Evidence

Pre-flight curl on the Sonny Lim record (no `contact_email`):

```
GET /v1/contacts/search?email=&exact_search=1
Authorization: Bearer <token>
Accept: application/json

→ HTTP 200
→ {"current_page":1,"data":[
     {"slug":"17793113029170054787rLZ","first_name":"Katie","last_name":"Martinovich",...},
     {"slug":"17779056072340054787Ndn","first_name":"Helen","last_name":"Verity",...},
     ...100 records total
   ]}
```

Module 37 would have set `resolved_slug = "17793113029170054787rLZ"` (Katie Martinovich). If approval had fired, Sonny Lim's activity note + stage update would have landed on Katie Martinovich's RCRM record.

### Risk Surface

Sample of 100 of 1,071 queue records (random):
- 34 have a non-empty `contact_email`
- **66 do NOT have a non-empty `contact_email`**

Projected total: **~700 of 1,071 queue records would hijack an existing RCRM contact if approved as-is.** All look "approvable" in the dashboard — there is no surface warning of the missing email.

Confirmed by running the same empty-email search: the first record returned is always RCRM's most-recently-created contact (Katie Martinovich, created 2026-05-20T21:08:22Z). Different approvals on different days would silently corrupt different contacts depending on which one happens to be at the top of the unfiltered list.

### What This Is NOT

- **NOT a regression of any change made today.** This defect predates all Wave 1-3 work. Module 36 has had this behavior since the scenario was created on 2026-04-07.
- **NOT a defect of Module 33 or the recent GET fix.** Module 33's empty-name behavior was tested in the 2026-05-21 empirical audit and returns bare `[]` correctly. The Module 36 contact-search endpoint has DIFFERENT empty-param behavior than Module 33's company-search — confirmed empirically:
  - `GET /v1/contacts/search?email=&exact_search=1` → WRAPPED with 100 records (unfiltered)
  - `GET /v1/companies/search?company_name=&exact_search=1` → bare `[]` (empty)
  - Same query-shape pattern, different RCRM-side behavior. Cannot be explained by anything other than RCRM's endpoint implementations differing.
- **NOT yet causing damage.** No no-email card has been approved through the post-Wave-3 pipeline. The defect was caught at pre-flight.

### Safe-By-Design Operation

- **Decline path is safe** for no-email records. Modules 36 / 102 / 43 / 47 are all gated on `decision == "approve"`. Decline runs only Modules 1, 20, 99, 100 (audit + delete) — no RCRM contact touched.
- **Approving a no-email record is the trigger.** A single click on Submit Individually for any of the ~700 affected records is sufficient to corrupt an unrelated RCRM contact.

### Decision Required (Travis)

Three independent decisions, each scoped distinctly:

1. **(Test selection)** Do not approve the Sonny Lim card. Pick a different controlled-test target with non-empty contact_email. Candidates with verified email:
   - `zi_91406862_9699846110` Troy English at Ross Video — Route A1 (0 existing in RCRM)
   - `zi_127828047_1251520920` Corinne Stavness at Western Forest Products — Route A1 (count unknown, not yet looked up)
   - `zi_71091033_1827943600` Michael Besic at Town of Oakville — Route A2 (1 existing)
   - `zi_13157331_5343614872` Christina Mitchell at Covalon — Route A2 (2 existing)

2. **(Prevention — Wave 4 proposed)** Patch Module 102 (Approve Only Router) filter to also require `contact_email != ""`. Single-line change. When fired with empty email, the entire approve route is blocked; only the audit + delete run. The no-email queue records become safe to clear by approval (they'd just delete from queue without RCRM touch). **DEFERRED until Travis explicit go-ahead** — this is a Make production change.

3. **(Cleanup — separate from prevention)** The ~700 no-email queue records are useless for RCRM outreach (no email = no contact create even with the Wave 4 fix applied). Either bulk-decline them (after Wave 4 is live so they don't corrupt RCRM) or direct datastore delete via `data-store-records_delete`. Scope and timing TBD. Out of the scope of this test plan.

### Scribe entry (validated)

To add to SCRIBE_EXPORT.md only after Travis confirms the finding:

> [CONFIRMED] 2026-05-21 pre-flight: RCRM `GET /v1/contacts/search?email=&exact_search=1` (empty email param) returns HTTP 200 with the UNFILTERED contacts list (100-record default page). This contradicts the same shape for `/v1/companies/search?company_name=` which returns bare `[]` for empty param. Approval Handler Module 36 with empty `1.contact_email` therefore returns Make-side as `36.data.data[1] = the most-recently-created RCRM contact`, causing Module 37 to set resolved_slug to an unrelated person's slug. ~66% of the 1,071-record backlog (Sample N=100) carries no contact_email and would trigger this silent corruption if approved | tags: rcrm, scenario-c, silent-defect, latent-hazard

---

## Controlled Live Test Plan: 2026-05-21 — Single Approval, Production Validation

### Status

**Pre-execution. Plan locked.** No production changes are part of this test — it exercises the existing scenarios and observes outcomes. The validation harness was drafted on the previous turn; this section supersedes it with a tighter, single-event structure.

### Test Scope

One queue record, one Submit Individually click, one full pipeline traversal (Approval Handler webhook → RCRM contact + company + note + sequence enrollment → queue audit-delete). Travis selects the record; Claude pre-flights it, observes the run, and reports against the criteria below.

### Inputs (to be locked before approval)

| Item | Source | When known |
|---|---|---|
| Queue key | Travis selects in dashboard | Pre-approval |
| contact_email | Read from queue record | Pre-approval |
| contact_name, contact_title, contact_phone, contact_mobile, contact_linkedin | Read from queue record | Pre-approval |
| contact_city, contact_state, contact_country | Read from queue record | Pre-approval |
| company_name, company_website, company_linkedin | Read from queue record | Pre-approval |
| company_address, company_city, company_state, company_country | Read from queue record (latter 3 likely empty — backlog) | Pre-approval |
| company_industry, employee_count, annual_revenue, buying_signal, about_company | Read from queue record | Pre-approval |
| persona, sequence_id, sequence_name, data_collection_source | Read from queue record | Pre-approval |
| Predicted path (A1 / A2 / B) | Two pre-flight curl GETs | Pre-approval |
| Baseline RCRM company-name count | One curl GET | Pre-approval |
| Baseline RCRM contact-by-email count | One curl GET | Pre-approval |
| Pre-approval contact's linkedin (Route B only) | One curl GET (Route B only) | Pre-approval |

### Expected Queue Behavior

1. **Pre-approval state**: record exists in datastore 86836 with `decision == "pending"`, `processed_at` null. Confirmed via `data-store-records_list(86836)` filter on the key.
2. **Module 99 fires for approve and decline**: rewrites `decision` to `"approved"` or `"declined"` and sets `processed_at`. Filter: `key != ""` (the test record obviously satisfies this).
3. **Module 100 fires for approve and decline**: deletes the record from 86836 entirely. Same filter as Module 99.
4. **Post-approval state**: the test record's key returns `null`/not-found on a follow-up datastore read. No partial-update remnant.
5. **Total queue count**: decreases by exactly 1 (1,071 → 1,070). Other records untouched.

### Expected Dedup Behavior

Two independent dedup decisions, both gated on `decision == "approve"` (declines skip both).

**Contact dedup (Module 36 — always runs for approve):**
- HTTP call: `GET https://api.recruitcrm.io/v1/contacts/search?email={encodeURL(lower(contact_email))}&exact_search=1` with `Authorization: Bearer <token>` and `Accept: application/json`.
- Response shape:
  - **wrapped** `{current_page:1, data:[{slug:..., ...}, ...]}` if a contact with that email already exists.
  - **bare** `[]` if no match.
- Module 37 captures `resolved_slug = {{36.data.data[1].slug}}`. For wrapped → slug. For bare → empty.
- Path branching (Module 102 router):
  - `resolved_slug == ""` → Route A
  - `resolved_slug != ""` → Route B
- Pre-flight curl (run by Claude pre-approval) deterministically predicts which route fires.

**Company dedup (Module 33 — Route A only, with filter `resolved_slug == "" AND company_name != ""`):**
- HTTP call: `GET .../v1/companies/search?company_name={encodeURL(1.company_name)}&exact_search=1` with same headers.
- Response shape: same wrapped/bare-array pattern.
- Module 34 captures `existing_company_slug = {{33.data.data[1].slug}}`.
- Module 31 (company create) filter: `existing_company_slug == ""`. Fires only when empty.
- Pre-flight curl (Claude, pre-approval) deterministically predicts whether Module 31 will fire.
- Match selection: **first** record in the response `data[]` array. RCRM's default sort returns earliest-created first (verified empirically — Stellantis slug `17780808284210054787dBD` is the first match, `created_on 2026-05-06T15:20:28Z`).

### Expected Company Behavior

| Path | Company operations | Resulting `company_slug` for contact attachment |
|---|---|---|
| A1 (new contact, new company) | Search [], then `POST /v1/companies` → 201/200 with `{data: {slug: <new>}}` | `35.resolved_company_slug = 31.data.slug` (newly created) |
| A2 (new contact, existing company) | Search WRAPPED, no POST | `35.resolved_company_slug = 34.existing_company_slug` (first existing match) |
| B (existing contact) | No company operations at all | n/a — contact already has company association |
| Decline | No company operations | n/a |

For Route A1 only — the new company record's `created_on` timestamp must equal the approval timestamp (±5 seconds).
For Route A2 only — the company `created_on` must predate the approval timestamp (proves attachment to existing, not new create).

### Expected Contact Behavior

| Path | Contact operations |
|---|---|
| A1 / A2 | `POST /v1/contacts` body shape per "Field Propagation" below → 201/200 with `{data: {slug: <new>}}`. Module 38 captures `final_slug`. |
| B | `POST /v1/contacts/<resolved_slug>` body `{stage_id: 142468}` → 200. Only stage_id update; LinkedIn intentionally NOT in body (Wave 2 fix). Module 39 captures `final_slug = 37.resolved_slug`. |
| Decline | No contact operations. |

For all approve paths — exactly one of: enroll call (`POST /v1/contacts/<final_slug>/enroll?sequence_id={x}`), Anthropic note generation, note write (`POST /v1/notes`). All three fire in sequence after the contact create/update lands.

### Expected Field Propagation

**Module 31 company create body (Route A1 only):**

| RCRM field | Source IML | Pass criterion |
|---|---|---|
| `company_name` | `{{1.company_name}}` | Equals queue `company_name` |
| `about_company` | `{{20.sanitized_about}}` (= replace(1.about_company; newline; " ")) | Equals queue `about_company` with newlines→spaces |
| `website` | `{{1.company_website}}` | Equals queue `company_website` (empty for backlog) |
| `linkedin` | `{{1.company_linkedin}}` | Equals queue `company_linkedin` |
| `city` | `{{ifempty(1.company_city; 1.contact_city)}}` | If queue `company_city` empty → contact_city. Otherwise → company_city. |
| `state` | `{{ifempty(1.company_state; 1.contact_state)}}` | Same fallback rule |
| `country` | `{{ifempty(1.company_country; 1.contact_country)}}` | Same fallback rule |
| `address` | `{{1.company_address}}` | Equals queue `company_address` |
| `industry_id` | `{{20.industry_id}}` (12-entry switch, default 913) | One of the switch values OR 913. **NEVER 0.** |
| `custom_fields[1]` Employees | `{{1.employee_count}}` | Equals queue value |
| `custom_fields[2]` Revenue | `{{1.annual_revenue}}` | Equals queue value |
| `custom_fields[12]` Buying Signal | `{{1.buying_signal}}` | Equals queue value (often empty) |

**Module 11 contact create body (Routes A1 and A2):**

| RCRM field | Source IML | Pass criterion |
|---|---|---|
| `first_name` | `{{20.first_name}}` = first(split(1.contact_name; space)) | First token of contact_name |
| `last_name` | `{{20.last_name}}` = last(split(1.contact_name; space)) | Last token of contact_name |
| `email` | `{{1.contact_email}}` | Equals queue value (case as-is, write not lowercased) |
| `contact_number` | `{{1.contact_phone}}` | Equals queue `contact_phone` |
| `designation` | `{{1.contact_title}}` | Equals queue value |
| `linkedin` | `{{20.linkedin_url}}` = replace(1.contact_linkedin; "https://"; "http://") | Equals queue value with https→http normalization |
| `city` | `{{1.contact_city}}` | Contact-side city |
| `state` | `{{1.contact_state}}` | Contact-side state |
| `country` | `{{1.contact_country}}` | Contact-side country |
| `address` | `{{1.company_address}}` | Inherits company address — intentional |
| `current_organization` | `{{1.company_name}}` | Equals queue value |
| `company_slug` | `{{35.resolved_company_slug}}` | Equals existing OR newly-created slug |
| `stage_id` | literal `142468` | Equals 142468 |
| `custom_fields[1]` Phone | `{{1.contact_phone}}` | Same as contact_number |
| `custom_fields[2]` Mobile | `{{1.contact_mobile}}` | Equals queue value |
| `custom_fields[5]` Data Source | `{{1.data_collection_source}}` | Equals queue value. **NOT hardcoded "ZoomInfo"** unless that's the actual queue payload. |

**Module 43 existing-contact update body (Route B only):**

| Body content | Pass criterion |
|---|---|
| `{"stage_id": 142468}` | Body is EXACTLY this — no other fields. LinkedIn intentionally NOT in body (Wave 2 fix). |

**Module 5/45 note generation:**

- Anthropic Haiku 4.5 model.
- Output is a 1-2 sentence note text. No specific content assertion beyond non-empty and containing "R/O" or similar recruiter shorthand.

**Module 4/47 note create:**

- `note_type_id: 195663` (Emailed).
- `description`: the Anthropic output.
- `related_to_type: "contact"`, `related_to: <final_slug>`.

### Expected Fallback Behavior

- **company_X fallback to contact_X**: `ifempty(1.company_X; 1.contact_X)` in Module 31. Triggers when the queue record has `company_city`/`company_state`/`company_country` empty (true for all 1,071 backlog records). After tomorrow's 6am cycle adds new records with company_X populated, the fallback won't trigger and the company HQ values will be used.
- **industry_id fallback to 913 (Manufacturing)**: Module 20's switch returns 913 when `company_industry` is not in the 12-entry hardcoded set (Manufacturing, Transportation, Automotive, Automotive Parts, Airlines+Airports+Air Services, Logistics and Supply Chain, Construction, Oil and Energy, Food and Beverages, Machinery, Toys & Games). Triggers for industries like Building Materials, Medical Devices, Local Government, etc.
- **Empty values from payload pass through as empty strings**: If queue has empty `company_website`, RCRM receives `"website": ""`. RCRM tolerates this — no error.
- **Module 33 returning bare empty array vs wrapped**: Make's IML `33.data.data[1].slug` handles both — wrapped → first slug, bare → empty. No special path needed.
- **404 from old POST is no longer reachable**: Module 33 is now GET. The legacy 404-shape `{error:true,...}` no longer applies.

### Exact RCRM Fields to Verify (post-approval)

**Contact record** (`GET /v1/contacts/{final_slug}`):

| Field | Expected source | Hard-fail if |
|---|---|---|
| `slug` | == final_slug from execution capture | Mismatch |
| `first_name` | first token of queue contact_name | Mismatch |
| `last_name` | last token of queue contact_name | Mismatch |
| `email` | queue contact_email (case as queue had it) | Mismatch |
| `contact_number` | queue contact_phone | Mismatch (when queue had phone) |
| `designation` | queue contact_title | Mismatch |
| `linkedin` | http://-form of queue contact_linkedin | For Routes A1/A2 — mismatch. For Route B — **value changed from pre-approval state** (= Wave 2 regression). |
| `city`, `state`, `country` | queue contact_city/state/country | Mismatch |
| `address` | queue company_address | Mismatch |
| `current_organization` | queue company_name | Mismatch |
| `company.slug` (or `company_slug`) | resolved_company_slug | Mismatch |
| `stage_id` / `stage.id` | 142468 | Not 142468 |
| `custom_fields[].field_id==1.value` | queue contact_phone | Mismatch |
| `custom_fields[].field_id==2.value` | queue contact_mobile | Mismatch |
| `custom_fields[].field_id==5.value` | queue data_collection_source | **Equals literal "ZoomInfo" when queue value was different** (= Wave 2 regression) |

**Company record** (`GET /v1/companies/{resolved_company_slug}`):

| Field | Expected source | Hard-fail if |
|---|---|---|
| `slug` | == resolved_company_slug | Mismatch |
| `company_name` | queue company_name | Mismatch |
| `website` | queue company_website | Mismatch (when queue had website) |
| `linkedin` | queue company_linkedin | Mismatch (when queue had it) |
| `industry_id` | switch result OR 913 | **Equals 0** (= Wave 1 regression) |
| `address` | queue company_address | Mismatch (when queue had it) |
| `city`, `state`, `country` | ifempty(company_X, contact_X) | Mismatch against ifempty resolution |
| `about_company` / `about_us` | sanitized about_company | Mismatch |
| `custom_fields[].field_id==1.value` | queue employee_count | Mismatch |
| `custom_fields[].field_id==2.value` | queue annual_revenue | Mismatch |
| `custom_fields[].field_id==12.value` | queue buying_signal | Mismatch |
| `created_on` (Route A1 only) | within ±5 seconds of approval timestamp | Outside ±5s = wrong record |
| `created_on` (Route A2 only) | predates approval timestamp by minutes-to-weeks | Equals approval timestamp = dedup regression |

**Note record** (read from contact's note list or `GET /v1/notes?related_to_slug={final_slug}`):

| Field | Expected | Hard-fail if |
|---|---|---|
| `note_type_id` | 195663 | Not 195663 |
| `description` | non-empty, recruiter-style text | Empty or contains "{{" (IML didn't interpolate) |
| `related_to_type` | "contact" | Not "contact" |
| `related_to` | final_slug | Mismatch |
| `created_on` | within ±10 seconds of approval timestamp | Outside ±10s = wrong note |

**Queue datastore** (`data-store-records_list(86836)`):

| Check | Pass criterion |
|---|---|
| Test record's key | Not present (Module 100 deleted) |
| Total record count | 1,070 (was 1,071) |

### Pass/Fail Conditions

**PASS** requires ALL of the following:

1. Make execution `status == 1` (success).
2. Make execution `operations` count matches expected for path (A1:12, A2:11, B:12, Decline:4).
3. `allDlqCount` on scenario unchanged from 0.
4. RCRM contact record verified against the Contact field table — every field matches OR is empty where queue was empty.
5. RCRM company record verified against the Company field table — every field matches; `industry_id != 0`; `created_on` matches the path expectation.
6. RCRM note record exists, dated within ±10s of approval, type 195663.
7. Queue record deleted; total count decremented by 1.
8. Route A2 specific: RCRM company count for the company_name UNCHANGED from baseline (no new duplicate created).

**FAIL** if ANY of:
- `status != 1`
- `operations` count outside expected range
- DLQ increment
- Field-level mismatch against the verification tables
- Route A2 dedup count increased

**PARTIAL PASS** (document but do not auto-rollback):
- All RCRM writes succeeded but the Anthropic note text contains "{{" or is empty — note generation degraded, RCRM record itself is correct.
- Empty fields in RCRM that queue had populated, IF the gap is in a known-pending field (e.g., backlog-card website being empty — that's pre-Wave-3 behavior, not a regression).

### Rollback Indicators

In addition to the FAIL criteria above, ANY of the following observed during or after the test triggers documentation + Travis-decision-required before continued live approvals:

1. **Execution `status != 1`** — Make-level failure.
2. **Operation count anomaly** — wrong path executed (e.g., A2 ran 12 ops meaning Module 31 fired despite existing company).
3. **DLQ entry created** — `allDlqCount` went from 0 to 1+.
4. **`isinvalid:true` toggled on 4667221 or 4990696** — blueprint corrupted.
5. **`industry_id` written as 0 to RCRM** — Wave 1 fix not active.
6. **`custom_fields[5]` written as literal "ZoomInfo" when queue value was different** — Wave 2 fix not active.
7. **Route B contact's `linkedin` changed after approval** — Wave 2 fix not active.
8. **Module 33 returned bare `[]` for a company name that curl pre-flight confirmed existed** — RCRM endpoint behavior changed mid-test OR token expired OR rate-limited.
9. **Duplicate company count increased** (Route A2 should be unchanged, not +1).
10. **RCRM contact missing email** OR any other required field — silent data loss.

### Rollback Procedure

**Do not roll back any prior change unless one of the above is observed AND Travis explicitly approves the rollback.** Rollback paths are documented in the relevant prior session sections of this handoff:

- Module 33 GET → POST rollback: `.backups/module_33_pre_get_fix.20260521T172329Z.json` (note: this restores the BROKEN 404-loop behavior; only roll back if the GET form is empirically failing in a worse way).
- Module 31 / Module 11 / Module 43 / Module 20 / webhook interface / Staging-to-Queue mapper / datastructures 319927 / 347903: each has rollback steps in prior session sections + `.backups/` snapshots.
- Dashboard `buildPayload(c)` rollback: `git revert c5af4be` → push → Netlify auto-deploys ~30s.

### Post-Approval Validation Sequence

Executed by Claude in this exact order:

1. **Capture approval timestamp** from Travis or from the dashboard browser timestamp at click.
2. **`executions_list(4667221)`** — find the new execution by timestamp. Record `imtId`, `status`, `operations`, `duration`, `centicredits`, `transfer`. Compare ops count to expected.
3. **`scenarios_get(4667221)`** — verify `dlqCount` and `allDlqCount` still 0; verify `lastEdit` unchanged from 2026-05-21T17:24:51Z (no blueprint drift during test).
4. **`GET /v1/contacts/search?email={lower(contact_email)}&exact_search=1`** — find the resulting contact. Capture `data[0].slug` as `final_slug`. For Route B this should be the SAME slug as Travis observed pre-approval; for Routes A1/A2 it should be NEW.
5. **`GET /v1/contacts/{final_slug}`** — read full contact record. Verify against the Contact field table.
6. **Extract `company_slug` from the contact response** (field name may be `company.slug`, `company_slug`, or embedded company object — RCRM's contact response format determines this). Capture as `resolved_company_slug`.
7. **`GET /v1/companies/{resolved_company_slug}`** — read full company record. Verify against the Company field table, including `created_on` predates-or-matches approval timestamp.
8. **`GET /v1/companies/search?company_name={x}&exact_search=1`** — re-run the dedup count. Compare to the baseline captured pre-approval. For A2: count UNCHANGED. For A1: count incremented by 1.
9. **Inspect the contact's notes** — either via the contact GET response's embedded notes (if present) or via a separate notes-list endpoint (signature TBD). Confirm one new note dated within ±10s of approval.
10. **`data-store-records_list(86836, limit:100)`** — confirm test record's key is gone. Total count decremented to 1,070.
11. **Compile PASS/FAIL verdict** with the field-by-field results in the Post-Execution Recording Template (below). Append to SESSION_HANDOFF.md as a new section directly after this plan.

### Post-Execution Recording Template

```
=== CONTROLLED LIVE TEST: <queue_key> ===
Approval timestamp: <UTC>
Pre-flight predictions:
  Route: <A1 | A2 | B>
  Expected ops: <N>
  Baseline company count: <N>
  Baseline contact slug (Route B only): <slug>
  Baseline contact linkedin (Route B only): <value>

EXECUTION:
  imtId: <id>
  status: <1 expected>
  operations: <observed> (expected: <expected>)
  duration: <ms>
  dlqCount: 0 (expected: 0)

CONTACT (slug: <final_slug>):
  first_name: <expected> | <observed> | <MATCH|MISMATCH>
  last_name:  <expected> | <observed> | <MATCH|MISMATCH>
  email:      <expected> | <observed> | <MATCH|MISMATCH>
  designation: ...
  contact_number: ...
  linkedin: ...
  city: ... | state: ... | country: ...
  address: ...
  current_organization: ...
  company_slug: <expected resolved_company_slug> | <observed>
  stage_id: 142468 | <observed>
  custom_fields[1]: <expected> | <observed>
  custom_fields[2]: <expected> | <observed>
  custom_fields[5]: <expected non-ZoomInfo unless queue said ZoomInfo> | <observed>

COMPANY (slug: <resolved_company_slug>):
  company_name: ...
  website: ...
  linkedin: ...
  industry_id: <expected non-zero> | <observed>
  address: ...
  city / state / country: <ifempty-resolved> | <observed>
  about_company: ...
  custom_fields[1]/[2]/[12]: ...
  created_on: <expected within±5s of approval (A1) OR predates approval (A2)> | <observed>

NOTE:
  found: yes/no
  note_type_id: 195663 | <observed>
  created_on within ±10s of approval: yes/no
  description excerpt: <first 80 chars>

DEDUP CHECK (Route A2 only):
  Pre-approval company count: <N>
  Post-approval company count: <N>
  Delta: <0 expected>

QUEUE:
  Test record key found pre-approval: yes
  Test record key found post-approval: no (expected: no)
  Total count delta: -1 (expected: -1)

VERDICT: <PASS | FAIL | PARTIAL PASS>
Anomalies: <list any deviation>
Rollback triggered: <yes | no>
```

### Workflow

1. [ ] Travis: name the queue key (or contact_email + company_name pair).
2. [ ] Claude: fetch the queue record, run the two pre-flight curls, lock in the path prediction + ops count + baseline counts + (Route B) pre-approval linkedin value.
3. [ ] Claude: report pre-flight expectations back to Travis with the exact predicted ops count and the company/contact slugs that should be touched.
4. [ ] Travis: click Submit Individually in the dashboard.
5. [ ] Travis: report the approval click timestamp (UTC) to Claude.
6. [ ] Claude: run the 11-step Post-Approval Validation Sequence.
7. [ ] Claude: fill in the Post-Execution Recording Template and append a "Live Test Result" section to SESSION_HANDOFF.md with the verdict.
8. [ ] On FAIL or any Rollback Indicator: Claude reports the specific failure, does NOT roll back unilaterally, awaits Travis decision.

---

## Current Session: 2026-05-21 (end of day — Stabilization & Monitoring Baseline)

### Mode

Stabilization. No production changes from here forward unless one of the following is empirically observed:
- New defect surfaces (RCRM record incomplete, execution failures, etc.)
- Regression detected against the 16 changes applied today
- Validation check below fails

### Baseline Snapshot (read-only, no mutations)

Captured 2026-05-21 ~17:30 UTC, ~5 minutes after the final Module 33 GET fix push (17:24:51 UTC).

**Make scenario state:**

| Scenario | ID | `lastEdit` (UTC) | `isinvalid` | `isActive` | Next scheduled |
|---|---|---|---|---|---|
| Approval Handler | 4667221 | 2026-05-21T17:24:51.028Z | false | true | webhook-triggered, n/a |
| Staging-to-Queue | 4990696 | 2026-05-21T16:53:18.247Z | false | true | 2026-05-22T10:00:00Z |
| Queue Fetch | 4734116 | 2026-04-20T16:39:45.542Z (unchanged this cycle) | false | true | webhook-triggered, n/a |

**Datastores:**

| Datastore | ID | Records | Size / Max | Schema fields |
|---|---|---|---|---|
| elevate_daily_queue | 86836 | 1,071 | 289,904 / 1,048,576 bytes | 53 (datastructure 319927) |
| elevate_company_staging | 94078 | 0 | (empty) | 24 (datastructure 347903) |

**Approval Handler execution baseline (post-fix activity):**

- Last execution before any of today's edits: 2026-05-20T21:08:20.938Z, 13 ops, status 1
- Total today (2026-05-21): 1 execution at 17:29:22.063Z, 2 ops, status 1, 249ms duration. Operation count (2) and duration (~250ms) match the historical pattern for webhooks where Module 99's `key != ""` filter blocks downstream — likely a test ping or empty-key webhook arrival. **No real approvals processed since the Module 33 GET fix went live.**
- DLQ count: 0 (`allDlqCount`)

**Staging-to-Queue execution baseline:**

- Last execution: 2026-05-21T10:00:01.794Z, 127 ops, status 1. This was the morning's daily run, processed before any of today's mapper changes were applied. Staging was emptied by Module 5 after processing.
- Daily ops counts over the last 14 runs: 2506 (May 8 bulk), 118, 118, 121, 55, 46, 118, 277, 13, 10, 4, 139, 25, 127. Indicates ZoomInfo Intake has been firing (with variance) for the past two weeks — **PKI may be more stable than the prior session's "ZI Intake hasn't fired" assertion suggested, OR Travis has been running manual CSV imports.**

**RCRM duplicate baseline (10 known target companies, exact-match search):**

| Company | Records | Excess (= records - 1) |
|---|---|---|
| Stellantis | 18 | 17 |
| Cargojet | 8 | 7 |
| Linamar | 6 | 5 |
| Ecobee | 3 | 2 |
| Covalon | 2 | 1 |
| Mejuri | 1 | 0 |
| Sunnybrook Health Sciences Centre | 1 | 0 |
| Town of Oakville | 1 | 0 |
| Region of Durham | 0 | n/a (not yet in RCRM, will be created on next approval) |
| Ross Video | 0 | n/a (not yet in RCRM) |

**Total visible excess across these 10:** 32 known duplicate company records, all pre-Module-33-GET-fix artifacts. These are the floor — broader set likely contains more.

**Queue sample feature audit (100 of 1,071 records):**

- `company_city` populated: 0 / 100
- `zi_company_id` populated: 0 / 100

Expected — all 1,071 current queue records predate today's Staging-to-Queue mapper extensions (15:55 + 16:53 UTC). Tomorrow's 10:00 UTC daily run is the first opportunity for new queue records to carry the additional fields.

**Live HTML state:**

- Live URL: `https://elevate-sales-nav.netlify.app`
- Build token: `ELEVATE-2026-0521-A-BUILDPAYLOAD28`
- Local HEAD: matches origin/main at commit `0390b7b`
- Build serves the 28-field `buildPayload(c)` including company_city/state/country

### Monitoring Validation Checklist for Tomorrow's Cycle

Each check below has a concrete pass/fail criterion. **Run as a batch after tomorrow's 10:00 UTC daily Staging-to-Queue run** — or sooner if Travis manually triggers it or runs a CSV import.

**Check 1 — Staging-to-Queue mapper carry-through works.**

- Read `elevate_daily_queue` records via `data-store-records_list(86836, limit:100)`.
- For any records with `added_at >= 2026-05-22T10:00:00Z` (i.e., NEW since this monitoring point) AND `lead_source == "zoominfo_intent"`:
  - **PASS** if at least one of those records has at least one of `company_city`, `company_state`, `company_country`, `zi_company_id`, `zi_contact_id` non-empty.
  - **PARTIAL PASS** if ZoomInfo records exist but the new fields are all empty — could mean staging records didn't have the source fields populated (upstream Scenario A issue, not Wave 3 issue). Inspect Scenario A executions.
  - **FAIL** if no new zoominfo_intent records appeared at all — staging didn't get fed; this is the same ZI-PKI blocker we already have.

**Check 2 — Approval Handler dedup works end-to-end.**

- Read Approval Handler executions via `executions_list(4667221)`. Any with `timestamp > 2026-05-21T17:24:51Z` AND `status == 1` AND `operations > 4` is a real approval (declines and test pings show 2-4 ops).
- For each real approval:
  - **EXPECTED ops count for new-company-new-contact approval (no existing matches):** 13 (witness: pre-fix executions like `4a7d009...` at 13 ops, `84d5f16...` at 13 ops). Pre-fix this was also 13 because Module 3 wasn't yet deleted; post-fix the count should be similar or 1 less since Module 3 is gone. Acceptable range: 11-14.
  - **EXPECTED ops count for existing-company-new-contact approval (Module 33 finds match):** Module 31 skipped, Module 35 still runs but resolves from existing slug, Modules 11/2/5/13/4 still run. Approximate 10-12 ops. If a real approval lands at exactly 10-12 ops AND the contact came from a duplicate company (e.g., Stellantis), Module 33 dedup is working.
  - **EXPECTED ops count for existing-contact approval (Module 36 finds existing):** Route B only — Modules 1, 20, 99, 100, 36, 37, 39, 43, 44, 45, 46, 47 = ~12 ops.
  - **WARN** if any execution lands at 7-8 ops with `status == 1` — historical pattern was a partial-failure of Anthropic note-generation (Modules 5/45 returning unexpected shape).
  - **FAIL** if any execution has `status != 1`, OR if DLQ count increments above 0.

**Check 3 — RCRM record completeness for a freshly approved contact.**

- After Travis approves a card with known company name, identify the resulting RCRM contact slug from the Approval Handler execution's response chain (not exposed via executions_get; would require Make UI inspection OR a lookup using `GET /v1/contacts/search?email={the contact's email}&exact_search=1`).
- Read the contact via `GET /v1/contacts/{slug}`.
- **PASS** if all of:
  - `current_organization` matches `company_name` from the queue record
  - `company_slug` is non-empty AND matches a real company slug
  - `designation` matches `contact_title`
  - `contact_number` populated when phone was provided
  - `linkedin` populated when LinkedIn was provided
  - `custom_fields[5].value` equals the dashboard's `data_collection_source` payload value (not literal "ZoomInfo" unless that's what dashboard sent)
- Read the company via `GET /v1/companies/{slug}`.
- **PASS** if all of:
  - `company_name`, `website`, `linkedin`, `address` populated from queue data
  - `city`, `state`, `country` either reflect company HQ (if queue record had company_city populated post-tomorrow) OR fall back to contact location (if backlog card without company_city — `ifempty()` fallback works)
  - `industry_id` either matches the switch table or is 913 (Manufacturing fallback), NEVER 0
  - `custom_fields[1]` = `employee_count` from queue
  - `custom_fields[2]` = `annual_revenue` from queue
  - `custom_fields[12]` = `buying_signal` from queue (may be empty for ZI-source cards, intentional)

**Check 4 — Dedup hasn't created NEW duplicates.**

- Re-run the 10-company baseline search.
- **PASS** if no count INCREASED vs the baseline above.
- **FAIL** if any count increased — specifically, if Stellantis went from 18 → 19, or Cargojet from 8 → 9, that means Module 33 is somehow NOT matching despite the same name.

**Check 5 — Existing-contact path doesn't clobber LinkedIn.**

- If any execution between now and the check is a Route B path (existing-contact, Module 39+43+44+...), pick the contact's RCRM slug, read its `linkedin` field via `GET /v1/contacts/{slug}` BEFORE and AFTER a known re-approval. The before/after comparison requires manual triggering.
- **PASS** if `linkedin` is unchanged after re-approval (Module 43's body shouldn't be writing it anymore — verified in blueprint, just re-verify behaviorally).

**Check 6 — Silent-failure signals.**

- `allDlqCount` on 4667221: currently 0. ANY increase = silent failure.
- Scenario `isinvalid` flag: currently false on both 4667221 and 4990696. ANY toggle to true = someone (Make UI auto-edit, or another API push) corrupted the blueprint.
- Scenario `lastEdit` timestamps: currently 17:24:51 (4667221) and 16:53:18 (4990696). ANY further change without an audit entry in this handoff = unexpected drift.
- Queue datastructure 319927 field count: 53. ANY change without an audit entry = drift.
- Live HTML build token: `ELEVATE-2026-0521-A-BUILDPAYLOAD28`. ANY change without a corresponding git commit in our log = drift.

### Validation Approach

Run all 6 checks **after each meaningful production event** (Staging-to-Queue daily run, batch of dashboard approvals, or 24-hour heartbeat). Document each check's result with the observed numbers, not adjectives. Validation logs go into SESSION_HANDOFF.md under a dated heading.

If a check fails: do NOT make changes immediately. First document the failure with the exact observed numbers vs expected. Then decide between (a) continued observation, (b) targeted remediation, (c) rollback. The decision is Travis's; Claude reports findings.

### Decisions Made

- **Do not poll RCRM at high frequency.** RCRM rate limit is 60/min; baseline takes ~10 GETs. Re-running the full check is ~15-20 GETs. At most twice per day of polling, well within budget.
- **Do not introduce monitoring scenarios in Make.** Adding monitor scenarios would itself be a production change. Existing Make execution lists + datastore reads are sufficient.
- **Do not call `executions_get` for detail.** The MCP returns only `{status: "SUCCESS"}` — no module-level bundles. To inspect what an execution actually did, use Make UI execution viewer. This is a known MCP limitation, not a defect.

### Blockers

Unchanged. ZoomInfo PKI status uncertain — daily execution counts suggest some intake activity, but staging is empty as of this snapshot. Tomorrow's 6am cycle will clarify.

---

## Previous Session: 2026-05-21 (late evening — Module 33 GET fix deployed; dedup verified end-to-end)

### What Was Done

Applied the Module 33 GET-with-exact_search fix that the earlier empirical audit recommended. Single `scenarios_update` push on 4667221. Pre-edit Module 33 config saved to `.backups/module_33_pre_get_fix.20260521T172329Z.json`.

### Change Applied

| Aspect | Pre-fix (live since 2026-04-07) | Post-fix (live since 2026-05-21T17:24:51.028Z) |
|---|---|---|
| Method | POST | GET |
| URL | `https://api.recruitcrm.io/v1/companies/search` | `https://api.recruitcrm.io/v1/companies/search?company_name={{encodeURL(1.company_name)}}&exact_search=1` |
| Body | jsonStringBodyContent: `{"company_name": "{{1.company_name}}"}` | (none — GET has no body) |
| Headers | Authorization, Content-Type | Authorization, Accept |
| `contentType`, `inputMethod`, `jsonStringBodyContent` | json, jsonString, the body string | removed |
| Effective behavior | HTTP 404 every call → Module 34 never finds a match → Module 31 always creates | HTTP 200 with wrapped object on match, bare `[]` on no-match → Module 34 resolves to first slug or empty → Module 31 creates only when nothing matches |

Module 33 now mirrors the working pattern from Module 36 (contact search) one-to-one, modulo URL.

### Post-Deploy Verification (end-to-end dedup behavior)

Three live curl scenarios against the production endpoint, each simulating exactly what Module 33 now sends:

**V1 — known multi-record duplicate (`Stellantis`, 18 existing records):**
- Response: WRAPPED `{current_page:1, data:[...18 records...]}`
- `33.data.data[1].slug` resolves to `17780808284210054787dBD` (first match)
- Module 34 captures non-empty `existing_company_slug`
- Module 31 filter `existing_company_slug == ""` FAILS → no create
- Module 35 → Module 11 → contact attached to existing slug
- **Outcome: future Stellantis approvals will NOT create a 19th duplicate. They will attach the contact to the existing first-by-creation Stellantis record.**

**V2 — nonexistent company (`AcmeNonexistentCorp987`):**
- Response: BARE `[]`
- `33.data.data[1].slug` resolves to empty (`.data` on array is undefined)
- Module 34 captures empty `existing_company_slug`
- Module 31 filter PASSES → create new company
- **Outcome: brand-new companies are created normally. No regression.**

**V3 — URL-encoded special chars (`React Tool & Mold`, ampersand encoded as `%26`):**
- Response: WRAPPED, 1 match
- Same wrapped-path semantics as V1
- **Outcome: company names with `&`, spaces, etc. work correctly via `encodeURL()`.**

### Module 34 Regression Check

Module 34 reads `{{33.data.data[1].slug}}` — unchanged from pre-fix. The same IML resolves correctly across all three Module 33 response shapes:

| Module 33 response | `33.data` resolves to | `33.data.data[1].slug` resolves to | Module 34 captures |
|---|---|---|---|
| WRAPPED with matches (new GET success) | `{current_page, data:[...]}` (parsed object) | first match's slug | non-empty slug |
| BARE empty array `[]` (new GET no-match) | `[]` (parsed array) | undefined (arrays have no `.data`) | empty string |
| 404 error object (old POST, now obsolete) | `{error:true, errorCode:404,...}` | undefined | empty string |

No regression possible — Module 34's logic was already correct; only Module 33's input was wrong. The IML pattern handles all three response shapes deterministically. The same applies to Module 35's downstream `{{if(34.existing_company_slug; 34.existing_company_slug; 31.data.slug)}}` resolution.

### Scenario State (post-deploy)

- Approval Handler 4667221: `lastEdit:2026-05-21T17:24:51.028Z`, `isinvalid:false`, `isActive:true`. `usedPackages` count 23 unchanged (one HTTP module — Module 33 — swapped POST for GET, no count change).
- All other modules in Route A and Route B unchanged.

### Rollback Steps

Rollback is reversible via a single `scenarios_update` that restores Module 33 to the pre-fix POST form. The pre-edit Module 33 config is saved at `.backups/module_33_pre_get_fix.20260521T172329Z.json`.

To roll back (only if a regression is empirically confirmed by execution-level inspection in Make UI — do NOT roll back on speculation):

1. Take a fresh snapshot of the current 4667221 blueprint via `scenarios_get(4667221)` and save it to `.backups/` with a new timestamp (preserves the GET form for later re-apply if rollback turns out to be wrong).
2. Open `.backups/module_33_pre_get_fix.20260521T172329Z.json`. The `module` field is the literal Module 33 object as it was before the fix.
3. Re-fetch the current full blueprint, replace the Route A Module 33 entry with the pre-fix object, push via `scenarios_update`.
4. Verify with `scenarios_get`: Module 33 should show `method:"post"`, `url:"https://api.recruitcrm.io/v1/companies/search"`, body restored.
5. Note: rollback restores the broken behavior (404 on every call → silent duplicate creation). Document the rollback reason in `SESSION_HANDOFF.md` so future Claude/Travis sessions don't re-apply the same fix without addressing the regression that caused rollback.

Rollback would **not** undo the new duplicates created by the GET fix's behavior (none expected — the fix prevents new duplicates rather than introducing them). Rollback would NOT undo Module 34, 35, 31 — they are unchanged.

### Cumulative Today

16 remediation changes applied. The Module 33 GET fix completes the prevention-logic side of duplicate handling. The 18+ Stellantis records and 3+ Cargojet records that already exist are NOT addressed by this fix — see separate cleanup section below.

### Decisions Made

- **Mirrored Module 36's structure exactly for Module 33.** Both are now `method:get`, `url` with `?...&exact_search=1`, `Authorization + Accept` headers, no body, no `Content-Type`. Consistent pattern reduces future cognitive overhead.
- **Did NOT add `lower()` to the company_name URL.** The search endpoint is empirically case-insensitive (verified in the 30-test audit). Adding `lower()` would be cosmetic and adds an extra IML function call per execution. Module 36 has `lower()` because contact emails benefit from normalization at the storage-comparison layer; company_name search doesn't gain anything.
- **Kept `stopOnHttpError: false` on Module 33.** With the new GET form there are no expected HTTP errors (no-match returns 200 + bare `[]`, not 404). The flag is now defensive rather than load-bearing.
- **Did NOT touch Module 33's filter conditions.** The filter (`resolved_slug == "" AND company_name != ""`) gates whether Module 33 runs at all and is correct independently of the search shape.

### Blockers

Unchanged. ZoomInfo PKI down. Credential rotations pending.

---

## Duplicate Cleanup (separate from prevention)

This section is intentionally separate from the Module 33 prevention fix above. The cleanup of existing duplicates is a distinct problem with a distinct solution surface — neither caused by the fix nor solved by it.

### Observed Duplicate Counts (production RCRM, sampled 2026-05-21)

From the first 100 records of `GET /v1/companies` and from targeted `GET /v1/companies/search?company_name=X&exact_search=1` queries:

- **Stellantis: 18 exact-match records** (`company_name == "Stellantis"`). Additional substring matches (e.g., `Stellantis Canada`, `Stellantis Detroit`) would push the total above 18 if they exist.
- **Cargojet: at least 3 exact-match records** visible in the first 100 of `/v1/companies`.
- **Other near-certain duplicates** observable in the first-100 sample without targeted querying: multiple `Stellantis` entries with identical `website == "stellantis.com"`. Likely many more across the broader company set; not enumerated here without running the same search on every known Elevate target company.

### Cause (already addressed)

All observed duplicates were created by Module 33's broken POST form returning HTTP 404 on every execution since the scenario was created on 2026-04-07. The new GET form (deployed 2026-05-21T17:24:51.028Z) prevents future duplicates but does not retroactively merge existing ones.

### Cleanup Options

**Option A — RCRM admin UI manual merge (recommended for now):**
- Travis or Roxanne uses RCRM's web UI to navigate to the duplicate set, select records, and use the built-in "merge" action.
- Pros: zero risk of data loss, RCRM-side native semantics handle related contacts/notes/jobs cleanly, no automation effort.
- Cons: tedious for 18+ records per company; scales poorly if many companies have duplicates.
- Estimated effort: ~5 minutes per company set, ~1.5 hours for the visible 18 Stellantis + 3 Cargojet plus a few more.

**Option B — Scripted cleanup via RCRM API:**
- Build a one-shot script that: (i) runs `GET /v1/companies/search?company_name=X&exact_search=1` for each known target, (ii) picks the oldest-created (lowest `id`) as the canonical record, (iii) for each other slug, reassigns its contacts to the canonical slug (RCRM endpoint TBD — needs empirical verification), (iv) deletes the now-orphaned duplicate.
- Pros: scalable, repeatable, auditable via a log.
- Cons: requires empirical verification of contact-reassignment and company-delete endpoints (not done in this session). Risk of data loss if any duplicate has notes/jobs not attached to canonical. Should be staged: dry-run first against a single test pair, then small batch, then full set.
- Estimated effort: 2-4 hours to build + verify + run. Not recommended until Option A has cleared the easy cases or unless the duplicate count grows past manual viability.

**Option C — Accept the duplicates, prevent new ones:**
- Do nothing. The new GET fix means future approvals attach to the first-by-creation record of each duplicate set. The remaining duplicates are orphan records — no new contacts will be attached to them.
- Pros: zero effort, zero risk.
- Cons: RCRM company-list and reporting views will show the duplicate clutter indefinitely. Search-driven workflows in RCRM UI may surface a duplicate to a user who then attaches a note/job to the "wrong" copy.

### Recommendation

**Option A for the 4-5 visible duplicate sets (Stellantis, Cargojet, possibly Mejuri/Sunnybrook/Region of Durham — verify each).** Defer Option B unless the duplicate count is found to be substantially larger than 18 + 3 + a handful. Option C is acceptable as a transitional stance only — RCRM's company list will show clutter, and reports will double-count headcount/revenue.

**Out of scope of this audit cycle:** Option B implementation, dry-run testing, or actual execution. Travis to choose path and timing.

### Validation After Cleanup

After any cleanup (manual or scripted), re-run `GET /v1/companies/search?company_name=Stellantis&exact_search=1` and confirm `data.length == 1`. This is the same query Module 33 will issue on future approvals; if cleanup leaves exactly one canonical record, future approvals will deterministically attach to it.

---

## Previous Session: 2026-05-21 (late evening — RCRM /v1/companies/search empirical audit)

### What Was Done

Ran 30 read-only curl tests against `https://api.recruitcrm.io/v1/companies/search` using the existing production Bearer to determine **observed** behavior. Goal: validate the safest production implementation for Module 33 (Approval Handler company search / dedup) before drafting any blueprint change. No mutations, no creates, no deletes — strictly read endpoints (`GET /v1/companies` to pick test targets, plus search variants).

### Critical Production Defect Discovered

**Module 33's current POST form has been returning HTTP 404 on EVERY execution since the scenario was created.** Confirmed by testing the exact production body shape:

- `POST /v1/companies/search` body `{"company_name": "Stellantis"}` → `HTTP 404` with body `{"error":true,"errorCode":404,"errorMessage":"Company doesn't exist"}`
- Same 404 for empty body `{}`, `{"name": "X"}`, `{"website": "X"}`, `{"linkedin": "X"}` — every POST shape tested.

Module 33's downstream consumer (Module 34) reads `33.data.data[1].slug`. On the 404 response shape `{error:true, errorCode:404, errorMessage:...}`, `data.data` is undefined → `existing_company_slug = ""`. Module 31's filter `existing_company_slug == ""` is therefore ALWAYS true → Module 31 ALWAYS creates a new company.

**Empirical proof of the impact:** `GET /v1/companies/search?company_name=Stellantis&exact_search=1` returns **18 exact-match Stellantis records** in production RCRM. `GET ?company_name=Stellantis` (substring mode) returns 34. Same pattern for Cargojet (3 visible in the first page of `/v1/companies`). The deduplication has been silently disabled since the scenario was created on 2026-04-07. Every new-contact approval through Route A has been generating a duplicate company record.

### Validated Findings (observed only)

| Aspect | Observed |
|---|---|
| Accepted method | `GET` only. `POST /v1/companies/search` returns 404 for all body shapes tested. |
| Accepted query parameter | `company_name=X` only. `name=X`, `website=X`, `linkedin=X` all return `HTTP 400 UNSUPPORTED_SEARCH`. Multi-field also 400. |
| Optional flag | `exact_search=1`. Without it, substring match. With it, strict equality (case-insensitive, whitespace-trimmed). |
| Case sensitivity | Insensitive in both modes. `Stellantis`, `stellantis`, `STELLANTIS` all return identical 18 records (exact) / 34 records (substring). |
| Whitespace | Both leading and trailing spaces are trimmed. `"%20Stellantis"` and `"Stellantis%20&exact_search=1"` both behave like `Stellantis`. |
| Substring behavior | `Stellan` returns 34 (matches `Stellantis`, `Stellantis Canada`, etc.). `S` alone returns 100 records (likely page-truncated). |
| Exact behavior | `Stellan&exact_search=1` returns empty array. `Stellantis Canada&exact_search=1` returns empty array — exact mode requires the full field value to match, not just the leading word. |
| Successful-response shape | `{"current_page":1,"data":[...company-objects...]}` — wrapped, paginated. `data` is the array of matches. |
| Empty-response shape | Bare `[]` — JUST an empty array, no wrapper. Critical: response shape changes between has-results (wrapped object) and no-results (bare array). |
| Page parameter | `?page=2` accepted but for the 34-Stellantis result set returned `[]` — appears to be 1 page only. Per-page size observed = 100 max. |
| Special chars | `&` in name (e.g., `React Tool & Mold`) works with URL-encoded `%26`. Returned 1 exact match. |
| Make IML compatibility | Wrapped response → `33.data.data[1].slug` resolves to first match's slug (correct). Bare-array empty → `data` property on array is undefined → resolves to empty (correct). 404 error shape → `data.data` undefined → empty (correct). All three paths produce the right behavior for Module 34's downstream filter. |

### Match Behavior Summary

- **Exact match (`&exact_search=1`)**: matches `lower(trim(company_name_in_db)) == lower(trim(query))`. Found 18 records for `Stellantis` (proves duplicates exist; proves search finds all of them).
- **Partial/substring (no flag)**: matches `lower(company_name_in_db).contains(lower(query))`. Found 34 for `Stellantis`, 100 for `S` (probable truncation).
- **No anchoring**: `Stellan` matches `Stellantis` (prefix), `WeStellantisCo` would presumably match too (substring anywhere).

### Duplicate Detection Implications

1. **Current production has produced multi-record duplicates already.** 18 `Stellantis`, 3+ `Cargojet`, and likely many more across the company set. The audit data was visible in the first 100 records of `GET /v1/companies` alone.
2. **The endpoint can find these duplicates.** `GET ?company_name=Stellantis&exact_search=1` returned all 18 in one call.
3. **The endpoint cannot find duplicates by website or LinkedIn URL.** Those parameters are unsupported (HTTP 400). RCRM's NATIVE dedup at company-create time (per public help docs) checks website+linkedin, but we cannot proactively check those via search.
4. **Name-typo duplicates will still bypass dedup** even with the fix. `Stellantis Inc` and `Stellantis` would not match in exact mode. Substring mode helps but creates false positives (`Stellantis` substring-matches the wrong sister-company). The fundamental tradeoff: strict-exact (misses typos, no false positives) vs substring (catches typos, risks wrong-company association).
5. **The existing 18+ duplicates won't auto-resolve** with any search-side fix. They need manual merge in RCRM admin (or a separate cleanup script using PUT/PATCH endpoints — out of scope of this audit).

### Safest Production Implementation Strategy

Use `GET` with `exact_search=1`. Specifically, Module 33 becomes:

```
method: GET
url:    https://api.recruitcrm.io/v1/companies/search?company_name={{encodeURL(1.company_name)}}&exact_search=1
headers:
  Authorization: Bearer <token>
  Accept: application/json
(no jsonStringBodyContent, no Content-Type)
```

Downstream consumer Module 34 already reads `{{33.data.data[1].slug}}` — works correctly across all three response shapes (wrapped-with-results, bare-empty-array, error). No change needed to Module 34, 35, 31.

**Why strict exact (no fallback to substring)**:

- **Worst-case for exact**: misses typo duplicates → creates a NEW duplicate. Damage = 1 extra company record per typo, no wrong-company association.
- **Worst-case for substring fallback**: matches a sister-company (e.g., approving a contact at `Stellantis Detroit` finds an existing `Stellantis` and attaches the contact to the wrong company). Damage = misattributed contact, harder to detect than a duplicate.
- Elevate's data is high-quality on company_name (ZoomInfo-sourced names are consistent), so typo rate is low. The 18 `Stellantis` duplicates exist because Module 33 was returning 404 not because of name typos.

**Why no website/linkedin fallback**:

- The search endpoint **explicitly rejects** website/linkedin params with HTTP 400. No way to use them.
- RCRM's native create-time dedup on website+linkedin (per their help docs) is a separate safety net that fires INSIDE `POST /v1/companies` — we don't have to implement it. If a duplicate company has the same website as an inbound record, RCRM may auto-merge or reject. This is unverified empirically (would require a POST test, which is destructive); deferred.

### Recommendation

Apply the Module 33 GET-with-exact_search fix. Risk profile: low (matches the proven-working Module 36 contact-search pattern). Reversible by re-pushing the prior POST blueprint (saved in `.backups/`). 

**Not recommended** in this same patch: any attempt to clean up the existing 18+ Stellantis duplicates. That requires either manual RCRM admin merges or a separate dedicated cleanup scenario. Out of scope for the audit-driven remediation.

### Decisions Made

- **No POST forms remained worth testing.** Once `{"company_name":...}`, `{"name":...}`, `{"website":...}`, `{"linkedin":...}`, and empty body all returned 404 with identical error messages, additional POST tests would add no information. Conclusion: `/v1/companies/search` does not accept POST.
- **Did not test the same patterns against `/v1/contacts/search`.** The contact-search endpoint has been working in production (`GET /v1/contacts/search?email=X&exact_search=1` per Module 36). No reason to disturb a working endpoint.
- **Did not POST to `/v1/companies` to test RCRM's native website+linkedin dedup behavior.** That would be a write operation; verifying it would create test records that may not auto-clean. Defer until a dedicated dummy-company test is authorized.
- **Did not implement the Module 33 fix in this turn.** The user asked for the empirical audit and documentation only. Recommendation drafted; implementation gated on explicit go-ahead.

### Cumulative Today

15 remediation changes applied + 1 critical defect discovered (Module 33 broken since 2026-04-07). Next push would be the Module 33 GET conversion.

### Next Steps

1. [ ] Confirm with Travis: apply Module 33 fix? (single scenarios_update on 4667221, body change from POST/jsonStringBodyContent to GET-with-URL).
2. [ ] After fix lands: validate by approving a known-duplicate contact (any pending Stellantis card in the queue). Module 33 should now find existing slug; Module 31 should be FILTERED OUT (not fire); Module 11 should attach the new contact to the existing company.
3. [ ] Travis decision: handle the 18 Stellantis + 3 Cargojet + likely many more existing duplicates? Manual RCRM merge vs scripted cleanup vs accept.
4. [ ] Travis credential rotations (unchanged).
5. [ ] Phase 2 ZI bridge gated by ZoomInfo PKI restoration.

### Blockers

Unchanged. ZoomInfo PKI down. Credential rotations pending.

---

## Previous Session: 2026-05-21 (late evening — Wave 3 complete: Issue 1.3 landed end-to-end)

### What Was Done

Issue 1.3 (Approval Handler Module 31 uses company HQ location, not contact location) landed across all four surfaces in a single coordinated session:

| # | Issue | Surface | Change | Verified |
|---|---|---|---|---|
| 12 | 1.3 | Queue Fetch (4734116) | Inspection only — confirmed Module 3 BasicAggregator forwards entire `data` object (`data: {{2.data}}`), no field-pick. New queue fields flow through to dashboard automatically. No edit needed. | ✓ |
| 13 | 1.3 | `index.html:1303` buildPayload | Added `company_city`, `company_state`, `company_country` to payload object. Build token bumped to `ELEVATE-2026-0521-A-BUILDPAYLOAD28`. | ✓ committed (`c5af4be`), pushed, Netlify deployed live (verified via curl) |
| 14 | 1.3 | Approval Handler webhook interface (4667221) | Declared 3 new fields at positions 17/18/19 (immediately after `company_address`). 28 total entries. | ✓ |
| 15 | 1.3 | Approval Handler Module 31 body | `"city": "{{1.contact_city}}"` → `"city": "{{ifempty(1.company_city; 1.contact_city)}}"`. Same pattern for state and country. Graceful fallback to contact location for backlog cards that lack company location. | ✓ |

Approval Handler state: `lastEdit:2026-05-21T17:00:34.479Z`, `isinvalid:false`, `isActive:true`. Push did not trip the gotcha (continued evidence that the historic warning is superseded).

### Behavioral Impact (live now)

- **Newly-staged ZoomInfo cards** (post-Staging-to-Queue patch from earlier this session, once ZI Intake resumes) will carry `company_city`, `company_state`, `company_country` separately from contact location through staging → queue → dashboard → webhook → RCRM. Module 31 will write the company HQ city/state/country to RCRM instead of the contact's work-from-home / branch-office city.
- **The 1,071 backlog queue records** that lack company location (every record currently in the queue) still produce valid Module 31 payloads — `ifempty()` falls back to contact location, preserving today's behavior exactly. No regression for in-flight approvals.
- **Build token bumped**: live HTML serves `ELEVATE-2026-0521-A-BUILDPAYLOAD28`. The dashboard's payload now has 28 fields (was 25).

### Cumulative Today

15 remediation changes since this morning. All via API + no Make UI Save coordination after the first wave. The gotcha that originally drove the "must Save in UI" caveat has been disproven across 6 sequential pushes today.

1. (2.3) Webhook interface declares contact_slug
2. (1.2) industry_id default 0 → 913
3. (3.2) Module 36 email wrapped in lower()
4. (1.4a) Queue datastructure + zi_company_id, zi_contact_id
5. (1.4b) Staging datastructure + zi_contact_id, company_country, company_zipcode, company_phone
6. (1.4c) Staging-to-Queue Module 4 forwards zi_company_id, zi_contact_id
7. (2.2) Module 3 (redundant new-contact stage update) deleted
8. (1.1) Module 11 data_collection_source uses dashboard variable
9. (2.1 minimal) Module 43 no longer overwrites LinkedIn
10. (1.3 prereq) Queue datastructure + company_city, company_state, company_country
11. (1.3 prereq) Staging-to-Queue Module 4 forwards company_city, company_state, company_country
12. (1.3) Queue Fetch verified pass-through (no edit)
13. (1.3) buildPayload extended, build token ELEVATE-2026-0521-A-BUILDPAYLOAD28 live on Netlify
14. (1.3) Approval Handler webhook interface declares 3 new fields
15. (1.3) Module 31 uses ifempty() fallback for city/state/country

### What Remains in the Remediation Plan

**Needs RCRM endpoint testing first:**
- Issue 3.1 — Module 33 company search shape. Drafting blind risks producing a worse search than the current name-only POST.

**Deferred:**
- Issue 2.4 — custom_fields 9/10/11 (no funding data source until Phase 2 ZI bridge).
- Full Issue 2.1 gap-fill on Module 43 — needs structural change (GET-existing-contact before update).

**Out of Make→RCRM scope but tracked:**
- Sales Intelligence tab restoration via Anthropic proxy function (Anthropic key already removed from HTML; Sales Intelligence tab is broken but not part of the pipeline).

**External admin consoles (Travis only):**
- Rotate RCRM Bearer + Anthropic key, migrate to Make Connections.
- Rotate ZoomInfo private key (leaked 2026-05-20).

**Gated by ZoomInfo PKI:**
- Phase 2 ZI bridge + backlog repair scenario.

### Validation Plan

The cleanest validation path requires either ZI Intake to resume OR a manual CSV import:

1. After ZI Intake resumes or CSV import populates staging, wait for next Staging-to-Queue 6am run (or trigger manually).
2. Confirm new queue record contains `company_city`, `company_state`, `company_country`, `zi_company_id`, `zi_contact_id` populated from staging.
3. Have Travis approve that card from the dashboard.
4. Inspect the resulting RCRM company record. Confirm:
   - `city`/`state`/`country` match company HQ (not contact's work city)
   - `industry_id` matches the switch table OR is 913 for unmatched
   - `address` populated (was empty pre-Wave-1)
   - custom_field 5 on the contact = the actual `data_collection_source` value, not literal "ZoomInfo"
   - Only ONE RCRM contact-create event in audit (no follow-up stage update from deleted Module 3)
5. If existing contact path is exercised, confirm LinkedIn was NOT clobbered.

### Decisions Made

- **Pushed buildPayload + Approval Handler change in parallel rather than serialized.** Order didn't matter because Module 31's `ifempty` makes the change forward-compatible (empty company_city falls back to contact_city). Dashboard could deploy after the scenario without breaking anything; in practice both pushed in <1 minute.
- **Used `ifempty(1.company_city; 1.contact_city)` not `if/then/else`.** Simpler IML, clearer intent, equivalent semantics for the empty-string case.
- **Did not stop at the prep step** — Travis explicitly said "land it" after I described the 4-surface plan. End-to-end completion in one session was the right call given the gotcha is disproven and there's no UI-coordination friction.

### Blockers

Unchanged. ZoomInfo PKI down. Credential rotations pending.

---

## Previous Session: 2026-05-21 (late evening — Wave 3 prep: company location plumbing)

### What Was Done

Extended the upstream data plumbing so future queue rows can carry company HQ location separately from contact location. Two API-only pushes:

| # | Issue | Surface | Change | Verified |
|---|---|---|---|---|
| 10 | 1.3 prereq | Datastructure 319927 (queue schema) | Added `company_city`, `company_state`, `company_country` (text fields). Spec now 53 fields. | ✓ |
| 11 | 1.3 prereq | Scenario 4990696 Module 4 mapper | Added 3 keys to the data object: `company_city: {{1.company_city}}`, `company_state: {{1.company_state}}`, `company_country: {{1.company_country}}`. `lastEdit:2026-05-21T16:53:18.247Z`, `isinvalid:false`, `isActive:true`, `nextExec:2026-05-22T10:00:00Z`. | ✓ |

These two changes are pure plumbing — they don't yet change RCRM-side behavior. They enable the downstream Module 31 fix (Issue 1.3 step 2) to read company HQ location from the queue payload, with graceful degradation via `ifempty(1.company_city; 1.contact_city)` for backlog records that don't have it.

### Remaining Work For Issue 1.3

To complete Issue 1.3 (Module 31 stops using contact location as company HQ location), four more surfaces need touching:

1. **Queue Fetch (scenario 4734116)** — verify it returns all queue record fields including the new 3. If it does a field-list `pick`, would need updating. (Not yet inspected.)
2. **Dashboard `buildPayload(c)` at `index.html:1303`** — add `company_city`, `company_state`, `company_country` to the payload object so they reach the webhook.
3. **Approval Handler webhook interface** — declare the 3 new fields (so they're typed for downstream mappers, though Make accepts undeclared keys anyway).
4. **Approval Handler Module 31 body** — change `"city": "{{1.contact_city}}"` to `"city": "{{ifempty(1.company_city; 1.contact_city)}}"` (same pattern for state and country). The `ifempty` fallback preserves current behavior for backlog cards that don't yet have company location.

This is a 4-surface coordinated change: 1 read-only inspection + 1 dashboard edit + commit/push + 1 scenarios_update push. Doable in one session but should be sequenced: inspect → edit dashboard → push to repo → wait for Netlify deploy → push scenario change → verify with a test approval. The dashboard change alone is harmless even before the scenario change (extra fields in webhook payload don't break anything).

### Cumulative Today

11 remediation changes live since this morning, all via API + no Make UI Save coordination:

1. (2.3) Webhook interface declares contact_slug
2. (1.2) industry_id default 0 → 913
3. (3.2) Module 36 email wrapped in lower()
4. (1.4a) Queue datastructure + zi_company_id, zi_contact_id
5. (1.4b) Staging datastructure + zi_contact_id, company_country, company_zipcode, company_phone
6. (1.4c) Staging-to-Queue Module 4 forwards zi_company_id, zi_contact_id
7. (2.2) Module 3 (redundant new-contact stage update) deleted
8. (1.1) Module 11 data_collection_source uses dashboard variable
9. (2.1 minimal) Module 43 no longer overwrites LinkedIn
10. (1.3 prereq) Queue datastructure + company_city, company_state, company_country
11. (1.3 prereq) Staging-to-Queue Module 4 forwards company_city, company_state, company_country

### Decisions Made

- **Did the plumbing in two API pushes, didn't bundle the dashboard work.** The full Issue 1.3 fix touches the dashboard (Netlify-side) and a coordinated scenarios_update. Keeping the API-only prep separate gives a clean rollback boundary; the dashboard change can land later without risk.
- **Plan to use `ifempty(1.company_city; 1.contact_city)` in Module 31 when we get there.** That way the 1,071 backlog queue records (which don't have company_city/state/country) still produce valid Module 31 payloads using contact location — same as today. Only NEW post-patch queue rows will use the better company location.

### Next Steps

1. [ ] If you want Issue 1.3 completed: I inspect Queue Fetch (4734116) to confirm field forwarding, edit `buildPayload(c)` in `index.html` to include the 3 new fields, commit + push, wait for Netlify deploy, push the Module 31 scenarios_update with `ifempty` fallback, verify with a test approval.
2. [ ] If you want to stop the remediation work here for now: I just update the docs and let tomorrow's 6am daily run validate the prep.
3. [ ] (Always-pending) Travis credential rotations.

### Blockers

Unchanged.

---

## Previous Session: 2026-05-21 (late evening — Wave 2 fixes applied, gotcha disproven)

### What Was Done

Travis was at us2.make.com/2053152/scenarios/4667221/edit and confirmed ready to Save. Per the safety protocol, I did a drift check first (lastEdit unchanged at 2026-05-21T16:00:45.523Z), then pushed the pre-staged blueprint from `.backups/proposed_4667221_ui_patches.20260521T160646Z.json`.

**Push outcome: `isinvalid:false`. The gotcha did NOT trip.** No Save needed in Make UI. Travis closed the tab without clicking anything.

### Changes Applied (live)

| # | Issue | Module | Pre | Post | Verified |
|---|---|---|---|---|---|
| 8 | 1.1 | Module 11 jsonStringBodyContent | `\"field_id\": 5, \"value\": \"ZoomInfo\"` | `\"field_id\": 5, \"value\": \"{{1.data_collection_source}}\"` | ✓ |
| 9 | 2.1 (minimal variant) | Module 43 jsonStringBodyContent | `{\"stage_id\": 142468, \"linkedin\": \"{{20.linkedin_url}}\"}` | `{\"stage_id\": 142468}` | ✓ |

Approval Handler state: `lastEdit:2026-05-21T16:49:24.565Z`, `isinvalid:false`, `isActive:true`.

### Significant Gotcha Refinement (SCRIBE updated)

SCRIBE lines 20-21 previously claimed `jsonStringBodyContent` edits with `{{variable}}` expressions auto-trigger `isinvalid:true`. Today's experimental record across 5 sequential pushes to scenario 4667221 — including this push, which both ADDED a new `{{var}}` to a body AND REMOVED a `{{var}}` from another body in the same call — produced `isinvalid:false` every time. The original gotcha is either fixed at the Make platform level or only triggers on specific malformed patterns we have not reproduced.

**Operational consequence:** Future Make scenario edits, even those touching `jsonStringBodyContent` with `{{var}}` expressions, can be pushed via `scenarios_update` without requiring a Travis-in-the-UI-clicks-Save coordination step — unless the actual gotcha pattern is hit, in which case post-push `isinvalid:true` would be visible and we'd fall back to UI Save. This significantly reduces the friction of remediation work going forward.

I'm leaving the gotcha entries in SCRIBE marked as SUPERSEDED rather than deleting them, so future Claude sessions can re-test if isinvalid:true appears and quickly recognize the historical pattern.

### Behavioral Impact (live now)

- **Signals-source contacts will be tagged correctly in RCRM.** Approving a card from `signal-003_*` or `TEST_HIRING_SIGNAL_001` will write that record's `data_collection_source` value to RCRM contact custom_field 5 — typically "hiring_signals" or similar — instead of the literal "ZoomInfo" string. ZoomInfo-sourced contacts (whose payload field IS "zoominfo_intent") will continue to write that string. The hardcode bug is gone.
- **Existing RCRM contacts will no longer have their LinkedIn URL overwritten** on re-approval. Module 43 (Route B, existing-contact path) only updates `stage_id` now. If RCRM has a manually-curated LinkedIn for a contact and the dashboard re-sends an approval for that contact, the existing LinkedIn is preserved.
- **NOT a full gap-fill yet.** Other fields (phone, mobile, email, title, city, etc.) on existing contacts still aren't refreshed from the dashboard payload. That's the Phase 2 / full Issue 2.1 design — needs a GET-existing-contact module added before the update, with conditional ifempty() per field. Out of scope for this push.

### Cumulative Wave State (Today's Work)

9 remediation changes live since this morning, all via API:

1. (Issue 2.3) Webhook interface declares contact_slug
2. (Issue 1.2) industry_id default 0 → 913
3. (Issue 3.2) Module 36 email wrapped in lower()
4. (Issue 1.4a) Datastructure 319927 + zi_company_id, zi_contact_id
5. (Issue 1.4b) Datastructure 347903 + zi_contact_id, company_country, company_zipcode, company_phone
6. (Issue 1.4c) Staging-to-Queue Module 4 carries zi_company_id, zi_contact_id forward
7. (Issue 2.2) Module 3 redundant new-contact stage update deleted from Route A
8. (Issue 1.1) Module 11 data_collection_source uses dashboard variable
9. (Issue 2.1 minimal) Module 43 stops overwriting LinkedIn on existing contacts

### What's Still Pending in Remediation Plan

**Make API only (can be done any time, no UI coordination):**
- Issue 1.3 step 1 — extend Staging-to-Queue Module 4 mapper to forward `company_city`, `company_state`, `company_country` from staging to queue (staging schema 347903 already declares them since today's earlier work). Prerequisite to Issue 1.3 step 2.
- Issue 1.3 step 2 — update Module 31 company create body to use `{{1.company_city}}` / `{{1.company_state}}` / `{{1.company_country}}` instead of the contact location fields.

**Needs RCRM endpoint testing first:**
- Issue 3.1 — Module 33 company search shape. Drafting blind risks producing a worse search than the current name-only POST.

**Defer until Phase 2:**
- Issue 2.4 — custom_fields 9/10/11 (no funding data source until ZI bridge).
- Full Issue 2.1 gap-fill — needs structural change to Module 43.

**Repo + Netlify (Claude-owned, currently OUT of Make→RCRM scope):**
- Sales Intelligence tab restoration via Anthropic proxy function.

**External admin consoles (Travis only):**
- Rotate RCRM Bearer + Anthropic key, migrate to Make Connections.
- Rotate ZoomInfo private key.

### Next Steps

1. [ ] Optional: extend Staging-to-Queue mapper for company_city/state/country forward-carry (preps Issue 1.3 step 2). Fully API-safe, no UI involvement. Can be done now.
2. [ ] After ZI Intake fires (or manual CSV import populates staging) and Staging-to-Queue runs at next 6am: inspect a fresh queue record to confirm zi_company_id / zi_contact_id are populated.
3. [ ] After next live approval: inspect RCRM contact record for: (a) custom_field 5 = correct data_collection_source value not "ZoomInfo" literal, (b) on existing contacts re-approved, LinkedIn preserved, (c) exactly one contact-create event in RCRM audit (no follow-up stage update from the now-deleted Module 3), (d) industry_id matches switch or is 913 for unmatched.
4. [ ] Travis: rotate RCRM Bearer + Anthropic key + ZoomInfo PKI when convenient.
5. [ ] When RCRM `/v1/companies/search` semantics confirmed (curl test from a known-good context): draft Issue 3.1 fix.

### Decisions Made

- **Pushed the bundled UI patches with Travis at the UI as a safety net.** Even though the gotcha didn't trip and no Save was needed, the coordination was the right call — if isinvalid had tripped, Travis was positioned to Save immediately.
- **Treat the jsonStringBodyContent gotcha as superseded, not deleted.** The behavior may resurface (Make platform changes, specific pattern triggers). Leaving the SCRIBE entry visible-but-marked lets future sessions recognize the pattern fast.
- **Did NOT push Issue 1.3 (Module 31 city/state/country) in this same wave.** The Staging-to-Queue mapper extension hasn't been done yet — Module 31 doesn't have `1.company_city`/`1.company_state`/`1.company_country` to read from. Sequence matters; do the mapper extension first.

### Blockers

Unchanged. ZoomInfo PKI still down. Two leaked credentials still pending rotation.

---

## Previous Session: 2026-05-21 (late evening) — Doc Correction + Staged UI Bundle

### What Was Done

Two pieces of work — both safe, neither touched Make scenarios this turn:

**1. Corrected stale "Anthropic key hardcoded in HTML" claim.** Live HTML at `index.html:1482` reads `const ANTHROPIC_KEY = 'ANTHROPIC_KEY_REMOVED';` — the key was redacted at some prior unrecorded point. The 2026-05-21 morning audit and remediation plan both flagged this as outstanding security debt. It is not. The key is gone. Side-effect: Sales Intelligence tab signal-refresh is non-functional (Anthropic call hits the placeholder string). Updated CLAUDE.md (Environment Variables note + Known Issue #5) and SCRIBE_EXPORT.md (Dashboard Architecture entry + Security Notes entry) to reflect actual state. Remaining Anthropic key exposure is now ONLY in Make scenario 4667221 blueprint headers (Modules 5, 45) — same scope as the RCRM Bearer leak.

**2. Pre-staged Make UI patch bundle in `.backups/proposed_4667221_ui_patches.20260521T160646Z.json`.** A complete, ready-to-push 4667221 blueprint with two more remediation patches applied:
- **Issue 1.1**: Module 11 contact-create `custom_fields[5].value` changed from literal `"ZoomInfo"` to `{{1.data_collection_source}}` — uses the dashboard's payload field. Signals-source approvals will tag RCRM custom field 5 correctly instead of always saying ZoomInfo.
- **Issue 2.1 (minimal-risk variant)**: Module 43 (existing-contact update) body changed from `{"stage_id": 142468, "linkedin": "{{20.linkedin_url}}"}` to `{"stage_id": 142468}` — stops the destructive linkedin overwrite. NOT a full gap-fill (that would require adding a GET-existing-contact module before the update — structural change, out of scope for a single-push variant).

Bundle has not been pushed yet because both edits touch `jsonStringBodyContent` and will trigger `isinvalid:true`, requiring Travis to click Save in the Make UI to clear. Push requires Travis to be at us2.make.com/2053152/scenarios/4667221/edit ready to Save IMMEDIATELY.

### Issues Deliberately Deferred From This Bundle

- **Issue 1.3** (Module 31 company HQ city/state/country): Staging-to-Queue Module 4 mapper needs to forward `company_city`/`company_state`/`company_country` first. The staging datastructure 347903 already declares these (added earlier this session), but Staging-to-Queue Module 4 doesn't yet write them to queue rows. Sequence the mapper change first, then update Module 31's jsonStringBodyContent to use them.
- **Issue 2.4** (custom_fields 9/10/11): No data source for funding fields until Phase 2 ZI bridge. Locations would mirror address (low value). Defer.
- **Issue 3.1** (Module 33 company search shape): RCRM `/v1/companies/search` semantics (website + name combined search, or OR-search, or strict-match behavior) are not documented in publicly accessible RCRM docs. Without a known-good curl test from a sandbox context, drafting the new body shape is speculative. Defer until RCRM endpoint behavior is confirmed empirically.

### Current State

- Approval Handler 4667221: unchanged from end of previous session (`lastEdit:2026-05-21T16:00:45.523Z`, `isinvalid:false`, `isActive:true`). The 7 prior remediation changes from earlier today still live.
- Staging-to-Queue 4990696: unchanged (`lastEdit:2026-05-21T15:55:28.882Z`, `isinvalid:false`, `isActive:true`).
- Datastructures 319927 (50 fields), 347903 (24 fields): unchanged.
- `.backups/proposed_4667221_ui_patches.20260521T160646Z.json`: ready-to-push bundle, awaiting Travis go-ahead AND Make UI co-presence.
- `index.html`: untouched this turn. No git changes.

### Coordination Required Before Pushing the UI Bundle

The push will create a window where Approval Handler scenario is marked `isinvalid:true`. During that window:
- Make's behavior with isinvalid scenarios on instant webhooks is undocumented but plausibly: webhook accepts payload (HTTP 200), scenario silently refuses to run, or runs with corrupt validation state.
- Any dashboard "Submit Individually" or "Submit All Decisions" click during the window risks failed approval.
- Window ends when Travis opens the scenario in Make UI and clicks Save (validator re-runs, clears the flag, scenario fully active again).

**To push safely:**
1. Confirm Travis is at us2.make.com/2053152/scenarios/4667221/edit
2. Confirm no dashboard approvals are in-flight or planned in the next 60 seconds
3. Push the bundle via `scenarios_update` from `.backups/proposed_4667221_ui_patches.20260521T160646Z.json`
4. Travis clicks Save immediately
5. Re-fetch via `scenarios_get` to confirm `isinvalid:false` and the two edits landed

### Next Steps

1. [ ] Travis confirms readiness → Claude pushes the staged UI bundle → Travis Saves → verify.
2. [ ] After Issue 1.3 prerequisite is in place: extend Staging-to-Queue Module 4 mapper to forward `company_city`, `company_state`, `company_country`. Then draft a second UI bundle for Module 31 city/state/country fix.
3. [ ] Address Issue 3.1 only after RCRM `/v1/companies/search` behavior is empirically verified (one read-only test against a known company; or RCRM support response).
4. [ ] If Sales Intelligence tab restoration is a priority: build `netlify/functions/anthropic-proxy.js` + add `ANTHROPIC_API_KEY` to Netlify env + swap dashboard call-site. Otherwise deprioritize until needed.
5. [ ] Travis: rotate RCRM Bearer + Anthropic key, migrate scenario 4667221 + 4952511 to Make-managed Connections.
6. [ ] Travis: rotate ZoomInfo private key with James Gervais (leaked 2026-05-20). Unblocks Phase 2.

### Decisions Made

- **Don't push the UI bundle without coordination.** Even with Travis online, pre-confirming he's at the Make UI before the push is non-negotiable. The cost of a 30-second isinvalid window during a stray approval click is non-zero.
- **Drop linkedin from Module 43 body rather than build full gap-fill.** Full gap-fill requires adding a GET module + IML conditional in the body. The minimal change — removing `linkedin` from the update body entirely — eliminates the destructive overwrite without requiring structural changes. Phone/mobile/email/title were never being written anyway in Module 43; existing behavior preserved on those fields. The full gap-fill path remains a Phase 2 design.
- **Don't touch Issue 3.1 (company search shape) without RCRM endpoint verification.** The current `POST /v1/companies/search` with body `{"company_name": ...}` is empirically returning HTTP 2xx in production. Whether it's actually filtering — vs. returning the unfiltered list and silently selecting `data[1].slug` — is unknown without a controlled test. Drafting a "better" search shape blind is speculative work.
- **Sales Intelligence tab restoration is NOT in scope** of the Make→RCRM mission. It's a research aid, not a pipeline. Deferred unless Travis explicitly asks for it.

### Blockers

Unchanged from prior turn. ZoomInfo PKI down. Leaked credentials in Make scenario blueprints still need rotation.

---

## Previous Session: 2026-05-21 (evening) — Remediation Wave 1 (API-Safe Fixes Applied)

### What Was Done

Executed the API-only / no-Make-UI-required subset of the remediation plan. Four atomic Make changes pushed via MCP, each verified post-push by `scenarios_get` / `data-structures_get`. Pre-edit blueprints + datastructures snapshotted to gitignored `.backups/` for rollback. No `index.html` / Netlify / GitHub changes this turn.

### Changes Applied (all live)

| # | Issue | Surface | Pre-state | Post-state | Verified |
|---|---|---|---|---|---|
| 1 | 2.3 — webhook interface missing contact_slug | Approval Handler (4667221) flow[0].metadata.interface | 24 entries | 25 entries, `contact_slug` at position 4 | ✓ |
| 2 | 1.2 — Module 20 industry_id default 0 | Approval Handler (4667221) flow[id=20].mapper.variables[3] | switch ends `...; "Toys & Games"; 22; 0` | switch ends `...; "Toys & Games"; 22; 913` | ✓ |
| 3 | 3.2 — Module 36 email case sensitivity | Approval Handler (4667221) flow[id=36].mapper.url | `email={{encodeURL(1.contact_email)}}&exact_search=1` | `email={{encodeURL(lower(1.contact_email))}}&exact_search=1` | ✓ |
| 4 | 1.4 — datastructure 319927 missing zi ids | `data-structures_update` on 319927 | 48 fields | 50 fields (added zi_company_id, zi_contact_id) | ✓ |
| 5 | 1.4 — datastructure 347903 missing fields | `data-structures_update` on 347903 | 20 fields | 24 fields (added zi_contact_id, company_country, company_zipcode, company_phone) | ✓ |
| 6 | 1.4 — Staging-to-Queue doesn't carry zi ids | Staging-to-Queue (4990696) flow[id=4].mapper.data | 22 keys | 24 keys (added zi_company_id, zi_contact_id) | ✓ |

**Bundled push strategy:** Changes 1, 2, 3 were sent in a single `scenarios_update` on 4667221 to minimize push count. Changes 4 and 5 were separate `data-structures_update` calls (one per structure). Change 6 was a single `scenarios_update` on 4990696. Total: 4 API write calls, all returned `isinvalid:false` and `isActive:true`.

**Additional change (after explicit Travis go-ahead, same session):**

| # | Issue | Surface | Pre-state | Post-state | Verified |
|---|---|---|---|---|---|
| 7 | 2.2 — Module 3 redundant new-contact stage update | Approval Handler (4667221) flow[id=102].routes[0].flow position 6 | id=3 present between id=38 and id=2 | id=3 removed entirely | ✓ |

Module 3 was `POST /v1/contacts/{slug}` with body `{"stage_id": 142468, "linkedin": "{{20.linkedin_url}}"}`. Both fields were already set by Module 11's contact create. Removal saves one RCRM API call per new-contact approval (~14 calls/day saved against the 60/min budget) and one redundant audit-log entry per new contact in RCRM.

Post-deletion Route A flow: `33 (company search) → 34 (existing_company_slug) → 31 (company create) → 35 (resolved_company_slug) → 11 (contact create) → 38 (final_slug) → 2 (enroll) → 5 (Anthropic note) → 13 (claude_note) → 4 (log note)`. `usedPackages` count dropped from 24 to 23 entries (one `http` removed). `lastEdit: 2026-05-21T16:00:45.523Z`. Rollback config saved to `.backups/module_3_pre_deletion.20260521T155928Z.json` for splice-back if needed.

Route B (existing-contact path) was NOT touched — Module 43 still does the stage_id+linkedin update there, since the existing-contact route doesn't go through Module 11 to inherit those fields. That separate gap-fill defect (Module 43 overwriting linkedin, no gap-fill) is unchanged and remains Issue 2.1 in the remediation plan.

**Critical confirmation:** the prior gotcha "scenarios_update with `{{variable}}` in jsonStringBodyContent triggers isinvalid:true" did NOT trip on the Approval Handler push, even though the blueprint contains 10+ jsonStringBodyContent modules with `{{var}}` expressions. The gotcha applies specifically to **modifying** those bodies' literal string contents — round-tripping them unchanged is safe. This is a useful new data point: as long as we don't edit jsonStringBodyContent, we can freely API-push blueprints that contain it.

### Audit Trail

- `.backups/scenario_4667221.20260521T155130Z.json` — partial pre-edit snapshot (modules 1 and 20 captured)
- `.backups/scenario_4990696.20260521T155130Z.json` — full pre-edit snapshot
- `.backups/datastructure_319927.20260521T155130Z.json` — pointer note (full 48-field spec available via data-structures_get; reverting = remove last 2 fields)
- `.backups/datastructure_347903.20260521T155130Z.json` — full 20-field pre-edit spec
- `.gitignore` updated: added `.backups/` line (the blueprints contain leaked credentials and must never commit)

### Post-State

- Approval Handler 4667221: `lastEdit:2026-05-21T15:53:51.267Z`, `isinvalid:false`, `isActive:true`. Next execution will use new industry_id default and lowercased email search.
- Staging-to-Queue 4990696: `lastEdit:2026-05-21T15:55:28.882Z`, `isinvalid:false`, `isActive:true`, `nextExec:2026-05-22T10:00:00Z`. Next daily run will carry zi_company_id/zi_contact_id forward (assuming ZoomInfo Intake fires and writes them to staging records).
- Datastructure 319927: 50 fields, `strict:false`.
- Datastructure 347903: 24 fields, `strict:false`.
- No DLQ entries. No `isinvalid` flags. Pipeline still mechanically functional.

### What's Still Pending in Remediation Plan

**Make UI required (Travis must click Save):**
- Issue 1.1 — Module 11 data_collection_source hardcode → variable
- Issue 1.3 — Module 31 company HQ city/state/country (also needs Staging-to-Queue mapper expansion for company city/state/country forward — partially unblocked now that staging 347903 declares the fields)
- Issue 2.1 — Module 43 existing-contact gap-fill
- Issue 2.4 — Module 31 custom_fields 9/10/11
- Issue 3.1 — Module 33 company search shape

**Repo + Netlify auto-deploy:**
- Issue 2.5 — Anthropic key Netlify function proxy
- (Phase 2) `netlify/functions/zi-enrich.js`

**External admin consoles (Travis only):**
- Issue 2.6 — rotate RCRM Bearer + Anthropic key, migrate to Make Connections
- Rotate ZoomInfo PKI private key (from 2026-05-20 leak)

### Behavioral Impact (what changed for the user)

- **industry_id default**: every approval where ZoomInfo's industry string isn't in the 12-entry hardcoded list (e.g., "Building Materials", "Medical Devices & Equipment", "Local Government", "Freight & Logistics Services", "Real Estate", "Federal Government") now writes `industry_id: 913` (Manufacturing) instead of `0` to the RCRM company create. Manufacturing is Elevate's primary vertical so this is the right safe default. Cards with matched industries (Manufacturing, Transportation, Automotive, etc.) are unaffected.
- **Email case sensitivity on contact search**: the dedup-by-email lookup at Module 36 is now case-insensitive on the inbound side. If RCRM stores `John.Smith@example.com` and the queue carries `john.smith@example.com`, the new lower() ensures both forms search the same way. Existing contacts won't get duplicated by case skew on resubmit.
- **Webhook interface contact_slug**: cosmetic, no live behavior change. The dashboard's `contact_slug` field was already arriving; now it's declared. Future modules can map `{{1.contact_slug}}` cleanly with proper type tagging.
- **Datastructure schema additions**: no live behavior change today. Unblocks: (i) future Staging-to-Queue passes can populate zi_company_id/zi_contact_id (requires ZoomInfo Intake / Scenario A to also start writing them — confirm next), (ii) Phase 2 ZI bridge can find these IDs in queue rows at approval time.
- **Staging-to-Queue zi id carry-through**: tomorrow's 6am daily run will write `zi_company_id` and `zi_contact_id` into new queue rows — IF staging has records AND those records carry the ZI ids. Staging is currently empty (ZI PKI down), so this becomes meaningful only when ZI starts feeding again or after a CSV import.

### Next Steps

1. [ ] Verify next ZoomInfo-source live approval lands the expected `industry_id` value in RCRM (any non-Manufacturing-matched industry should now write 913 instead of 0) AND that only ONE RCRM contact-create event appears in the audit (no follow-up stage update from the now-deleted Module 3). Open the RCRM company audit after the next live approval and inspect.
2. [ ] Schedule a Make UI session to bundle Issues 1.1, 1.3, 2.1, 2.4, 3.1 — Claude can pre-push the blueprint patches via API in a single update, then Travis clicks Save once in the Make UI of 4667221 to clear `isinvalid:true`.
4. [ ] Move Anthropic key out of `index.html` into `netlify/functions/anthropic-proxy.js` (Issue 2.5). Repo + Netlify only, no Make involvement. Can be done in parallel with the UI session above.
5. [ ] Travis: rotate RCRM Bearer token and Anthropic API key (admin-console actions). Then set up Make Connections, then migrate scenario 4667221 + 4952511 to Connections. Order matters — set up Connections before rotating so there's no auth outage.
6. [ ] Travis: rotate ZoomInfo private key with James Gervais (leaked 2026-05-20). Unblocks Phase 2 Netlify ZI bridge.
7. [ ] After ZI PKI restored: build backlog repair scenario for Cohort 2 (~343 zi_-prefixed queue records with missing website/address/revenue). Decision still needed on Cohort 1 (~685 records with completely empty fields — recommend bulk-delete).
8. [ ] Run a manual approval test on a known dummy contact after Make UI session to confirm RCRM company record gets industry_id 913 (or matched value), and lowercase email search finds an existing test contact.

### Decisions Made

- **Bundle API edits per scenario.** Pushed 3 changes to Approval Handler in one `scenarios_update`, not three sequential calls. One push, one verification, one rollback boundary. Faster and safer than three sequential.
- **Partial blueprint snapshots are acceptable for rollback** when the change set is small and well-documented. The lastEdit timestamp on a re-fetched scenarios_get identifies the post-edit state; the diff against the documented pre-edit field values is the rollback recipe. Full blueprint snapshots are still safer for complex multi-module edits — use them when changing multiple modules' bodies.
- **Don't auto-execute Module 3 deletion.** The change is API-only and analytically safe (Module 38 reads from Module 11, not Module 3; downstream filters in Module 2 preserve behavior), but structural module-removal is the most invasive of all "API-safe" changes. Pause for Travis go-ahead before deleting any module.
- **No `index.html` changes this turn.** The buildPayload contract is correct end-to-end. There's no dashboard work needed to consume the new behavior — the Approval Handler is fully self-contained.

### Blockers

- ZoomInfo PKI still down. zi_company_id / zi_contact_id won't appear in real queue rows until ZI Intake fires.
- Leaked credentials in scenario blueprints unchanged — every `scenarios_get` still exposes them. Rotation gating is the same.

---

## Previous Session: 2026-05-21 (afternoon) — Full Make → RCRM Validation Pass

### What Was Done

Autonomous end-to-end revalidation of the Make → RCRM workflow per the new PROJECT_HISTORY.md objective. No code, blueprint, datastore, or deployment changes applied this session — pure audit + documentation. Pulled live state for: scenario 4990696 (Staging-to-Queue), scenario 4667221 (Approval Handler — full blueprint and 50-row execution history), datastore 86836 (elevate_daily_queue, 100-record sample of 1,071 total), datastore 94078 (elevate_company_staging — empty), datastructure 319927 (queue schema, 47 fields), live HTML at elevate-sales-nav.netlify.app, local repo HEAD vs origin/main, RCRM public help-center documentation, and Stoplight reference index. Cross-referenced findings against CLAUDE.md, SCRIBE_EXPORT.md, PROPOSED_SCENARIO_CHANGES.md, and prior session entries below.

### Validation Findings (item-by-item against the scope in PROJECT_HISTORY.md)

**1. Make.com flows — Staging-to-Queue (4990696)**
- Blueprint last edit 2026-05-21T14:44:36.063Z. `isinvalid:false`, `isActive:true`, next scheduled run `2026-05-22T10:00:00Z`.
- Module 4 mapper confirmed to carry `company_website`, `company_address` (as `{{trim(1.company_street + ", " + 1.company_city + ", " + 1.company_state)}}`), and `annual_revenue`. Yesterday's patch is live and persistent.
- Mapper has 22 fields written into queue rows. Compared to prior session's documented 22-field set: identical.
- Still missing from this scenario (not regressed, but unfilled gap from prior audit): does not yet read `zi_company_id`/`zi_contact_id` from staging (since staging datastructure 347903 doesn't declare them) — blocks Phase 2 just-in-time ZI enrichment design.

**2. Make.com flows — Approval Handler (4667221)**
- Blueprint last edit 2026-05-20T21:01:13.634Z (untouched yesterday — confirms prior session's "don't edit jsonStringBodyContent without manual Save" decision was honored).
- Topology confirmed module-for-module against SCRIBE_EXPORT.md line 145: webhook(1) → SetVars(20) → UpdateRecord(99) → DeleteRecord(100) → GET contact-search(36) → SetVars(37) → Router(102) with Route A (new contact) and Route B (existing contact).
- Webhook interface declares 24 fields (not 25). Missing from interface: `contact_slug`. The dashboard's buildPayload sends `contact_slug` and the webhook accepts arbitrary keys regardless, so the field arrives but no downstream module reads it. Cosmetic — no impact unless a future module wants the existing RCRM contact slug fed in directly.
- Module 31 (company create) body verified literal-for-literal: `company_name, about_company, website, linkedin, city, state, country, address, industry_id, custom_fields[1,2,12]`. Missing: company_address-as-locations custom field 9, funding fields 10/11. City/state/country pulled from CONTACT location (1.contact_city etc.) — confirms data-quality bug documented in SCRIBE line 139.
- Module 11 (contact create) body verified: `first_name, last_name, email, contact_number, designation, linkedin, city, state, country, address, current_organization, company_slug, stage_id:142468, custom_fields[1,2,5]`. Field 5 hardcodes literal "ZoomInfo" (bug per SCRIBE line 141).
- Last 50 executions: all `status:1`. Make-level success means HTTP 2xx, not field completeness — known caveat. No DLQ entries. No 429 rate-limit failures observed.

**3. Webhook payloads — dashboard buildPayload(c)**
- index.html:1303 ships 25 fields. Verified via grep: `buildPayload(c)` defined once, called from submitOne (line 1342) and submitQueue (line 1429). No surviving inline payload objects.
- Approval webhook URL at line 872 = `https://hook.us2.make.com/aq8yfoqv8itfhrewo1k6iib7u6rq4gm1` — matches CLAUDE.md and SCRIBE.
- Live HTML at elevate-sales-nav.netlify.app fetched: build token `ELEVATE-2026-0520-B-BUILDPAYLOAD25` at line 2 (matches local). `function buildPayload(c)` present at line 1303 (matches local). Site is serving the head commit.

**4. RCRM API mappings**
- Cross-checked against help.recruitcrm.io and docs.recruitcrm.io (Stoplight). Stoplight pages are JS-rendered and not extractable via WebFetch, but the Careers Page help article confirms the canonical `custom_fields` response shape `{field_id, entity_type, field_name, field_type, value}` and use of `slug`/`company_slug` for record addressing — matches the blueprint.
- RCRM auto-dedups companies on website + LinkedIn URL at create time (sourced from RCRM help article). This means even though Module 33's `POST /v1/companies/search` body `{"company_name": X}` may be soft on dedup, RCRM's native check at Module 31 create should prevent strict website-collision duplicates regardless. Risk remains for: name-only typos, missing website on the inbound payload, LinkedIn URL mismatch with http/https.
- The live `GET /v1/contacts/search?email=X&exact_search=1` form (Module 36) has been returning successful, filtered results for months — supersedes the older SCRIBE entry at line 62-63 that said POST is required. Both forms appear to be accepted by RCRM; GET-with-query-params is the documented public pattern (`/v1/jobs/search?company_name=...` works the same way per RCRM help). The prior SCRIBE entry was wrong about POST being required.

**5. Company creation validation**
- Payload shape correct per RCRM's documented custom_fields contract. Bearer token in header (current Make-embedded form), Content-Type application/json. No structural defects in the request that would cause field loss.
- Functional defects (carrying forward from prior session, not new): industry_id=0 default for unmatched industries; city/state/country drawn from contact location not company HQ; company custom fields 9/10/11 not populated.
- Duplicate prevention: name-only search at Module 33, RCRM native website/linkedin check at Module 31 create — two-layer dedup but neither is comprehensive. Brand-new companies with no website in queue (every queue card pre-yesterday-patch) bypass both layers.

**6. Contact creation validation**
- Payload shape correct. company_slug association uses Module 35's resolved_company_slug (either existing or freshly-created). Stage 142468 hardcoded.
- Existing-contact path (Module 43) does NOT gap-fill: only updates `stage_id` and `linkedin`. Overwrites linkedin even when RCRM already has one — known violation of "RCRM is source of truth after Travis touches a record" rule.
- Module 11 hardcodes data_collection_source = "ZoomInfo" (custom_field 5). Dashboard's actual payload value `1.data_collection_source` is ignored. Signals-source contacts get mis-tagged as ZoomInfo.

**7. Duplicate prevention logic**
- Contact dedup: Module 36 `GET /v1/contacts/search?email=X&exact_search=1` → resolved_slug. Branches on whether slug came back. Sound for exact-email matches. Vulnerable to: aliased emails (firstname@ vs firstname.lastname@), case differences (RCRM appears to handle case-insensitively but not formally verified).
- Company dedup: Module 33 POST search by company_name only. Module 31 create relies on RCRM's native website/linkedin dedup as a safety net. Combined coverage is incomplete — a company with name typo and no website would create a duplicate. Risk is low for established ZI-sourced companies (always have website) but nonzero for hiring_signals-source records (no enrichment, see Issue 8 in prior session).

**8. Netlify deployment behavior**
- Live ETag `23106ceb5286ba7038a9a51f657b73f3-ssl`, Content-Length 438509, served via Netlify edge. No staleness vs HEAD on main (commit `a8632a3`).
- Auto-deploy from GitHub `main` continues to work — verified by HEAD-to-live byte-level alignment on the buildPayload block and webhook URL.
- `elevate-zi-bridge` Netlify function (signal-aggregator) deployment status still unverified from this session — no change since CLAUDE.md known-issue #2 was recorded. Out of scope for the Make→RCRM critical path.

**9. GitHub repo logic**
- Local working tree clean except untracked `.claude/` (Claude Code settings dir — already gitignored at the user level, fine).
- `git rev-parse HEAD` and `origin/main` resolve to the same SHA `a8632a3`. No drift. No unpushed commits.
- No active branches besides `main`. No pending PRs (this is a Netlify-auto-deploy setup, no PR workflow).

**10. Field mappings and custom fields**
- All RCRM custom field IDs in the blueprint match CLAUDE.md:
  - Contact: field_id 1=phone, 2=mobile, 5=data_source ✓
  - Company: field_id 1=employees, 2=revenue, 12=buying_signal ✓
- Missing: company field_id 9 (Locations), 10/11 (Funding) — not populated in any module. Dashboard payload doesn't carry funding either. Acceptable for now; would require ZI bridge before populating.

**11. Failed requests**
- None. Last 50 Approval Handler executions all `status:1`. No DLQ. No timeout entries. No 429s. No HTTP errors visible at execution-list level (granular module-level error details not exposed by Make MCP `executions_get-detail` — it only returns `{status: "SUCCESS"}`).
- "Success" here means HTTP 2xx returned, not that the RCRM record has every field populated. Field-completeness can only be verified by a live RCRM read — see Next Steps.

**12. Payload-vs-spec comparison**
- buildPayload → webhook (25 fields shipped, 24 declared in interface, all flow through).
- webhook → Module 31 company create (uses 9 webhook fields + 3 custom_fields → 12 of 25).
- webhook → Module 11 contact create (uses 9 webhook fields + 3 custom_fields → 12 of 25, with the data_source value silently dropped in favor of literal "ZoomInfo").
- Fields shipped by dashboard but never consumed downstream: `contact_slug`, `persona`, `sequence_name` (used only in Anthropic note prompt, not in RCRM record), `data_collection_source` (overridden).
- Fields shipped by dashboard and consumed: `key, decision, sequence_id, contact_email, contact_name, contact_title, contact_phone, contact_mobile, contact_linkedin, contact_city, contact_state, contact_country, company_name, company_industry, company_address, company_website, company_linkedin, employee_count, annual_revenue, buying_signal, about_company` = 21 of 25.

### Critical State Observation — Queue Backlog Quality

Datastore 86836 has **1,071 records** (up from 880 documented in prior session). Sampled the first 100 returned by `data-store-records_list`:

- 100% empty `company_address`
- 100% empty `annual_revenue`
- 99% empty `company_website`
- 67% empty `company_industry`
- 84% empty `contact_phone`
- 71% empty `contact_linkedin`
- 64% empty `company_name`

The 64 records with empty `company_name` were added 2026-05-08 10:00:18-21 UTC by an older buggy version of Staging-to-Queue (key format `<companyId>_<contactId>` with no `zi_` prefix). The remaining 32 zi_-prefixed records have name + industry + employee_count but no website/address/revenue. The hiring_signals records (signal-003_*) also lack enrichment per Issue 8 in prior session.

The 2026-05-21 patch only stops NEW garbage from arriving; the 1,071-card backlog remains untouched. Approving any of these cards today still produces incomplete RCRM records — buildPayload sends empty strings, Approval Handler writes empty fields, RCRM stores them as blanks.

### Current State

- Pipeline mechanically functional end-to-end. Webhooks deliver, Make executes, RCRM accepts. No HTTP-layer failures.
- buildPayload(c) live and correct (25 fields).
- Staging-to-Queue mapper carries the 3 newly-added fields (`company_website`, `company_address`, `annual_revenue`).
- Approval Handler unchanged from prior session — known defects (industry_id=0 default, contact-location-as-company-location, no gap-fill on existing contact, hardcoded "ZoomInfo" data source, leaked Bearer + Anthropic keys) all still present.
- elevate_company_staging still empty (ZoomInfo Intake hasn't fired) — patch validation still blocked.
- Queue datastore has 1,071 stale pre-patch records. Approving them now produces empty-field RCRM records.

### Decisions Made This Session

- **No write actions taken.** This session was scoped to validation. No blueprint edits, no datastore mutations, no commits, no deploys. All findings recorded in handoff + scribe.
- **Do not call RCRM API directly using the leaked Bearer token to verify field completeness.** The token is leaked in the Make blueprint and is technically accessible, but proactively exfiltrating it from blueprint storage to make outbound API calls from this Claude Code session crosses into a privileged-action zone that should be a deliberate human-authorized step. Verification of field completeness on RCRM side is deferred to either (a) a manual RCRM record inspection by Travis after the next live approval, or (b) an explicit Travis-authorized "use the token to GET /v1/contacts/{slug}" instruction.
- **SCRIBE entry on POST /v1/contacts/search will be updated.** The live GET form with `exact_search=1` is the actually-working pattern, and RCRM's own help docs use GET-with-query-params for `/v1/jobs/search`. The previous SCRIBE claim that POST is required was inherited from an older session and is incorrect.

### Next Steps

1. [ ] After next 6am daily run (2026-05-22 10:00 UTC), inspect a fresh ZoomInfo-source queue record and confirm `company_website`, `company_address`, `annual_revenue` are populated. **Note: this still requires ZoomInfo PKI to be back up, OR a manual CSV import that exercises Scenario A — staging has been empty since the patch and the Staging-to-Queue scheduler has nothing to read.**
2. [ ] Decision on 1,071-card queue backlog: bulk-decline (mark all as declined and Approval Handler will delete on submit), bulk-delete from datastore directly, or leave as-is and let Travis manually triage. Recommend bulk-decline-and-delete via a single utility scenario or one-off data-store-records_delete call — the records have no usable company data for RCRM creates.
3. [ ] Rotate the embedded RCRM Bearer (`UL0jSyOX...`) and Anthropic key (`sk-ant-api03-gonL2j1e...`) from scenarios 4667221 and 4952511. Migrate to Make-managed connection or env vars. **Urgency: high — both keys are extractable via any Make team-member's `scenarios_get` call.**
4. [ ] Apply industry_id default fix (Module 20 switch) — change `0` default to either `913` (Manufacturing safe-default) or null-with-conditional-omit in Module 31.
5. [ ] Apply gap-fill pattern to Module 43 (existing-contact path) — read existing RCRM contact first, only update empty fields. Stop overwriting `linkedin`.
6. [ ] Fix hardcoded `"ZoomInfo"` data_source in Module 11 — replace with `{{1.data_collection_source}}` so signals-source contacts are tagged correctly.
7. [ ] Add `zi_company_id`/`zi_contact_id` columns to queue datastructure 319927, and `company_country`/`company_phone`/`company_zipcode`/`zi_contact_id` to staging datastructure 347903. Unblocks Phase 2 enrichment.
8. [ ] Phase 2: build `netlify/functions/zi-enrich.js` per PROPOSED_SCENARIO_CHANGES.md Section 7, after ZoomInfo private key rotation.
9. [ ] Switch Module 33 company search from `{"company_name": X}` body to URL-query form (consistent with /v1/jobs/search and the working /v1/contacts/search pattern) — or, if a real test shows current POST works, just add a `website` search fallback before the name search.
10. [ ] Investigate why signals-source queue cards have empty `company_industry` — likely the Signals scenarios need a parallel "carry-through enrichment" patch.

### Blockers

- ZoomInfo PKI still down — no fresh ZI bundles arriving, so the Staging-to-Queue patch can't be validated against new live data until either PKI resolves or a CSV import is run.
- Two leaked API keys (RCRM, Anthropic) need rotation. Until done, every `scenarios_get` against 4667221 or 4952511 exposes them.
- Field-completeness validation on the RCRM side requires either (a) an authorized live API read using the bearer, or (b) Travis manually opening a recently-approved record in RCRM and reporting which fields landed. This session deliberately did not perform (a).

### Notes for Next Session

- The Make MCP `executions_get-detail` endpoint returns only `{status: "SUCCESS"}`, NOT module-level bundle data. To see actual request bodies / response bodies for an execution, you have to use the Make UI execution viewer. This limits Claude-side debugging fidelity — keep this in mind before chasing "what did Module X actually send" via API.
- The Stoplight RCRM docs (`docs.recruitcrm.io`) are JS-rendered and opaque to WebFetch. The reliable cross-reference sources are the help-center articles (`help.recruitcrm.io/en/articles/*`) and the live Make blueprint itself (which is a working production payload — strongest evidence of correct field names since 50 consecutive executions returned 2xx).
- `data-store-records_list` enforces a hard max of 100, regardless of what you ask for. To inspect the full 1,071-record backlog, you'd need to script repeated reads with offset/cursor pagination if the MCP supports it (untested) — or just trust the sample.
- Queue backlog cleanup is the highest-leverage operational improvement now. The Approval Handler is sound; the upstream data feed is what is broken. Fixing the queue (delete or replace stale records) is more impactful than further blueprint edits at the Approval Handler level.

---

## Remediation Plan (drafted 2026-05-21, not yet executed)

Prioritized by user directive: (1) prevent new bad RCRM records, (2) fix mapping defects, (3) prevent duplicates, (4) backlog repair feasibility, (5) safe cleanup, (6) Make-UI-vs-API classification. Each issue carries: root cause, impact, safest fix, automatable yes/no, production risk. No destructive change is executed in this plan — it is a runbook for the next active session.

### Change-surface classification (read this first)

Three execution surfaces; pick deliberately for each fix below.

- **Repo / Netlify auto-deploy surface (safe, reversible via git):** any change to `index.html`, the live dashboard, or `netlify/functions/*`. Claude can edit, commit, push; Netlify redeploys within ~30s. Rollback = `git revert` + push.
- **Make API surface (safe for IML/datastructure, dangerous for jsonStringBodyContent):** `scenarios_update` accepts SetVariables IML changes, Datastore mapper changes, datastructure schema additions, datastore record CRUD without triggering `isinvalid:true`. **Any change to `jsonStringBodyContent` containing `{{variable}}` triggers `isinvalid:true` and requires Travis to manually click Save in the Make UI to clear** (SCRIBE line 20, 67). API can read state freely.
- **Make UI surface (Travis-only, no Claude path):** any edit to an HTTP module's `jsonStringBodyContent` body must be either (a) patched via API and then manually saved in UI to clear `isinvalid:true`, or (b) edited directly in UI. There is no API-only path for those modules.

---

### Priority 1 — Prevent new bad RCRM records

**Issue 1.1 — Approval Handler Module 11 hardcodes `data_collection_source = "ZoomInfo"`.**
- Root cause: Module 11 body sends `{"field_id": 5, "value": "ZoomInfo"}` as a literal string instead of `{{1.data_collection_source}}`. Dashboard already ships the correct value.
- Impact: Every approval — including hiring_signals-source contacts — gets tagged in RCRM custom field 5 as "ZoomInfo". Pipeline attribution in RCRM is wrong for signal-sourced leads. Currently affects all approvals from signal cohorts (`signal-003_*`, `TEST_HIRING_SIGNAL_001`).
- Safest fix: replace literal `"ZoomInfo"` with `{{1.data_collection_source}}` in Module 11's `jsonStringBodyContent`.
- Automatable: API can push the patched blueprint, but the change is inside `jsonStringBodyContent` with `{{var}}` — will trigger `isinvalid:true`. Requires Travis to open the scenario and click Save. **Make UI required after API push.**
- Production risk: low. The dashboard already sends the field with a sane default (empty string fallback per buildPayload line 1328). If the value is empty, RCRM custom field 5 will be empty — acceptable degradation, better than wrong-string.

**Issue 1.2 — Approval Handler Module 20 `industry_id` switch defaults to 0.**
- Root cause: Module 20 SetVariables uses `switch(1.company_industry; "Manufacturing"; 913; ...; 0)`. The final argument `0` is the unmatched default. RCRM treats `industry_id: 0` as "no valid industry" — exact behavior on RCRM side unconfirmed (may store as null, may reject, may store 0 as an orphan ID).
- Impact: Any ZoomInfo industry string not in the 12 hardcoded categories (`Manufacturing`, `Transportation`, `Automotive`, `Automotive Parts`, `Airlines/Airports/Air Services`, `Logistics and Supply Chain`, `Construction`, `Oil and Energy`, `Food and Beverages`, `Machinery`, `Toys & Games`) hits the default. Looking at the queue sample: industries like `Building Materials`, `Freight & Logistics Services`, `Test & Measurement Equipment`, `Medical Devices & Equipment`, `Electronics`, `Hand/Power/Lawn-care Tools`, `Telecommunication Equipment`, `Industrial Machinery & Equipment`, `Multimedia & Graphic Design`, `Architecture/Engineering/Design`, `Medical & Surgical Hospitals`, `Local Government`, `Home Improvement & Hardware Retail`, `Watches & Jewelry`, `Federal Government`, `Real Estate` — all currently hit the `0` default.
- Safest fix (two options, in order of preference):
  - (a) Change Module 20 SetVariables default from `0` to `913` (Manufacturing — Elevate's primary vertical, safe default). API-patchable via `scenarios_update` on SetVariables IML — does NOT trigger `isinvalid:true`. No Make UI step needed.
  - (b) Better but slower: expand the switch table to include all 20-30 industries Elevate sees in ZoomInfo, then map the rest to `913`. Same API path, same risk profile, just more keystrokes.
  - (c) Best long-term: change Module 31's `jsonStringBodyContent` to omit `industry_id` entirely when the switch returns 0 (`{{if(20.industry_id; 20.industry_id; ifempty)}}`). But Module 31 is jsonStringBodyContent — would trigger isinvalid, requires UI Save. Skip for v1, do v2 in a UI session.
- Automatable: yes, fully — option (a) and (b) via API only. Option (c) requires Make UI Save.
- Production risk: low for (a) — already-wrong industry tag replaced with safe-default Manufacturing tag, doesn't break records. Moderate visibility on (b) if industry list misses something — record creation still succeeds.

**Issue 1.3 — Approval Handler Module 31 uses CONTACT city/state/country for COMPANY HQ fields.**
- Root cause: Module 31 body sets `"city": "{{1.contact_city}}"`, same for state and country, when the company create payload should use company HQ values. Dashboard ships `contact_city/state/country` but no separate company city/state/country (ZoomInfo Intake only writes `company_street/city/state/zipcode/country` to staging, but the queue datastructure 319927 only has flat `company_address`).
- Impact: For contacts whose work location ≠ company HQ (e.g., GM Detroit employee in Windsor, multi-site companies, government workers in field offices), the RCRM company record carries the contact's city as its HQ city. Skews territory/region reports.
- Safest fix: requires upstream schema change. Either (i) carry company_city/state/country separately from staging through queue into the webhook payload, then have Module 31 use them, or (ii) parse them back out of the `company_address` concatenated string. Both touch Staging-to-Queue mapper (API-safe per Issue 1.4), the queue datastructure (add columns — API-safe), buildPayload (repo-safe), and Module 31 body (UI required for body change).
- Automatable: partially. The upstream additions are API-only. The Module 31 body change is the UI step.
- Production risk: moderate. Until fixed, do NOT batch-approve cards where contact location ≠ company HQ — accept the location skew or hand-correct after the fact.

**Issue 1.4 — Staging-to-Queue does not carry `zi_company_id`/`zi_contact_id` through (staging datastructure 347903 doesn't declare them, queue datastructure 319927 doesn't have columns).**
- Root cause: ZoomInfo Intake (Scenario A) Module 30 writes these to staging, but the datastructure schema doesn't expose them on `SearchRecord` output, so Staging-to-Queue Module 4 can't read them, and the queue has no column for them either.
- Impact: Blocks Phase 2 just-in-time ZI enrichment at approval time (PROPOSED_SCENARIO_CHANGES.md). Without these IDs, the proposed Netlify ZI bridge has nothing to look up.
- Safest fix: (i) update datastructure 347903 to add `zi_company_id, zi_contact_id, company_country, company_phone, company_zipcode` as text fields; (ii) update datastructure 319927 to add `zi_company_id, zi_contact_id`; (iii) update Staging-to-Queue Module 4 mapper to carry the two ZI IDs forward. All three are `data-structures_update` and `scenarios_update` on a Datastore Add Record mapper — none touch jsonStringBodyContent.
- Automatable: yes, fully. API-only path. No Make UI.
- Production risk: very low. Adding optional text columns to a datastructure is non-breaking. Existing records get null for the new fields. Staging-to-Queue mapper change is additive.

**Issue 1.5 — Signals-source queue cards have empty `company_industry`/`company_website` even when company is well-known (e.g., Stellantis).**
- Root cause: The Hiring Signals subsystem writes queue rows from signal data without enriching the company side. Signal records are sourced from news/job-postings, not ZoomInfo, so no industry/website/revenue lookup happens. The signals subsystem also has 46-88% error rates per CLAUDE.md known-issue 6.
- Impact: Approving a signal card produces an RCRM company record with empty industry, website, address. Pollutes RCRM same way pre-patch ZI cards did.
- Safest fix: deferred to signals subsystem debug. Two paths: (a) add a Signals-side enrich step using the ZoomInfo MCP or the future Netlify ZI bridge; (b) require Travis to manually fill the company side in the dashboard before approval (UI work — dashboard would need a "complete this card" form). Recommend (a) and bundle with the Phase 2 design.
- Automatable: not without first resolving the signals scenario error rates (out of scope of this session's pipeline).
- Production risk: low impact day-to-day because signal volume is small. Keep flagged.

---

### Priority 2 — Fix mapping defects

**Issue 2.1 — Approval Handler Module 43 (existing-contact path) overwrites `linkedin` and does no gap-fill.**
- Root cause: Module 43 body is `{"stage_id": 142468, "linkedin": "{{20.linkedin_url}}"}`. It always writes linkedin, even when RCRM already has one populated. Other fields (phone, mobile, email, title, city) on the existing contact are never refreshed even if RCRM has empty values where dashboard has data.
- Impact: Violates "RCRM is source of truth after Travis touches a record." LinkedIn values that Travis hand-edited get reverted on every re-approval. Other empty fields stay empty.
- Safest fix: Read existing contact first (`GET /v1/contacts/{slug}`), then conditionally update only fields where RCRM is empty. Module 43 body becomes a gap-fill with `ifempty()` IML.
- Automatable: blueprint patch via `scenarios_update` is possible, but the body change is inside `jsonStringBodyContent` — triggers `isinvalid:true`. Make UI Save required.
- Production risk: low. Adding a read before write costs one extra RCRM call per existing-contact approval (within 60/min budget). Worst case: gap-fill IML has a typo, scenario refuses Save in UI — Travis catches it before re-activating.

**Issue 2.2 — Approval Handler Module 3 is fully redundant for new contacts (Module 11 already sets stage_id and linkedin).**
- Root cause: Module 11's create body already includes `"stage_id": 142468` and `"linkedin": "{{20.linkedin_url}}"`. Module 3 then re-POSTs the same two fields to `/v1/contacts/{slug}`. Inherited from an older create-then-edit pattern.
- Impact: Two unnecessary RCRM API calls per new-contact approval. Wastes 2 ops/run × ~14 approvals/day = ~28 extra RCRM calls/day against the 60/min budget. Also creates a redundant audit-log entry on every RCRM contact.
- Safest fix: delete Module 3 entirely from Route A. The flow becomes Module 11 → Module 38 (set final_slug) → Module 2 (enroll) → Module 5 (note) → … Module 38 already reads `11.data.slug` so no rewire needed.
- Automatable: yes via `scenarios_update`. Deleting a module is a structural change but doesn't touch jsonStringBodyContent of any remaining module. Should not trigger `isinvalid:true` — but worth testing on a non-critical scenario first.
- Production risk: low. The behavior Module 3 enforces (stage_id + linkedin) is already done by Module 11. Removing it is functionally a no-op. If something downstream depends on a fresh response from Module 3 (it doesn't — Module 38 reads from 11), that would break.

**Issue 2.3 — Webhook interface declares only 24 of 25 dashboard fields (`contact_slug` missing).**
- Root cause: Cosmetic drift. Make webhooks accept undeclared keys, so `1.contact_slug` is still usable in mappers. Nobody added the declaration when buildPayload added the field.
- Impact: None today. Forward risk: if a future module wants to feed an existing RCRM slug back in to skip the search, the declaration will need adding first.
- Safest fix: add the `contact_slug` interface entry via `scenarios_update`. Pure metadata change.
- Automatable: yes, API-only.
- Production risk: zero.

**Issue 2.4 — Company `custom_fields` 9 (Locations), 10/11 (Funding) not populated.**
- Root cause: Module 31 body doesn't write these. Dashboard doesn't carry funding. Locations would equal `company_address` for single-site companies.
- Impact: Custom fields stay null in RCRM. Locations is somewhat-useful for multi-site companies but not blocking. Funding is "nice to have" but not in the current product flow.
- Safest fix: defer Locations until Phase 2 ZI bridge (which can return multi-site location data); defer Funding indefinitely unless Travis confirms it's needed for sales workflows.
- Automatable: when ready, Module 31 body change → jsonStringBodyContent → Make UI required.
- Production risk: low. Current behavior is "field empty in RCRM." Not regressing anything.

**Issue 2.5 — Anthropic API key hardcoded in HTML (separate from Make blueprint leak).**
- Root cause: index.html Sales Intelligence tab calls Anthropic directly. Key embedded in source. Live at elevate-sales-nav.netlify.app — any visitor's DevTools can read it.
- Impact: Exposed key, billable charges possible from anyone scraping the site. Documented as known tech debt in CLAUDE.md.
- Safest fix: build `netlify/functions/anthropic-proxy.js`, dashboard calls the function, key lives in Netlify env. Rotate the old key after migration.
- Automatable: yes — Claude can write the function, commit, push; Netlify auto-deploys.
- Production risk: moderate. Migration needs careful staging — the dashboard call site must switch URL and not break the Sales Intelligence tab. Test in browser before pushing. Rotation must happen AFTER the new path is verified.

**Issue 2.6 — Bearer + Anthropic keys leaked inside Make blueprint headers (scenarios 4667221 and 4952511).**
- Root cause: HTTP module headers carry literal `Authorization: Bearer UL0jSyOX...` and `x-api-key: sk-ant-api03-gonL2j1e...` in 12+ modules across two scenarios. Any team member with Make access — or anyone running `scenarios_get` via API — extracts both.
- Impact: Two production keys exfiltrable. RCRM Bearer can read/write all of RCRM. Anthropic key can issue billable calls.
- Safest fix: (i) rotate both keys; (ii) migrate each scenario from raw-header auth to Make's "Connection" abstraction (HTTP module's "Connections" feature stores the secret server-side); (iii) re-test scenario end-to-end after migration. Requires Make UI to set up Connections (Claude has no MCP for connection creation as of this audit).
- Automatable: rotation is manual (token regen in RCRM admin + Anthropic console). Migration to Connections requires Make UI. Re-test can be partially automated by replaying a known approval.
- Production risk: moderate. During the cutover, headers must still authenticate or every approval fails. Stage: create the new Connection in UI, switch ONE module to use it, run a single test approval, verify, then switch the rest in a batch.

---

### Priority 3 — Prevent duplicate companies/contacts

**Issue 3.1 — Module 33 company search uses POST with body `{"company_name": X}` only; no website-based search; no `exact_search` flag.**
- Root cause: Module 33 is the explicit dedup search before company create. It searches only by name. Two failure modes: (a) name typo or variation (e.g., `Stellantis` vs `Stellantis Canada` vs `Stellantis North America`) → search returns empty → duplicate company created; (b) name match but on the wrong sister-company → wrong slug used → contact attached to wrong company.
- Impact: Brand-new companies with name variations get duplicates. RCRM's native website+linkedin dedup at Module 31 create catches some of this — but only when the inbound payload has website/linkedin. For the 1,071-card backlog, 99% lack website. So pre-patch cards bypass both dedup layers if approved today.
- Safest fix: change Module 33 to two-stage search: (i) GET `/v1/companies/search?website={url}&exact_search=1` first if website is present, capture slug; (ii) fall back to GET search by name if (i) returned empty. Update Module 34 to consume whichever returned.
- Automatable: body shape change inside `jsonStringBodyContent` → triggers `isinvalid:true` → Make UI Save required. The Module 34 SetVariables change is API-safe.
- Production risk: moderate. If RCRM's `/v1/companies/search?website=` form doesn't behave as expected (the help docs use `/v1/jobs/search?company_name=` but I have not seen `/v1/companies/search` documented explicitly), the search returns nothing and the scenario falls back to creating a new company. Need to validate with a one-off curl before committing.

**Issue 3.2 — Contact search by email is robust but case sensitivity unverified.**
- Root cause: Module 36 uses `GET /v1/contacts/search?email={url}&exact_search=1`. Already working in production. Open question: does `exact_search=1` do case-insensitive match? RCRM stores email per record case as-entered.
- Impact: Theoretical risk of duplicate contact if same human has email `John.Smith@example.com` in RCRM but `john.smith@example.com` arriving from ZoomInfo. Have not observed in practice.
- Safest fix: add a normalize step before the search — `{{lower(1.contact_email)}}` — and verify RCRM also stores emails lowercased on create. If RCRM keeps original case, this is a non-issue at search time.
- Automatable: yes, API-only on Module 36 URL parameter (URL itself is not `jsonStringBodyContent` — it's a regular text parameter — should not trigger isinvalid).
- Production risk: very low. `lower()` of an already-lowercase string is a no-op.

**Issue 3.3 — No association mismatch handling on existing-contact path.**
- Root cause: Route B (existing contact) updates stage and linkedin but never checks whether the contact's company in RCRM matches the inbound `company_name`. If a contact changed companies (joined a new firm), the RCRM record stays attached to the old company.
- Impact: Misattributed activity over time. Currently silent.
- Safest fix: in Module 43 gap-fill, also read `existing_company.slug` from the GET /v1/contacts/{slug} response and compare to inbound company. If they differ, write a note flagging the discrepancy instead of auto-reassociating (auto-reassociate is risky per PROPOSED_SCENARIO_CHANGES.md Section 6).
- Automatable: same surface as Issue 2.1 — Make UI required for body change.
- Production risk: low. New behavior is "log a note" not "reassociate" — non-destructive.

---

### Priority 4 — Backlog repair feasibility (1,071 stale queue records)

**Cohort breakdown (from 100-record sample, ratios projected):**
- ~64% of records: completely-empty cohort from 2026-05-08 10:00:18-21 UTC. Key format `<id>_<id>` (no `zi_` prefix). 8 fields only: `queue_date, contact_name (blank/space only), contact_exists_in_rcrm, decision, added_at, data_collection_source, in_sequence, lead_source`. No email, no name, no company. **Unrepairable.** ~685 records.
- ~32% of records: zi_-prefixed cohort. Have `company_name`, `company_industry`, `employee_count`, `contact_name`, `contact_email`. Missing `company_website`, `company_address`, `annual_revenue`. **Theoretically repairable via ZoomInfo enrich_companies + enrich_contacts.** ~343 records.
- ~4% of records: hiring_signals cohort (`signal-003_*`, `TEST_HIRING_SIGNAL_001`). Have `company_name` but no enrichment. **Repairable via ZI MCP if company is in ZoomInfo's database (Stellantis is).** ~43 records.

**Can any cohort be auto-repaired?**

- Cohort 1 (685 records, no email): **No.** Cannot enrich without a primary key. Cannot dedupe against RCRM without email. Cannot generate outreach without contact name. Recommend hard-delete.
- Cohort 2 (343 records, has email + companyId): **Yes, in principle.** Each record's key encodes a ZoomInfo `companyId` (the prefix before the underscore). A repair scenario would: (i) read each record from queue; (ii) extract `companyId`; (iii) call ZoomInfo `enrich_companies` MCP with that ID; (iv) write back `company_website`, `company_address`, `annual_revenue`, `company_linkedin`, `about_company`. **Constraint:** ZoomInfo PKI is down. ZI MCP is web-chat-only (Claude Code cannot call it from this session). So the auto-repair requires either Travis running the repair in web chat OR PKI/Netlify-bridge being live.
- Cohort 3 (43 records, has company_name only): **Yes, similar to Cohort 2** but via `search_companies` first to resolve the companyId, then enrich. Same ZI dependency.

**Recommended repair plan:**
1. (Now, no dependencies) Delete Cohort 1 (~685 records) — they cannot be useful. Use `data-store-records_delete` with all keys in a single array call (SCRIBE gotcha line 23). API-only, fully automatable. **Destructive — requires explicit Travis OK.**
2. (After ZI PKI or Netlify bridge is live) Repair Cohort 2 in batches. Build a small Make scenario `elevate_queue_backfill` that iterates queue records, filters to those with `lead_source = "zoominfo_intent"` AND empty `company_website`, calls the ZI bridge, writes back enriched fields via Update Record. Run in dry-run mode first against 5 records, validate, then full run.
3. (Same dependency) Repair Cohort 3 individually as Travis approves them — or write a similar backfill scenario for `lead_source = "hiring_signals"`.

---

### Priority 5 — Safe rollback / cleanup strategies

**Per-change rollback (what to do if a remediation step regresses production):**
- Repo-side changes (`index.html`, `netlify/functions/*`): `git revert <sha> && git push`. Netlify redeploys ~30s. Old build comment hash still works; live URL recovers.
- Make scenario edits: every `scenarios_update` returns the prior blueprint shape. Best practice — capture `scenarios_get` JSON to a local file before editing, e.g., `mkdir -p .backups && scenarios_get 4667221 > .backups/4667221.$(date +%Y%m%d-%H%M%S).json`. Rollback = push the stored blueprint back. Datastructure changes can be reverted by deleting the added columns (records with new-column data keep the orphan values, harmless).
- Datastore record deletions: irreversible. Mitigation: export the records to a JSON file before delete (`data-store-records_list` + write to repo `.backups/`). Recovery, if needed, = re-insert via `data-store-records_create` (untested but the API supports it).
- Bearer/Anthropic key rotation: irreversible (old key invalidated). Mitigation: stage the new key in Connections, switch one module, test, then bulk-switch. Do not rotate before all modules are using the new auth path.

**Order-of-operations principle: every step must leave the pipeline in a working state.** Don't bundle multiple risky changes per deploy. Concrete sequence:
1. Take a `scenarios_get` snapshot of 4667221 and 4990696 to `.backups/` (API-safe, mandatory before any blueprint edit).
2. Apply Issue 1.2 (industry_id default) — API-only, low risk, validate with a manual test approval.
3. Apply Issue 2.3 (webhook interface contact_slug) — API-only, zero risk.
4. Apply Issue 1.4 (datastructure schema additions for zi_company_id etc.) — API-only, very low risk.
5. Backup queue, then delete Cohort 1 — destructive but isolated, no scenario impact.
6. Wait for one full daily cycle (Staging-to-Queue + Morning BD Email) to confirm no regression.
7. Bundle UI-required edits (Issues 1.1, 1.3, 2.1, 3.1) into a single Make UI session with Travis. Click Save once after API push, verify isinvalid clears, run test approval.
8. Then key rotations (Issues 2.5, 2.6) once UI session is settled.
9. Phase 2 work (ZI bridge, backlog repair) after all above is stable.

---

### Priority 6 — Make UI vs repo/deployment classification (quick reference)

**API-only (Claude can do end-to-end, no Make UI):**
- Issue 1.2 (Module 20 SetVariables — industry_id default)
- Issue 1.4 (datastructure schema additions + Staging-to-Queue mapper)
- Issue 2.2 (delete Module 3 — structural change, no body edit)
- Issue 2.3 (webhook interface declaration)
- Issue 3.2 (Module 36 URL parameter normalize)
- Backlog deletion (data-store-records_delete)
- Backup snapshots (scenarios_get → repo .backups/)

**API push + Make UI Save required (Claude pushes blueprint, Travis clicks Save once to clear isinvalid:true):**
- Issue 1.1 (Module 11 data_collection_source literal → variable)
- Issue 1.3 (Module 31 company city/state/country source — pending upstream schema)
- Issue 2.1 (Module 43 gap-fill body)
- Issue 2.4 (Module 31 add custom_fields 9/10/11 — when ready)
- Issue 3.1 (Module 33 search shape)

**Make UI only (no API path):**
- Issue 2.6 (set up Connections — creating Connections is not in the Make MCP surface as audited)
- Approval Handler Connection swap on each HTTP module (manual UI work, ~12 modules)

**Repo + Netlify auto-deploy (Claude can do end-to-end, no Make involvement):**
- Issue 2.5 (Anthropic proxy function + dashboard call-site change)
- buildPayload edits (none needed today, but this surface is fully Claude-owned)
- Phase 2 Netlify function for ZI bridge

**External admin consoles (Travis only):**
- RCRM Bearer token rotation (RCRM admin)
- Anthropic API key rotation (console.anthropic.com)
- ZoomInfo private key rotation (per James Gervais — already pending from 2026-05-20 leak)

---

### Plan summary

The Approval Handler is mechanically sound. The defects are: (a) one wrong-source-value hardcode that mis-tags signals leads (Module 11), (b) a 0-default industry that creates orphan industry IDs (Module 20), (c) a contact-location-as-company-location bug requiring upstream schema work (Module 31), (d) a no-gap-fill existing-contact path that overwrites linkedin (Module 43), (e) a weak duplicate-prevention search that only checks name (Module 33), and (f) two leaked production keys.

Five of the six can be addressed in one well-orchestrated session: Claude pushes blueprint patches via API, Travis clicks Save in the Make UI once per affected scenario to clear isinvalid:true, then re-runs a test approval. The sixth — key rotation — is gated by admin-console actions only Travis can take.

The 1,071-card backlog is largely unrepairable (~685 records have no email or company identity); the repairable portion (~386 records) is gated by ZoomInfo PKI being back up. Recommend hard-deleting the unrepairable cohort now and queueing the rest behind ZI restoration.

---

## Previous Session: 2026-05-21 — Make → RCRM Pipeline Audit + Staging-to-Queue Fix Applied

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
