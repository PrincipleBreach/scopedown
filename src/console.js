// ScopeDown agent console: review drafts, see what agents did, set what they may do.
// Hash routes: #/drafts, #/drafts/<id>, #/scope, #/activity, #/settings.

import { h, $, ago, bytes, when } from './ui/dom.js';
import { icon, arrow } from './ui/icons.js';
import { renderMarkdown } from './ui/markdown.js';
import { dialog, toast } from './ui/overlay.js';
import { ADAPTERS, getAdapter, AGENT_PERMISSIONS } from './platforms/index.js';

const ext = globalThis.browser ?? globalThis.chrome;
const label = (id) => getAdapter(id)?.label || id;
const STATUS = {
  pending_review: { label: 'Waiting', tone: 'waiting', stamp: 'Awaiting review' },
  submitting: { label: 'Filing', tone: 'quiet', stamp: 'Filing' },
  submitted: { label: 'Filed', tone: 'done', stamp: 'Filed', stampTone: 'red' },
  rejected: { label: 'Rejected', tone: 'quiet', stamp: 'Rejected', stampTone: 'quiet' },
  handed_off: { label: 'On platform', tone: 'quiet', stamp: 'On platform', stampTone: 'quiet' },
  failed: { label: 'Failed', tone: 'bad', stamp: 'Not filed' },
};
const FILTERS = {
  all: { label: 'All', test: () => true },
  waiting: { label: 'Waiting', test: (d) => d.status === 'pending_review' || d.status === 'submitting' },
  filed: { label: 'Filed', test: (d) => d.status === 'submitted' || d.status === 'handed_off' },
  attention: { label: 'Needs attention', test: (d) => d.status === 'failed' || d.status === 'rejected' },
};
const CONNECTION = {
  connected: ['Connected', 'waiting'],
  connecting: ['Connecting', 'quiet'],
  disconnected: ['Reconnecting', 'quiet'],
  host_missing: ['Bridge not installed', 'bad'],
  needs_permission: ['Needs permission', 'bad'],
  off: ['Agents off', 'quiet'],
};
const EDITABLE = ['pending_review', 'rejected', 'failed'];
const PAGE = 20;

let drafts = [];
let agent = null;
let editing = null; // draft id with unsaved edits open

async function call(type, payload = {}) {
  const r = await ext.runtime.sendMessage({ type, ...payload });
  if (!r?.ok) throw new Error(r?.error || 'The extension did not answer.');
  return r.result;
}

// ---------------------------------------------------------------- small pieces

function status(s) {
  const st = STATUS[s] || { label: s, tone: 'quiet' };
  return h('span', { class: 'status', dataset: { tone: st.tone } }, st.label);
}

function stamp(s) {
  const st = STATUS[s] || { stamp: s };
  return h('span', { class: 'stamp', dataset: { tone: st.stampTone || '' }, text: st.stamp });
}

function severity(level) {
  const n = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }[level] ?? 0;
  return h('span', { class: 'sev', dataset: { level } }, h('i', { 'aria-hidden': 'true' }, [1, 2, 3, 4].map((k) => h('b', { class: k <= n ? 'on' : '' }))), level || 'none');
}

function pageHead({ eyebrow, title, lede, side }) {
  return h('header', { class: 'page-head arrive' },
    h('p', { class: 'eyebrow', text: eyebrow }),
    h('div', { class: 'page-head-row' }, h('h1', { text: title }), side || null),
    lede ? h('p', { class: 'lede', text: lede }) : null);
}

function command(text) {
  const b = h('button', { class: 'cmd', type: 'button', title: 'Copy' }, h('code', { text }), h('span', { class: 'cmd-copy', text: 'Copy' }));
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    flash(b.querySelector('.cmd-copy'), 'Copied');
  });
  return b;
}

function flash(el, text) {
  const before = el.textContent;
  el.textContent = text;
  el.closest('.row')?.classList.add('done');
  clearTimeout(el._flash);
  el._flash = setTimeout(() => {
    el.textContent = before;
    el.closest('.row')?.classList.remove('done');
  }, 1400);
}

function button(text, fn, { kind = 'action', go, small = false, type = 'button' } = {}) {
  const cls = kind === 'link' ? 'link' : `action${kind === 'outline' ? ' action--outline' : kind === 'quiet' ? ' action--quiet' : ''}${small ? ' action--sm' : ' action--block'}`;
  const b = h('button', { class: cls, type }, kind === 'link' ? h('span', { text }) : text, go ? arrow(go) : null);
  if (fn) b.addEventListener('click', () => busy(b, fn));
  return b;
}

function linkOut(text, href, { kind = 'action' } = {}) {
  const cls = kind === 'link' ? 'link' : `action action--block${kind === 'outline' ? ' action--outline' : ''}`;
  return h('a', { class: cls, href, target: '_blank', rel: 'noopener' }, kind === 'link' ? h('span', { text }) : text, arrow('out'));
}

async function busy(el, fn) {
  el.disabled = true;
  el.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } catch (e) {
    toast(e.message, { tone: 'error' });
    return null;
  } finally {
    el.disabled = false;
    el.removeAttribute('aria-busy');
  }
}

// ---------------------------------------------------------------- data and routing

async function load() {
  [drafts, agent] = await Promise.all([call('drafts:list'), call('agent:get')]);
  const waiting = drafts.filter((d) => d.status === 'pending_review').length;
  $('#count').hidden = !waiting;
  $('#count').textContent = String(waiting);
  $('#count').setAttribute('aria-label', `${waiting} waiting`);
  const state = agent.settings.agentEnabled ? agent.connection.state : 'off';
  const [text, tone] = CONNECTION[state] || [state, 'quiet'];
  const conn = $('#conn');
  conn.dataset.state = state;
  conn.dataset.tone = tone;
  conn.textContent = text;
  conn.title = agent.connection.error || 'Agent connection';
}

function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, params: new URLSearchParams(query) };
}

