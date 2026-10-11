# Milestone 28 Independent Acceptance

## Overall verdict

**PASS**

Verification date: **2026-10-11**. All seven gates pass within the executed local acceptance scope. The implementation report was not treated as test evidence: tests, builds, dependency audits, runtime checks, database inspection, source inspection, and controlled ingestion were executed again. A supplementary isolated-schema probe exercised real hybrid retrieval and generation across all three source types.

No application, migration, configuration, dependency, or existing test code was changed during verification. A SHA-256 comparison of 166 source/configuration files found **0 changes**. This acceptance report is the only new repository deliverable from verification. Temporary verification artifacts reside under `/tmp/m28-acceptance-*`. No fixes, commits, pushes, tags, history changes, destructive rollback, or volume destruction were performed.

**MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED.** Automated Angular tests/build pass; no browser session was available. Deployed Azure egress/TLS/DNS behavior and a production restore rehearsal remain operational follow-ups, not locally verified deployment claims.

## Gate summary

| Gate | Verdict | Executed evidence |
|---|---|---|
| Gate 1 — Schema / migration | PASS | Seven recorded migrations; five new scoped tables and two retrieval views; live constraints/indexes inspected; accepted inventory preserved |
| Gate 2 — Crawler security | PASS | 58 security tests plus 11 crawl tests passed; pinned DNS connection path, TLS and redirect enforcement inspected |
| Gate 3 — Extraction / indexing | PASS | Isolated DB indexing tests, controlled live ingestion, real 1,024-dimensional embeddings, production answers and website citation checks |
| Gate 4 — Resync / durable jobs | PASS | Deduplicated enqueue, concurrent claims, stale fencing, retries, scheduling, hashes/304, atomic replacement and safe removal tests passed |
| Gate 5 — Manual FAQ | PASS | CRUD, owner/admin/member/CSRF/isolation, FTS/vector, update/delete, public citations and privacy tests; real FAQ answer |
| Gate 6 — Mixed-source RAG | PASS | Existing deterministic tests plus supplementary real-embedding/generation probe using accepted PDF data, website and FAQ in one isolated chatbot |
| Gate 7 — Regression / runtime | PASS | All claimed test counts reproduced; three builds and Docker builds pass; runtime healthy; audits meet allowed severity threshold; privacy and inventory checks pass |

## Critical security findings

No critical security finding observed in the executed acceptance checks.

No crawler TLS bypass, uncontrolled second DNS resolution, cross-origin redirect expansion, cross-tenant retrieval, unauthorized mutation, fabricated citation acceptance, or retrieval after source deletion was observed. These results are bounded verification evidence, not a claim that every possible network or deployment configuration has been exhaustively tested.

Non-blocking observations and verification limitations:

- The existing mixed-source integration test intentionally fails query embeddings and uses lexical fallback. This alone would not establish mixed hybrid operation; the additional real-model probe below closes that gap.
- The first supplemental probe failed at generation with `unavailable`: its temporary harness incorrectly read `OLLAMA_MODEL` from the Zod-parsed application configuration, which strips that field. The actual provider factory reads the environment directly. Only the `/tmp` harness was corrected to use the resolved Compose model; no application code was repaired. The corrected probe passed. This failed attempt is retained here rather than counted as a pass.
- The first sandboxed host HTTP checks could not open local sockets (`000`, curl exit 7). Repeating the same checks with approved local-network access returned 200/200. These were sandbox access failures, not application health failures.
- A search found `rejectUnauthorized: false` examples in **Undici documentation**, not in the crawler execution path. The crawler uses Node HTTP/HTTPS and explicitly sets `rejectUnauthorized: true`.
- The known Mammoth dependency chain remains moderately vulnerable; exact results are recorded below. It was not introduced by the M28 dependency diff.

## Gate 1 evidence

Pre-flight commands:

```sh
git status -sb
git diff --stat
docker compose ps -a
curl -sS -o /tmp/m28-acceptance-health.json -w '%{http_code}\n' http://localhost:3001/api/health
curl -sS -o /tmp/m28-acceptance-ready.json -w '%{http_code}\n' http://localhost:3001/api/ready
git diff --name-only -- backend/migrations
```

