import { mountWidget } from './widget';
const script = document.currentScript;
if (script instanceof HTMLScriptElement) {
  const start = () => { void mountWidget(script).catch(() => { /* Invalid embeds do not break customer pages. */ }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}
