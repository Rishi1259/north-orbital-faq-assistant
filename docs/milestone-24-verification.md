# Milestone 24 — Production RAG verification

Implemented and verified locally on 2026-10-03 (Asia/Kolkata). The existing local working tree
was the baseline; no commit, push, reset, clean, stash or volume deletion was performed.

## Architecture and runtime

`POST /api/organizations/:organizationId/chatbots/:chatbotId/chat` now validates the chatbot,
then calls `rag/chat-service.ts` → `ProductionRetriever` → `PostgresRetrievalRepository`.
The runtime does not load the generated semantic JSON or local customer-document chunks,
and does not mix the historical static FAQ corpus into tenant answers. The legacy service and
index scripts remain for offline regression work. `predev` no longer regenerates local indexes;
Compose no longer mounts generated documents into the API.

The first retrieval pass uses the actual user question. PostgreSQL lexical retrieval runs alongside
query embedding + PostgreSQL cosine retrieval. The service merges ranks, optionally performs one
contextual rewrite and second retrieval pass, deduplicates, bounds evidence, generates an answer,
validates citations, and rechecks ready source rows before returning the existing response contract.

Generation and embedding provider abstractions remain intact. Optional `generateStructured`
on `ModelProvider` enables a separate query schema; answer-only providers have a compatibility
adapter. The production composition root supplies provider/model identity separately from retrieval.
No new external search store, cache, agent framework, authentication or commercial UI was added.

## Migration and indexes

`backend/migrations/1791100000000_production-rag.js`, following the ingestion migration:

- Adds stored generated `document_chunks.search_vector = to_tsvector('simple', content)`.
- Adds `document_chunks_search_gin`.
- Adds `document_chunks_scope (organization_id, chatbot_id, document_id, chunk_index, id)`.
- Adds `document_embeddings_scope_model (organization_id, chatbot_id, provider, model, dimensions)`.
- Retains the existing vector(1024) column, cosine HNSW index, tables and composite foreign keys.
- Down migration removes only the added indexes and FTS column.

Applied successfully to the populated development database using the Compose migrate service.
No ingested documents were replaced. All tests also apply actual migrations in isolated schemas.
A development-database down migration was intentionally not run. Adding the stored generated
column takes a normal ALTER TABLE lock and computes existing rows; schedule this migration
appropriately for a large production database.

