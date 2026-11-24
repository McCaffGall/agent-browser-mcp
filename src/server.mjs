// Zero-dependency HTTP + WebSocket + Streamable HTTP MCP server for Agent Browser.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from './audit.mjs';
import { BrowserBroker } from './broker.mjs';
import { handleBody } from './mcp.mjs';
import { SettingsStore } from './policy.mjs';
import { PairingVault, defaultHomeDir } from './vault.mjs';
import { acceptWebSocket, rejectUpgrade } from './ws.mjs';

const DEFAULT_EXTENSION_PATH = fileURLToPath(new URL('../extension', import.meta.url));
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'tailscale-user-name'];

function header(req, name) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function isLoopbackAddr(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isDirectLoopback(req) {
  if (!isLoopbackAddr(req.socket?.remoteAddress)) return false;
  const host = header(req, 'host').toLowerCase();
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  return !PROXY_HEADERS.some(h => Boolean(header(req, h)));
}

function isOwnDashboardOrigin(req, port) {
  const origin = header(req, 'origin').trim().toLowerCase();
  if (!origin) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isLocalOrOwnPage(req, port) {
  if (!isDirectLoopback(req)) return false;
  const origin = header(req, 'origin').trim();
  if (!origin) return true;
  return isOwnDashboardOrigin(req, port);
}

function isAllowedExtensionOrigin(origin) {
  if (!origin) return true;
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin.trim());
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', err => reject(err));
  });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Browser MCP</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 860px; margin: 0 auto; display: grid; gap: 16px; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 20px; }
    h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; margin-top: 8px; }
    .muted { color: #94a3b8; font-size: 13px; }
    .ok { color: #4ade80; font-weight: 600; }
    .bad { color: #f87171; font-weight: 600; }
    .btn { border: 1px solid #475569; background: #334155; color: #f8fafc; border-radius: 7px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
    .btn.danger { background: #dc2626; border-color: #ef4444; }
    .btn.primary { background: #2563eb; border-color: #3b82f6; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 5px; border: 1px solid #334155; font-size: 12px; }
    .kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div>
        <h1>Agent Browser MCP</h1>
        <div id="status-line" class="muted">Loading status...</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="refresh-btn" type="button" class="btn">Refresh</button>
        <button id="kill-btn" type="button" class="btn danger">Kill Switch</button>
        <button id="resume-btn" type="button" class="btn primary" style="display:none;">Resume</button>
      </div>
    </div>

    <div class="card">
      <h2>Endpoints &amp; Pairing</h2>
      <div class="kv">
        <div class="muted">MCP (HTTP)</div><div><code id="mcp-url">-</code></div>
        <div class="muted">Extension WS</div><div><code id="ws-url">-</code></div>
        <div class="muted">Extension Path</div><div><code id="ext-path">-</code></div>
        <div class="muted">Pairing Hint</div><div><code id="pair-hint">-</code></div>
      </div>
    </div>

    <div class="card">
      <h2>Connected Browsers</h2>
      <div id="clients-list" class="muted">None</div>
    </div>

    <div class="card">
      <h2>Active Agent Tab Groups</h2>
      <div id="groups-list" class="muted">None</div>
    </div>
  </div>

  <script>
    const statusLine = document.getElementById('status-line');
    const mcpUrlEl = document.getElementById('mcp-url');
    const wsUrlEl = document.getElementById('ws-url');
    const extPathEl = document.getElementById('ext-path');
    const pairHintEl = document.getElementById('pair-hint');
    const clientsList = document.getElementById('clients-list');
    const groupsList = document.getElementById('groups-list');
    const killBtn = document.getElementById('kill-btn');
    const resumeBtn = document.getElementById('resume-btn');
    const refreshBtn = document.getElementById('refresh-btn');

    async function refresh() {
      const res = await fetch('/status');
      const data = await res.json();
      mcpUrlEl.textContent = data.mcpUrl;
      wsUrlEl.textContent = data.wsUrl;
      extPathEl.textContent = data.extensionPath;
      pairHintEl.textContent = data.pairingHint;

      if (data.killSwitch) {
        statusLine.textContent = 'Kill Switch active (all agent actions blocked)';
        statusLine.className = 'bad';
        killBtn.style.display = 'none';
        resumeBtn.style.display = 'inline-block';
      } else if (data.connected) {
        statusLine.textContent = 'Extension connected and ready';
        statusLine.className = 'ok';
        killBtn.style.display = 'inline-block';
        resumeBtn.style.display = 'none';
      } else {
        statusLine.textContent = 'Waiting for browser extension connection';
        statusLine.className = 'muted';
        killBtn.style.display = 'inline-block';
        resumeBtn.style.display = 'none';
      }

      clientsList.replaceChildren();
      if (!data.clients.length) {
        clientsList.textContent = 'No browser extension connected yet. Run: agent-browser-mcp pair --write-local';
      } else {
        for (const c of data.clients) {
          const row = document.createElement('div');
          row.className = 'row';
          const left = document.createElement('div');
          left.textContent = c.browserName + ' ' + c.version + ' (ext ' + c.extensionVersion + ')';
          const right = document.createElement('div');
          right.className = 'muted';
          right.textContent = c.browserId;
          row.append(left, right);
          clientsList.appendChild(row);
        }
      }

      groupsList.replaceChildren();
      if (!data.groups.length) {
        groupsList.textContent = 'No active agent tab groups.';
      } else {
        for (const g of data.groups) {
          const row = document.createElement('div');
          row.className = 'row';
          const left = document.createElement('div');
          const title = document.createElement('div');
          title.textContent = g.title + ' (' + g.color + ')';
          const sub = document.createElement('div');
          sub.className = 'muted';
          sub.textContent = g.tabs.length + ' tab(s) · ' + g.seat + ' · ' + g.ownerKey;
          left.append(title, sub);
          const stopBtn = document.createElement('button');
          stopBtn.type = 'button';
          stopBtn.className = 'btn danger';
          stopBtn.textContent = 'Stop';
          stopBtn.addEventListener('click', async () => {
            await fetch('/groups/' + encodeURIComponent(g.ownerKey) + '/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ closeTabs: true }),
            });
            await refresh();
          });
          row.append(left, stopBtn);
          groupsList.appendChild(row);
        }
      }
    }

    killBtn.addEventListener('click', async () => {
      await fetch('/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closeTabs: false }) });
      await refresh();
    });
    resumeBtn.addEventListener('click', async () => {
      await fetch('/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await refresh();
    });
    refreshBtn.addEventListener('click', refresh);
    void refresh();
    setInterval(refresh, 4000);
  </script>
</body>
</html>`;
}

export function createBrowserServer(opts = {}) {
  const requestedPort = opts.port ?? 17788;
  const host = opts.host ?? '127.0.0.1';
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const extensionPath = opts.extensionPath ?? DEFAULT_EXTENSION_PATH;
  const groupPrefix = opts.groupPrefix ?? 'Agent';

  const vault = new PairingVault(opts.vaultFile ?? path.join(homeDir, 'vault.json'));
  const settings = new SettingsStore(opts.configFile ?? path.join(homeDir, 'config.json'));
  const audit = new AuditLog({ file: opts.auditFile ?? path.join(homeDir, 'audit.jsonl') });
  // Mint token on startup so /status and pair hint work immediately.
  vault.token();

  const broker = new BrowserBroker({
    audit,
    settings: () => settings.read(),
    groupPrefix,
  });

  let actualPort = requestedPort;
  const urls = () => ({
    wsUrl: `ws://127.0.0.1:${actualPort}/ws`,
    mcpUrl: `http://127.0.0.1:${actualPort}/mcp`,
    pairingHint: vault.hint(),
    extensionPath,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isDirectLoopback(req)) {
        sendJson(res, 403, { error: 'Agent Browser server only accepts direct loopback requests.' });
        return;
      }

      const parsed = new URL(req.url || '/', `http://127.0.0.1:${actualPort}`);
      const pathname = parsed.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderDashboardHtml());
        return;
      }

      if (method === 'GET' && pathname === '/status') {
        sendJson(res, 200, broker.status(urls()));
        return;
      }

      if (method === 'GET' && pathname === '/tools') {
        sendJson(res, 200, { tools: broker.tools() });
        return;
      }

      if (method === 'GET' && pathname === '/audit') {
        const limit = Math.min(500, Math.max(1, Math.round(Number(parsed.searchParams.get('limit')) || 50)));
        sendJson(res, 200, { rows: audit.recent(limit) });
        return;
      }

      if (method === 'GET' && pathname === '/config') {
        sendJson(res, 200, settings.read());
        return;
      }

      if (pathname === '/mcp') {
        if (header(req, 'origin') && !isOwnDashboardOrigin(req, actualPort)) {
          sendJson(res, 403, { error: 'Cross-site browser requests to MCP are blocked.' });
          return;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const sessionId =
            header(req, 'x-agent-session') ||
            parsed.searchParams.get('session') ||
            null;
          const seat =
            header(req, 'x-agent-seat') ||
            parsed.searchParams.get('seat') ||
            null;
          const out = await handleBody(broker, body, { sessionId, seat });
          if (out === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, 200, out);
          return;
        }
        if (method === 'DELETE') {
          sendJson(res, 200, {});
          return;
        }
        sendJson(res, 405, { error: 'This MCP endpoint only answers POST.' }, { Allow: 'POST, DELETE' });
        return;
      }

      if (method === 'POST' && pathname === '/pair') {
        if (!isLocalOrOwnPage(req, actualPort)) {
          sendJson(res, 403, { error: 'Pairing tokens can only be retrieved locally.' });
          return;
        }
        const body = await readJsonBody(req);
        const token = body?.rotate ? vault.rotate() : vault.token();
        sendJson(res, 200, { ...urls(), token });
        return;
      }

      if (method === 'POST' && pathname === '/call') {
        if (!isLocalOrOwnPage(req, actualPort)) {
          sendJson(res, 403, { error: 'Browser tool calls are restricted to local tools on this machine.' });
          return;
        }
        const b = await readJsonBody(req);
        const out = await broker.call({
          tool: b.tool,
          args: b.args,
          sessionId: typeof b.sessionId === 'string' ? b.sessionId : (header(req, 'x-agent-session') || null),
          seat: typeof b.seat === 'string' ? b.seat : (header(req, 'x-agent-seat') || null),
          via: header(req, 'x-agent-via') === 'cli' ? 'cli' : 'http',
        });
        const { httpStatus, ...payload } = out;
        sendJson(res, httpStatus, payload);
        return;
      }

      const stopMatch = /^\/groups\/([^/]+)\/stop$/.exec(pathname);
      if (method === 'POST' && stopMatch) {
        if (!isLocalOrOwnPage(req, actualPort)) {
          sendJson(res, 403, { error: 'Stopping an agent tab group is restricted to local control.' });
          return;
        }
        const body = await readJsonBody(req);
        const ownerKey = decodeURIComponent(stopMatch[1]);
        const closeTabs = body?.closeTabs !== false;
        sendJson(res, 200, broker.stopGroup(ownerKey, closeTabs));
        return;
      }

      if (method === 'POST' && pathname === '/kill') {
        if (!isLocalOrOwnPage(req, actualPort)) {
          sendJson(res, 403, { error: 'Browser Kill Switch is restricted to local control.' });
          return;
        }
        const body = await readJsonBody(req);
        settings.patch({ killSwitch: true });
        const closeTabs = body?.closeTabs === true;
        sendJson(res, 200, { killSwitch: true, ...broker.killAll(closeTabs) });
        return;
      }

      if (method === 'POST' && pathname === '/resume') {
        if (!isLocalOrOwnPage(req, actualPort)) {
          sendJson(res, 403, { error: 'Resuming browser automation is restricted to local control.' });
          return;
        }
        settings.patch({ killSwitch: false });
        sendJson(res, 200, { killSwitch: false });
        return;
      }

      sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const code = err?.statusCode || 500;
      sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    let parsed;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request', 'Invalid request URL');
      return;
    }
    if (parsed.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found', 'Unknown WebSocket endpoint');
      return;
    }

    if (!isDirectLoopback(req)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Direct loopback connections only');
      return;
    }
    const origin = header(req, 'origin');
    if (!isAllowedExtensionOrigin(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden', 'Disallowed WebSocket origin');
      return;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(header(req, 'authorization'))?.[1]?.trim() ?? '';
    const candidate = parsed.searchParams.get('token')?.trim() || bearer;
    if (!vault.verify(candidate)) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'Invalid or missing pairing token');
      return;
    }

    const ws = acceptWebSocket(req, socket, head);
    if (ws) broker.attachSocket(ws);
  });

  return {
    server,
    broker,
    vault,
    settings,
    audit,
    urls,
    port() {
      return actualPort;
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          if (addr && typeof addr === 'object') actualPort = addr.port;
          broker.startHeartbeat();
          resolve({ port: actualPort, host, ...urls() });
        });
      });
    },
    async close() {
      broker.stop();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
