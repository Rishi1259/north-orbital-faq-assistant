# Milestone 27 — Commercial SaaS foundation

Provider-independent plans, subscriptions, entitlements, transactional quotas, usage, organization API keys, account UI, onboarding and privacy foundations. No payment provider is integrated. Existing pgvector/FTS/RRF production RAG, public IDs, exact origins, session/CSRF/RBAC and local host ports remain unchanged.

## Architecture and files

`backend/src/commercial/` contains the model/Zod schemas, plan/subscription repositories, `CommercialService` transaction/entitlement/usage boundary, `ApiKeyService`, `CommercialDocuments`, privacy projections and HTTP routers. Existing chatbot creation, owner bootstrap, document services, ingestion completion, public chat and authenticated chat call these services. Backend startup wires the commercial services; the worker also polls the cleanup queue. No second retrieval pipeline or Redis is introduced.

Added files: migration `1791300000000_commercial-saas-foundation.js`; `commercial/{model,repository,service,api-keys,documents,privacy,router}.ts`; backend commercial unit/integration tests and rollback-transaction test adapter; `scripts/verify-commercial.mjs` and secret-safe local Compose launcher; Angular `account.ts`/`account.spec.ts`; `.env.production.example`; this report and `production-azure.md`. Modified files include backend app/server, chatbot repository, security repository, document service/router/repository, ingestion worker, public/tenant routers, two existing repository integration fixtures and the existing smoke-session helper (optional existing-owner reuse), Angular root component/template and demo public-ID meta tag, README, environment examples and `.gitignore`.

## Gate 1 — schema and subscriptions

The additive sixth migration preserves organizations/chatbots/documents/chunks/vectors. Existing and newly inserted organizations receive an active Beta subscription. New-organization assignment is a database trigger, including controlled CLI-created organizations. Initial period: transaction time through 30 days later. Prices default to NULL and are display metadata only.

| Plan | Bots | Shared messages/period | Documents | Storage bytes | Members | API | Advanced analytics flag |
|---|---:|---:|---:|---:|---:|---|---|
| beta | 1 | 1,000 | 25 | 250,000,000 | 2 | No | No |
| starter | 1 | 3,000 | 50 | 1,000,000,000 | 3 | No | No |
| growth | 3 | 15,000 | 250 | 5,000,000,000 | 10 | Yes | Yes |
| business | 10 | 50,000 | 1,000 | 20,000,000,000 | 30 | Yes | Yes |

Storage uses decimal MB/GB. Existing above-limit data remains readable/deletable; quotas block further growth. Edit plans using a privileged DB configuration process, not client input. Archived plans disappear from the active catalog but retain entitlements for organizations already assigned to them.

| Table | Columns/constraints | Access indexes |
|---|---|---|
| `plans` | code PK; bounded name/status; nullable INR/USD minor prices; chatbot/message/document/storage/team/page limits; API/analytics flags; timestamps. Nonnegative limits/prices, positive member limit; safe-integer bounds for bigint values. | code PK |
| `organization_subscriptions` | organization PK/FK cascade; plan FK; allowlisted status; finite ordered period bounds; optional trial/grace; timestamps | organization PK; plan index |
| `usage_counters` | tenant FK cascade; finite metric; period bounds; nonnegative quantity; timestamp | PK `(organization_id,metric,period_start)`; tenant-period index |
| `api_keys` | UUID PK; tenant FK cascade; bounded name/prefix; unique SHA-256 hash; finite nonempty scopes; creator user FK; creation/expiry/revocation/last-use timestamps | hash unique; tenant-created-ID index |
| `object_cleanup_jobs` | UUID PK; organization/chatbot/document identifiers; finite PDF/DOCX format; upload/delete purpose; reserved size; due time/attempts/created time | unique document; due-time; tenant-purpose indexes |

Cleanup deliberately has no cascading tenant FK: deleting metadata must not erase pending object cleanup. The migration down path refuses pending cleanup work, then removes only M27 objects; it loses commercial history/credentials and is not a routine production rollback. Security audit records remain immutable.

