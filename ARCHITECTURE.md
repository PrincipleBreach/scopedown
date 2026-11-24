# ScopeDown agent bridge

ScopeDown gives a hunter's AI agents the same program access the hunter has in their browser: programs, scope, rules, past reports, and report submission. The browser stays the only place that holds a session. A human approves anything that leaves the account unless they switch on auto-submit for a specific program.

## Processes

```
agent harness (Claude Code, Cursor, ...)
   │ stdio, MCP
   ▼
scopedown-mcp            MCP server, started by the harness
   │ newline-delimited JSON over a Unix socket in ~/.scopedown/sockets (0700)
   ▼
scopedown-mcp host       native messaging host, started by the browser
   │ native messaging (length-prefixed JSON on stdio)
   ▼
ScopeDown extension      background service worker in the hunter's browser
   │ chrome.scripting in a hackerone.com or bugcrowd.com tab (MAIN world)
   ▼
HackerOne GraphQL, Bugcrowd JSON endpoints, with the hunter's own session
```

Two Node processes are needed because each side starts its own: the browser starts the native host when the extension calls `connectNative`, and the harness starts the MCP server. They meet at a socket file only the user can open. Each host writes its own socket (`<browser>-<pid>.sock`), so several browsers or profiles can be connected at once and the MCP server can address each.

## Why requests run inside a platform tab

The extension does not call the platforms from its own origin. It runs a small function inside an open `hackerone.com` or `bugcrowd.com` tab, so every request is a normal same-origin request from the site itself: the session cookie, the CSRF token and the `Origin` header are exactly what the site expects. If no such tab is open, the extension opens one in the background (`/robots.txt`, no page scripts) and closes it after three idle minutes.

## Security model

The extension is the enforcement point. The MCP server and the host only relay.

- **Off by default.** Agent access is a switch in the popup. Turning it on requests the optional permissions (`nativeMessaging`, `notifications`, and host access to the two platforms). Turning it off disconnects the bridge.
- **Fixed operations only.** The bridge accepts a short list of named operations with validated parameters. Every GraphQL document and URL is written in the extension. An agent cannot send a query, a mutation or a path of its own.
- **Writes need a human.** `draft_report` stores a draft locally. Nothing reaches the platform until the hunter presses Submit on the review page, or has switched on auto-submit for that one program. Bugcrowd publishing is protected by a captcha, so Bugcrowd drafts always end in the hunter's own browser tab.
- **Rate limits and caching.** At most 3 platform requests per second per platform, and program data is cached for 5 minutes, so an agent loop cannot hammer an account into a ban.
- **Visible.** The badge counts drafts waiting for review, a notification announces each new draft, and the review page keeps an activity log of every operation an agent ran.
- **Local only.** Nothing is sent anywhere except the platform requests the hunter's browser makes. The socket directory is created with mode 0700.
- **Untrusted text.** Program policies and report threads are written by other people. Tool results label them as data so agents do not follow instructions hidden inside them.

Out of scope: a malicious process already running as the same OS user. It could read the browser's cookies directly.

## Platform adapters

Each platform is a folder under `src/platforms/<id>/`: `program.js` reads and normalizes a program (also used by the popup), `agent.js` implements the agent operations from fixed requests, `page.js` holds functions injected into the platform's tabs, and `index.js` describes the adapter. `src/platforms/index.js` registers adapters and documents the contract; `test/adapters.test.js` enforces it. Capabilities a platform lacks are absent from its adapter (Bugcrowd has no `file` and no `disclosed`), and the operations and the console adjust: `status` reports each platform's capabilities to agents.

`requirements(handle)` is how a platform describes what a report needs. It returns whether the account can submit, the filing route (`direct` or `platform_form`), the required standard fields, the program's custom fields (key, label, type, allowed values, pattern, help), the in-scope assets with the platform's ids for them, and any quota. Drafts are validated against it.

## Protocol

Requests and responses are JSON objects. The MCP server sends:

```json
{ "type": "request", "id": "7f3c…", "op": "check_scope", "params": { … }, "client": { "name": "claude-code", "version": "2.1" } }
```

The extension answers with `{ "type": "response", "id": "7f3c…", "ok": true, "result": { … } }` or `{ "ok": false, "error": { "code": "not_in_scope", "message": "…" } }`. On connect the extension sends `{ "type": "hello", "extension": { "version", "browser", "install" } }`, which the host keeps and returns for `{ "type": "status" }` without a round trip.

## Operations

| Operation | Reads or writes | Notes |
| --- | --- | --- |
| `status` | reads | Browsers, signed-in accounts, permissions, Bugcrowd weekly quota, drafts waiting |
| `list_programs` | reads | Programs the hunter can submit to; private only, query and paging |
| `get_program` | reads | The ScopeDown Markdown and a structured summary |
| `check_scope` | reads | Per-target verdict: in scope, out of scope or not listed, with the matching asset |
| `list_scope_changes` | reads | Scope changes on every program, dated, with filters; checks the platforms first |
| `get_report_requirements` | reads | Required fields, custom fields, assets, quota, filing route |
| `get_weaknesses` | reads | HackerOne program weaknesses, Bugcrowd VRT entries by full id with priority |
| `search_disclosed_reports` | reads | HackerOne Hacktivity, for duplicate checks |
| `list_my_reports`, `get_my_report` | reads | The hunter's own reports and their threads |
| `draft_report`, `update_draft` | local write | Validated against the program: the asset must be in scope, the weakness must exist |
| `attach_file`, `remove_attachment` | local write | Evidence files, sent in verified chunks, stored in IndexedDB |
| `get_draft`, `list_drafts` | reads | `get_draft` can wait up to 10 minutes for a decision |

