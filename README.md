<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/banner-light.svg">
  <img alt="Principle Breach" src=".github/banner-dark.svg" width="100%">
</picture>

# ScopeDown

ScopeDown turns a HackerOne or Bugcrowd program into one clean Markdown file for your AI agent, and connects your agents to the programs you can access, through your own logged-in browser. Agents read scope and policy, check targets, look for duplicates, and draft reports with evidence. You approve each report before it is filed.

## Install

The Chrome Web Store listing is in review, and the Firefox add-on comes next. Until they are live, install a release build:

- **Chrome, Brave, Edge and other Chromium browsers:** download `scopedown-<version>-chrome.zip` from the [latest release](https://github.com/PrincipleBreach/scopedown/releases/latest) and unzip it. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the folder.
- **Firefox 142 or later:** download `scopedown-<version>-firefox.zip`, open `about:debugging`, click **This Firefox**, then **Load Temporary Add-on** and pick the zip. Firefox removes temporary add-ons when it restarts.

Open a program page, click the ScopeDown icon (or press `Alt+Shift+S`), and press `Enter` to copy the Markdown.

### Connect agents

1. Open the browser at least once and sign in to HackerOne or Bugcrowd there.
2. Register the bridge with your browsers. For an unpacked Chromium build, add `--extension-id <id>` with the ID shown at `chrome://extensions`.

   ```bash
   npx @principlebreach/scopedown-mcp install
   ```

3. Click the ScopeDown icon and switch **Agents** on.
4. Add the server to your agent. Any MCP client can run `npx -y @principlebreach/scopedown-mcp` as a stdio server.

   ```bash
   claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp
   ```

`npx @principlebreach/scopedown-mcp doctor` shows which browsers are registered and connected.

## The popup

The program, its platform and visibility, in-scope and out-of-scope counts, the top reward, and the values the program makes you send (a required header, a test-account email). Click a value to copy it.

| Key | Action |
| --- | --- |
| `Enter` or `C` | Copy Markdown |
| `T` | Copy in-scope domains, URLs and IP ranges, one per line |
| `D` | Save as .md |
| `P` | Toggle the preview |
| `Esc` | Close |

## The Markdown

YAML front matter; key rules quoted from the policy (required headers, test accounts, rate limits, automation limits); in-scope and out-of-scope tables; rewards; asset notes; and the program's own text, verbatim apart from lossless clean-up. A column with the same value on every row is stated once, and Bugcrowd scope is grouped by scope group with its rewards and notes.

## What agents can do

| Tool | HackerOne | Bugcrowd |
| --- | --- | --- |
| `status` | Accounts, permissions, platforms and their capabilities | Same |
| `list_programs` | Programs you can submit to, private invitations, search, paging | Accepted private invitations, search, paging |
| `get_program` | Scope and policy as Markdown or JSON, public or private | Same, from the engagement brief |
| `check_scope` | Verdict per host, URL, IP or CIDR | Same, including `{subdomain}` targets |
| `list_scope_changes` | Assets added, removed or changed on every program you can submit to, and new invitations, dated by HackerOne | Same, dated by the brief version that made the change |
| `get_report_requirements` | Required fields, the program's custom fields, assets, filing route | Required fields, targets, quota, filing route |
| `get_weaknesses` | The program's weaknesses (CWE) | VRT entries by full id with priority P1 to P5 |
| `search_disclosed_reports` | Hacktivity | Not available on Bugcrowd |
| `list_my_reports`, `get_my_report` | Your reports and their threads | Your submissions |
| `draft_report`, `update_draft`, `attach_file`, `remove_attachment` | Drafts with evidence, validated against the program | Same |
| `get_draft`, `list_drafts` | Outcome, waiting up to 10 minutes for your decision | Same |

### Fresh scope

New scope is where nobody has looked yet. ScopeDown checks every program you can submit to, public and private, and records what changed:

- **What:** assets added, removed, or changed (in scope, bounty eligibility, max severity, group, notes), new invitations and launches, and programs you lost.
- **When:** the platform's own date where it keeps one. HackerOne dates every asset; Bugcrowd dates every version of a brief. The first check already lists what the platforms added in the last 30 days.
- **How fast:** about 30 seconds for 750 HackerOne programs, a minute the first time. Bugcrowd allows one request a second: its first check takes about 10 minutes for 300 engagements, then public engagements are rechecked at most every 2 hours and private ones every check.
- **Where:** the console's **Scope** page groups changes by program with filters (kind, period, platform, asset type, private or public, in scope, bounty, search) and copies new targets one per line. Agents get the same through `list_scope_changes`. Settings can check every 30 minutes and notify you about new in-scope assets.

A removal is only recorded from a complete read, so a failed request or an expired session never makes scope look gone.

### How a report gets filed

1. The agent reads the program (`get_program`), checks its targets (`check_scope`), and looks for duplicates.
2. `get_report_requirements` tells it what this program needs: required fields, custom fields with their allowed values, in-scope assets, and the filing route.
3. `get_weaknesses` finds the weakness. On Bugcrowd the agent picks the most specific VRT entry; its priority becomes the draft's severity unless the agent sets one.
4. `draft_report` validates everything against the live program and puts the draft, with any evidence files, in the agent console. The badge counts drafts waiting.
5. You review it, edit it if needed, and either:
   - **Submit** (HackerOne, route `direct`): ScopeDown uploads the evidence and files the report as you, and the agent sees the report URL.
   - **Open in the platform's form**: always on Bugcrowd (its form has a captcha) and for HackerOne programs with required custom fields (route `platform_form`), and available on any HackerOne draft. ScopeDown opens the form and fills it in the new tab, then you check it and submit there. The platform keeps it as your draft until you do.
     - **Bugcrowd:** title, target, VRT, URL, description with the request, and evidence files. You also tick the terms and solve the captcha.
     - **HackerOne:** asset, weakness, severity, title, description, impact, the program's custom fields, and evidence files, with `{{attachment:name}}` turned into HackerOne's inline references.
     - The console shows what was filled and anything left to do by hand, lists every field in the platform's order (one click to copy), and marks the draft filed once the report shows up in your list.
   - **Reject** with a note the agent reads and can act on with `update_draft`.
6. Programs you put on the auto-submit list (meant for your own sandbox programs) skip step 5 on the `direct` route.

## Privacy and permissions

Nothing is sent to Principle Breach or anyone else: no analytics, no remote code, no AI calls. Requests go from your browser to the platform, with your session. Copying a program needs only `activeTab` and `scripting`; agent access asks for `nativeMessaging`, `notifications` and the two platform sites when you switch it on. `alarms` runs the scope check every 30 minutes, only if you turn that on. Details: [PRIVACY.md](PRIVACY.md). How it works and the security model: [ARCHITECTURE.md](ARCHITECTURE.md).

## Platforms

Each platform is one adapter under `src/platforms/<id>/` behind a tested contract, so adding YesWeHack or Intigriti does not touch shared code. See [CONTRIBUTING.md](CONTRIBUTING.md#add-a-platform).

Tested on Chrome and Brave on macOS. Firefox builds pass Mozilla's validator; Linux and Windows bridge installs are implemented but not yet tested.

## Development

Node 22 or later. `npm run build` also needs the `zip` command.

```bash
npm install && npm test && npm run lint
npm run build                   # dist/scopedown-<version>-chrome.zip and -firefox.zip
(cd mcp && npm install && npm test)
```

Loading your checkout in a browser and running an agent against local code: [CONTRIBUTING.md](CONTRIBUTING.md#local-development).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a>. Offensive security research.</sub>
