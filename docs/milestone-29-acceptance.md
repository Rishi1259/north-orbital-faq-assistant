# Milestone 29 Independent Acceptance

## Overall verdict

PASS

Local application/runtime acceptance passed. Gates 1, 2, 3, 4, 6 and 7 pass; Gate 5 passes with manual browser follow-up. No implementation repairs were made.

## Scope

Independent verification performed on 2026-10-12 (Asia/Kolkata), repository `Rishi1259/north-orbital-faq-assistant`, branch `main`, HEAD `6d0bfd9`. Evidence consists of source review, freshly executed tests/builds/audits, inspection of the populated local PostgreSQL database, and an independently authored live HTTP harness. Neither `docs/milestone-29-verification.md` nor its claimed counts was used as proof. The existing `verify-leads.mjs` was inspected but was not used as the live acceptance harness.

This covers local application/runtime acceptance. No real browser automation tool was exposed and no browser visual session was exercised. JSDOM/component tests are not visual browser acceptance. Deployed Azure/TLS behavior and a production restore rehearsal were not performed.

Only this acceptance report was added to the repository. Temporary independent harness/evidence files were written under `/tmp`. No application source, existing tests, migrations, manifests, lockfiles, or design documents were changed. No staging, commit, push, tag, reset, history rewrite, destructive migration rollback, volume deletion, or service restart occurred.

## Gate summary

| Gate | Verdict |
|---|---|
| Gate 1 — Schema / configuration / commercial | PASS |
| Gate 2 — Public lead capture security | PASS |
| Gate 3 — Human handoff workflow | PASS |
| Gate 4 — Admin / privacy / deletion | PASS |
| Gate 5 — Widget / Angular UX | PASS WITH MANUAL FOLLOW-UP |
| Gate 6 — Quotas / abuse / operations | PASS |
| Gate 7 — Full regression / runtime | PASS |

## Critical security findings

No critical security finding observed in the executed acceptance checks.

## Gate 1 evidence

Executed `git status -sb`, `git diff --stat`, `git diff --check`, `docker compose ps -a`, and PostgreSQL queries through `docker compose exec -T postgres psql -U north_orbital -d north_orbital`. Initial and final health/readiness requests to `http://localhost:3001/api/health` and `/api/ready` returned **200**.

`SELECT count(*) FROM pgmigrations` returned **8**. The migration names consist of the seven accepted migrations plus `1791500000000_lead-capture-human-handoff`. The already-running migration container had exited **0**. Verification did not roll back or reapply migrations to the populated schema. Source inspection of `backend/migrations/1791500000000_lead-capture-human-handoff.js` confirms an additive migration: plan columns, an expanded finite usage CHECK, and four new tables; earlier tenant/content tables are not dropped or rewritten. Its `down` function refuses rollback without a data-preservation plan.

Live `\d+` inspection confirmed:

| Table | Scoping, columns and integrity |
|---|---|
| `lead_capture_settings` | Composite primary key `(organization_id, chatbot_id)` and composite chatbot FK with `ON DELETE CASCADE`; enable/collection/required booleans; bounded title/message/success/consent text; positive `consent_version`; `updated_by` user FK with SET NULL; creation/update timestamps. |
| `leads` | UUID primary key; composite unique `(organization_id, chatbot_id, id)`; composite chatbot FK with cascade; finite source/status; bounded name/email/phone/company/message; explicit consent flag/version/time; creation/update timestamps. Consent flag must agree with presence of `consent_at`. |
| `handoff_requests` | UUID primary key; composite `(organization_id, chatbot_id, lead_id)` FK to the corresponding lead, with cascade; finite status; bounded reason; optional assignee; positive revision default 1; requested/acknowledged/resolved and creation/update timestamps. Acknowledged/resolved states require their corresponding timestamps. |
| `lead_submission_receipts` | Composite primary key `(organization_id, chatbot_id, kind, key_hash)`; kind limited to lead/handoff; 64-character hexadecimal hash CHECK; 24-hour expiry; composite chatbot FK with cascade. No contact data or lead/handoff resource IDs. |

Indexes cover tenant/chatbot creation-time pagination with UUID tie-breakers, status filtering, handoff lead lookup, organization/assignee, and receipt expiry. Settings reject required-but-uncollected fields, handoff without capture/contact collection, and required consent without text. Leads have finite statuses `new`, `contacted`, `qualified`, `closed`; handoffs have `requested`, `acknowledged`, `resolved`, `cancelled`. Leads use row locking for updates; handoffs additionally use optimistic revisions.

