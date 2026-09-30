# Changelog

## v0.3.0

### Added

- local semantic embeddings with `qwen3-embedding:0.6b`
- persistent semantic document index
- cosine-similarity document search
- hybrid lexical + semantic retrieval
- deterministic hybrid reranking
- query-side retrieval instructions for semantic search
- lexical fallback when semantic embeddings are unavailable
- dedicated 14-case hybrid RAG evaluation

### Improved

- paraphrased document questions can retrieve relevant chunks even without exact wording
- semantic relevance is prioritized while lexical matches remain useful for exact terminology
- explicit negative statements and prohibitions are treated as valid grounding evidence
- unrelated document questions continue to use deterministic fallback
- document citations remain validated server-side

### Verification

- backend automated tests: 61/61 passing
- hybrid RAG structural evaluation: 14/14 passing

## v0.2.0

### Added

- PDF text extraction with page metadata
- DOCX text extraction with section metadata
- stable document and chunk IDs
- deterministic document chunking and lexical search
- combined FAQ and document retrieval
- PDF page citations
- DOCX section citations
- document citation API
- mixed FAQ/document grounding
- dedicated 21-case document evaluation
- fictional PDF and DOCX sample documents

### Security and reliability

- model-generated document citations are validated server-side
- unsupported questions fall back instead of inventing answers
- private and generated document directories are Git-ignored
- local filesystem paths are not exposed through citation responses

## v0.1.0

Initial FAQ assistant release with Angular, Node.js/TypeScript, Ollama, grounded FAQ retrieval, citations, conversation history, validation, rate limiting, tests, and a 30-case evaluation.
