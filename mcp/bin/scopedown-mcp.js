#!/usr/bin/env node
// scopedown-mcp: the MCP server (default), the native messaging host the browser starts,
// and the commands that install and check both.

import { VERSION } from '../src/version.js';

const [command = 'serve', ...rest] = process.argv.slice(2);

const usage = `scopedown-mcp ${VERSION}, the ScopeDown agent bridge by Principle Breach

  scopedown-mcp                 Run the MCP server on stdio (what your agent harness starts)
  scopedown-mcp install         Register the bridge with your installed browsers
  scopedown-mcp uninstall       Remove it again
  scopedown-mcp doctor          Show what is installed and which browsers are connected
  scopedown-mcp --version       Print the version

Install options:
  --browser <name>              Only this browser (chrome, brave, edge, arc, chromium, vivaldi, firefox)
  --extension-id <id>           Also allow this Chromium extension ID (for example a store build)

Add it to Claude Code:
  claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp
`;

function option(name) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

// Browsers start the host with arguments of their own (the extension origin, a window
// handle), so "host" is matched by name and anything after it is ignored.
switch (command) {
  case 'serve': {
    const { runServer } = await import('../src/server.js');
    await runServer();
    break;
  }
  case 'host': {
    const { runHost } = await import('../src/host.js');
    runHost();
    break;
  }
  case 'install': {
    const { install } = await import('../src/install.js');
    const only = option('--browser') ? [option('--browser').toLowerCase()] : null;
    const extensionIds = option('--extension-id') ? [option('--extension-id')] : [];
    const out = install({ only, extensionIds });
    if (!out.installed.length) {
      console.log('No browser profile was found. Open Chrome, Brave, Edge, Arc, Chromium, Vivaldi or Firefox once, then run install again.');
      process.exitCode = 1;
      break;
    }
    for (const i of out.installed) console.log(`Registered with ${i.browser}: ${i.manifest}`);
    console.log(`\nNext:\n  1. In the browser, click the ScopeDown icon and switch Agents on.\n  2. Add the server to your harness, for example:\n     claude mcp add scopedown -- npx -y @principlebreach/scopedown-mcp`);
    break;
  }
  case 'uninstall': {
    const { uninstall } = await import('../src/install.js');
    const out = uninstall();
    for (const r of out.removed) console.log(`Removed from ${r.browser}: ${r.manifest}`);
    if (!out.removed.length) console.log('Nothing was installed.');
    break;
  }
  case 'doctor': {
    const { doctor } = await import('../src/install.js');
    console.log(JSON.stringify(doctor(), null, 2));
    break;
  }
  case 'help':
  case '--help':
  case '-h':
    console.log(usage);
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  default:
    // Firefox starts native hosts with the manifest path as the first argument.
    if (/\.json$/i.test(command) || command.startsWith('chrome-extension://')) {
      const { runHost } = await import('../src/host.js');
      runHost();
    } else {
      console.error(`Unknown command "${command}".\n\n${usage}`);
      process.exitCode = 2;
    }
}
