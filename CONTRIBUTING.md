# Contributing to ScopeDown

ScopeDown is built by [Principle Breach](https://principlebreach.com).
Contributions are welcome.

## Ground Rules

- New behavior ships with focused tests. A bug fix reproduces the failure first.
- Agents only reach fixed operations. Never add an operation that forwards a query, path or mutation an agent wrote.
- Nothing is filed without the user, except on programs the user put on the auto-submit list.
- Program, report and agent text is untrusted. Pages build DOM nodes; nothing goes through `innerHTML`.
- Functions injected into a platform tab stay self-contained: no imports, no outer variables.
- Platform names appear only under `src/platforms`. Shared code talks to adapters.

## Local Development

Node 22 or later, and the `zip` command for `npm run build`.

```bash
npm install
npm run fonts          # fetch Switzer from Fontshare (optional for development)
npm test               # extension tests
npm run lint           # store manifest checks and Mozilla's validator
npm run build          # store zips in dist/
cd mcp && npm install && npm test
```

Load the extension unpacked from the repository root (`chrome://extensions`, Developer mode, Load unpacked). The `key` in `manifest.json` keeps the development ID stable, which the bridge allowlists. For Firefox 142 or later, run `npm run lint` and load `dist/firefox/manifest.json` from `about:debugging`; the repository manifest is the Chromium one.

To run agents against your checkout instead of the npm release, register the bridge and the server from it:

```bash
node mcp/bin/scopedown-mcp.js install
claude mcp add scopedown-dev -- node "$PWD/mcp/bin/scopedown-mcp.js"
```

`npm run fixtures` refreshes `test/fixtures` from live public programs. Never commit data from private programs.

## Add a Platform

A platform is one folder under `src/platforms/<id>/`. Shared code does not change.

1. `program.js`: `match(url)` returns the program handle for the platform's program URLs; `fetchInPage(...)` runs inside the platform tab and returns raw program data; `normalize(raw, { fetchedAt })` returns the shared program shape (see the HackerOne and Bugcrowd versions).
2. `agent.js`: the agent operations, built only from fixed requests through `runInPlatform(ORIGIN, fn, args)` and `pageRequest`. Required: `account`, `program`, `listPrograms`, `weaknesses`, `resolveWeakness`, `requirements`, `myReports`, `findFiled`, `formUrl`, `formFields`. Optional: `myReport`, `disclosed`, `file` (direct filing; without it, drafts are finished in the platform's form), `severityFor`, `prefill` (`{ func, args(draft, files) }`: fills the platform's own form in the tab the hand-off opens; `func` is self-contained and returns `{ filled, missed }` or `{ error }`; it must never submit).
3. `index.js`: the adapter descriptor with `id`, `label`, `origin` and `weaknessLabel`.
4. Register it in `src/platforms/index.js` and add its origin to `optional_host_permissions` in `manifest.json`.
5. Capture public fixtures and add labeled scope cases. `test/adapters.test.js` checks the contract for every registered adapter.

The MCP server needs no change: platform ids are validated by the extension, and `status` lists what each platform supports.

## Releasing

The extension and the MCP server version separately.

**Extension**

1. Set the version in `manifest.json`, `package.json` and `src/render.js`, and add a `## <version>` section to `CHANGELOG.md`.
2. `npm test` and `npm run lint`.
3. Commit, then push a signed tag: `git tag -s v<version> -m v<version> && git push origin v<version>`. The release workflow tests, builds both zips, and publishes a GitHub release with `SHA256SUMS`, build provenance and the changelog section as notes.
4. Upload the release zips to the Chrome Web Store, Edge Add-ons and addons.mozilla.org. A store's first upload gives its extension ID: add it to `CHROMIUM_EXTENSION_IDS` in `mcp/src/paths.js` so the bridge accepts that build, and release the MCP server.

**MCP server**

1. Set the version in `mcp/package.json` and add a `## scopedown-mcp <version>` section to `CHANGELOG.md`.
2. `cd mcp && npm test && npm audit --omit=dev && npm publish --access public`.

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a> — offensive security research.</sub>
