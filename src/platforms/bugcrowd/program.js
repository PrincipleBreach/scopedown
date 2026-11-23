// Bugcrowd: reads the engagement brief JSON that the engagement page loads.
// fetchInPage runs inside the tab (MAIN world), so private engagements work with the
// user's own session. It must stay self-contained: no imports, no outer variables.

export const label = 'Bugcrowd';

const RESERVED = new Set([
  'engagements', 'programs', 'submissions', 'dashboard', 'user', 'users', 'h', 'settings',
  'leaderboard', 'crowdstream', 'resources', 'researchers', 'customers', 'blog', 'messages',
]);

export function match(url) {
  if (url.hostname !== 'bugcrowd.com' && url.hostname !== 'www.bugcrowd.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let code = null;
  if (parts[0] === 'engagements' && parts[1]) code = parts[1];
  else if (parts[0] && !RESERVED.has(parts[0].toLowerCase())) code = parts[0];
  if (!code || !/^[\w.-]+$/.test(code)) return null;
  return { code };
}

export function inPageArgs({ code }) {
  return [code];
}

export async function fetchInPage(code) {
  try {
    const get = async (path, accept) => {
      const res = await fetch(path, { credentials: 'include', headers: { Accept: accept } });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Bugcrowd refused access. Sign in, and check you are invited to this engagement.');
      }
      if (res.status === 404) {
        throw Object.assign(new Error(`There is no Bugcrowd engagement "${code}".`), { reason: 'not_found' });
      }
      if (!res.ok) throw new Error(`Bugcrowd returned HTTP ${res.status}.`);
      return res;
    };

    const findBriefPath = (root) => {
      for (const el of root.querySelectorAll('[data-api-endpoints]')) {
        try {
          const p = JSON.parse(el.getAttribute('data-api-endpoints'))?.engagementBriefApi?.getBriefVersionDocument;
          if (p) return p;
        } catch { /* not JSON, keep looking */ }
      }
      return null;
    };

    const enginePath = `/engagements/${encodeURIComponent(code)}`;
    // Only this engagement's own pages: /engagements/tesla must not match /engagements/tesla-mbo.
    const onEngagement = location.pathname === enginePath || location.pathname.startsWith(`${enginePath}/`);
    let briefPath = onEngagement ? findBriefPath(document) : null;
    if (!briefPath) {
      const html = await (await get(enginePath, 'text/html')).text();
      briefPath = findBriefPath(new DOMParser().parseFromString(html, 'text/html'));
    }
    if (!briefPath) {
      return { error: 'No program brief found here. Sign in, and check you can see this engagement.', reason: 'not_found' };
    }
    const url = new URL(briefPath, location.origin);
    if (!url.pathname.endsWith('.json')) url.pathname += '.json';
    const brief = await (await get(url.pathname + url.search, 'application/json')).json();
    if (!brief?.data?.brief) return { error: 'Bugcrowd sent an unexpected response for the brief.' };
    return { code, brief };
  } catch (e) {
    return { error: String(e?.message || e), reason: e?.reason };
  }
}

const CATEGORY = {
  website: 'Website', api: 'API', ios: 'iOS', android: 'Android', hardware: 'Hardware',
  other: 'Other', network: 'Network', iot: 'IoT', cloud: 'Cloud', code: 'Source code',
  blockchain: 'Blockchain', 'ai_model': 'AI model',
};

const PRIORITIES = ['1', '2', '3', '4', '5'];

