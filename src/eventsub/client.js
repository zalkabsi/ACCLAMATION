import { EventEmitter } from 'node:events';

/**
 * Twitch EventSub WebSocket client (protocol v1).
 *
 * Why hand-rolled instead of a library: Node 22+ ships a WebSocket client, the
 * protocol is five message types, and the reconnect path is the part that must
 * be right. Keeping it here makes it testable against the fake server in
 * `replay/fake-eventsub.js` without network access.
 *
 * Protocol facts this implements:
 *  - first frame is session_welcome; it carries the session id subscriptions
 *    are bound to and the keepalive timeout (default 10s);
 *  - no notification/keepalive within the keepalive window => dead socket;
 *  - session_reconnect points at a new URL; connect there and only then close
 *    the old socket (the two overlap so no events are lost);
 *  - after a plain disconnect, subscriptions must be recreated by the caller
 *    (EventSub does not replay events) — `welcome` fires again for that reason.
 */
export class EventSubClient extends EventEmitter {
  constructor({
    url = 'wss://eventsub.wss.twitch.tv/ws',
    WebSocketImpl = globalThis.WebSocket,
    logger = null,
    now = () => Date.now(),
    minReconnectDelayMs = 800,
    maxReconnectDelayMs = 20000,
    welcomeTimeoutMs = 15000,
    keepaliveGraceMs = 4000,
    random = Math.random,
  } = {}) {
    super();
    if (!WebSocketImpl) throw new Error('No WebSocket implementation available');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.now = now;
    this.minReconnectDelayMs = minReconnectDelayMs;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
    this.welcomeTimeoutMs = welcomeTimeoutMs;
    this.keepaliveGraceMs = keepaliveGraceMs;
    this.random = random;

    this.status = 'idle';
    this.sessionId = null;
    this.keepaliveTimeoutSeconds = null;
    this._socket = null;
    this._stopped = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._welcomeTimer = null;
    this._swapping = false;
    this._pendingReconnectUrl = null;
    this._seenMessages = new Set();
    this._seenOrder = [];
  }

  start() {
    this._stopped = false;
    this._connect(this.url, { reason: 'initial' });
    return this;
  }

