import {
  readFile,
} from 'node:fs/promises';

import path from 'node:path';

import {
  searchDocuments,
} from './searcher.js';

import type {
  DocumentIndex,
} from './types.js';

const query =
  process.argv
    .slice(2)
    .join(' ')
    .trim();

if (!query) {
  console.error(
    'Usage: npm run documents:search -- "your question"',
  );

  process.exit(1);
}

const repositoryRoot =
  path.resolve(
    process.cwd(),
    '..',
  );

const indexPath =
  path.join(
    repositoryRoot,
    'documents',
    'generated',
    'document-index.json',
  );

const index =
  JSON.parse(
    await readFile(
      indexPath,
      'utf8',
    ),
  ) as DocumentIndex;

const results =
  searchDocuments(
    query,
    index.chunks,
    5,
  );

if (results.length === 0) {
  console.log(
    'No relevant document chunks found.',
  );

  process.exit(0);
}

for (
  const [
    indexNumber,
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
    `${indexNumber + 1}. ${result.chunk.documentTitle}`,
  );

  console.log(
    `   Score: ${result.score}`,
  );

  console.log(
    `   Location: ${location}`,
  );

  console.log(
    `   Source: ${result.chunk.sourcePath}`,
  );

  console.log(
    `   Chunk: ${result.chunk.id}`,
  );

  console.log(
    `   ${result.chunk.text}`,
  );
}
