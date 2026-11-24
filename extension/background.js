// MV3 service worker for Agent Browser.
// Connects to the local broker over authenticated loopback WebSocket, enforces
// per-agent tab-group ownership, and runs CDP commands on target tabs.

import { CdpController } from './lib/cdp-actions.js';
import { TabGroupManager } from './lib/tab-groups.js';
import { WsClient } from './lib/ws-client.js';

const DEFAULT_WS_URL = 'ws://127.0.0.1:17788/ws';
const PAIRING_STORAGE_KEY = 'agent_browser_pairing_v1';
const BROWSER_ID_KEY = 'agent_browser_id_v1';

let killSwitchActive = false;

async function getBrowserIdentity() {
  const stored = await chrome.storage.local.get(BROWSER_ID_KEY);
  let browserId = stored?.[BROWSER_ID_KEY];
  if (!browserId) {
    browserId = `ext-${crypto.randomUUID().slice(0, 8)}`;
    await chrome.storage.local.set({ [BROWSER_ID_KEY]: browserId });
  }
  const ua = navigator.userAgent || '';
  const isBrave = Boolean(navigator.brave) || /Brave/i.test(ua);
  const match = /Chrome\/([\d.]+)/.exec(ua);
  const browserName = isBrave ? 'Brave' : 'Chrome';
  const version = match ? match[1] : '';
  const extensionVersion = chrome.runtime.getManifest().version;
  return { browserId, browserName, version, extensionVersion };
}

let cdp = null;
const tabGroups = new TabGroupManager(chrome, {
  onRevokeTab: async tabId => {
    if (cdp) await cdp.detachTab(tabId);
  },
  onChange: () => {
    syncState();
    void updateBadge();
  },
});
cdp = new CdpController(chrome, tabGroups);

const wsClient = new WsClient({
  onOpen: async () => {
    await tabGroups.init();
    const id = await getBrowserIdentity();
    wsClient.send({
      type: 'hello',
      ...id,
      groups: tabGroups.snapshot(),
    });
    void updateBadge();
  },
  onClose: () => {
    void updateBadge();
  },
  onMessage: async msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'welcome') {
      killSwitchActive = Boolean(msg.killSwitch);
      void updateBadge();
      return;
    }
    if (msg.type === 'ping') {
      wsClient.send({ type: 'pong', ts: msg.ts });
      return;
    }
    if (msg.type === 'stop_group') {
      await tabGroups.stopGroup(msg.ownerKey, msg.closeTabs !== false);
      syncState();
      void updateBadge();
      return;
    }
    if (msg.type === 'kill_all') {
      killSwitchActive = true;
      await tabGroups.killAll(Boolean(msg.closeTabs));
      syncState();
      void updateBadge();
      return;
    }
    if (msg.type === 'invoke') {
      try {
        const out = await cdp.execute(msg);
        if (out && out.__error) {
          wsClient.send({ type: 'result', id: msg.id, ok: false, error: out.__error });
        } else {
          wsClient.send({ type: 'result', id: msg.id, ok: true, data: out });
        }
      } catch (err) {
        wsClient.send({
          type: 'result',
          id: msg.id,
          ok: false,
          error: { code: 'tool_error', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  },
});

async function syncState() {
  if (!wsClient.connected) return;
  const id = await getBrowserIdentity();
  wsClient.send({
    type: 'state_sync',
    browserId: id.browserId,
    groups: tabGroups.snapshot(),
  });
}

async function updateBadge() {
  try {
    if (killSwitchActive) {
      await chrome.action.setBadgeText({ text: 'KILL' });
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
      return;
    }
    if (!wsClient.connected) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
      return;
    }
    const count = tabGroups.snapshot().length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#7c3aed' : '#16a34a' });
  } catch {
    // ignore action badge errors
  }
}

async function loadPairingAndConnect() {
  const stored = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
  let cfg = stored?.[PAIRING_STORAGE_KEY];
  if (!cfg?.wsUrl || !cfg?.token) {
    try {
      const resp = await fetch(chrome.runtime.getURL('pairing.local.json'));
      if (resp.ok) {
        const localCfg = await resp.json();
        if (localCfg?.wsUrl && localCfg?.token) {
          cfg = { wsUrl: String(localCfg.wsUrl), token: String(localCfg.token) };
          await chrome.storage.local.set({ [PAIRING_STORAGE_KEY]: cfg });
        }
      }
    } catch {
      // pairing.local.json is optional
    }
  }
  if (cfg?.wsUrl && cfg?.token) {
    wsClient.connect(cfg.wsUrl, cfg.token);
  }
  await updateBadge();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void tabGroups.handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void tabGroups.handleTabRemoved(tabId);
});

chrome.tabGroups.onRemoved.addListener(group => {
  if (typeof group?.id === 'number') {
    void tabGroups.handleGroupRemoved(group.id);
  }
});

chrome.alarms.create('agent-browser-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'agent-browser-keepalive') {
    void loadPairingAndConnect();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void loadPairingAndConnect();
});

chrome.runtime.onStartup.addListener(() => {
  void loadPairingAndConnect();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await tabGroups.init();
    const type = message?.type;
    if (type === 'get_state') {
      const stored = await chrome.storage.local.get(PAIRING_STORAGE_KEY);
      const cfg = stored?.[PAIRING_STORAGE_KEY] || null;
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      sendResponse({
        connected: wsClient.connected,
        killSwitch: killSwitchActive,
        wsUrl: cfg?.wsUrl || DEFAULT_WS_URL,
        paired: Boolean(cfg?.token),
        groups: tabGroups.snapshot(),
        activeTab: activeTab ? { id: activeTab.id, title: activeTab.title, url: activeTab.url } : null,
      });
      return;
    }
    if (type === 'pair') {
      const wsUrl = String(message.wsUrl || DEFAULT_WS_URL).trim();
      const token = String(message.token || '').trim();
      if (!wsUrl || !token) {
        sendResponse({ ok: false, error: 'Both WebSocket URL and pairing token are required.' });
        return;
      }
      await chrome.storage.local.set({ [PAIRING_STORAGE_KEY]: { wsUrl, token } });
      wsClient.disconnect();
      wsClient.connect(wsUrl, token);
      sendResponse({ ok: true });
      return;
    }
    if (type === 'disconnect') {
      wsClient.disconnect();
      await chrome.storage.local.remove(PAIRING_STORAGE_KEY);
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'stop_group') {
      await tabGroups.stopGroup(message.ownerKey, true);
      syncState();
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'kill_all') {
      killSwitchActive = true;
      await tabGroups.killAll(Boolean(message.closeTabs));
      syncState();
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'share_tab') {
      const groups = await tabGroups.shareTab(message.ownerKey, Number(message.tabId));
      syncState();
      sendResponse({ ok: true, groups });
      return;
    }
    if (type === 'unshare_tab') {
      const groups = await tabGroups.unshareTab(message.ownerKey, Number(message.tabId));
      syncState();
      sendResponse({ ok: true, groups });
      return;
    }
    sendResponse({ ok: false, error: 'Unknown action' });
  })().catch(err => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

void loadPairingAndConnect();