export function normalize(raw, { fetchedAt }) {
  const b = raw.brief;
  const d = b.data;
  const brief = d.brief;
  const code = d.engagement?.code || raw.code;
  const scopes = [];
  const groups = [];
  const rewardRows = [];

  for (const g of d.scope || []) {
    const name = (g.name || '').trim() || 'Unnamed group';
    const rr = g.rewardRangeData || {};
    const cells = PRIORITIES.map((p) => money(rr[p]?.min, rr[p]?.max));
    const paid = cells.some(Boolean);
    if (g.inScope && paid) rewardRows.push({ label: name, cells });
    groups.push({
      name,
      inScope: Boolean(g.inScope),
      cells: g.inScope && paid ? cells : null,
      notes: (g.descriptionHtml || g.description || '').trim(),
      notesFormat: g.descriptionHtml ? 'html' : 'markdown',
    });
    for (const t of g.targets || []) {
      // Some programs type Markdown escapes into target names, like "\*.example.com".
      const ident = (t.name || '').trim().replace(/\\([*_`\\])/g, '$1');
      const locators = [t.uri, t.ipAddress].map((x) => (x || '').trim()).filter((x) => x && x !== ident);
      // "Website Testing" style tags only repeat the category; keep the tech stack tags.
      const tags = (t.tags || []).map((x) => x?.name?.trim()).filter((x) => x && !/ Testing$/i.test(x));
      scopes.push({
        identifier: ident,
        location: [...new Set(locators)].join(' '),
        type: CATEGORY[t.category] || t.category || '',
        group: name,
        groupId: groups.length - 1,
        inScope: Boolean(g.inScope),
        bounty: g.inScope ? paid : false,
        maxSeverity: '',
        tags,
        notes: (t.description || '').trim(),
        notesFormat: 'markdown',
      });
    }
  }

  // Drop priority columns no group pays for (for example P5).
  const used = PRIORITIES.map((_, i) => rewardRows.some((r) => r.cells[i]));
  const rewards = rewardRows.length
    ? {
      columns: PRIORITIES.map((p) => `P${p}`).filter((_, i) => used[i]),
      rows: rewardRows.map((r) => ({ label: r.label, cells: r.cells.filter((_, i) => used[i]) })),
      notes: '',
    }
    : null;

  // Each in-scope group carries its own reward line, for example "P1 $7,000 to $35,000, P2 $3,000".
  for (const g of groups) {
    g.rewards = g.cells
      ? PRIORITIES.map((p, i) => (used[i] && g.cells[i] ? `P${p} ${g.cells[i]}` : null)).filter(Boolean).join(', ')
      : '';
    delete g.cells;
  }

  const facts = [];
  if (brief.safeHarborStatus?.label) facts.push(['Safe harbor', brief.safeHarborStatus.label]);
  if (b.rewardAllocation) facts.push(['Reward model', b.rewardAllocation.replace(/_/g, ' ')]);
  if (b.engagementTypeDetail?.productLabel) facts.push(['Engagement type', b.engagementTypeDetail.productLabel]);
  if (b.industryName) facts.push(['Industry', b.industryName]);
  if (b.vrtVersion) facts.push(['Severity taxonomy', `Bugcrowd VRT ${b.vrtVersion}`]);
  if (b.endsAt || d.engagement?.endsAt) facts.push(['Ends', b.endsAt || d.engagement.endsAt]);

  const sections = [
    ['Program overview', brief.description],
    ['Targets overview', brief.targetsOverview],
    ['Additional information', brief.additionalInformation],
  ].filter(([, html]) => html && html.trim()).map(([title, body]) => ({ title, body, format: 'html' }));

  const participation = b.participation || d.engagementConfiguration?.participation;
  return {
    platform: 'bugcrowd',
    platformName: 'Bugcrowd',
    name: (brief.name || code || '').trim(),
    handle: code,
    url: `https://bugcrowd.com/engagements/${code}`,
    visibility: participation === 'open' ? 'public' : (participation ? 'private' : null),
    status: b.statusLabel || d.engagement?.state || null,
    bounties: rewards ? true : (b.rewardAllocation ? false : null),
    updatedAt: b.publishedAt || null,
    fetchedAt,
    facts,
    scopes,
    groups,
    rewards,
    sections,
    warnings: [],
  };
}

function money(min, max) {
  const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;
  if (!max && !min) return '';
  if (min != null && max != null && min !== max) return `${fmt(min)} to ${fmt(max)}`;
  return fmt(max ?? min);
}
