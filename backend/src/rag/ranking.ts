import { createHash } from 'node:crypto';
import type { RagConfig } from './config.js';
import type { Candidate, RankedCandidate } from './types.js';

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function fuse(candidates: Candidate[], config: RagConfig): RankedCandidate[] {
  const merged = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = merged.get(candidate.id);
    if (!previous) { merged.set(candidate.id, { ...candidate }); continue; }
    if (candidate.lexicalRank !== undefined && candidate.lexicalRank < (previous.lexicalRank ?? Infinity)) {
      previous.lexicalRank = candidate.lexicalRank; previous.lexicalScore = candidate.lexicalScore;
    }
    if (candidate.semanticRank !== undefined && candidate.semanticRank < (previous.semanticRank ?? Infinity)) {
      previous.semanticRank = candidate.semanticRank; previous.semanticDistance = candidate.semanticDistance;
    }
  }
  // Best rank per branch across passes avoids rewarding a duplicate just for being retrieved twice.
  return [...merged.values()].map(c => ({ ...c, hybridScore:
    (c.semanticRank ? config.RAG_VECTOR_WEIGHT / (config.RAG_RRF_K + c.semanticRank) : 0) +
    (c.lexicalRank ? config.RAG_LEXICAL_WEIGHT / (config.RAG_RRF_K + c.lexicalRank) : 0),
  })).sort((a, b) => b.hybridScore - a.hybridScore ||
    (a.semanticRank ?? Infinity) - (b.semanticRank ?? Infinity) ||
    (a.lexicalRank ?? Infinity) - (b.lexicalRank ?? Infinity) ||
    compareId(a.documentId, b.documentId) || a.chunkIndex - b.chunkIndex || compareId(a.id, b.id));
}
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
function shingles(text: string): Set<string> {
  const words = text.split(' ');
  return new Set(words.slice(0, -4).map((_, i) => words.slice(i, i + 5).join(' ')));
}
export interface SelectedEvidence { sourceId: string; chunk: RankedCandidate; block: string }
export function selectEvidence(ranked: RankedCandidate[], config: RagConfig): SelectedEvidence[] {
  const selected: SelectedEvidence[] = [];
  const fingerprints = new Set<string>();
  const accepted: { text: string; shingles: Set<string> }[] = [];
  let used = 0;
  for (const chunk of ranked) {
    if (selected.length >= config.RAG_TOP_K) break;
    const text = normalize(chunk.text);
    if (!text) continue;
    const fingerprint = createHash('sha256').update(text).digest('hex');
    if (fingerprints.has(fingerprint)) continue;
    const grams = shingles(text);
    // Compare only to the <=8 selected chunks, never all candidate pairs.
    if (accepted.some(old => old.text.includes(text) || (grams.size >= 20 && old.shingles.size >= 20 &&
      [...grams].filter(g => old.shingles.has(g)).length / grams.size >= 0.85))) continue;
    const sourceId = `S${selected.length + 1}`;
    // JSON encoding makes document-supplied delimiters unambiguous. Entire block counts toward budget.
    const encode = (content: string) => JSON.stringify({ sourceId, title: chunk.title.slice(0, 300),
      page: chunk.page, section: chunk.section?.slice(0, 200) ?? null, content });
    const remaining = config.RAG_MAX_CONTEXT_CHARS - used - (selected.length ? 1 : 0);
    let content = chunk.text;
    let block = encode(content);
    if (block.length > remaining) {
      let low = 0; let high = content.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (encode(content.slice(0, mid)).length <= remaining) low = mid; else high = mid - 1;
      }
      if (low < 100) continue;
      content = content.slice(0, low); block = encode(content);
    }
    selected.push({ sourceId, chunk: { ...chunk, text: content }, block });
    used += block.length + (selected.length > 1 ? 1 : 0);
    fingerprints.add(fingerprint); accepted.push({ text, shingles: grams });
  }
  return selected;
}
