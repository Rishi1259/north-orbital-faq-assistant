import { z } from 'zod';
import { HttpError } from '../security/errors.js';
export const MetricSchema = z.enum(['public_chat_messages','internal_chat_messages','documents_created','ingestion_pages','storage_bytes','api_requests','website_pages_indexed','website_crawl_requests','manual_faq_entries','leads_created','handoffs_requested']);
export type Metric = z.infer<typeof MetricSchema>;
export const ScopeSchema = z.enum(['chat:write','chatbots:read','documents:read','documents:write','analytics:read']);
export const CreateKeySchema = z.object({ name: z.string().trim().min(1).max(80),
  scopes: z.array(ScopeSchema).min(1).max(5).refine(v => new Set(v).size === v.length),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict();
export interface Subscription {
  organization_id: string; plan_code: string; status: 'trialing'|'active'|'past_due'|'suspended'|'cancelled';
  current_period_start: Date; current_period_end: Date; trial_ends_at: Date|null; grace_ends_at: Date|null;
}
export interface Plan {
  lead_capture_enabled:boolean; human_handoff_enabled:boolean; monthly_lead_limit:number; monthly_handoff_limit:number;
  website_source_limit: number; knowledge_page_limit: number; indexed_bytes_limit: string;
  code: string; name: string; status: string; monthly_price_inr_minor: string|null; monthly_price_usd_minor: string|null;
  chatbot_limit: number; monthly_message_limit: number; document_limit: number; storage_bytes_limit: string;
  team_member_limit: number; monthly_ingestion_page_limit: number|null; api_access: boolean; advanced_analytics: boolean;
}
// Provider-independent rolling periods retain the exact configured duration and anchor.
// Initial beta period is 30 days, not an assumed calendar month.
export function currentPeriod(start: Date, end: Date, now = new Date()) {
  const duration = end.getTime()-start.getTime();
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('Invalid subscription period.');
  const steps = Math.max(0, Math.floor((now.getTime()-start.getTime())/duration));
  return { start: new Date(start.getTime()+steps*duration), end: new Date(end.getTime()+steps*duration) };
}
export function subscriptionAllowed(s: Subscription, now = new Date()) {
  if (s.current_period_start > now) return false;
  return s.status === 'active' || (s.status === 'trialing' && !!s.trial_ends_at && s.trial_ends_at > now) ||
    (s.status === 'past_due' && !!s.grace_ends_at && s.grace_ends_at > now);
}
export function entitlements(s: Subscription, p: Plan, now = new Date()) {
  const allowed = subscriptionAllowed(s, now);
  return { allowed, leadCaptureEnabled:allowed && p.lead_capture_enabled, humanHandoffEnabled:allowed && p.human_handoff_enabled, monthlyLeadLimit:p.monthly_lead_limit, monthlyHandoffLimit:p.monthly_handoff_limit, apiAccess: allowed && p.api_access, advancedAnalytics: allowed && p.advanced_analytics,
    websiteSourceLimit: p.website_source_limit, knowledgePageLimit: p.knowledge_page_limit, indexedBytesLimit: Number(p.indexed_bytes_limit),
    chatbotLimit: p.chatbot_limit, monthlyMessageLimit: p.monthly_message_limit, documentLimit: p.document_limit,
    storageBytesLimit: Number(p.storage_bytes_limit), teamMemberLimit: p.team_member_limit,
    monthlyIngestionPageLimit: p.monthly_ingestion_page_limit };
}
export function quota(used: number, limit: number|null) {
  return { used, limit, remaining: limit === null ? null : Math.max(0,limit-used),
    percentage: limit === null ? null : limit === 0 ? (used ? 100 : 0) : Math.min(100,Math.round(used/limit*10000)/100) };
}
export class QuotaError extends HttpError {
  constructor() { super(429, 'QUOTA_EXCEEDED', 'Your organization has reached its plan limit.'); }
}
export function assertEntitled(s: Subscription, now = new Date()) {
  if (!subscriptionAllowed(s,now)) throw new HttpError(403,'SUBSCRIPTION_INACTIVE','Your organization subscription does not allow this operation.');
}
export function deriveOnboarding(bots: {knowledgeReady: boolean; allowedOriginConfigured: boolean; publicChatEnabled: boolean}[]) {
  return { organizationCreated: true, chatbotCreated: bots.length > 0,
    knowledgeReady: bots.some(b=>b.knowledgeReady), allowedOriginConfigured: bots.some(b=>b.allowedOriginConfigured),
    publicChatEnabled: bots.some(b=>b.publicChatEnabled),
    installationReady: bots.some(b=>b.knowledgeReady && b.allowedOriginConfigured && b.publicChatEnabled) };
}