Initial status was `## main...origin/main`, with the existing implementation changes unstaged/untracked. No reset or cleaning occurred. Initial tracked diff: **33 files, 262 insertions, 53 deletions**; ordinary diff statistics exclude untracked M27/M28 files. The tracked migration diff was empty. M27 was already untracked at pre-flight, so Git alone cannot provide its historical accepted version; it was unchanged by this verification.

Inspected [M28 migration](../backend/migrations/1791400000000_website-knowledge.js). Live `public.pgmigrations` contains exactly:

```text
1 1790914311352_initial-production-schema
2 1790914547732_document-storage
3 1791000000000_document-ingestion
4 1791100000000_production-rag
5 1791200000000_public-platform-security
6 1791300000000_commercial-saas-foundation
7 1791400000000_website-knowledge
```

The supplied six-migration baseline therefore increases by exactly one. The migration adds schema/views and plan fields, extends the finite usage check, and preserves document tables. Its `down` refuses an unreviewed rollback; no down migration was run.

Live catalog commands used `docker compose exec -T postgres psql -U north_orbital -d north_orbital -c ...` with:

```sql
SELECT tablename,indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN
 ('website_sources','website_pages','website_crawl_jobs','manual_faqs','knowledge_chunks')
ORDER BY tablename,indexname;
SELECT conrelid::regclass,conname,pg_get_constraintdef(oid)
FROM pg_constraint WHERE connamespace='public'::regnamespace
AND conrelid IN ('website_sources'::regclass,'website_pages'::regclass,
 'website_crawl_jobs'::regclass,'manual_faqs'::regclass,
 'knowledge_chunks'::regclass,'usage_counters'::regclass);
```

Results: **20 indexes** on the five M28 tables and **42 constraints** across those tables plus usage counters. Actual database definitions agree with the migration.

| Relation | Verified persistence / constraints |
|---|---|
| `website_sources` | Organization/chatbot, normalized URL/origin, status, schedule/due times, attempt/success/completion/error metadata, creator and timestamps; composite chatbot FK; unique scoped seed |
| `website_pages` | Organization/chatbot/source, canonical URL/path/title, hash, HTTP/provenance metadata, validators, extraction version, state, discovery/index/removal timestamps; composite source FK and unique scoped canonical URL |
| `website_crawl_jobs` | Organization/chatbot/source, queued/running/successful/failed, attempts/max attempts, availability, lease, worker token, start/completion/error metadata; composite FK |
| `manual_faqs` | Organization/chatbot, bounded question/answer/category, ready/disabled state, creator/timestamps; composite chatbot FK |
| `knowledge_chunks` | Organization/chatbot plus website/page or FAQ identity; mutually exclusive source kinds; composite cascading FKs; generated FTS; `vector(1024)`; dimensions check; unique per-source chunk positions |

`ready_knowledge_chunks` and `knowledge_vectors` are shared retrieval views, not a second website/FAQ retriever. Documents keep their original tables. The source-specific rows provide shared identity through the views rather than a generic JSON source record.

Indexes include due-source lookup, available queued jobs, running leases, scoped page state, scoped chunks, GIN FTS, HNSW cosine vectors, and `website_one_live_job`, a partial unique index over queued/running jobs. The M28 integration test rejects a cross-tenant page FK with PostgreSQL **23503**, and duplicate normalized sources with **23505**.

Live plan limits:

| Plan | Website sources | Website/FAQ knowledge pages | Indexed bytes |
|---|---:|---:|---:|
| beta | 5 | 200 | 20,000,000 |
| starter | 10 | 500 | 20,000,000 |
| growth | 30 | 2,500 | 20,000,000 |
| business | 100 | 10,000 | 20,000,000 |

[SourceService capacity checks](../backend/src/sources/service.ts), [commercial locking](../backend/src/commercial/service.ts), and job finalization enforce these in PostgreSQL transactions under the organization lock. These are separate from accepted document limits. Indexed bytes include UTF-8 chunk content plus 4,096 bytes per vector. Changed/new website pages additionally consume ingestion pages.

