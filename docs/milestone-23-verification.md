# Milestone 23 verification — 2026-10-02

Implemented against the existing local working tree, including uncommitted Milestone 21/22
schema, tenancy APIs and frontend changes. No commits were made. Private/generated documents
were not changed, and no Docker volumes were removed.

## Architecture

Tenant-validated multipart upload streams to a temporary file, validates PDF/DOCX bytes,
calculates SHA-256, stores the source in a tenant-scoped S3 key, and creates a pending document
and queued job in one PostgreSQL transaction. A separate worker claims jobs with row locking,
heartbeats/fences attempts, downloads/verifies the object, reuses extraction and chunking,
conditionally runs OCR, and generates bounded-concurrency Ollama embeddings. Atomic
finalization replaces chunks/vectors, marks the document ready and completes the job.
Failures use safe summaries, bounded backoff, terminal states and an owned-document retry API.
Current chat retrieval remains unchanged; PostgreSQL retrieval is deferred to Milestone 24.

## Files created

- `.dockerignore`
- `backend/migrations/1791000000000_document-ingestion.js`
- `backend/src/storage/object-storage.ts`
- `backend/src/ingestion/types.ts`
- `backend/src/ingestion/errors.ts`
- `backend/src/ingestion/repository.ts`
- `backend/src/ingestion/upload-validation.ts`
- `backend/src/ingestion/document-service.ts`
- `backend/src/ingestion/document-router.ts`
- `backend/src/ingestion/quality.ts`
- `backend/src/ingestion/ocr.ts`
- `backend/src/ingestion/processor.ts`
- `backend/src/ingestion/worker.ts`
- `backend/tests/ingestion.test.ts`
- `backend/tests/document-api.test.ts`
- `backend/tests/integration/ingestion.test.ts`
- `backend/scripts/verify-ocr.mjs`
- `backend/scripts/verify-ingestion.mjs`
- `docker/minio.Dockerfile`
- `docs/milestone-23-verification.md`

## Files changed from the initial local state

- `.env.example`, `backend/.env.example`, `README.md`
- `backend/package.json`, `backend/package-lock.json`
- `backend/src/config.ts`, `backend/src/app.ts`, `backend/src/server.ts`
- `backend/src/documents/types.ts`, `backend/src/documents/pdf-extractor.ts`
- `backend/Dockerfile`, `compose.yaml`

Other pre-existing changes shown by `git status` belong to the initial working tree; frontend
source, existing tests, old migrations and the current retriever were not edited for this milestone.

## Dependencies

- Runtime: `@aws-sdk/client-s3`, `multer`, `yauzl`.
- Development typings: `@types/multer`, `@types/yauzl`.
- Worker image: Debian Bookworm `ocrmypdf`, `tesseract-ocr`, `tesseract-ocr-eng`, `poppler-utils`
  and their package-managed runtime dependencies.
- Local storage images: pinned upstream MinIO server and `mc`, compiled in Go build stages.

## Commands actually run

Native commands used Node 22.23.2 via an explicit PATH.

| Command / check | Result |
| --- | --- |
| Backend `npm run build` | Passed, strict TypeScript/ESM |
| Backend `npm test` | 17 files, 99 tests passed |
| Backend `npm run test:db` | 4 files, 10 tests passed |
| Frontend `npm run build` | Passed, production bundle |
| Frontend `npm test -- --watch=false` | 1 file, 3 tests passed |
| `docker compose config --quiet` | Passed |
| `docker compose build` | All five images built successfully |
| `docker compose up -d` | Services started successfully |
| `docker compose ps -a` | PostgreSQL, MinIO and backend healthy; worker running; migrate/minio-init exited 0 |
| PostgreSQL migration/table inspection | New migration applied; all seven expected tables present |
| Worker image OCR package version checks | OCRmyPDF 14.0.1, Tesseract 5.3.0, Poppler 22.12.0 |
| Container `node scripts/verify-ocr.mjs` | Real image-only PDF OCR passed |
| Container `node scripts/verify-ingestion.mjs` | Real API/storage/worker/Ollama/database flow passed |
| `git diff --check` | Passed |

The full integration smoke check verified:

- Text PDF: ready, two ordered chunks and 1024-dimensional embeddings; no OCR.
- DOCX: ready, six chunks and 1024-dimensional embeddings; no OCR.
- Scanned PDF: ready after OCR, one chunk and a 1024-dimensional embedding.
- Downloaded object bytes equal uploaded source bytes.
- Upload response is 202 with pending metadata.
- Wrong-tenant get/retry return 404.
- Corrupt PDF exhausts three attempts, exposes a safe terminal reason, and can be manually retried.
- Synthetic test tenants, objects and rows are removed by the verification script.

Initial sandboxed HTTP tests could not bind test sockets, and the sandboxed Angular build
aborted without a diagnostic. Both passed after rerunning with the required permissions.
Initial Docker Hub/Quay MinIO image pulls failed with access-denied/401 responses. Compose
now builds pinned upstream sources, and the complete stack was subsequently verified.
There are no outstanding environment-blocked verification commands.

## Operational notes

The local stack is running at backend port 3001, PostgreSQL port 55432, and MinIO ports
59000/59001. The outreach service's port 3000 was not changed. Worker has no published port.
For production, configure a private S3-compatible bucket and deployment credentials/IAM;
retain an authenticated tenant authorization boundary around the existing tenant APIs.
Native development needs the example ingestion configuration and OCR dependencies if enabled.

OCR defaults to English and uses a deterministic text-density heuristic; unusually short or
mixed-layout PDFs can require tuning. Token counts remain null without a model tokenizer.
A crash between S3 upload and DB commit can leave an orphan object; cleanup is best-effort,
with reconciliation/lifecycle tooling needed for that crash window. Uploaded document content
is intentionally not available to chat until tenant-scoped PostgreSQL retrieval in Milestone 24.
