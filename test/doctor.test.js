import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FakeEventSubServer } from '../replay/fake-eventsub.js';
import { EventSubClient } from '../src/eventsub/client.js';
import { waitForLiveChat } from '../scripts/doctor.js';

const logger = { warn() {}, info() {}, debug() {}, error() {} };
const chat = { chatter_user_name: 'sample', message_id: 'sample-1', message: { text: 'hello' } };

function fakeHelix() {
  const created = [];
  const deleted = [];
  return {
    created,
    deleted,
    async createSubscription(request) {
      const id = `${request.sessionId}:${request.type}`;
      created.push({ ...request, id });
      return { alreadyExists: false, data: { id } };
    },
    async deleteSubscription(id) { deleted.push(id); },
  };
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the test condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function run(client, helix, scopes = ['user:read:chat']) {
  return waitForLiveChat({
    client, helix, broadcasterUserId: 'broadcaster', userId: 'viewer', scopes,
    channel: 'sample', logger, waitSeconds: 4, output() {},
  });
}

test('doctor preserves a transferred session and resubscribes after a fresh session', async (t) => {
  const server = await new FakeEventSubServer({ keepaliveTimeoutSeconds: 0.2 }).listen();
  const client = new EventSubClient({
    url: server.url, keepaliveGraceMs: 100, minReconnectDelayMs: 40,
    maxReconnectDelayMs: 100, logger,
  });
  const helix = fakeHelix();
  const welcomes = [];
  client.on('welcome', (welcome) => welcomes.push(welcome.sessionId));
  t.after(async () => { client.stop(); await server.close(); });

  const result = run(client, helix);
  await until(() => welcomes.length === 1 && helix.created.length === 3);
  const first = welcomes[0];

  await server.forceReconnect(first);
  await until(() => welcomes.length === 2);
  assert.equal(welcomes[1], first);
  assert.equal(helix.created.length, 3);

  assert.equal(server.hang(first), true);
  await until(() => welcomes.length === 3 && helix.created.length === 6);
  assert.notEqual(welcomes[2], first);
  server.sendEvent(welcomes[2], 'channel.chat.message', chat);
  assert.equal(await result, 0);
  assert.deepEqual(new Set(helix.deleted), new Set(helix.created.map((item) => item.id)));
});

test('doctor cleans up subscriptions still being created when chat arrives', async () => {
  class Client extends EventEmitter {
    start() { queueMicrotask(() => this.emit('welcome', { sessionId: 'one', keepaliveTimeoutSeconds: 10 })); }
    stop() { this.stopped = true; }
  }
  const client = new Client();
  const helix = fakeHelix();
  const create = helix.createSubscription;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = false;
  helix.createSubscription = async (request) => {
    if (!started) { started = true; await gate; }
    return create(request);
  };

  const result = run(client, helix);
  await until(() => started);
  client.emit('notification', { type: 'channel.chat.message', event: chat });
  assert.equal(client.stopped, true);
  assert.equal(helix.deleted.length, 0);
  release();
  assert.equal(await result, 0);
  assert.equal(helix.created.length, 3);
  assert.deepEqual(new Set(helix.deleted), new Set(helix.created.map((item) => item.id)));
});

test('doctor fails when chat subscription is skipped', async () => {
  class Client extends EventEmitter {
    start() { queueMicrotask(() => this.emit('welcome', { sessionId: 'one', keepaliveTimeoutSeconds: 10 })); }
    stop() {}
  }
  const helix = fakeHelix();
  assert.equal(await run(new Client(), helix, []), 1);
  assert.deepEqual(helix.created.map((item) => item.type), ['channel.raid']);
  assert.deepEqual(helix.deleted, helix.created.map((item) => item.id));
});