let lastPath = null;
async function render() {
  await load();
  const { parts, params } = route();
  const tab = parts[0] || 'drafts';
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  let content;
  if (tab === 'drafts' && parts[1]) content = await draftView(parts[1]);
  else if (tab === 'scope') content = await scopeView(params);
  else if (tab === 'activity') content = await activityView(params);
  else if (tab === 'settings') content = await settingsView();
  else content = draftsView(params);
  const view = $('#view');
  // Arrival plays on navigation only, not on the live refreshes that follow.
  const path = location.hash;
  if (path === lastPath) for (const el of content.querySelectorAll('.arrive')) el.classList.remove('arrive');
  lastPath = path;
  view.replaceChildren(content);
  if (tab === 'settings' && params.get('focus')) document.getElementById(params.get('focus'))?.scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------- drafts

function draftsView(params) {
  const filter = FILTERS[params.get('filter')] ? params.get('filter') : 'all';
  const list = drafts.filter(FILTERS[filter].test);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const shown = list.slice((page - 1) * PAGE, page * PAGE);
  const ready = agent.settings.agentEnabled && agent.connection.state === 'connected';
  const waiting = drafts.filter((d) => d.status === 'pending_review').length;

  const head = pageHead({
    eyebrow: waiting ? `${waiting} waiting for you` : 'Agent console',
    title: 'Drafts',
    lede: 'Reports your agents drafted. You decide what gets filed.',
  });
  const filters = h('nav', { class: 'filters', 'aria-label': 'Filter drafts' }, Object.entries(FILTERS).map(([key, f]) => h('a', {
    href: `#/drafts?filter=${key}`,
    'aria-current': String(key === filter),
  }, f.label, h('span', { class: 'n', text: String(drafts.filter(f.test).length) }))));

  if (!drafts.length) {
    return h('div', {}, head, ready
      ? h('div', { class: 'region-empty' }, h('div', {}, h('h2', { text: 'No drafts yet' }), h('p', { text: 'When an agent calls draft_report, the report shows up here.' })))
      : setupSection());
  }
  if (!list.length) {
    return h('div', {}, head, filters, h('div', { class: 'region-empty', style: 'margin-top:16px' },
      h('div', {}, h('h2', { text: `Nothing in ${FILTERS[filter].label.toLowerCase()}` })),
      h('a', { class: 'link', href: '#/drafts' }, h('span', { text: 'All drafts' }), arrow('next'))));
  }

  const rows = h('ul', { class: 'rows drafts', style: 'margin-top:16px' }, shown.map((d) => h('li', {}, h('a', { class: 'row', href: `#/drafts/${d.id}` },
    h('div', { class: 'key' }, status(d.status), h('span', { class: 'where', text: `${label(d.platform)} · ${d.handle}` })),
    h('div', { class: 'row-title' }, h('strong', { text: d.title }), h('span', { text: [d.asset?.identifier, d.source].filter(Boolean).join(' · ') })),
    h('span', { class: 'hide-sm' }, severity(d.severity)),
    h('span', { class: 'when hide-sm', title: when(d.updated_at), text: ago(d.updated_at) }),
    arrow('next'),
  ))));
  const pages = Math.ceil(list.length / PAGE);
  const link = (p) => `#/drafts?filter=${filter}&page=${p}`;
  const pager = pages > 1 ? h('div', { class: 'pager' },
    h('span', { text: `${(page - 1) * PAGE + 1} to ${Math.min(page * PAGE, list.length)} of ${list.length}` }),
    h('nav', { 'aria-label': 'Pages' },
      h('a', { class: 'link', href: link(page - 1), 'aria-disabled': String(page <= 1), hidden: page <= 1 }, arrow('back'), h('span', { text: 'Newer' })),
      h('a', { class: 'link', href: link(page + 1), hidden: page >= pages }, h('span', { text: 'Older' }), arrow('next')))) : null;
  return h('div', {}, head, filters, rows, pager);
}

async function draftView(id) {
  const d = drafts.find((x) => x.id === id);
  const back = h('a', { class: 'link link--muted back', href: '#/drafts' }, arrow('back'), h('span', { text: 'Drafts' }));
  if (!d) {
    return h('div', {}, back, h('div', { class: 'region-empty' }, h('div', {}, h('h2', { text: 'Draft not found' }), h('p', { text: 'It may have been deleted.' }))));
  }
  const editable = EDITABLE.includes(d.status);
  return h('div', {}, back,
    h('div', { class: 'detail arrive' },
      h('div', { class: 'sheet-wrap' }, h('div', { class: 'sheet-stack', 'aria-hidden': 'true' }), sheet(d, editable)),
      rail(d, editable)));
}

// A program called like its platform ("HackerOne" on HackerOne) reads better by handle.
function programLabel(d) {
  const name = d.program?.name || d.handle;
  return name === label(d.platform) ? d.handle : name;
}

function attachmentChip(d) {
  return (name) => {
    const a = (d.attachments || []).find((x) => x.name === name);
    if (!a) return h('code', { text: `{{attachment:${name}}}` });
    const chip = h('a', { class: 'chip', href: '#', title: `Open ${name}` }, icon('clip', { size: 12 }), name);
    chip.addEventListener('click', (e) => { e.preventDefault(); openFile(a); });
    return chip;
  };
}

// The draft as a report sheet. Edit mode keeps the sheet and puts fields in place.
function sheet(d, editable) {
  const head = h('header', { class: 'sheet-head' },
    h('span', { class: 'label', text: `${label(d.platform)} · ${programLabel(d)} · ${d.id}` }),
    stamp(d.status));
  if (editing === d.id && editable) return h('article', { class: 'sheet', 'aria-label': 'Edit draft' }, head, editForm(d));

  const row = (k, v) => (v ? [h('dt', { text: k }), h('dd', {}, v)] : []);
  const unset = h('span', { class: 'unset', text: 'Not set' });
  const md = (text) => renderMarkdown(text, { attachment: attachmentChip(d) });
  return h('article', { class: 'sheet' }, head,
    h('h1', { class: 'sheet-title', text: d.title }),
    h('dl', { class: 'ledger' },
      row('Program', d.program?.url ? h('a', { class: 'inline-link', href: d.program.url, target: '_blank', rel: 'noopener', text: d.program.name || d.handle }) : d.handle),
      row('Asset', d.asset?.identifier ? h('span', { class: 'mono', text: d.asset.identifier }) : unset),
      row(getAdapter(d.platform)?.weaknessLabel || 'Weakness', d.weakness ? h('span', {}, d.weakness.name, d.weakness.priority ? h('span', { class: 'muted mono', text: `  P${d.weakness.priority}` }) : null) : unset.cloneNode(true)),
      row('Severity', severity(d.severity)),
      row('CVSS', d.cvss_vector ? h('span', { class: 'mono', text: d.cvss_vector }) : null),
      row('URL', d.url ? h('span', { class: 'mono', text: d.url }) : null),
      row('Request', d.http_request ? h('pre', { text: d.http_request }) : null),
      (d.custom_fields || []).map((cf) => row(cf.label, cf.value === true ? 'Yes' : cf.value === false ? 'No' : String(cf.value))),
      row('Agent', h('span', {}, d.source, h('span', { class: 'muted', text: ` · ${when(d.created_at)}` }))),
      row('Report', d.report?.url ? h('a', { class: 'inline-link mono', href: d.report.url, target: '_blank', rel: 'noopener', text: d.report.id ? `#${d.report.id}` : 'Open' }) : null)),
    h('section', { class: 'sheet-block' }, h('h2', { class: 'label', text: 'Description' }), md(d.description)),
    h('section', { class: 'sheet-block' }, h('h2', { class: 'label', text: 'Impact' }), md(d.impact)));
}

function editForm(d) {
  const title = h('textarea', { class: 'input edit-title', rows: '2', maxlength: '150', 'aria-label': 'Title' });
  title.value = d.title;
  const sev = h('select', { class: 'input', 'aria-label': 'Severity', style: 'width:auto' }, ['none', 'low', 'medium', 'high', 'critical'].map((v) => h('option', { value: v, selected: v === d.severity, text: v[0].toUpperCase() + v.slice(1) })));
  const desc = h('textarea', { class: 'input', rows: '20', 'aria-label': 'Description' });
  desc.value = d.description;
  const impact = h('textarea', { class: 'input', rows: '6', 'aria-label': 'Impact' });
  impact.value = d.impact;
  const save = h('button', { class: 'action action--sm', type: 'submit' }, 'Save changes');
  const cancel = h('button', { class: 'action action--quiet action--sm', type: 'button', onClick: () => { editing = null; render(); } }, 'Cancel');
  const field = (name, el) => h('label', { class: 'field' }, h('span', { class: 'label', text: name }), el);
  const form = h('form', { class: 'edit-form' },
    field('Title', title), field('Severity', sev), field('Description', desc), field('Impact', impact),
    h('div', { class: 'edit-foot' }, h('span', {}, 'Markdown. Embed a file with ', h('code', { text: '{{attachment:name}}' }), '.'), h('span', { class: 'buttons' }, cancel, save)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, async () => {
      await call('draft:save', { id: d.id, fields: { title: title.value.replace(/\s*\n\s*/g, ' '), severity: sev.value, description: desc.value, impact: impact.value } });
      editing = null;
      toast('Changes saved.');
      await render();
    });
  });
  setTimeout(() => title.focus(), 0);
  return form;
}

