import { createHash } from 'node:crypto';
import type { CommercialService } from '../commercial/service.js';
import type { DB } from '../commercial/repository.js';
import { assertEntitled, QuotaError } from '../commercial/model.js';
import { HttpError, notFound } from '../security/errors.js';
import { appendAudit, type Audit } from '../security/repository.js';
import type { PublicChatbot } from '../public/repository.js';
import { SettingsSchema, settingsKeys, settingsProjection, snake, validateSubmission, leadProjection, handoffProjection, type Settings, type Submission } from './model.js';
export class LeadService {
  constructor(readonly commercial:CommercialService){}
  async bot(db:DB,org:string,bot:string){if(!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2 FOR UPDATE',[org,bot])).rowCount)throw notFound();}
  async settings(org:string,bot:string,db:DB=this.commercial.pool):Promise<Settings & {consentVersion:number}>{
    if(!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2',[org,bot])).rowCount)throw notFound();
    return (await db.query(`SELECT ${settingsProjection},consent_version AS "consentVersion" FROM lead_capture_settings WHERE organization_id=$1 AND chatbot_id=$2`,[org,bot])).rows[0]??{...SettingsSchema.parse({}),consentVersion:1};
  }
  async publicSettings(org:string,bot:string){const {consentVersion:_,...safe}=await this.settings(org,bot);return safe;}
  async updateSettings(org:string,bot:string,s:Settings,audit:Audit){return this.commercial.run(org,async(db)=>{
    await this.bot(db,org,bot);
    const old=await this.settings(org,bot,db);
    const version=old.consentVersion+(old.consentText!==s.consentText||old.consentRequired!==s.consentRequired?1:0);
    await db.query(`INSERT INTO lead_capture_settings(organization_id,chatbot_id,${settingsKeys.map(snake).join(',')},updated_by,consent_version)
      VALUES($1,$2,${settingsKeys.map((_,i)=>'$'+(i+3)).join(',')},$${settingsKeys.length+3},$${settingsKeys.length+4})
      ON CONFLICT(organization_id,chatbot_id) DO UPDATE SET ${settingsKeys.map(k=>`${snake(k)}=EXCLUDED.${snake(k)}`).join(',')},updated_by=EXCLUDED.updated_by,consent_version=EXCLUDED.consent_version,updated_at=now()`,
      [org,bot,...settingsKeys.map(k=>s[k]),audit.actorUserId,version]);
    await appendAudit(db,{...audit,organizationId:org,chatbotId:bot,action:'lead_capture.settings_updated',targetType:'chatbot',targetId:bot});
    return this.settings(org,bot,db);
  });}
  async submit(bot:PublicChatbot,origin:string|undefined,input:Submission,handoff:boolean,requestId:string){
    return this.commercial.run(bot.organizationId,async(db,{subscription:s,plan:p})=>{
      const org=bot.organizationId,id=bot.chatbotId;
      await this.bot(db,org,id);
      // Recheck public identity/origin under the same lock used for rotation and settings edits.
      if(!(await db.query('SELECT id FROM chatbots WHERE organization_id=$1 AND id=$2 AND public_enabled AND public_id=$3',[org,id,bot.publicId])).rowCount)throw notFound();
      if(origin&&!(await db.query('SELECT 1 FROM chatbot_allowed_origins WHERE organization_id=$1 AND chatbot_id=$2 AND origin=$3',[org,id,origin])).rowCount)throw new HttpError(403,'ORIGIN_REJECTED','Origin is not allowed.');
      const settings=await this.settings(org,id,db);
      if(!settings.enabled||(handoff&&!settings.handoffEnabled))throw new HttpError(403,'CAPTURE_DISABLED','Contact requests are unavailable.');
      const kind=handoff?'handoff':'lead',hash=createHash('sha256').update(input.idempotencyKey).digest('hex');
      await db.query('DELETE FROM lead_submission_receipts WHERE organization_id=$1 AND expires_at<=now()',[org]);
      if((await db.query('SELECT 1 FROM lead_submission_receipts WHERE organization_id=$1 AND chatbot_id=$2 AND kind=$3 AND key_hash=$4',[org,id,kind,hash])).rowCount)return;
      validateSubmission(settings,input,handoff);
      assertEntitled(s);
      if(!p.lead_capture_enabled||(handoff&&!p.human_handoff_enabled))throw new HttpError(403,'FEATURE_DISABLED','Contact requests are unavailable.');
      for(const [metric,limit] of [['leads_created',p.monthly_lead_limit],...(handoff?[['handoffs_requested',p.monthly_handoff_limit] as const]:[])] as const){
        const used=Number((await db.query('SELECT coalesce(sum(quantity),0) n FROM usage_counters WHERE organization_id=$1 AND period_start=$2 AND metric=$3',[org,s.current_period_start,metric])).rows[0].n);
        if(used>=limit)throw new QuotaError();
      }
      // Preserve the email local part; only the DNS domain is case-insensitive.
      const email=input.email?input.email.slice(0,input.email.lastIndexOf('@')+1)+input.email.slice(input.email.lastIndexOf('@')+1).toLowerCase():null;
      const lead=(await db.query(`INSERT INTO leads(organization_id,chatbot_id,source,name,normalized_email,phone,company,visitor_message,consent_given,consent_version,consent_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9 THEN now() ELSE NULL END) RETURNING id`,
        [org,id,input.source,input.name||null,email,input.phone||null,input.company||null,input.visitorMessage||null,input.consentGiven,settings.consentVersion])).rows[0];
      const audit={organizationId:org,chatbotId:id,requestId};
      await appendAudit(db,{...audit,action:'lead.created',targetType:'lead',targetId:lead.id});
      await this.commercial.meter(db,s,'leads_created');
      if(handoff){const h=(await db.query('INSERT INTO handoff_requests(organization_id,chatbot_id,lead_id,reason) VALUES($1,$2,$3,$4) RETURNING id',[org,id,lead.id,input.reason])).rows[0];
        await appendAudit(db,{...audit,action:'handoff.requested',targetType:'handoff',targetId:h.id});await this.commercial.meter(db,s,'handoffs_requested');}
      await db.query('INSERT INTO lead_submission_receipts(organization_id,chatbot_id,kind,key_hash) VALUES($1,$2,$3,$4)',[org,id,kind,hash]);
    });
  }
  async list(org:string,bot:string,handoff:boolean,limit:number,offset:number,status?:string){
    await this.settings(org,bot);
    const projection=handoff?handoffProjection.split(',').map(c=>'h.'+c).join(',')+',l.name,l.normalized_email,l.phone':leadProjection;
    const from=handoff?'handoff_requests h JOIN leads l ON l.organization_id=h.organization_id AND l.chatbot_id=h.chatbot_id AND l.id=h.lead_id':'leads h';
    const items=(await this.commercial.pool.query(`SELECT ${projection} FROM ${from} WHERE h.organization_id=$1 AND h.chatbot_id=$2 AND ($3::text IS NULL OR h.status=$3) ORDER BY h.created_at DESC,h.id DESC LIMIT $4 OFFSET $5`,[org,bot,status??null,limit+1,offset])).rows;
    return {items:items.slice(0,limit),hasMore:items.length>limit,limit,offset};
  }
  async get(org:string,bot:string,id:string,handoff:boolean,db:DB=this.commercial.pool,lock=false){
    const r=(await db.query(`SELECT ${handoff?handoffProjection:leadProjection} FROM ${handoff?'handoff_requests':'leads'} WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,[org,bot,id])).rows[0];if(!r)throw notFound();return r;
  }
  async updateLead(org:string,bot:string,id:string,status:string,audit:Audit){return this.commercial.run(org,async db=>{
    const old=await this.get(org,bot,id,false,db,true);
    if(old.status!==status){await db.query('UPDATE leads SET status=$4,updated_at=now() WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3',[org,bot,id,status]);
      await appendAudit(db,{...audit,organizationId:org,chatbotId:bot,action:'lead.status_updated',targetType:'lead',targetId:id,metadata:{status:status as NonNullable<Audit['metadata']>['status']}});}
    return this.get(org,bot,id,false,db);
  });}
  async deleteLead(org:string,bot:string,id:string,audit:Audit){return this.commercial.run(org,async db=>{
    await this.bot(db,org,bot);
    await this.get(org,bot,id,false,db,true);
    if((await db.query('DELETE FROM leads WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3',[org,bot,id])).rowCount)
      await appendAudit(db,{...audit,organizationId:org,chatbotId:bot,action:'lead.deleted',targetType:'lead',targetId:id});
  });}
  async updateHandoff(org:string,bot:string,id:string,change:{revision:number;action:'acknowledge'|'assign'|'resolve'|'cancel';assignedUserId?:string|null},audit:Audit){return this.commercial.run(org,async db=>{
    const old=await this.get(org,bot,id,true,db,true);
    if(old.revision!==change.revision)throw new HttpError(409,'CONFLICT','This request changed. Refresh before trying again.');
    if(['resolved','cancelled'].includes(old.status))throw new HttpError(409,'INVALID_TRANSITION','This request is already closed.');
    let status=old.status,assigned=old.assigned_user_id;
    if(change.action==='assign'){
      assigned=change.assignedUserId??null;
      if(assigned&&!(await db.query('SELECT 1 FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 FOR KEY SHARE',[org,assigned])).rowCount)throw notFound();
    }else if(change.action==='acknowledge'){
      if(status!=='requested')throw new HttpError(409,'INVALID_TRANSITION','This request is already acknowledged.');status='acknowledged';
    }else if(change.action==='resolve'){
      if(status!=='acknowledged')throw new HttpError(409,'INVALID_TRANSITION','Acknowledge this request before resolving it.');status='resolved';
    }else status='cancelled';
    await db.query(`UPDATE handoff_requests SET status=$4,assigned_user_id=$5,revision=revision+1,updated_at=now(),
      acknowledged_at=CASE WHEN $4='acknowledged' THEN coalesce(acknowledged_at,now()) ELSE acknowledged_at END,
      resolved_at=CASE WHEN $4='resolved' THEN now() ELSE resolved_at END WHERE organization_id=$1 AND chatbot_id=$2 AND id=$3`,[org,bot,id,status,assigned]);
    const action={assign:'assigned',acknowledge:'acknowledged',resolve:'resolved',cancel:'cancelled'}[change.action];
    await appendAudit(db,{...audit,organizationId:org,chatbotId:bot,action:`handoff.${action}`,targetType:'handoff',targetId:id,metadata:{status, ...(change.action==='assign'?{assignedUserId:assigned}:{})}});
    return this.get(org,bot,id,true,db);
  });}
}
