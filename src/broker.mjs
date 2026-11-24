// Central browser automation broker: manages connected extension sockets,
// tab-group ownership verification, per-tab FIFO action queues, MCP formatting,
// and stop / kill-switch controls.

import crypto from 'node:crypto';
import {
  BROWSER_TOOLS,
  colorForSeat,
  makeGroupTitle,
  makeOwnerKey,
  redactSensitiveText,
} from './protocol.mjs';
import { evaluateCall } from './policy.mjs';

const TOOL_SET = new Set(BROWSER_TOOLS.map(t => t.name));

const TAB_SCOPED_TOOLS = new Set([
  'browser_tab_close',
  'browser_navigate',
  'browser_read_page',
  'browser_find',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_scroll',
  'browser_screenshot',
  'browser_console',
  'browser_network',
]);

const MUTATING_TOOLS = new Set([
  'browser_tab_open',
  'browser_tab_close',
  'browser_navigate',
  'browser_group_close',
]);

const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v);

export class BrowserBroker {
  constructor(deps) {
    this.audit = deps.audit;
    this.getSettings = deps.settings;
    this.onChange = deps.onChange ?? (() => {});
    this.serverVersion = deps.serverVersion ?? '0.2.0';
    this.groupPrefix = deps.groupPrefix ?? 'Agent';
    this.clients = new Map();
    this.pending = new Map();
    this.queues = new Map();
    this.heartbeatTimer = null;
  }

