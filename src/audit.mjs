// Audit log for browser extension actions. Records who acted, which tool
// and tab/host, policy decision, and redacted error summary — never typed text,
// form values, cookies, or pairing tokens.

import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveText } from './protocol.mjs';

const clip = (value, max) => {
  if (!value) return null;
  const clean = redactSensitiveText(String(value)).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};

export class AuditLog {
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.maxRows = Math.max(50, opts.maxRows || 500);
    this.rows = [];
    this.nextId = 1;
  }

  record(entry, at = new Date().toISOString()) {
    const row = {
      id: this.nextId++,
      at,
      sessionId: clip(entry.sessionId, 120),
      seat: clip(entry.seat, 60),
      via: entry.via || 'http',
      tool: clip(entry.tool, 80) ?? '(invalid)',
      tabId: typeof entry.tabId === 'number' && Number.isFinite(entry.tabId) ? Math.round(entry.tabId) : null,
      host: clip(entry.host, 120),
      decision: entry.decision === 'block' ? 'block' : 'allow',
      ok: Boolean(entry.ok),
      errorSummary: clip(entry.errorSummary, 240),
      durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
    };
    this.rows.unshift(row);
    if (this.rows.length > this.maxRows) {
      this.rows.length = this.maxRows;
    }
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      } catch {
        // never fail tool dispatch if audit disk write fails
      }
    }
    return row;
  }

  recent(limit = 50) {
    const safeLimit = Math.min(this.maxRows, Math.max(1, Math.round(Number(limit) || 50)));
    return this.rows.slice(0, safeLimit);
  }
}