Metadata-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` checks on the accepted tenant showed
bounded SQL sorting/joining, approximately 0.804 ms lexical and 0.359 ms semantic in that sample.
The small corpus caused PostgreSQL to prefer sequential scans. This is not a production-scale
benchmark; application code never fetches all vectors or scans all customer chunks in memory.
The GIN/HNSW and scope indexes are available to the planner as data grows.

## Retrieval and evidence selection

Lexical retrieval uses PostgreSQL's `simple` tokenization with OR-combined lexemes and a small
English question/function-word exclusion list. This tolerates natural questions containing words
absent from a passage, while preserving names and non-English terms without stemming. Empty,
punctuation-only and excluded-token queries return no candidates. Terms and scope are parameterized;
SQL ranking uses `ts_rank_cd`, then document ID, chunk index and chunk ID.

Semantic SQL uses `<=>` cosine distance and rejects model/provider/dimension mismatches. The
service and repository validate 1024 finite values with nonzero norm. Query embedding follows
the existing plain-text embedding convention; the vector never enters prompts or responses.

Weighted RRF: `0.85/(60+semanticRank) + 0.15/(60+lexicalRank)`, absent branches contributing zero.
The weights, RRF constant and candidate limits are named validated settings. Across passes a
chunk retains its best rank per branch, so repetition does not inflate its score. Stable ties use
semantic rank, lexical rank, document ID, chunk index and chunk ID.

Evidence selection merges identical chunk IDs, hashes normalized exact content, drops contained
chunks and chunks with at least 85% repeated five-word shingles relative to already selected evidence.
The overlap denominator is the new candidate, preserving neighbors with substantial new information.
Comparisons are bounded by the candidate counts and at most eight selected chunks. Distinct adjacent
chunks remain eligible. Default limits are five chunks and 12,000 characters for the entire encoded
evidence context, including metadata/escaping/separators. A final chunk can be truncated to fit.

## Tenant and lifecycle guarantees

Every lexical, vector and source-ID SQL lookup requires both organization and chatbot IDs.
All queries explicitly join chunks to documents on the composite scope and require `status='ready'`;
vector queries additionally scope embeddings and join their document/chunk ownership. Neither a
UUID nor an upstream HTTP check alone grants retrieval. Service checks also reject out-of-scope rows.

Tests cover two organizations, two bots in one organization, inconsistent scope pairs, all four
statuses, transitions, chunk/document cascade deletion and source lookups. Citations are rechecked
after generation; missing, changed-content or non-ready cited chunks cause a safe fallback.
This is a point-in-time check, not a lock held throughout response delivery.

These guarantees preserve the existing tenant-routing trust model. Authentication/authorization of
who may select a tenant UUID remains deferred to Milestone 26.

## Query rewriting

With history present, pronouns/references, elliptical questions, or short questions with zero
first-pass candidates can trigger rewriting. Standalone questions with adequate results do not.
The rewriter receives at most four recent messages, each capped at 500 characters. The original
question is always preserved in pass one and final generation. History resolves intent only and
is explicitly not authoritative evidence.

The model returns only a structured standalone query of at most 500 characters; source IDs,
extra fields, empty values, multiline/JSON-shaped queries and malformed outputs are rejected.
An eight-second timeout aborts supported providers. Exceptions/timeouts/invalid or unchanged
queries preserve first-pass evidence. Pass two uses the exact same tenant scope, and results are
merged using best branch ranks. There is no loop or third retrieval pass.

An initial real run answered the follow-up from first-pass evidence while its answer-envelope
rewrite returned `canAnswer=false`. This prompted the dedicated `{ "query": "..." }` implementation;
unit tests retain coverage for both provider interfaces. The final real follow-up request
`cd8ef412-3a68-4571-b343-9fe2dc66bf75` logged passes 1 and 2, `rewriteUsed=true`,
`semanticFallbackUsed=false`, and five selected evidence chunks. Retrieval plus rewriting took
2,615 ms in that run, and the answer returned one validated citation. All eight smoke cases
passed again on the updated implementation.

## Generation, citations and failure behavior

Only selected ready tenant chunks enter JSON evidence blocks with server-assigned `S1`…`S8`
identifiers. The prompt labels documents and history as untrusted data, rejects embedded instructions,
requires support from supplied evidence and allows evidence-backed negative answers.

The server intersects model source IDs with selected in-scope evidence, removes duplicate/unknown
citations and preserves evidence order. Metadata comes only from retrieved rows. No valid citation,
an unsupported answer or empty evidence yields the friendly insufficient-evidence response. Empty
evidence skips generation entirely. Citation markers in answer prose are removed; source links are
server generated. Malformed structured generation retains the existing 502 convention, model outage
503, model timeout 504, and total retrieval failure a generic 500 with no stack trace.

Citation links use the new tenant-scoped `document-sources/:chunkId` route. It repeats chatbot and
ready-only repository checks, returning title, document/chunk IDs, page/section and excerpt. The old
unscoped document-source route has no production chunks loaded and cannot expose uploaded evidence.
Storage keys, credentials and embedding vectors are absent from prompts, citations and source responses.

Embedding outage/dimension error preserves lexical retrieval. Lexical miss can still use semantic
matches. One failed SQL branch preserves the other; total DB unavailability is not disguised as an
empty corpus. Rewrite/second-pass failure preserves the original results. Safe Pino fields include
request/tenant IDs, pass, counts, rewrite/fallback flags, fixed failure labels and durations. No query,
rewritten query, text, prompt, model body, vectors, cookies or authorization headers are logged by RAG.

## Environment

| Variable | Default | Validation |
| --- | --- | --- |
| RAG_TOP_K | 5 | integer 1–8 |
| RAG_LEXICAL_CANDIDATES | 30 | integer 1–100 |
| RAG_VECTOR_CANDIDATES | 30 | integer 1–100 |
| RAG_VECTOR_WEIGHT | 0.85 | number 0–1 |
| RAG_LEXICAL_WEIGHT | 0.15 | number 0–1; weights cannot both be zero |
| RAG_RRF_K | 60 | integer 1–1000 |
| RAG_MAX_CONTEXT_CHARS | 12000 | integer 1000–40000 |
| RAG_QUERY_REWRITE_ENABLED | true | true/false |

Zod validates these at startup. Both example env files and Compose forwarding are updated.
`OLLAMA_EMBEDDING_MODEL`, `EMBEDDING_TIMEOUT_MS`, `OLLAMA_MODEL` and `MODEL_TIMEOUT_MS` continue
using the existing conventions. The frontend timeout is 110 seconds to accommodate two 30-second
embedding requests, an eight-second rewrite and 30-second generation with the current defaults.

## Automated commands and recorded results

Use Node 22.22.3+ (verified with 22.23.2). Native DB tests read the existing untracked backend `.env`.

```bash
cd backend
npm run build
npm test
npm run test:db
npm run evaluate:rag
cd ../frontend
npm run build
npm test -- --watch=false
```

| Check | Recorded result |
| --- | --- |
| Backend build | Passed |
| Backend unit/HTTP tests | 132 passed, 18 files |
| DB integration tests | 25 passed, 5 files |
| Focused production-RAG evaluation | 48 passed, 2 files (overlaps suites above) |
| Frontend build | Passed with Node 22.23.2 |
| Frontend tests | 3 passed |
| Compose config/build | Passed |
| Migration | Applied successfully; subsequent migration run had no pending work |
| Backend/PostgreSQL/MinIO health | Healthy; worker running |
| `/api/health`, `/api/ready` | HTTP 200 |
| Real PDF/DOCX/paraphrase/fallback/citation/isolation smoke | Passed |
| Existing ingestion/OCR smoke | Passed PDF, DOCX, scanned PDF, retry exhaustion, manual retry and storage checks |

Initial sandboxed HTTP/DB tests could not bind/connect and were rerun with local network permission.
The first Angular invocation found Node 20; explicit Node 22 PATH fixed that. The sandboxed Angular
build aborted, then passed outside the sandbox. One initial DB test failed before the public FTS
migration was applied; the complete suite passed afterward. A smoke run immediately after container recreation also hit a readiness race; the script now
waits for readiness and the complete rerun passed. Failed attempts were not counted as passes.

## Real local verification commands

From the repository root, with native Ollama available:

```bash
docker compose config --quiet
docker compose build
docker compose run --rm --no-deps migrate
docker compose up -d --no-build backend worker
docker compose ps
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:3001/api/ready