The database metric CHECK and [MetricSchema](../backend/src/commercial/model.ts) enumerate nine finite names, including `website_pages_indexed`, `website_crawl_requests`, and `manual_faq_entries`. There is no customer API accepting arbitrary metric names.

Pre-flight and final persistent baseline both match **3 organizations / 3 subscriptions / 5 documents / 14 chunks / 14 vectors / 0 cleanup jobs**. Content-inclusive row fingerprints stayed identical during acceptance; see inventory below. This proves preservation during this run and agrees with the supplied pre-M28 counts; no historical pre-M28 fingerprint was supplied.

## Gate 2 evidence

Executed:

```sh
cd backend
npx vitest run tests/crawler-security.test.ts tests/crawler-crawl.test.ts --reporter=verbose
```

Result: **2 files, 69 passed**: 58 security cases and 11 crawling cases. They also passed in the full 253-test backend run.

Inspected [URL/address policy](../backend/src/sources/url.ts), [network transport](../backend/src/sources/http.ts), [configuration](../backend/src/sources/config.ts), [robots/sitemaps](../backend/src/sources/discovery.ts), and [crawl traversal](../backend/src/sources/crawl.ts).

| Property | Concrete evidence |
|---|---|
| URL policy | HTTP and HTTPS accepted; WHATWG URL normalizes scheme/host/default ports/dot segments; fragments removed; query order and repeated parameters retained |
| Forbidden input | Tests reject file/ftp/gopher/data/javascript/mailto/tel/unix, embedded credentials, localhost, malformed/non-public addresses; all other protocols fail the two-protocol allowlist |
| IPv4 SSRF | Tests reject 127.0.0.1, private ranges, link-local, metadata 169.254.169.254, Azure 168.63.129.16, CGNAT, multicast, broadcast, and alternative loopback encodings such as 2130706433 and 0x7f000001 |
| IPv6 SSRF | Loopback, mapped loopback, unique-local, link-local, multicast and transition/documentation ranges rejected; ordinary global IPv6 accepted |
| DNS rebinding | Every returned address must pass; mixed public/private answers fail. Connection uses a custom lookup returning the validated address/family, with `agent:false`. A test records exactly one resolver call and verifies the actual connection lookup still returns the allowed address after the resolver is configured to return loopback |
| Host/SNI/TLS | Original URL hostname goes to HTTPS request; certificate verification explicitly true; no trust-all agent or custom verification bypass. Worker environment prints `NODE_TLS_REJECT_UNAUTHORIZED=unset` |
| Redirects | Each target is normalized and exact-origin checked before the next transport call; each production transport call resolves/validates/pins again. Private and foreign-origin redirects reject; redirect-loop test reaches the bounded limit |
| Body/time limits | Declared and streamed oversized bodies reject; compressed responses reject; DNS abort timeout tested. Request abort covers connection and response, with a total crawl deadline also checked around discovery/pages/embedding preparation |
| Crawl bounds | Sequential requests per crawl, 50 pages, depth 3, 100 links/page, 5 redirects, 10-second request and 120-second total default; all configurations have finite Zod maxima |
| Robots | Correct crawler agent selection, longest allow/disallow matching, wildcard/end matching, encoded unreserved path handling, unrelated-agent handling. 404 allows; temporary error fails conservatively; disallowed seed/page/redirect is not crawled |
| Sitemap | Robots declaration, conventional sitemap fallback, sitemap index, depth and URL bounds tested; document count and byte limits inspected; visited-document set prevents recursive loops; exact-origin/SSRF policy applies |
| XML safety | Strict saxes parser, DTD/entity rejection, malformed XML rejection, parser nesting bound; no external entity fetch mechanism enabled |

Searches included `rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED`, `checkServerIdentity`, `secureContext`, and `insecureHTTPParser` in application source and relevant installed parser/network dependencies. Only the crawler's explicit `rejectUnauthorized:true` appeared in application code. Undici documentation examples are not executed by this crawler. No production configuration uses a certificate-verification bypass.

