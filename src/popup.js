import { detect, ADAPTERS, AGENT_PERMISSIONS } from './platforms/index.js';
import { build } from './render.js';

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

let result = null; // { markdown, filename, targets }

// Placeholder bars from the HTML, restored when the user retries.
const placeholders = Object.fromEntries(['name', 'sub', 'in', 'out', 'top']
  .map((id) => [id, [...$(id).childNodes].map((n) => n.cloneNode(true))]));

async function targetTab() {
  // ?tab=<id> lets the end-to-end test drive a specific tab; normal use reads the active tab.
  const id = Number(new URLSearchParams(location.search).get('tab'));
  if (id) return ext.tabs.get(id);
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// A tab that is still navigating has no URL yet, so wait for it to finish (10 s max).
function loaded(tab) {
  if (!tab || tab.status !== 'loading') return tab;
  return new Promise((resolve) => {
    const done = (t) => {
      ext.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(t);
    };
    const onUpdated = (id, info, t) => {
      if (id === tab.id && info.status === 'complete') done(t);
    };
    const timer = setTimeout(() => ext.tabs.get(tab.id).then(done, () => done(tab)), 10_000);
    ext.tabs.onUpdated.addListener(onUpdated);
    // Covers a load that finished before the listener was attached.
    ext.tabs.get(tab.id).then((t) => t.status === 'complete' && done(t), () => {});
  });
}

async function run() {
  for (const [id, nodes] of Object.entries(placeholders)) $(id).replaceChildren(...nodes.map((n) => n.cloneNode(true)));
  $('note').hidden = true;
  setState('loading');
  const tab = await loaded(await targetTab());
  const url = tab?.url || tab?.pendingUrl;
  const hit = url ? detect(url) : null;
  if (!hit) {
    return notice('unsupported', 'Open a program page', `${ADAPTERS.map((a) => a.label).join(' or ')}, public or private.`);
  }

  let injection;
  try {
    [injection] = await ext.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: hit.adapter.program.fetchInPage,
      args: hit.adapter.program.inPageArgs(hit.target),
    });
  } catch (e) {
    return notice('error', 'Could not read this tab', String(e?.message || e));
  }
  const raw = injection?.result;
  if (!raw || raw.error) {
    return notice('error', 'Could not read this program', raw?.error || 'The page returned no data. Reload it and try again.');
  }

  try {
    const program = hit.adapter.program.normalize(raw, { fetchedAt: new Date().toISOString() });
    show(program, build(program, { parse }));
  } catch (e) {
    notice('error', 'Could not format this program', String(e?.message || e));
  }
}

function show(p, out) {
  result = {
    markdown: out.markdown,
    targets: out.targets,
    filename: `${p.platform}-${safe(p.handle || p.name)}.md`,
  };

  $('name').textContent = p.name;
  $('name').title = p.name;
  // Submissions only get a mention when they are not open.
  const closed = p.status && !/^(open|in progress)$/i.test(p.status) ? cap(p.status.toLowerCase()) : null;
  $('sub').textContent = [p.platformName, p.visibility ? cap(p.visibility) : null, closed].filter(Boolean).join(' · ');
  $('note').hidden = true;
  $('in').textContent = out.inScope;
  $('out').textContent = out.outScope;
  $('top').textContent = out.topReward ? out.topReward.label : (p.bounties === false ? 'None' : '-');

  const rules = out.rules.filter((r) => r.short.mono);
  $('rules').replaceChildren(...rules.map(ruleRow));
  $('rules').hidden = !rules.length;

  $('size').textContent = `${tokens(out.markdown)} tokens`;
  $('toggle-preview').disabled = false;
  $('size').title = `${out.markdown.length.toLocaleString('en-US')} characters. The token count is an estimate.`;
  $('preview').textContent = out.markdown;

  $('copy').disabled = false;
  $('download').disabled = false;
  $('targets').disabled = !out.targets.length;
  const targetsLabel = out.targets.length ? `Copy ${out.targets.length} targets, one per line (T)` : 'No domains, URLs or IP ranges in scope';
  $('targets').title = targetsLabel;
  if (p.warnings.length) say(`${p.warnings.length} API warning(s) are noted at the top of the file.`);

  setState('ready');
  performance.mark('scopedown:ready');
  $('copy').focus();
}

