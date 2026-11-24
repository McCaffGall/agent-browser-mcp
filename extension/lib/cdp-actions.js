// Dispatches all browser automation actions into a specific target tab using
// chrome.debugger (Chrome DevTools Protocol). Never uses OS-level mouse/keyboard
// events, never switches the owner's active tab or window focus, and redacts
// passwords/tokens/cookies in all outputs.

import { redactHeaders, redactText, redactUrl } from './redaction.js';

const MAX_BUFFER = 200;

export class CdpController {
  constructor(chromeApi, tabGroups) {
    this.chrome = chromeApi;
    this.tabGroups = tabGroups;
    this.attached = new Set();
    this.consoleByTab = new Map();
    this.networkByTab = new Map();
    this.pendingRequests = new Map();

    if (this.chrome.debugger?.onEvent) {
      this.chrome.debugger.onEvent.addListener((source, method, params) => {
        if (typeof source?.tabId === 'number') {
          this._onDebuggerEvent(source.tabId, method, params || {});
        }
      });
    }
    if (this.chrome.debugger?.onDetach) {
      this.chrome.debugger.onDetach.addListener(source => {
        if (typeof source?.tabId === 'number') {
          this.attached.delete(source.tabId);
        }
      });
    }
  }

  async detachTab(tabId) {
    if (!this.attached.has(tabId)) return;
    this.attached.delete(tabId);
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
  }

  async ensureAttached(tabId) {
    if (this.attached.has(tabId)) return;
    try {
      await this.chrome.debugger.attach({ tabId }, '1.3');
      this.attached.add(tabId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Another debugger is already attached/i.test(msg)) {
        throw new Error(`Another debugger (such as DevTools) is already attached to tab ${tabId}.`);
      }
      throw err;
    }
    await this._cdp(tabId, 'Page.enable');
    await this._cdp(tabId, 'Runtime.enable');
    await this._cdp(tabId, 'DOM.enable');
    await this._cdp(tabId, 'Log.enable');
    await this._cdp(tabId, 'Network.enable');
    // Emulate focus inside this tab's renderer so CDP mouse/text events work on background tabs without stealing OS/window focus.
    await this._cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }

  async _cdp(tabId, method, params = {}) {
    return this.chrome.debugger.sendCommand({ tabId }, method, params);
  }

  _pushRing(map, tabId, entry) {
    let arr = map.get(tabId);
    if (!arr) {
      arr = [];
      map.set(tabId, arr);
    }
    arr.push(entry);
    if (arr.length > MAX_BUFFER) arr.splice(0, arr.length - MAX_BUFFER);
  }

