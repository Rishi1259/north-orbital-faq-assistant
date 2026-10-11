import { Router } from 'express';
import { z } from 'zod';
import { auditContext } from '../security/http.js';
import { SettingsSchema,LeadStatus,HandoffStatus } from './model.js';
import type { LeadService } from './service.js';
export function leadAdminRouter(service:LeadService){
  const r=Router(),base='/organizations/:organizationId/chatbots/:chatbotId';
  r.use(base,(req,_res,next)=>{z.uuid().parse(req.params.organizationId);z.uuid().parse(req.params.chatbotId);next();});
  r.get(`${base}/lead-settings`,async(req,res)=>res.json(await service.settings(req.params.organizationId,req.params.chatbotId)));
  r.put(`${base}/lead-settings`,async(req,res)=>res.json(await service.updateSettings(req.params.organizationId,req.params.chatbotId,SettingsSchema.parse(req.body),auditContext(req,res,'',''))));
  r.get(`${base}/handoff-members`,async(req,res)=>{
    await service.settings(req.params.organizationId,req.params.chatbotId);
    const limit=z.coerce.number().int().min(1).max(100).default(100).parse(req.query.limit),offset=z.coerce.number().int().min(0).max(100000).default(0).parse(req.query.offset);
    const rows=(await service.commercial.pool.query('SELECT m.user_id,m.role,u.email FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.user_id LIMIT $2 OFFSET $3',[req.params.organizationId,limit+1,offset])).rows;
    res.json({items:rows.slice(0,limit),hasMore:rows.length>limit,limit,offset});
  });
  for(const [path,handoff] of [['leads',false],['handoffs',true]] as const){
    r.get(`${base}/${path}`,async(req,res)=>{
      const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0),status:(handoff?HandoffStatus:LeadStatus).optional()}).strict().parse(req.query);
      res.json(await service.list(req.params.organizationId,req.params.chatbotId,handoff,q.limit,q.offset,q.status));
    });
    r.get(`${base}/${path}/:id`,async(req,res)=>res.json(await service.get(req.params.organizationId,req.params.chatbotId,z.uuid().parse(req.params.id),handoff)));
  }
  r.patch(`${base}/leads/:id`,async(req,res)=>{const {status}=z.object({status:LeadStatus}).strict().parse(req.body);res.json(await service.updateLead(req.params.organizationId,req.params.chatbotId,z.uuid().parse(req.params.id),status,auditContext(req,res,'','')));});
  r.delete(`${base}/leads/:id`,async(req,res)=>{await service.deleteLead(req.params.organizationId,req.params.chatbotId,z.uuid().parse(req.params.id),auditContext(req,res,'',''));res.status(204).end();});
  r.patch(`${base}/handoffs/:id`,async(req,res)=>{
    const change=z.object({revision:z.number().int().positive(),action:z.enum(['acknowledge','assign','resolve','cancel']),assignedUserId:z.uuid().nullable().optional()}).strict().refine(c=>c.action==='assign'?c.assignedUserId!==undefined:c.assignedUserId===undefined).parse(req.body);
    res.json(await service.updateHandoff(req.params.organizationId,req.params.chatbotId,z.uuid().parse(req.params.id),change,auditContext(req,res,'','')));
  });
  return r;
}
