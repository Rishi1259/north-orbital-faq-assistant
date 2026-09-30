import {
  OllamaEmbeddingProvider,
} from '../embeddings/ollama-embedding-provider.js';

import {
  searchDocumentsHybrid,
} from './hybrid-searcher.js';

import {
  loadDocumentIndex,
} from './index-loader.js';

import {
  loadSemanticDocumentIndex,
} from './semantic-index-loader.js';

const query =
  process.argv
    .slice(2)
    .join(' ')
    .trim();

if (!query) {
  console.error(
    'Usage: npm run documents:hybrid-search -- "your question"',
  );

  process.exit(1);
}

const documentIndex =
  loadDocumentIndex();

const semanticIndex =
  loadSemanticDocumentIndex();

const embeddingProvider =
  new OllamaEmbeddingProvider();

const semanticMinimumScore =
  Number(
    process.env.SEMANTIC_MIN_SCORE ??
    0.20,
  );

const results =
  await searchDocumentsHybrid(
    query,
    documentIndex.chunks,
    semanticIndex,
    embeddingProvider,
    {
      semanticMinimumScore,
    },
  );

if (
  results.length === 0
) {
  console.log(
    'No relevant document chunks found.',
  );

  process.exit(0);
}

for (
  const [
    index,
    result,
  ] of results.entries()
) {
  const location =
    result.chunk.page
      ? `page ${result.chunk.page}`
      : result.chunk.section
        ? `section "${result.chunk.section}"`
        : 'document';

  console.log('');
  console.log(
    `${index + 1}. ${result.chunk.documentTitle}`,
  );

  console.log(
    `   Hybrid: ${result.hybridScore.toFixed(4)}`,
  );

  console.log(
    `   Lexical: ${result.lexicalScore.toFixed(4)}`,
  );

  console.log(
    `   Semantic: ${result.semanticScore.toFixed(4)}`,
  );

  console.log(
    `   Location: ${location}`,
  );

  console.log(
    `   Chunk: ${result.chunk.id}`,
  );

  console.log(
    `   ${result.chunk.text}`,
  );
}