Live pre-migration inventory: **5 migrations, 3 organizations, 5 documents**. Migration application succeeded. Final live counts and runtime results are recorded below. Isolated migration integration setup also applies M21–26, inserts an organization, then applies M27 and verifies its Beta backfill.

## Gate 2 — entitlements and quotas

All mutations lock the organization then subscription before checking/updating capacity. Resource checks and writes share a transaction. Message consumption sums public and internal counters under that same lock and upserts exactly one counter before RAG execution. Independent simultaneous requests cannot overshoot the shared plan allowance. No refund is issued for generation failure, timeout, fallback or client disconnect after acceptance. Model/query-rewrite retries within a request do not consume again.

Invalid sessions/CSRF, invalid public IDs, missing/disallowed origins, invalid chatbots and malformed chat bodies do not consume message units. Rate limits run independently and may count malformed attempts. `QUOTA_EXCEEDED` is HTTP 429 with `{error:{code,message}}`; inactive subscription/API entitlement failures are HTTP 403 with safe stable codes. Failed quota transactions roll back, then append `quota.exceeded`; audit failures are not silently ignored.

- Bot count: organization-wide current chatbots.
- Documents: organization-wide current metadata plus outstanding upload intents, all processing states.
- Storage: current document sizes plus all upload/cleanup intent bytes. Deleting files retain capacity until actual object cleanup succeeds.
- Members: all memberships, enforced by the existing controlled owner bootstrap; repeated bootstrap of the same member does not consume another slot. Organization creation creates one owner within the positive team limit. There is still no membership-management API.
- Messages: public widget + internal/admin + bearer chat share `monthly_message_limit`.
- API access: creation and every authenticated bearer request require an allowed subscription and API-enabled plan. Revocation/listing remain possible after downgrade/suspension.

`active` permits usage. `trialing` requires explicit future `trial_ends_at`. `past_due` requires explicit future `grace_ends_at`, retaining normal limits during grace. Exact expiry, missing deadline, suspended/cancelled status or future period start denies usage. Reads/export/revocation/deletion remain available to authorized users. No automatic trial conversion, payment collection or self-service plan change exists.

Periods retain the configured subscription start/end duration and anchor, advancing whole durations when necessary. Beta defaults to rolling 30-day periods; this is deliberately **not calendar-month billing**. An operator can set future provider-aligned boundaries later. DB time is read after the organization lock. Historical counters remain stored; inventory capacity does not reset. Operators must preserve boundaries on a mid-period plan change to preserve current usage.

## Gate 3 — metering and commercial API

Finite metrics: `public_chat_messages`, `internal_chat_messages`, `documents_created`, `storage_bytes`, `ingestion_pages`, `api_requests`. Creation count/uploaded bytes are cumulative period events; the usage API separately computes current document/storage inventory for actual capacity. Known ingestion pages are recorded once on successful fenced completion, in the same transaction as chunks/vectors/job completion. A lost lease cannot meter twice. Existing document inventory is counted from day one; pre-migration historical traffic is not invented.

Every successfully authenticated, plan-entitled bearer request that passes its rate limits increments `api_requests`, including later scope/path/body rejection; rejected credentials and absent API entitlement do not. Message consumption still waits until chat acceptance.

Usage fields contain `used`, `limit`, `remaining` and bounded `percentage`. The shared `messages` field carries the enforced limit; public/internal breakdowns have null limits to avoid suggesting separate allowances. `monthly_ingestion_page_limit` is nullable and currently advisory/metered only; seeded plans do not set it. Advanced analytics is a capability flag for later extensions; all plans can read these basic aggregates.

All routes below use cookie session authentication and tenant membership unless stated otherwise:

