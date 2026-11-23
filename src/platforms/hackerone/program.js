// HackerOne: reads the program through the same GraphQL API the program page uses.
// fetchInPage runs inside the tab (MAIN world), so private programs work with the
// user's own session. It must stay self-contained: no imports, no outer variables.

export const label = 'HackerOne';

const RESERVED = new Set([
  'hacktivity', 'opportunities', 'directory', 'bugs', 'reports', 'settings', 'leaderboard',
  'users', 'teams', 'organizations', 'inbox', 'dashboard', 'notifications', 'sign_in',
  'sign_up', 'users_sign_in', 'graphql', 'programs', 'hackers', 'resources', 'product',
]);

const TEAM_QUERY = `query ScopeDownTeam($handle: String!) {
  team(handle: $handle) {
    id handle name url state submission_state offers_bounties currency
    response_efficiency_percentage only_cleared_hackers
    policy_setting { last_policy_change_at }
    policy
    bounty_table {
      low_label medium_label high_label critical_label description
      bounty_table_rows(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { ...Row }
      }
    }
    structured_scopes(first: 100, archived: false) {
      pageInfo { hasNextPage endCursor }
      nodes { ...Scope }
    }
  }
}
fragment Scope on StructuredScope {
  id asset_identifier asset_type human_asset_type eligible_for_bounty eligible_for_submission
  max_severity instruction confidentiality_requirement integrity_requirement availability_requirement
}
fragment Row on BountyTableRow {
  name low medium high critical low_minimum medium_minimum high_minimum critical_minimum
  structured_scope { asset_identifier }
}`;

const SCOPES_PAGE = `query ScopeDownScopes($handle: String!, $after: String) {
  team(handle: $handle) {
    connection: structured_scopes(first: 100, after: $after, archived: false) {
      pageInfo { hasNextPage endCursor }
      nodes { id asset_identifier asset_type human_asset_type eligible_for_bounty eligible_for_submission
        max_severity instruction confidentiality_requirement integrity_requirement availability_requirement }
    }
  }
}`;

const ROWS_PAGE = `query ScopeDownRows($handle: String!, $after: String) {
  team(handle: $handle) {
    bounty_table {
      connection: bounty_table_rows(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { name low medium high critical low_minimum medium_minimum high_minimum critical_minimum
          structured_scope { asset_identifier } }
      }
    }
  }
}`;

export function match(url) {
  if (url.hostname !== 'hackerone.com' && url.hostname !== 'www.hackerone.com') return null;
  const handle = url.pathname.split('/').filter(Boolean)[0];
  if (!handle || RESERVED.has(handle.toLowerCase()) || !/^[\w.-]+$/.test(handle)) return null;
  return { handle };
}

export function inPageArgs({ handle }) {
  return [handle, { team: TEAM_QUERY, scopes: SCOPES_PAGE, rows: ROWS_PAGE }];
}

