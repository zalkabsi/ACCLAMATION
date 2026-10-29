import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/server/main.js';

const logger = { warn() {}, info() {}, debug() {}, error() {} };

function config(live = false) {
  const env = live
    ? { TWITCH_CLIENT_ID: 'client', TWITCH_USER_TOKEN: 'token', TWITCH_CHANNEL: 'sample' }
    : {};
  const result = loadConfig({ env, cwd: '/tmp/acclamation-live-server-test' });
  result.server.port = 0;
  result.memoryPath = ':memory:';
  return result;
}

async function until(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('live status ignores old socket closes and follows the current session', async (t) => {
  class Client extends EventEmitter {
    start() {}
    stop() { this.emit('close', { wasCurrent: true }); }
  }
  const client = new Client();
  const created = [];
  const helix = {
    async validate() { return { user_id: 'viewer', scopes: ['user:read:chat'] }; },
    async createSubscription(request) {
      created.push(request);
      return { alreadyExists: false, data: { id: `${request.sessionId}:${request.type}` } };
    },
  };
  const app = await startApp({ config: config(true), logger, eventSubFactory: () => client, helixFactory: () => helix });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const status = async () => (await fetch(`${base}/api/health`).then((response) => response.json())).connection.status;

  assert.equal(await status(), 'connecting');
  client.emit('welcome', { sessionId: 'first', keepaliveTimeoutSeconds: 10 });
  await until(() => created.length === 3);
  assert.equal(await status(), 'connected');

  client.emit('reconnect', {});
  assert.equal(await status(), 'reconnecting');
  client.emit('welcome', { sessionId: 'first', keepaliveTimeoutSeconds: 10 });
  client.emit('close', { wasCurrent: false, wasSwap: false });
  assert.equal(await status(), 'connected');
  assert.equal(created.length, 3);

  client.emit('timeout', { phase: 'keepalive' });
  assert.equal(await status(), 'reconnecting');
  client.emit('welcome', { sessionId: 'second', keepaliveTimeoutSeconds: 10 });
  await until(() => created.length === 6);
  client.emit('close', { wasCurrent: false, wasSwap: false });
  assert.equal(await status(), 'connected');
  client.emit('close', { wasCurrent: true, wasSwap: false });
  assert.equal(await status(), 'reconnecting');
});

test('app shutdown closes an open overlay event stream', async (t) => {
  const app = await startApp({ config: config(), logger });
  t.after(() => app.server.closeAllConnections());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/events`);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: hello/);

  const drained = (async () => {
    while (!(await reader.read()).done) { /* consume any buffered SSE data */ }
  })();
  let timer;
  try {
    await Promise.race([
      Promise.all([app.close(), drained]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown timed out')), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});
