import { Router } from 'express';
import { z } from 'zod';
import { SourceService,WebsiteInput,WebsiteUpdate,FaqInput } from './service.js';
import { auditContext,enforceLimit,sessionOf } from '../security/http.js';
import type { SecurityStore } from '../security/repository.js';
import type { Metrics } from '../operations/metrics.js';
export function sourceRouter(service:SourceService,security:SecurityStore,metrics:Metrics) {
  const router=Router(),base='/organizations/:organizationId/chatbots/:chatbotId';
  const scope=(params:Record<string,unknown>)=>z.object({organizationId:z.uuid(),chatbotId:z.uuid()}).parse(params);
  const pagination=(q:unknown)=>z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(q);
  for(const type of ['website-sources','manual-faqs'])router.use(`${base}/${type}`,async(req,res,next)=>{
    const s=scope(req.params);await service.bot(service.pool,s);
    if(!['GET','HEAD','OPTIONS'].includes(req.method))await enforceLimit(security,res,metrics,'knowledge-mutation',[s.organizationId,sessionOf(res).userId],30,3600);
    next();
  });
  router.get(`${base}/website-sources`,async(req,res)=>{const p=pagination(req.query);res.json({items:await service.list(scope(req.params),p.limit,p.offset),...p});});
  router.post(`${base}/website-sources`,async(req,res)=>{res.status(201).json(await service.create(scope(req.params),WebsiteInput.parse(req.body),auditContext(req,res,'website_source.created','website_source')));});
  router.get(`${base}/website-sources/:sourceId`,async(req,res)=>res.json(await service.get(scope(req.params),z.uuid().parse(req.params.sourceId))));
  router.get(`${base}/website-sources/:sourceId/pages`,async(req,res)=>{const p=pagination(req.query);res.json({items:await service.pages(scope(req.params),z.uuid().parse(req.params.sourceId),p.limit,p.offset),...p});});
  router.patch(`${base}/website-sources/:sourceId`,async(req,res)=>res.json(await service.update(scope(req.params),z.uuid().parse(req.params.sourceId),WebsiteUpdate.parse(req.body),auditContext(req,res,'website_source.updated','website_source'))));
  router.post(`${base}/website-sources/:sourceId/sync`,async(req,res)=>{z.object({}).strict().parse(req.body??{});res.status(202).json(await service.sync(scope(req.params),z.uuid().parse(req.params.sourceId),auditContext(req,res,'website_source.sync_requested','website_source')));});
  router.delete(`${base}/website-sources/:sourceId`,async(req,res)=>{await service.remove(scope(req.params),z.uuid().parse(req.params.sourceId),false,auditContext(req,res,'website_source.deleted','website_source'));res.status(204).end();});
  router.get(`${base}/manual-faqs`,async(req,res)=>{const p=pagination(req.query);res.json({items:await service.faqs(scope(req.params),p.limit,p.offset),...p});});
  router.get(`${base}/manual-faqs/:faqId`,async(req,res)=>res.json((await service.faqs(scope(req.params),1,0,z.uuid().parse(req.params.faqId)))[0]));
  router.post(`${base}/manual-faqs`,async(req,res)=>{res.status(201).json(await service.saveFaq(scope(req.params),FaqInput.parse(req.body),auditContext(req,res,'manual_faq.created','manual_faq')));});
  router.put(`${base}/manual-faqs/:faqId`,async(req,res)=>res.json(await service.saveFaq(scope(req.params),FaqInput.parse(req.body),auditContext(req,res,'manual_faq.updated','manual_faq'),z.uuid().parse(req.params.faqId))));
  router.delete(`${base}/manual-faqs/:faqId`,async(req,res)=>{await service.remove(scope(req.params),z.uuid().parse(req.params.faqId),true,auditContext(req,res,'manual_faq.deleted','manual_faq'));res.status(204).end();});
  return router;
}
