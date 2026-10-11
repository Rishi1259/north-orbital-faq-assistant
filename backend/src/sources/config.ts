import { z } from 'zod';
const int = (value: number, max: number, min = 1) => z.coerce.number().int().min(min).max(max).default(value);
export const CrawlerEnvironmentSchema = z.object({
  CRAWLER_MAX_PAGES_PER_SOURCE: int(50, 1000), CRAWLER_MAX_DEPTH: int(3, 10, 0),
  CRAWLER_MAX_LINKS_PER_PAGE: int(100, 1000), CRAWLER_MAX_RESPONSE_BYTES: int(1048576, 5242880),
  CRAWLER_MAX_TOTAL_BYTES: int(20971520, 104857600), CRAWLER_MAX_SITEMAP_BYTES: int(1048576, 5242880),
  CRAWLER_MAX_SITEMAP_URLS: int(500, 10000), CRAWLER_MAX_SITEMAP_DOCUMENTS: int(10, 100),
  CRAWLER_MAX_SITEMAP_DEPTH: int(2, 5, 0), CRAWLER_REQUEST_TIMEOUT_MS: int(10000, 30000, 100),
  CRAWLER_TOTAL_TIMEOUT_MS: int(120000, 600000, 1000), CRAWLER_MAX_REDIRECTS: int(5, 10, 0),
  CRAWLER_MAX_ATTEMPTS: int(3, 10), CRAWLER_REQUEST_DELAY_MS: int(100, 5000, 0),
  CRAWLER_MAX_CHUNKS_PER_SOURCE: int(1500, 30000), CRAWLER_MAX_CHUNKS_PER_PAGE: int(30, 100), CRAWLER_MAX_CHUNKS_PER_RUN: int(500, 5000),
  CRAWLER_USER_AGENT: z.string().regex(/^[A-Za-z][A-Za-z0-9._/-]{5,100}$/).default('NorthOrbitalKnowledgeCrawler/1.0'),
});
export type CrawlerConfig = z.infer<typeof CrawlerEnvironmentSchema>;
export class CrawlError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfter = 0) { super(code); }
}
