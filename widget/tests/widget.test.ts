// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedHistory, mountWidget, parseConfig, parseScript } from '../src/widget';
const id = `pub_${'a'.repeat(48)}`;
const config = { publicId: id, displayName: '<img src=x onerror=alert(1)>', welcomeMessage: '<script>oops</script>', accentColor: '#2563EB', launcherLabel: 'Chat', launcherPosition: 'bottom-right' };
function script() { const s = document.createElement('script'); s.src = 'https://chat.example/widget/v1.js'; s.dataset.chatbot = id; return s; }
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body }) as Response;
afterEach(() => { document.body.replaceChildren(); });
describe('widget', () => {
  it('validates embed and branding; rejects unsafe hosts, IDs and CSS', () => {
    expect(parseScript(script())).toEqual({ publicId: id, origin: 'https://chat.example' });
    const s = script(); s.dataset.chatbot = 'bad'; expect(() => parseScript(s)).toThrow();
    expect(() => parseConfig({ ...config, accentColor: 'red;position:fixed' }, id)).toThrow();
    expect(() => parseConfig({ ...config, launcherPosition: 'top' }, id)).toThrow();
  });
  it('renders safely, opens/closes and restores focus with Escape', async () => {
    const result = await mountWidget(script(), vi.fn(async () => response(config)));
    const root = result.host.shadowRoot!;
    expect(root.querySelector('img')).toBeNull(); expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain(config.welcomeMessage);
    const launcher = root.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    launcher.click(); expect(root.querySelector('section')!.hidden).toBe(false);
    root.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('section')!.hidden).toBe(true); expect(root.activeElement).toBe(launcher);
  });
  it('sends no credentials, bounds history, renders text and scoped citation details', async () => {
    const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fetcher = vi.fn(async (url: string | URL | Request) => response(String(url).endsWith('/config') ? config : String(url).includes('document-sources') ? { excerpt: '<img>Evidence' } :
      { answer: '<svg onload=bad>Answer', sources: [{ id: sourceId, title: '<img>Source', path: 'javascript:evil()' }] }));
    const { host } = await mountWidget(script(), fetcher);
    const root = host.shadowRoot!, input = root.querySelector('textarea')!;
    input.value = 'hello'; root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('.citation')).not.toBeNull());
    expect(root.querySelector('svg')).toBeNull(); expect(root.querySelector('a')).toBeNull();
    (root.querySelector('.citation') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.textContent).toContain('<img>Evidence'));
    expect(fetcher).toHaveBeenLastCalledWith(`https://chat.example/api/public/chatbots/${id}/document-sources/${sourceId}`, expect.objectContaining({ credentials: 'omit' }));
    const history = boundedHistory(Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'x'.repeat(2000) })));
    expect(history).toHaveLength(6); expect(history[0].content).toHaveLength(1000);
  });
  it('handles blocked configuration and failed chat without storing failed history', async () => {
    const blocked = await mountWidget(script(), vi.fn(async () => response({}, false)));
    expect(blocked.host.shadowRoot!.textContent).toContain('unavailable on this website');
    const result = await mountWidget(script(), vi.fn(async url => String(url).endsWith('/config') ? response(config) : response({}, false)));
    const root = result.host.shadowRoot!; root.querySelector('textarea')!.value = 'hello';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('Chat is unavailable. Please try again later.'));
    expect(result.history).toHaveLength(0);
  });
});
const leadConfig={enabled:true,handoffEnabled:true,formTitle:'<img>Contact us',formMessage:'Leave details',successMessage:'Request received',collectName:true,requireName:true,collectEmail:true,requireEmail:true,collectPhone:false,requirePhone:false,collectCompany:false,requireCompany:false,collectMessage:true,requireMessage:false,consentRequired:true,consentText:'I agree to follow-up'};
async function contact(fetcher?:ReturnType<typeof vi.fn>,override={}){const f=fetcher??vi.fn(async()=>response({...config,leadCapture:{...leadConfig,...override}}));const {host}=await mountWidget(script(),f);const root=host.shadowRoot!;(root.querySelector('button[aria-expanded]') as HTMLButtonElement).click();return {root,f};}
function clickText(root:ShadowRoot,text:string){(Array.from(root.querySelectorAll('button')).find(b=>b.textContent===text)!).click();}
function fill(root:ShadowRoot){(root.querySelector('#contact-name') as HTMLInputElement).value='<img>Visitor';(root.querySelector('#contact-email') as HTMLInputElement).value='lead@example.test';(root.querySelector('#contact-reason') as HTMLTextAreaElement).value='Please help';(root.querySelector('#contact-consent') as HTMLInputElement).checked=true;}
function sendContact(root:ShadowRoot){root.querySelector('form.contact')!.dispatchEvent(new Event('submit',{cancelable:true}));}
it('hides CTAs when disabled and shows explicit actions when enabled',async()=>{const disabled=await contact(undefined,{enabled:false});expect(disabled.root.textContent).not.toContain('Talk to a person');const enabled=await contact();expect(enabled.root.textContent).toContain('Talk to a person');expect(enabled.root.textContent).toContain('Contact us');});
it('renders configured fields and consent safely with required validation',async()=>{const {root,f}=await contact();clickText(root,'Talk to a person');expect(root.querySelector('#contact-phone')).toBeNull();expect(root.querySelector('#contact-name')!.hasAttribute('required')).toBe(true);expect(root.querySelector('form.contact')!.hasAttribute('novalidate')).toBe(true);expect(root.querySelector('img')).toBeNull();sendContact(root);expect(root.textContent).toContain('Enter a valid name.');expect(root.textContent).toContain('Consent is required.');expect(f).toHaveBeenCalledTimes(1);expect(root.activeElement?.id).toBe('contact-name');});
it('submits intentional handoff without history or credentials and announces success',async()=>{const f=vi.fn(async url=>response(String(url).endsWith('/config')?{...config,leadCapture:leadConfig}:{status:'accepted'}));const {root}=await contact(f);clickText(root,'Talk to a person');fill(root);sendContact(root);await vi.waitFor(()=>expect(root.textContent).toContain('Request received'));const call=f.mock.calls[1] as unknown as [string,RequestInit];const payload=JSON.parse(call[1].body as string);expect(call[0]).toMatch(/\/handoff$/);expect(call[1].credentials).toBe('omit');expect(payload).toMatchObject({source:'widget',name:'<img>Visitor',reason:'Please help',consentGiven:true});expect(payload.history).toBeUndefined();expect(payload.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);expect(root.querySelector('img')).toBeNull();expect((root.querySelector('#contact-name') as HTMLInputElement).value).toBe('');clickText(root,'Back to chat');expect(root.querySelector('form.contact')).toBeNull();expect(root.querySelector('.messages')!.hasAttribute('hidden')).toBe(false);});
it('prevents repeated click while pending and reuses frozen request on uncertain retry',async()=>{let resolve!: (v:Response)=>void;let calls=0;const f=vi.fn(async url=>{if(String(url).endsWith('/config'))return response({...config,leadCapture:leadConfig});calls++;if(calls===1)return new Promise<Response>(r=>resolve=r);return response({status:'accepted'});});const {root}=await contact(f);clickText(root,'Talk to a person');fill(root);sendContact(root);sendContact(root);expect(calls).toBe(1);resolve({...response({},false),status:503});await vi.waitFor(()=>expect(root.textContent).toContain('could not be confirmed'));sendContact(root);await vi.waitFor(()=>expect(root.textContent).toContain('Request received'));expect((f.mock.calls[1] as unknown as [string,RequestInit])[1].body).toBe((f.mock.calls[2] as unknown as [string,RequestInit])[1].body);});
it('dismisses form with Escape, clears contact values and restores CTA focus',async()=>{const {root}=await contact();clickText(root,'Talk to a person');fill(root);root.querySelector('#contact-name')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(root.querySelector('form.contact')).toBeNull();expect(root.activeElement?.textContent).toBe('Talk to a person');clickText(root,'Talk to a person');expect((root.querySelector('#contact-name') as HTMLInputElement).value).toBe('');});
it('contact form submit uses leads endpoint and never automatically sends on opening',async()=>{const f=vi.fn(async url=>response(String(url).endsWith('/config')?{...config,leadCapture:leadConfig}:{status:'accepted'}));const {root}=await contact(f);clickText(root,'Contact us');expect(f).toHaveBeenCalledTimes(1);expect(root.querySelector('#contact-reason')).toBeNull();(root.querySelector('#contact-name') as HTMLInputElement).value='Fixture';(root.querySelector('#contact-email') as HTMLInputElement).value='lead@example.test';(root.querySelector('#contact-consent') as HTMLInputElement).checked=true;sendContact(root);await vi.waitFor(()=>expect(root.textContent).toContain('Request received'));expect(String(f.mock.calls[1][0])).toMatch(/\/leads$/);});
it('validates malformed contact configuration',()=>{expect(()=>parseConfig({...config,leadCapture:{...leadConfig,formTitle:'x'.repeat(121)}},id)).toThrow();});
