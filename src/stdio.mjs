// Stdio-to-HTTP MCP bridge for universal compatibility with Claude Code,
// Claude Desktop, Codex, Cursor, Windsurf, Copilot, and Antigravity.
// Auto-starts one shared background broker daemon on localhost so multiple
// parallel IDE/agent sessions share a single browser extension connection.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

export function normalizeClientSeat(clientName) {
  const raw = String(clientName || '').trim().toLowerCase();
  if (!raw) return 'agent';
  if (raw.includes('claude')) return 'claude';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('cursor')) return 'cursor';
  if (raw.includes('copilot')) return 'copilot';
  if (raw.includes('windsurf')) return 'windsurf';
  if (raw.includes('antigravity') || raw.includes('agy')) return 'agy';
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'agent';
}

async function isReachable(statusUrl) {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(port, serverEntry) {
  const statusUrl = `http://127.0.0.1:${port}/status`;
  if (await isReachable(statusUrl)) return;

  const child = spawn(process.execPath, [serverEntry, 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await isReachable(statusUrl)) return;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`Timed out waiting for agent-browser-mcp broker on 127.0.0.1:${port}`);
}

export async function runStdioBridge(opts = {}) {
  const port = Number(opts.port || process.env.AGENT_BROWSER_PORT || 17788);
  const explicitUrl = opts.mcpUrl || process.env.AGENT_BROWSER_MCP_URL || '';
  const targetMcpUrl = explicitUrl || `http://127.0.0.1:${port}/mcp`;
  const autoStart = opts.autoStart !== false && !explicitUrl;

  let activeSeat = opts.seat || process.env.AGENT_BROWSER_SEAT || '';
  const sessionId =
    opts.session ||
    process.env.AGENT_BROWSER_SESSION ||
    `mcp-${crypto.randomBytes(3).toString('hex')}`;

  let daemonReadyPromise = null;
  const ensureReady = () => {
    if (!autoStart) return Promise.resolve();
    if (!daemonReadyPromise) {
      daemonReadyPromise = ensureDaemon(port, opts.serverEntry);
    }
    return daemonReadyPromise;
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();

  const handleLine = async line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }

    if (!activeSeat && msg && !Array.isArray(msg) && msg.method === 'initialize') {
      const clientName = msg.params?.clientInfo?.name;
      if (clientName) activeSeat = normalizeClientSeat(clientName);
    }

    const seat = activeSeat || 'agent';
    try {
      await ensureReady();
      const res = await fetch(targetMcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Session': sessionId,
          'X-Agent-Seat': seat,
        },
        body: JSON.stringify(msg),
      });
      if (res.status === 202) return;
      const text = await res.text();
      if (text.trim()) {
        process.stdout.write(`${text.trim()}\n`);
      }
    } catch (err) {
      const id = msg && !Array.isArray(msg) && msg.id !== undefined ? msg.id : null;
      if (id !== null) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          })}\n`,
        );
      } else {
        process.stderr.write(`[agent-browser-mcp stdio] ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };

  await new Promise(resolve => {
    rl.on('line', line => {
      chain = chain.then(() => handleLine(line));
    });
    rl.on('close', () => {
      void chain.then(resolve);
    });
  });
}
