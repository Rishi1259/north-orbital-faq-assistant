# Changelog

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
