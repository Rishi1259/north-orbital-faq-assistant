import {
  mkdir,
  readdir,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';

import { extractDocument } from './extract-document.js';

const repositoryRoot =
  path.resolve(process.cwd(), '..');

const inputDirectories = [
  path.join(
    repositoryRoot,
    'documents',
    'samples',
  ),
  path.join(
    repositoryRoot,
    'documents',
    'private',
  ),
];

const outputDirectory = path.join(
  repositoryRoot,
  'documents',
  'generated',
);

async function findDocuments(
  directory: string,
): Promise<string[]> {
  try {
    const entries = await readdir(
      directory,
      {
        withFileTypes: true,
      },
    );

    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          ['.pdf', '.docx'].includes(
            path.extname(
              entry.name,
            ).toLowerCase(),
          ),
      )
      .map((entry) =>
        path.join(
          directory,
          entry.name,
        ),
      );
  } catch {
    return [];
  }
}

const files = (
  await Promise.all(
    inputDirectories.map(
      findDocuments,
    ),
  )
)
  .flat()
  .sort();

if (files.length === 0) {
  throw new Error(
    'No PDF or DOCX documents were found.',
  );
}

const documents = [];

for (const filePath of files) {
  const sourcePath = path.relative(
    repositoryRoot,
    filePath,
  );

  console.log(
    `Extracting ${sourcePath}`,
  );

  documents.push(
    await extractDocument(
      filePath,
      sourcePath,
    ),
  );
}

await mkdir(outputDirectory, {
  recursive: true,
});

const outputPath = path.join(
  outputDirectory,
  'extracted-documents.json',
);

await writeFile(
  outputPath,
  JSON.stringify(
    {
      generatedAt:
        new Date().toISOString(),
      documents,
    },
    null,
    2,
  ) + '\n',
);

console.log('');
console.log(
  `Extracted ${documents.length} documents.`,
);

console.log(
  `Output: ${outputPath}`,
);
