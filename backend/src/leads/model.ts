import { z } from 'zod';
import { HttpError } from '../security/errors.js';
const text = (max: number) => z.string().trim().max(max).refine(v => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v));
const single = (max: number) => text(max).refine(v => !/[\r\n\t]/.test(v));
export const SettingsSchema = z.object({
  enabled:z.boolean().default(false), handoffEnabled:z.boolean().default(false),
  formTitle:single(120).min(1).default('Contact us'), formMessage:text(1000).default('Leave your details for our team.'),
  successMessage:text(500).min(1).default('Thank you. Your request has been received.'),
  collectName:z.boolean().default(true),requireName:z.boolean().default(false),
  collectEmail:z.boolean().default(true),requireEmail:z.boolean().default(true),
  collectPhone:z.boolean().default(false),requirePhone:z.boolean().default(false),
  collectCompany:z.boolean().default(false),requireCompany:z.boolean().default(false),
  collectMessage:z.boolean().default(true),requireMessage:z.boolean().default(false),
  consentRequired:z.boolean().default(false),consentText:text(1000).default(''),
}).strict().superRefine((s,ctx)=>{
  for(const f of fields) if(s[`require${f}`]&&!s[`collect${f}`])ctx.addIssue({code:'custom',path:[`require${f}`],message:'Required fields must be collected.'});
  if(s.handoffEnabled&&(!s.enabled||(!s.collectEmail&&!s.collectPhone)))ctx.addIssue({code:'custom',path:['handoffEnabled'],message:'Handoff requires capture and a contact field.'});
  if(s.consentRequired&&!s.consentText)ctx.addIssue({code:'custom',path:['consentText'],message:'Enter consent text.'});
});
export const fields=['Name','Email','Phone','Company','Message'] as const;
export type Settings=z.infer<typeof SettingsSchema>;
export const settingsKeys=Object.keys(SettingsSchema.shape) as (keyof Settings)[];
export const snake=(s:string)=>s.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
export const settingsProjection=settingsKeys.map(k=>`${snake(k)} AS "${k}"`).join(',');
export const LeadStatus=z.enum(['new','contacted','qualified','closed']);
export const HandoffStatus=z.enum(['requested','acknowledged','resolved','cancelled']);
export const SubmissionSchema=z.object({
  idempotencyKey:z.uuid(),source:z.enum(['widget','public_api']).default('public_api'),
  name:single(200).optional(),email:single(254).optional(),phone:single(40).optional(),company:single(200).optional(),
  visitorMessage:text(2000).optional(),reason:text(2000).optional(),consentGiven:z.boolean().default(false),
}).strict();
export type Submission=z.infer<typeof SubmissionSchema>;
export function validateSubmission(s:Settings,i:Submission,handoff:boolean){
  const fail=(message:string)=>{throw new HttpError(400,'INVALID_REQUEST',message);};
  const values={Name:i.name,Email:i.email,Phone:i.phone,Company:i.company,Message:i.visitorMessage};
  for(const f of fields){if(s[`require${f}`]&&!values[f])fail(`${f} is required.`);if(!s[`collect${f}`]&&values[f])fail(`${f} is not collected.`);}
  if(i.email&&!z.email().safeParse(i.email).success)fail('Enter a valid email address.');
  if(i.phone&&(!/^[+()\d .\-/#ext]+$/i.test(i.phone)||i.phone.replace(/\D/g,'').length<3))fail('Enter a valid phone number.');
  if(handoff&&(!i.email&&!i.phone))fail('Email or phone is required for follow-up.');
  if(handoff&&!i.reason)fail('A reason is required for follow-up.');
  if(!handoff&&i.reason)fail('Reason is only available for handoff.');
  if(s.consentRequired&&!i.consentGiven)fail('Consent is required.');
  if(i.consentGiven&&!s.consentText)fail('Consent is not configured.');
}
export const leadProjection='id,chatbot_id,source,name,normalized_email,phone,company,visitor_message,status,consent_given,consent_version,consent_at,created_at,updated_at';
export const handoffProjection='id,chatbot_id,lead_id,status,reason,assigned_user_id,revision,requested_at,acknowledged_at,resolved_at,created_at,updated_at';
