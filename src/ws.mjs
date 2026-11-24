// Minimal RFC 6455 WebSocket upgrade & framing over Node's raw http.Server
// socket. Keeps agent-browser-mcp zero-dependency while giving the browser
// extension a fast, authenticated loopback channel.

import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildFrame(opcode, payload) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen = 4;
  else if (len >= 65536) headerLen = 10;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = len;
  } else if (len < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(frame, headerLen);
  return frame;
}

export function rejectUpgrade(socket, statusCode, statusText, message) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  } catch {
    // ignore write failures on closing socket
  }
  socket.destroy();
}

export function acceptWebSocket(req, socket, head, maxPayloadBytes = 16 * 1024 * 1024) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key.trim()) {
    rejectUpgrade(socket, 400, 'Bad Request', 'Missing Sec-WebSocket-Key');
    return null;
  }

  const accept = crypto.createHash('sha1').update(key.trim() + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );

  let open = true;
  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragChunks = null;
  let fragOpcode = 0;

  const messageHandlers = [];
  const pongHandlers = [];
  const closeHandlers = [];
  const errorHandlers = [];

  const emitClose = () => {
    if (!open) return;
    open = false;
    for (const h of closeHandlers) h();
  };

  const emitError = err => {
    for (const h of errorHandlers) h(err);
  };

  const sendRaw = (opcode, payload) => {
    if (!open || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(buildFrame(opcode, payload));
      return true;
    } catch (err) {
      emitError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  };

  const close = (code = 1000, reason = '') => {
    if (!open) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    sendRaw(0x8, payload);
    open = false;
    try {
      socket.end();
    } catch {
      socket.destroy();
    }
    for (const h of closeHandlers) h();
  };

  const processBuffer = () => {
    while (buffer.length >= 2 && open) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxPayloadBytes)) {
          close(1009, 'Payload too large');
          return;
        }
        payloadLen = Number(big);
        offset = 10;
      }

      if (payloadLen > maxPayloadBytes) {
        close(1009, 'Payload too large');
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }

      buffer = buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x8) {
        close(1000, '');
        return;
      }
      if (opcode === 0x9) {
        sendRaw(0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        for (const h of pongHandlers) h();
        continue;
      }
      if (opcode === 0x0) {
        if (!fragChunks) {
          close(1002, 'Unexpected continuation frame');
          return;
        }
        fragChunks.push(payload);
        if (fin) {
          const joined = Buffer.concat(fragChunks);
          const text = joined.toString('utf8');
          const op = fragOpcode;
          fragChunks = null;
          fragOpcode = 0;
          if (op === 0x1) {
            for (const h of messageHandlers) h(text);
          }
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          fragChunks = [payload];
          fragOpcode = opcode;
          continue;
        }
        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          for (const h of messageHandlers) h(text);
        }
        continue;
      }
      close(1003, 'Unsupported frame opcode');
      return;
    }
  };

  socket.on('data', chunk => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (buffer.length > maxPayloadBytes + 1024) {
      close(1009, 'Buffer exceeded limit');
      return;
    }
    processBuffer();
  });

  socket.on('close', emitClose);
  socket.on('end', emitClose);
  socket.on('error', err => {
    emitError(err);
    emitClose();
  });

  if (buffer.length > 0) queueMicrotask(processBuffer);

  return {
    send: text => sendRaw(0x1, Buffer.from(text, 'utf8')),
    ping: (ts = Date.now()) => sendRaw(0x9, Buffer.from(String(ts), 'utf8')),
    close,
    isOpen: () => open && !socket.destroyed,
    onMessage: handler => { messageHandlers.push(handler); },
    onPong: handler => { pongHandlers.push(handler); },
    onClose: handler => { closeHandlers.push(handler); },
    onError: handler => { errorHandlers.push(handler); },
  };
}
