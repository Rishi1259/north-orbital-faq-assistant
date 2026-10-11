import { settingsProjection,leadProjection,handoffProjection } from '../leads/model.js';
import { appendAudit, type Audit } from '../security/repository.js';
import type { CommercialService } from './service.js';
import { keyColumns } from './api-keys.js';
import { deriveOnboarding } from './model.js';
// Explicit projections are the privacy boundary; never serialize database rows from SELECT *.
const exportQueries = {
  leadSettings:`SELECT chatbot_id,${settingsProjection},consent_version,created_at,updated_at FROM lead_capture_settings WHERE organization_id=$1 AND created_at<=$4 ORDER BY chatbot_id LIMIT $2 OFFSET $3`,
  leads:`SELECT ${leadProjection} FROM leads WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  handoffs:`SELECT ${handoffProjection} FROM handoff_requests WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  websiteSources: `SELECT id,chatbot_id,canonical_seed_url,status,sync_mode,next_sync_at,last_attempted_at,last_successful_at,created_at,updated_at FROM website_sources WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  websitePages: `SELECT id,chatbot_id,website_source_id,canonical_url,title,state,last_seen_at,indexed_at FROM website_pages WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  manualFaqs: `SELECT id,chatbot_id,question,answer,category,status,created_at,updated_at FROM manual_faqs WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  memberships: `SELECT m.user_id,m.role,m.created_at,u.email FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.created_at<=$4 ORDER BY m.user_id LIMIT $2 OFFSET $3`,
  chatbots: `SELECT id,name,status,public_id,public_enabled,display_name,welcome_message,accent_color,launcher_label,launcher_position,created_at,updated_at FROM chatbots WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  documents: `SELECT id,chatbot_id,title,original_filename,mime_type,size_bytes,status,page_count,chunk_count,ocr_used,created_at,processed_at FROM documents WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  allowedOrigins: `SELECT chatbot_id,origin,created_at FROM chatbot_allowed_origins WHERE organization_id=$1 AND created_at<=$4 ORDER BY chatbot_id,origin LIMIT $2 OFFSET $3`,
  apiKeys: `SELECT ${keyColumns} FROM api_keys WHERE organization_id=$1 AND created_at<=$4 ORDER BY id LIMIT $2 OFFSET $3`,
  auditEvents: `SELECT id,actor_user_id,chatbot_id,action,target_type,target_id,metadata,created_at FROM audit_events WHERE organization_id=$1 AND created_at<=$4 ORDER BY created_at,id LIMIT $2 OFFSET $3`,
  usageHistory: `SELECT metric,period_start,period_end,quantity FROM usage_counters WHERE organization_id=$1 AND period_start<=$4 ORDER BY period_start,metric LIMIT $2 OFFSET $3`,
};
export class PrivacyService {
  constructor(private commercial: CommercialService) {}
  async export(org: string, limit: number, offset: number, audit: Audit, requestedAsOf?: string) {
    // Capture DB time before the audit transaction starts. Later export audits are
    // outside this cutoff, so paginating the audit section always terminates.
    const now: Date = (await this.commercial.pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
    const asOf = requestedAsOf ? new Date(Math.min(+new Date(requestedAsOf),+now)) : now;
    return this.commercial.run(org,async(db,state)=>{
      const account = await this.commercial.snapshotWithin(db,org,state);
      const sections: Record<string, {items: unknown[]; hasMore: boolean}> = {};
      for (const [name,sql] of Object.entries(exportQueries)) {
        const rows = (await db.query(sql,[org,limit+1,offset,asOf])).rows;
        sections[name] = {items:rows.slice(0,limit),hasMore:rows.length>limit};
      }
      await appendAudit(db,{...audit,organizationId:org,action:'privacy.exported',targetType:'organization',targetId:org});
      return {schemaVersion:1,asOf,exportedAt:new Date(),limit,offset,...account,sections};
    });
  }
  async onboarding(org: string) {
    const rows = (await this.commercial.pool.query(`SELECT
      EXISTS(SELECT 1 FROM ready_knowledge_chunks c WHERE c.organization_id=b.organization_id AND c.chatbot_id=b.id) AS "knowledgeReady",
      EXISTS(SELECT 1 FROM chatbot_allowed_origins o WHERE o.organization_id=b.organization_id AND o.chatbot_id=b.id) AS "allowedOriginConfigured",
      b.public_enabled AS "publicChatEnabled" FROM chatbots b WHERE organization_id=$1`,[org])).rows;
    return deriveOnboarding(rows);
  }
}
