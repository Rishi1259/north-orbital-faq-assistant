import { z } from 'zod';

export function normalizeOrigin(input: string): string {
  if (input.length > 300 || input !== input.trim() || /[\\\s]/.test(input)) throw new Error('Invalid origin.');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*') ||
      !/^https?:\/\/[^/?#]+\/?$/i.test(input)) throw new Error('Invalid origin.');
  return url.origin;
}
const origin = z.string().transform((value, ctx) => {
  try { return normalizeOrigin(value); } catch { ctx.addIssue({ code: 'custom', message: 'An exact HTTP(S) origin is required.' }); return z.NEVER; }
});
const bool = (value: 'true' | 'false') => z.enum(['true', 'false']).default(value).transform(v => v === 'true');
const positive = (value: number, max = 86400) => z.coerce.number().int().min(1).max(max).default(value);
export const SecurityEnvironmentSchema = z.object({
  ADMIN_APP_ORIGIN: origin.default('http://localhost:4200'),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,60}$/).default('north_orbital_session'),
  SESSION_TTL_SECONDS: positive(604800, 604800),
  SESSION_COOKIE_SECURE: bool('true'),
  LOCAL_HTTP_DEVELOPMENT: bool('false'),
  PUBLIC_CHAT_ALLOW_MISSING_ORIGIN: bool('false'),
  PUBLIC_CHAT_RATE_LIMIT: positive(30),
  PUBLIC_CHAT_RATE_WINDOW_SECONDS: positive(60),
  LOGIN_RATE_LIMIT: positive(5),
  LOGIN_RATE_WINDOW_SECONDS: positive(900),
  UPLOAD_RATE_LIMIT: positive(20),
  UPLOAD_RATE_WINDOW_SECONDS: positive(3600),
  RATE_LIMIT_HASH_SECRET: z.string().min(32).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  METRICS_ENABLED: bool('false'),
  METRICS_TOKEN: z.string().min(32).optional(),
});
export type SecurityConfig = z.infer<typeof SecurityEnvironmentSchema>;
export function validateSecurity(config: SecurityConfig, production: boolean): boolean {
  return (!production || Boolean(config.RATE_LIMIT_HASH_SECRET &&
    new Set(config.RATE_LIMIT_HASH_SECRET).size >= 12 && !/placeholder|change.?me|example|replace|generate/i.test(config.RATE_LIMIT_HASH_SECRET))) &&
    (!config.METRICS_ENABLED || Boolean(config.METRICS_TOKEN && new Set(config.METRICS_TOKEN).size >= 12 && !/placeholder|change.?me|example|replace|generate/i.test(config.METRICS_TOKEN))) &&
    (config.SESSION_COOKIE_SECURE || (config.LOCAL_HTTP_DEVELOPMENT && new URL(config.ADMIN_APP_ORIGIN).protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.ADMIN_APP_ORIGIN).hostname))) &&
    (!config.PUBLIC_CHAT_ALLOW_MISSING_ORIGIN || (!production && config.LOCAL_HTTP_DEVELOPMENT));
}
export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  return SecurityEnvironmentSchema.refine(c => validateSecurity(c, env.NODE_ENV === 'production'),
    'Invalid security configuration: check secrets, metrics and explicit local HTTP settings.').parse(env);
}
export const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const PasswordSchema = z.string().min(12).max(256);
export const BrandingSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  welcomeMessage: z.string().trim().min(1).max(500),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  launcherLabel: z.string().trim().min(1).max(40),
  launcherPosition: z.enum(['bottom-right', 'bottom-left']),
}).strict();
export const OriginsSchema = z.object({ origins: z.array(origin).max(50).transform(v => [...new Set(v)]) }).strict();
