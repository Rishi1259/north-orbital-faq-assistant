import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { BrandingSchema, loadSecurityConfig, normalizeOrigin, OriginsSchema } from '../src/security/config.js';
import { hashPassword, hashToken, randomPublicId, randomToken, verifyPassword } from '../src/security/crypto.js';
import { cookieOptions } from '../src/security/http.js';
const config = loadSecurityConfig({ NODE_ENV: 'test' });
const org = randomUUID(), bot = randomUUID(), doc = randomUUID();
const base = `/api/organizations/${org}/chatbots/${bot}`;
describe('fail-closed route boundary', () => {
  it.each([
    ['post', '/api/organizations'], ['get', `/api/organizations/${org}`], ['get', base],
    ['post', `${base}/chat`], ['get', `${base}/documents`], ['post', `${base}/documents`],
    ['post', `${base}/documents/${doc}/retry`], ['get', `${base}/document-sources/${doc}`],
    ['post', `${base}/public-id/rotate`], ['put', `${base}/public-access`],
    ['put', `${base}/allowed-origins`], ['get', `/api/organizations/${org}/audit-events`],
    ['get', '/api/document-sources/anything'], ['get', '/api/sources/SRC-001'], ['post','/api/chat'],
  ])('requires auth: %s %s', async (method, url) => {
    const app = createApp({ securityConfig: config, provider: {} as never });
    await (request(app) as any)[method](url).expect(401);
  });
  it('keeps operational endpoints available and metrics private', async () => {
    const app = createApp({ securityConfig: config, provider: {} as never });
    await request(app).get('/api/health').expect(200); await request(app).get('/api/ready').expect(200);
    await request(app).get('/internal/metrics').expect(404);
  });
  it('protects metrics with separate bearer credentials and fixed labels', async () => {
    const token = randomToken();
    const app = createApp({ securityConfig: { ...config, METRICS_ENABLED: true, METRICS_TOKEN: token }, provider: {} as never });
    await request(app).get(base).expect(401);
    await request(app).get('/internal/metrics').set('Cookie', `north_orbital_session=${randomToken()}`).expect(404);
    const result = await request(app).get('/internal/metrics').set('Authorization', `Bearer ${token}`).expect(200);
    expect(result.text).toContain('north_orbital_http_requests_total');
    expect(result.text).not.toContain(org); expect(result.text).not.toContain(bot); expect(result.text).not.toContain(token);
  });
});
it('hashes passwords with salted Argon2id and uses random independent public/session IDs', async () => {
  const password = 'a long fixture passphrase';
  const hash = await hashPassword(password), other = await hashPassword(password);
  expect(hash).toMatch(/^\$argon2id\$/); expect(hash).not.toBe(other); expect(hash).not.toContain(password);
  expect(await verifyPassword(hash, password)).toBe(true); expect(await verifyPassword(hash, 'wrong')).toBe(false);
  expect(new Set(Array.from({ length: 100 }, randomPublicId)).size).toBe(100);
  const token = randomToken(); expect(token).toHaveLength(43); expect(hashToken(token)).toHaveLength(64); expect(hashToken(token)).not.toBe(token);
});
it.each(['https://example.com/path','https://example.com?x=1','https://example.com/#x','null','file:///test','https://*.example.com','https://user:pass@example.com','https://example.com\\evil',' https://example.com'])('rejects invalid origin %s', value => expect(() => normalizeOrigin(value)).toThrow());
it('normalizes exact origins and deduplicates without wildcard matching', () => {
  expect(OriginsSchema.parse({ origins: ['https://EXAMPLE.com:443', 'https://example.com/'] }).origins).toEqual(['https://example.com']);
});
it('rejects unsafe branding and insecure production config', () => {
  expect(() => BrandingSchema.parse({ accentColor: 'url(javascript:bad)' })).toThrow();
  expect(() => loadSecurityConfig({ NODE_ENV: 'production' })).toThrow();
  expect(() => loadSecurityConfig({ SESSION_COOKIE_SECURE: 'false' })).toThrow();
  expect(() => loadSecurityConfig({ NODE_ENV: 'production', RATE_LIMIT_HASH_SECRET: randomToken(), PUBLIC_CHAT_ALLOW_MISSING_ORIGIN: 'true' })).toThrow();
  expect(cookieOptions(config)).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/api' });
});

it('rejects copy-pasted example secrets in production', () => {
  expect(() => loadSecurityConfig({ NODE_ENV: 'production', RATE_LIMIT_HASH_SECRET: 'REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS' })).toThrow();
});
