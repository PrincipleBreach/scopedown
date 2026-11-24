# Privacy Policy

ScopeDown is a browser extension and a local MCP server by Principle Breach. This policy covers both.

## What ScopeDown does not do

- It does not send any data to Principle Breach or to any third party.
- It has no analytics, telemetry, advertising, remote code or remote configuration.
- It does not call any AI service. Agents you connect run under your own control.

## What stays on your computer

- **Program data** (scope, policy, rewards) is read from HackerOne or Bugcrowd inside your browser, with your existing session, when you click the extension or an agent you connected asks for it. It is cached in memory for a few minutes.
- **Drafts, evidence files, settings and the activity log** are stored in your browser's extension storage and IndexedDB. They stay until you delete them in the agent console or remove the extension.
- **Scope history**: the scope watch keeps each program's assets (name, type, scope and bounty flags; asset notes only as a short fingerprint) and the changes it found, in IndexedDB, for up to 180 days or 20,000 changes. Clear it under Settings, Data.
- **The bridge** (the MCP server and its native messaging host) exchanges messages with the extension over a socket in `~/.scopedown` that only your OS user can open, and writes a small log there.

## What leaves your computer

Only the requests your browser makes to the platform you are using: reading programs and reports, checking programs for scope changes (when you or an agent ask, or every 30 minutes if you turn that on), and, after your approval or on programs you put on the auto-submit list, filing a report with its evidence files. These requests go directly from your browser to the platform, under its own privacy policy.

## Permissions

- `activeTab`, `scripting`: read the program page you clicked the extension on.
- `storage`: keep drafts, settings and the activity log.
- `offscreen` (Chrome): convert program briefs from HTML to Markdown.
- `alarms`: check scope every 30 minutes, only if you turn that on in Settings.
- Optional, requested only when you switch Agents on: `nativeMessaging` (talk to the local bridge), `notifications` (tell you a draft is waiting, or that new scope appeared), and access to hackerone.com and bugcrowd.com (run agent requests there).

## Contact

hello@principlebreach.com

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a>. Offensive security research.</sub>
