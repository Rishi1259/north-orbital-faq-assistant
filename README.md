# North Orbital FAQ Assistant

A portfolio-ready website FAQ chatbot built with Angular, Node.js, TypeScript, and a local Ollama model.

> **Important:** North Orbital Community Initiative is a fictional nonprofit created only for this demonstration project. No claims are made about real organizations.

## What this project demonstrates

- responsive Angular chat interface
- Node.js/TypeScript API
- server-side validation
- request rate limiting
- local Ollama integration
- provider abstraction for future hosted models
- grounded answers from a controlled FAQ knowledge base
- clickable source references
- short conversation history for follow-up questions
- deterministic fallback for unsupported questions
- timeout and model-unavailable handling
- automated frontend and backend tests
- reproducible 30-question evaluation suite

## Architecture

```mermaid
flowchart TD
    A[Angular frontend] -->|POST /api/chat| B[Node.js / Express API]
    B --> C[Input validation]
    C --> D[FAQ retrieval]
    D --> E{Relevant knowledge found?}
    E -->|No| F[Deterministic fallback]
    E -->|Yes| G[Grounded prompt]
    G --> H[ModelProvider]
    H --> I[Ollama qwen3.5:9b]
    I --> J[Structured answer validation]
    J --> K[Source ID validation]
    K --> A

## PDF and Word document search

Version 0.2.0 adds local document-grounded Q&A for PDF and DOCX files.

The ingestion pipeline:

1. extracts text from trusted local documents
2. preserves PDF page numbers and DOCX section headings
3. creates stable document and chunk IDs
4. splits content into searchable chunks
5. retrieves relevant chunks using deterministic lexical search
6. sends only retrieved context to the configured model
7. validates returned citation IDs before exposing them to the user

Citation behavior:

- PDF sources cite the page number
- DOCX sources cite the section heading

Example citations:

```text
North Orbital Digital Access Program Guide · Page 1
North Orbital Volunteer Handbook · Orientation
