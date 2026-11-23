// Runs inside a hackerone.com tab (MAIN world). Must stay self-contained: no imports, no outer variables.

// Uploads one evidence file the way HackerOne's report form does (POST /attachments),
// returning the attachment id to reference from the report.
export async function pageAttach(req) {
  try {
    let csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || globalThis.__scopedownCsrf;
    if (!csrf) {
      const html = await (await fetch(req.csrfFrom || '/', { credentials: 'include', headers: { Accept: 'text/html' } })).text();
      csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] || null;
    }
    const bin = atob(req.base64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: req.type }), req.name);
    const res = await fetch('/attachments', { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: form });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !body?.id) return { error: { code: 'platform', message: `HackerOne refused ${req.name} (HTTP ${res.status}).` } };
    return { id: String(body.id), name: body.name, size: body.size };
  } catch (e) {
    return { error: { code: 'page_fetch', message: String(e?.message || e) } };
  }
}

// Fills HackerOne's report form from a draft, the way a person would, so the form's own
// state picks every value up. It never presses Submit: the hunter reviews and submits.
// HackerOne autosaves the form as the hunter's draft for that program. Returns which
// fields it set and which it could not.
export async function fillHackerOneForm(data) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return el.value === value;
  };
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // An item's own name, without its CWE id or the asset's meta line (search wraps matches in <strong>).
  const own = (el) => {
    const copy = el.cloneNode(true);
    for (const extra of copy.querySelectorAll('.text-muted, .meta-text')) extra.remove();
    return copy.textContent;
  };
  const out = { filled: [], missed: [] };
  const note = (field, ok, why) => (ok ? out.filled.push(field) : out.missed.push(why ? `${field}: ${why}` : field));

  if (!(await until(() => document.querySelector('[name="report[title]"]')))) return { error: 'The HackerOne report form did not load.' };
  const main = document.querySelector('main') || document.body;

  // react-select: open its menu, type the wanted label, click the option that matches.
  const pick = async (input, label) => {
    if (!input) return false;
    const control = input.closest('[class*="control"]') || input.parentElement;
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.focus();
    setValue(input, label);
    const prefix = input.id.replace(/-input$/, '');
    const option = await until(() => [...document.querySelectorAll(`[id^="${prefix}-option-"]`)].find((o) => norm(o.textContent) === norm(label)), 4000);
    option?.click();
    return Boolean(option);
  };

  // Asset and weakness are searchable lists of buttons; the step then shows the selection.
  const choose = async (searchLabel, itemClass, wanted) => {
    const search = main.querySelector(`input[aria-label="${searchLabel}"]`);
    if (!search) return 'missing';
    setValue(search, wanted);
    const item = await until(() => [...main.querySelectorAll(`.${itemClass}`)].find((el) => norm(own(el)) === norm(wanted)), 4000);
    if (!item) return 'not offered';
    (item.closest('button') || item).click();
    return (await selected(searchLabel, wanted, 2000)) ? 'ok' : 'not selected';
  };
  // Once something is selected the step reads "Currently selected: (Deselect) <name>".
  const selected = (searchLabel, wanted, ms = 0) => {
    let card = main.querySelector(`input[aria-label="${searchLabel}"]`);
    while (card && !/currently selected:/i.test(card.textContent || '')) card = card.parentElement;
    const shows = () => [...(card?.querySelectorAll('.selected-item, *') || [])].some((e) => {
      const t = norm(e.textContent);
      return t.startsWith('currently selected: (deselect)') && t.includes(norm(wanted));
    });
    return ms ? until(shows, ms) : Promise.resolve(shows());
  };

  note('Title', setValue(main.querySelector('[name="report[title]"]'), data.title));
  const impact = main.querySelector('[name="report[impact]"]');
  if (data.impact) note('Impact', Boolean(impact) && setValue(impact, data.impact), impact ? null : 'no impact field');

  // The program's custom fields, matched by their label.
  for (const cf of data.custom || []) {
    const label = [...main.querySelectorAll('label[for]')].find((l) => norm(l.textContent.replace(/\*\s*$/, '')) === norm(cf.label));
    const value = label && main.querySelector(`[name="field_${label.htmlFor}.value"]`);
    let ok = false;
    if (value?.type === 'checkbox') {
      if (value.checked !== Boolean(cf.value)) value.click();
      ok = value.checked === Boolean(cf.value);
    } else if (value instanceof HTMLTextAreaElement) {
      ok = setValue(value, String(cf.value));
    } else if (value) {
      let box = value;
      let select = null;
      for (let i = 0; i < 5 && box && !select; i++) {
        box = box.parentElement;
        select = box?.querySelector('input[id^="react-select-"]');
      }
      ok = select ? await pick(select, String(cf.value)) : setValue(value, String(cf.value));
    }
    note(cf.label, ok, value ? 'fill it by hand' : 'not in the form');
  }

  if (data.files?.length) {
    const dz = main.querySelector('.attachments-upload')?.dropzone;
    if (!dz) note('Attachments', false, 'no attachment area');
    else {
      const added = data.files.map((f) => {
        const bin = atob(f.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], f.name, { type: f.type });
        dz.addFile(file);
        return file;
      });
      await until(() => added.every((f) => ['success', 'error', 'canceled'].includes(f.status)), 60000);
      const done = added.filter((f) => f.status === 'success').length;
      note(`Attachments (${done})`, done === added.length, `${added.length - done} of ${added.length} did not upload; attach them by hand`);
    }
  }

  // The description goes in last, so evidence references can point at the uploaded files:
  // {{attachment:name}} becomes HackerOne's inline {F<id>}.
  const ids = new Map([...main.querySelectorAll('.attachment-uploaded')].map((row) => [
    row.querySelector('.attachment-name')?.textContent.trim(),
    row.querySelector('.attachment-id')?.textContent.match(/F(\d+)/)?.[1],
  ]));
  const description = String(data.description || '').replace(/\{\{attachment:([^}]+)\}\}/g, (_, name) => (ids.get(name.trim()) ? `{F${ids.get(name.trim())}}` : `\`${name.trim()}\` (attached)`));
  const info = main.querySelector('[name="report[vulnerability_information]"]');
  note('Description', Boolean(info) && setValue(info, description));

  // Selections come last: the form autosaves the text, and that save's reply can reset a
  // selection made while it was in flight. So wait for it, pick, then check again later.
  await sleep(2500);
  const picks = [];
  if (data.asset) picks.push(['Asset', 'Search Assets', 'spec-asset-suggestion', data.asset]);
  if (data.weakness) picks.push(['Weakness', 'Search Weaknessess', 'spec-weakness-suggestion', data.weakness]);
  const results = new Map();
  for (const [field, search, cls, wanted] of picks) results.set(field, await choose(search, cls, wanted));
  if (data.severity) {
    const method = main.querySelector('#severity-calculator-selector-dropdown');
    const manual = !method || /manual/i.test(method.textContent) || await pick(method.querySelector('input[id^="react-select-"]'), 'Manual');
    const label = data.severity[0].toUpperCase() + data.severity.slice(1);
    const rate = manual && await until(() => [...main.querySelectorAll('form button')].find((b) => b.textContent.trim() === label), 3000);
    rate?.click();
    const ok = Boolean(rate) && Boolean(await until(() => /--selected/.test(rate.className) || rate.getAttribute('aria-pressed') === 'true', 2000));
    note('Severity', ok, manual ? 'set it by hand' : 'this program asks for the calculator');
  }

  // Settle: the form's autosave replies can reset a field filled while they were in flight.
  // Re-apply whatever changed until a round finds nothing to fix.
  const texts = [['Title', '[name="report[title]"]', data.title], ['Impact', '[name="report[impact]"]', data.impact], ['Description', '[name="report[vulnerability_information]"]', description]].filter(([, , v]) => v);
  for (let round = 0; round < 3; round++) {
    await sleep(3000);
    let fixed = false;
    for (const [, selector, value] of texts) {
      const el = main.querySelector(selector);
      if (el && el.value !== value) { setValue(el, value); fixed = true; }
    }
    for (const [field, search, cls, wanted] of picks) {
      if (results.get(field) === 'ok' && !(await selected(search, wanted))) { results.set(field, await choose(search, cls, wanted)); fixed = true; }
    }
    if (!fixed) break;
  }
  for (const [field, selector, value] of texts) {
    const el = main.querySelector(selector);
    if (out.filled.includes(field) && el?.value !== value) {
      out.filled.splice(out.filled.indexOf(field), 1);
      note(field, false, 'HackerOne reset it; paste it by hand');
    }
  }
  for (const [field, search, , wanted] of picks) {
    const r = results.get(field) === 'ok' && !(await selected(search, wanted)) ? 'not selected' : results.get(field);
    note(field, r === 'ok', r === 'missing' ? `the form has no ${field.toLowerCase()} step` : 'pick it by hand');
  }

  main.querySelector('[name="report[title]"]')?.scrollIntoView({ block: 'center' });
  return out;
}