| Method | Route | Authorization/behavior |
|---|---|---|
| GET | `/api/plans` | Authenticated active catalog |
| GET | `/api/account/organizations` | Current user's memberships; bounded 100-row account selector |
| GET | `/api/organizations/:organizationId/subscription` | Subscription, plan and period |
| GET | `/api/organizations/:organizationId/usage` | Period, plan and aggregate usage |
| GET | `/api/organizations/:organizationId/entitlements` | Effective limits/features/status |
| GET | `/api/organizations/:organizationId/onboarding-status` | Persisted-state summary |
| POST | `/api/organizations/:organizationId/api-keys` | Owner/admin + CSRF + API plan; secret once |
| GET | `/api/organizations/:organizationId/api-keys` | Owner/admin; safe paginated metadata |
| DELETE | `/api/organizations/:organizationId/api-keys/:apiKeyId` | Owner/admin + CSRF; idempotent revocation |
| GET | `/api/organizations/:organizationId/privacy/export` | Owner only; paginated metadata JSON |
| DELETE | `/api/organizations/:organizationId/chatbots/:chatbotId/documents/:documentId` | Owner/admin + CSRF; 202, durable cleanup |
| POST | `/api/v1/organizations/:organizationId/chatbots/:chatbotId/chat` | Bearer key only; `chat:write`; existing production RAG |

There is **no plan-changing HTTP endpoint**, production or development. Operator subscription changes follow [the deployment runbook](production-azure.md).

## Gate 4 — API keys

`no_live_` plus 32 CSPRNG bytes encoded base64url (256 bits). Creation returns `{apiKey,secret}` with no hash. PostgreSQL stores SHA-256 only, plus a short identifying prefix. Hash comparison uses the existing timing-safe helper; random high-entropy keys do not need password-style Argon2. List/revoke/export never return the reusable credential or hash. Expiry/revocation is checked for every request; last-use is updated without logging headers. Revocation prevents subsequent authentication; it does not cancel already accepted in-flight work.

Scopes: `chat:write` is implemented. `chatbots:read`, `documents:read`, `documents:write`, `analytics:read` are explicitly **reserved**, grant no current route access and cannot authorize chat. Key management is rate limited at 30/minute per user/organization, with at most 100 unrevoked/unexpired credentials. Bearer ingress is limited at 120/minute per client and 60/minute per key, using shared PostgreSQL HMAC windows. Bearer routes do not accept session cookies as credentials and do not require browser CSRF. No cross-origin browser bearer CORS policy is added.

## Gate 5 — onboarding and privacy

Onboarding reports organization/bot existence, ready knowledge (a ready scoped document with a retrieval-eligible chunk), configured origins and public enabled state. `installationReady` requires all three on the **same chatbot**. It does not claim a customer actually embedded the script or that inference is healthy.

Owner JSON export includes organization, subscription/plan/usage, safe membership email/role data, chatbot settings, document metadata, allowed origins, key metadata, historical usage and allowlisted audit metadata. It explicitly excludes file content, chunks/questions, passwords, password/session/CSRF/key hashes, storage keys/credentials and application secrets. Each section is paginated (`limit` 1–100, default 50; `offset` 0–1,000,000), returning `items` and `hasMore`. Reuse the returned `asOf` timestamp in subsequent requests and fetch pages per section until `hasMore=false`; the cutoff prevents the export’s own audit events from continually extending pagination. writes between pages can move rows, so use the maintenance runbook for a fully consistent export. Export reads are rate limited and generate `privacy.exported`; files require a separately authorized export.

Deletion transaction locks ingestion jobs/document, creates durable cleanup, deletes metadata (cascading chunks/vectors/jobs) and appends `document.deleted`. Worker completion after deletion fails lease fencing. Cleanup uses `FOR UPDATE SKIP LOCKED`, an idempotent S3 DELETE and retries every five minutes indefinitely after failure. Physical storage quota releases only after success. Missing scoped document deletion is idempotent; a foreign chatbot is rejected. Noncanonical legacy storage keys return `STORAGE_RECONCILIATION_REQUIRED` and preserve metadata for operator reconciliation.

Uploads commit a reservation/cleanup intent before PUT, then hold its row lock across bounded PUT and metadata/job commit. A crash or ambiguous PUT/commit leaves durable cleanup eligible after one hour; concurrent cleanup cannot lock an active intent. Expired intents cannot be finalized. This also closes the earlier best-effort orphan cleanup gap for production uploads. Application paths backed by the real ingestion repository automatically use this durable service.