function ruleRow(r) {
  const li = document.createElement('li');
  const row = document.createElement('button');
  row.className = 'row rule';
  row.title = `Copy. From the policy: ${r.lines[0].replace(/[*_`]/g, '')}`;
  const k = Object.assign(document.createElement('span'), { className: 'k', textContent: r.short.key });
  const v = Object.assign(document.createElement('span'), { className: 'v row-title', textContent: r.short.value });
  const end = Object.assign(document.createElement('span'), { className: 'row-end', textContent: 'Copy' });
  end.setAttribute('aria-hidden', 'true');
  row.append(k, v, end);
  row.addEventListener('click', () => copyText(r.short.value, row, `Copied ${r.short.key.toLowerCase()} value.`, end));
  li.append(row);
  return li;
}

function notice(state, title, text) {
  $('sub').textContent = state === 'error' ? 'Error' : 'No program here';
  $('name').textContent = title;
  $('name').title = '';
  $('note').textContent = text;
  $('note').hidden = false;
  $('rules').hidden = true;
  $('retry').hidden = state !== 'error';
  setState(state);
  if (state === 'error') $('retry').focus();
}

function setState(state) {
  $('app').dataset.state = state;
  $('app').setAttribute('aria-busy', String(state === 'loading'));
  if (state === 'loading') $('retry').hidden = true;
}

async function copyText(text, el, message, labelEl = el.querySelector('.label-text')) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash(el, labelEl, labelEl ? 'Copied' : null);
  say(message);
}

// Brief confirmation on the control itself; icon buttons only change their outline.
function flash(el, labelEl, text) {
  const before = labelEl?.textContent;
  el.classList.add('done');
  if (labelEl && text) labelEl.textContent = text;
  clearTimeout(el._flash);
  el._flash = setTimeout(() => {
    el.classList.remove('done');
    if (labelEl && text) labelEl.textContent = before;
  }, 1200);
}

function copyMarkdown() {
  if (result) copyText(result.markdown, $('copy'), 'Markdown copied.');
}

function copyTargets() {
  if (result?.targets.length) copyText(`${result.targets.join('\n')}\n`, $('targets'), `${result.targets.length} targets copied.`);
}

function download() {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: result.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  flash($('download'), $('download').querySelector('.label-text'), 'Saved');
  say(`Saved ${result.filename}.`);
}

function say(text) {
  $('status').textContent = text;
}

function tokens(text) {
  const n = Math.round(text.length / 4);
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`;
}

function togglePreview(open = $('preview-wrap').hidden) {
  $('preview-wrap').hidden = !open;
  $('toggle-preview').setAttribute('aria-expanded', String(open));
  $('toggle-preview').querySelector('.label-text').textContent = open ? 'Hide preview' : 'Preview';
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function safe(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'program';
}

// Agent access. The popup can close while Chrome shows its permission prompt, so it marks
// the intent first; the background connects as soon as the permissions land.
const AGENT_STATES = {
  connected: 'Connected',
  connecting: 'Connecting',
  host_missing: 'Install the bridge',
  disconnected: 'Waiting for the bridge',
  needs_permission: 'Needs permission',
  off: 'Off',
};

async function agentRefresh() {
  const r = await ext.runtime.sendMessage({ type: 'agent:get' }).catch(() => null);
  if (!r?.ok) return;
  const { settings, connection, waiting } = r.result;
  const state = settings.agentEnabled ? (AGENT_STATES[connection.state] || connection.state) : 'Off';
  $('agent-switch').checked = settings.agentEnabled;
  $('agent-state').textContent = waiting ? `${state} · ${waiting} to review` : state;
  $('agent-state').toggleAttribute('data-waiting', Boolean(waiting));
  $('agent-state').title = connection.error || '';
  $('agent-setup').hidden = !(settings.agentEnabled && connection.state === 'host_missing');
}

$('agent-switch').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (on) {
    const asked = ext.permissions.request(AGENT_PERMISSIONS);
    ext.runtime.sendMessage({ type: 'agent:enable', enabled: true });
    if (!(await asked)) await ext.runtime.sendMessage({ type: 'agent:enable', enabled: false });
  } else {
    await ext.runtime.sendMessage({ type: 'agent:enable', enabled: false });
  }
  agentRefresh();
  setTimeout(agentRefresh, 800);
});
$('agent-setup').addEventListener('click', () => copyText($('agent-setup-cmd').textContent, $('agent-setup'), 'Install command copied.', $('agent-setup').querySelector('.cmd-copy')));
agentRefresh();

$('copy').addEventListener('click', copyMarkdown);
$('targets').addEventListener('click', copyTargets);
$('download').addEventListener('click', download);
$('retry').addEventListener('click', run);
$('toggle-preview').addEventListener('click', () => togglePreview());

// Keys: Enter or C copies Markdown, T copies targets, D saves, P toggles the preview, R retries, Esc closes.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.key === 'Escape') return window.close();
  const inPreview = e.target === $('preview');
  const onControl = e.target instanceof HTMLButtonElement || e.target.tagName === 'A' || e.target.tagName === 'INPUT';
  const ready = $('app').dataset.state === 'ready';
  if (e.key === 'Enter' && ready && !onControl && !inPreview) {
    e.preventDefault();
    copyMarkdown();
  }
  if (inPreview) return;
  const key = e.key.toLowerCase();
  if (key === 'c' && ready) copyMarkdown();
  if (key === 't' && ready) copyTargets();
  if (key === 'd' && ready) download();
  if (key === 'p' && ready) togglePreview();
  if (key === 'r' && !$('retry').hidden) run();
});

run();
