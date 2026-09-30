import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';

import {
  chunkDocuments,
} from './chunker.js';

import type {
  ExtractedDocument,
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

const extractedPath =
  path.join(
    generatedDirectory,
    'extracted-documents.json',
  );

const raw = JSON.parse(
  await readFile(
    extractedPath,
    'utf8',
  ),
) as {
  documents: ExtractedDocument[];
};

const chunks =
  chunkDocuments(
    raw.documents,
    {
      maxWords: 140,
      overlapWords: 30,
    },
  );

await mkdir(
  generatedDirectory,
  {
    recursive: true,
  },
);

const outputPath =
  path.join(
    generatedDirectory,
    'document-index.json',
  );

await writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt:
        new Date().toISOString(),
      chunks,
    },
    null,
    2,
  ) + '\n',
);

console.log(
  `Indexed ${chunks.length} chunks from ${raw.documents.length} documents.`,
);

console.log(
  `Output: ${outputPath}`,
);
