import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { redactHeaders, redactText, redactUrl } from '../extension/lib/redaction.js';
import { TabGroupManager } from '../extension/lib/tab-groups.js';
import { CdpController } from '../extension/lib/cdp-actions.js';

const EXT_DIR = fileURLToPath(new URL('../extension/', import.meta.url));

function createMockChrome() {
  let nextTabId = 100;
  let nextGroupId = 50;
  const tabs = new Map();
  const groups = new Map();
  const storageSession = new Map();
  const calls = [];
  const attached = new Set();
  const onEventListeners = [];
  const onDetachListeners = [];

  return {
    storage: {
      session: {
        async get(key) { return { [key]: storageSession.get(key) }; },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storageSession.set(k, v);
        },
      },
    },
    windows: {
      async getAll() { return [{ id: 1, focused: true, type: 'normal' }]; },
      async create(opts) { calls.push({ api: 'windows.create', args: opts }); return { id: 2 }; },
      async update(id, opts) { calls.push({ api: 'windows.update', args: { id, opts } }); },
    },
    tabs: {
      async create(opts) {
        calls.push({ api: 'tabs.create', args: opts });
        const id = ++nextTabId;
        const tab = { id, windowId: opts.windowId ?? 1, groupId: -1, url: opts.url || 'about:blank', title: 'Mock Tab', status: 'complete', active: Boolean(opts.active) };
        tabs.set(id, tab);
        return tab;
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error(`Tab ${id} missing`);
        return t;
      },
      async query(q) {
        return [...tabs.values()].filter(t => (q.groupId !== undefined ? t.groupId === q.groupId : true));
      },
      async group(opts) {
        const gid = opts.groupId ?? ++nextGroupId;
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: opts.createProperties?.windowId ?? 1, title: '', color: 'grey' });
        for (const tid of opts.tabIds) {
          const t = tabs.get(tid);
          if (t) t.groupId = gid;
        }
        return gid;
      },
      async update(id, opts) {
        calls.push({ api: 'tabs.update', args: { id, opts } });
        const t = tabs.get(id);
        if (t && opts && typeof opts === 'object') Object.assign(t, opts);
        return t;
      },
      async remove(ids) {
        const arr = Array.isArray(ids) ? ids : [ids];
        for (const id of arr) tabs.delete(id);
      },
    },
    tabGroups: {
      async get(id) {
        const g = groups.get(id);
        if (!g) throw new Error(`Group ${id} missing`);
        return g;
      },
      async update(id, opts) {
        const g = groups.get(id);
        if (g) Object.assign(g, opts);
        return g;
      },
    },
    debugger: {
      onEvent: { addListener: fn => onEventListeners.push(fn) },
      onDetach: { addListener: fn => onDetachListeners.push(fn) },
      async attach({ tabId }) {
        attached.add(tabId);
        calls.push({ api: 'debugger.attach', args: tabId });
      },
      async detach({ tabId }) {
        attached.delete(tabId);
        calls.push({ api: 'debugger.detach', args: tabId });
      },
      async sendCommand({ tabId }, method, params) {
        calls.push({ api: `cdp:${method}`, args: { tabId, params } });
        if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgo=' };
        if (method === 'Runtime.evaluate') return { result: { value: { found: true, x: 50, y: 25, title: 'T', url: 'https://x.test', text: 'hi', elements: [] } } };
        return {};
      },
    },
    _tabs: tabs,
    _attached: attached,
    _calls: calls,
    _emitDebuggerEvent: (tabId, method, params) => {
      for (const fn of onEventListeners) fn({ tabId }, method, params);
    },
  };
}

test('MV3 manifest, PNG icons (16/32/48/128), and strict no-inline-script popup integrity', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Agent Browser');
  assert.equal(manifest.version, '0.2.0');
  assert.ok(manifest.permissions.includes('tabGroups'));
  assert.ok(manifest.permissions.includes('debugger'));
  for (const iconMap of [manifest.icons, manifest.action?.default_icon]) {
    assert.ok(iconMap && typeof iconMap === 'object');
    for (const size of ['16', '32', '48', '128']) {
      const rel = iconMap[size];
      assert.ok(rel, `Missing ${size}px icon`);
      const buf = fs.readFileSync(path.join(EXT_DIR, rel));
      assert.equal(buf.subarray(0, 4).toString('hex'), '89504e47');
      assert.equal(buf.readUInt32BE(16), Number(size));
      assert.equal(buf.readUInt32BE(20), Number(size));
    }
  }
  const popupHtml = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
  assert.doesNotMatch(popupHtml, /onclick=|onload=/i);
  assert.doesNotMatch(popupHtml, /<script(?![^>]*\bsrc=)[^>]*>/i);
});