  _onDebuggerEvent(tabId, method, params) {
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args)
        ? params.args.map(a => (a.value !== undefined ? String(a.value) : a.description || a.type || '')).join(' ')
        : '';
      this._pushRing(this.consoleByTab, tabId, {
        at: new Date().toISOString(),
        level: params.type || 'log',
        text: redactText(args).slice(0, 1000),
      });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      const text = details.exception?.description || details.text || 'Uncaught exception';
      this._pushRing(this.consoleByTab, tabId, {
        at: new Date().toISOString(),
        level: 'error',
        text: redactText(String(text)).slice(0, 1000),
      });
      return;
    }
    if (method === 'Log.entryAdded') {
      const entry = params.entry || {};
      this._pushRing(this.consoleByTab, tabId, {
        at: new Date().toISOString(),
        level: entry.level || 'info',
        text: redactText(String(entry.text || '')).slice(0, 1000),
      });
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const req = params.request || {};
      const record = {
        at: new Date().toISOString(),
        requestId: params.requestId,
        method: req.method || 'GET',
        url: redactUrl(req.url || ''),
        type: params.type || 'Other',
        requestHeaders: redactHeaders(req.headers || {}),
        status: null,
        error: null,
      };
      this.pendingRequests.set(`${tabId}:${params.requestId}`, record);
      this._pushRing(this.networkByTab, tabId, record);
      return;
    }
    if (method === 'Network.responseReceived') {
      const rec = this.pendingRequests.get(`${tabId}:${params.requestId}`);
      const res = params.response || {};
      if (rec) {
        rec.status = typeof res.status === 'number' ? res.status : null;
        rec.mimeType = res.mimeType || undefined;
      } else {
        this._pushRing(this.networkByTab, tabId, {
          at: new Date().toISOString(),
          requestId: params.requestId,
          method: 'GET',
          url: redactUrl(res.url || ''),
          status: typeof res.status === 'number' ? res.status : null,
          mimeType: res.mimeType || undefined,
        });
      }
      return;
    }
    if (method === 'Network.loadingFailed') {
      const rec = this.pendingRequests.get(`${tabId}:${params.requestId}`);
      if (rec) rec.error = params.errorText || 'failed';
    }
  }

  async _waitForTabLoad(tabId, wait = 'load', timeoutMs = 15000) {
    if (wait === 'none') return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await this.chrome.tabs.get(tabId);
        if (tab?.status === 'complete') return;
        if (wait === 'domcontentloaded' && tab?.status === 'complete') return;
      } catch {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async _eval(tabId, fnSource, arg) {
    await this.ensureAttached(tabId);
    const expr = `(${fnSource})(${JSON.stringify(arg)})`;
    const res = await this._cdp(tabId, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Script evaluation failed.');
    }
    return res?.result?.value;
  }

  async execute(msg) {
    const { ownerKey, sessionId, seat, groupTitle, groupColor, tool, args = {} } = msg;

    if (tool === 'browser_tabs_list') {
      return this.tabGroups.listTabs(ownerKey);
    }

    if (tool === 'browser_tab_open') {
      const opened = await this.tabGroups.openTab({
        ownerKey,
        sessionId,
        seat,
        groupTitle,
        groupColor,
        url: typeof args.url === 'string' ? args.url : 'about:blank',
      });
      if (args.url && args.url !== 'about:blank') {
        await this._waitForTabLoad(opened.tabId, args.wait || 'load');
        try {
          const fresh = await this.chrome.tabs.get(opened.tabId);
          opened.url = fresh.url || opened.url;
          opened.title = fresh.title || opened.title;
          opened.status = fresh.status || opened.status;
        } catch {
          // ignore
        }
      }
      return opened;
    }

    if (tool === 'browser_group_close') {
      const stopped = await this.tabGroups.stopGroup(ownerKey, true, id => this.detachTab(id));
      return { closed: stopped, ownerKey };
    }

    const tabId = Number(args.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { __error: { code: 'bad_request', message: `${tool} requires a valid tabId.` } };
    }

    if (tool === 'browser_tab_close') {
      const closed = await this.tabGroups.closeTab(ownerKey, tabId);
      if (!closed.ok) return { __error: { code: closed.code, message: closed.message } };
      return closed;
    }

    const access = await this.tabGroups.assertTabAccess(ownerKey, tabId);
    if (!access.ok) {
      return { __error: { code: access.code, message: access.message } };
    }

    switch (tool) {
      case 'browser_navigate': {
        await this.ensureAttached(tabId);
        const nav = await this._cdp(tabId, 'Page.navigate', { url: String(args.url) });
        if (nav?.errorText) {
          throw new Error(`Navigation failed: ${nav.errorText}`);
        }
        await this._waitForTabLoad(tabId, args.wait || 'load');
        const tab = await this.chrome.tabs.get(tabId);
        return { tabId, url: tab.url || String(args.url), title: tab.title || '', status: tab.status };
      }

      case 'browser_read_page': {
        const maxTextChars = Math.min(30000, Math.max(200, Number(args.maxTextChars) || 8000));
        const snapshot = await this._eval(
          tabId,
          (limit) => {
            const isVisible = (el) => {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
            const nodes = [...document.querySelectorAll(selector)].filter(isVisible).slice(0, 120);
            let nextNum = 1;
            for (const existing of document.querySelectorAll('[data-agent-ref]')) {
              const m = /^e(\d+)$/.exec(existing.getAttribute('data-agent-ref') || '');
              if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
            }
            const elements = nodes.map(el => {
              let ref = el.getAttribute('data-agent-ref');
              if (!ref) {
                ref = 'e' + nextNum++;
                el.setAttribute('data-agent-ref', ref);
              }
              const tag = el.tagName.toLowerCase();
              const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
              let value = null;
              if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                if (inputType === 'password') value = el.value ? '[redacted]' : '';
                else value = String(el.value ?? '').slice(0, 200);
              }
              const label =
                el.getAttribute('aria-label') ||
                el.getAttribute('placeholder') ||
                (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
              const r = el.getBoundingClientRect();
              return {
                ref,
                tag,
                type: inputType,
                role: el.getAttribute('role') || null,
                name: el.getAttribute('name') || null,
                label,
                value,
                href: tag === 'a' ? el.getAttribute('href') : null,
                checked: inputType === 'checkbox' || inputType === 'radio' ? Boolean(el.checked) : undefined,
                disabled: Boolean(el.disabled),
                rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
              };
            });
            const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
            return { title: document.title, url: location.href, text, elements };
          },
          maxTextChars,
        );
        return {
          tabId,
          title: snapshot.title,
          url: redactUrl(snapshot.url),
          text: redactText(snapshot.text),
          elements: snapshot.elements.map(el => ({
            ...el,
            value: typeof el.value === 'string' && el.type !== 'password' ? redactText(el.value) : el.value,
          })),
        };
      }

      case 'browser_find': {
        const query = String(args.query || '').trim();
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        const matches = await this._eval(
          tabId,
          ({ query: q, limit: lim }) => {
            const lower = q.toLowerCase();
            let candidates = [];
            try {
              if (/^[.#\[]/.test(q) || q.includes('>') || q.includes('=')) {
                candidates = [...document.querySelectorAll(q)];
              }
            } catch {
              candidates = [];
            }
            if (candidates.length === 0) {
              const all = [...document.querySelectorAll('a, button, input, select, textarea, label, [role], h1, h2, h3, p, span, div')];
              candidates = all.filter(el => {
                const hay = [
                  el.getAttribute('aria-label'),
                  el.getAttribute('placeholder'),
                  el.getAttribute('name'),
                  el.getAttribute('role'),
                  el.innerText || el.textContent,
                ].filter(Boolean).join(' ').toLowerCase();
                return hay.includes(lower);
              });
            }
            let nextNum = 1;
            for (const existing of document.querySelectorAll('[data-agent-ref]')) {
              const m = /^e(\d+)$/.exec(existing.getAttribute('data-agent-ref') || '');
              if (m) nextNum = Math.max(nextNum, Number(m[1]) + 1);
            }
            const out = [];
            for (const el of candidates) {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              let ref = el.getAttribute('data-agent-ref');
              if (!ref) {
                ref = 'e' + nextNum++;
                el.setAttribute('data-agent-ref', ref);
              }
              out.push({
                ref,
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
              });
              if (out.length >= lim) break;
            }
            return out;
          },
          { query, limit },
        );
        return { tabId, query, matches };
      }

      case 'browser_click': {
        await this.ensureAttached(tabId);
        let x = typeof args.x === 'number' ? args.x : null;
        let y = typeof args.y === 'number' ? args.y : null;
        if (x === null || y === null) {
          const target = await this._eval(
            tabId,
            ({ ref, selector }) => {
              const el = ref ? document.querySelector(`[data-agent-ref="${ref}"]`) : selector ? document.querySelector(selector) : null;
              if (!el) return { found: false };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              const r = el.getBoundingClientRect();
              return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase() };
            },
            { ref: args.ref || null, selector: args.selector || null },
          );
          if (!target?.found) {
            throw new Error(`Element not found (${args.ref || args.selector || 'missing target'}).`);
          }
          x = target.x;
          y = target.y;
        }
        const button = args.button === 'right' || args.button === 'middle' ? args.button : 'left';
        const clickCount = Math.min(3, Math.max(1, Number(args.clickCount) || 1));
        await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
        await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
        await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
        return { tabId, clicked: true, x: Math.round(x), y: Math.round(y), button };
      }

      case 'browser_type': {
        await this.ensureAttached(tabId);
        const text = String(args.text ?? '');
        const focused = await this._eval(
          tabId,
          ({ ref, selector, clear }) => {
            const el = ref ? document.querySelector(`[data-agent-ref="${ref}"]`) : selector ? document.querySelector(selector) : document.activeElement;
            if (!el) return { found: false };
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            el.focus();
            if (clear && ('value' in el)) {
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc?.set) desc.set.call(el, '');
              else el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (clear && el.isContentEditable) {
              el.textContent = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return { found: true, tag: el.tagName.toLowerCase(), x: el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2, y: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 };
          },
          { ref: args.ref || null, selector: args.selector || null, clear: Boolean(args.clear) },
        );
        if (!focused?.found) {
          throw new Error(`Target input not found (${args.ref || args.selector || 'activeElement'}).`);
        }
        if ((args.ref || args.selector) && typeof focused.x === 'number' && typeof focused.y === 'number') {
          await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: focused.x, y: focused.y, button: 'none', clickCount: 0 });
          await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1 });
          await this._cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1 });
        }
        if (text) {
          await this._cdp(tabId, 'Input.insertText', { text });
        }
        if (args.pressEnter) {
          await this._cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          await this._cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        return { tabId, typedLength: text.length, pressedEnter: Boolean(args.pressEnter) };
      }

      case 'browser_fill': {
        await this.ensureAttached(tabId);
        const fields = Array.isArray(args.fields) ? args.fields : [];
        const results = [];
        for (const f of fields) {
          const res = await this._eval(
            tabId,
            ({ ref, selector, value }) => {
              const el = ref ? document.querySelector(`[data-agent-ref="${ref}"]`) : selector ? document.querySelector(selector) : null;
              if (!el) return { ok: false, target: ref || selector || '(missing)' };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              el.focus();
              const tag = el.tagName.toLowerCase();
              const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
              if (type === 'checkbox' || type === 'radio') {
                el.checked = Boolean(value);
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return { ok: true, target: ref || selector, tag };
              }
              if (tag === 'select') {
                el.value = String(value ?? '');
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, target: ref || selector, tag };
              }
              const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc?.set) desc.set.call(el, String(value ?? ''));
              else if ('value' in el) el.value = String(value ?? '');
              else el.textContent = String(value ?? '');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, target: ref || selector, tag };
            },
            { ref: f?.ref || null, selector: f?.selector || null, value: f?.value },
          );
          results.push(res);
        }
        return { tabId, filled: results.length, results };
      }

      case 'browser_scroll': {
        await this.ensureAttached(tabId);
        if (args.ref || args.selector) {
          const out = await this._eval(
            tabId,
            ({ ref, selector }) => {
              const el = ref ? document.querySelector(`[data-agent-ref="${ref}"]`) : document.querySelector(selector);
              if (!el) return { found: false };
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              return { found: true, scrollY: Math.round(window.scrollY) };
            },
            { ref: args.ref || null, selector: args.selector || null },
          );
          if (!out?.found) throw new Error('Scroll target not found.');
          return { tabId, ...out };
        }
        const deltaX = Number(args.deltaX) || 0;
        const deltaY = Number(args.deltaY) || 400;
        await this._cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 100,
          y: 100,
          deltaX,
          deltaY,
        });
        const pos = await this._eval(tabId, () => ({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) }), null);
        return { tabId, deltaX, deltaY, ...pos };
      }

      case 'browser_screenshot': {
        await this.ensureAttached(tabId);
        const shot = await this._cdp(tabId, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: Boolean(args.fullPage),
        });
        const tab = await this.chrome.tabs.get(tabId);
        return {
          tabId,
          url: redactUrl(tab.url || ''),
          title: tab.title || '',
          mimeType: 'image/png',
          data: shot.data,
        };
      }

      case 'browser_console': {
        const list = this.consoleByTab.get(tabId) || [];
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        const entries = list.slice(-limit);
        if (args.clear) this.consoleByTab.set(tabId, []);
        return { tabId, entries };
      }

      case 'browser_network': {
        const list = this.networkByTab.get(tabId) || [];
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        const entries = list.slice(-limit);
        if (args.clear) this.networkByTab.set(tabId, []);
        return { tabId, entries };
      }

      default:
        return { __error: { code: 'bad_request', message: `Unsupported browser tool: ${tool}` } };
    }
  }
}
