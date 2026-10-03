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