Tests use injected responses/resolvers or a mocked Node request boundary. They do not establish real deployed firewall behavior or a live public certificate-handshake matrix; those are operational follow-ups. Production contains no localhost fixture exception.

## Gate 3 evidence

Executed the unchanged live harness:

```sh
docker compose stop worker
cd backend
node scripts/local-compose-env.mjs scripts/verify-website-knowledge.mjs
cd ..
docker compose up -d --no-deps worker
```

Result, exit **0**:

```text
M28 live acceptance passed: controlled crawl, real 1024-dimensional embeddings,
unchanged-page preservation, website/FAQ production answers, scoped citations,
deletion and audit.
Original inventory preserved.
```

The worker was stopped only for this fixture, then restored. The script rejects running with an active worker, creates a disposable authenticated tenant/chatbot, injects a deterministic website transport, uses real local qwen embeddings and the API's real generation provider, and removes only its fixture data in `finally`. No arbitrary website is contacted, and production SSRF is not weakened.

The 17 M28 PostgreSQL integration cases run migrations in a random isolated schema. Gate 3's test asserts extracted title/provenance, removed navigation text, FTS results, semantic retrieval, **`vector_dims(embedding)=1024`**, and empty foreign-tenant results. The supplementary Gate 6 probe also runs actual website → extraction → embedding → production hybrid retrieval → model answer → validated citation.

Extraction inspection confirms Cheerio, semantic main/article preference, paragraphs/headings/list/table text boundaries, whitespace normalization, and removal of script/style/noscript/template/hidden elements and repetitive navigation/header/footer content. There is no JavaScript execution or headless browser. Navigation links are discovered before navigation text is removed. BFS tests establish same-origin discovery, fragment normalization, deduplication, page/depth limits, binary rejection, and ignored non-HTTP/foreign links.

Persistence includes scoped URL/title/hash/state/timestamps and page/source IDs. Original HTML is not persisted. Citation metadata is built from selected database evidence, not model-supplied page URLs or UUIDs. [Citation validation](../backend/src/rag/chat-service.ts) accepts only selected S-identifiers, then re-queries current scoped rows and compares identity, type, URL, title and content provenance after generation. Unknown IDs yield fallback.

The public citation integration case verifies **200** for website and FAQ evidence, correct type/canonical URL, no organization UUID or embedding/worker/creator metadata, **404** for a random fabricated chunk, and **404** after deletion. [Public router](../backend/src/public/router.ts) uses a public chatbot identity and origin policy, scoped repository lookup, and a bounded **1,500-character excerpt**. Active previously indexed snapshots remain available while a resync is running/failed; disabled/deleted/removed content is excluded.

## Gate 4 evidence

Executed `npm run test:db -- --no-file-parallelism`: **76 passed**, including the M28 resync/job tests in [website-knowledge.test.ts](../backend/tests/integration/website-knowledge.test.ts). The controlled live harness additionally verifies sync HTTP **202**, manual claim/process, and unchanged chunk IDs.

Inspected [enqueue/sync routes](../backend/src/sources/router.ts), [service enqueue](../backend/src/sources/service.ts), [CrawlJobs](../backend/src/sources/jobs.ts), and the independent crawl loop in [worker.ts](../backend/src/ingestion/worker.ts).

