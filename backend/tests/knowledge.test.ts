import { describe, expect, it } from 'vitest';

import { loadKnowledge } from '../src/knowledge/loader.js';
import { retrieveFaqs } from '../src/knowledge/retriever.js';

describe('knowledge base', () => {
  it('loads 25 FAQs and their sources', () => {
    const knowledge = loadKnowledge();

    expect(knowledge.faqs).toHaveLength(25);
    expect(knowledge.sources).toHaveLength(7);
  });

  it('uses unique FAQ IDs', () => {
    const { faqs } = loadKnowledge();

    const ids = faqs.map((faq) => faq.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references sources that exist', () => {
    const { faqs, sources } = loadKnowledge();

    const sourceIds = new Set(
      sources.map((source) => source.id),
    );

    for (const faq of faqs) {
      for (const sourceId of faq.sourceIds) {
        expect(sourceIds.has(sourceId)).toBe(true);
      }
    }
  });
});

describe('FAQ retrieval', () => {
  const knowledge = loadKnowledge();

  it('retrieves the workshop-cost FAQ', () => {
    const results = retrieveFaqs(
      'How much do the workshops cost?',
      knowledge.faqs,
    );

    expect(results[0]?.faq.id).toBe('FAQ-006');
  });

  it('retrieves the youth-age FAQ', () => {
    const results = retrieveFaqs(
      'What ages can join youth coding?',
      knowledge.faqs,
    );

    expect(results[0]?.faq.id).toBe('FAQ-009');
  });

  it('retrieves the laptop-loan FAQ', () => {
    const results = retrieveFaqs(
      'Can I borrow a laptop to take home?',
      knowledge.faqs,
    );

    expect(results[0]?.faq.id).toBe('FAQ-013');
  });

  it('returns no result for an unrelated question', () => {
    const results = retrieveFaqs(
      'Do you repair bicycles?',
      knowledge.faqs,
    );

    expect(results).toEqual([]);
  });
});

describe('FAQ retrieval with natural or misleading phrasing', () => {
  const knowledge = loadKnowledge();

  it('understands charge as workshop cost', () => {
    const results = retrieveFaqs(
      'You charge $50 for every workshop, right?',
      knowledge.faqs,
    );

    expect(
      results.map((result) => result.faq.id),
    ).toContain('FAQ-006');
  });

  it('finds opening hours for a Monday assumption', () => {
    const results = retrieveFaqs(
      "You're open on Mondays, correct?",
      knowledge.faqs,
    );

    expect(
      results.map((result) => result.faq.id),
    ).toContain('FAQ-004');
  });

  it('finds tax deductibility information', () => {
    const results = retrieveFaqs(
      'Donations are definitely tax deductible, correct?',
      knowledge.faqs,
    );

    expect(
      results.map((result) => result.faq.id),
    ).toContain('FAQ-021');
  });
});
