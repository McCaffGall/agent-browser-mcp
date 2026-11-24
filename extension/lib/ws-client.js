// Authenticated loopback WebSocket client for Agent Browser MCP.

export class WsClient {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.wsUrl = null;
    this.token = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
  }

  connect(wsUrl, token) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.shouldReconnect = Boolean(wsUrl && token);
    if (!this.shouldReconnect) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    let url;
    try {
      const u = new URL(wsUrl);
      u.searchParams.set('token', token);
      url = u.toString();
    } catch {
      this.handlers.onStatus?.('bad_url');
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.handlers.onOpen?.();
    });

    ws.addEventListener('message', event => {
      try {
        const msg = JSON.parse(String(event.data));
        this.handlers.onMessage?.(msg);
      } catch {
        // ignore malformed broker frames
      }
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      this.handlers.onClose?.();
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // close event handles cleanup and reconnect
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'Disconnected by user');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * (2 ** Math.min(4, this.reconnectAttempts)));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect(this.wsUrl, this.token);
    }, delay);
  }
}
