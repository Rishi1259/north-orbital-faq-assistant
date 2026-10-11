# Milestone 29 — Lead capture and human handoff

Verification date: 2026-10-12 (Asia/Kolkata). Implementation is uncommitted on `main`; no commit, push, tag, history rewrite, branch deletion, volume removal, or accepted tenant data replacement was performed.

**Implementation and automated/runtime verification are finished. Independent acceptance remains pending. MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED.** Gates 1–4, 6 and 7 passed; Gate 5's component tests, security inspection and production builds passed, but its real-browser visual/interaction check is outstanding. The Browser skill/runtime was consulted; `getForUrl('http://localhost:4200')` returned “No browser is available,” and discovery returned an empty list. No browser or complete WCAG acceptance is claimed.

## Baseline and preservation

Initial `git status -sb` was exactly:

```text
## main...origin/main
```

Initial live inventory matched the accepted M28 baseline: 7 migrations; 3 organizations and subscriptions; 5 documents, 14 document chunks and 14 document embeddings; 0 object cleanup jobs, website sources/pages/crawl jobs, FAQs and knowledge chunks. The M29 migration advanced the live migration count to 8 without changing those counts. Prior migration files are unchanged. Tests use isolated PostgreSQL schemas or rollback transactions; controlled live checks use newly created disposable organizations/chatbots and fictional contacts, then remove only their fixtures. Existing documents were neither reingested nor replaced.

## Architecture and migration — Gate 1

New migration: `backend/migrations/1791500000000_lead-capture-human-handoff.js`.

It adds relational `lead_capture_settings`, `leads`, `handoff_requests`, and PII-free `lead_submission_receipts`; extends plans and the finite usage metric check. It does not add transcript or embedding storage. Rollback deliberately refuses automatic data loss and requires an explicit preservation plan.

Settings are keyed by `(organization_id, chatbot_id)` and include enabled/handoff flags; bounded title, form and acknowledgement messages; collected/required flags for name, email, phone, company and message; consent required/text/version; updating user and timestamps. Missing settings resolve to disabled capture/handoff without creating rows. Required fields must be collected. Handoff requires capture enabled and at least email or phone collected. Consent-required settings require nonempty consent text. All presentation is plain text, never HTML.

Leads store tenant and bot scope, a finite `widget`/`public_api` source, contact fields, visitor-written message, finite status, consent metadata and timestamps. They do not store IPs, cookies, headers, session/CSRF/API-key values, transcripts or vectors.

Handoffs reference `(organization_id, chatbot_id, lead_id)` with a composite FK. Assignment references `(organization_id, assigned_user_id)` in organization memberships; membership deletion clears only the assignment. The database rejects foreign-organization users even if application validation is bypassed. Scope/status/time indexes support deterministic pagination and queue inspection.

### Commercial model

All four existing plans explicitly enable capture and handoff, subject to subscription eligibility and these allowances per existing subscription period (normally 30 days, not necessarily a calendar month):

| Plan | Leads | Handoffs |
|---|---:|---:|
| beta | 100 | 25 |
| starter | 500 | 100 |
| growth | 2,500 | 500 |
| business | 10,000 | 2,500 |

Each handoff consumes **one lead plus one handoff**. The new finite metrics are `leads_created` and `handoffs_requested`. Account entitlements and usage expose these capabilities/allowances. Existing records, settings, export and deletion remain available after downgrade or suspension; only new creation is commercially gated.

## Public APIs and security — Gate 2

Existing public configuration `GET /api/public/chatbots/:publicId/config` includes `leadCapture`, containing only form flags/text. It excludes tenant/bot internal UUIDs, updating users, timestamps and consent version.

- `POST /api/public/chatbots/:publicId/leads`
- `POST /api/public/chatbots/:publicId/handoff`

Both return HTTP 202 and exactly `{"status":"accepted"}` on success; no internal resource IDs, assignment, subscription or quota counts are returned. They are mounted in the anonymous public router, outside session/CSRF-protected tenant routes. Public IDs are identifiers, not secrets. Existing exact Origin middleware, no-store caching, public-enabled checks, old-ID rotation behavior and separate public CORS are retained. Missing Origin is rejected by the accepted production policy; the existing explicit local-development exception remains unchanged. Identity, enabled state and allowed Origin are rechecked under the chatbot lock before writing.

