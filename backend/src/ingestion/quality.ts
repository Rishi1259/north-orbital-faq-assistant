import type { ExtractedDocument } from '../documents/types.js';

export function pdfTextQuality(document: ExtractedDocument) {
  const pages = document.pageCount ?? Math.max(1, ...document.blocks.map(b => b.page ?? 1));
  const charactersByPage = new Map<number, number>();
  for (const block of document.blocks) {
    // Letters and numbers exclude parser page separators, punctuation and replacement glyphs.
    const useful = (block.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const page = block.page ?? 1;
    charactersByPage.set(page, (charactersByPage.get(page) ?? 0) + useful);
  }
  const usefulCharacters = [...charactersByPage.values()].reduce((a, b) => a + b, 0);
  const meaningfulPages = [...charactersByPage.values()].filter(count => count >= 40).length;
  return { usefulCharacters, meaningfulPages, pages,
    usable: usefulCharacters >= 80 && meaningfulPages / pages >= 0.5 };
}
