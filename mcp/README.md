# scopedown-mcp

The MCP server for [ScopeDown](https://principlebreach.com/?utm_source=github&utm_medium=profile&utm_campaign=scopedown-mcp-readme) by Principle Breach. It gives your AI agents the HackerOne and Bugcrowd access you already have in your browser: the programs you can submit to, their scope and rules, your reports, and report drafts that you approve before they are filed.

Your session never leaves the browser. The agent talks to this server, the server talks to the ScopeDown extension over a local socket only your user can open, and the extension makes each request from inside a HackerOne or Bugcrowd tab.

## Set up

1. Install the [ScopeDown extension](https://github.com/PrincipleBreach/scopedown#install) and sign in to HackerOne or Bugcrowd in that browser.
2. Register the bridge with your browsers. Each browser must have been opened at least once.

   ```sh
   npx @principlebreach/scopedown-mcp install
   ```

3. Click the ScopeDown icon and switch **Agents** on.
4. Add the server to your agent harness. Claude Code:

   ```sh
   claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp
   ```

   Any other MCP client: run `npx -y @principlebreach/scopedown-mcp` as a stdio server.

`npx @principlebreach/scopedown-mcp doctor` shows which browsers are registered and connected, `uninstall` removes everything it installed, and `--version` prints the version.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connected browsers, signed-in accounts and their email aliases, what you allowed, drafts waiting |
| `get_email_alias` | Your platform email aliases for the test accounts programs ask for, and `username+tag@` addresses for several accounts |
| `list_programs` | Programs you can submit to; `private_only`, `query`, paging |
| `get_program` | The program as agent-ready Markdown: key rules, scope tables, rewards, full policy, headed by your email alias for that platform |
| `check_scope` | Verdict per host, URL, IP or CIDR: in scope, out of scope, or not listed |
| `get_report_requirements` | What a report to this program needs: required fields, custom fields and their allowed values, assets, quota, and whether it is filed directly or finished in the platform's form |
| `get_weaknesses` | HackerOne weaknesses, or Bugcrowd VRT entries by full id with their P1 to P5 priority |
| `search_disclosed_reports` | HackerOne Hacktivity, for duplicate checks |
| `list_my_reports`, `get_my_report` | Your reports and, on HackerOne, the full thread |
| `draft_report` | A draft for you to review, with optional evidence files; validated against the program's scope |
| `attach_file`, `remove_attachment` | Evidence on a draft: images, video, logs, HAR, PDF, ZIP; 20 MB each, 10 per draft |
| `update_draft` | Revise a draft, for example after you reject it with a note |
| `get_draft`, `list_drafts` | Draft status; `get_draft` can wait up to 10 minutes for your decision |

Lists return `next_cursor` when there is more; pass it back as `cursor` with the platform. Reference an attached file inside a report with `{{attachment:file-name}}`.

## What agents cannot do

- Run their own queries. Every request is one of the operations above, written in the extension.
- File a report without you. Drafts wait on the extension's review page, unless you put a HackerOne program on the auto-submit list (meant for your own sandbox programs).
- Publish on Bugcrowd, or file HackerOne programs with required custom fields. Those drafts are finished in the platform's own form, with every field copied for you.
- Flood an account. The extension allows about 3 platform requests per second and caches program data for 5 minutes.

Every operation is listed in the extension's activity log.

## Requirements

Node 22 or later. Tested with Chrome and Brave on macOS. Edge, Arc, Chromium, Vivaldi and Firefox registration, and Linux and Windows installs, are implemented but not yet tested.

## License

MIT. See [LICENSE](LICENSE). Source, issues and the security policy: [github.com/PrincipleBreach/scopedown](https://github.com/PrincipleBreach/scopedown).

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a>. Offensive security research.</sub>