Full-account automated deletion is deliberately deferred; [production-azure.md](production-azure.md) provides the suspension, export, draining, object reconciliation, reviewed DB deletion, audit retention and backup-expiry runbook. No conversations are persisted or exported/deleted.

## Gate 6 — account UI and production readiness

The existing Angular public chat remains the default. “Organization account” opens a minimal authenticated panel with email/password login, authorized organization selector, current plan/status/period, quota progress, onboarding checklist and owner/admin API-key management. Passwords clear after login attempts; CSRF and new-key secret remain in component memory only. Newly created keys can be copied immediately and disappear on dismissal, organization change, revoke, sign-out or leaving the panel. No browser storage persists them. The account view offers `chat:write` only and paginates key lists.

Production documentation covers ACR image builds, separate backend/worker deployment, PostgreSQL Flexible Server/pgvector, S3-private storage, Key Vault injection, frontend hosting, HTTPS/DNS, probes, all environment groups, backups, protected metrics, proxy/cookies and migration execution. No Azure resources or credentials are created. A private production inference deployment is still required; development Ollama remains supported. See [.env.production.example](../.env.production.example) and [production-azure.md](production-azure.md).

## Gate 7 — security and regression

Parameterized tenant-scoped SQL, existing membership roles and browser CSRF remain. Quotas are server-side and distinct from short-window limits. No raw visitor questions or document content are added for analytics, no customer IDs are added to Prometheus labels, and loggers omit credential headers/bodies. New tests authenticate through the real login/session path. Two older test fixtures use savepoint-backed Pool adapters so repositories can exercise real transactions without committing fixture data; no production authorization is bypassed.

Verification commands (run with Node **22.23.2**, including tools spawned by npm):

```sh
# In a shell selecting the supported runtime:
export PATH=/Users/rishikeshgujar/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/bin
cd backend
npm run migrate -- up
npm run build
npm test
npm run test:db
npm run evaluate:rag
npm audit --omit=dev
cd ../widget
npm run build
npm test
npm audit --omit=dev
cd ../frontend
npm run build
npm test -- --watch=false
npm audit --omit=dev
cd ..
docker compose config --quiet
docker compose build --build-arg NPM_CONFIG_OFFLINE=true backend worker migrate
# Existing cache only; omit NPM_CONFIG_OFFLINE for normal registry-backed builds.
docker compose up -d backend worker
docker compose exec -T postgres psql -U north_orbital -d north_orbital \
  -c 'SELECT count(*) FROM pgmigrations; SELECT count(*) FROM organizations; SELECT count(*) FROM documents;'
```

`docker compose config --quiet` intentionally validates without printing resolved secrets. Initial sandbox-blocked socket/registry attempts and wrong-Node runs are not counted as passes. All successful host npm checks use the supported runtime (explicit `env PATH=...` where needed).

Live smoke and backup commands are listed in the executed-results section below. They use temporary synthetic tenants or the existing accepted RAG fixtures, do not remove volumes, and do not change existing customers' plans.

## Executed results — 2026-10-04–05

| Gate/check | Result |
|---|---|
| Gate 1 migration application/backfill/schema | Passed; additive migration applied; isolated old-organization backfill verified |
| Gate 2 concurrent/resource/message/member/status quotas | Passed in commercial integration suite |
| Gate 3 tenant APIs, metering, failed generation, period rollover | Passed in commercial integration suite |
| Gate 4 hash-only keys, scope/tenant/expiry/revocation/plan/rate checks | Passed in commercial integration suite |
| Gate 5 export safety, onboarding, cascade deletion, cleanup retries | Passed in commercial integration suite |
| Backend build | Passed |
| Backend unit/HTTP suites | 20 files, **184 tests passed** (20 new commercial unit cases) |
| PostgreSQL integration | 7 files, **59 tests passed** (24 new commercial cases) |
| Production RAG evaluation | 2 files, **48 tests passed**; overlaps the suites above |
| Angular build/tests | Passed; **9 tests** across 2 files (5 new account tests) |
| Widget build/tests | Passed; **4 tests** |
| Production dependency audits | Backend, frontend, widget: **0 vulnerabilities** |
| Compose configuration | Passed, quiet validation |