test('TabGroupManager creates background tabs (active: false), never steals focus, and revokes on drag-out', async () => {
  const chromeApi = createMockChrome();
  const revoked = [];
  const mgr = new TabGroupManager(chromeApi, {
    onRevokeTab: async tabId => { revoked.push(tabId); },
  });

  const opened = await mgr.openTab({
    ownerKey: 'task-1::claude',
    sessionId: 'task-1',
    seat: 'claude',
    groupTitle: 'Agent · task-1 · claude',
    groupColor: 'orange',
    url: 'https://example.com',
  });

  const createCall = chromeApi._calls.find(c => c.api === 'tabs.create');
  assert.equal(createCall.args.active, false);
  assert.equal(chromeApi._calls.some(c => c.api === 'windows.update' || c.api === 'tabs.update'), false);
  assert.equal((await mgr.assertTabAccess('task-1::claude', opened.tabId)).ok, true);

  const tab = chromeApi._tabs.get(opened.tabId);
  tab.groupId = -1;
  await mgr.handleTabUpdated(opened.tabId, {}, tab);

  assert.ok(revoked.includes(opened.tabId));
  assert.equal((await mgr.assertTabAccess('task-1::claude', opened.tabId)).ok, false);
});

test('CdpController dispatches CDP clicks/typing without OS input and preserves owner-shared tabs on stop', async () => {
  const chromeApi = createMockChrome();
  let cdp;
  const mgr = new TabGroupManager(chromeApi, {
    onRevokeTab: async tabId => { await cdp.detachTab(tabId); },
  });
  cdp = new CdpController(chromeApi, mgr);

  const opened = await cdp.execute({
    ownerKey: 'task-2::codex',
    sessionId: 'task-2',
    seat: 'codex',
    groupTitle: 'Agent · task-2 · codex',
    groupColor: 'green',
    tool: 'browser_tab_open',
    args: { url: 'https://example.com' },
  });

  await cdp.execute({
    ownerKey: 'task-2::codex',
    sessionId: 'task-2',
    seat: 'codex',
    groupTitle: 'Agent · task-2 · codex',
    groupColor: 'green',
    tool: 'browser_click',
    args: { tabId: opened.tabId, ref: 'e1' },
  });
  assert.ok(chromeApi._calls.some(c => c.api === 'cdp:Input.dispatchMouseEvent'));

  const typed = await cdp.execute({
    ownerKey: 'task-2::codex',
    sessionId: 'task-2',
    seat: 'codex',
    groupTitle: 'Agent · task-2 · codex',
    groupColor: 'green',
    tool: 'browser_type',
    args: { tabId: opened.tabId, ref: 'e1', text: 'super-secret-value' },
  });
  assert.equal(typed.typedLength, 18);
  assert.doesNotMatch(JSON.stringify(typed), /super-secret-value/);

  chromeApi._emitDebuggerEvent(opened.tabId, 'Network.requestWillBeSent', {
    requestId: 'r1',
    request: {
      method: 'GET',
      url: 'https://example.com/cb?token=secret123&ok=1',
      headers: { Authorization: 'Bearer abcdef', Cookie: 'sid=1', Accept: 'application/json' },
    },
  });
  const net = await cdp.execute({
    ownerKey: 'task-2::codex',
    sessionId: 'task-2',
    seat: 'codex',
    groupTitle: 'Agent · task-2 · codex',
    groupColor: 'green',
    tool: 'browser_network',
    args: { tabId: opened.tabId },
  });
  assert.doesNotMatch(JSON.stringify(net), /secret123|abcdef|sid=1/);

  const ownerTab = await chromeApi.tabs.create({ windowId: 1, url: 'https://owner.example', active: true });
  await mgr.shareTab('task-2::codex', ownerTab.id);
  await mgr.stopGroup('task-2::codex', true);
  assert.ok(chromeApi._tabs.has(ownerTab.id), 'owner-shared tab must NOT be closed');
  assert.equal(chromeApi._tabs.has(opened.tabId), false, 'agent-created tab is closed');
});

test('extension redaction helpers scrub headers, query tokens, and bearer strings', () => {
  assert.equal(redactHeaders({ Authorization: 'Bearer xyz', Accept: '*/*' }).Authorization, '[redacted]');
  assert.match(redactUrl('https://a.test/path?code=123&page=2'), /code=%5Bredacted%5D/);
  assert.equal(redactText('Bearer tok_12345'), 'Bearer [redacted]');
});
