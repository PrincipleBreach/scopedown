# ScopeDown

Browser extension (Chrome, Brave, Edge, Firefox; Manifest V3) plus an MCP server that gives AI agents a hunter's HackerOne and Bugcrowd access through the hunter's own browser.

## Commands

- `npm test`: extension tests (`node --test test/`).
- `npm run lint`: builds the store manifests without fonts and runs Mozilla's validator on the Firefox build (warnings fail).
- `npm run fonts`: fetch Switzer from Fontshare into `fonts/` (git-ignored, license forbids redistribution).
- `npm run build`: store zips in `dist/`.
- `cd mcp && npm test`: bridge and MCP server tests.

## Layout

- `src/platforms/<id>/`: one adapter per platform (`program.js`, `agent.js`, `page.js`, `index.js`); `src/platforms/index.js` is the registry and documents the contract. The extension point for new platforms.
- `src/agent/`: platform-neutral agent layer: `ops.js` (the only operations agents can run), `drafts.js` (validation, approval, filing, resume), `runner.js` (runs functions in a platform tab, rate limit, cache), `scope.js` (scope checker), `files.js` (evidence), `bridge.js` (native messaging), `store.js`.
- `src/render.js`, `src/markdown.js`: program to Markdown.
- `src/popup.*`, `src/console.*`, `src/ui/`, `src/base.css`: the interface on the Principle Breach design tokens.
- `mcp/`: `scopedown-mcp` (stdio MCP server, native messaging host, installer).
- `ARCHITECTURE.md`: processes, security model, protocol, filing.

## Conventions

- Agents reach fixed operations only; the extension validates every parameter again.
- Nothing is filed without the user except on auto-submit programs.
- No `innerHTML`; untrusted text becomes text nodes. Links are http(s) only.
- Page functions passed to `chrome.scripting.executeScript` are self-contained.
- Platform names only under `src/platforms`.
- Brand: paper #f7f7f5, ink #20211f, one red #b82419 as a line color only, Switzer and JetBrains Mono, 4px radius.
- Interface: the principlebreach.com primitives in `src/base.css`: ruled rows (`.rows`/`.row`), mono caps labels, a mono eyebrow with a red square, ink actions with a travelling arrow, the draft as a report sheet. No boxed cards or pill badges.
- Fixtures are public programs only.