Assignment combines a same-organization membership lookup held `FOR KEY SHARE` (`backend/src/leads/service.ts:89`) with a database FK `(organization_id, assigned_user_id)` to `organization_memberships(organization_id,user_id)`. Membership deletion sets only the assignee column NULL, preserving the organization association.

Independent live invalid writes returned **23503** for a foreign assignee and sibling-chatbot lead/handoff mismatch, and **23514** for arbitrary lead status, arbitrary handoff status, impossible collection settings, and arbitrary usage metric. The rerun integration suite additionally rejected cross-organization handoff associations and negative plan limits.

Actual commercial fields: `lead_capture_enabled`, `human_handoff_enabled`, `monthly_lead_limit`, `monthly_handoff_limit`. Both capabilities are explicitly represented; live plans have:

| Plan | Lead limit | Handoff limit | Both capabilities |
|---|---:|---:|---|
| beta | 100 | 25 | enabled |
| starter | 500 | 100 | enabled |
| growth | 2500 | 500 | enabled |
| business | 10000 | 2500 | enabled |

`backend/src/commercial/model.ts:3` and the database CHECK both enumerate permitted usage metrics, including `leads_created` and `handoffs_requested`; `CommercialService.meter` validates the metric before SQL.

The initial and final accepted counts were organizations **3**, subscriptions **3**, documents **5**, chunks **14**, embeddings **14**, cleanup jobs **0**. Independent SHA-256 fingerprints of sorted full rows in organizations, subscriptions, documents, chunks and embeddings were identical before/after the live harness, not merely equal counts.

## Gate 2 evidence

Public routes are `GET /api/public/chatbots/:publicId/config`, `POST .../leads`, and `POST .../handoff`. `backend/src/public/repository.ts:20` accepts only the opaque `pub_` identifier format and resolves only enabled public chatbots. The router is mounted before session authentication. Independent public requests used no cookie, session or CSRF token.

**Origin and public identity:** `backend/src/public/router.ts:20` applies the same exact-origin middleware to config, chat, leads and handoff. It requires the normalized origin to equal the received string and a stored allowlisted origin; no suffix/wildcard comparison. Independent config/lead/handoff requests with wrong origin, a foreign subdomain, a trailing slash, and missing Origin produced **12 × 403**. Allowed config returned **200** and accepted lead/handoff submissions returned **202**. Disabled and rotated-old IDs were tested on both POST routes, plus an internal chatbot UUID: **5 × 404**. Missing Origin is rejected in this runtime; source preserves the existing explicit missing-origin policy switch. The service rechecks current public ID, enabled state and origin under the chatbot lock before creation.

**Public config:** explicit branding projection plus safe form settings only (`public/repository.ts:14`, `leads/service.ts:16`). The live response contained enable flags, titles/messages, field collection/requirement flags and consent text/requirement. It contained no organization UUID, internal chatbot/user UUID, subscription/hash values or consent version. No unnecessary internal identity is disclosed.

**Validation:** independently omitting each configured required name/email/phone/company/message returned **5 × 400**. Invalid email, name over 200 characters, NUL in message, oversized/non-UUID idempotency key, client-supplied consent version, malformed phone and handoff without a contact method returned **7 × 400**. Handoff reason requirements and phone-only capture are additionally covered by the rerun integration suite. Zod strict schemas reject unknown fields; field bounds are name/company 200, email 254, phone 40, message/reason 2000. Controls are rejected; single-line fields also reject newlines/tabs (`leads/model.ts`). All initial validation/origin failures left leads, handoffs, receipts and successful usage at **0**.

**Consent:** required consent false returned **400**; true returned **202**. A client `consentVersion` field returned **400**. Stored version equalled the current server settings version. Settings changes to consent text/requirement increment the server version. With consent optional and absent, independent submissions stored `consent_given=false` and `consent_at=NULL`. The email local part is preserved; only the domain is lowercased. The integration test verified mixed-case domain normalization; independent live storage preserved the mixed-case local part. No dot removal, plus-address stripping, or email-based identity merging occurs.

**Response privacy:** every independently accepted lead, replay and handoff response was exactly `{"status":"accepted"}` with **202**, without resource IDs, organization, subscription, assignee, quota or audit details. Error responses were bounded safe codes/messages.

