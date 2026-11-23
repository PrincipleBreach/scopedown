// Runs inside a bugcrowd.com tab (MAIN world). Must stay self-contained: no imports, no outer variables.

// Bugcrowd's submission form ships its configuration as React props in the HTML.
export async function bugcrowdFormProps(code) {
  try {
    const res = await fetch(`/engagements/${encodeURIComponent(code)}/submissions/new`, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (res.status === 401 || res.status === 403) return { error: { code: 'forbidden', message: 'Bugcrowd refused access to this engagement. Check you are signed in and joined.' } };
    if (!res.ok) return { error: { code: 'platform', message: `Bugcrowd returned HTTP ${res.status}.` } };
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const el = doc.querySelector('[data-react-class="EngagementSubmissionForm"]');
    if (!el) return { error: { code: 'not_found', message: 'This engagement has no submission form. It may be closed or need you to join it first.' } };
    const p = JSON.parse(el.getAttribute('data-react-props'));
    const nav = doc.querySelector('[data-react-class="ResearcherNavbar"]');
    const user = nav ? JSON.parse(nav.getAttribute('data-react-props'))?.username : null;
    return {
      username: user,
      disabled: Boolean(p.disabled),
      targets: (p.availableTargets || []).map((t) => ({ id: t.id, name: t.name })),
      vrt: p.vrtOptions || [],
      throttle: p.submissionThrottleCaps || null,
      captcha: Boolean(p.turnstileSiteKey),
    };
  } catch (e) {
    return { error: { code: 'page_fetch', message: String(e?.message || e) } };
  }
}

// Fills the open submission form from a draft, the way a person would, so Bugcrowd's own
// form state picks every value up. It never ticks the terms box and never presses a submit
// button: the hunter reviews, solves the captcha and submits. Returns which fields it set.
export async function fillBugcrowdForm(data) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return el.value === value;
  };
  const out = { filled: [], missed: [] };
  const note = (field, ok, why) => (ok ? out.filled.push(field) : out.missed.push(why ? `${field}: ${why}` : field));

  if (!(await until(() => document.querySelector('[name="submission[caption]"]')))) {
    return { error: 'The Bugcrowd form did not load.' };
  }
  const field = (name) => document.querySelector(`[name="${name}"]`);

  if (data.title) note('Summary title', setValue(field('submission[caption]'), data.title));

  if (data.target) {
    const sel = field('submission[target_id]');
    const want = String(data.target.name || '').trim().toLowerCase();
    const opt = sel && [...sel.options].find((o) => (data.target.id != null && o.value === String(data.target.id)) || o.textContent.trim().toLowerCase() === want);
    note('Target', Boolean(opt) && setValue(sel, opt.value), opt ? null : 'not in the form');
  }

  if (data.url) {
    const el = field('submission[bug_url]');
    note('URL', Boolean(el) && setValue(el, data.url), el ? null : 'no URL field');
  }

  let description = data.description || '';
  const requestField = document.querySelector('textarea[name*="http_request"]');
  if (data.request && requestField) note('HTTP request', setValue(requestField, data.request));
  else if (data.request) description += `\n\n## HTTP request\n\n\`\`\`http\n${data.request}\n\`\`\``;
  if (description) note('Description', setValue(field('submission[description]'), description));

  // The VRT picker is a tree: category, subcategory, variant. Click the exact path, then
  // check the form stored the full dotted id.
  if (data.vrt) {
    const props = JSON.parse(document.querySelector('[data-react-class="EngagementSubmissionForm"]')?.getAttribute('data-react-props') || '{}');
    const names = [];
    let level = props.vrtOptions || [];
    for (const part of data.vrt.split('.')) {
      const node = level.find((o) => o.id === part);
      if (!node) break;
      names.push(node.name);
      level = node.children || [];
    }
    const stored = () => document.querySelector('input[name="submission[original_vrt_id]"]')?.value === data.vrt;
    if (names.length !== data.vrt.split('.').length) note('VRT', false, 'not offered by this engagement');
    else {
      // Categories and subcategories open on hover and select on click, so hover along the
      // path and click only the last entry.
      document.querySelector('.vrt-dropdown__select')?.click();
      const label = (el) => el.getAttribute('aria-label') || el.querySelector(':scope > span[aria-label]')?.getAttribute('aria-label');
      const hover = (el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const target = (li) => li.querySelector(':scope > span[aria-label]') || li;
      const cat = await until(() => [...document.querySelectorAll('li.vrt-dropdown__opt--category')].find((li) => label(li) === names[0]), 4000);
      let picked = null;
      if (cat && names.length === 1) picked = cat;
      else if (cat) {
        hover(cat);
        const sub = await until(() => [...document.querySelectorAll('li.vrt-dropdown__opt--subcategory')].find((li) => label(li) === names[1]), 4000);
        if (sub && names.length === 2) picked = target(sub);
        else if (sub) {
          hover(target(sub));
          picked = await until(() => [...sub.querySelectorAll('li.vrt-dropdown__opt--variant')].find((li) => label(li) === names[2]), 4000);
        }
      }
      picked?.click();
      const ok = Boolean(picked) && Boolean(await until(stored, 3000));
      if (document.querySelector('#vrt-categories')) document.querySelector('[name="submission[caption]"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      note('VRT', ok, ok ? null : 'pick it by hand');
    }
  }

  if (data.files?.length) {
    const input = document.querySelector('input[type="file"][name="file_attachments[]"]')
      || [...document.querySelectorAll('input[type="file"]')].find((i) => /attachment/i.test(i.labels?.[0]?.textContent || ''));
    if (!input) note('Attachments', false, 'no attachment field');
    else {
      const dt = new DataTransfer();
      for (const f of data.files) {
        const bin = atob(f.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      note(`Attachments (${data.files.length})`, true);
    }
  }

  document.querySelector('[name="submission[caption]"]')?.scrollIntoView({ block: 'center' });
  return out;
}
