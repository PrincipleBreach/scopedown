# Security Policy

## Reporting a Vulnerability

Report it privately through [GitHub](https://github.com/PrincipleBreach/scopedown/security/advisories/new)
or by email to **security@principlebreach.com**. Do not open a public issue for an
unpublished vulnerability in ScopeDown, its MCP server, or its release pipeline.

Include what you have:

- The extension version (`chrome://extensions`), the MCP server version (`npx @principlebreach/scopedown-mcp --version`), and the browser.
- The smallest steps or MCP calls that reproduce the issue.
- The impact and affected component.
- Any disclosure constraints and preferred credit.

Remove session cookies, program data and report text that are not required for the reproduction.

## Response Targets

| Stage | Target |
| --- | --- |
| Acknowledgment | 3 business days |
| Initial assessment | 10 business days |
| Fix or mitigation for a confirmed issue | 90 days |

We coordinate disclosure and credit with the reporter.

## Supported Versions

Security fixes land on the latest release. Earlier releases do not receive backports unless a release advisory says otherwise.

## Scope

In scope:

- An agent or web page making the extension run a request or mutation that is not one of the fixed operations in `src/agent/ops.js`.
- A report filed without the user's approval on a program that is not on the user's auto-submit list.
- Reading or changing drafts, settings or files from outside the extension's own pages and the local bridge.
- Access to the bridge socket by another OS user.
- Script execution in the extension's pages from program, report or agent text.
- Release artifacts and the native host installer.

Out of scope: a malicious process already running as the same OS user (it could read the browser's cookies directly), and the platforms' own vulnerabilities, which belong in their programs.

## Design Boundary

The extension is the enforcement point: the MCP server and the native host only relay. See [ARCHITECTURE.md](ARCHITECTURE.md) for the operation list, the approval model and the transport.

---

<sub>Built by <a href="https://principlebreach.com">Principle Breach</a> — offensive security research.</sub>