**Rate limits:** PostgreSQL `rate_limit_windows`, HMAC-SHA256 of rate-limit kind/public ID/client identity with `RATE_LIMIT_HASH_SECRET`, and atomic upsert/hit increment (`security/repository.ts:112`). Raw IP is not a table column. Lead limit is **10 attempts/900 seconds**, handoff **5/900 seconds**; retries count as attempts. Concurrent independent boundary requests yielded lead **10 × 202, 2 × 429**, and handoff **5 × 202, 2 × 429**. Every rejected response had `RATE_LIMITED` and a positive `Retry-After`. Each batch reused one key and created/metered only one logical submission. Runtime logs contained zero raw-loopback-IP matches; integration also inspected stored limiter rows for absence of plaintext IP.

**Payload bounds:** M29-specific `express.json({limit:'12kb'})` middleware precedes the global parser (`backend/src/app.ts`). A roughly 14KB message returned **413** before creation.

**Idempotency:** UUID-only keys are hashed with SHA-256 and scoped by organization, chatbot and lead/handoff kind. The receipt lookup and insert occur under organization/subscription/chatbot locks in the same creation transaction. Independent simultaneous identical lead attempts returned **202/202**, with one lead and one lead usage increment. Handoff limiter replay likewise created one lead, one handoff and one increment of each metric. Separate keys with the same email produced **two distinct leads**. Integration independently rerun here covers four simultaneous retries for both kinds, receipt expiration after 24 hours, and retry after lead deletion without resurrection or extra metering. Receipts contain no resource ID; they intentionally survive lead deletion until expiry/chatbot deletion. Reusing a key means retrying the original logical submission, not changing its payload.

## Gate 3 evidence

Atomic creation is implemented in `backend/src/leads/service.ts:28` through `CommercialService.run`: BEGIN; organization row lock; subscription row lock; chatbot lock; checks; lead/audit/usage; handoff/audit/usage; receipt; COMMIT. Exceptions ROLLBACK the whole transaction (`commercial/repository.ts`).

The freshly executed PostgreSQL test `rolls back lead, usage, receipt and audits when handoff insertion fails` installs a rejecting trigger **only in its disposable test schema**, obtains HTTP **500**, and verifies **0 leads, 0 handoffs, 0 usage, 0 receipts, 0 lead-created audits** before removing the trigger. This failure injection was not installed on the populated public schema. The live backend's M29 compiled files match the locally compiled source hashes (8/8 selected artifacts including public router, service, security repository and widget).

Independent live workflow started `requested`, acknowledged **200**, assigned to a same-org member **200**, and resolved **200**. Assignment to each same-org owner/admin/member was accepted. Foreign and nonexistent assignees both returned **404 NOT_FOUND**, without disclosing foreign membership. The database FK separately rejected a foreign assignee with **23503**. Resolve-before-acknowledge and assignment-after-resolution returned **409**. The integration suite also executed cancellation and stale revision rejection.

Two simultaneous assignments using the same revision yielded exactly **one 200 and one 409**, with the winning value persisted. `FOR UPDATE`, revision comparison/increment, and membership key-share lock prevent inconsistent updates (`leads/service.ts:82`). Only successful mutations append transition audit events; the live assignment sequence had five successful assignment audits, matching the successful changes rather than rejected/concurrent attempts.

Independent tenant and sibling-bot probes covered lead GET/PATCH/DELETE and handoff GET/acknowledge/assign/resolve: **14 × 404**. Foreign privacy export also returned **404**. Tests separately exercised the inverse scoped-resource IDOR arrangements.

Owner and admin management worked through the backend. Member GETs for leads, handoffs, settings and assignment candidates returned **4 × 200**; settings PUT, lead PATCH/DELETE and handoff PATCH returned **4 × 403**. Those same four mutation classes with missing and invalid CSRF returned **8 × 403**. `authentication` precedes M29 admin routes; `tenantAuthorization` enforces current role/membership (`security/http.ts:24`). Public submission remains intentionally session/CSRF independent.

## Gate 4 evidence

Independent authenticated checks exercised paginated lists, individual lead/handoff reads, lead status update, settings update, handoff acknowledge/assignment/resolve, and normal lead deletion. Admin reads and mutations returned **200**; deletion **204**.

Pagination is parameterized and bounded to **1–100** rows, default **25**, offset **0–100000**, with `hasMore` from one extra row. A live limit=1 request returned one item and `hasMore=true`; excessive limits and arbitrary order/status values produced **4 × 400**. Ordering is fixed `created_at DESC,id DESC`, with finite status filters (`leads/router.ts:19`, `leads/service.ts:60`). Assignment membership pages cap at 100 and use stable user-ID ordering. No raw user-supplied SQL sort fragment is interpolated.

