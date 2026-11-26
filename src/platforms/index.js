// Platform registry. Each platform is one adapter folder (program.js, agent.js, index.js);
// nothing outside src/platforms names a platform. To add one, see CONTRIBUTING.md.
//
// Adapter contract (checked by test/adapters.test.js):
//   id, label, origin, weaknessLabel
//   program: match(url) -> target | null, inPageArgs(target), fetchInPage(...) (runs in the
//            platform tab, self-contained), normalize(raw, { fetchedAt }) -> program
//   agent (required): account, program, listPrograms, weaknesses, resolveWeakness,
//            requirements, myReports, findFiled, formUrl, formFields
//   agent (optional): myReport, disclosed, file (direct filing), severityFor,
//            prefill: { finish, func, args(draft, files) } fills the platform's own form in the tab
//            the hand-off opens (func runs there, self-contained) and returns
//            { filled: [field], missed: [reason] } or { error }
//            watch: { list, signals, scopes, due?, rotate? } finds new and changed scope (see
//            src/agent/watch.js)
//            alias: { plus_tags: 'supported' | 'not_documented', note, docs } describes the
//            email alias the platform forwards to the hunter; account() then returns email_alias
import hackerone from './hackerone/index.js';
import bugcrowd from './bugcrowd/index.js';

export const ADAPTERS = [hackerone, bugcrowd];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

export function getAdapter(id) {
  return BY_ID.get(id) || null;
}

// Returns { adapter, target } for a supported program URL, or null.
export function detect(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  for (const adapter of ADAPTERS) {
    const target = adapter.program.match(url);
    if (target) return { adapter, id: adapter.id, target };
  }
  return null;
}

// What switching Agents on asks the browser for. Origins must also be listed under
// optional_host_permissions in manifest.json.
export const AGENT_PERMISSIONS = {
  permissions: ['nativeMessaging', 'notifications'],
  origins: ADAPTERS.map((a) => `${a.origin}/*`),
};