// What happens next, and the controls for it.
function rail(d, editable) {
  const adapter = getAdapter(d.platform);
  const platform = label(d.platform);
  const direct = d.mode?.filing === 'direct' && Boolean(adapter?.agent.file);
  const files = (d.attachments || []).length;

  const say = {
    pending_review: direct
      ? ['Waiting for you. ', `Submit report files it on ${platform} under your account${files ? `, with ${files} file${files > 1 ? 's' : ''}` : ''}.`]
      // mode.note is written for the agent, so the user gets the platform's own finishing line.
      : [`Finished in ${platform}'s form. `, adapter?.agent.prefill ? `ScopeDown fills it in a new tab. ${adapter.agent.prefill.finish}` : 'ScopeDown opens the form and lists each field to paste.'],
    submitting: [`Filing on ${platform}. `, 'This takes a few seconds.'],
    submitted: [`Filed ${ago(d.updated_at)}`, d.report?.id ? ` as report #${d.report.id}.` : '.'],
    rejected: ['You rejected it. ', d.review_note ? `Your note: ${d.review_note}` : 'The agent can revise it with update_draft.'],
    handed_off: handedOff(d, platform),
    failed: ['Filing failed. ', d.error || ''],
  }[d.status] || [''];
  const stateLine = h('div', { class: 'state-line', dataset: { tone: d.status === 'failed' ? 'bad' : '' } }, status(d.status), h('p', {}, h('strong', { text: say[0] }), say.slice(1).join('')));

  const primary = [];
  if (d.status === 'submitted' && d.report?.url) primary.push(linkOut('View report', d.report.url));
  const openForm = (kind) => button(`Open ${platform} form`, async () => {
    // Where ScopeDown fills the form itself, the clipboard is left alone.
    if (!adapter?.agent.prefill) await copyAll(d, { quiet: true });
    await call('draft:handoff', { id: d.id });
    toast(adapter?.agent.prefill
      ? `Opening ${platform}'s form. ScopeDown fills it in. ${adapter.agent.prefill.finish}`
      : `Opened ${platform}'s form. Every field is on your clipboard, and listed here one by one.`);
  }, { kind, go: 'out' });
  if (d.status === 'handed_off') primary.push(openForm('outline'));
  if (['pending_review', 'failed'].includes(d.status)) {
    if (direct) primary.push(button(d.status === 'failed' ? 'Retry submit' : 'Submit report', () => submit(d), { go: 'next' }));
    primary.push(openForm(direct ? 'outline' : 'action'));
  }

  const text = [];
  if (editable && editing !== d.id) text.push(button('Edit', () => { editing = d.id; render(); }, { kind: 'link' }));
  if (['pending_review', 'failed'].includes(d.status)) text.push(button('Reject', () => reject(d), { kind: 'link' }));
  if (d.status !== 'submitting') text.push(button('Delete', () => remove(d), { kind: 'link' }));
  for (const t of text) t.classList.add('link--muted');

  const showFields = d.status === 'handed_off' || (!direct && ['pending_review', 'failed'].includes(d.status));
  return h('aside', { class: 'rail', 'aria-label': 'Review' },
    h('section', { class: 'rail-block lead' }, stateLine,
      primary.length ? h('div', { class: 'rail-actions' }, primary) : null,
      text.length ? h('div', { class: 'text-actions' }, text) : null),
    showFields ? fieldsBlock(d) : null,
    filesBlock(d, editable),
    historyBlock(d));
}

// What the hand-off left for the hunter: filled fields, anything to do by hand, the last steps.
function handedOff(d, platform) {
  const p = d.prefill;
  const prefill = getAdapter(d.platform)?.agent.prefill;
  const last = `${prefill?.finish || ''} ${platform} keeps it as a draft until you do; ScopeDown marks it filed once it shows up in your reports.`;
  if (!prefill) return ['Opened in the form. ', `Paste each field below into ${platform}'s form. It is marked filed once it shows up in your ${platform} reports.`];
  if (!p) return [`Filling ${platform}'s form in the new tab. `, last];
  if (p.error) return ['ScopeDown could not fill the form. ', `${p.error} Paste each field below instead.`];
  const missed = p.missed.length ? ` By hand: ${p.missed.join('; ')}.` : '';
  return [`Filled: ${p.filled.join(', ')}.`, `${missed} ${last}`];
}