Additional executed commands (from `backend/`, with the Node 22 PATH above):

```sh
npm run backup:verify
node scripts/local-compose-env.mjs dist/operations/object-backup.js
SMOKE_USE_EXISTING_OWNER=true node scripts/local-compose-env.mjs scripts/verify-rag.mjs
```

The local Compose launcher reads resolved configuration in memory, maps DB/storage/AI to the documented loopback ports, and never prints credentials. The host `.env` has no S3 configuration, so an initial direct `backup:objects` attempt failed safely; rerunning with the correct private Compose configuration passed. The initial RAG smoke attempted a third membership in the existing Beta demo and was correctly quota-blocked. Existing-owner reuse avoids changing the customer plan or membership quota.

- PostgreSQL backup and temporary restore passed: `backups/postgres/2026-10-04T02-37-49-110Z-763b2df1.dump`. Only its randomly named restore database was removed.
- Private object backup passed: **5 objects, 761,738 bytes**.
- Live authenticated RAG passed: ready PDF, ready DOCX, semantic paraphrase, unrelated/absent answers, follow-up, tenant isolation, and health/readiness.
- Browser visual smoke unavailable: browser runtime discovery returned no connected browser. Angular/jsdom assertions passed; no visual acceptance is claimed.

Final runtime results:

| Check | Result |
|---|---|
| Backend/worker/migration image builds | Passed; worker OCR package download took approximately 33 minutes; no TLS bypass or dependency changes |
| Gate 6 account view/configuration | Angular build and 9 component tests passed; production template/runbook added; no Azure deployment or full-browser visual claim |
| Gate 7 live commercial smoke | Passed: Beta quota rejection, API entitlement, hashed-key metadata, bearer RAG, export safety, revocation, durable physical S3 deletion |
| Gate 7 live public smoke | Passed: login/bootstrap, safe config, exact/missing/bad origins, real RAG/citations, protected routes, widget, metrics and rate limiting |
| Gate 7 PDF/DOCX/OCR ingestion | Passed: PDF 2 chunks, DOCX 6 chunks, scanned PDF 1 chunk; all vectors 1,024 dimensions; original object bytes verified |
| Ingestion failure handling | Automatic failure retries, terminal failure, manual retry and wrong-tenant rejection passed |
| Log privacy | Zero API-key secret, document-content, credential-field, vector-array and known-secret matches |
| Final health/readiness | Both HTTP 200 |
| Final existing-data inventory | 3 organizations, 3 subscriptions, 5 documents, 14 chunks, 14 vectors, 0 cleanup jobs |
| Migration count | **5 → 6** |

Additional exact runtime commands executed (repository root unless prefixed by `cd backend`):

```sh
docker compose up -d --no-deps backend
docker compose up -d --no-deps worker
# Backend-only rebuild after export pagination correction:
docker compose build --build-arg NPM_CONFIG_OFFLINE=true backend
# From backend/:
node scripts/local-compose-env.mjs scripts/verify-commercial.mjs
node scripts/verify-public.mjs --organization f94827a2-4ec3-4bd0-92cc-49accd1cdf9b --chatbot f732a2ca-55b2-47fa-aefa-1fb497e56262
node scripts/verify-log-privacy.mjs
# From repository root:
docker compose run --rm --no-deps \
  -v /Users/rishikeshgujar/Projects/north-orbital-faq-assistant/backend/scripts:/app/backend/scripts:ro \
  -v /Users/rishikeshgujar/Projects/north-orbital-faq-assistant/documents/samples:/app/documents/samples:ro \
  worker node scripts/verify-ingestion.mjs
docker compose exec -T postgres psql -U north_orbital -d north_orbital -c "SELECT (SELECT count(*) FROM pgmigrations) AS migrations,(SELECT count(*) FROM organizations) AS organizations,(SELECT count(*) FROM organization_subscriptions) AS subscriptions,(SELECT count(*) FROM documents) AS documents,(SELECT count(*) FROM document_chunks) AS chunks,(SELECT count(*) FROM document_embeddings) AS vectors,(SELECT count(*) FROM object_cleanup_jobs) AS cleanup_jobs;"
docker compose exec -T backend node -e "Promise.all(['/api/health','/api/ready'].map(async p=>console.log(p,(await fetch('http://127.0.0.1:3000'+p)).status)))"
git diff --check
git status --short --untracked-files=all
```

