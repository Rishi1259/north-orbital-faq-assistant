import { Router } from 'express';
import { z } from 'zod';
import type { CommercialService } from './service.js';
import { ApiKeyService } from './api-keys.js';
import { PlanRepository } from './repository.js';
import { PrivacyService } from './privacy.js';
import { CommercialDocuments } from './documents.js';
import { HttpError, notFound } from '../security/errors.js';
import { auditContext, enforceLimit, sessionOf } from '../security/http.js';
import type { SecurityStore } from '../security/repository.js';
import type { Metrics } from '../operations/metrics.js';
import { ChatRequestSchema } from '../ai/types.js';
import type { ProductionChatService } from '../rag/chat-service.js';
export const PageSchema = z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict();
export function commercialRouter(commercial: CommercialService, security: SecurityStore, metrics: Metrics) {
  const router = Router(), keys = new ApiKeyService(commercial), privacy = new PrivacyService(commercial);
  const base = '/organizations/:organizationId';
  router.get('/plans',async(_req,res)=>res.json({plans:await new PlanRepository(commercial.pool).list()}));
  router.get('/account/organizations',async(_req,res)=>res.json({organizations:(await commercial.pool.query(`SELECT o.id,o.name,m.role FROM organizations o
    JOIN organization_memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at,o.id LIMIT 100`,[sessionOf(res).userId])).rows}));
  router.get(`${base}/subscription`,async(req,res)=>{ const s = await commercial.snapshot(req.params.organizationId); res.json({subscription:s.subscription,plan:s.plan,period:s.period}); });
  router.get(`${base}/usage`,async(req,res)=>{ const s = await commercial.snapshot(req.params.organizationId); res.json({period:s.period,plan:s.plan,usage:s.usage}); });
  router.get(`${base}/entitlements`,async(req,res)=>res.json((await commercial.snapshot(req.params.organizationId)).entitlements));
  router.get(`${base}/onboarding-status`,async(req,res)=>res.json(await privacy.onboarding(req.params.organizationId)));
  router.get(`${base}/privacy/export`,async(req,res)=>{
    if (res.locals.role !== 'owner') throw new HttpError(403,'FORBIDDEN','This operation requires an owner.');
    const {limit,offset,asOf} = PageSchema.extend({asOf:z.iso.datetime({offset:true}).optional()}).parse(req.query);
    await enforceLimit(security,res,metrics,'privacy-export',[req.params.organizationId,sessionOf(res).userId],30,60);
    res.set('Content-Disposition','attachment; filename="organization-export.json"');
    res.json(await privacy.export(req.params.organizationId,limit,offset,auditContext(req,res,'privacy.exported','organization'),asOf));
  });
  router.use(`${base}/api-keys`,async(req,res,next)=>{
    if (res.locals.role === 'member') throw new HttpError(403,'FORBIDDEN','This operation requires an administrator.');
    await enforceLimit(security,res,metrics,'api-key-management',[String(req.params.organizationId),sessionOf(res).userId],30,60); next();
  });
  router.get(`${base}/api-keys`,async(req,res)=>{ const {limit,offset}=PageSchema.parse(req.query);res.json({apiKeys:await keys.list(req.params.organizationId,limit,offset),limit,offset}); });
  router.post(`${base}/api-keys`,async(req,res)=>res.status(201).json(await keys.create(req.params.organizationId,req.body,auditContext(req,res,'api_key.created','api_key'))));
  router.delete(`${base}/api-keys/:apiKeyId`,async(req,res)=>{await keys.revoke(req.params.organizationId,req.params.apiKeyId,auditContext(req,res,'api_key.revoked','api_key'));res.status(204).end();});
  router.delete(`${base}/chatbots/:chatbotId/documents/:documentId`,async(req,res)=>{
    const scope = z.object({organizationId:z.uuid(),chatbotId:z.uuid(),documentId:z.uuid()}).parse(req.params);
    if (!(await commercial.pool.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2',[scope.organizationId,scope.chatbotId])).rowCount) throw notFound();
    await new CommercialDocuments(commercial).delete(scope,auditContext(req,res,'document.deleted','document'));
    res.status(202).json({status:'deletion_scheduled'});
  });
  return router;
}
// A separate bearer-only namespace deliberately never accepts sessions or browser CSRF.
export function apiRouter(commercial: CommercialService, security: SecurityStore, metrics: Metrics, chat?: ProductionChatService) {
  const router = Router(), keys = new ApiKeyService(commercial);
  router.use(async(req,res,next)=>{
    res.set('Cache-Control','no-store');
    await enforceLimit(security,res,metrics,'api-client',[req.ip??'unknown'],120,60);
    const header = req.get('authorization')??'';
    if (!header.startsWith('Bearer ')) throw new HttpError(401,'INVALID_API_KEY','Invalid API key.');
    const key = await keys.authenticate(header.slice(7));
    await enforceLimit(security,res,metrics,'api-key',[key.id],60,60);
    await commercial.apiRequest(key.organizationId);
    res.locals.apiKey = key; next();
  });
  router.post('/organizations/:organizationId/chatbots/:chatbotId/chat',async(req,res)=>{
    const {organizationId,chatbotId} = z.object({organizationId:z.uuid(),chatbotId:z.uuid()}).parse(req.params);
    const key = res.locals.apiKey;
    if (organizationId !== key.organizationId) throw notFound();
    if (!key.scopes.includes('chat:write')) throw new HttpError(403,'INSUFFICIENT_SCOPE','This API key lacks the required scope.');
    const input = ChatRequestSchema.parse(req.body);
    if (!(await commercial.pool.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2',[organizationId,chatbotId])).rowCount) throw notFound();
    if (!chat) throw new HttpError(503,'UNAVAILABLE','Chat is temporarily unavailable.');
    await commercial.consumeMessage(organizationId,'internal_chat_messages',true);
    res.json(await chat.chat({organizationId,chatbotId},input,String(req.id)));
  });
  return router;
}
