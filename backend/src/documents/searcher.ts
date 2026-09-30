import type {
  DocumentChunk,
  DocumentSearchResult,
} from './types.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'the',
  'to',
  'what',
  'when',
  'where',
  'you',
  'your',
]);

const ALIASES: Record<string, string> = {
  volunteers: 'volunteer',
  reservations: 'reservation',
  reserved: 'reserve',
  reserving: 'reserve',
  workstations: 'workstation',
  computers: 'computer',
  minutes: 'minute',
};

function normalize(
  value: string,
): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenVariants(
  token: string,
): string[] {
  const variants = new Set<string>([
    token,
  ]);

  const alias = ALIASES[token];

  if (alias) {
    variants.add(alias);
  }

  if (
    token.length > 4 &&
    token.endsWith('s') &&
    !token.endsWith('ss')
  ) {
    variants.add(
      token.slice(0, -1),
    );
  }

  return [...variants];
}

function tokens(
  value: string,
): Set<string> {
  return new Set(
    normalize(value)
      .split(' ')
      .flatMap(tokenVariants)
      .filter(
        (token) =>
          token.length > 1 &&
          !STOP_WORDS.has(token),
      ),
  );
}

function overlap(
  left: Set<string>,
  right: Set<string>,
): number {
  let result = 0;

  for (const token of left) {
    if (right.has(token)) {
      result += 1;
    }
  }

  return result;
}

export function searchDocuments(
  query: string,
  chunks: DocumentChunk[],
  limit = 5,
): DocumentSearchResult[] {
  const queryTokens = tokens(query);

  if (queryTokens.size === 0) {
    return [];
  }

  const normalizedQuery =
    normalize(query);

  return chunks
    .map(
      (
        chunk,
      ): DocumentSearchResult => {
        const textTokens =
          tokens(chunk.text);

        const titleTokens =
          tokens(
            chunk.documentTitle,
          );

        const sectionTokens =
          tokens(
            chunk.section ?? '',
          );

        let score = 0;

        score +=
          overlap(
            queryTokens,
            textTokens,
          ) * 4;

        score +=
          overlap(
            queryTokens,
            sectionTokens,
          ) * 3;

        score +=
          overlap(
            queryTokens,
            titleTokens,
          ) * 2;

        const normalizedText =
          normalize(chunk.text);

        if (
          normalizedText.includes(
            normalizedQuery,
          )
        ) {
          score += 8;
        }

        return {
          chunk,
          score,
        };
      },
    )
    .filter(
      (result) =>
        result.score >= 6,
    )
    .sort(
      (left, right) => {
        if (
          right.score !==
          left.score
        ) {
          return (
            right.score -
            left.score
          );
        }

        return left.chunk.id.localeCompare(
          right.chunk.id,
        );
      },
    )
    .slice(0, limit);
}