Privacy export is owner-only (`commercial/router.ts:25`). Independent owner export **200** contained settings, leads and handoffs; admin and member each received **403**, foreign organization **404**. `commercial/privacy.ts` uses explicit projections for every M29 section; the live export was checked for password/session/CSRF/API/idempotency hash field names, all absent. The export intentionally includes customer-owned contact data and safe audit IDs; it does not include limiter/receipt tables or credentials.

Normal API deletion of two initial leads returned **2 × 204**, removed the linked handoff, and produced **404** on subsequent lead/handoff reads. Lists and privacy export contained no deleted lead/handoff. A repeated DELETE returned **404**, as implemented; there is no promise here of repeated-DELETE 204. Safe usage/audit history remains. The two PII-free receipts remained immediately after deletion to prevent replay resurrection, and disappeared when disposable chatbots were cleaned. All later live-created leads were also removed through the normal administrative API before fixture organization cleanup.

Final SQL left-join orphan counts: handoff→lead **0**, lead→chatbot/org **0**, non-NULL assignee→organization membership **0**, receipt→chatbot **0**. Receipts have no lead/handoff resource reference, so resource-level receipt orphan checks are not applicable.

Audit metadata for M29 uses an explicit allowlist (`security/repository.ts:19`): empty creation/deletion/settings metadata, finite status, and assignment UUID only. Independent canary scans returned **0** matches. Final SQL examining **all retained M29 events** found **0** rows with metadata keys beyond `status` and `assignedUserId`. Successful transitions were counted; rejected attempts did not generate successful transition events.

The independent live log scan covered backend and worker logs after fictional submission. Every PII, credential, idempotency, body and IP match count was **0**; detailed counts appear below. Request logging serializes only request ID/method and response status, excludes headers/body/URL, and also configures redaction. Error handling logs bounded error categories, never database error/body content (`logging/logger.ts`, `app.ts`). The supplemental existing log-privacy script was re-executed, also with all-zero results.

## Gate 5 evidence

Fresh widget test execution: **11 passed / 1 file**. Angular: **32 passed / 4 files**. Production Angular build, backend TypeScript build and widget TypeScript/esbuild bundle all passed. Angular production output was **366.41 kB raw / 94.29 kB estimated transfer**; widget bundle **10.6 kB**.

`widget/src/widget.ts` preserves Shadow DOM and uses `document.createElement`, `textContent` and safe fixed attributes. Capture-disabled CTAs are absent; enabled capture provides Contact us, with a separate Talk to a person action when handoff is enabled. Forms follow field collection/required config, show consent, validate with textual errors, focus the first invalid control, and announce pending/success/failure through a status region. Pending submit is guarded; payload and UUID remain frozen through ambiguous failure so Retry resends the same request. Confirmed validation rejection unfreezes editable fields. Cancel/Escape discard values and restore CTA focus; success clears values and Back to chat restores the chat UI. Existing chat/history/citations remain bounded and are covered by the tests. No form values are stored in localStorage/sessionStorage; JSON POST carries PII, not query parameters. Requests explicitly omit credentials.

`frontend/src/app/leads.ts` implements settings, bounded lead and handoff pages, details, finite status selection, explicit hard-delete confirmation, membership assignment, acknowledge/resolve/cancel, role-sensitive controls, busy guards, loading/error feedback, and stale-response protection. API calls still rely on backend role/CSRF enforcement. Angular interpolation escapes visitor text; component tests rendered markup-like visitor content as text without creating script/image elements. Shared `admin-workbench.scss` is used by contact and existing knowledge management. Settings drafts and bot selection, paging resets after deletion/filtering, and 409 refresh guidance were inspected and tested.

Static searches over application sources returned **0 matches** for `innerHTML`, `insertAdjacentHTML`, `bypassSecurityTrust*`, `DomSanitizer`, `localStorage`, or `sessionStorage`. Accessible structure includes labels, required indications, associated error descriptions, `aria-invalid`, native buttons/selects, textual statuses, live feedback, focus placement for details/forms, and a titled/described native deletion dialog with Cancel initially focused. The widget form is inline, not a modal; no focus trap is claimed for it.

The frontend review skills' static auditor was also run:

```sh
python3 /Users/rishikeshgujar/.codex/plugins/cache/openai-curated-remote/frontend-design-premium/1.4.0/skills/frontend-design-premium/scripts/audit_project.py /Users/rishikeshgujar/Projects/north-orbital-faq-assistant --mode strict
```

