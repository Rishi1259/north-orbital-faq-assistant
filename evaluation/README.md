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