export async function fetchInPage(handle, queries) {
  try {
    // HackerOne's 404 page forbids all requests through its CSP, so answer before trying.
    if (performance.getEntriesByType('navigation')[0]?.responseStatus === 404) {
      return { error: `There is no HackerOne program at /${handle}.`, reason: 'not_found' };
    }
    // A signed-in POST needs the session's CSRF token. The agent's worker tab shows robots.txt,
    // which has no meta tag, so read the token from the site shell and keep it for the tab.
    const KEY = '__scopedownCsrf';
    const loadCsrf = async () => {
      const html = await (await fetch('/hacktivity/overview', { credentials: 'include', headers: { Accept: 'text/html' } })).text();
      const token = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] || null;
      if (token) Object.defineProperty(globalThis, KEY, { value: token, configurable: true });
      return token;
    };
    const meta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    let csrf = meta || globalThis[KEY] || await loadCsrf();
    const warnings = [];

    const gql = async (query, variables, retried = false) => {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(new URL('/graphql', location.origin), {
        method: 'POST', credentials: 'include', headers, body: JSON.stringify({ query, variables }),
      });
      // A token cached from an older session: replace it once.
      if (res.status === 403 && !meta && !retried) {
        csrf = await loadCsrf();
        return gql(query, variables, true);
      }
      if (!res.ok) throw new Error(`HackerOne API returned HTTP ${res.status}.`);
      const body = await res.json();
      for (const e of body.errors || []) warnings.push(e.message);
      return body.data || {};
    };

    const data = await gql(queries.team, { handle });
    const team = data.team;
    if (!team) {
      return {
        error: warnings[0] ? `HackerOne API: ${warnings[0]}` : `No program "${handle}" is visible to this account. Sign in if it is private.`,
        reason: 'not_found',
      };
    }

    // Follow pagination so large programs come back complete.
    const drain = async (conn, query, pick) => {
      let page = conn?.pageInfo;
      for (let i = 0; page?.hasNextPage && i < 50; i++) {
        const next = pick(await gql(query, { handle, after: page.endCursor }));
        if (!next) break;
        conn.nodes.push(...next.nodes);
        page = next.pageInfo;
      }
    };
    await drain(team.structured_scopes, queries.scopes, (d) => d.team?.connection);
    if (team.bounty_table) {
      await drain(team.bounty_table.bounty_table_rows, queries.rows, (d) => d.team?.bounty_table?.connection);
    }
    return { team, warnings };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

const SEVERITY_ORDER = ['none', 'low', 'medium', 'high', 'critical'];

export function normalize(raw, { fetchedAt }) {
  const t = raw.team;
  const currency = (t.currency || 'usd').toUpperCase();
  const scopes = (t.structured_scopes?.nodes || []).map((s) => {
    // CVSS environmental requirements in vector notation, for example "CR:H/IR:H/AR:M".
    const cia = [
      ['CR', s.confidentiality_requirement],
      ['IR', s.integrity_requirement],
      ['AR', s.availability_requirement],
    ].filter(([, v]) => v && v !== 'not_defined' && v !== 'none')
      .map(([k, v]) => `${k}:${v[0].toUpperCase()}`).join('/');
    return {
      id: s.id || null,
      identifier: (s.asset_identifier || '').trim(),
      type: s.human_asset_type || s.asset_type || '',
      inScope: Boolean(s.eligible_for_submission),
      bounty: s.eligible_for_bounty == null ? null : Boolean(s.eligible_for_bounty),
      maxSeverity: SEVERITY_ORDER.includes(s.max_severity) ? s.max_severity : (s.max_severity || ''),
      cia,
      notes: (s.instruction || '').trim(),
      notesFormat: 'markdown',
    };
  });

  let rewards = null;
  const bt = t.bounty_table;
  const rows = bt?.bounty_table_rows?.nodes || [];
  if (bt && rows.length) {
    const tiers = ['low', 'medium', 'high', 'critical'];
    const columns = tiers.map((k) => bt[`${k}_label`] || k[0].toUpperCase() + k.slice(1));
    rewards = {
      columns,
      rows: rows.map((r) => ({
        label: r.structured_scope?.asset_identifier
          ? `\`${r.structured_scope.asset_identifier}\``
          : (r.name || 'All bounty-eligible assets'),
        cells: tiers.map((k) => money(r[`${k}_minimum`], r[k], currency)),
      })),
      notes: bt.description?.trim() || '',
    };
  }

  const visibility = { public_mode: 'public', soft_launched: 'private' }[t.state] || t.state || null;
  const facts = [];
  if (t.response_efficiency_percentage != null) facts.push(['Response efficiency', `${t.response_efficiency_percentage}%`]);
  if (t.only_cleared_hackers) facts.push(['Access', 'Only cleared hackers']);

  return {
    platform: 'hackerone',
    platformName: 'HackerOne',
    platformId: t.id || null,
    name: t.name || t.handle,
    handle: t.handle,
    url: t.url || `https://hackerone.com/${t.handle}`,
    visibility,
    status: t.submission_state || null,
    bounties: t.offers_bounties == null ? null : Boolean(t.offers_bounties),
    updatedAt: t.policy_setting?.last_policy_change_at || null,
    fetchedAt,
    facts,
    scopes,
    groups: [],
    rewards,
    sections: t.policy ? [{ title: 'Policy', body: t.policy, format: 'markdown' }] : [],
    warnings: raw.warnings || [],
  };
}

function money(min, max, currency) {
  const fmt = (n) => (currency === 'USD' ? '$' : `${currency} `) + Number(n).toLocaleString('en-US');
  if (max == null && min == null) return '';
  if (min != null && max != null && min !== max) return `${fmt(min)} to ${fmt(max)}`;
  return fmt(max ?? min);
}