| Scenario | Observed test / implementation evidence |
|---|---|
| Asynchronous manual sync | HTTP route only validates, authorizes, rate-limits and enqueues; returns 202; crawler executes in worker |
| Duplicate requests | Ten simultaneous sync calls produce one queued job |
| Concurrent claiming | Five simultaneous claims produce one claim; SQL uses `FOR UPDATE OF j SKIP LOCKED` |
| Lease recovery | Expired claim is recovered, old token cannot finalize; weekly schedule remains more than six days away; exhausted attempt becomes failed |
| Temporary failure | TIMEOUT causes retryable failure; 429/5xx classified retryable; 30-second exponential backoff bounded at one hour; numeric Retry-After capped at one hour |
| Permanent failure | Robots failure is terminal in integration test; policy/MIME errors default non-retryable; all attempts bounded |
| Automatic schedule | Due daily source is durably enqueued and completes with future next-sync; accepted modes are only manual/daily/weekly |
| Identical content | Embedding spy not called; same chunk IDs remain |
| Conditional 304 | Existing content/chunks survive and no embedding occurs; cached links preserve discovery. ETag and Last-Modified request paths inspected |
| Changed content | Fresh embeddings created; old chunk IDs no longer resolve; new text appears in FTS |
| Removed content | Complete crawl omitting a prior page leaves one active page and marks the absent page removed; its chunks deleted in finalization |
| Partial failure | Timeout leaves the previous two-page snapshot intact; page/depth/link truncation yields incomplete enumeration rather than absent-page deletion |
| Atomic finalization | Replacement preparation precedes transaction; page/chunk/vector changes, removals, quota checks, metering, completion and audit commit together; quota failure rolls back to previous content |
| Deletion/disable during leased work | Cascading deletion cancels work; disabled source test rejects old finalization and hides evidence |

Final jobs: **0 queued, 0 overdue, 0 running, 0 stale, 0 exhausted**, and no active document jobs. Worker runs separate bounded document and crawl loops. The lease design permits stale computation to finish locally but fencing prevents it from publishing after recovery/deletion; network work is also duration-bounded.

## Gate 5 evidence

[FAQ model/service](../backend/src/sources/service.ts) and [routes](../backend/src/sources/router.ts) provide scoped create/list/get/update/delete. Bounds are question 500, answer 8,000, category 100 characters. Strict Zod schemas reject unknown client associations. Database constraints reinforce text bounds.

Executed M28 integration results include:

- Owner create **201**, admin create **201**; member FAQ/website mutation **403**, member read **200**.
- Missing CSRF **403**, empty question **400**, unsafe submitted website **400**, foreign-tenant FAQ **404**.
- FAQ FTS results have `manual_faq` source type. The shared vector schema is 1,024 dimensions, and the supplemental real hybrid test returns a validated manual FAQ answer.
- Update removes old chunk identity and makes new text searchable; `xmin` fencing prevents a stale concurrent replacement from committing. Replacement content and embedding commit together.
- Delete empties retrieval and public citation lookup becomes **404**.
- Audit sequence asserts exactly `manual_faq.created`, `manual_faq.updated`, `manual_faq.deleted` for the tested entry.
- Export contains website source/page metadata and FAQ content, and no embedding/worker/lease fields. [Privacy export](../backend/src/commercial/privacy.ts) uses explicit column projections, not `SELECT *` serialization.

The fabricated-citation production test returns fallback for `S99`; public citation lookup rejects a random UUID. The real FAQ supplemental check also passes fake-ID rejection with real retrieval enabled.

## Gate 6 evidence

Existing deterministic mixed test: a ready PDF row/vector, website pages and FAQ coexist in one isolated chatbot. Distinct queries identify each source type, combined retrieval includes all three, and fake/unrelated queries fall back. That test intentionally uses lexical fallback; it is not presented here as proof of the semantic branch.

Additional independent command:

```sh
node /tmp/m28-acceptance-hybrid.mjs
```

This temporary verification-only probe:

1. Creates a random `accept28_*` schema and applies the unchanged seven migrations.
2. Copies metadata, text and existing vectors from an accepted ready workstation PDF into an isolated chatbot. Public accepted rows and object storage remain read-only; nothing is re-ingested or replaced.
3. Ingests one controlled Atlas website and creates a lunar-workshop FAQ using real `qwen3-embedding:0.6b`.
4. Uses the actual `PostgresRetrievalRepository`, `ProductionRetriever`, ranking/selection, `createProductionChatService` and `qwen3.5:9b`. Semantic evidence is asserted, not deliberately disabled.
5. Checks distinct document/website/FAQ answers and citation kinds, mixed bounded evidence, foreign scope, unrelated fallback, fake S99 rejection and source deletion.
6. Drops only its newly created isolated schema in `finally`.

Corrected probe output, exit **0**:

