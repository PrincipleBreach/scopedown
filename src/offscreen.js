// Chrome only: turns a program into Markdown with a real DOM, for the service worker.
import { build } from './render.js';

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'build' || sender.id !== chrome.runtime.id) return false;
  try {
    sendResponse(build(msg.program, { parse }));
  } catch (e) {
    sendResponse({ error: String(e?.message || e) });
  }
  return false;
});