docker compose run --rm --no-deps \
  -v "$PWD/backend/scripts:/app/backend/scripts:ro" \
  backend node scripts/verify-rag.mjs

docker compose run --rm --no-deps \
  -v "$PWD/backend/scripts:/app/backend/scripts:ro" \
  -v "$PWD/documents/samples:/app/documents/samples:ro" \
  worker node scripts/verify-ingestion.mjs
```

The RAG smoke uses the accepted organization `f94827a2-4ec3-4bd0-92cc-49accd1cdf9b` and chatbot
`f732a2ca-55b2-47fa-aefa-1fb497e56262`. Existing ready PDF/DOCX/scanned documents are read-only.
The script asserts PDF/DOCX facts, a paraphrase, unrelated/absent-answer fallbacks, a follow-up,
validated citation paths/metadata and empty-tenant/wrong-tenant isolation. It creates and removes
only its own empty test tenant. It logs case names, booleans, citation counts and request IDs,
never questions/answers/evidence. Expected output: eight passing JSON case records and exit 0.

For another compatible fixture set, override `RAG_TEST_ORGANIZATION_ID`, `RAG_TEST_CHATBOT_ID`
and `RAG_TEST_API_URL`. The default question assertions target the existing public sample content.
The ingestion smoke creates synthetic fixtures and removes only its own rows/objects; it includes
real scanned-PDF OCR and verifies the uploaded bytes. Expected output is success for three formats
and the failure/retry/tenant checks. No volumes are deleted.

## Limitations and acceptance checks

- No production-scale concurrency/load benchmark or ANN recall tuning was performed. Review query
  plans and recall with representative larger tenants before production rollout.
- `simple` FTS has no stemming and the query stop list is English-oriented. Semantic retrieval
  and model quality depend on the configured model/languages; there is no calibrated relevance cutoff.
- Citation validation guarantees source membership/ownership, not logical entailment of every model
  sentence. The generation instruction and real evaluations reduce, but cannot eliminate, hallucination.
- Rewrite heuristics are bounded and may miss unusual references or request unnecessary rewrites.
  Answer-only provider adapters may rewrite less reliably than the dedicated structured interface.
- Context truncation can omit late details. Deduplication uses lightweight lexical overlap, not semantic
  equivalence. Historical corpus evaluation scripts do not target the current production endpoint.
- No manual visual browser pass was performed; frontend behavior is covered by its existing tests/build.
  Before acceptance, optionally exercise a PDF source link, a DOCX source link and a multi-turn chat in
  Angular using the unchanged development tenant context.
- No destructive migration rollback was performed on the populated development database.

Milestone 25 public/widget IDs, branding and domains; Milestone 26 authentication/security/audit/backups;
and Milestone 27 billing/plans/metering/onboarding remain intentionally deferred.
