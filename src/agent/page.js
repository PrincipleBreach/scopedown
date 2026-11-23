// Functions injected into a platform tab (MAIN world), so every
// request is an ordinary same-origin request from the site, with its own session and CSRF.
// Each one must stay self-contained: no imports, no outer variables.

// One HTTP request from inside the page. The extension builds the request; agents never do.
export async function pageRequest(req) {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav?.responseStatus >= 400) return { error: { code: 'bad_tab', message: `This tab shows an error page (${nav.responseStatus}).` } };

    const KEY = '__scopedownCsrf';
    // Pages without the meta tag (robots.txt in the worker tab): read it from the site shell.
    const loadCsrf = async () => {
      const html = await (await fetch(req.csrfFrom || '/', { credentials: 'include', headers: { Accept: 'text/html' } })).text();
      const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] || html.match(/"csrfToken":"([^"]+)"/)?.[1] || null;
      if (token) Object.defineProperty(globalThis, KEY, { value: token, configurable: true });
      return token;
    };
    const meta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    let csrf = meta || globalThis[KEY] || (req.csrf ? await loadCsrf() : null);
    const send = () => {
      const headers = { Accept: req.accept || 'application/json' };
      if (req.json !== undefined) headers['Content-Type'] = 'application/json';
      if (req.csrf && csrf) headers['X-CSRF-Token'] = csrf;
      return fetch(req.path, {
        method: req.method || 'GET',
        credentials: 'include',
        headers,
        body: req.json !== undefined ? JSON.stringify(req.json) : undefined,
      });
    };
    let res = await send();
    // A token cached from an older session (signed out and in again): replace it and try once more.
    // A 403 means the request was refused, so sending it again cannot repeat its effect.
    if (res.status === 403 && req.csrf && !meta) {
      csrf = await loadCsrf();
      res = await send();
    }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, url: res.url, redirected: res.redirected, body };
  } catch (e) {
    return { error: { code: 'page_fetch', message: String(e?.message || e) } };
  }
}