  stop() {
    this._stopped = true;
    this.status = 'stopped';
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._watchdog);
    clearTimeout(this._welcomeTimer);
    this._reconnectTimer = null;
    this._watchdog = null;
    this._welcomeTimer = null;
    if (this._socket) {
      try {
        this._socket.close(1000, 'client shutting down');
      } catch {
        /* already closed */
      }
      this._socket = null;
    }
    this.emit('stopped');
  }

  /** Reconnect immediately, e.g. after the server restarted. */
  reconnect(reason = 'manual') {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._teardownSocket();
    this._connect(this.url, { reason });
  }

  _connect(url, { reason, asSwap = false } = {}) {
    if (this._stopped) return;
    this.logger?.debug?.('eventsub connecting', { reason, asSwap });
    this.status = this._swapping ? 'reconnecting' : 'connecting';
    let socket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (error) {
      this.emit('socket-error', { error, phase: 'construct' });
      this._scheduleReconnect(reason);
      return;
    }

    if (!asSwap) {
      this._socket = socket;
    } else {
      this._swapSocket = socket;
    }

    clearTimeout(this._welcomeTimer);
    this._welcomeTimer = setTimeout(() => {
      if (socket.readyState !== 1) return;
      this.logger?.warn?.('eventsub welcome timed out', {});
      this.emit('timeout', { phase: 'welcome' });
      try {
        socket.close(4000, 'welcome timeout');
      } catch {
        /* noop */
      }
    }, this.welcomeTimeoutMs);

    socket.addEventListener('open', () => {
      this.logger?.debug?.('eventsub socket open', { asSwap });
    });

    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      this._handleFrame(data, { socket, asSwap });
    });

    socket.addEventListener('close', (event) => {
      const wasCurrent = socket === this._socket;
      const wasSwap = socket === this._swapSocket;
      this.logger?.debug?.('eventsub socket closed', { code: event.code, reason: event.reason, wasCurrent });
      this.emit('close', { code: event.code, reason: event.reason, wasCurrent, wasSwap });
      if (wasSwap) {
        this._swapSocket = null;
        if (this._swapping && this._pendingReconnectUrl && !this._stopped) {
          // The server asked us to swap, but the new socket failed. Retry the
          // reconnect URL instead of sitting on a dead session.
          const nextUrl = this._pendingReconnectUrl;
          this._swapping = false;
          this._scheduleReconnect('swap-failed', nextUrl);
        }
        return;
      }
      if (!wasCurrent || this._stopped) return;
      this._socket = null;
      clearTimeout(this._watchdog);
      this._watchdog = null;
      if (this._swapping && this._pendingReconnectUrl) {
        // The swap failed; try the reconnect URL again rather than sitting dead.
        const nextUrl = this._pendingReconnectUrl;
        this._swapping = false;
        this._scheduleReconnect('swap-failed', nextUrl);
        return;
      }
      this.status = 'disconnected';
      this._scheduleReconnect('socket-closed');
    });

    socket.addEventListener('error', (error) => {
      this.emit('socket-error', { error, phase: 'socket' });
    });
  }

  _handleFrame(data, { socket, asSwap }) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.emit('protocol-error', { error, data: String(data).slice(0, 400) });
      return;
    }
    const type = message?.metadata?.message_type;
    const messageId = message?.metadata?.message_id;
    if (messageId) {
      if (this._seenMessages.has(messageId)) return;
      this._seenMessages.add(messageId);
      this._seenOrder.push(messageId);
      if (this._seenOrder.length > 2000) this._seenMessages.delete(this._seenOrder.shift());
    }

    switch (type) {
      case 'session_welcome': {
        clearTimeout(this._welcomeTimer);
        this._welcomeTimer = null;
        const session = message.payload?.session ?? {};
        this.sessionId = session.id ?? null;
        this.keepaliveTimeoutSeconds = session.keepalive_timeout_seconds ?? 10;
        this.status = 'connected';
        this._attempt = 0;
        if (asSwap) {
          this._completeSwap(socket);
        }
        this._armWatchdog();
        this.emit('welcome', {
          sessionId: this.sessionId,
          keepaliveTimeoutSeconds: this.keepaliveTimeoutSeconds,
          reconnectUrl: session.reconnect_url ?? null,
        });
        return;
      }
      case 'session_keepalive': {
        this._armWatchdog();
        this.emit('keepalive', { at: this.now() });
        return;
      }
      case 'session_reconnect': {
        const reconnectUrl = message.payload?.session?.reconnect_url;
        if (!reconnectUrl) {
          this.emit('protocol-error', { error: new Error('session_reconnect without reconnect_url') });
          return;
        }
        this.logger?.info?.('eventsub reconnect requested', {});
        this.emit('reconnect', { url: reconnectUrl });
        this._swapping = true;
        this._pendingReconnectUrl = reconnectUrl;
        this.status = 'reconnecting';
        this._connect(reconnectUrl, { reason: 'server-reconnect', asSwap: true });
        return;
      }
      case 'notification': {
        this._armWatchdog();
        this.emit('notification', {
          type: message.payload?.subscription?.type,
          version: message.payload?.subscription?.version,
          subscription: message.payload?.subscription,
          event: message.payload?.event,
          metadata: message.metadata,
        });
        return;
      }
      case 'revocation': {
        this.emit('revocation', {
          subscription: message.payload?.subscription,
          status: message.payload?.subscription?.status,
        });
        return;
      }
      default: {
        this.emit('protocol-error', { error: new Error(`unknown message_type ${type}`) });
      }
    }
  }

  _completeSwap(newSocket) {
    const old = this._socket;
    this._socket = newSocket;
    this._swapSocket = null;
    this._swapping = false;
    this._pendingReconnectUrl = null;
    if (old && old !== newSocket) {
      try {
        old.close(4001, 'replaced by reconnect URL');
      } catch {
        /* noop */
      }
    }
  }

  _armWatchdog() {
    clearTimeout(this._watchdog);
    const seconds = this.keepaliveTimeoutSeconds ?? 10;
    const delay = seconds * 1000 + this.keepaliveGraceMs;
    this._watchdog = setTimeout(() => {
      this.logger?.warn?.('eventsub keepalive missed', { seconds });
      this.emit('timeout', { phase: 'keepalive' });
      this._teardownSocket();
      this._scheduleReconnect('keepalive-missed');
    }, delay);
  }

  _teardownSocket() {
    clearTimeout(this._watchdog);
    clearTimeout(this._welcomeTimer);
    this._watchdog = null;
    this._welcomeTimer = null;
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      try {
        socket.close(4002, 'client reconnect');
      } catch {
        /* noop */
      }
    }
  }

  _scheduleReconnect(reason, url = this.url) {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.minReconnectDelayMs * 2 ** this._attempt * (0.5 + this.random()),
    );
    this._attempt += 1;
    this.status = 'reconnecting';
    this.logger?.info?.('eventsub reconnecting', { reason, delayMs: Math.round(delay) });
    this._reconnectTimer = setTimeout(() => {
      this._connect(url, { reason: `retry:${reason}` });
    }, Math.round(delay));
  }
}
