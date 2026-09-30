import {
  readFile,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';

import {
  OllamaEmbeddingProvider,
} from '../embeddings/ollama-embedding-provider.js';

import {
  buildSemanticIndex,
} from './semantic-indexer.js';

import type {
  DocumentIndex,
} from './types.js';

const repositoryRoot =
  path.resolve(
    process.cwd(),
    '..',
  );

const generatedDirectory =
  path.join(
    repositoryRoot,
    'documents',
    'generated',
  );

const documentIndexPath =
  path.join(
    generatedDirectory,
    'document-index.json',
  );

const semanticIndexPath =
  path.join(
    generatedDirectory,
    'semantic-index.json',
  );

const documentIndex =
  JSON.parse(
    await readFile(
      documentIndexPath,
      'utf8',
    ),
  ) as DocumentIndex;

const model =
  process.env
    .OLLAMA_EMBEDDING_MODEL ??
  'qwen3-embedding:0.6b';

const batchSize =
  Number(
    process.env
      .SEMANTIC_INDEX_BATCH_SIZE ??
      8,
  );

const provider =
  new OllamaEmbeddingProvider({
    model,
  });

console.log(
  `Embedding ${documentIndex.chunks.length} chunks with ${model}...`,
);

const semanticIndex =
  await buildSemanticIndex(
    documentIndex.chunks,
    provider,
    {
      model,
      batchSize,
    },
  );

await writeFile(
  semanticIndexPath,
  JSON.stringify(
    semanticIndex,
    null,
    2,
  ) + '\n',
);

console.log(
  `Indexed ${semanticIndex.entries.length} semantic vectors.`,
);

console.log(
  `Dimensions: ${semanticIndex.dimensions}`,
);

console.log(
  `Output: ${semanticIndexPath}`,
);