// The platform form's fields in its own order, one click each.
function fieldsBlock(d) {
  const fields = getAdapter(d.platform)?.agent.formFields(d) || [];
  const all = h('button', { class: 'link link--muted', type: 'button' }, h('span', { text: 'Copy all' }));
  all.addEventListener('click', () => copyAll(d));
  return h('section', { class: 'rail-block' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('h2', { class: 'label', text: `${label(d.platform)} form` }), all),
    h('ul', { class: 'rows fields' }, fields.map(([k, v]) => {
      const end = h('span', { class: 'row-end', text: 'Copy' });
      const b = h('button', { class: 'row', type: 'button', title: `Copy ${k}` }, h('span', { class: 'row-title' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: String(v).split('\n').find((l) => l.trim() && !/^\s*#{1,6}\s/.test(l)) || '' })), end);
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(String(v));
        flash(end, 'Copied');
      });
      return h('li', {}, b);
    })));
}

async function copyAll(d, { quiet = false } = {}) {
  const fields = getAdapter(d.platform)?.agent.formFields(d) || [];
  await navigator.clipboard.writeText(fields.map(([k, v]) => `${k}:\n${v}`).join('\n\n'));
  if (!quiet) toast(`Copied ${fields.length} fields in ${label(d.platform)}'s order.`);
}

function filesBlock(d, editable) {
  const files = d.attachments || [];
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', async () => {
    for (const file of picker.files) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        await call('file:add', { id: d.id, name: file.name, base64: btoa(s) });
        toast(`Attached ${file.name}.`);
      } catch (e) {
        toast(e.message, { tone: 'error' });
      }
    }
    render();
  });
  const add = editable && files.length < 10 ? h('button', { class: 'link link--muted', type: 'button' }, h('span', { text: 'Add file' })) : null;
  add?.addEventListener('click', () => picker.click());

  const list = files.length ? h('ul', { class: 'rows files' }, files.map((a) => {
    const image = /^image\/(png|jpeg|gif|webp)$/.test(a.type);
    const thumb = h('span', { class: 'thumb' }, icon(image ? 'image' : 'file'));
    if (image) call('file:get', { fileId: a.id }).then((f) => thumb.replaceChildren(h('img', { src: `data:${f.type};base64,${f.base64}`, alt: '' }))).catch(() => {});
    const open = h('button', { class: 'link link--muted', type: 'button', 'aria-label': `Open ${a.name}` }, h('span', { text: 'Open' }));
    open.addEventListener('click', () => openFile(a));
    const rm = editable ? h('button', { class: 'link link--muted', type: 'button', 'aria-label': `Remove ${a.name}` }, h('span', { text: 'Remove' })) : null;
    rm?.addEventListener('click', async () => {
      const r = await dialog({ title: `Remove ${a.name}?`, body: 'It will not be attached when the report is filed.', confirm: 'Remove', tone: 'danger' });
      if (r.action !== 'confirm') return;
      await call('file:remove', { id: d.id, fileId: a.id });
      toast(`Removed ${a.name}.`);
      render();
    });
    return h('li', { class: 'file' }, thumb,
      h('div', { class: 'file-name' }, h('strong', { text: a.name, title: a.name }), h('span', { text: `${bytes(a.size)} · ${a.added_by === 'user' ? 'you' : a.added_by}` })),
      h('span', { class: 'file-actions' }, open, rm));
  })) : null;

  return h('section', { class: 'rail-block' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('h2', { class: 'label', text: files.length ? `Evidence · ${files.length}` : 'Evidence' }), add, picker),
    list || h('p', { class: 'rail-hint', text: 'No files. Images, video, logs, HAR, PDF or ZIP, up to 20 MB each.' }));
}

function historyBlock(d) {
  const names = { created: 'Drafted', edited: 'Edited', submitting: 'Filing started', submitted: 'Filed', rejected: 'Rejected', handed_off: 'Opened in the form', prefilled: 'Filled the form', 'prefill failed': 'Could not fill the form', failed: 'Filing failed' };
  return h('section', { class: 'rail-block' }, h('h2', { class: 'label', text: 'History' }),
    h('ol', { class: 'history' }, [...d.history].reverse().slice(0, 12).map((e) => h('li', {},
      h('time', { datetime: e.at, title: when(e.at), text: ago(e.at) }),
      h('span', {}, names[e.event] || e.event[0].toUpperCase() + e.event.slice(1), h('span', { class: 'by', text: ` · ${e.by === 'user' ? 'you' : e.by}` }))))));
}

