// Renders the Markdown agents write (headings, lists, code, quotes, tables, emphasis, links)
// into DOM nodes. No HTML from the text is ever interpreted, links are limited to http(s),
// and remote images are shown as links so a draft cannot make the browser fetch anything.

import { h } from './dom.js';

export function renderMarkdown(text, { attachment } = {}) {
  const root = h('div', { class: 'md' });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s{0,3}(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      root.append(h('pre', { class: 'md-code', dataset: { lang: fence[2] || '' } }, h('code', { text: body.join('\n') })));
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      root.append(h(`h${level}`, {}, inline(heading[2], attachment)));
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      root.append(h('blockquote', {}, renderMarkdown(body.join('\n'), { attachment }).childNodes));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      root.append(h('div', { class: 'md-table' }, h('table', {},
        h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c, attachment))))),
        h('tbody', {}, rows.map((r) => h('tr', {}, head.map((_, j) => h('td', {}, inline(r[j] || '', attachment)))))),
      )));
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const list = h(ordered ? 'ol' : 'ul');
      const start = ordered ? parseInt(item[2], 10) : 1;
      if (ordered && start !== 1) list.setAttribute('start', String(start));
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const body = [m[3]];
        i++;
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) body.push(lines[i++].trim());
        const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
        list.append(task
          ? h('li', { class: 'task' }, h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ', inline(task[2], attachment))
          : h('li', {}, inline(body.join(' '), attachment)));
      }
      root.append(list);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s{0,3}(#{1,6}\s|```|~~~|>)/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++].trim());
    root.append(h('p', {}, inline(para.join('\n'), attachment)));
  }
  return root;
}

// Inline syntax: `code`, **bold**, *em*, ~~del~~, [text](url), <url>, {{attachment:name}}.
function inline(text, attachment) {
  const out = [];
  const re = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([\s\S]+?)\*(?!\w)|(?<!\w)_(?!\s)([\s\S]+?)_(?!\w)|~~([\s\S]+?)~~|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|\{\{attachment:([^}]+)\}\}|\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', { text: m[2] }));
    else if (m[3] || m[4]) out.push(h('strong', {}, inline(m[3] || m[4], attachment)));
    else if (m[5] || m[6]) out.push(h('em', {}, inline(m[5] || m[6], attachment)));
    else if (m[7]) out.push(h('del', {}, inline(m[7], attachment)));
    else if (m[9]) out.push(link(m[8] || m[9], m[9]));
    else if (m[10]) out.push(link(m[10], m[10]));
    else if (m[11]) out.push(attachment ? attachment(m[11].trim()) : h('code', { text: m[0] }));
    else out.push(h('br'));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function link(label, href) {
  if (!/^https?:\/\//i.test(href)) return label;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, label);
}
