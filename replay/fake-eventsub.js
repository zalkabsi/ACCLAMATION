import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A fake Twitch EventSub WebSocket server.
 *
 * It speaks the real protocol — welcome, keepalive, notification, reconnect,
 * revocation, ping/pong, close codes — on top of a tiny RFC 6455 server, so the
 * production client and the replay harness run exactly the same code. This is
 * what makes day one possible without a Twitch account.
 */
export class FakeEventSubServer extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port = 0,
    keepaliveTimeoutSeconds = 10,
    sessionId = null,
    welcomeDelayMs = 0,
    logger = null,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.keepaliveTimeoutSeconds = keepaliveTimeoutSeconds;
    this.fixedSessionId = sessionId;
    this.welcomeDelayMs = welcomeDelayMs;
    this.logger = logger;

    this.http = createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('this endpoint only speaks websocket');
    });
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    this.connections = new Map();
    this.sessions = new Map();
    this._tokens = new Map();
    this._closed = false;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, resolve);
    });
    const address = this.http.address();
    this.port = typeof address === 'object' && address ? address.port : this.port;
    this.baseUrl = `ws://${this.host}:${this.port}/ws`;
    return this;
  }

  get url() {
    return this.baseUrl;
  }

  async close() {
    this._closed = true;
    for (const connection of this.connections.values()) {
      clearInterval(connection.keepaliveTimer);
      try {
        connection.socket.destroy();
      } catch {
        /* noop */
      }
    }
    this.connections.clear();
    this.sessions.clear();
    await new Promise((resolve) => this.http.close(resolve));
  }

  /** Wait until a connection has received its welcome and is registered. */
  waitForSession(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const existing = [...this.sessions.keys()][0];
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        this.off('session', onSession);
        reject(new Error('timed out waiting for an EventSub session'));
      }, timeoutMs);
      const onSession = (sessionId) => {
        clearTimeout(timer);
        this.off('session', onSession);
        resolve(sessionId);
      };
      this.on('session', onSession);
    });
  }

  /**
   * Send a notification for a subscription type.
   * @param {string|null} sessionId null broadcasts to every connection
   */
  sendEvent(sessionId, subscriptionType, event, { version = '1', messageId = randomUUID() } = {}) {
    return this._broadcast(sessionId, {
      metadata: {
        message_id: messageId,
        message_type: 'notification',
        message_timestamp: new Date().toISOString(),
        subscription_type: subscriptionType,
        subscription_version: version,
      },
      payload: {
        subscription: {
          id: `sub-${subscriptionType}`,
          status: 'enabled',
          type: subscriptionType,
          version,
          cost: 0,
          condition: {},
          transport: { method: 'websocket', session_id: sessionId ?? 'fake' },
          created_at: new Date().toISOString(),
        },
        event,
      },
    }, sessionId);
  }

  sendRaw(sessionId, message) {
    return this._broadcast(sessionId, message, sessionId);
  }

  /** Protocol-level reconnect: new URL, same session, old socket kept briefly. */
  async forceReconnect(sessionId, { closeOldAfterMs = 60 } = {}) {
    const connection = this.sessions.get(sessionId);
    if (!connection) throw new Error(`unknown session ${sessionId}`);
    const token = randomUUID();
    this._tokens.set(token, sessionId);
    const reconnectUrl = `${this.baseUrl}?reconnect=${token}`;
    this._send(connection, {
      metadata: {
        message_id: randomUUID(),
        message_type: 'session_reconnect',
        message_timestamp: new Date().toISOString(),
      },
      payload: {
        session: {
          id: sessionId,
          status: 'reconnecting',
          keepalive_timeout_seconds: null,
          reconnect_url: reconnectUrl,
          connected_at: new Date().toISOString(),
        },
      },
    });
    connection.closeOldAfterMs = closeOldAfterMs;
    connection.replaced = true;
    return reconnectUrl;
  }

  revoke(sessionId, subscription) {
    return this.sendRaw(sessionId, {
      metadata: {
        message_id: randomUUID(),
        message_type: 'revocation',
        message_timestamp: new Date().toISOString(),
      },
      payload: { subscription: { type: 'channel.chat.message', version: '1', status: 'authorization_revoked', ...subscription } },
    });
  }

  /** Pretend the connection died without a close handshake (timeout tests). */
  hang(sessionId) {
    const connection = this.sessions.get(sessionId);
    if (!connection) return false;
    clearInterval(connection.keepaliveTimer);
    connection.silent = true;
    return true;
  }

  _broadcast(sessionId, message, onlySession = null) {
    const targets = sessionId ? [this.sessions.get(sessionId)].filter(Boolean) : [...this.sessions.values()];
    for (const connection of targets) {
      if (onlySession && connection.sessionId !== onlySession) continue;
      this._send(connection, message);
    }
    return targets.length;
  }

  _send(connection, message) {
    const payload = Buffer.from(JSON.stringify(message));
    connection.lastSentAt = Date.now();
    try {
      connection.socket.write(encodeFrame(0x1, payload));
    } catch (error) {
      this.emit('send-error', { error });
    }
  }

  _onUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('reconnect');
    const reconnectSession = token ? this._tokens.get(token) : null;
    if (reconnectSession) this._tokens.delete(token);

    const sessionId = reconnectSession ?? this.fixedSessionId ?? `session-${randomUUID().slice(0, 8)}`;
    const connection = {
      socket,
      sessionId,
      buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
      fragments: [],
      keepaliveTimer: null,
      lastSentAt: 0,
      silent: false,
      closed: false,
      isSwap: Boolean(reconnectSession),
    };
    this.connections.set(socket, connection);
    this.sessions.set(sessionId, connection);

    socket.on('data', (chunk) => this._onData(connection, chunk));
    socket.on('error', () => this._cleanup(connection));
    socket.on('close', () => this._cleanup(connection));

    this.emit('connection', { sessionId, isSwap: connection.isSwap });
    if (reconnectSession) this.emit('reconnected', { sessionId });

    const sendWelcome = () => {
      if (connection.closed) return;
      this._send(connection, welcomeMessage(sessionId, this.keepaliveTimeoutSeconds));
      this.emit('session', sessionId);
      connection.keepaliveTimer = setInterval(() => {
        if (connection.silent || connection.closed) return;
        if (Date.now() - connection.lastSentAt >= this.keepaliveTimeoutSeconds * 1000) {
          this._send(connection, {
            metadata: {
              message_id: randomUUID(),
              message_type: 'session_keepalive',
              message_timestamp: new Date().toISOString(),
            },
            payload: {},
          });
        }
      }, Math.max(50, (this.keepaliveTimeoutSeconds * 1000) / 2));
    };
    if (this.welcomeDelayMs > 0) setTimeout(sendWelcome, this.welcomeDelayMs);
    else sendWelcome();

    if (reconnectSession) {
      const old = [...this.connections.values()].find(
        (c) => c !== connection && c.sessionId === sessionId && c.replaced,
      );
      if (old) {
        setTimeout(() => {
          try {
            old.socket.write(encodeFrame(0x8, closePayload(4004, 'replaced')));
            old.socket.end();
          } catch {
            /* noop */
          }
        }, old.closeOldAfterMs ?? 60);
      }
    }
  }

  _onData(connection, chunk) {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    let parsed;
    try {
      parsed = parseFrames(connection.buffer);
    } catch (error) {
      this.emit('protocol-error', { error });
      connection.socket.destroy();
      return;
    }
    connection.buffer = parsed.rest;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        try {
          connection.socket.write(encodeFrame(0x8, closePayload(1000, 'bye')));
        } catch {
          /* noop */
        }
        connection.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        connection.socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        // EventSub clients do not send data frames; record and ignore them.
        this.emit('client-message', { sessionId: connection.sessionId, payload: frame.payload.toString('utf8') });
      }
    }
  }

  _cleanup(connection) {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.keepaliveTimer);
    this.connections.delete(connection.socket);
    if (this.sessions.get(connection.sessionId) === connection) {
      this.sessions.delete(connection.sessionId);
    }
    this.emit('close', { sessionId: connection.sessionId });
  }
}

export function welcomeMessage(sessionId, keepaliveTimeoutSeconds = 10) {
  return {
    metadata: {
      message_id: randomUUID(),
      message_type: 'session_welcome',
      message_timestamp: new Date().toISOString(),
    },
    payload: {
      session: {
        id: sessionId,
        status: 'connected',
        connected_at: new Date().toISOString(),
        keepalive_timeout_seconds: keepaliveTimeoutSeconds,
        reconnect_url: null,
      },
    },
  };
}

function closePayload(code, reason) {
  const reasonBuffer = Buffer.from(String(reason || '').slice(0, 100));
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return payload;
}

export function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  return Buffer.concat([header, payload]);
}

export function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const high = buffer.readUInt32BE(cursor);
      const low = buffer.readUInt32BE(cursor + 4);
      length = high * 2 ** 32 + low;
      cursor += 8;
    }
    if (length > 8 * 1024 * 1024) throw new Error('frame too large');
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
