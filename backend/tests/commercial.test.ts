import { describe,it,expect } from 'vitest';
import { currentPeriod, subscriptionAllowed, entitlements, quota, QuotaError, CreateKeySchema, MetricSchema, deriveOnboarding, type Subscription, type Plan } from '../src/commercial/model.js';
import { generateApiKey, verifyApiKey, keyUsable } from '../src/commercial/api-keys.js';
const now = new Date('2026-10-04T00:00:00Z');
const sub:Subscription={organization_id:'org',plan_code:'beta',status:'active',current_period_start:new Date('2026-09-15T12:00:00Z'),current_period_end:new Date('2026-10-15T12:00:00Z'),trial_ends_at:null,grace_ends_at:null};
const plan = {api_access:true,advanced_analytics:true,storage_bytes_limit:'5000000000',monthly_message_limit:15000} as Plan;
describe('commercial rules',()=>{
  it('retains subscription anchors rather than calendar months',()=>{expect(currentPeriod(sub.current_period_start,sub.current_period_end,now)).toEqual({start:sub.current_period_start,end:sub.current_period_end});});
  it('rolls exactly at the boundary and skips missed periods',()=>{
    expect(currentPeriod(sub.current_period_start,sub.current_period_end,sub.current_period_end).start).toEqual(sub.current_period_end);
    const p=currentPeriod(sub.current_period_start,sub.current_period_end,new Date('2027-01-20Z'));expect(+p.end-+p.start).toBe(30*86400000);expect(+p.start).toBeLessThan(+new Date('2027-01-20Z'));expect(+p.end).toBeGreaterThan(+new Date('2027-01-20Z'));
  });
  it('rejects invalid periods',()=>expect(()=>currentPeriod(now,now)).toThrow());
  it.each(['suspended','cancelled'] as const)('denies %s subscriptions',status=>expect(subscriptionAllowed({...sub,status},now)).toBe(false));
  it('requires an unexpired explicit trial',()=>{
    expect(subscriptionAllowed({...sub,status:'trialing'},now)).toBe(false);
    expect(subscriptionAllowed({...sub,status:'trialing',trial_ends_at:new Date(+now+1)},now)).toBe(true);
    expect(subscriptionAllowed({...sub,status:'trialing',trial_ends_at:now},now)).toBe(false);
  });
  it('requires an explicit unexpired past-due grace',()=>{
    expect(subscriptionAllowed({...sub,status:'past_due'},now)).toBe(false);
    expect(subscriptionAllowed({...sub,status:'past_due',grace_ends_at:new Date(+now+1)},now)).toBe(true);
    expect(subscriptionAllowed({...sub,status:'past_due',grace_ends_at:now},now)).toBe(false);
  });
  it('denies future subscriptions',()=>expect(subscriptionAllowed({...sub,current_period_start:new Date(+now+1)},now)).toBe(false));
  it('resolves effective feature flags and numeric byte limits',()=>{
    expect(entitlements(sub,plan,now)).toMatchObject({allowed:true,apiAccess:true,storageBytesLimit:5000000000});
    expect(entitlements({...sub,status:'cancelled'},plan,now)).toMatchObject({allowed:false,apiAccess:false,advancedAnalytics:false});
  });
  it('clamps remaining and handles zero/unlimited quotas',()=>{
    expect(quota(101,100)).toEqual({used:101,limit:100,remaining:0,percentage:100});expect(quota(0,0).percentage).toBe(0);expect(quota(2,null).remaining).toBeNull();
  });
  it('uses stable privacy-safe quota errors',()=>expect(new QuotaError()).toMatchObject({status:429,code:'QUOTA_EXCEEDED'}));
  it('uses a finite metric allowlist',()=>expect(MetricSchema.safeParse('customer-filename.pdf').success).toBe(false));
  it('requires installation readiness on the same bot',()=>expect(deriveOnboarding([{knowledgeReady:true,allowedOriginConfigured:false,publicChatEnabled:true},{knowledgeReady:false,allowedOriginConfigured:true,publicChatEnabled:true}]).installationReady).toBe(false));
  it('derives empty and complete onboarding',()=>{expect(deriveOnboarding([]).chatbotCreated).toBe(false);expect(deriveOnboarding([{knowledgeReady:true,allowedOriginConfigured:true,publicChatEnabled:true}]).installationReady).toBe(true);});
});
describe('API credentials',()=>{
  it('generates unique 256-bit secrets and hashes',()=>{
    const a=generateApiKey(),b=generateApiKey();expect(a.secret).toMatch(/^no_live_[\w-]{43}$/);expect(Buffer.from(a.secret.slice(8),'base64url')).toHaveLength(32);expect(a.secret).not.toBe(b.secret);expect(a.hash).toMatch(/^[a-f0-9]{64}$/);expect(a.hash).not.toContain(a.secret);
    expect(verifyApiKey(a.secret,a.hash)).toBe(true);expect(verifyApiKey(b.secret,a.hash)).toBe(false);expect(verifyApiKey('bad',a.hash)).toBe(false);
  });
  it.each([[],['root'],['chat:write','chat:write']])('rejects invalid scopes %j',scopes=>expect(CreateKeySchema.safeParse({name:'CRM',scopes}).success).toBe(false));
  it('bounds and strictly validates creation',()=>{expect(CreateKeySchema.safeParse({name:'a'.repeat(81),scopes:['chat:write']}).success).toBe(false);expect(CreateKeySchema.safeParse({name:'CRM',scopes:['chat:write'],organizationId:'another'}).success).toBe(false);});
  it('rejects revoked/expired keys including exact expiry',()=>{
    expect(keyUsable({revoked_at:null,expires_at:null},now)).toBe(true);expect(keyUsable({revoked_at:now,expires_at:null},now)).toBe(false);expect(keyUsable({revoked_at:null,expires_at:now},now)).toBe(false);
  });
});