It reported **5 findings**, all in unchanged `frontend/src/app/app.html`: three actionless-button detections are false positives because those buttons have Angular `(click)` handlers at lines 1, 17 and 65; the remaining two concern missing explicit `novalidate` and resizable textarea styling in the pre-existing chat form (`app.scss:240`). These were recorded, not repaired, and are outside M29's changed contact UI. This generic static audit is not being represented as a clean global UX certification.

**MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED.** Real rendering, narrow viewport layout, native dialog/select behavior, keyboard focus across browser navigation, contrast and screen-reader behavior were not visually verified. Gate 5 is PASS WITH MANUAL FOLLOW-UP under the requested local acceptance rule.

## Gate 6 evidence

Independent disposable plan records isolated quota/entitlement changes from the four persistent plans. Disabling lead capture blocked new lead submission with **403**; disabling handoff blocked handoff with **403**. Existing admin reads/export remained **200**. Rerun integration additionally verified deletion after downgrade and suspended subscriptions.

| Independent concurrent quota test | Attempts | Accepted | Rejected | Persisted lead/handoff | Metered lead/handoff |
|---|---:|---:|---|---|---|
| Lead quota 1 | 4 | 1 × 202 | 3 × 429 QUOTA_EXCEEDED | 1 / 0 | 1 / 0 |
| Handoff quota 1 | 4 | 1 × 202 | 3 × 429 QUOTA_EXCEEDED | 1 / 1 | 1 / 1 |

There was no overshoot. `CommercialService.locked` holds the organization then subscription row lock before usage totals are read; insertion and increments commit in that transaction. The SQL sum is therefore serialized, not an unprotected read-then-write race. Handoff consumes both allowances. Validation/origin failures, rate-limited retries and quota failures did not increase successful usage. Before cleanup the independent fixtures had aggregate **9 leads_created / 4 handoffs_requested**, exactly their successful logical creations.

Limiter implementation and concurrent boundary results are recorded under Gate 2. `rate_limit_windows` atomically increments with an UPSERT and caps stored denied hits at limit+1.

Prometheus review (`operations/metrics.ts`) found fixed route classes/status codes/event labels and finite handoff statuses. Handoff count and oldest open queue age are derived from database queries. No organization/chatbot/lead/handoff UUID, contact field or IP is used as a metric label. Integration tested the protected metrics endpoint: unauthenticated **404**, authorized **200**, finite requested-state count and queue-age output, with no fixture IDs/contact values. No external handoff background queue is required or introduced.

`docs/production-azure.md:67`–81 explicitly covers lead/reason PII, TLS transport and validated encrypted database connections, private database access, backups and historical deleted data, encryption at rest, least privilege, queue monitoring, quotas, PostgreSQL rate limits, deletion, owner export, PII-safe logs/audit, and deferred email/SMS/CRM/webhooks. It explicitly states that application field-level encryption is **not** implemented.

Source and dependency review found no new email/SMS/CRM/webhook delivery integration. Package manifests/lockfiles are unchanged versus HEAD. Searches for named providers (SendGrid, Postmark, Resend, Mailgun, Twilio, HubSpot, Salesforce, Zapier) returned no implementation/dependency matches; there is no SES delivery path. Existing AWS SDK usage is S3 object storage, not outbound notification delivery.

## Gate 7 evidence

Commands were run from the appropriate package directories. Correct runtime PATH used:

```sh
export PATH=/Users/rishikeshgujar/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/bin
# backend
npm run build
npm test
DATABASE_URL=<local PostgreSQL connection> npm run test:db
DATABASE_URL=<local PostgreSQL connection> npm run evaluate:rag
# frontend
npm run build
npm test -- --watch=false
# widget
npm run build
npm test
# repository
 docker compose config --quiet
 docker compose build backend worker migrate
# each package
npm audit --omit=dev --json
```

Connection credentials are intentionally omitted from the report. Actual commands connected to local PostgreSQL on port 55432. Backend database suites use unique disposable schemas or fixture transactions rolled back at test completion; the populated tenant baseline was not rolled back.

| Fresh execution | Result |
|---|---|
| Backend build | PASS |
| Backend unit tests | 278 passed, 23 files |
| PostgreSQL integration | 115 passed, 9 files |
| Production RAG evaluation | 48 passed, 2 files |
| Angular production build | PASS |
| Angular tests | 32 passed, 4 files |
| Widget build | PASS |
| Widget tests | 11 passed, 1 file |
| Compose config | exit 0 |
| Docker backend / worker / migrate builds | all built, exit 0 |