async function openFile(a) {
  const f = await call('file:get', { fileId: a.id });
  const bin = atob(f.base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  // Agent-supplied HTML or SVG is downloaded, never rendered in the extension's origin.
  const safe = /^(image\/(png|jpeg|gif|webp)|video\/|text\/plain|application\/(pdf|json))/.test(f.type);
  const url = URL.createObjectURL(new Blob([buf], { type: safe ? f.type : 'application/octet-stream' }));
  const link = h('a', { href: url, target: safe ? '_blank' : null, download: safe ? null : f.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function submit(d) {
  const files = (d.attachments || []).length;
  const r = await dialog({
    title: `Submit to ${programLabel(d)}?`,
    body: h('div', { style: 'display:grid;gap:16px' }, h('p', { text: `${label(d.platform)} receives the report as shown, under your account.` }),
      h('dl', { class: 'ledger', style: '--ledger-key:72px' },
        h('dt', { text: 'Asset' }), h('dd', { class: 'mono', text: d.asset?.identifier || 'None' }),
        h('dt', { text: 'Severity' }), h('dd', {}, severity(d.severity)),
        h('dt', { text: 'Files' }), h('dd', { text: files ? `${files} attached` : 'None' }))),
    confirm: 'Submit report',
  });
  if (r.action !== 'confirm') return;
  const out = await call('draft:submit', { id: d.id, reviewed: d.updated_at });
  if (out.status === 'submitted') toast('Report filed.', { action: out.report?.url ? { label: 'View', run: () => window.open(out.report.url, '_blank', 'noopener') } : null });
  else toast(out.error || 'Filing failed.', { tone: 'error' });
  await render();
}

async function reject(d) {
  const r = await dialog({ title: 'Reject this draft?', body: 'The agent reads your note through get_draft and can revise the draft.', confirm: 'Reject', fields: [{ name: 'note', label: 'Note for the agent', multiline: true, placeholder: 'What has to change before this can be filed?' }] });
  if (r.action !== 'confirm') return;
  await call('draft:reject', { id: d.id, note: r.note });
  toast('Draft rejected. The agent can revise it.');
  await render();
}

async function remove(d) {
  const r = await dialog({ title: 'Delete this draft?', body: 'It is removed from ScopeDown with its files. Nothing on the platform changes.', confirm: 'Delete draft', tone: 'danger' });
  if (r.action !== 'confirm') return;
  await call('draft:delete', { id: d.id });
  toast('Draft deleted.');
  location.hash = '#/drafts';
}

// ---------------------------------------------------------------- scope

const SCOPE_KINDS = {
  new: { label: 'New', kinds: ['added', 'program_added'] },
  changed: { label: 'Changed', kinds: ['changed'] },
  removed: { label: 'Removed', kinds: ['removed', 'program_removed'] },
  all: { label: 'All', kinds: null },
};
const PERIODS = { '24h': ['Last 24 hours', 1], '7d': ['Last 7 days', 7], '30d': ['Last 30 days', 30], '90d': ['Last 90 days', 90] };
const ASSET_TYPES = { web: 'Web', wildcard: 'Wildcard', api: 'API', network: 'IPs and ranges', android: 'Android', ios: 'iOS', executable: 'Executable', source_code: 'Source code', hardware: 'Hardware', iot: 'IoT', cloud: 'Cloud', blockchain: 'Blockchain', ai_model: 'AI model', other: 'Other' };
const CHANGE_WORD = {
  added: ['New', 'waiting'], changed: ['Changed', 'quiet'], removed: ['Removed', 'quiet'],
  program_added: ['New program', 'waiting'], program_removed: ['Gone', 'quiet'],
};
const FIELD_NAMES = { in_scope: 'In scope', bounty: 'Bounty', max_severity: 'Max severity', group: 'Group', reward: 'Reward', type: 'Type', location: 'Location', asset: 'Name' };
const PROGRAMS_PER_PAGE = 20;
const ROWS_PER_PROGRAM = 8;
const COPYABLE = new Set(['web', 'wildcard', 'api', 'network']);
let scopePoll = null;

// The page's filters live in the hash, so a view can be bookmarked and the back button works.
function scopeLink(params, change = {}) {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(change)) {
    if (v == null || v === '') next.delete(k);
    else next.set(k, v);
  }
  if (!('page' in change)) next.delete('page');
  const q = next.toString();
  return `#/scope${q ? `?${q}` : ''}`;
}

function scopeStatusLine(st) {
  const running = st.state === 'running';
  const platforms = Object.entries(st.platforms);
  const parts = platforms.map(([id, p]) => {
    if (running && p.stage && p.stage !== 'done' && p.stage !== 'failed') {
      const [n, of] = p.stage === 'reading' ? [p.read, p.to_read] : [p.checked, p.programs];
      return `${label(id)} ${p.stage} ${n} of ${of}`;
    }
    return p.programs ? `${p.programs} ${label(id)}` : null;
  }).filter(Boolean);
  // Only a check that read everything counts as checked.
  const last = platforms.map(([, p]) => p.last_complete_at).filter(Boolean).sort().at(-1);
  const errors = running ? [] : platforms.filter(([, p]) => p.errors?.length).map(([id, p]) => `${label(id)}: ${p.errors[0]}${p.errors.length > 1 ? ` (and ${p.errors.length - 1} more)` : ''}`);
  let word = ['Not checked yet', 'quiet'];
  if (running) word = ['Checking', 'waiting'];
  else if (last) word = [`Checked ${ago(last)}`, 'quiet'];
  else if (st.finished_at) word = ['Check failed', 'bad'];
  return h('div', { class: 'scope-state', id: 'scope-state', 'aria-live': 'polite' },
    h('span', { class: 'status', dataset: { tone: word[1] }, text: word[0] }),
    parts.length ? h('span', { class: 'scope-state-text', text: running ? parts.join(' · ') : `${parts.join(', ')} programs` }) : null,
    errors.length ? h('span', { class: 'scope-state-text bad', text: errors.join(' ') }) : null);
}

async function checkNow(btn) {
  await busy(btn, async () => {
    await call('scope:check');
    await new Promise((r) => setTimeout(r, 400));
  });
  render();
}

function watchScope() {
  clearTimeout(scopePoll);
  scopePoll = setTimeout(async () => {
    if (route().parts[0] !== 'scope') return;
    const st = await call('scope:status').catch(() => null);
    if (!st) return;
    if (st.state === 'running') {
      document.getElementById('scope-state')?.replaceWith(scopeStatusLine(st));
      watchScope();
    } else render();
  }, 2000);
}

function changeText(e) {
  if (e.kind === 'program_added') return e.assets ? `${e.assets} assets` : 'New to you';
  if (e.kind === 'program_removed') return 'You can no longer submit here';
  if (e.kind !== 'changed') return [e.asset_type, e.group, e.reward].filter(Boolean).join(' · ');
  const yes = (v) => (v === true ? 'yes' : v === false ? 'no' : v ?? 'none');
  return Object.entries(e.changes || {}).map(([k, v]) => (Array.isArray(v) ? `${FIELD_NAMES[k] || k} ${yes(v[0])} to ${yes(v[1])}` : `${k === 'notes' ? 'Notes' : k} ${v}`)).join(' · ');
}

function scopeRow(e) {
  const [word, tone] = CHANGE_WORD[e.kind] || [e.kind, 'quiet'];
  const programEvent = e.kind.startsWith('program_');
  const end = h('span', { class: 'row-end', text: programEvent ? '' : 'Copy' });
  const facts = [];
  if (!programEvent) {
    facts.push(e.in_scope ? null : 'Out of scope');
    facts.push(e.bounty === true ? 'Bounty' : e.bounty === false ? 'No bounty' : null);
  }
  const body = [
    h('span', { class: 'when', title: `${when(e.at)}${e.dated_by === 'platform' ? `, dated by ${label(e.platform)}` : ', when ScopeDown noticed'}`, text: ago(e.at) }),
    h('span', { class: 'status', dataset: { tone }, text: word }),
    h('span', { class: 'row-title' },
      h('strong', { text: programEvent ? e.program_name : e.asset }),
      h('span', { text: [changeText(e), e.location].filter(Boolean).join(' · ') })),
    h('span', { class: 'scope-facts' },
      e.max_severity ? severity(e.max_severity) : null,
      h('span', { class: 'mono muted', text: facts.filter(Boolean).join(' · ') })),
    programEvent ? arrow('out') : end,
  ];
  if (programEvent) {
    return h('li', {}, h('a', { class: 'row', href: e.program_url, target: '_blank', rel: 'noopener', title: `Open ${e.program_name}` }, body));
  }
  const b = h('button', { class: 'row', type: 'button', title: `Copy ${e.asset}` }, body);
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(e.asset);
    flash(end, 'Copied');
  });
  return h('li', {}, b);
}

function programBlock(g, params, { all }) {
  const counts = Object.entries(g.counts).map(([k, n]) => `${n} ${(CHANGE_WORD[k]?.[0] || k).toLowerCase()}`).join(' · ');
  const targets = [...new Set(g.events.filter((e) => e.kind === 'added' && e.in_scope && COPYABLE.has(e.category)).map((e) => e.asset))];
  const copy = targets.length ? h('button', { class: 'link link--muted', type: 'button' }, h('span', { text: `Copy ${targets.length} target${targets.length === 1 ? '' : 's'}` })) : null;
  copy?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(targets.join('\n'));
    toast(`Copied ${targets.length} new in-scope target${targets.length === 1 ? '' : 's'} from ${g.program_name}, one per line.`);
  });
  const shown = all ? g.events : g.events.slice(0, ROWS_PER_PROGRAM);
  return h('section', { class: 'scope-program', 'aria-label': g.program_name },
    h('header', { class: 'scope-program-head' },
      h('div', { class: 'scope-program-title' },
        h('h2', {}, h('a', { class: 'link', href: g.program_url, target: '_blank', rel: 'noopener' }, h('span', { text: g.program_name }), arrow('out'))),
        h('p', { class: 'mono', text: [label(g.platform), g.visibility, g.program, counts].filter(Boolean).join(' · ') })),
      h('div', { class: 'scope-program-actions' }, copy,
        all ? null : h('a', { class: 'link link--muted', href: scopeLink(params, { program: `${g.platform}:${g.program}` }) }, h('span', { text: 'Only this program' })))),
    h('ul', { class: 'rows scope-rows' }, shown.map(scopeRow)),
    g.events.length > shown.length ? h('a', { class: 'link link--muted scope-more', href: scopeLink(params, { program: `${g.platform}:${g.program}` }) }, h('span', { text: `All ${g.events.length} changes` }), arrow('next')) : null);
}