Every list returns `next_cursor` when there is more.

## Scope watch

`src/agent/watch.js` finds scope changes on every program the hunter can submit to. Adapters that support it have `agent.watch`: `list()` (every program, or an error: never a partial list), `signals(programs)` (a cheap change signal per program), `scopes(items)` (the assets now, as one or more dated snapshots), and optionally `due(record)` and `rotate`.

A sweep, per platform:

1. List the programs. Only a complete list can show that a program went away.
2. Read the signal of each program due for a check.
   - HackerOne: the asset count and the newest asset's `created_at`, for 40 programs per GraphQL request (`teams(where: { handle: { _in } })`, three requests per visit to the tab). `last_updated_at` is not used: assets are often added after it.
   - Bugcrowd: the engagement's `changelog.json`, whose newest version id is the signal. Private engagements every sweep, public ones at most every 2 hours, one request a second.
3. Read the scope of programs whose signal moved, new programs, and on the first sweep the programs the platform changed in the last 30 days. HackerOne also re-reads 30 programs per sweep, the ones read longest ago, because an edit to an existing asset moves no signal.
   - HackerOne: five programs' first page per request, then larger programs page on their own.
   - Bugcrowd: the version documents tagged `targets` since the stored one, plus the latest. Without a stored snapshot, the version before the oldest one read is the baseline.
4. Compare with the stored snapshot by asset id (HackerOne's structured scope id, Bugcrowd's target id, both stable). Each change is dated by the platform where it can be (`created_at`, `updated_at`, or the brief version's `publishedAt`) and otherwise by the sweep. A partial read records no removals.

Snapshots, events and per-platform state live in the IndexedDB database `scopedown-watch`. Events are kept 180 days, 20,000 at most. A sweep from the last 10 minutes is reused. `list_scope_changes` starts a sweep and waits up to 45 seconds per request; the MCP server polls until it ends or 150 seconds pass. With the Settings switch on, an alarm runs a sweep every 30 minutes and notifies about new in-scope assets and programs.

## Evidence files

The MCP server reads a file the agent names (evidence types only, up to 20 MB) and sends it in 512 KB chunks with its SHA-256. The extension verifies the hash, stores the bytes in IndexedDB, and lists the file on the draft. Up to 10 files of 20 MB per draft. The console shows each file, previews images, and opens agent-supplied HTML or SVG only as a download, never in the extension's origin.

## Report submission

A draft's route comes from the platform's requirements. `direct` drafts are filed by the adapter's `file()` after approval. `platform_form` drafts (all Bugcrowd drafts, and HackerOne programs with required custom fields, which `createReport` cannot carry) are reviewed in the console and finished in the platform's own form.

HackerOne: the extension files a draft the way HackerOne's report form does. Each evidence file goes to `POST /attachments`, then one `createReport` call carries the title, description, impact, severity, weakness, asset and attachment ids. `{{attachment:name}}` in the text becomes HackerOne's inline `{F<id>}`. "Open HackerOne form" opens the report form and fills it through the adapter's `prefill` (`fillHackerOneForm`): it fills the text and evidence first, then picks the asset, weakness and severity, then re-checks every field for up to three rounds, because HackerOne's autosave replies can reset a field filled while they were in flight. Custom fields are matched by their labels. `{{attachment:name}}` becomes `{F<id>}` once the files are uploaded. HackerOne keeps the filled form as the hunter's draft for that program.

Bugcrowd: after approval the extension opens the engagement's submission form and fills it in that tab through the adapter's `prefill` (`fillBugcrowdForm` in `page.js`): title, target, VRT (clicked along its category path until the form holds the full dotted id), URL, description with the HTTP request, and evidence files. It never ticks the terms box or presses a submit button; the hunter checks the form, solves the captcha and submits. Bugcrowd saves the filled form as a draft on its side until then. What was filled and what was missed is stored on the draft (`prefill`) and shown in the console, which also lists every field for copy and paste. A handed-off draft on either platform is marked submitted once a report with its title shows up in the hunter's list.

Filing survives a restart of the extension's background worker. Each finished step is saved on the draft; a draft left in `submitting` resumes on the next start. Uploaded files are not sent twice, and the report is never filed twice: the attempt is recorded before `createReport`, and a resumed run first looks for a report with the same title filed since then. Waits happen in the MCP server as short polls, so no browser request lasts long and a worker restart costs one poll.

Draft states: `pending_review`, then `submitting` and `submitted`; or `rejected` with the hunter's note; or `handed_off`; or `failed` with the platform's error. Agents can revise a draft with `update_draft` while it is `pending_review`, `rejected` or `failed`.

## Console

`src/console.html` is the hunter's side: drafts with filters and paging, a draft page with a rendered preview and an editor, evidence, history, the activity log, the Scope page (changes grouped by program, with filters in the URL, live progress while a check runs, and new targets copied one per line), and settings (agent access per platform, the scope watch timer, auto-submit, setup checklist, local data). Agent-written Markdown is rendered into DOM nodes, never through `innerHTML`, with links limited to http(s) and remote images shown as links.

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a>. Offensive security research.</sub>
