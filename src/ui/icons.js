// 16px line icons, 1.5 stroke, square caps: drawn to sit with Switzer at 13 to 14px.

const PATHS = {
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4 4l8 8M12 4l-8 8',
  dot: '',
  clock: 'M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
  alert: 'M8 5v3.5M8 11v.01M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
  external: 'M9.5 2.5h4v4M13.5 2.5L7 9M11.5 9.5v3.5h-9v-9H6',
  clip: 'M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.3 11.2a1.1 1.1 0 0 1-1.5-1.5L10 4.5',
  file: 'M9 1.5H4v13h8V4.5l-3-3zM9 1.5v3h3',
  image: 'M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 1.5-1.5 3 3M10.5 6.2v.01',
  trash: 'M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4',
  more: 'M3.5 8v.01M8 8v.01M12.5 8v.01',
  chevron: 'M6 3.5L10.5 8 6 12.5',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  plus: 'M8 3v10M3 8h10',
  upload: 'M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 13.5h11',
  target: 'M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M12.25 8a4.25 4.25 0 1 1-8.5 0 4.25 4.25 0 0 1 8.5 0z',
  download: 'M8 2v8M4.75 7L8 10.25 11.25 7M2.75 13.25h10.5',
  send: 'M2.5 8h9M8 4l4 4-4 4',
  plug: 'M6 1.5v3M10 1.5v3M4 4.5h8V7a4 4 0 0 1-8 0V4.5zM8 11v3.5',
  pencil: 'M10.5 2.5l3 3-8 8h-3v-3l8-8z',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  activity: 'M1.5 8h3l2-5 3 10 2-5h3',
  gear: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  inbox: 'M1.5 9.5l2-6h9l2 6v4h-13zM1.5 9.5h4l1 1.5h3l1-1.5h4',
  out: 'M4.5 11.5l7-7M6 4.5h5.5V10',
  next: 'M2.5 8h10.5M9 4l4 4-4 4',
  prev: 'M13.5 8H3M7 4L3 8l4 4',
};

export function icon(name, { size = 16, label } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', `icon icon-${name}`);
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  if (name === 'dot') {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '3');
    svg.append(c);
    return svg;
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] || '');
  svg.append(path);
  return svg;
}

// The site's travelling arrow: the icon twice, one leaves as the other enters on hover.
export function arrow(kind = 'next') {
  const name = { out: 'out', next: 'next', back: 'prev' }[kind];
  const span = document.createElement('span');
  span.className = `arrow arrow--${kind}`;
  span.setAttribute('aria-hidden', 'true');
  span.append(icon(name), icon(name));
  return span;
}
