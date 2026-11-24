import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserServer } from '../src/server.mjs';

const BIN_PATH = fileURLToPath(new URL('../bin/agent-browser-mcp.mjs', import.meta.url));

test('stdio bridge initializes with clientInfo seat detection, lists 14 tools, and opens tab in blue cursor group', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-stdio-'));
  const srv = createBrowserServer({ port: 0, homeDir: dir });
  const info = await srv.start();
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const observedInvokes = [];
  const ws = new WebSocket(`${info.wsUrl}?token=${encodeURIComponent(srv.vault.token())}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', err => reject(err), { once: true });
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'invoke') {
      observedInvokes.push(msg);
      ws.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: true,
        data: { tabId: 42, groupId: 7, url: msg.args?.url || 'about:blank', title: 'Cursor Tab' },
      }));
    }
  });
  ws.send(JSON.stringify({
    type: 'hello',
    browserId: 'fake-brave',
    browserName: 'Brave',
    version: '158.0',
    extensionVersion: '0.2.0',
    groups: [],
  }));
  await new Promise(r => setTimeout(r, 40));
  t.after(() => ws.close());

  const cleanEnv = { ...process.env };
  delete cleanEnv.AGENT_BROWSER_SEAT;
  delete cleanEnv.AGENT_BROWSER_SESSION;

  const child = spawn(process.execPath, [BIN_PATH, 'stdio', '--no-autostart', '--url', info.mcpUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanEnv,
  });
  t.after(() => child.kill());

  const rl = readline.createInterface({ input: child.stdout });
  const responses = [];
  const waiters = [];
  rl.on('line', line => {
    if (!line.trim()) return;
    const obj = JSON.parse(line);
    responses.push(obj);
    const w = waiters.shift();
    if (w) w(obj);
  });

  const rpc = msg => new Promise(resolve => {
    waiters.push(resolve);
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  });

  const initRes = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'Cursor', version: '1.0' } },
  });
  assert.equal(initRes.result.serverInfo.name, 'agent-browser-mcp');

  // Notification returns nothing (HTTP 202)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listRes = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listRes.result.tools.length, 14);

  const openRes = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_tab_open', arguments: { url: 'https://example.com' } },
  });
  assert.equal(openRes.result.structuredContent.tabId, 42);
  assert.equal(observedInvokes[0].seat, 'cursor');
  assert.equal(observedInvokes[0].groupColor, 'blue');

  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
});

test('pair CLI generates vault token in AGENT_BROWSER_HOME without running server', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-pair-'));
  try {
    const out = execFileSync(process.execPath, [BIN_PATH, 'pair', '--port', '19999'], {
      env: { ...process.env, AGENT_BROWSER_HOME: homeDir },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.wsUrl, 'ws://127.0.0.1:19999/ws');
    assert.equal(parsed.mcpUrl, 'http://127.0.0.1:19999/mcp');
    assert.equal(parsed.token.length, 64);
    const stat = fs.statSync(path.join(homeDir, 'vault.json'));
    assert.equal(stat.mode & 0o077, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