JSON is limited to 12 KiB before the existing general 16 KiB parser. Unknown fields (including history, internal lead IDs and client consent versions) are rejected. Submissions require a UUID `idempotencyKey`; source defaults to `public_api`. Email local parts are preserved, with only the DNS domain lowercased. Phone values remain validated strings with international punctuation; no country-specific canonicalization is performed. Scalar controls/newlines and NUL are rejected where inappropriate; multiline message text allows ordinary line breaks. Limits: name/company 200, email 254, phone 40, visitor message/reason 2,000, title 120, form/consent text 1,000, acknowledgement 500 characters. Total encoded payload remains subject to the byte limit.

Collected/required fields are enforced server-side, and nonempty uncollected contact fields are rejected. **Every handoff must supply a configured email or phone and a nonempty reason**, even when neither field is individually required. It cannot be an anonymous callback. The bounded reason is visitor-written; the widget never sends chat history to either endpoint.

### Consent

`consentGiven` defaults false. Required consent demands true. Consent text/required-flag changes increment a server-owned version. Submission stores the current version and, only if consent was explicitly given, a timestamp. No client version is accepted. Optional consent is not falsely marked given. This is a basic consent mechanism, not a legal compliance claim.

### Rate limits and idempotency

PostgreSQL HMAC limiter scopes are public chatbot ID plus client/IP identity: lead attempts 10 per 900 seconds; handoff attempts 5 per 900 seconds. Raw IP does not appear in rate-limit rows. Rejection is 429 `RATE_LIMITED` with `Retry-After`. Attempts, including successful retries, count toward abuse limits; rejected attempts never consume commercial usage.

A receipt is scoped by organization, chatbot, endpoint kind and SHA-256 of the random UUID key. It contains neither contact data nor lead IDs. The first accepted submission wins; a retry with that key returns the same safe acknowledgement without creating/metering again. Clients must use a fresh key for a genuinely new request, not reuse a key for edited successful submissions. Receipts protect retries for 24 hours; expiry is pruned lazily on the organization's next submission. Capture/public disabling still blocks submissions. A receipt survives lead deletion until expiry, preventing delayed retries from recreating deleted contact data. This is not email-based deduplication or CRM identity resolution.

## Workflow, assignment and authorization — Gate 3

Lead statuses: `new`, `contacted`, `qualified`, `closed`. Owners/admins may move between any of these finite labels; unchanged status does not generate a new event.

Handoff transitions:

```text
requested → acknowledged → resolved
requested → cancelled
acknowledged → cancelled
```

Assignment or unassignment is permitted while requested/acknowledged. Resolved/cancelled requests are terminal. Resolve requires prior acknowledgement. Request, acknowledgement and resolution timestamps are explicit.

Owner/admin has full configuration, read, status, assignment, resolve/cancel and lead-deletion access. **Members are read-only**, including handoffs assigned to themselves. The existing tenant middleware is authoritative and all administrative mutations require session CSRF. Assignment validates membership in the transaction with a key-share lock and is reinforced by the composite membership FK. Foreign and nonexistent assignees return the same 404.

Handoff PATCH requires the current positive integer `revision`. Organization locking plus row `FOR UPDATE` serializes mutations; after one edit increments the revision, simultaneous stale edits receive 409 `CONFLICT`. Invalid transitions also return 409. Only committed transitions are audited.

## Staff APIs, privacy and deletion — Gate 4

All routes are beneath `/api/organizations/:organizationId/chatbots/:chatbotId`:

| Method | Suffix | Purpose |
|---|---|---|
| GET / PUT | `/lead-settings` | Read/configure capture |
| GET | `/leads` | Paginated/filterable leads |
| GET / PATCH / DELETE | `/leads/:id` | Details/status/hard deletion |
| GET | `/handoffs` | Paginated/filterable queue and contact summary |
| GET / PATCH | `/handoffs/:id` | Details/workflow/assignment |
| GET | `/handoff-members` | Bounded member choices for assignment |