The RAG command reruns tests also represented in the broader suites; these counts are not summed as unique cases.

Initial constrained attempts were inconclusive for environment reasons: npm selected Node 20 before PATH was pinned; Angular rejected that version and widget JSDOM failed ESM loading. The sandbox blocked Supertest sockets, producing an initial 47 failed/231 passed backend result. These were rerun with Node 22.23.2 and required local network access, with the final counts above. An initial sandbox Angular build emitted only “Building…”; its separate unsandboxed rerun completed successfully. The temporary independent harness's first run had a PostgreSQL CommonJS import error before making fixtures; its temporary import was corrected and the complete run passed. No application failure was repaired or hidden. One read-only job inventory query used the wrong table name and was corrected to `document_ingestion_jobs`.

Runtime before and after: backend healthy, PostgreSQL healthy, MinIO healthy, worker running; migrate exited **0**, MinIO init exited **0**. Both health and readiness were **200** initially, at live completion, and at final verification. The rebuilt images were not used to restart populated services. Eight selected running artifacts matched local build hashes, establishing that the checked live implementation corresponds to the reviewed source.

Passing regression coverage was confirmed in:

| Behavior | Executed evidence |
|---|---|
| Sessions, CSRF, tenant isolation | `tests/security.test.ts`, integration `security.test.ts`, tenant isolation/HTTP suites, independent live role/CSRF probes |
| Public origin, disable, ID rotation | integration `security.test.ts`, `leads.test.ts`, independent live public probes |
| API-key authentication/scopes/expiry/revocation | integration `commercial.test.ts` |
| Commercial quotas | integration commercial/leads/website-knowledge suites and independent quota-one races |
| Document upload/ingestion/deletion | document API/ingestion unit tests; integration ingestion/commercial tests |
| OCR/document RAG | ingestion OCR selection/failure tests, document extraction tests, production RAG unit/PostgreSQL evaluation |
| Crawler SSRF and sync | `crawler-security.test.ts`, `crawler-crawl.test.ts`, integration website-knowledge tests |
| Manual FAQ, mixed sources, citation validation | integration website-knowledge and production RAG tests |
| Privacy export | integration commercial/leads/website-knowledge tests and independent live owner export |

A new end-to-end external-model/OCR upload run against accepted records was not performed; regression here is the executed automated coverage, not a claim of fresh external inference quality or a production OCR benchmark.

## Live acceptance

An independent temporary harness `/tmp/m29-independent-live.mjs` executed against the running backend on port 3001 and actual local PostgreSQL. It produced **20 passed check groups, 0 failed**, saved in `/tmp/m29-independent-results.json` and `/tmp/m29-independent-live.log`. It used generated fictional `@example.test` accounts/contacts, four disposable organizations across the workflow/quota cases, four disposable users, disposable chatbots and one isolated cloned plan. Public calls had no session; administrative calls used actual login-issued sessions/CSRF.

The controlled path configured collection/consent, read public config, submitted/replayed a lead, submitted a handoff, read both as admin, denied member mutation, acknowledged, assigned to the same-org member, rejected foreign assignment, resolved, exported as owner, checked audit/log privacy, deleted through the normal API, checked disappearance/cascade, and cleaned fixtures. Further probes covered exact Origin, field validation, bad CSRF, sibling chatbot access, revision races, finite database constraints, disabled/rotated IDs, limiter concurrency and quota-one concurrency.

Receipt retention after individual lead deletion is intentional for 24-hour replay protection; final fixture chatbot cleanup removed all receipts. Safe append-only audit events remain as designed. No accepted tenant records were used for destructive acceptance exercises.

## Persistent inventory

Final counts only:

| Table / inventory | Count |
| pgmigrations | 8 |
| organizations | 3 |
| organization_subscriptions | 3 |
| documents | 5 |
| document_chunks | 14 |
| document_embeddings | 14 |
| object_cleanup_jobs | 0 |
| website_sources | 0 |
| website_pages | 0 |
| website_crawl_jobs | 0 |
| manual_faqs | 0 |
| knowledge_chunks | 0 |
| lead_capture_settings | 0 |
| leads | 0 |
| handoff_requests | 0 |
| lead_submission_receipts | 0 |
| Disposable organizations | 0 |
| Disposable users | 0 |
| Disposable plans | 0 |
| Handoff→lead orphans | 0 |
| Lead→chatbot/org orphans | 0 |
| Assigned-user membership orphans | 0 |
| Receipt→chatbot orphans | 0 |

