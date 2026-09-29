import type { Faq } from './schema.js';

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
  'where',
  'you',
  'your',
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOKEN_ALIASES: Record<string, string> = {
  charge: 'cost',
  charged: 'cost',
  charging: 'cost',
  fee: 'cost',
  fees: 'cost',
  price: 'cost',
  prices: 'cost',
};

function tokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);

  if (
    token.length > 4 &&
    token.endsWith('s') &&
    !token.endsWith('ss')
  ) {
    variants.add(token.slice(0, -1));
  }

  for (const variant of [...variants]) {
    const alias = TOKEN_ALIASES[variant];

    if (alias) {
      variants.add(alias);
    }
  }

  return [...variants];
}

function tokens(value: string): Set<string> {
  const rawTokens = normalize(value).split(' ');

  return new Set(
    rawTokens
      .flatMap(tokenVariants)
      .filter(
        (token) =>
          token.length > 1 &&
          !STOP_WORDS.has(token),
      ),
  );
}

function countOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;

  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }

  return count;
}

export interface FaqMatch {
  faq: Faq;
  score: number;
}

export function retrieveFaqs(
  query: string,
  faqs: Faq[],
  limit = 3,
): FaqMatch[] {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(query);

  if (!normalizedQuery || queryTokens.size === 0) {
    return [];
  }

  const matches = faqs
    .map((faq): FaqMatch => {
      const questionTokens = tokens(faq.question);
      const answerTokens = tokens(faq.answer);
      const keywordTokens = tokens(faq.keywords.join(' '));

      let score = 0;

      score += countOverlap(queryTokens, questionTokens) * 4;
      score += countOverlap(queryTokens, keywordTokens) * 3;
      score += countOverlap(queryTokens, answerTokens);

      for (const keyword of faq.keywords) {
        const normalizedKeyword = normalize(keyword);

        if (
          normalizedKeyword.length >= 3 &&
          normalizedQuery.includes(normalizedKeyword)
        ) {
          score += 5;
        }
      }

      return {
        faq,
        score,
      };
    })
    .filter((match) => match.score >= 4)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.faq.id.localeCompare(right.faq.id);
    });

  return matches.slice(0, limit);
}
