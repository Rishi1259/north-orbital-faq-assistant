import { Router } from 'express';
import { z } from 'zod';
import { ChatRequestSchema } from '../ai/types.js';
import type { ProductionChatService } from '../rag/chat-service.js';
import type { RetrievalRepository } from '../rag/types.js';
import { BrandingSchema, normalizeOrigin, OriginsSchema, type SecurityConfig } from '../security/config.js';
import { HttpError, notFound } from '../security/errors.js';
import { auditContext, enforceLimit } from '../security/http.js';
import type { SecurityStore } from '../security/repository.js';
import type { Metrics } from '../operations/metrics.js';
import { publicConfig, type PublicChatbot, type PublicChatbotRepository } from './repository.js';

export function publicRouter(bots: PublicChatbotRepository, security: SecurityStore, config: SecurityConfig,
  chat: ProductionChatService | undefined, sources: RetrievalRepository | undefined, metrics: Metrics) {
  const router = Router();
  router.use('/chatbots/:publicId', async (req, res, next) => {
    res.vary('Origin'); res.set('Cache-Control', 'no-store');
    const bot = await bots.resolve(String(req.params.publicId));
    const origin = req.get('origin');
    let normalized: string | undefined;
    try { normalized = origin ? normalizeOrigin(origin) : undefined; } catch { /* Fail closed below. */ }
    if (origin ? (!normalized || normalized !== origin || !(await bots.origins(bot.organizationId, bot.chatbotId)).includes(normalized)) :
      !config.PUBLIC_CHAT_ALLOW_MISSING_ORIGIN) throw new HttpError(403, 'ORIGIN_REJECTED', 'Origin is not allowed.');
    if (origin) res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    res.locals.publicBot = bot; next();
  });
  router.get('/chatbots/:publicId/config', (_req, res) => res.json(publicConfig(res.locals.publicBot)));
  router.post('/chatbots/:publicId/chat', async (req, res) => {
    const bot: PublicChatbot = res.locals.publicBot;
    await enforceLimit(security, res, metrics, 'public-chat', [bot.publicId, req.ip ?? 'unknown'], config.PUBLIC_CHAT_RATE_LIMIT, config.PUBLIC_CHAT_RATE_WINDOW_SECONDS);
    const input = ChatRequestSchema.parse(req.body);
    if (!chat) throw new HttpError(503, 'UNAVAILABLE', 'Chat is temporarily unavailable.');
    metrics.event('public_chat');
    try {
      const result = await chat.chat(bot, input, String(req.id));
      // Revalidate access after a slow generation: rotation/disable takes effect for in-flight responses too.
      await bots.resolve(bot.publicId);
      const currentOrigin = req.get('origin');
      if (currentOrigin && !(await bots.origins(bot.organizationId, bot.chatbotId)).includes(currentOrigin)) throw new HttpError(403, 'ORIGIN_REJECTED', 'Origin is not allowed.');
      if (result.fallback) metrics.event('rag_fallback');
      res.json({ ...result, sources: result.sources.map(s => ({ ...s,
        path: `/api/public/chatbots/${bot.publicId}/document-sources/${s.id}` })) });
    } catch (error) { metrics.event('public_failure'); throw error; }
  });
  router.get('/chatbots/:publicId/document-sources/:sourceId', async (req, res) => {
    const id = z.uuid().safeParse(req.params.sourceId);
    if (!id.success || !sources) throw notFound();
    const bot: PublicChatbot = res.locals.publicBot;
    const [chunk] = await sources.getByIds(bot, [id.data]);
    if (!chunk || chunk.organizationId !== bot.organizationId || chunk.chatbotId !== bot.chatbotId) throw notFound();
    res.json({ id: chunk.id, title: chunk.title.slice(0, 200), page: chunk.page,
      section: chunk.section?.slice(0, 200) ?? null, excerpt: chunk.text.slice(0, 1500) });
  });
  return router;
}
export function publicAdminRouter(bots: PublicChatbotRepository, security: SecurityStore) {
  const router = Router();
  const base = '/organizations/:organizationId/chatbots/:chatbotId';
  router.use(base, (req, _res, next) => {
    z.uuid().parse(req.params.organizationId); z.uuid().parse(req.params.chatbotId); next();
  });
  router.get(`${base}/public-settings`, async (req, res) => res.json(await bots.get(req.params.organizationId, req.params.chatbotId)));
  router.put(`${base}/branding`, async (req, res) => res.json(await bots.update(req.params.organizationId, req.params.chatbotId,
    { branding: BrandingSchema.parse(req.body) }, auditContext(req, res, 'chatbot.updated', 'chatbot'))));
  router.put(`${base}/public-access`, async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await bots.update(req.params.organizationId, req.params.chatbotId, { enabled },
      { ...auditContext(req, res, 'chatbot.public_enabled.changed', 'chatbot'), metadata: { enabled } }));
  });
  router.post(`${base}/public-id/rotate`, async (req, res) => res.json(await bots.update(req.params.organizationId, req.params.chatbotId,
    { rotate: true }, auditContext(req, res, 'chatbot.public_id.rotated', 'chatbot'))));
  router.get(`${base}/allowed-origins`, async (req, res) => res.json({ origins: await bots.origins(req.params.organizationId, req.params.chatbotId) }));
  router.put(`${base}/allowed-origins`, async (req, res) => {
    const { origins } = OriginsSchema.parse(req.body);
    await bots.update(req.params.organizationId, req.params.chatbotId, { origins },
      { ...auditContext(req, res, 'chatbot.allowed_origins.changed', 'chatbot'), metadata: { count: origins.length } });
    res.json({ origins });
  });
  router.get('/organizations/:organizationId/audit-events', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
    const offset = z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    res.json({ events: await security.auditPage(req.params.organizationId, limit, offset), limit, offset });
  });
  return router;
}
