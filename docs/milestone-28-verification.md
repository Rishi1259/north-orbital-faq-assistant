# Milestone 28 — website and manual FAQ knowledge

Implementation and verification record. Changes remain uncommitted, including the pre-existing accepted M27 working-tree changes. No accepted migration was edited; no accepted document was re-ingested or deleted. No external customer website is contacted by automated tests.

Major implementation files:

- `backend/migrations/1791400000000_website-knowledge.js`: additive schema, quotas and shared retrieval views.
- `backend/src/sources/{config,url,http,discovery,crawl,service,jobs,router}.ts`: bounded transport, discovery, indexing, source APIs and durable execution.
- `backend/src/rag/{repository,ranking,chat-service,types}.ts`, `app.ts`, `public/router.ts`: mixed evidence and validated source-aware citations.
- `backend/src/commercial/{model,service}.ts`, `operations/metrics.ts`, `ingestion/worker.ts`: commercial inventory/export, operations and worker integration.
- `frontend/src/app/knowledge.ts`, `account.ts`, `chat-api.service.ts`, `styles.scss`: knowledge management and citation types.
- `backend/tests/crawler-*.test.ts`, `tests/integration/website-knowledge.test.ts`, `frontend/src/app/knowledge.spec.ts`, `backend/scripts/verify-website-knowledge.mjs`: deterministic and live acceptance.
- Three environment examples, `compose.yaml`, `docs/production-azure.md`, `DESIGN.md`, `UX-CONTRACT.md`, and this report: deployment and operational guidance.

## Architecture and schema (Gate 1)

The seventh migration is `backend/migrations/1791400000000_website-knowledge.js`. It adds normalized `website_sources`, `website_pages`, `website_crawl_jobs`, `manual_faqs`, and `knowledge_chunks` tables. Source identity is represented by the source-specific relational records; the shared retrieval abstraction is `ready_knowledge_chunks` plus `knowledge_vectors` views. Existing document tables/IDs/vectors remain intact. Composite organization/chatbot/source/page foreign keys prevent mismatched associations. Canonical URL uniqueness is per website source. Partial job uniqueness permits only one queued/running job per source. Tenant lookup, scheduling, lease, page state, GIN FTS and HNSW cosine indexes support the new access paths.

Pre-migration inventory: **6 migrations, 3 organizations, 3 subscriptions, 5 documents, 14 document chunks, 14 document vectors, 0 cleanup jobs**. Transactional schema validation succeeded before application. After application: **7 migrations, all other baseline counts unchanged**. Isolated-schema integration tests apply all seven migrations and verify scoped constraints. Rollback intentionally requires a reviewed forward migration/export; no destructive down migration was executed.

## Network security (Gate 2)

`backend/src/sources/url.ts` owns URL normalization: HTTP(S), lowercase host/scheme via WHATWG URL, default-port normalization, fragment removal and dot-segment resolution. Query strings/order/repeated parameters are preserved. Credentials, control characters, backslashes, malformed URLs, private/local/special hostnames and blocked literal addresses are rejected. Trailing-dot hostnames are conservatively rejected. Exact origin includes scheme and non-default port; subdomains never qualify automatically.

IPv4 policy blocks loopback, RFC1918, link-local/metadata, carrier NAT, multicast, broadcast, reserved/test/benchmark ranges. IPv6 accepts only global unicast outside special/documentation/transition ranges; mapped IPv4 is rejected entirely. All DNS answers must pass. `http.ts` supplies a custom lookup returning only the validated address, with a fixed family, a fresh non-pooled connection, original URL hostname and mandatory TLS verification. Redirects are re-normalized, origin-checked and resolved/pinned on every hop. Resolver/network/body/timeout tests use injected transports or mocked Node connection boundaries; production contains no localhost exception.

