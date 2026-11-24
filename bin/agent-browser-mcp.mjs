#!/usr/bin/env node
// Universal CLI, HTTP/WS broker daemon, and stdio MCP entrypoint for Agent Browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserServer } from '../src/server.mjs';
import { runStdioBridge } from '../src/stdio.mjs';
import { PairingVault } from '../src/vault.mjs';

const ENTRY_PATH = fileURLToPath(import.meta.url);
const EXTENSION_DIR = fileURLToPath(new URL('../extension', import.meta.url));

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function getPort(flags) {
  const p = Number(flags.port || process.env.AGENT_BROWSER_PORT || 17788);
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    throw new Error(`Invalid port: ${flags.port}`);
  }
  return p;
}

function getBaseUrl(flags) {
  if (typeof flags.url === 'string' && flags.url.trim()) {
    return flags.url.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  }
  return `http://127.0.0.1:${getPort(flags)}`;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

function printHelp() {
  process.stdout.write(`agent-browser-mcp — Universal MV3 browser extension & MCP broker

Usage:
  agent-browser-mcp serve [--port 17788]
  agent-browser-mcp stdio [--port 17788] [--url <mcpUrl>] [--seat <name>] [--session <id>] [--no-autostart]
  agent-browser-mcp pair [--port 17788] [--write-local] [--rotate]
  agent-browser-mcp status [--port 17788]
  agent-browser-mcp tools [--port 17788]
  agent-browser-mcp extension-path

Browser Tool CLI:
  agent-browser-mcp open [url] [--seat <name>] [--session <id>]
  agent-browser-mcp tabs [--seat <name>] [--session <id>]
  agent-browser-mcp read <tabId>
  agent-browser-mcp find <tabId> <query>
  agent-browser-mcp click <tabId> <ref-or-selector>
  agent-browser-mcp type <tabId> <ref-or-selector> <text> [--clear] [--enter]
  agent-browser-mcp fill <tabId> '<json-fields-array>'
  agent-browser-mcp scroll <tabId> [deltaY]
  agent-browser-mcp screenshot <tabId> [--out file.png] [--full-page]
  agent-browser-mcp console <tabId> [--clear]
  agent-browser-mcp network <tabId> [--clear]
  agent-browser-mcp close <tabId>
  agent-browser-mcp stop
  agent-browser-mcp kill [--close-tabs]
  agent-browser-mcp resume
`);
}

async function callTool(baseUrl, flags, tool, args) {
  const sessionId = String(flags.session || process.env.AGENT_BROWSER_SESSION || 'cli');
  const seat = String(flags.seat || process.env.AGENT_BROWSER_SEAT || 'agent');
  const { status, data } = await fetchJson(`${baseUrl}/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Via': 'cli',
      'X-Agent-Session': sessionId,
      'X-Agent-Seat': seat,
    },
    body: JSON.stringify({ tool, args, sessionId, seat }),
  });
  if (!data.ok) {
    process.stderr.write(`${JSON.stringify(data, null, 2)}\n`);
    const code = data?.error?.code;
    if (code === 'not_connected') process.exit(3);
    if (code === 'kill_switch_active' || code === 'browser_disabled' || code === 'policy_blocked' || code === 'tab_not_owned') process.exit(4);
    process.exit(status >= 400 ? 2 : 1);
  }
  return data;
}

async function main() {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const cmd = positionals[0] || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) {
    printHelp();
    return;
  }

  if (cmd === 'extension-path') {
    process.stdout.write(`${EXTENSION_DIR}\n`);
    return;
  }

  if (cmd === 'serve') {
    const port = getPort(flags);
    const srv = createBrowserServer({
      port,
      extensionPath: EXTENSION_DIR,
    });
    const info = await srv.start();
    process.stdout.write(`Agent Browser MCP listening at http://127.0.0.1:${info.port}\n`);
    process.stdout.write(`  MCP HTTP:  ${info.mcpUrl}\n`);
    process.stdout.write(`  Ext WS:    ${info.wsUrl}\n`);
    process.stdout.write(`  Extension: ${info.extensionPath}\n`);
    const shutdown = async () => {
      await srv.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'stdio') {
    await runStdioBridge({
      port: getPort(flags),
      mcpUrl: typeof flags.url === 'string' ? flags.url : '',
      seat: typeof flags.seat === 'string' ? flags.seat : '',
      session: typeof flags.session === 'string' ? flags.session : '',
      autoStart: flags.autostart !== false,
      serverEntry: ENTRY_PATH,
    });
    return;
  }

  if (cmd === 'pair') {
    const port = getPort(flags);
    const baseUrl = getBaseUrl(flags);
    const rotate = Boolean(flags.rotate);
    let payload;
    try {
      const res = await fetchJson(`${baseUrl}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotate }),
      });
      if (res.ok && res.data?.token) {
        payload = res.data;
      }
    } catch {
      // Broker not running yet; mint/read directly from PairingVault.
    }
    if (!payload) {
      const vault = new PairingVault();
      const token = rotate ? vault.rotate() : vault.token();
      payload = {
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        pairingHint: vault.hint(),
        extensionPath: EXTENSION_DIR,
        token,
      };
    }
    if (flags['write-local']) {
      const target = path.join(EXTENSION_DIR, 'pairing.local.json');
      fs.writeFileSync(target, `${JSON.stringify({ wsUrl: payload.wsUrl, token: payload.token }, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(target, 0o600);
      payload.wroteLocal = target;
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const baseUrl = getBaseUrl(flags);

  if (cmd === 'status') {
    const { data } = await fetchJson(`${baseUrl}/status`);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (cmd === 'tools') {
    const { data } = await fetchJson(`${baseUrl}/tools`);
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (cmd === 'kill') {
    const { data } = await fetchJson(`${baseUrl}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closeTabs: Boolean(flags['close-tabs']) }),
    });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (cmd === 'resume') {
    const { data } = await fetchJson(`${baseUrl}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  let out;
  switch (cmd) {
    case 'tabs':
      out = await callTool(baseUrl, flags, 'browser_tabs_list', {});
      break;
    case 'open':
      out = await callTool(baseUrl, flags, 'browser_tab_open', {
        ...(positionals[1] ? { url: positionals[1] } : {}),
        ...(typeof flags.wait === 'string' ? { wait: flags.wait } : {}),
      });
      break;
    case 'navigate':
      out = await callTool(baseUrl, flags, 'browser_navigate', {
        tabId: Number(positionals[1]),
        url: positionals[2],
      });
      break;
    case 'read':
      out = await callTool(baseUrl, flags, 'browser_read_page', {
        tabId: Number(positionals[1]),
      });
      break;
    case 'find':
      out = await callTool(baseUrl, flags, 'browser_find', {
        tabId: Number(positionals[1]),
        query: positionals.slice(2).join(' '),
      });
      break;
    case 'click': {
      const target = positionals[2] || '';
      const isRef = /^e\d+$/.test(target);
      out = await callTool(baseUrl, flags, 'browser_click', {
        tabId: Number(positionals[1]),
        ...(isRef ? { ref: target } : { selector: target }),
      });
      break;
    }
    case 'type': {
      const target = positionals[2] || '';
      const isRef = /^e\d+$/.test(target);
      out = await callTool(baseUrl, flags, 'browser_type', {
        tabId: Number(positionals[1]),
        ...(isRef ? { ref: target } : { selector: target }),
        text: positionals[3] ?? '',
        clear: Boolean(flags.clear),
        pressEnter: Boolean(flags.enter),
      });
      break;
    }
    case 'fill':
      out = await callTool(baseUrl, flags, 'browser_fill', {
        tabId: Number(positionals[1]),
        fields: JSON.parse(positionals[2] || '[]'),
      });
      break;
    case 'scroll':
      out = await callTool(baseUrl, flags, 'browser_scroll', {
        tabId: Number(positionals[1]),
        deltaY: Number(positionals[2] ?? 400),
      });
      break;
    case 'screenshot': {
      out = await callTool(baseUrl, flags, 'browser_screenshot', {
        tabId: Number(positionals[1]),
        fullPage: Boolean(flags['full-page']),
      });
      const img = out?.result?.content?.find(c => c.type === 'image');
      if (typeof flags.out === 'string' && img?.data) {
        fs.writeFileSync(flags.out, Buffer.from(img.data, 'base64'));
        process.stdout.write(`Saved screenshot to ${flags.out}\n`);
        return;
      }
      break;
    }
    case 'console':
      out = await callTool(baseUrl, flags, 'browser_console', {
        tabId: Number(positionals[1]),
        clear: Boolean(flags.clear),
      });
      break;
    case 'network':
      out = await callTool(baseUrl, flags, 'browser_network', {
        tabId: Number(positionals[1]),
        clear: Boolean(flags.clear),
      });
      break;
    case 'close':
      out = await callTool(baseUrl, flags, 'browser_tab_close', {
        tabId: Number(positionals[1]),
      });
      break;
    case 'stop':
      out = await callTool(baseUrl, flags, 'browser_group_close', {});
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(out.result?.structuredContent ?? out.result ?? out, null, 2)}\n`);
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
