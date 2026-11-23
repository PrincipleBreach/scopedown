<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/banner-light.svg">
  <img alt="Principle Breach" src=".github/banner-dark.svg" width="100%">
</picture>

# ScopeDown

ScopeDown turns a HackerOne or Bugcrowd program into one clean Markdown file for your AI agent, and connects your agents to the programs you can access, through your own logged-in browser. Agents read scope and policy, check targets, look for duplicates, and draft reports with evidence. You approve each report before it is filed.

## Install

1. Install the extension from the Chrome Web Store or addons.mozilla.org, or load this folder unpacked.
2. Open a program page, click the ScopeDown icon (or press `Alt+Shift+S`), and press `Enter` to copy the Markdown.

To connect agents:

```bash
npx @principlebreach/scopedown-mcp install
claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp
```

Then click the ScopeDown icon and switch **Agents** on. Any MCP client can run `npx -y @principlebreach/scopedown-mcp` as a stdio server.

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
| `get_report_requirements` | Required fields, the program's custom fields, assets, filing route | Required fields, targets, quota, filing route |
| `get_weaknesses` | The program's weaknesses (CWE) | VRT entries by full id with priority P1 to P5 |
| `search_disclosed_reports` | Hacktivity | Not available on Bugcrowd |
| `list_my_reports`, `get_my_report` | Your reports and their threads | Your submissions |
| `draft_report`, `update_draft`, `attach_file`, `remove_attachment` | Drafts with evidence, validated against the program | Same |
| `get_draft`, `list_drafts` | Outcome, waiting up to 10 minutes for your decision | Same |

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

Nothing is sent to Principle Breach or anyone else: no analytics, no remote code, no AI calls. Requests go from your browser to the platform, with your session. Copying a program needs only `activeTab` and `scripting`; agent access asks for `nativeMessaging`, `notifications` and the two platform sites when you switch it on. Details: [PRIVACY.md](PRIVACY.md). How it works and the security model: [ARCHITECTURE.md](ARCHITECTURE.md).

## Platforms

Each platform is one adapter under `src/platforms/<id>/` behind a tested contract, so adding YesWeHack or Intigriti does not touch shared code. See [CONTRIBUTING.md](CONTRIBUTING.md#add-a-platform).

Tested on Chrome and Brave on macOS. Firefox builds pass Mozilla's validator; Linux and Windows bridge installs are implemented but not yet tested.

## Development

```bash
npm install && npm test && npm run lint
cd mcp && npm install && npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a> — offensive security research.</sub>
