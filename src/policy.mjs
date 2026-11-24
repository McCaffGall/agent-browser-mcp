// Site allow/deny rules, kill-switch policy, and local JSON config store.
// Deny rules always win over allow rules; internal browser/extension schemes
// are hard-blocked regardless of settings.

import fs from 'node:fs';
import path from 'node:path';
import { defaultHomeDir } from './vault.mjs';

export const DEFAULT_SETTINGS = {
  enabled: true,
  killSwitch: false,
  defaultPolicy: 'allow',
  allowDomains: [],
  denyDomains: [
    'chrome://*',
    'brave://*',
    'edge://*',
    'chrome-extension://*',
    'file://*',
    '*.1password.com',
    'vault.bitwarden.com',
  ],
  actionTimeoutMs: 20_000,
  maxGroups: 12,
};

const HARD_BLOCKED_PROTOCOLS = new Set([
  'chrome:',
  'brave:',
  'edge:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'file:',
  'javascript:',
  'data:',
  'blob:',
]);

const cleanDomains = raw => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const s = String(entry ?? '').trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

export function validateSettings(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const defaultPolicy = b.defaultPolicy === 'deny' ? 'deny' : 'allow';
  const timeout = Number(b.actionTimeoutMs ?? DEFAULT_SETTINGS.actionTimeoutMs);
  const maxGroups = Number(b.maxGroups ?? DEFAULT_SETTINGS.maxGroups);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120_000) {
    throw new Error('Action timeout must be between 1,000 and 120,000 ms.');
  }
  if (!Number.isFinite(maxGroups) || maxGroups < 1 || maxGroups > 50) {
    throw new Error('Max concurrent tab groups must be between 1 and 50.');
  }
  return {
    enabled: b.enabled !== false,
    killSwitch: b.killSwitch === true,
    defaultPolicy,
    allowDomains: b.allowDomains === undefined ? [...DEFAULT_SETTINGS.allowDomains] : cleanDomains(b.allowDomains),
    denyDomains: b.denyDomains === undefined ? [...DEFAULT_SETTINGS.denyDomains] : cleanDomains(b.denyDomains),
    actionTimeoutMs: Math.round(timeout),
    maxGroups: Math.round(maxGroups),
  };
}

export function matchesDomainRule(parsed, rule) {
  const r = String(rule || '').trim().toLowerCase();
  if (!r) return false;
  if (r.endsWith('://*')) {
    const scheme = r.slice(0, -3);
    return parsed.protocol === scheme;
  }
  const host = parsed.hostname.toLowerCase();
  if (r.startsWith('*.')) {
    const base = r.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === r;
}

export function evaluateUrl(rawUrl, settings, opts = {}) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || trimmed === 'about:blank') {
    if (opts.allowBlank) return { allowed: true, host: 'about:blank' };
    return { allowed: false, host: null, reason: 'A target http:// or https:// URL is required.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, host: null, reason: `Invalid URL: ${trimmed}` };
  }

  if (HARD_BLOCKED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, host: parsed.protocol, reason: `Scheme ${parsed.protocol} is blocked for agent browser access.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, host: parsed.protocol, reason: `Only http:// and https:// URLs are allowed (got ${parsed.protocol}).` };
  }

  const host = parsed.hostname.toLowerCase();
  for (const rule of settings.denyDomains) {
    if (matchesDomainRule(parsed, rule)) {
      return { allowed: false, host, reason: `Domain "${host}" is blocked by browser policy rule "${rule}".` };
    }
  }

  if (settings.defaultPolicy === 'deny') {
    const ok = settings.allowDomains.some(rule => matchesDomainRule(parsed, rule));
    if (!ok) {
      return { allowed: false, host, reason: `Domain "${host}" is not in the browser allowlist.` };
    }
  }

  return { allowed: true, host };
}

export function evaluateCall(tool, args, settings, knownTabUrl = null) {
  if (!settings.enabled) {
    return { allowed: false, code: 'browser_disabled', reason: 'Agent browser access is disabled in config.', host: null };
  }
  if (settings.killSwitch) {
    return {
      allowed: false,
      code: 'kill_switch_active',
      reason: 'Browser Kill Switch is active. Resume it via agent-browser-mcp resume or the local control page.',
      host: null,
    };
  }

  if (tool === 'browser_tab_open') {
    const url = typeof args.url === 'string' ? args.url : '';
    const check = evaluateUrl(url, settings, { allowBlank: true });
    if (!check.allowed) return { allowed: false, code: 'policy_blocked', reason: check.reason, host: check.host };
    return { allowed: true, host: check.host };
  }

  if (tool === 'browser_navigate') {
    const url = typeof args.url === 'string' ? args.url : '';
    const check = evaluateUrl(url, settings, { allowBlank: false });
    if (!check.allowed) return { allowed: false, code: 'policy_blocked', reason: check.reason, host: check.host };
    return { allowed: true, host: check.host };
  }

  if (knownTabUrl && knownTabUrl !== 'about:blank' && tool !== 'browser_tab_close' && tool !== 'browser_group_close') {
    const check = evaluateUrl(knownTabUrl, settings, { allowBlank: true });
    if (!check.allowed) return { allowed: false, code: 'policy_blocked', reason: check.reason, host: check.host };
    return { allowed: true, host: check.host };
  }

  let host = null;
  if (knownTabUrl) {
    try { host = new URL(knownTabUrl).hostname.toLowerCase() || knownTabUrl; } catch { host = null; }
  }
  return { allowed: true, host };
}

export class SettingsStore {
  constructor(file = path.join(defaultHomeDir(), 'config.json')) {
    this.file = file;
    this.cached = null;
  }

  path() {
    return this.file;
  }

  read() {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cached = validateSettings({ ...DEFAULT_SETTINGS, ...parsed });
      return this.cached;
    } catch {
      this.cached = { ...DEFAULT_SETTINGS, allowDomains: [...DEFAULT_SETTINGS.allowDomains], denyDomains: [...DEFAULT_SETTINGS.denyDomains] };
      return this.cached;
    }
  }

  save(next) {
    const validated = validateSettings(next);
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(validated, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.cached = validated;
    return validated;
  }

  patch(patchObj) {
    const current = this.read();
    return this.save({ ...current, ...(patchObj && typeof patchObj === 'object' ? patchObj : {}) });
  }
}
