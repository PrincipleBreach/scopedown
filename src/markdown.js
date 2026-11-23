// Small, dependency-free HTML to Markdown converter plus Markdown helpers.
// It works on any DOM that exposes nodeType, nodeName, childNodes and getAttribute,
// so the popup can use the browser DOMParser and tests can use linkedom.

const INDENT = '\u0000'; // stands in for list indentation until the final tidy pass
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'HEAD', 'TITLE']);

export function htmlToMarkdown(html, { parse, headingOffset = 0, baseUrl } = {}) {
  if (!html || !html.trim()) return '';
  const doc = parse(html);
  const ctx = { headingOffset, baseUrl, pre: [] };
  const md = convert(doc.body || doc, ctx);
  return tidy(md, ctx);
}

function kids(node, ctx) {
  let out = '';
  for (const child of node.childNodes) out += convert(child, ctx);
  return out;
}

function convert(node, ctx) {
  if (node.nodeType === 3) return node.nodeValue.replace(/[​﻿]/g, '').replace(/\s+/g, ' ');
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return '';
  const tag = String(node.nodeName).toUpperCase();
  if (SKIP.has(tag)) return '';

  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const level = Math.min(6, Number(tag[1]) + ctx.headingOffset);
      const text = oneLine(kids(node, ctx)).replace(/\*\*/g, '');
      return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
    }
    case 'P': case 'DIV': case 'SECTION': case 'ARTICLE': case 'HEADER': case 'FOOTER':
    case 'MAIN': case 'ASIDE': case 'NAV': case 'FIGURE': case 'FIGCAPTION': case 'DL': case 'DETAILS':
    case 'SUMMARY': case 'ADDRESS': case 'CENTER':
      return `\n\n${kids(node, ctx).trim()}\n\n`;
    case 'DT': return `\n\n**${oneLine(kids(node, ctx))}**\n`;
    case 'DD': return `\n${kids(node, ctx).trim()}\n\n`;
    case 'BR': return '\n';
    case 'HR': return '\n\n---\n\n';
    case 'STRONG': case 'B': return wrap(kids(node, ctx), '**');
    case 'EM': case 'I': case 'CITE': return wrap(kids(node, ctx), '_');
    case 'S': case 'DEL': case 'STRIKE': return wrap(kids(node, ctx), '~~');
    case 'CODE': case 'KBD': case 'SAMP': case 'TT': {
      const text = textOf(node);
      if (!text.trim()) return text;
      const fence = text.includes('`') ? '``' : '`';
      return `${fence}${text.replace(/\s+/g, ' ')}${fence}`;
    }
    case 'PRE': {
      const text = textOf(node).replace(/\n+$/, '');
      ctx.pre.push(`\`\`\`\n${text}\n\`\`\``);
      return `\n\n\u0001${ctx.pre.length - 1}\u0001\n\n`;
    }
    case 'A': {
      const text = oneLine(kids(node, ctx));
      const href = resolve(node.getAttribute('href'), ctx.baseUrl);
      if (!href) return text;
      if (!text || sameLink(text, href)) return `<${href.replace(/^mailto:/, '')}>`;
      return `[${text}](${href})`;
    }
    case 'IMG': {
      const src = resolve(node.getAttribute('src'), ctx.baseUrl);
      const alt = (node.getAttribute('alt') || '').trim();
      return src ? `![${alt}](${src})` : alt;
    }
    case 'UL': case 'OL': return list(node, ctx, tag === 'OL');
    case 'LI': return `\n${item('- ', node, ctx)}\n`;
    case 'BLOCKQUOTE': {
      const inner = tidyFragment(kids(node, ctx));
      return `\n\n${inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
    }
    case 'TABLE': return table(node, ctx);
    default: return kids(node, ctx);
  }
}

function list(node, ctx, ordered) {
  let n = Number(node.getAttribute('start')) || 1;
  const lines = [];
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    if (String(child.nodeName).toUpperCase() === 'LI') {
      lines.push(item(ordered ? `${n++}. ` : '- ', child, ctx));
    } else {
      const extra = tidyFragment(convert(child, ctx));
      if (extra) lines.push(extra);
    }
  }
  return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
}

function item(marker, node, ctx) {
  const body = tidyFragment(kids(node, ctx)).replace(/\n{2,}/g, '\n');
  const pad = INDENT.repeat(marker.length);
  return marker + body.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

function table(node, ctx) {
  const rows = [];
  const walk = (el) => {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = String(child.nodeName).toUpperCase();
      if (tag === 'TR') rows.push(child);
      else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') walk(child);
    }
  };
  walk(node);
  const cells = rows.map((tr) => [...tr.childNodes]
    .filter((c) => c.nodeType === 1 && /^(TD|TH)$/i.test(c.nodeName))
    .map((c) => tableCell(tidyFragment(kids(c, ctx)))));
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (!width) return '';
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const line = (r) => `| ${pad(r).join(' | ')} |`;
  const [head, ...body] = cells;
  return `\n\n${[line(head), line(Array(width).fill('---')), ...body.map(line)].join('\n')}\n\n`;
}

export function tableCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

function wrap(inner, mark) {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m[2] || m[2].includes('\n')) return inner;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  let out = '';
  for (const c of node.childNodes || []) {
    out += String(c.nodeName).toUpperCase() === 'BR' ? '\n' : textOf(c);
  }
  return out;
}

function resolve(href, base) {
  if (!href) return '';
  href = href.trim();
  if (/^(javascript|data):/i.test(href) || href.startsWith('#')) return '';
  try {
    return base ? new URL(href, base).href : href;
  } catch {
    return href;
  }
}

// Trim each line and collapse blank runs, but keep list indentation markers.
function tidyFragment(s) {
  return s
    .split('\n')
    .map((l) => l.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tidy(md, ctx) {
  return tidyFragment(md)
    .replace(new RegExp(INDENT, 'g'), ' ')
    .replace(/\u0001(\d+)\u0001/g, (_, i) => ctx.pre[Number(i)]);
}

// Link text that only repeats its own URL, ignoring a trailing slash or mailto.
function sameLink(text, href) {
  const norm = (u) => u.trim().replace(/^mailto:/i, '').replace(/\/+$/, '').toLowerCase();
  return norm(text) === norm(href);
}

// Lossless clean-up of Markdown written by programs: drops link titles, turns links whose
// text is their own URL into autolinks, and trims trailing spaces. Code fences are left alone.
export function tidyMarkdown(md) {
  if (!md) return '';
  let fence = null;
  return md.split('\n').map((line) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line.trimEnd();
    }
    if (fence) return line;
    return line
      .replace(/\[([^\]]*)\]\((\S+?)\s+(?:"[^"]*"|'[^']*')\)/g, '[$1]($2)')
      .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (all, text, href) => (sameLink(text, href) && /^(https?:|mailto:)/i.test(href)
        ? `<${href.replace(/^mailto:/i, '')}>`
        : all))
      .trimEnd();
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Push every ATX heading down by `offset` levels, skipping fenced code.
export function shiftHeadings(md, offset) {
  if (!md || !offset) return md || '';
  let fence = null;
  return md.split('\n').map((line) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, (_, sp, h) => sp + '#'.repeat(Math.min(6, h.length + offset)));
  }).join('\n');
}

// Lowest heading level used outside code fences, or 0 when there are none.
export function topHeadingLevel(md) {
  let fence = null;
  let top = 0;
  for (const line of (md || '').split('\n')) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^\s{0,3}(#{1,6})(?=\s|$)/);
    if (h && (!top || h[1].length < top)) top = h[1].length;
  }
  return top;
}

// Re-level headings so the shallowest one lands at `level`.
export function nestHeadings(md, level) {
  const top = topHeadingLevel(md);
  return top ? shiftHeadings(md, Math.max(0, level - top)) : md;
}