```json
{"case":"document","passed":true,"semanticEvidence":true,"citationKinds":["document"]}
{"case":"website","passed":true,"semanticEvidence":true,"citationKinds":["website"]}
{"case":"manual_faq","passed":true,"semanticEvidence":true,"citationKinds":["manual_faq"]}
{"case":"mixed_hybrid","passed":true,"sourceTypes":3,"selected":4,"weights":[0.85,0.15]}
{"case":"isolation_fallback_fake_ids_deletion","passed":true}
```

The schema was removed successfully. No customer page contents, accepted document text, prompts, generated answer bodies, credentials or embeddings were printed by the probe.

[Repository](../backend/src/rag/repository.ts) uses the shared views for both FTS and pgvector, with organization/chatbot predicates on chunks and vectors. [Ranking](../backend/src/rag/ranking.ts) retains 0.85 semantic / 0.15 lexical RRF, bounded candidates/context, deterministic tie-breaking and duplicate evidence suppression. The mixed probe asserts at most configured top-K and context characters. There is no FAQ keyword shortcut or separate toy website retriever. JSON evidence and system instructions explicitly classify retrieved content as untrusted; this is not full M35 acceptance.

## Gate 7 evidence

Commands executed with Node **22.23.2** (host PATH explicitly selected):

```sh
cd backend
npm run build
npm test
npm run test:db -- --no-file-parallelism
npm run evaluate:rag
npm audit --omit=dev --json
node scripts/verify-log-privacy.mjs
cd ../frontend
NG_BUILD_MAX_WORKERS=1 npm run build
npm test -- --watch=false
npm audit --omit=dev --json
cd ../widget
npm run build
npm test
npm audit --omit=dev --json
cd ..
docker compose config --quiet
docker compose build backend worker migrate
docker compose ps -a
git diff --check
```

| Check | Independent result |
|---|---|
| Backend TypeScript build | Exit 0 |
| Backend unit tests | **22 files / 253 passed** |
| PostgreSQL integration | **8 files / 76 passed** |
| Production RAG evaluation | **2 files / 48 passed** |
| Targeted crawler security/crawl | **2 files / 69 passed** (subset of unit suite) |
| Angular build | Exit 0; bundle 343.07 kB raw |
| Angular tests | **3 files / 19 passed**, including 10 knowledge tests |
| Widget build | Exit 0 |
| Widget tests | **1 file / 4 passed** |
| Compose validation | Exit 0 |
| Backend/worker/migration Docker builds | Exit 0; cached layers reused where applicable |
| Controlled live website/FAQ acceptance | Exit 0 |
| Supplemental real mixed hybrid check | Exit 0 after correcting the temporary harness model lookup |
| Whitespace check | `git diff --check`, exit 0 |

Counts match the implementation claims. RAG evaluation and targeted crawler runs overlap the full suites and are not extra unique tests.

Runtime observed initially and finally: backend **healthy**, PostgreSQL **healthy**, MinIO **healthy**, worker **running**. The migration service shows **Exited (0)** from an earlier run; its age is not evidence of M28 application—the seven rows in the live migration table are. No new ports or infrastructure were introduced by verification. Final host-port checks on **3001** returned:

```text
GET /api/health 200
GET /api/ready  200
```

Authorization is mounted before the source router: [app.ts](../backend/src/app.ts) mounts session authentication and tenant authorization; [security/http.ts](../backend/src/security/http.ts) verifies session CSRF and rejects member administrative mutations. The existing commercial/bearer/public isolation regression tests passed, including API-key scope, expiry/revocation, tenant isolation, distinct bearer limits, shared atomic message quotas and durable document cleanup.

M28 quota tests race four FAQ writes against capacity one and admit exactly one. Finalization quota failure preserves the old website index. Mutation rate exhaustion returns **429**; page pagination rejects limit 101 with **400**. The finite meter calls are inside the same organization transaction as successful create/finalization; deduplicated sync does not increment again. Final usage quantities are below.

Privacy evidence:

```text
apiKeySecrets: 0 matches
documentContent: 0 matches
websiteFaqContent: 0 matches
credentialFields: 0 matches
vectors: 0 matches
Known credential values: 0 matches
```

