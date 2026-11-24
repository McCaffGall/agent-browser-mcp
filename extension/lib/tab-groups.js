// Manages per-agent named, colored tab groups and explicit owner tab sharing.
// Persists state in chrome.storage.session so MV3 service worker restarts never
// lose tab-group ownership, and revokes access immediately if a tab is dragged
// out of its group or closed.

const STORAGE_KEY = 'agent_browser_groups_v1';

export class TabGroupManager {
  constructor(chromeApi, options = {}) {
    this.chrome = chromeApi;
    this.onRevokeTab = options.onRevokeTab || (async () => {});
    this.onChange = options.onChange || (() => {});
    this.groups = new Map(); // ownerKey -> { sessionId, seat, ownerKey, groupId, title, color, sharedTabIds, tabs, lastActiveAt }
    this.readyPromise = null;
  }

  async init() {
    if (!this.readyPromise) {
      this.readyPromise = this._load();
    }
    return this.readyPromise;
  }

  async _load() {
    const store = this.chrome.storage?.session;
    if (!store) return;
    try {
      const res = await store.get(STORAGE_KEY);
      const saved = res?.[STORAGE_KEY];
      if (Array.isArray(saved)) {
        for (const g of saved) {
          if (g && typeof g.ownerKey === 'string') {
            this.groups.set(g.ownerKey, {
              sessionId: g.sessionId || 'adhoc',
              seat: g.seat || 'agent',
              ownerKey: g.ownerKey,
              groupId: typeof g.groupId === 'number' ? g.groupId : -1,
              title: g.title || g.ownerKey,
              color: g.color || 'pink',
              sharedTabIds: Array.isArray(g.sharedTabIds) ? [...g.sharedTabIds] : [],
              tabs: Array.isArray(g.tabs) ? [...g.tabs] : [],
              lastActiveAt: g.lastActiveAt || new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      // ignore storage errors in restricted environments
    }
    await this.reconcile();
  }

  async _persist() {
    const store = this.chrome.storage?.session;
    if (!store) return;
    try {
      await store.set({ [STORAGE_KEY]: [...this.groups.values()] });
    } catch {
      // ignore
    }
  }

  async reconcile() {
    let changed = false;
    for (const [ownerKey, entry] of [...this.groups.entries()]) {
      const liveTabs = [];
      if (entry.groupId > 0) {
        try {
          const queried = await this.chrome.tabs.query({ groupId: entry.groupId });
          for (const t of queried) {
            if (typeof t.id === 'number') {
              liveTabs.push({
                tabId: t.id,
                groupId: entry.groupId,
                url: t.url || t.pendingUrl || '',
                title: t.title || '',
                status: t.status,
              });
            }
          }
        } catch {
          entry.groupId = -1;
        }
      }

      const nextShared = [];
      for (const tabId of entry.sharedTabIds) {
        try {
          const t = await this.chrome.tabs.get(tabId);
          if (t && typeof t.id === 'number') {
            nextShared.push(t.id);
            if (!liveTabs.some(x => x.tabId === t.id)) {
              liveTabs.push({
                tabId: t.id,
                groupId: typeof t.groupId === 'number' ? t.groupId : -1,
                url: t.url || t.pendingUrl || '',
                title: t.title || '',
                status: t.status,
                shared: true,
              });
            }
          }
        } catch {
          changed = true;
        }
      }

      entry.sharedTabIds = nextShared;
      entry.tabs = liveTabs;
      if (liveTabs.length === 0) {
        this.groups.delete(ownerKey);
        changed = true;
      }
    }
    if (changed) await this._persist();
    return this.snapshot();
  }

  snapshot() {
    return [...this.groups.values()].map(g => ({
      sessionId: g.sessionId,
      seat: g.seat,
      ownerKey: g.ownerKey,
      groupId: g.groupId,
      title: g.title,
      color: g.color,
      tabs: g.tabs,
      sharedTabIds: g.sharedTabIds,
      lastActiveAt: g.lastActiveAt,
    }));
  }

  async _findNormalWindowId() {
    const wins = await this.chrome.windows.getAll({ windowTypes: ['normal'] });
    const focused = wins.find(w => w.focused && typeof w.id === 'number');
    if (focused) return focused.id;
    const any = wins.find(w => typeof w.id === 'number');
    if (any) return any.id;
    const created = await this.chrome.windows.create({ focused: false, type: 'normal' });
    return created.id;
  }

  async openTab({ ownerKey, sessionId, seat, groupTitle, groupColor, url }) {
    await this.init();
    let entry = this.groups.get(ownerKey);
    let windowId;
    if (entry && entry.groupId > 0) {
      try {
        const grp = await this.chrome.tabGroups.get(entry.groupId);
        windowId = grp.windowId;
      } catch {
        entry.groupId = -1;
      }
    }
    if (windowId === undefined) {
      windowId = await this._findNormalWindowId();
    }

    // Never activate the new tab or focus the window: the owner keeps their active tab and cursor.
    const tab = await this.chrome.tabs.create({
      windowId,
      url: url || 'about:blank',
      active: false,
    });

    let groupId;
    if (entry && entry.groupId > 0) {
      groupId = await this.chrome.tabs.group({ tabIds: [tab.id], groupId: entry.groupId });
    } else {
      groupId = await this.chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
      await this.chrome.tabGroups.update(groupId, {
        title: groupTitle,
        color: groupColor || 'pink',
        collapsed: false,
      });
    }

    const now = new Date().toISOString();
    if (!entry) {
      entry = {
        sessionId,
        seat,
        ownerKey,
        groupId,
        title: groupTitle,
        color: groupColor || 'pink',
        sharedTabIds: [],
        tabs: [],
        lastActiveAt: now,
      };
      this.groups.set(ownerKey, entry);
    } else {
      entry.groupId = groupId;
      entry.title = groupTitle;
      entry.color = groupColor || entry.color;
      entry.lastActiveAt = now;
    }

    const tabInfo = {
      tabId: tab.id,
      groupId,
      url: tab.url || tab.pendingUrl || url || 'about:blank',
      title: tab.title || '',
      status: tab.status || 'loading',
    };
    entry.tabs = [...entry.tabs.filter(t => t.tabId !== tab.id), tabInfo];
    await this._persist();
    this.onChange();
    return { tabId: tab.id, groupId, url: tabInfo.url, title: tabInfo.title, status: tabInfo.status };
  }

  async listTabs(ownerKey) {
    await this.init();
    await this.reconcile();
    const entry = this.groups.get(ownerKey);
    if (!entry) return { groupId: -1, tabs: [] };
    return { groupId: entry.groupId, title: entry.title, color: entry.color, tabs: entry.tabs };
  }

  async assertTabAccess(ownerKey, tabId) {
    await this.init();
    const entry = this.groups.get(ownerKey);
    if (!entry) {
      return { ok: false, code: 'tab_not_owned', message: `No active tab group for ${ownerKey}.` };
    }
    let tab;
    try {
      tab = await this.chrome.tabs.get(tabId);
    } catch {
      entry.tabs = entry.tabs.filter(t => t.tabId !== tabId);
      entry.sharedTabIds = entry.sharedTabIds.filter(id => id !== tabId);
      await this._persist();
      await this.onRevokeTab(tabId);
      return { ok: false, code: 'tab_not_owned', message: `Tab ${tabId} no longer exists.` };
    }

    const inOwnGroup = entry.groupId > 0 && tab.groupId === entry.groupId;
    const isShared = entry.sharedTabIds.includes(tabId);
    if (!inOwnGroup && !isShared) {
      entry.tabs = entry.tabs.filter(t => t.tabId !== tabId);
      await this._persist();
      await this.onRevokeTab(tabId);
      this.onChange();
      return {
        ok: false,
        code: 'tab_not_owned',
        message: `Tab ${tabId} is no longer in ${entry.seat}'s tab group (access revoked).`,
      };
    }

    entry.lastActiveAt = new Date().toISOString();
    return { ok: true, tab, shared: isShared && !inOwnGroup };
  }

  async closeTab(ownerKey, tabId) {
    const check = await this.assertTabAccess(ownerKey, tabId);
    if (!check.ok) return check;
    const entry = this.groups.get(ownerKey);
    await this.onRevokeTab(tabId);
    if (check.shared) {
      // Never close an owner-shared tab; simply unshare it.
      entry.sharedTabIds = entry.sharedTabIds.filter(id => id !== tabId);
      entry.tabs = entry.tabs.filter(t => t.tabId !== tabId);
    } else {
      try {
        await this.chrome.tabs.remove(tabId);
      } catch {
        // already closed
      }
      entry.tabs = entry.tabs.filter(t => t.tabId !== tabId);
    }
    if (entry.tabs.length === 0) {
      this.groups.delete(ownerKey);
    }
    await this._persist();
    this.onChange();
    return { ok: true, closed: !check.shared, unshared: check.shared, tabId };
  }

  async shareTab(ownerKey, tabId) {
    await this.init();
    const entry = this.groups.get(ownerKey);
    if (!entry) throw new Error(`Group ${ownerKey} not found.`);
    const tab = await this.chrome.tabs.get(tabId);
    if (!entry.sharedTabIds.includes(tabId)) entry.sharedTabIds.push(tabId);
    if (!entry.tabs.some(t => t.tabId === tabId)) {
      entry.tabs.push({
        tabId,
        groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
        url: tab.url || '',
        title: tab.title || '',
        status: tab.status,
        shared: true,
      });
    }
    await this._persist();
    this.onChange();
    return this.snapshot();
  }

  async unshareTab(ownerKey, tabId) {
    await this.init();
    const entry = this.groups.get(ownerKey);
    if (!entry) return this.snapshot();
    entry.sharedTabIds = entry.sharedTabIds.filter(id => id !== tabId);
    entry.tabs = entry.tabs.filter(t => t.tabId !== tabId || t.groupId === entry.groupId);
    await this.onRevokeTab(tabId);
    await this._persist();
    this.onChange();
    return this.snapshot();
  }

  async stopGroup(ownerKey, closeTabs = true) {
    await this.init();
    const entry = this.groups.get(ownerKey);
    if (!entry) return false;
    const toClose = [];
    for (const t of entry.tabs) {
      await this.onRevokeTab(t.tabId);
      if (closeTabs && !entry.sharedTabIds.includes(t.tabId)) {
        toClose.push(t.tabId);
      }
    }
    for (const id of entry.sharedTabIds) {
      await this.onRevokeTab(id);
    }
    if (toClose.length > 0) {
      try {
        await this.chrome.tabs.remove(toClose);
      } catch {
        // some tabs may already be closed
      }
    }
    this.groups.delete(ownerKey);
    await this._persist();
    this.onChange();
    return true;
  }

  async killAll(closeTabs = false) {
    await this.init();
    for (const ownerKey of [...this.groups.keys()]) {
      await this.stopGroup(ownerKey, closeTabs);
    }
  }

  async handleTabUpdated(tabId, changeInfo, tab) {
    await this.init();
    let changed = false;
    for (const [ownerKey, entry] of [...this.groups.entries()]) {
      const idx = entry.tabs.findIndex(t => t.tabId === tabId);
      const isShared = entry.sharedTabIds.includes(tabId);
      if (idx >= 0 && !isShared && entry.groupId > 0 && tab && tab.groupId !== entry.groupId) {
        // Owner dragged this tab out of the agent's group -> immediately revoke access.
        entry.tabs.splice(idx, 1);
        await this.onRevokeTab(tabId);
        if (entry.tabs.length === 0) this.groups.delete(ownerKey);
        changed = true;
        continue;
      }
      if (idx >= 0 && tab) {
        entry.tabs[idx] = {
          ...entry.tabs[idx],
          url: tab.url || entry.tabs[idx].url,
          title: tab.title ?? entry.tabs[idx].title,
          status: changeInfo.status ?? tab.status ?? entry.tabs[idx].status,
        };
        if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') changed = true;
      }
    }
    if (changed) {
      await this._persist();
      this.onChange();
    }
  }

  async handleTabRemoved(tabId) {
    await this.init();
    let changed = false;
    for (const [ownerKey, entry] of [...this.groups.entries()]) {
      const had = entry.tabs.some(t => t.tabId === tabId) || entry.sharedTabIds.includes(tabId);
      if (!had) continue;
      entry.tabs = entry.tabs.filter(t => t.tabId !== tabId);
      entry.sharedTabIds = entry.sharedTabIds.filter(id => id !== tabId);
      await this.onRevokeTab(tabId);
      if (entry.tabs.length === 0) this.groups.delete(ownerKey);
      changed = true;
    }
    if (changed) {
      await this._persist();
      this.onChange();
    }
  }

  async handleGroupRemoved(groupId) {
    await this.init();
    let changed = false;
    for (const [ownerKey, entry] of [...this.groups.entries()]) {
      if (entry.groupId !== groupId) continue;
      for (const t of entry.tabs) await this.onRevokeTab(t.tabId);
      this.groups.delete(ownerKey);
      changed = true;
    }
    if (changed) {
      await this._persist();
      this.onChange();
    }
  }
}
