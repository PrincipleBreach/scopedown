// Functions injected into a platform tab (MAIN world), so every
// request is an ordinary same-origin request from the site, with its own session and CSRF.
// Each one must stay self-contained: no imports, no outer variables.

// One HTTP request from inside the page. The extension builds the request; agents never do.
export async function pageRequest(req) {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav?.responseStatus >= 400) return { error: { code: 'bad_tab', message: `This tab shows an error page (${nav.responseStatus}).` } };

    const KEY = '__scopedownCsrf';
    let csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || globalThis[KEY];
    if (req.csrf && !csrf) {
      // Pages without the meta tag (robots.txt in the worker tab): read it from the site shell.
      const html = await (await fetch(req.csrfFrom || '/', { credentials: 'include', headers: { Accept: 'text/html' } })).text();
      csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] || html.match(/"csrfToken":"([^"]+)"/)?.[1] || null;
      if (csrf) Object.defineProperty(globalThis, KEY, { value: csrf, configurable: true });
    }
    const headers = { Accept: req.accept || 'application/json' };
    if (req.json !== undefined) headers['Content-Type'] = 'application/json';
    if (req.csrf && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(req.path, {
      method: req.method || 'GET',
      credentials: 'include',
      headers,
      body: req.json !== undefined ? JSON.stringify(req.json) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, url: res.url, redirected: res.redirected, body };
  } catch (e) {
    return { error: { code: 'page_fetch', message: String(e?.message || e) } };
  }
}
