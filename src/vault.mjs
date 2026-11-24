// Private per-install pairing token for the browser extension WebSocket.
// Stored owner-only (0600) outside git, never included in public /status or audit rows.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultHomeDir() {
  return process.env.AGENT_BROWSER_HOME || path.join(os.homedir(), '.config', 'agent-browser-mcp');
}

export class PairingVault {
  constructor(file = path.join(defaultHomeDir(), 'vault.json')) {
    this.file = file;
  }

  path() {
    return this.file;
  }

  read() {
    try {
      this._tightenMode();
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed?.version !== 1 || typeof parsed.token !== 'string' || parsed.token.length < 16) return null;
      return {
        version: 1,
        token: parsed.token,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  _write(data) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  /** Return the current pairing token, generating and saving one if missing. */
  token() {
    const existing = this.read();
    if (existing) return existing.token;
    return this.rotate();
  }

  /** Mint a fresh 256-bit hex pairing token and save it atomically. */
  rotate() {
    const next = {
      version: 1,
      token: crypto.randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this._write(next);
    return next.token;
  }

  verify(candidate) {
    if (!candidate) return false;
    const expected = this.token();
    const a = Buffer.from(String(candidate));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  hint() {
    const t = this.token();
    return `${t.slice(0, 6)}…`;
  }

  _tightenMode() {
    try {
      const st = fs.statSync(this.file);
      if ((st.mode & 0o077) !== 0) fs.chmodSync(this.file, 0o600);
    } catch {
      // file does not exist yet
    }
  }
}