Lead/handoff pages default to 25, maximum 100, offset maximum 100,000. Ordering is `created_at DESC, id DESC`; status uses a finite schema and bound SQL parameters. `hasMore` uses one extra row. Member choices are also paginated. No arbitrary SQL ordering/filtering exists.

Every resource query includes organization, bot and resource ID. Foreign organizations or sibling-chatbot IDs return 404; read lists never mix bots. Delete of an absent resource also returns 404 (no distinction between already-deleted and foreign IDs). Hard deletion cascades linked handoffs via the database FK, leaves no orphaned contact data and retains safe audit and historical usage. Historical usage is not refunded.

The existing **owner-only**, paginated, as-of privacy export adds `leadSettings`, `leads` and `handoffs`. Every added query projects explicit columns; no `SELECT *` is used for customer exports. Contact/message/consent data and assignment IDs are included for the correct organization. Password/session/CSRF/API-key hashes, receipt/rate hashes, headers, IPs, embeddings and internal secrets are excluded. After deletion, the active export excludes deleted leads and handoffs. Existing backup snapshots can still contain past data; this milestone does not invent a backup-retention framework.

### Audit and log privacy

Actions: `lead_capture.settings_updated`, `lead.created`, `lead.status_updated`, `lead.deleted`, `handoff.requested`, `handoff.acknowledged`, `handoff.assigned`, `handoff.resolved`, `handoff.cancelled`.

Audits identify scoped targets and authenticated staff actors where applicable. Metadata uses the existing allowlist plus finite status values and validated assignment UUID/null. Names, emails, phones, company, visitor reason/message, consent text and raw IP are absent. Public submissions do not serialize bodies into application logs, URLs or metrics. Live unique canaries for all five contact categories produced **0 matches each**, without printing their values. The existing log verifier additionally passed credential fields, known secret values, API-key patterns, document/website/FAQ contents and vector scans.

## Widget and Angular — Gate 5

The widget preserves existing chat, citations and Shadow DOM behavior and adds explicit **Contact us** and **Talk to a person** CTAs when enabled. Its inline form renders configured labels/required fields and explicit consent, validates before sending, focuses the first invalid field, disables duplicate submit while pending, announces status, preserves a frozen payload/key for ambiguous retries, and clears values on success/dismissal. Cancel/Escape restores CTA focus. It uses `createElement`, `textContent` and form-control values; no unsafe HTML, persistent contact storage, URL contact fields, analytics or automatic LLM-triggered submission.

Angular's organization account adds **Leads and follow-up**: settings, collected/required fields, consent controls, paginated and filtered lists, lead details/status/deletion, handoff details with contact summary, assignment and workflow controls. Members see read-only views. Dense lists omit full visitor messages. Angular interpolation escapes customer text. Loading/busy/error/empty/success states are explicit; stale organization responses are ignored; settings drafts block chatbot switching; deletion uses the existing native-dialog pattern with explicit cascade consequences. Conflict responses instruct staff to refresh/reopen. Native selects and natural scrolling preserve the accepted workbench. Knowledge and contact screens share extracted `admin-workbench.scss` styles using existing tokens.

Component tests cover these behavior paths and existing account/knowledge/chat tests pass. The production Angular bundle is approximately 366.4 kB raw / 94.3 kB estimated transfer, below existing budgets; widget bundle is 10.6 kB.

**MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED**: inspect desktop/narrow viewport, keyboard focus and native dialog/select behavior, long content, success/failure/pending, and chat regression in an actual browser. Browser discovery returned no available instance. No screenshots or complete browser/a11y acceptance are claimed.

The required premium static audit ran and reproduced the **same five inherited findings** in untouched `frontend/src/app/app.html`: three actionless-button false positives for existing Angular `(click)` bindings; two legacy composer novalidate/textarea-resize findings. The existing audit JSON is unchanged. New M29 code has no unsafe HTML/storage/console patterns. The static audit is not represented as a clean whole-project or browser acceptance. Accepted public-chat UI was not redesigned to suppress inherited scanner output.

