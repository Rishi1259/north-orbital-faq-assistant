export interface Config {
  publicId: string; displayName: string; welcomeMessage: string; accentColor: string;
  launcherLabel: string; launcherPosition: 'bottom-right' | 'bottom-left';
}
export interface Message { role: 'user' | 'assistant'; content: string; }
export function parseScript(script: HTMLScriptElement) {
  const publicId = script.dataset.chatbot ?? '';
  if (!/^pub_[a-f0-9]{48}$/.test(publicId)) throw new Error('Invalid chatbot identifier.');
  const url = new URL(script.src);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid widget host.');
  return { publicId, origin: url.origin };
}
export function parseConfig(value: unknown, publicId: string): Config {
  const c = value as Config;
  if (!c || c.publicId !== publicId || typeof c.displayName !== 'string' || c.displayName.length < 1 || c.displayName.length > 80 ||
    typeof c.welcomeMessage !== 'string' || c.welcomeMessage.length > 500 || typeof c.launcherLabel !== 'string' ||
    c.launcherLabel.length < 1 || c.launcherLabel.length > 40 || !/^#[a-f0-9]{6}$/i.test(c.accentColor) ||
    !['bottom-left', 'bottom-right'].includes(c.launcherPosition)) throw new Error('Invalid widget configuration.');
  return c;
}
export const boundedHistory = (messages: Message[]) => messages.slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
export async function mountWidget(script: HTMLScriptElement, fetcher: typeof fetch = fetch) {
  const { publicId, origin } = parseScript(script);
  const base = `${origin}/api/public/chatbots/${publicId}`;
  const host = element('div');
  host.style.setProperty('all', 'initial');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  async function api(path: string, body?: unknown) {
    const response = await fetcher(`${base}${path}`, { method: body ? 'POST' : 'GET', credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(110000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Please wait a moment before trying again.' : 'Chat is unavailable. Please try again later.');
    return response.json();
  }
  const style = element('style');
  style.textContent = `:host{all:initial;font-family:system-ui,sans-serif;color:#182230}*{box-sizing:border-box}
    .wrap{position:fixed;bottom:20px;right:20px;z-index:2147483000;font:15px/1.5 system-ui,sans-serif}
    button,textarea{font:inherit}button{cursor:pointer;border:0;border-radius:12px;padding:10px 16px;background:var(--accent,#2563EB);color:white}
    button:focus-visible,textarea:focus-visible{outline:3px solid #111;outline-offset:3px}button:disabled{opacity:.6;cursor:wait}
    .panel{width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100dvh - 110px);background:white;border:1px solid #d0d5dd;border-radius:16px;box-shadow:0 8px 40px #0003;display:flex;flex-direction:column;margin-bottom:12px;overflow:hidden}
    [hidden]{display:none!important}header{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #eee}h2{font-size:17px;margin:0}
    .messages{flex:1;overflow:auto;padding:14px;overscroll-behavior:contain}.message{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:#f2f4f7;border-radius:10px;margin:0 0 12px}.user{background:#e8efff}
    .citation{display:block;background:transparent;color:#174ea6;text-align:left;padding:4px;text-decoration:underline}
    form{padding:12px;display:flex;gap:8px;border-top:1px solid #eee}textarea{resize:none;min-width:0;width:100%;border:1px solid #aaa;border-radius:8px;padding:8px;color:#182230;background:white}
    .error{max-width:300px;padding:12px;background:white;color:#182230;border:1px solid #ddd}
    @media(max-width:480px){.wrap{bottom:12px;right:12px}.panel{width:calc(100vw - 24px)}}`;
  shadow.append(style);
  const wrap = element('div'); wrap.className = 'wrap'; shadow.append(wrap);
  let config: Config;
  try { config = parseConfig(await api('/config'), publicId); }
  catch { const error = element('p', 'Chat is unavailable on this website.'); error.className = 'error'; error.setAttribute('role', 'status'); wrap.append(error); return { host }; }
  wrap.style.setProperty('--accent', config.accentColor);
  if (config.launcherPosition === 'bottom-left') { wrap.style.left = '12px'; wrap.style.right = 'auto'; }
  const launcher = element('button', config.launcherLabel); launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'north-orbital-chat-panel');
  const panel = element('section'); panel.id = 'north-orbital-chat-panel'; panel.className = 'panel'; panel.hidden = true;
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', config.displayName);
  const header = element('header'); header.append(element('h2', config.displayName));
  const close = element('button', '×'); close.setAttribute('aria-label', 'Close chat'); header.append(close);
  const messages = element('div'); messages.className = 'messages'; messages.setAttribute('role', 'log'); messages.setAttribute('aria-live', 'polite'); messages.setAttribute('aria-label', 'Conversation');
  const form = element('form'); const input = element('textarea'); input.maxLength = 1000; input.rows = 2; input.placeholder = 'Ask a question'; input.setAttribute('aria-label', 'Your message');
  const send = element('button', 'Send'); send.type = 'submit'; form.append(input, send); panel.append(header, messages, form); wrap.append(panel, launcher);
  const history: Message[] = [];
  function render(role: string, text: string) { const p = element('p', text); p.className = `message ${role === 'user' ? 'user' : 'assistant'}`; messages.append(p); messages.scrollTop = messages.scrollHeight; return p; }
  render('assistant', config.welcomeMessage);
  function toggle(open: boolean) { panel.hidden = !open; launcher.setAttribute('aria-expanded', String(open)); (open ? input : launcher).focus(); }
  launcher.onclick = () => toggle(panel.hidden === true); close.onclick = () => toggle(false);
  shadow.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') toggle(false); });
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async event => {
    event.preventDefault(); const message = input.value.trim(); if (!message || send.disabled) return;
    const previous = boundedHistory(history); render('user', message); input.value = ''; send.disabled = true;
    try {
      const response = await api('/chat', { message, history: previous });
      if (typeof response.answer !== 'string' || response.answer.length > 2000 || !Array.isArray(response.sources)) throw new Error('Chat is unavailable. Please try again later.');
      render('assistant', response.answer);
      history.push({ role: 'user', content: message }, { role: 'assistant', content: response.answer });
      history.splice(0, Math.max(0, history.length - 6));
      for (const source of response.sources.slice(0, 8)) {
        if (!/^[0-9a-f-]{36}$/i.test(source.id) || typeof source.title !== 'string') continue;
        // Construct the source endpoint ourselves; never navigate model-provided URLs.
        const cite = element('button', `${source.title.slice(0, 200)}${typeof source.location === 'string' ? ` — ${source.location.slice(0, 200)}` : ''}`);
        cite.className = 'citation'; cite.setAttribute('aria-label', `View source: ${source.title.slice(0, 200)}`);
        cite.onclick = async () => {
          cite.disabled = true;
          try { const detail = await api(`/document-sources/${source.id}`); if (typeof detail.excerpt !== 'string') throw new Error(); render('assistant', detail.excerpt.slice(0, 1500)); }
          catch { render('assistant', 'This source is currently unavailable.'); }
          finally { cite.disabled = false; }
        };
        messages.append(cite);
      }
      // Keep both memory and DOM bounded on long-running customer pages.
      while (messages.children.length > 80) messages.firstElementChild?.remove();
    } catch (error) { render('assistant', error instanceof Error && error.message.startsWith('Please wait') ? error.message : 'Chat is unavailable. Please try again later.'); }
    finally { send.disabled = false; input.focus(); }
  };
  return { host, toggle, history };
}