function scopeFilters(params) {
  const field = (name, el) => h('label', { class: 'field' }, h('span', { class: 'label', text: name }), el);
  const select = (key, options, fallback, name) => {
    const el = h('select', { class: 'input', 'aria-label': name }, Object.entries(options).map(([v, t]) => h('option', { value: v, selected: (params.get(key) || fallback) === v, text: t })));
    el.addEventListener('change', () => { location.hash = scopeLink(params, { [key]: el.value === fallback ? null : el.value }); });
    return field(name, el);
  };
  const check = (key, text, on) => {
    const el = h('input', { type: 'checkbox', class: 'switch', checked: on });
    el.addEventListener('change', () => { location.hash = scopeLink(params, { [key]: el.checked === (key === 'scope') ? null : (key === 'scope' ? 'any' : '1') }); });
    return h('label', { class: 'scope-check' }, el, h('span', { text }));
  };
  const search = h('input', { class: 'input', type: 'search', value: params.get('q') || '', placeholder: 'Asset, program or group', spellcheck: 'false', 'aria-label': 'Search' });
  const form = h('form', { class: 'scope-filters', role: 'search', 'aria-label': 'Filter scope changes' },
    select('period', Object.fromEntries(Object.entries(PERIODS).map(([k, [t]]) => [k, t])), '7d', 'Period'),
    select('platform', { all: 'All platforms', ...Object.fromEntries(ADAPTERS.filter((a) => a.agent.watch).map((a) => [a.id, a.label])) }, 'all', 'Platform'),
    select('type', { all: 'All asset types', ...ASSET_TYPES }, 'all', 'Asset type'),
    select('vis', { all: 'Private and public', private: 'Private', public: 'Public' }, 'all', 'Programs'),
    field('Search', search),
    h('div', { class: 'scope-checks' }, check('scope', 'In scope only', params.get('scope') !== 'any'), check('bounty', 'Bounty only', params.get('bounty') === '1')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = scopeLink(params, { q: search.value.trim() || null });
  });
  search.addEventListener('search', () => { if (!search.value) location.hash = scopeLink(params, { q: null }); });
  return form;
}

async function scopeView(params) {
  const p = (k) => params.get(k);
  const kind = SCOPE_KINDS[p('kind')] ? p('kind') : 'new';
  const period = PERIODS[p('period')] ? p('period') : '7d';
  const [pf, ph] = (p('program') || '').split(':');
  const filters = {
    since: new Date(Date.now() - PERIODS[period][1] * 86_400_000).toISOString(),
    platform: getAdapter(pf) ? pf : getAdapter(p('platform')) ? p('platform') : undefined,
    handle: getAdapter(pf) && ph ? ph : undefined,
    categories: ASSET_TYPES[p('type')] ? [p('type')] : undefined,
    visibility: ['public', 'private'].includes(p('vis')) ? p('vis') : undefined,
    in_scope_only: p('scope') !== 'any',
    bounty_only: p('bounty') === '1',
    query: p('q') || undefined,
  };

  const lede = 'New and changed scope across every program you can submit to, dated by the platforms. Copy an asset to start on it.';
  if (!agent.settings.agentEnabled) {
    const on = button('Turn on agent access', () => enableAgents(true), { small: true });
    on.classList.remove('action--block');
    return h('div', {}, pageHead({ eyebrow: 'Scope watch', title: 'Scope', lede }),
      h('div', { class: 'region-empty' }, h('div', {}, h('h2', { text: 'Scope watch reads your programs through this browser' }), h('p', { text: `It needs agent access to ${ADAPTERS.map((a) => a.label).join(' and ')}.` })), on));
  }

  const data = await call('scope:list', { filters });
  const st = data.status;
  const running = st.state === 'running';
  const checked = Object.values(st.platforms).some((x) => x.watching_since);
  const counts = Object.fromEntries(Object.entries(SCOPE_KINDS).map(([k, v]) => [k, v.kinds ? data.events.filter((e) => v.kinds.includes(e.kind)).length : data.events.length]));
  const events = SCOPE_KINDS[kind].kinds ? data.events.filter((e) => SCOPE_KINDS[kind].kinds.includes(e.kind)) : data.events;

  const check = h('button', { class: 'action action--sm', type: 'button', disabled: running, 'aria-busy': running ? 'true' : null }, running ? 'Checking' : 'Check now', arrow('next'));
  check.addEventListener('click', () => checkNow(check));
  const auto = h('a', { class: 'link link--muted', href: '#/settings?focus=scope-watch' }, h('span', { text: data.watch ? `Checks every ${data.every} minutes` : 'Auto-check off' }));
  const fresh = counts.new;
  const head = pageHead({
    eyebrow: checked ? `${fresh} new in ${PERIODS[period][0].toLowerCase()}` : 'Scope watch',
    title: 'Scope',
    lede,
    side: h('div', { class: 'scope-side' }, h('div', { class: 'scope-side-row' }, auto, check), scopeStatusLine(st)),
  });
  if (running) watchScope();

  if (!checked && !data.events.length) {
    return h('div', {}, head, h('div', { class: 'region-empty' }, h('div', {},
      h('h2', { text: running ? 'Checking every program for the first time' : 'No scope checked yet' }),
      h('p', { text: 'The first check reads every program you can submit to: about a minute on HackerOne and 10 on Bugcrowd, which allows one request a second. It lists what the platforms added in the last 30 days.' }))));
  }

  const kinds = h('nav', { class: 'filters', 'aria-label': 'Kind of change' }, Object.entries(SCOPE_KINDS).map(([k, v]) => h('a', {
    href: scopeLink(params, { kind: k === 'new' ? null : k }),
    'aria-current': String(k === kind),
  }, v.label, h('span', { class: 'n', text: String(counts[k]) }))));

  const groups = new Map();
  for (const e of events) {
    const key = `${e.platform}:${e.program}`;
    if (!groups.has(key)) groups.set(key, { platform: e.platform, program: e.program, program_name: e.program_name, program_url: e.program_url, visibility: e.visibility, counts: {}, events: [] });
    const g = groups.get(key);
    g.counts[e.kind] = (g.counts[e.kind] || 0) + 1;
    g.events.push(e);
  }
  // A new program leads its own group.
  for (const g of groups.values()) g.events.sort((x, y) => y.kind.startsWith('program_') - x.kind.startsWith('program_'));
  const list = [...groups.values()];
  const one = Boolean(filters.handle);
  const page = Math.max(1, Number(p('page')) || 1);
  const shown = list.slice((page - 1) * PROGRAMS_PER_PAGE, page * PROGRAMS_PER_PAGE);
  const back = one ? h('a', { class: 'link link--muted back', href: scopeLink(params, { program: null }) }, arrow('back'), h('span', { text: 'All programs' })) : null;

  const body = list.length
    ? h('div', { class: 'scope-list' }, shown.map((g) => programBlock(g, params, { all: one })))
    : h('div', { class: 'region-empty' },
      h('div', {}, h('h2', { text: `Nothing ${SCOPE_KINDS[kind].label.toLowerCase() === 'all' ? '' : `${SCOPE_KINDS[kind].label.toLowerCase()} `}in ${PERIODS[period][0].toLowerCase()}` }), h('p', { text: 'Try a longer period, or clear the filters.' })),
      h('a', { class: 'link', href: '#/scope' }, h('span', { text: 'Clear filters' }), arrow('next')));
  const pages = Math.ceil(list.length / PROGRAMS_PER_PAGE);
  const pager = pages > 1 ? h('div', { class: 'pager' },
    h('span', { text: `Programs ${(page - 1) * PROGRAMS_PER_PAGE + 1} to ${Math.min(page * PROGRAMS_PER_PAGE, list.length)} of ${list.length}` }),
    h('nav', { 'aria-label': 'Pages' },
      h('a', { class: 'link', href: scopeLink(params, { page: String(page - 1) }), hidden: page <= 1 }, arrow('back'), h('span', { text: 'Newer' })),
      h('a', { class: 'link', href: scopeLink(params, { page: String(page + 1) }), hidden: page >= pages }, h('span', { text: 'Older' }), arrow('next')))) : null;
  const capped = data.total > data.events.length ? h('p', { class: 'scope-note', text: `Showing the newest ${data.events.length} of ${data.total} changes. Narrow the filters to see the rest.` }) : null;
  return h('div', {}, head, back, h('div', { class: 'scope-tools' }, kinds, scopeFilters(params)), capped, body, pager);
}