## Quotas, abuse and operations — Gate 6

Creation uses the existing lock order: organization → subscription → chatbot/resources. Eligibility, quotas, creation, receipt, audit and metering commit together. Tests issue five distinct concurrent requests against a quota of two, independently for leads and handoffs: exactly two succeed, all remaining requests return `QUOTA_EXCEEDED`, no overshoot occurs. Concurrent identical requests produce one lead/handoff and one usage increment per metric. A database trigger injected into the isolated test schema forces handoff insertion failure and proves complete rollback of lead, receipt, usage and audit.

Operational metrics add `north_orbital_handoffs{status}` for the four finite statuses and `north_orbital_handoff_queue_age_seconds` for the oldest requested/acknowledged item. Existing protected metrics access, HTTP/rejection counters and health/readiness semantics remain intact. There are no tenant/contact/resource identifiers in metric labels. No external dependency, environment secret, production TLS bypass or privileged container was added. `.env` examples require no M29 changes.

`docs/production-azure.md` now covers contact PII, TLS, database-at-rest and backup protection, least privilege, queue/age and quota/rate monitoring, export/deletion, restricted audit/log content and the lack of outbound email/CRM integrations. No application field encryption is claimed.

## Automated tests and runtime — Gate 7

Final test runs explicitly used local Node 22.23.2. Built backend container reports Node 22.23.3.

| Suite | Final result | M28 approximate baseline |
|---|---:|---:|
| Backend unit | 278 passed / 23 files | 253 |
| PostgreSQL integration | 115 passed / 9 files | 76 |
| RAG evaluation | 48 passed / 2 files | 48 |
| Angular | 32 passed / 4 files | 19 |
| Widget | 11 passed / 1 file | 4 |

RAG evaluation overlaps existing unit/integration suites; do not sum it as disjoint coverage. Existing tests were retained; two prior migration-count assertions now expect 8 instead of 7. Added coverage is 25 backend unit cases, 39 database cases, 13 Angular cases and 7 widget cases.

Commands run: backend `npm test`, `npm run test:db`, `npm run evaluate:rag`, `npm run build`; frontend `npm test -- --watch=false`, `npm run build`; widget `npm test`, `npm run build`; `docker compose config -q`; `docker compose build backend worker migrate`; additive migration with `docker compose run --rm migrate`; local runtime `docker compose up -d backend worker`.

Sandbox restrictions initially blocked local sockets/database access, npm audit DNS and Docker Buildx activity writes. Required commands were rerun with authorized access. One intermediate DB rerun produced subscription-start timing rejections in inherited commercial/ingestion/repository fixtures; subsequent complete runs passed, including the final Node 22 run. Subscription policy was not relaxed. Angular's first sandbox build aborted without diagnostics; builds passed with required access. An initial new Angular test needed an additional asynchronous turn before flushing member choices; it was corrected and all tests pass.

### Dependency audits

`npm audit --omit=dev` was run independently for all three packages. No `audit fix --force` was used; no dependencies were introduced.

| Package | Critical | High | Moderate | Low | Info |
|---|---:|---:|---:|---:|---:|
| backend | 0 | 0 | 3 | 0 | 0 |
| frontend | 0 | 0 | 0 | 0 | 0 |
| widget | 0 | 0 | 0 | 0 | 0 |

Backend's three reported package entries are the inherited `mammoth → argparse → sprintf-js` chain, advisory GHSA-hp3w-g68c-fv3c. npm proposes an incompatible Mammoth downgrade; it was not applied. High/critical acceptance thresholds are satisfied.

### Controlled live acceptance

`backend/scripts/verify-leads.mjs` runs through the existing local Compose configuration helper without exposing secrets. It proved configuration, safe public config, lead submission, duplicate retry, atomic handoff submission, authenticated lists, acknowledgement, same-organization assignment, resolution, lead status update, owner privacy export, audit privacy, live log canaries, hard deletion and linked-handoff removal. `/api/health` and `/api/ready` both returned **200**. Its before/after inventory assertion passed and all fixture contacts/settings/receipts were removed.