| Job / document state | Count |
|---|---:|
| document_ingestion_jobs succeeded | 4 |
| document_ingestion_jobs failed | 2 |
| document_ingestion_jobs queued | 0 |
| document_ingestion_jobs processing | 0 |
| website_crawl_jobs queued | 0 |
| website_crawl_jobs running | 0 |
| website_crawl_jobs successful | 0 |
| website_crawl_jobs failed | 0 |
| documents ready | 4 |
| documents failed | 1 |

The existing failed document remained byte-for-byte unchanged in the before/after database fingerprints; no reingestion was attempted. Final aggregate `leads_created` quantity **0**, `handoffs_requested` quantity **0** (no retained M29 usage rows after disposable organization cascade).

| Retained M29 audit action | Count |
|---|---:|
| handoff.acknowledged | 2 |
| handoff.assigned | 6 |
| handoff.requested | 5 |
| handoff.resolved | 2 |
| handoff.cancelled | 0 |
| lead_capture.settings_updated | 14 |
| lead.created | 11 |
| lead.deleted | 11 |
| lead.status_updated | 2 |
| Total | 53 |

These totals include prior retained safe audit records plus this acceptance run. Audit events intentionally have no tenant deletion cascade and are append-only. No audit deletion/bypass was attempted.

## Dependency audit

Fresh `npm audit --omit=dev --json` results:

| Package | Critical | High | Moderate | Low | Info |
|---|---:|---:|---:|---:|---:|
| backend | 0 | 0 | 3 | 0 | 0 |
| frontend | 0 | 0 | 0 | 0 | 0 |
| widget | 0 | 0 | 0 | 0 | 0 |

Backend findings are `mammoth`, `argparse`, `sprintf-js`, the inherited moderate Mammoth dependency chain. All six package manifests/lockfiles are unchanged from HEAD, corroborating that M29 introduced no dependency changes or new vulnerability. Backend audit's nonzero vulnerability exit is expected for these accepted inherited moderates. No audit fix command was run.

## PII privacy verification

Runtime backend/worker log match counts only; no canary values or credentials are disclosed:

| Check | Matches |
|---|---:|
| name | 0 |
| email | 0 |
| phone | 0 |
| company | 0 |
| visitorMessage | 0 |
| sessionCookie | 0 |
| sessionToken | 0 |
| csrfToken | 0 |
| credentialAndHash | 0 |
| idempotencyKey | 0 |
| idempotencyHash | 0 |
| Authorization | 0 |
| Cookie | 0 |
| rawRequestBody | 0 |
| apiKeySecret | 0 |
| rawIP | 0 |
| Supplemental API-key secret pattern | 0 |
| Supplemental known configured credential values | 0 |
| Supplemental credential/header fields | 0 |
| Supplemental document content canaries | 0 |
| Supplemental website/FAQ canaries | 0 |
| Supplemental vector pattern | 0 |
| M29 audit canary values | 0 |
| M29 audit rows with non-allowlisted metadata keys | 0 |

The unique name/email/company/message canaries were generated at runtime; the phone was a deliberately fictional fixed test value. Session cookie/token/CSRF and stored hash values were compared directly in memory. API-key leakage was additionally searched by its actual production secret format. The scans cover currently retained Compose logs, not remote observability infrastructure or unavailable historical rotations.

## Manual follow-ups

- **MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED**: widget and Angular desktop/narrow layout, native dialogs/selects, keyboard/focus, actual screen-reader announcements and contrast.
- Deployed Azure/TLS, reverse-proxy/client-IP configuration and production private-network behavior were not proven locally.
- Production backup restore rehearsal was not performed; backup access, encryption and deleted-data handling require deployment operations verification.
- Generic UI static audit findings in the unchanged chat form remain outside this milestone's repair scope.

## Known limitations

M29 does not include live human takeover, transcript viewer, conversation analytics, email/SMS notifications, CRM synchronization, webhooks/Zapier, helpdesk integrations, or a full legal/privacy compliance framework. These intentionally deferred features are not acceptance failures.

Receipts expire lazily on subsequent organization submissions and are removed on chatbot deletion. They deliberately retain retry protection after lead deletion. Lead deletion retains safe historical usage/audits; it does not erase historical backups or refund quota. Application field-level encryption is not implemented.