// ---------------------------------------------------------------- activity

async function activityView(params) {
  const all = await call('activity:list');
  const errors = params.get('errors') === '1';
  const list = errors ? all.filter((e) => !e.ok) : all;
  const limit = Math.max(50, Number(params.get('show')) || 50);
  const head = pageHead({ eyebrow: 'Agent console', title: 'Activity', lede: 'Every operation an agent ran through this browser. Report text is never logged.' });
  const filters = h('nav', { class: 'filters', 'aria-label': 'Filter activity' },
    h('a', { href: '#/activity', 'aria-current': String(!errors) }, 'All', h('span', { class: 'n', text: String(all.length) })),
    h('a', { href: '#/activity?errors=1', 'aria-current': String(errors) }, 'Errors', h('span', { class: 'n', text: String(all.filter((e) => !e.ok).length) })));
  if (!list.length) {
    return h('div', {}, head, filters, h('div', { class: 'region-empty', style: 'margin-top:16px' }, h('div', {}, h('h2', { text: errors ? 'No errors' : 'No activity yet' }), h('p', { text: 'Operations show up here as soon as an agent connects.' }))));
  }
  return h('div', {}, head, filters,
    h('table', { class: 'table', style: 'margin-top:16px' },
      h('thead', {}, h('tr', {}, ['When', 'Agent', 'Operation', 'Program', 'Result'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, list.slice(0, limit).map((e) => h('tr', {},
        h('td', { class: 'when', title: when(e.at), text: ago(e.at) }),
        h('td', { text: e.client }),
        h('td', { class: 'op', text: e.op }),
        h('td', { text: [e.platform && label(e.platform), e.program].filter(Boolean).join(' · ') }),
        h('td', { class: e.ok ? 'detail-cell' : 'detail-cell bad', text: e.detail || (e.ok ? `ok · ${e.ms} ms` : 'failed') }))))),
    list.length > limit ? h('div', { class: 'pager' }, h('span', { text: `${limit} of ${list.length}` }),
      h('a', { class: 'link', href: `#/activity?${errors ? 'errors=1&' : ''}show=${limit + 50}` }, h('span', { text: 'Show more' }), arrow('next'))) : null);
}

// ---------------------------------------------------------------- settings

function section(id, title, text, ...body) {
  return h('section', { class: 'section', id },
    h('div', { class: 'section-intro' }, h('h2', { text: title }), text ? h('p', { text }) : null),
    h('div', { class: 'section-body' }, body));
}

function setupSection() {
  const s = agent.settings;
  const c = agent.connection.state;
  const installed = s.agentEnabled && ['connected', 'disconnected', 'connecting'].includes(c);
  const used = agent.lastClient;
  const step = (done, n, title, text, extra) => h('li', { class: 'step', dataset: { done: String(Boolean(done)) } },
    h('span', { class: 'step-n', text: String(n).padStart(2, '0') }),
    h('div', {}, h('h3', {}, title, done ? icon('check', { label: 'Done' }) : null), h('p', {}, text), extra));
  const turnOn = s.agentEnabled ? null : button('Turn on agent access', () => enableAgents(true), { small: true });
  if (turnOn) turnOn.classList.remove('action--block');
  return section('connect', 'Connect an agent', `Agents on this computer use this browser's ${ADAPTERS.map((a) => a.label).join(' and ')} sessions. Filing waits for you.`,
    h('ol', { class: 'steps' },
      step(s.agentEnabled, 1, 'Turn on agent access', 'The browser asks for the permissions once.', turnOn),
      step(installed, 2, 'Install the bridge', installed ? 'Installed and connected to this browser.' : c === 'host_missing' ? 'Not found yet. Run this once, then come back.' : 'Run this once.', installed ? null : command('npx @principlebreach/scopedown-mcp install')),
      step(used, 3, 'Add ScopeDown to your harness', used ? `Last request from ${used.client} ${ago(used.at)}.` : 'Claude Code shown. Any MCP client can run the same server over stdio.', command('claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp'))));
}

function platformBlurb(a) {
  const parts = ['Scope and policy', `${/^[A-Z]{2,}$/.test(a.weaknessLabel) ? a.weaknessLabel : a.weaknessLabel.toLowerCase()} lookup`, 'your reports', 'drafts'];
  if (a.agent.disclosed) parts.splice(2, 0, 'disclosed reports');
  parts.push(a.agent.file ? 'filing after you approve' : `finishing in ${a.label}'s form`);
  return `${parts.join(', ')}.`;
}

async function enableAgents(on) {
  if (on && !(await ext.permissions.request(AGENT_PERMISSIONS))) {
    toast('Agent access needs those permissions.', { tone: 'error' });
    return render();
  }
  await call('agent:enable', { enabled: on });
  toast(on ? 'Agent access is on.' : 'Agent access is off.');
  setTimeout(render, 600);
  return render();
}

async function settingsView() {
  const s = agent.settings;
  const c = agent.connection;
  const sw = (checked, onChange, name, disabled = false) => {
    const el = h('input', { type: 'checkbox', class: 'switch', checked, disabled, 'aria-label': name });
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  };
  const setting = (title, text, control) => h('li', { class: 'setting' }, h('div', {}, h('h3', { text: title }), text ? h('p', {}, text) : null), control);
  const [connText, connTone] = CONNECTION[s.agentEnabled ? c.state : 'off'] || [c.state, 'quiet'];

  const access = section('access', 'Agent access', 'What agents may reach through this browser, signed in as you.',
    h('ul', { class: 'rows settings-rows' },
      setting('Agent access', h('span', { class: 'status', dataset: { tone: connTone }, title: c.error || '', text: connText }), sw(s.agentEnabled, enableAgents, 'Agent access')),
      ADAPTERS.map((a) => setting(a.label, platformBlurb(a), sw(s.platforms[a.id] !== false, async (on) => {
        await call('agent:platform', { platform: a.id, enabled: on });
        toast(`${a.label} ${on ? 'allowed' : 'blocked'} for agents.`);
      }, a.label, !s.agentEnabled)))));

  const fileable = ADAPTERS.filter((a) => a.agent.file);
  const platformPick = h('select', { class: 'input', 'aria-label': 'Platform' }, fileable.map((a) => h('option', { value: a.id, text: a.label })));
  const handle = h('input', { class: 'input', placeholder: 'Program handle, e.g. my_sandbox', spellcheck: 'false', 'aria-label': 'Program handle' });
  const addBtn = h('button', { class: 'action action--outline action--sm', type: 'submit' }, 'Add');
  const autoForm = h('form', { class: 'inline-form' }, fileable.length > 1 ? platformPick : null, handle, addBtn);
  autoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = getAdapter(platformPick.value);
    const value = handle.value.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/[/?#].*$/, '');
    if (!/^[\w.-]{1,120}$/.test(value)) return toast('Enter a program handle.', { tone: 'error' });
    const r = await dialog({ title: `Auto-submit for ${value}?`, body: `Drafts for this ${a.label} program are filed the moment an agent writes them, without your review.`, confirm: 'Turn on auto-submit', tone: 'danger' });
    if (r.action !== 'confirm') return;
    await call('agent:autosubmit', { key: `${a.id}:${value}`, enabled: true });
    toast(`Auto-submit is on for ${value}.`);
    render();
  });
  const autoRows = s.autoSubmit.map((key) => {
    const [pid, ph] = key.split(':');
    const rm = h('button', { class: 'link link--muted', type: 'button' }, h('span', { text: 'Remove' }));
    rm.addEventListener('click', async () => { await call('agent:autosubmit', { key, enabled: false }); toast('Auto-submit removed.'); render(); });
    return setting(ph, label(pid), rm);
  });
  const auto = section('auto-submit', 'Auto-submit', `Drafts for these programs are filed without your review. Meant for your own sandbox programs. Only on ${fileable.map((a) => a.label).join(', ')}, for programs without custom report fields.`,
    autoRows.length ? h('ul', { class: 'rows settings-rows' }, autoRows) : h('div', { class: 'region-empty', style: 'padding:16px 0' }, h('p', { style: 'margin:0', text: 'No programs. Every draft waits for you.' })),
    autoForm);

  const watchOn = sw(Boolean(s.scopeWatch), async (on) => {
    await call('scope:auto', { enabled: on });
    toast(on ? 'Scope is checked every 30 minutes.' : 'Scope is checked only when you or an agent ask.');
  }, 'Check scope every 30 minutes', !s.agentEnabled);
  const scopeWatch = section('scope-watch', 'Scope watch', 'Finds new and changed scope on every program you can submit to.',
    h('ul', { class: 'rows settings-rows' },
      setting('Check every 30 minutes', 'In a background tab, with a notification when new in-scope assets or programs appear. Bugcrowd gets one request a second, and each public engagement is checked at most every 2 hours.', watchOn)));

  const clearLog = h('button', { class: 'action action--quiet action--sm', type: 'button', text: 'Clear' });
  clearLog.addEventListener('click', async () => {
    const r = await dialog({ title: 'Clear the activity log?', confirm: 'Clear', tone: 'danger' });
    if (r.action === 'confirm') { await call('activity:clear'); toast('Activity cleared.'); }
  });
  const finished = drafts.filter((d) => ['submitted', 'rejected', 'handed_off'].includes(d.status)).length;
  const clearDrafts = h('button', { class: 'action action--quiet action--sm', type: 'button', text: 'Delete finished', disabled: !finished });
  clearDrafts.addEventListener('click', async () => {
    const r = await dialog({ title: `Delete ${finished} finished draft${finished === 1 ? '' : 's'}?`, body: 'Filed, rejected and handed-off drafts are removed from ScopeDown with their files. Nothing on the platforms changes.', confirm: 'Delete', tone: 'danger' });
    if (r.action === 'confirm') { const n = await call('drafts:clear-finished'); toast(`Deleted ${n} drafts.`); render(); }
  });
  const clearScope = h('button', { class: 'action action--quiet action--sm', type: 'button', text: 'Clear' });
  clearScope.addEventListener('click', async () => {
    const r = await dialog({ title: 'Clear the scope history?', body: 'The changes found so far and the stored copy of each program\'s scope are removed. The next check starts a new baseline and lists what the platforms added in the last 30 days.', confirm: 'Clear scope history', tone: 'danger' });
    if (r.action === 'confirm') { await call('scope:reset'); toast('Scope history cleared.'); }
  });
  const data = section('data', 'Data', 'Kept in this browser profile.',
    h('ul', { class: 'rows settings-rows' },
      setting('Activity log', 'The last 300 operations agents ran.', clearLog),
      setting('Drafts', `${drafts.length} draft${drafts.length === 1 ? '' : 's'}, ${finished} finished.`, clearDrafts),
      setting('Scope history', 'What the scope watch found, and its copy of each program\'s scope. Clearing starts a new baseline.', clearScope)));

  return h('div', {},
    pageHead({ eyebrow: 'Agent console', title: 'Settings', lede: "What agents may do with this browser's access." }),
    h('div', { class: 'arrive' }, access, setupSection(), scopeWatch, auto, data));
}

// ---------------------------------------------------------------- live updates

$('#version').textContent = `ScopeDown ${ext.runtime.getManifest().version}`;
let pending = null;
ext.storage.onChanged.addListener((changes) => {
  if (!changes.drafts && !changes.settings && !changes.connection && !changes.activity) return;
  if (editing) return;
  clearTimeout(pending);
  pending = setTimeout(render, 120);
});
window.addEventListener('hashchange', () => { editing = null; render(); });
// Any action that fails without its own handling still tells the user.
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || String(e.reason), { tone: 'error' }));
render();