The account uses the existing API-origin metadata. Final inspection found the checked-in demo public ID predates the current database ID; `frontend/src/index.html` now references the successfully verified `pub_40088b8e277984a34293f4a78823df5edb61b0271e5a3a8b`. This updates the local client configuration; no public-ID rotation was performed. Replace these nonsecret deployment meta tags for other environments. The log scanner now explicitly detects full `no_live_` secrets.


## Known limits and deferred work

No billing/payment integration, checkout, invoices or self-service plan changes; Stripe/Razorpay integration is M37. Periods use provider-independent configured durations. Page quotas are advisory only; all required bot/document/storage/member/message/API quotas are enforced. No advanced analytics product is introduced beyond its entitlement flag and basic aggregate usage. Reserved API scopes are not implemented routes.

No M28 crawling/manual FAQ entry, M30 conversation persistence/transcript viewer or lead capture, WhatsApp, voice or other M28+ features. Membership invitations/management, password recovery/MFA, automated full-account deletion, raw-file export packaging, retention automation, malware scanning and production AI provider/hosting integration remain deferred. Existing upload/chatbot audit records still use their earlier post-service audit path; key/deletion/privacy/commercial-counter transactions are atomic as described. The public frontend's chat history remains in-memory.

Uploads serialize organization operations while the private PUT completes; monitor pool pressure. API-key revocation cannot cancel previously accepted work. Export is paginated rather than an unbounded whole-account response; concurrent writes require a maintenance window for consistency. Cleanup has durable retries and attempt/due-time visibility but requires operational alerting. Metadata deletion does not erase storage object versions or backups automatically; follow configured retention. Full browser accessibility/visual acceptance and deployment-specific Azure/TLS/proxy/restore rehearsals are separate from automated jsdom/unit checks.

Working tree is intentionally **uncommitted**. No tag or commit is created.

## Final git status

`git diff --check` passed. There are 21 modified tracked files and 18 new files, all unstaged/uncommitted. No commit or tag was created.

```text
 M .env.example
 M .gitignore
 M README.md
 M backend/.env.example
 M backend/scripts/smoke-session.mjs
 M backend/scripts/verify-log-privacy.mjs
 M backend/src/app.ts
 M backend/src/chatbots/chatbot-repository.ts
 M backend/src/ingestion/document-router.ts
 M backend/src/ingestion/document-service.ts
 M backend/src/ingestion/repository.ts
 M backend/src/ingestion/worker.ts
 M backend/src/public/router.ts
 M backend/src/security/repository.ts
 M backend/src/server.ts
 M backend/src/tenancy/tenant-router.ts
 M backend/tests/integration/repositories.test.ts
 M backend/tests/integration/tenant-http-isolation.test.ts
 M frontend/src/app/app.html
 M frontend/src/app/app.ts
 M frontend/src/index.html
?? .env.production.example
?? backend/migrations/1791300000000_commercial-saas-foundation.js
?? backend/scripts/local-compose-env.mjs
?? backend/scripts/verify-commercial.mjs
?? backend/src/commercial/api-keys.ts
?? backend/src/commercial/documents.ts
?? backend/src/commercial/model.ts
?? backend/src/commercial/privacy.ts
?? backend/src/commercial/repository.ts
?? backend/src/commercial/router.ts
?? backend/src/commercial/service.ts
?? backend/tests/commercial.test.ts
?? backend/tests/integration/commercial.test.ts
?? backend/tests/transaction-pool.ts
?? docs/milestone-27-verification.md
?? docs/production-azure.md
?? frontend/src/app/account.spec.ts
?? frontend/src/app/account.ts
```
