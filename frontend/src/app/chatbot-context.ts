// Set a public identifier through <meta name="north-orbital-chatbot" content="pub_...">.
// Public IDs are not secrets. No internal tenant UUIDs are needed by the demo.
export function publicChatbotId(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="north-orbital-chatbot"]')?.content ?? '';
}

export function publicApiOrigin(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="north-orbital-api-origin"]')?.content;
  if (!configured) return '';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== configured) throw new Error('Invalid API origin');
  return url.origin;
}
