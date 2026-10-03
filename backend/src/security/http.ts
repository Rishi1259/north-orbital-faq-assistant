import { logger } from '../logging/logger.js';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { CreateOrganizationSchema } from '../organizations/organization-service.js';
import type { Metrics } from '../operations/metrics.js';
import { EmailSchema, type SecurityConfig } from './config.js';
import { hashToken, safeEqual } from './crypto.js';
import { HttpError, notFound } from './errors.js';
import type { SecurityStore, Session } from './repository.js';

export function sessionOf(response: Response): Session { return response.locals.session; }
export function cookieOptions(config: SecurityConfig) {
  return { httpOnly: true, secure: config.SESSION_COOKIE_SECURE, sameSite: 'lax' as const, path: '/api', maxAge: config.SESSION_TTL_SECONDS * 1000 };
}
export async function enforceLimit(store: SecurityStore, response: Response, metrics: Metrics,
  kind: string, parts: string[], limit: number, seconds: number) {
  const result = await store.consume(kind, parts, limit, seconds);
  if (!result.allowed) {
    metrics.event('rate_limit'); response.set('Retry-After', String(result.retryAfter));
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }
}
export function authentication(store: SecurityStore | undefined, config: SecurityConfig): RequestHandler {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const cookies = (req.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${config.SESSION_COOKIE_NAME}=`));
    const token = cookies.length === 1 ? cookies[0].slice(config.SESSION_COOKIE_NAME.length + 1) : '';
    const session = store && await store.authenticate(token);
    if (!session) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');
    res.locals.session = session;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const csrf = req.get('x-csrf-token') ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || !safeEqual(hashToken(csrf), session.csrfHash)) {
        throw new HttpError(403, 'INVALID_CSRF', 'Valid CSRF protection is required.');
      }
    }
    next();
  };
}
export function tenantAuthorization(store: SecurityStore | undefined, config: SecurityConfig, metrics: Metrics): RequestHandler {
  return async (req, res, next) => {
    const organizationId = String(req.params.organizationId);
    const role = store && await store.role(sessionOf(res).userId, organizationId);
    if (!role) throw notFound();
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const internalChat = req.method === 'POST' && /^\/chatbots\/[0-9a-f-]+\/chat$/i.test(req.path);
    if (role === 'member' && ((mutation && !internalChat) || req.path === '/audit-events')) {
      throw new HttpError(403, 'FORBIDDEN', 'This operation requires an administrator.');
    }
    res.locals.role = role;
    logger.info({ requestId: req.id, userId: sessionOf(res).userId, organizationId,
      action: 'organization.authorized', result: 'success' }, 'Organization access authorized.');
    if (mutation && /\/documents(?:\/[0-9a-f-]+\/retry)?\/?$/i.test(req.path)) {
      await enforceLimit(store!, res, metrics, 'upload', [sessionOf(res).userId, organizationId],
        config.UPLOAD_RATE_LIMIT, config.UPLOAD_RATE_WINDOW_SECONDS);
    }
    next();
  };
}
export function authRouter(store: SecurityStore | undefined, config: SecurityConfig, metrics: Metrics) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/login', async (req, res) => {
    if (!store) throw new HttpError(503, 'UNAVAILABLE', 'Authentication unavailable.');
    // Login CSRF protection: require the exact configured first-party Origin, including for CLI clients.
    if (req.get('origin') !== config.ADMIN_APP_ORIGIN) throw new HttpError(403, 'ORIGIN_REJECTED', 'Origin is not allowed.');
    const input = z.object({ email: EmailSchema, password: z.string().min(1).max(256) }).strict().parse(req.body);
    // Client-only and account-only windows also prevent distributing attempts across accounts/IPs.
    for (const [kind, parts] of [['login-client', [req.ip ?? 'unknown']], ['login-account', [input.email]]] as const) {
      await enforceLimit(store, res, metrics, kind, [...parts], config.LOGIN_RATE_LIMIT, config.LOGIN_RATE_WINDOW_SECONDS);
    }
    try {
      const result = await store.login(input.email, input.password, String(req.id));
      res.cookie(config.SESSION_COOKIE_NAME, result.token, cookieOptions(config));
      res.json({ user: result.user, csrfToken: result.csrfToken });
    } catch (error) { if (error instanceof HttpError && error.status === 401) metrics.event('login_failure'); throw error; }
  });
  router.use(authentication(store, config));
  router.get('/me', (_req, res) => {
    const s = sessionOf(res);
    res.json({ user: { id: s.userId, email: s.email } });
  });
  router.post('/logout', async (req, res) => {
    await store!.logout(sessionOf(res), String(req.id));
    const { maxAge: _, ...options } = cookieOptions(config);
    res.clearCookie(config.SESSION_COOKIE_NAME, options); res.status(204).end();
  });
  return router;
}
export function organizationCreation(store: SecurityStore | undefined): RequestHandler {
  return async (req, res, next) => {
    if (!store) return next(new HttpError(503, 'UNAVAILABLE', 'Service unavailable.'));
    const organization = await store.createOrganization(CreateOrganizationSchema.parse(req.body), sessionOf(res).userId, String(req.id));
    res.status(201).json({ organization });
  };
}
export function auditContext(req: Request, res: Response, action: string, targetType: string) {
  return { action, targetType, actorUserId: sessionOf(res).userId, requestId: String(req.id) };
}
