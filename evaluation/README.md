## Production RAG evaluation (Milestone 24)

Run `cd backend && npm run evaluate:rag` from the repository root. This focused suite combines
`tests/production-rag.test.ts` with `tests/integration/production-rag.test.ts`. It requires migrated
PostgreSQL via `DATABASE_URL`, uses isolated synthetic data and deterministic 1024-dimensional
vectors, and does not require Ollama. It evaluates retrieval membership, tenant exclusion,
source integrity, pass limits and fallbacks rather than exact generated prose.

| Case | Deterministic coverage |
| --- | --- |
| Direct lexical fact / exact term | Real FTS query and rank tests |
| Semantic paraphrase / semantic-only evidence | Real cosine SQL with orthogonal fake vectors |
| Pronoun follow-up | Literal miss then successful scoped rewrite |
| Ambiguous follow-up | Previous user turn passed to rewriter |
| Unrelated question / absent answer | Empty-evidence and unsupported-answer fallbacks |
| Negative fact | HTTP fixture supports a cited negative answer |
| Competing chunks | RRF semantic bias and stable tie-breaks |
| Repeated / overlapping chunks | ID merge, fingerprints, asymmetric overlap selection |
| Tenant isolation / wrong chatbot | SQL, retriever, HTTP and source-link exclusion |
| Non-ready / deleted data | All lifecycle states, FK cascades, post-generation recheck |
| Citation correctness | Metadata from selected rows, deterministic deduplication |
| Hallucinated citations | Unknown IDs rejected; omitted evidence cannot be cited |
| Semantic outage | Lexical fallback, wrong dimensions and vector SQL errors |
| Rewrite outage | Exception, malformed output and eight-second timeout fallback |

Model-dependent acceptance is separate: `backend/scripts/verify-rag.mjs` uses the real tenant
chat API, existing accepted ready documents and Ollama. It checks useful facts, source ownership,
PDF/DOCX citations, paraphrases, follow-ups and safe fallbacks. It prints only metadata. See
[verification commands and results](../docs/milestone-24-verification.md).

## Historical evaluation tools

The older scripts below target the pre-production/local-index contracts and are retained as
historical artifacts. They are not acceptance tests for the current tenant chat endpoint.

# Evaluation

This directory contains a reproducible evaluation for the North Orbital FAQ Assistant.

## Coverage

The 30 cases cover:

- supported FAQ questions
- conversational follow-ups
- unsupported questions
- misleading assumptions
- instruction-override / prompt-injection attempts

## Running the evaluation

Start Ollama and the backend first.

From the repository root:

```bash
node evaluation/run-evaluation.mjs