  startHeartbeat(intervalMs = 25_000) {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const ts = Date.now();
      for (const client of this.clients.values()) {
        if (!client.ws.isOpen()) continue;
        client.ws.ping(ts);
        this._send(client.ws, { type: 'ping', ts });
      }
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: { code: 'not_connected', message: 'Browser broker stopped.' } });
    }
    this.pending.clear();
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }

  attachSocket(ws) {
    let clientId = null;

    ws.onPong(() => {
      if (clientId && this.clients.has(clientId)) {
        this.clients.get(clientId).lastSeenAt = new Date().toISOString();
      }
    });

    ws.onMessage(raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello') {
        const browserId = String(msg.browserId || '').trim() || `browser-${crypto.randomUUID().slice(0, 8)}`;
        const prior = this.clients.get(browserId);
        if (prior && prior.ws !== ws) {
          prior.ws.close(1000, 'Replaced by newer connection');
        }
        clientId = browserId;
        const now = new Date().toISOString();
        const client = {
          browserId,
          browserName: String(msg.browserName || 'Chromium').slice(0, 60),
          version: String(msg.version || '').slice(0, 40),
          extensionVersion: String(msg.extensionVersion || '0.2.0').slice(0, 20),
          connectedAt: now,
          lastSeenAt: now,
          ws,
          groups: this._normalizeGroups(browserId, msg.groups),
        };
        this.clients.set(browserId, client);
        const settings = this.getSettings();
        this._send(ws, { type: 'welcome', serverVersion: this.serverVersion, killSwitch: settings.killSwitch });
        if (settings.killSwitch) {
          this._send(ws, { type: 'kill_all', closeTabs: false });
        }
        this.onChange();
        return;
      }

      if (msg.type === 'state_sync') {
        if (!clientId) return;
        const client = this.clients.get(clientId);
        if (!client) return;
        client.lastSeenAt = new Date().toISOString();
        client.groups = this._normalizeGroups(clientId, msg.groups);
        this.onChange();
        return;
      }

      if (msg.type === 'result') {
        if (clientId && this.clients.has(clientId)) {
          this.clients.get(clientId).lastSeenAt = new Date().toISOString();
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve({ ok: Boolean(msg.ok), data: msg.data, error: msg.error });
        return;
      }

      if (msg.type === 'pong') {
        if (clientId && this.clients.has(clientId)) {
          this.clients.get(clientId).lastSeenAt = new Date().toISOString();
        }
      }
    });

    const cleanup = () => {
      if (!clientId) return;
      const current = this.clients.get(clientId);
      if (current && current.ws === ws) {
        this.clients.delete(clientId);
        for (const [id, pending] of this.pending.entries()) {
          if (pending.browserId === clientId) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.resolve({ ok: false, error: { code: 'not_connected', message: 'Browser extension disconnected.' } });
          }
        }
        this.onChange();
      }
    };

    ws.onClose(cleanup);
    ws.onError(() => cleanup());
  }

  status(urls) {
    const settings = this.getSettings();
    const clients = [];
    const groups = [];
    for (const c of this.clients.values()) {
      if (!c.ws.isOpen()) continue;
      clients.push({
        browserId: c.browserId,
        browserName: c.browserName,
        version: c.version,
        extensionVersion: c.extensionVersion,
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt,
        groups: c.groups,
      });
      groups.push(...c.groups);
    }
    return {
      connected: clients.length > 0,
      enabled: settings.enabled,
      killSwitch: settings.killSwitch,
      clients,
      groups,
      wsUrl: urls.wsUrl,
      mcpUrl: urls.mcpUrl,
      pairingHint: urls.pairingHint,
      extensionPath: urls.extensionPath,
    };
  }

  tools() {
    return BROWSER_TOOLS;
  }

  stopGroup(ownerKey, closeTabs = true) {
    let found = false;
    for (const client of this.clients.values()) {
      const idx = client.groups.findIndex(g => g.ownerKey === ownerKey);
      if (idx >= 0) {
        found = true;
        client.groups.splice(idx, 1);
      }
      if (client.ws.isOpen()) {
        this._send(client.ws, { type: 'stop_group', ownerKey, closeTabs });
      }
    }
    for (const [id, p] of this.pending.entries()) {
      if (p.ownerKey === ownerKey) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: { code: 'kill_switch_active', message: 'Tab group stopped by owner.' } });
      }
    }
    this.onChange();
    return { stopped: found, ownerKey };
  }

  killAll(closeTabs = false) {
    let stoppedGroups = 0;
    for (const client of this.clients.values()) {
      stoppedGroups += client.groups.length;
      client.groups = [];
      if (client.ws.isOpen()) {
        this._send(client.ws, { type: 'kill_all', closeTabs });
      }
    }
    for (const [id, p] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: { code: 'kill_switch_active', message: 'Stopped by browser Kill Switch.' } });
    }
    this.onChange();
    return { stoppedGroups };
  }

  async call(input) {
    const start = Date.now();
    const rawTool = typeof input.tool === 'string' ? input.tool.trim() : '';
    const sessionId = input.sessionId?.trim() || 'adhoc';
    const seat = input.seat?.trim() || 'agent';
    const ownerKey = makeOwnerKey(sessionId, seat);

    const fail = (httpStatus, code, message, opts = {}) => {
      const durationMs = Date.now() - start;
      this.audit.record({
        sessionId,
        seat,
        via: input.via || 'http',
        tool: rawTool || '(missing)',
        tabId: opts.tabId ?? null,
        host: opts.host ?? null,
        decision: opts.decision ?? 'allow',
        ok: false,
        errorSummary: message,
        durationMs,
      });
      return { httpStatus, ok: false, tool: rawTool, durationMs, error: { code, message } };
    };

    if (!rawTool || !TOOL_SET.has(rawTool)) {
      return fail(400, 'bad_request', `Unknown browser tool: ${rawTool || '(empty)'}`);
    }
    const tool = rawTool;

    if (input.args !== undefined && !isRecord(input.args)) {
      return fail(400, 'bad_request', 'Tool arguments must be a JSON object.');
    }
    const args = isRecord(input.args) ? { ...input.args } : {};

    let tabId = null;
    if (TAB_SCOPED_TOOLS.has(tool)) {
      const rawTab = Number(args.tabId);
      if (!Number.isInteger(rawTab) || rawTab <= 0) {
        return fail(400, 'bad_request', `${tool} requires a positive integer tabId.`);
      }
      tabId = rawTab;
    }

    const client = this._pickClient(ownerKey);
    if (!client) {
      return fail(
        409,
        'not_connected',
        'No browser extension is connected. Load the extension in Chrome/Brave/Edge and pair it.',
        { tabId },
      );
    }

    const callerGroup = client.groups.find(g => g.ownerKey === ownerKey) ?? null;
    let knownTab = null;
    if (tabId !== null) {
      if (!callerGroup) {
        return fail(403, 'tab_not_owned', `Tab ${tabId} is not in ${seat}'s tab group.`, { tabId, decision: 'block' });
      }
      knownTab = callerGroup.tabs.find(t => t.tabId === tabId) ?? null;
      if (!knownTab && !callerGroup.sharedTabIds.includes(tabId)) {
        return fail(403, 'tab_not_owned', `Tab ${tabId} does not belong to ${seat}'s tab group.`, { tabId, decision: 'block' });
      }
    }

    const settings = this.getSettings();
    const policy = evaluateCall(tool, args, settings, knownTab?.url ?? null);
    if (!policy.allowed) {
      return fail(403, policy.code ?? 'policy_blocked', policy.reason ?? 'Blocked by browser policy.', {
        tabId,
        host: policy.host,
        decision: 'block',
      });
    }

    if (tool === 'browser_tab_open' && !callerGroup) {
      const totalGroups = [...this.clients.values()].reduce((acc, c) => acc + c.groups.length, 0);
      if (totalGroups >= settings.maxGroups) {
        return fail(429, 'group_limit_reached', `Max concurrent agent tab groups (${settings.maxGroups}) reached.`, {
          tabId,
          host: policy.host,
          decision: 'block',
        });
      }
    }

    const queueKey = tabId !== null ? `${client.browserId}:tab:${tabId}` : `${client.browserId}:group:${ownerKey}`;

    const dispatched = await this._enqueue(queueKey, () =>
      this._dispatch(
        client,
        {
          ownerKey,
          sessionId,
          seat,
          groupTitle: makeGroupTitle(sessionId, seat, this.groupPrefix),
          groupColor: colorForSeat(seat),
          tool,
          args,
        },
        settings.actionTimeoutMs,
      ),
    );

    const durationMs = Date.now() - start;
    if (!dispatched.ok) {
      const code = dispatched.error?.code ?? 'tool_error';
      const msg = dispatched.error?.message ?? 'Browser tool failed.';
      const status = code === 'timeout' ? 504 : code === 'not_connected' ? 409 : code === 'tab_not_owned' ? 403 : 400;
      this.audit.record({
        sessionId,
        seat,
        via: input.via || 'http',
        tool,
        tabId,
        host: policy.host,
        decision: code === 'tab_not_owned' ? 'block' : 'allow',
        ok: false,
        errorSummary: msg,
        durationMs,
      });
      return { httpStatus: status, ok: false, tool, durationMs, error: { code, message: redactSensitiveText(msg) } };
    }

    this._applyOptimisticState(client, ownerKey, sessionId, seat, tool, tabId, dispatched.data);

    const host = this._resolveResultHost(policy.host, dispatched.data);
    this.audit.record({
      sessionId,
      seat,
      via: input.via || 'http',
      tool,
      tabId: tabId ?? (isRecord(dispatched.data) && typeof dispatched.data.tabId === 'number' ? dispatched.data.tabId : null),
      host,
      decision: 'allow',
      ok: true,
      errorSummary: null,
      durationMs,
    });
    if (MUTATING_TOOLS.has(tool)) {
      this.onChange();
    }

    return {
      httpStatus: 200,
      ok: true,
      tool,
      durationMs,
      result: this._formatMcpResult(tool, dispatched.data),
    };
  }

  _pickClient(ownerKey) {
    const openClients = [...this.clients.values()].filter(c => c.ws.isOpen());
    if (openClients.length === 0) return null;
    const ownerClient = openClients.find(c => c.groups.some(g => g.ownerKey === ownerKey));
    if (ownerClient) return ownerClient;
    return openClients.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  }

  _enqueue(key, task) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    const tail = run.then(
      () => { if (this.queues.get(key) === tail) this.queues.delete(key); },
      () => { if (this.queues.get(key) === tail) this.queues.delete(key); },
    );
    this.queues.set(key, tail);
    return run;
  }

  _dispatch(client, payload, timeoutMs) {
    if (!client.ws.isOpen()) {
      return Promise.resolve({ ok: false, error: { code: 'not_connected', message: 'Browser extension disconnected.' } });
    }
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'timeout', message: `${payload.tool} timed out after ${timeoutMs}ms.` } });
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { id, browserId: client.browserId, ownerKey: payload.ownerKey, resolve, timer });
      const sent = this._send(client.ws, { type: 'invoke', id, ...payload });
      if (!sent) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: { code: 'not_connected', message: 'Failed to send command to browser extension.' } });
      }
    });
  }

  _applyOptimisticState(client, ownerKey, sessionId, seat, tool, tabId, data) {
    const now = new Date().toISOString();
    if (tool === 'browser_tab_open' && isRecord(data) && typeof data.tabId === 'number') {
      const groupId = typeof data.groupId === 'number' ? data.groupId : -1;
      const tab = {
        tabId: data.tabId,
        groupId,
        url: typeof data.url === 'string' ? data.url : 'about:blank',
        title: typeof data.title === 'string' ? data.title : '',
      };
      let group = client.groups.find(g => g.ownerKey === ownerKey);
      if (!group) {
        group = {
          sessionId,
          seat,
          ownerKey,
          groupId,
          title: makeGroupTitle(sessionId, seat, this.groupPrefix),
          color: colorForSeat(seat),
          browserId: client.browserId,
          tabs: [],
          sharedTabIds: [],
          lastActiveAt: now,
        };
        client.groups.push(group);
      } else {
        if (groupId > 0) group.groupId = groupId;
        group.lastActiveAt = now;
      }
      if (!group.tabs.some(t => t.tabId === tab.tabId)) group.tabs.push(tab);
      return;
    }

    if (tool === 'browser_navigate' && tabId !== null && isRecord(data)) {
      const group = client.groups.find(g => g.ownerKey === ownerKey);
      const tab = group?.tabs.find(t => t.tabId === tabId);
      if (tab) {
        if (typeof data.url === 'string') tab.url = data.url;
        if (typeof data.title === 'string') tab.title = data.title;
      }
      if (group) group.lastActiveAt = now;
      return;
    }

    if (tool === 'browser_tab_close' && tabId !== null) {
      const group = client.groups.find(g => g.ownerKey === ownerKey);
      if (group) {
        group.tabs = group.tabs.filter(t => t.tabId !== tabId);
        group.sharedTabIds = group.sharedTabIds.filter(id => id !== tabId);
        group.lastActiveAt = now;
        if (group.tabs.length === 0 && group.sharedTabIds.length === 0) {
          client.groups = client.groups.filter(g => g.ownerKey !== ownerKey);
        }
      }
      return;
    }

    if (tool === 'browser_group_close') {
      client.groups = client.groups.filter(g => g.ownerKey !== ownerKey);
    }
  }

  _resolveResultHost(fallback, data) {
    if (isRecord(data) && typeof data.url === 'string') {
      try {
        return new URL(data.url).hostname.toLowerCase() || fallback;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  _formatMcpResult(tool, data) {
    if (tool === 'browser_screenshot' && isRecord(data) && typeof data.data === 'string') {
      const { data: base64Png, ...meta } = data;
      return {
        content: [
          { type: 'image', data: base64Png, mimeType: 'image/png' },
          { type: 'text', text: redactSensitiveText(JSON.stringify(meta, null, 2)) },
        ],
        structuredContent: meta,
      };
    }
    const text = redactSensitiveText(JSON.stringify(data ?? {}, null, 2));
    return {
      content: [{ type: 'text', text }],
      structuredContent: data,
    };
  }

  _normalizeGroups(browserId, raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item.ownerKey !== 'string') continue;
      const tabs = Array.isArray(item.tabs)
        ? item.tabs
            .filter(t => isRecord(t) && typeof t.tabId === 'number')
            .map(t => ({
              tabId: Number(t.tabId),
              groupId: typeof t.groupId === 'number' ? t.groupId : -1,
              url: typeof t.url === 'string' ? t.url : '',
              title: typeof t.title === 'string' ? t.title : '',
              status: typeof t.status === 'string' ? t.status : undefined,
              shared: t.shared === true,
            }))
        : [];
      out.push({
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : 'adhoc',
        seat: typeof item.seat === 'string' ? item.seat : 'agent',
        ownerKey: item.ownerKey,
        groupId: typeof item.groupId === 'number' ? item.groupId : -1,
        title: typeof item.title === 'string' ? item.title : item.ownerKey,
        color: typeof item.color === 'string' ? item.color : 'pink',
        browserId,
        tabs,
        sharedTabIds: Array.isArray(item.sharedTabIds)
          ? item.sharedTabIds.filter(n => typeof n === 'number')
          : [],
        lastActiveAt: typeof item.lastActiveAt === 'string' ? item.lastActiveAt : new Date().toISOString(),
      });
    }
    return out;
  }

  _send(ws, msg) {
    return ws.send(JSON.stringify(msg));
  }
}