## Git state

Pre-flight `git status -sb`:

```text
## main...origin/main
 M DESIGN.md
 M UX-CONTRACT.md
 M backend/scripts/local-compose-env.mjs
 M backend/scripts/verify-log-privacy.mjs
 M backend/src/app.ts
 M backend/src/commercial/model.ts
 M backend/src/commercial/privacy.ts
 M backend/src/commercial/service.ts
 M backend/src/operations/metrics.ts
 M backend/src/public/router.ts
 M backend/src/security/repository.ts
 M backend/tests/integration/commercial.test.ts
 M backend/tests/integration/website-knowledge.test.ts
 M docs/production-azure.md
 M frontend/src/app/account.ts
 M frontend/src/app/knowledge.ts
 M widget/src/widget.ts
 M widget/tests/widget.test.ts
?? backend/migrations/1791500000000_lead-capture-human-handoff.js
?? backend/scripts/verify-leads.mjs
?? backend/src/leads/
?? backend/tests/integration/leads.test.ts
?? backend/tests/leads.test.ts
?? docs/milestone-29-verification.md
?? frontend/src/app/admin-workbench.scss
?? frontend/src/app/leads.spec.ts
?? frontend/src/app/leads.ts
```

Pre-flight `git diff --stat` (tracked changes):

```text
 DESIGN.md                                          |  4 ++
 UX-CONTRACT.md                                     | 17 +++++
 backend/scripts/local-compose-env.mjs              |  2 +-
 backend/scripts/verify-log-privacy.mjs             |  1 +
 backend/src/app.ts                                 |  5 ++
 backend/src/commercial/model.ts                    |  5 +-
 backend/src/commercial/privacy.ts                  |  4 ++
 backend/src/commercial/service.ts                  |  2 +-
 backend/src/operations/metrics.ts                  |  5 ++
 backend/src/public/router.ts                       | 12 +++-
 backend/src/security/repository.ts                 |  6 +-
 backend/tests/integration/commercial.test.ts       |  2 +-
 .../tests/integration/website-knowledge.test.ts    |  4 +-
 docs/production-azure.md                           | 16 +++++
 frontend/src/app/account.ts                        |  6 +-
 frontend/src/app/knowledge.ts                      |  8 +--
 widget/src/widget.ts                               | 76 +++++++++++++++++++++-
 widget/tests/widget.test.ts                        | 12 ++++
 18 files changed, 167 insertions(+), 20 deletions(-)
```

Pre-flight `git diff --check`: exit **0**, no output. The tracked diff remains **18 files changed, 167 insertions, 20 deletions**; untracked M29 files are not included in that stat.

Source-integrity check hashed **228 tracked/untracked non-ignored files** before verification and compared each afterward: **0 changed or removed**. The acceptance report is the only newly added non-ignored file. All application source remains exactly as found. Selected runtime artifact comparison: **8/8 matched** local builds.

Final `git status -sb`:

```text
## main...origin/main
 M DESIGN.md
 M UX-CONTRACT.md
 M backend/scripts/local-compose-env.mjs
 M backend/scripts/verify-log-privacy.mjs
 M backend/src/app.ts
 M backend/src/commercial/model.ts
 M backend/src/commercial/privacy.ts
 M backend/src/commercial/service.ts
 M backend/src/operations/metrics.ts
 M backend/src/public/router.ts
 M backend/src/security/repository.ts
 M backend/tests/integration/commercial.test.ts
 M backend/tests/integration/website-knowledge.test.ts
 M docs/production-azure.md
 M frontend/src/app/account.ts
 M frontend/src/app/knowledge.ts
 M widget/src/widget.ts
 M widget/tests/widget.test.ts
?? backend/migrations/1791500000000_lead-capture-human-handoff.js
?? backend/scripts/verify-leads.mjs
?? backend/src/leads/
?? backend/tests/integration/leads.test.ts
?? backend/tests/leads.test.ts
?? docs/milestone-29-acceptance.md
?? docs/milestone-29-verification.md
?? frontend/src/app/admin-workbench.scss
?? frontend/src/app/leads.spec.ts
?? frontend/src/app/leads.ts
```

Final `git diff --stat`: unchanged from the pre-flight stat above. Final `git diff --check`: exit **0**, no output. No unexpected tracked secret files were found: environment matches were example files and the existing environment-loading helper; actual local env/backup files remain ignored. No staging or commit was performed.

**M29 remains uncommitted.**