A separate count-only runtime log scan found **0 secret/hash fields**, **0 raw HTML matches**, **0 crawl/document queue failure messages**. Source review found sanitized queue errors and no page-body logging in the crawler. Request logger serializers omit body/headers; redaction includes authorization, cookies, CSRF/session tokens and storage secrets. Audit insertion projects only `result/count/enabled/role`; a live audit query found **0 M28 events with metadata keys outside that allowlist**. No raw audit or credential values were printed.

Frontend source and tests verify website list/add/normalized URL/status/count/dates/schedule/sync/delete, FAQ list/create/edit/delete, confirmation behavior, busy-state duplicate suppression, draft preservation, permission-hidden mutation controls, labels and live status. Customer text uses Angular interpolation; searches found no `innerHTML` or security-bypass APIs in the knowledge component. Errors use safe fixed messages. Browser connection discovery returned **“No browser is available”**, followed by an empty browser list. **MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED.**

Production files inspected: [.env.production.example](../.env.production.example) and [production-azure.md](production-azure.md). The template has placeholders, verified database TLS (`sslmode=verify-full`), HTTPS service endpoints, secure cookies, finite crawler settings, and no localhost/127.0.0.1/host.docker.internal/development credential matches. Documentation covers outbound DNS/HTTP(S), pinned DNS and TLS, metadata/private-network egress denial, preserving required private DB/storage/inference connectivity, worker sizing/concurrency, scheduler/leases, queue alerts, DB growth, privacy, backup consistency and restore implications. Actual Azure enforcement was not exercised locally.

## Persistent inventory

Final `public` inventory (isolated test schemas excluded and removed):

| Item | Pre-flight | Final |
|---|---:|---:|
| Migrations | 7 | 7 |
| Organizations | 3 | 3 |
| Organization subscriptions | 3 | 3 |
| Documents | 5 | 5 |
| Document chunks | 14 | 14 |
| Document embeddings | 14 | 14 |
| Object cleanup jobs | 0 | 0 |
| Website sources | Not separately counted | 0 |
| Website pages | Not separately counted | 0 |
| FAQs | Not separately counted | 0 |
| Knowledge chunks, including inline vectors | Not separately counted | 0 |

Final crawl jobs: **0 total**, comprising queued **0**, running **0**, successful **0**, failed **0**. Overdue queued (>15 minutes), stale running (>60 seconds), exhausted failures and active document jobs: **0 each**. Source/page/chunk scoped orphan checks: **0 each**. Document chunk and document vector orphan checks: **0 each**. The catalog contains no remaining `accept28_*` schema. No disposable acceptance sources are retained.

Content-inclusive fingerprints were computed by ordered `row_to_json` aggregation and MD5 inside PostgreSQL; only the hashes were returned. Pre-flight and final values match exactly:

```text
documents            df9eb1f28cde6af5c26b4bfe441a17af
document_chunks      fb59b7458b621a3762a847a4376bd9fb
document_embeddings  6f329399e40beaeef83150be45b84ce9
```

Final finite usage aggregates (`SUM(quantity)` over retained public counters, all periods):

| Metric | Quantity |
|---|---:|
| api_requests | 5 |
| documents_created | 1 |
| ingestion_pages | 2 |
| internal_chat_messages | 9 |
| public_chat_messages | 1 |
| storage_bytes | 1,975 |
| website_pages_indexed | 0, no retained row |
| website_crawl_requests | 0, no retained row |
| manual_faq_entries | 0, no retained row |

Disposable organizations' usage cascades away with fixture cleanup. Their append-only audit history remains. Final M28 audit counts include prior implementation checks as well as this run, and are not attributed exclusively to independent acceptance:

| Action | Count |
|---|---:|
| website_source.created | 3 |
| website_source.updated | 0 |
| website_source.deleted | 2 |
| website_source.sync_requested | 3 |
| website_source.sync_completed | 6 |
| website_source.sync_failed | 0 |
| manual_faq.created | 3 |
| manual_faq.updated | 0 |
| manual_faq.deleted | 2 |