Node HTTP request uses an abort deadline covering DNS, connection and response. Identity encoding is requested; unsolicited compression is rejected before reading. Both declared and streamed body lengths are bounded. Cookies, credentials, custom authentication and remote JavaScript are unsupported. Requests are sequential per crawl; fixed identifiable user agent and page delay limit site load. HTTP 429/5xx are retryable; numeric Retry-After is clamped to one hour. TLS, URL, policy, robots and unsupported-content failures expose only finite safe codes. Unknown errors are sanitized to `CRAWL_FAILED`.

Implementation references: [Node HTTP request options](https://nodejs.org/download/release/latest-jod/docs/api/http.html), [Cheerio parsing configuration](https://cheerio.js.org/docs/advanced/configuring-cheerio/), [Cheerio security boundaries](https://cheerio.js.org/docs/advanced/security/). These informed transport/parser usage; test results establish repository behavior.

## Robots, sitemaps and extraction (Gates 2–3)

Robots is fetched before discovery. Successful policy obeys agent-specific rules, allow/disallow longest-match ordering and wildcard/end anchors; percent-encoded unreserved characters normalize consistently. A bounded glob matcher avoids regex backtracking. 404 means no policy; other failed responses abort conservatively. Page redirects must also satisfy robots. Robots disallow is never overridden by source ownership.

Robots Sitemap declarations take precedence over `/sitemap.xml`. Strict `saxes` XML parsing accepts sitemap indexes/urlsets, rejects malformed XML/DTD/entities, bounds nesting/documents/URLs/bytes and detects loops. Off-origin/private sitemap targets fail conservatively. Conventional sitemap 404 enables HTML fallback; malformed or failed sitemap enumeration does not silently authorize removals. Cheerio (already used by the project) parses bounded HTML without executing it; main/article content is preferred, scripts/styles/templates/hidden elements/forms/navigation/header/footer/aside are removed. Whitespace is normalized, title/headings remain evidence context. HTML canonical declarations are deliberately ignored. Plain text is supported; PDFs/binary links stay in the direct-upload route.

Discovery is deterministic breadth-first from seed plus sorted sitemap URLs, then same-origin HTML links. Cached links are retained for 304 responses, preventing false removal when a parent has not changed. Bounds that prevent complete enumeration mark a run incomplete; they never authorize absent-page deletion.

## Indexing, changes, removal and durable jobs (Gates 3–4)

`crawl.ts` prepares normalized content, SHA-256 hashes, bounded overlapping chunks (140 words/30-word overlap with a character cap), and 1,024-dimensional qwen embeddings. Hashes include title. Unchanged pages preserve existing chunk IDs/vectors; conditional ETag/Last-Modified requests allow a valid 304 to preserve content. Removed-page restoration fetches fresh content and re-embeds. Retrieval deduplication already removes identical/overlapping evidence across URLs/source types.

`jobs.ts` prepares all replacements outside the final transaction. Finalization acquires the existing commercial organization lock, locks the source and checks a random job-claim fencing token. Page upserts, changed chunk/vector replacements, removals, quotas, metering, job completion and audit commit together. A failed crawl/finalization cannot expose half-updated content or delete the old index. Stable IDs apply while content remains unchanged; changed content gets new chunk IDs, invalidating old citations. Failed/syncing sources can still serve their previously successful snapshot; disabled/deleted sources cannot.

Only complete discovery removes previously active URLs absent from a run. Explicit 404/410 removes a visited page on successful finalization. Any network/robots/sitemap/embedding failure aborts the run. Page/depth/discovery truncation suppresses absent-page removal. This deliberately favors stale content over unsafe mass removal after ambiguous failure.

PostgreSQL jobs use queued/running/successful/failed states, attempt counts, available times, heartbeat/claim tokens, completion/error metadata, `FOR UPDATE SKIP LOCKED`, partial uniqueness, exponential backoff (30 seconds to one hour) and max attempts. Stale jobs after 60 seconds requeue or fail terminally; old tokens cannot finalize. Manual sync returns 202; automatic daily/weekly scheduler only queues durable work. No HTTP route executes a crawl. Worker runs one crawl loop alongside the existing document/OCR/cleanup loop so long websites cannot starve documents. Terminal jobs and removed page metadata expire after 30 days in bounded batches.

## FAQs, APIs, retrieval and citations (Gates 5–6)

Source APIs live under `/api/organizations/:organizationId/chatbots/:chatbotId`:

- `/website-sources`: GET paginated list, POST create.
- `/website-sources/:sourceId`: GET, PATCH schedule/enablement, DELETE.
- `/website-sources/:sourceId/sync`: POST, deduplicated 202.
- `/website-sources/:sourceId/pages`: GET bounded metadata pagination.
- `/manual-faqs`: GET paginated list, POST create.
- `/manual-faqs/:faqId`: GET, PUT update, DELETE.

All use existing sessions, CSRF, membership, owner/admin mutation policy, chatbot ownership checks, parameterized SQL, privacy-preserving not-found errors, and a PostgreSQL tenant/user mutation limit of 30/hour. Source URLs are immutable; delete/create to change the origin. FAQ question/answer/category bounds are 500/8,000/100 characters. FAQ content is `Question: … Answer: …`, with one FTS/vector representation. Updates prepare embeddings before an atomic replacement and use database revision fencing; clients can provide the displayed revision for stale-editor conflict detection. Delete cascades retrieval rows immediately. No API-key namespace or M27 API was replaced.

The existing PostgreSQL retriever queries both shared views. Global lexical/semantic candidate ordering feeds unchanged weighted RRF (0.85 semantic/0.15 lexical), deterministic reranking, bounded rewriting and context selection. Source type is included in JSON evidence blocks. Website/FAQ content is untrusted evidence; it has no authority over system instructions, tools, authorization or configuration. This is preparation for M35, not completion of it.

Only selected S-identifiers survive model citation validation. After generation the repository rechecks scope, active lifecycle, chunk identity, source identity, title, canonical URL and evidence content. Public citation endpoints keep the backwards-compatible `document-sources/:chunkId` route for all source kinds and return bounded excerpt/title/type/source/page/public URL metadata. Organization/chatbot administration metadata is excluded. Unknown, removed or deleted chunks return 404. Existing document clients remain compatible.

## Quotas, privacy and operations

New plan fields: `website_source_limit` (Beta 5/Starter 10/Growth 30/Business 100), `knowledge_page_limit` (200/500/2,500/10,000), `indexed_bytes_limit` (20,000,000 default). Knowledge pages count active website pages plus FAQ entries; existing document limits remain separate and are not overloaded. Indexed bytes count UTF-8 chunk text plus 4,096 bytes per vector, excluding PostgreSQL overhead. Every final mutation checks capacity under the existing organization lock. Changed/new website pages also consume `ingestion_pages`, enforcing a configured non-null monthly ingestion limit for website work; unchanged pages do not consume it. The existing document advisory page policy is unchanged.

Finite new metrics: `website_crawl_requests`, `website_pages_indexed`, `manual_faq_entries`. The account usage response exposes inventory and these period aggregates. No customer-controlled metrics or Prometheus labels. Protected metrics add job-state gauges, oldest due queue age and pages processed across retained successful jobs. Liveness/readiness do not contact websites.

Audit actions: `website_source.created`, `.updated`, `.deleted`, `.sync_requested`, `.sync_completed`, `.sync_failed`; `manual_faq.created`, `.updated`, `.deleted`; existing `quota.exceeded`. Audit metadata remains the accepted small allowlist, never content/HTML/network diagnostics/credentials. Privacy export adds explicit projected website source/schedule/page metadata and FAQ content; no embeddings, worker tokens, raw provider errors or resolution details. Deletion removes pages/chunks/vectors and queued/running work in one cascade; late workers fail fencing.

The account panel adds chatbot selection, website add/schedule/status/sync/disable/delete, and FAQ list/create/edit/delete. Angular bindings escape customer text; forms have labels, validation, status announcements, bounded pagination, pending-state controls, stale-response protection, and an app-owned native dialog for delete confirmation. Runtime browser was unavailable in this session; no browser visual/accessibility certification is claimed.

## Configuration

Validated defaults are repeated in all three environment examples and forwarded through Compose:

| Setting suffix (`CRAWLER_`) | Default |
|---|---:|
| MAX_PAGES_PER_SOURCE / MAX_DEPTH / MAX_LINKS_PER_PAGE | 50 / 3 / 100 |
| MAX_RESPONSE_BYTES / MAX_TOTAL_BYTES / MAX_SITEMAP_BYTES | 1,048,576 / 20,971,520 / 1,048,576 |
| MAX_SITEMAP_URLS / MAX_SITEMAP_DOCUMENTS / MAX_SITEMAP_DEPTH | 500 / 10 / 2 |
| REQUEST_TIMEOUT_MS / TOTAL_TIMEOUT_MS / MAX_REDIRECTS | 10,000 / 120,000 / 5 |
| MAX_ATTEMPTS / REQUEST_DELAY_MS | 3 / 100 |
| MAX_CHUNKS_PER_PAGE / MAX_CHUNKS_PER_SOURCE / MAX_CHUNKS_PER_RUN | 30 / 1,500 / 500 |
| USER_AGENT | NorthOrbitalKnowledgeCrawler/1.0 |

Production egress, DNS, sizing, alerts, database growth, privacy and restore requirements are in `docs/production-azure.md`. Production examples contain placeholders, no development endpoints/credentials.

## Verification commands and results

Use Node 22.23.2 on the host. Database suites run serially to avoid unrelated migration/rate-limit test contention. HTTP/database tests need local socket access; sandbox-denied attempts do not count as test failures or passes.

```sh
cd backend
npm run build
npm test
npm run test:db -- --no-file-parallelism
npm run evaluate:rag
npm audit --omit=dev
cd ../frontend
NG_BUILD_MAX_WORKERS=1 npm run build
npm test -- --watch=false
npm audit --omit=dev
cd ../widget
npm run build
npm test
npm audit --omit=dev
cd ..
docker compose config --quiet
docker compose build backend worker migrate
docker compose up -d --no-deps backend worker
git diff --check
git status -sb
git diff --stat
```

The added deterministic tests cover URL/IP/redirect/DNS/TLS/body/timeout/robots/XML security, discovery bounds, hashes/304, restored pages, DB indexing, leases/retries/scheduling (including weekly scheduling after stale-lease recovery), FAQ CRUD/RBAC/CSRF/isolation, mixed evidence/fake citations, quotas, public citations and deletion. Isolated test schemas are removed; existing tenant data is never a cleanup target.

Final automated results (2026-10-11):

| Check | Result |
|---|---|
| Backend build | Passed, Node 22.23.2 |
| Backend unit tests | 22 files, 253 passed |
| PostgreSQL integration tests | 8 files, 76 passed |
| Production RAG evaluation | 2 files, 48 passed (overlaps the above suites) |
| Angular build and tests | Passed; 19 tests, including 10 knowledge-management tests |
| Widget build and tests | Passed; 4 tests |
| Controlled live M28 API/Ollama acceptance | Passed; real embeddings and generation, website/FAQ citations, unchanged chunk IDs, deletion and audit |
| Log privacy scan | Zero matches for API keys, credentials, document/website/FAQ fixture prose and vector arrays |
| DESIGN.md lint | Zero errors and zero warnings |
| Production npm audits | Zero high/critical in all three packages; frontend/widget zero total; backend three moderate package findings from one inherited sprintf-js advisory |

The backend moderate advisory is [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), inherited through Mammoth → argparse → sprintf-js. The registry-proposed fix downgrades Mammoth to 0.3.29 and breaks the accepted document ingestion dependency. No forced audit fix or unsafe dependency replacement was used. `npm audit --omit=dev --audit-level=high` passes; the unrestricted audit still reports the moderate findings. The new saxes dependency has no reported production advisory in this run.

Live fixture command (run with the local worker stopped; restore it afterwards):

```sh
docker compose stop worker
cd backend
node scripts/local-compose-env.mjs scripts/verify-website-knowledge.mjs
cd ..
docker compose up -d --no-deps worker
```

The script refuses to run while the worker is active, injects an HTTP fixture under a public-shaped test hostname, and uses the real API, sessions, PostgreSQL, qwen embedding model and qwen generation model. It never relaxes production SSRF or contacts a third-party fixture website. Its temporary organizations/user and knowledge data are removed in `finally`, and the original inventory is compared before/after. An earlier interrupted run left two disposable organizations; only those explicitly identified fixture organizations/user were removed before the successful rerun. All five accepted documents and fourteen document chunks/vectors remained intact throughout.

UI verification is automated component/build evidence. No browser session was available for visual inspection. The premium static audit reported five findings in the pre-existing public chat template (three Angular event bindings misclassified as actionless buttons and two existing native-control rules); accepted public chat was not redesigned. This is not a claim of full visual or assistive-technology certification.

## Limits and deferred work

No authenticated website crawling, cookie injection, headless browser, JavaScript execution, intranet/private network crawling, automatic cross-domain crawling, compressed sitemap/HTML responses, HTML canonical-tag merging, or arbitrary cron. No complete M35 prompt-injection defense, platform plugins (WordPress/Shopify/Wix), WhatsApp, payments or new API-key scopes. HTTP Retry-After date syntax is not interpreted; numeric seconds are bounded. Incomplete enumeration retains absent pages until a complete run or explicit deletion. Large pages over the chunk budget fail safely instead of silently truncating indexed text. Public website URLs/query strings can contain personal data: customers should select sources accordingly. Historical audit/backups and previously delivered answers outlive deletion under existing retention policy.

## Final runtime and preservation record

Final backend, worker and migration Docker builds passed. Compose configuration validation passed. Recreated backend and worker use the final source revision; backend/PostgreSQL/MinIO report healthy, worker is running. Both `/api/health` and `/api/ready` return HTTP 200. OCRmyPDF, Tesseract and Poppler version checks passed in the worker build. Existing host ports and persistent volumes were preserved.

| Inventory | Before M28 | Final |
|---|---:|---:|
| Migrations | 6 | 7 |
| Organizations | 3 | 3 |
| Organization subscriptions | 3 | 3 |
| Uploaded documents | 5 | 5 |
| Document chunks | 14 | 14 |
| Document vectors | 14 | 14 |
| Object cleanup jobs | 0 | 0 |

Final disposable website sources/pages, manual FAQs and knowledge chunks: **0**. Active document/crawl jobs: **0**. Orphan document chunks/vectors: **0**. New knowledge tables have scoped cascading foreign keys and no remaining rows after fixture cleanup. No accepted document was re-ingested.

## Final git record

All implementation remains uncommitted and unstaged. No commit, push, tag, branch deletion or history rewrite was performed. The working tree already contained accepted M27 changes at the start; this record includes those retained changes. `git diff --check` passes. Ordinary diff statistics omit untracked files, including the new M28 source modules, tests and migration.

Exact `git status -sb`:

```text
## main...origin/main
 M .env.example
 M .gitignore
 M README.md
 M backend/.env.example
 M backend/package-lock.json
 M backend/package.json
 M backend/scripts/smoke-session.mjs
 M backend/scripts/verify-log-privacy.mjs
 M backend/src/app.ts
 M backend/src/chat-service.ts
 M backend/src/chatbots/chatbot-repository.ts
 M backend/src/config.ts
 M backend/src/ingestion/document-router.ts
 M backend/src/ingestion/document-service.ts
 M backend/src/ingestion/repository.ts
 M backend/src/ingestion/worker.ts
 M backend/src/operations/metrics.ts
 M backend/src/public/router.ts
 M backend/src/rag/chat-service.ts
 M backend/src/rag/ranking.ts
 M backend/src/rag/repository.ts
 M backend/src/rag/types.ts
 M backend/src/security/repository.ts
 M backend/src/server.ts
 M backend/src/tenancy/tenant-router.ts
 M backend/tests/integration/repositories.test.ts
 M backend/tests/integration/tenant-http-isolation.test.ts
 M compose.yaml
 M frontend/src/app/app.html
 M frontend/src/app/app.ts
 M frontend/src/app/chat-api.service.ts
 M frontend/src/index.html
 M frontend/src/styles.scss
?? .env.production.example
?? DESIGN.md
?? UX-CONTRACT.md
?? backend/migrations/1791300000000_commercial-saas-foundation.js
?? backend/migrations/1791400000000_website-knowledge.js
?? backend/scripts/local-compose-env.mjs
?? backend/scripts/verify-commercial.mjs
?? backend/scripts/verify-website-knowledge.mjs
?? backend/src/commercial/
?? backend/src/sources/
?? backend/tests/commercial.test.ts
?? backend/tests/crawler-crawl.test.ts
?? backend/tests/crawler-security.test.ts
?? backend/tests/integration/commercial.test.ts
?? backend/tests/integration/website-knowledge.test.ts
?? backend/tests/transaction-pool.ts
?? docs/milestone-27-verification.md
?? docs/milestone-28-verification.md
?? docs/production-azure.md
?? frontend/src/app/account.spec.ts
?? frontend/src/app/account.ts
?? frontend/src/app/knowledge.spec.ts
?? frontend/src/app/knowledge.ts
?? premium-audit.json
```

Exact `git diff --stat`:

```text
 .env.example                                       | 26 ++++++++++++++++++++++
 .gitignore                                         |  1 +
 README.md                                          | 14 +++++++++++-
 backend/.env.example                               | 26 ++++++++++++++++++++++
 backend/package-lock.json                          | 19 ++++++++++++++++
 backend/package.json                               |  1 +
 backend/scripts/smoke-session.mjs                  | 13 +++++++----
 backend/scripts/verify-log-privacy.mjs             |  2 ++
 backend/src/app.ts                                 | 22 +++++++++++++-----
 backend/src/chat-service.ts                        |  3 ++-
 backend/src/chatbots/chatbot-repository.ts         |  7 +++++-
 backend/src/config.ts                              |  2 ++
 backend/src/ingestion/document-router.ts           |  2 ++
 backend/src/ingestion/document-service.ts          |  8 +++++--
 backend/src/ingestion/repository.ts                | 14 ++++++++++--
 backend/src/ingestion/worker.ts                    | 20 ++++++++++++++++-
 backend/src/operations/metrics.ts                  | 15 +++++++++++--
 backend/src/public/router.ts                       |  6 +++--
 backend/src/rag/chat-service.ts                    | 11 ++++-----
 backend/src/rag/ranking.ts                         |  2 +-
 backend/src/rag/repository.ts                      | 12 +++++-----
 backend/src/rag/types.ts                           |  1 +
 backend/src/security/repository.ts                 |  9 ++++++++
 backend/src/server.ts                              |  9 ++++++--
 backend/src/tenancy/tenant-router.ts               |  2 ++
 backend/tests/integration/repositories.test.ts     |  8 ++-----
 .../integration/tenant-http-isolation.test.ts      |  8 ++-----
 compose.yaml                                       | 26 +++++++++++++++++++---
 frontend/src/app/app.html                          |  4 ++++
 frontend/src/app/app.ts                            |  9 ++++++++
 frontend/src/app/chat-api.service.ts               |  3 ++-
 frontend/src/index.html                            |  2 +-
 frontend/src/styles.scss                           |  8 +++++++
 33 files changed, 262 insertions(+), 53 deletions(-)
```
