# Changelog

## 1.2.0

Email alias
- New `get_email_alias` tool: the address each platform forwards to you, `username@wearehackerone.com` and `username@bugcrowdninja.com`, for the test accounts programs ask for. `tags` gives one address per test account, such as `username+victim@wearehackerone.com`. HackerOne documents these tagged addresses; Bugcrowd does not, and the tool says so.
- `status` shows the alias next to each signed-in account, and `get_program` names it for agents.
- HackerOne's alias is the one its API returns. Bugcrowd's is built from your profile username, as Bugcrowd's docs define it. ScopeDown keeps only the username from that profile.
- Bugcrowd: `status` knows your username before your first submission.

## scopedown-mcp 1.2.0

- `get_email_alias`: the user's HackerOne and Bugcrowd email aliases, with tagged addresses for several test accounts, whether each platform documents tags, and a note that mail to them reaches the user.
- `get_program` starts with the user's alias for that platform, above the line that marks the program text as untrusted. Only a plain address is printed.
- The server instructions tell agents to sign up for test accounts with the alias, and to ask the user for links or codes sent to it.
- `status` describes the alias on each account.
- Needs ScopeDown 1.2.0 in the browser.

## 1.1.0

Scope watch
- New `list_scope_changes` tool: assets added, removed or changed on every program you can submit to, public and private, plus new invitations and programs you lost. Dated by HackerOne's asset dates and Bugcrowd's brief versions; the first check lists the last 30 days.
- Filters across every program: platform, program, period, kind of change, asset type (named the same on both platforms), in scope, bounty, minimum severity, private or public, and words. Results can be grouped by program.
- The console has a Scope page with the same filters, live progress, and new targets copied one per line.
- Settings can check every 30 minutes and notify you about new in-scope assets (needs the `alarms` permission, which shows no prompt).
- A removal is only recorded from a complete read. An expired Bugcrowd session, a timeout or a rate limit never makes scope look gone.
- Agent requests can run several platform requests in one visit to the tab, three at a time.

## scopedown-mcp 1.1.0

- `list_scope_changes`: what changed in the scope of every program the user can submit to, with filters for platform, program, period, kind of change, asset type, in scope, bounty, minimum severity, private or public, and words, optionally grouped by program. It waits for the extension's check in steps of 45 seconds, up to 150 seconds, and says when the check is still running.
- The server instructions point agents to it for fresh attack surface.
- Needs ScopeDown 1.1.0 in the browser.

## 1.0.1

HackerOne
- Agent requests no longer fail with HTTP 403 in ScopeDown's background tab: it reads the session's CSRF token from the site when the page has none.
- `list_programs` with `private_only` pages through every private program. Unknown cursors are `bad_request`, and HTTP errors are errors, never an empty list or a sign-out.
- `get_my_report` says whose report it is (`reporter`, `yours`). For another hunter's disclosed report it returns the published body, `disclosed_at`, and the team's and hunter's summaries, which are the whole write-up of a limited disclosure.
- Custom field formats are checked the way HackerOne checks them (Ruby patterns such as `\A...\z`), and a mismatch quotes the program's own hint.

Bugcrowd
- `list_my_reports` pages through every submission with no gaps or repeats, drafts left out. A program filter matches the engagement exactly, by its name, and asks Bugcrowd to filter on its side.
- `list_programs` search runs on Bugcrowd's side, so it covers every engagement, not one page of them.
- `get_program` reads the engagement asked for, never a longer one that starts the same, and a missing engagement is `not_found`.

Agent and drafts
- A platform tab showing an error page is skipped. A background tab that reloads while a request runs is waited for and tried again, and a failed one is closed before another opens.
- Submitting a draft checks it is the version you reviewed. If the agent changed it after you opened it, you are asked to read it again.
- Drafts are stored one write at a time. Past 200, the oldest finished drafts are removed with their files.
- Auto-submit stops, and says why in the draft's history, when an evidence file is refused. A file the agent replaced after a failed attempt is uploaded again, not reused.
- `status` asks both platforms at once.

## scopedown-mcp 1.0.2

- With several browsers connected, the default one stays the same when a browser restarts.
- Messages split inside a multi-byte character decode correctly.
- On Windows, the host creates its folder on first run.
- Tool descriptions: `get_my_report` explains `yours` and disclosed summaries, and `list_programs` says a page can be short, so page until `next_cursor` is null.

## scopedown-mcp 1.0.1

- `scopedown-mcp --version` prints the version, and the help names it.
- Needs Node.js 22 or newer.
- Install and connection messages name the popup's **Agents** switch, and say to open a browser once when none is found.

## 1.0.0

First public release.

- Copy any HackerOne or Bugcrowd program as agent-ready Markdown: key rules, scope tables, rewards, notes and the full policy.
- MCP server with 15 tools: programs, scope and policy, scope checks, report requirements, weaknesses and VRT, disclosed reports, your reports, drafts with evidence files.
- Agent console: review, edit, submit or reject drafts; activity log; per-platform access; auto-submit for chosen programs.
- HackerOne: drafts are filed after your approval, with attachments. Programs with required custom fields, or any draft you prefer to finish yourself, open in HackerOne's form already filled in: asset, weakness, severity, text, custom fields and evidence.
- Bugcrowd: approving a draft opens Bugcrowd's form and fills it in your browser (title, target, VRT, URL, description, request and evidence files); you tick the terms, solve the captcha and submit. Anything it cannot set is listed in the console, one click to copy.
- Platform adapters: each platform is one folder behind a tested contract.

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a>. Offensive security research.</sub>