Existing `verify-commercial.mjs` passed live plans, quotas, bearer chat/API-key hashing and revocation, export and disposable private-object deletion. Existing `verify-website-knowledge.mjs` passed controlled crawl, real 1024-dimensional embeddings, unchanged-page preservation, website and manual FAQ production answers, citations and cleanup. The worker was stopped only for that existing controlled test and restarted afterward. No third-party crawler policy or TLS check was relaxed. Existing automated suites also cover authentication/CSRF, exact public origins, tenant/API-key isolation, documents/OCR, mixed RAG and crawler security. Backup scripts are unchanged.

Runtime: PostgreSQL healthy, MinIO healthy, backend healthy, worker running; migration/init containers completed normally. Compose validates. Final orphan and leftover fixture-schema checks are zero.

## Final database inventory

No contact values appear in this report.

| Entity | Count |
|---|---:|
| migrations | 8 |
| organizations | 3 |
| organization_subscriptions | 3 |
| documents | 5 |
| document_chunks | 14 |
| document_embeddings | 14 |
| website_sources | 0 |
| website_pages | 0 |
| website_crawl_jobs | 0 |
| manual_faqs | 0 |
| knowledge_chunks | 0 |
| lead_capture_settings | 0 |
| leads | 0 |
| handoff_requests | 0 |
| lead_submission_receipts | 0 |
| object_cleanup_jobs | 0 |

Existing documents remain 4 ready and 1 failed; no original failed document was altered. Ingestion jobs are 4 succeeded and 2 failed, with 0 queued/processing jobs. Document chunk and embedding orphan counts are both 0. Disposable M28/M29/commercial test schema count is 0.

Usage totals across retained periods (fixture organizations' counters were cascade-cleaned):

| Metric | Quantity |
|---|---:|
| public_chat_messages | 1 |
| internal_chat_messages | 9 |
| documents_created | 1 |
| ingestion_pages | 2 |
| storage_bytes | 1,975 |
| api_requests | 5 |
| website_pages_indexed | 0 |
| website_crawl_requests | 0 |
| manual_faq_entries | 0 |
| leads_created | 0 |
| handoffs_requested | 0 |

Final retained M29 audit counts: settings updated 1; lead created 2; lead status updated 1; lead deleted 2; handoff requested 1; acknowledged 1; assigned 1; resolved 1; cancelled 0. Total 10. Safe audit survives fixture tenant deletion under the existing append-only policy; no contact values remain. Cancellation is covered by isolated integration tests.

Lead, settings, handoff, membership-assignment, document chunk and embedding orphan counts: **0 each**. There are no queued/processing ingestion jobs, crawl jobs or object cleanup jobs.

## Major files

- New migration and `backend/src/leads/{model,service,router}.ts`: schema, validation, transactions, staff APIs.
- Public router/app wiring; commercial model/service/privacy; audit repository; metrics.
- `frontend/src/app/leads.ts` and tests; account entry; shared workbench stylesheet with Knowledge.
- Widget contact form/config validation and tests.
- Backend unit/database tests; live acceptance/log-privacy helpers.
- This report, production Azure guidance, DESIGN and UX contracts.

## Known limitations and deferred work

M29 does **not** provide live human chat takeover, persistent transcript viewer, conversation analytics/intelligence, email or SMS notifications, CRM synchronization, webhooks/Zapier, helpdesk integrations, automatic sales qualification, or a complete legal/privacy compliance framework. Email notification delivery is deferred to M34. No staff notes, CAPTCHA provider, external automation or transcript persistence was added. Staff must monitor the in-app queue. Receipt expiry is lazy and has a 24-hour retry guarantee; deleted contacts can remain in historical protected backups. Browser visual acceptance is outstanding as described above.

## Final Git evidence

The following output was captured after implementation and documentation changes. `git diff --stat` covers tracked modifications only; new untracked M29 files are explicitly listed by `git status -sb`. All changes remain unstaged/uncommitted. No commit/push was performed.

```text
$ git status -sb
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

$ git diff --stat
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

$ git diff --check
(no output; exit 0)
```
