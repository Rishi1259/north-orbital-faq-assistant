import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FaqsSchema,
  SourcesSchema,
  type KnowledgeBase,
} from './schema.js';

const repositoryRoot = fileURLToPath(
  new URL('../../../', import.meta.url),
);

function readJsonFile(fileName: string): unknown {
  const filePath = path.join(repositoryRoot, 'knowledge', fileName);
  const contents = readFileSync(filePath, 'utf8');

  return JSON.parse(contents);
}

export function loadKnowledge(): KnowledgeBase {
  const sources = SourcesSchema.parse(readJsonFile('sources.json'));
  const faqs = FaqsSchema.parse(readJsonFile('faqs.json'));

  const sourceIds = new Set(sources.map((source) => source.id));
  const faqIds = new Set<string>();

  for (const faq of faqs) {
    if (faqIds.has(faq.id)) {
      throw new Error(`Duplicate FAQ ID: ${faq.id}`);
    }

    faqIds.add(faq.id);

    for (const sourceId of faq.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(
          `FAQ ${faq.id} references unknown source ${sourceId}`,
        );
      }
    }
  }

  return {
    faqs,
    sources,
  };
}
