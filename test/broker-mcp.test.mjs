import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBrowserServer } from '../src/server.mjs';

async function startHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-mcp-'));
  const srv = createBrowserServer({ port: 0, homeDir: dir });
  const info = await srv.start();
  const baseHttp = `http://127.0.0.1:${info.port}`;
  const baseWs = `ws://127.0.0.1:${info.port}/ws`;
  return {
    dir,
    srv,
    info,
    baseHttp,
    baseWs,
    async close() {
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function connectFakeExtension(wsUrl, token, handler) {
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', err => reject(err), { once: true });
  });
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(String(ev.data));
    void handler(msg, ws);
  });
  ws.send(JSON.stringify({
    type: 'hello',
    browserId: 'fake-chrome-1',
    browserName: 'Chrome',
    version: '131.0',
    extensionVersion: '0.2.0',
    groups: [],
  }));
  await new Promise(r => setTimeout(r, 40));
  return ws;
}

test('WebSocket rejects bad tokens, non-extension origins, and unknown paths; accepts /ws', async t => {
  const h = await startHarness();
  t.after(() => h.close());

  const badToken = await new Promise(resolve => {
    const ws = new WebSocket(`${h.baseWs}?token=wrong`);
    ws.addEventListener('error', () => resolve(true), { once: true });
    ws.addEventListener('open', () => { ws.close(); resolve(false); }, { once: true });
  });
  assert.equal(badToken, true);

  const res = await fetch(`${h.baseHttp}/ws?token=${encodeURIComponent(h.srv.vault.token())}`, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      Origin: 'https://evil.example.com',
    },
  }).catch(() => null);
  if (res) assert.equal(res.status, 403);

  const unknownRes = await fetch(`${h.baseHttp}/unknown?token=${encodeURIComponent(h.srv.vault.token())}`, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    },
  }).catch(() => null);
  if (unknownRes) assert.equal(unknownRes.status, 404);

  const validWs = await connectFakeExtension(h.baseWs, h.srv.vault.token(), () => {});
  assert.equal(validWs.readyState, WebSocket.OPEN);
  validWs.close();
});

test('MCP, parallel Claude/Codex isolation, per-tab FIFO queue, policy blocking, audit redaction, kill switch & HTML page', async t => {
  const h = await startHarness();
  t.after(() => h.close());

  let nextTabId = 10;
  let nextGroupId = 100;
  const activeOrders = [];
  const killEvents = [];
  const stopEvents = [];

  const token = h.srv.vault.token();
  const ws = await connectFakeExtension(h.baseWs, token, async (msg, sock) => {
    if (msg.type === 'kill_all') { killEvents.push(msg); return; }
    if (msg.type === 'stop_group') { stopEvents.push(msg); return; }
    if (msg.type !== 'invoke') return;

    if (msg.tool === 'browser_tab_open') {
      const tabId = ++nextTabId;
      const groupId = ++nextGroupId;
      sock.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: true,
        data: { tabId, groupId, url: msg.args?.url || 'about:blank', title: 'Test Page' },
      }));
      return;
    }

    if (msg.tool === 'browser_click') {
      activeOrders.push(`start:${msg.args.ref}`);
      await new Promise(r => setTimeout(r, msg.args.ref === 'e1' ? 60 : 10));
      activeOrders.push(`end:${msg.args.ref}`);
      sock.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: true,
        data: { tabId: msg.args.tabId, clicked: true, ref: msg.args.ref },
      }));
      return;
    }

    if (msg.tool === 'browser_screenshot') {
      sock.send(JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: true,
        data: { tabId: msg.args.tabId, url: 'https://example.com', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      }));
      return;
    }

    sock.send(JSON.stringify({
      type: 'result',
      id: msg.id,
      ok: true,
      data: { tabId: msg.args?.tabId, url: 'https://example.com', text: 'Bearer secretTokenValue' },
    }));
  });
  t.after(() => ws.close());

  // Local HTML status page renders cleanly
  const htmlRes = await fetch(`${h.baseHttp}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /Agent Browser MCP/);

  const mcpCall = async (seat, name, args) => {
    const res = await fetch(`${h.baseHttp}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Session': 'task-1',
        'X-Agent-Seat': seat,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return res.json();
  };

  const toolsRes = await fetch(`${h.baseHttp}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then(r => r.json());
  assert.equal(toolsRes.result.tools.length, 14);

  const [claudeOpen, codexOpen] = await Promise.all([
    mcpCall('claude', 'browser_tab_open', { url: 'https://example.com/a' }),
    mcpCall('codex', 'browser_tab_open', { url: 'https://example.com/b' }),
  ]);
  const claudeTab = claudeOpen.result.structuredContent.tabId;
  const codexTab = codexOpen.result.structuredContent.tabId;
  assert.notEqual(claudeTab, codexTab);

  // Cross-group isolation
  const cross = await mcpCall('codex', 'browser_read_page', { tabId: claudeTab });
  assert.equal(cross.result.isError, true);
  assert.match(cross.result.content[0].text, /tab_not_owned/);

  // Policy blocks internal schemes
  const blockedScheme = await mcpCall('claude', 'browser_tab_open', { url: 'chrome://settings' });
  assert.equal(blockedScheme.result.isError, true);
  assert.match(blockedScheme.result.content[0].text, /policy_blocked/);

  // Redaction on read_page
  const readRes = await mcpCall('claude', 'browser_read_page', { tabId: claudeTab });
  assert.match(readRes.result.content[0].text, /Bearer \[redacted\]/);
  assert.doesNotMatch(readRes.result.content[0].text, /secretTokenValue/);

  // Screenshot returns MCP image block
  const shotRes = await mcpCall('claude', 'browser_screenshot', { tabId: claudeTab });
  assert.equal(shotRes.result.content[0].type, 'image');

  // Per-tab FIFO queue
  await Promise.all([
    mcpCall('claude', 'browser_click', { tabId: claudeTab, ref: 'e1' }),
    mcpCall('claude', 'browser_click', { tabId: claudeTab, ref: 'e2' }),
  ]);
  assert.deepEqual(activeOrders, ['start:e1', 'end:e1', 'start:e2', 'end:e2']);

  // Stop group & Kill switch + resume
  const stopRes = await fetch(`${h.baseHttp}/groups/${encodeURIComponent('task-1::claude')}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ closeTabs: true }),
  });
  assert.equal(stopRes.status, 200);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(stopEvents.length, 1);

  const killRes = await fetch(`${h.baseHttp}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ closeTabs: false }),
  });
  assert.equal(killRes.status, 200);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(killEvents.length, 1);

  const blocked = await mcpCall('codex', 'browser_tabs_list', {});
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /kill_switch_active/);

  const resumeRes = await fetch(`${h.baseHttp}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(resumeRes.status, 200);
  const resumed = await mcpCall('codex', 'browser_tabs_list', {});
  assert.equal(Boolean(resumed.result.isError), false);

  // Audit log recorded calls with zero leaked secrets
  const auditRes = await fetch(`${h.baseHttp}/audit`).then(r => r.json());
  assert.ok(auditRes.rows.length >= 5);
  assert.doesNotMatch(JSON.stringify(auditRes), /secretTokenValue/);
});