Update/failure audit paths were exercised in isolated tests whose schemas were cleaned. Source deletion was verified before tenant cleanup by the live harness, including no remaining pages/chunks/jobs, a deletion audit event and citation **404**.

## Dependency audit

Independent `npm audit --omit=dev --json` results:

| Package | Critical | High | Moderate | Low | Informational | Audit exit |
|---|---:|---:|---:|---:|---:|---:|
| backend | 0 | 0 | 3 | 0 | 0 | 1 |
| frontend | 0 | 0 | 0 | 0 | 0 | 0 |
| widget | 0 | 0 | 0 | 0 | 0 | 0 |

Backend findings are `sprintf-js`, `argparse`, and `mammoth`, all from [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), **unbounded precision specifier denial of service**, CVSS **5.3**, affected sprintf-js range `<=1.1.3`.

Executed `npm ls mammoth argparse sprintf-js saxes --omit=dev`:

```text
mammoth@1.13.0
└── argparse@1.0.10
    └── sprintf-js@1.0.3
saxes@6.0.0
```

The package diff adds saxes only; Mammoth was already present. npm proposes a breaking Mammoth downgrade to **0.3.29**. No audit fix or dependency change was made. The unrestricted backend audit is **not clean**, but these known moderate findings are explicitly allowed by the acceptance rules; the required zero high/critical target is met. Continue tracking upstream remediation without sacrificing accepted DOCX ingestion. No M28 parser dependency advisory appeared in this audit.

## Manual follow-ups

- **MANUAL BROWSER VISUAL ACCEPTANCE STILL REQUIRED**: real keyboard/focus/modal behavior, responsive layout, screen-reader announcements and visual state review. Browser runtime discovery returned no available sessions.
- Verify deployed Azure egress rules, DNS behavior, metadata/private-route isolation, server certificate validation, and required private dependency connectivity. Local application checks do not prove cloud firewall configuration.
- Perform a production-sized backup/restore rehearsal including all source/page/chunk/job/usage tables, lease recovery, deletion retention and load-controlled scheduler restart.
- Track the inherited moderate Mammoth dependency advisory. No high/critical production vulnerability was reported by the executed audit.
- The supplemental real-hybrid probe is a temporary acceptance artifact, not a newly committed regression test. Its checks/results and command are documented here; the existing deterministic integration test still intentionally uses lexical fallback for mixed queries.

## Known limitations

- No authenticated external crawling, cookies, intranet/private-network crawling, JavaScript execution, or headless rendering.
- Exact-origin HTTP(S) scope only; no automatic subdomain/domain expansion.
- Compressed website/sitemap responses are rejected rather than decompressed. PDFs/binary website assets remain outside this ingestion route.
- HTML canonical tags do not override scope or merge pages. Query parameters are preserved.
- Recurrence is manual/daily/weekly; no arbitrary cron. Retry-After supports bounded numeric seconds, not date syntax.
- Incomplete discovery retains absent old pages; it does not authorize mass removal. Failed resync may continue serving its previously indexed active snapshot.
- Public citations expose bounded provenance, not administration metadata. Previously delivered answers and retained backups/audit are not erased by source deletion.
- Full M35 prompt-injection defenses, platform plugins, WhatsApp and payments are not claimed.

## Git state

Final status and diff statistics follow. They include the retained pre-existing M27 working-tree changes as well as M28; ordinary diff statistics omit untracked files. Only this report was added to the repository by acceptance. Source/configuration hash verification found zero changes. No secret files were unexpectedly tracked: `git ls-files '*env*' '*secret*' '*pem*' '*key*'` returned only the two tracked environment examples; the production example is untracked and contains placeholders. No commit or push occurred.
`git status -sb`:

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
?? docs/milestone-28-acceptance.md
?? docs/milestone-28-verification.md
?? docs/production-azure.md
?? frontend/src/app/account.spec.ts
?? frontend/src/app/account.ts
?? frontend/src/app/knowledge.spec.ts
?? frontend/src/app/knowledge.ts
?? premium-audit.json
```

`git diff --stat`:

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
