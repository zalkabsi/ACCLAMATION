import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEventSubServer } from '../replay/fake-eventsub.js';
import { EventSubClient } from '../src/eventsub/client.js';

const logger = { warn() {}, info() {}, debug() {}, error() {} };

function once(emitter, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    emitter.once(event, onEvent);
  });
}

async function setup(t, { keepaliveTimeoutSeconds = 10, grace = 200 } = {}) {
  const server = new FakeEventSubServer({ keepaliveTimeoutSeconds }).listen();
  const fake = await server;
  const client = new EventSubClient({
    url: fake.url,
    keepaliveGraceMs: grace,
    minReconnectDelayMs: 60,
    maxReconnectDelayMs: 200,
    logger,
  });
  t.after(async () => {
    client.stop();
    await fake.close();
  });
  return { server: fake, client };
}

const chatEvent = (text, messageId = 'm1') => ({
  message_id: messageId,
  chatter_user_login: 'mochirose',
  chatter_user_name: 'mochirose',
  message: { text },
  message_type: 'text',
});

test('welcome carries the session id and notifications are delivered', async (t) => {
  const { server, client } = await setup(t);
  client.start();
  const welcome = await once(client, 'welcome');
  assert.ok(welcome.sessionId);
  assert.equal(welcome.keepaliveTimeoutSeconds, 10);
  assert.equal(client.status, 'connected');

  server.sendEvent(welcome.sessionId, 'channel.chat.message', chatEvent('choke at 20'));
  const notification = await once(client, 'notification');
  assert.equal(notification.type, 'channel.chat.message');
  assert.equal(notification.event.message.text, 'choke at 20');
  assert.equal(notification.metadata.message_type, 'notification');
});

test('keepalive messages reset the health timer', async (t) => {
  const { client } = await setup(t, { keepaliveTimeoutSeconds: 0.25 });
  client.start();
  await once(client, 'welcome');
  const keepalive = await once(client, 'keepalive', 3000);
  assert.ok(keepalive.at > 0);
});

test('duplicate deliveries are ignored', async (t) => {
  const { server, client } = await setup(t);
  const notifications = [];
  client.on('notification', (notification) => notifications.push(notification));
  client.start();
  const { sessionId } = await once(client, 'welcome');
  server.sendEvent(sessionId, 'channel.chat.message', chatEvent('first'), { messageId: 'same-id' });
  server.sendEvent(sessionId, 'channel.chat.message', chatEvent('second'), { messageId: 'same-id' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event.message.text, 'first');
});

test('a server-initiated reconnect keeps the same session and resumes events', async (t) => {
  const { server, client } = await setup(t);
  client.start();
  const first = await once(client, 'welcome');

  await server.forceReconnect(first.sessionId);
  const reconnect = await once(client, 'reconnect');
  assert.match(reconnect.url, /reconnect=/);

  const second = await once(client, 'welcome');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(client.status, 'connected');

  server.sendEvent(first.sessionId, 'channel.chat.message', chatEvent('after swap', 'm2'));
  const notification = await once(client, 'notification');
  assert.equal(notification.event.message.text, 'after swap');
});

test('a dead socket is detected by the keepalive watchdog and replaced', async (t) => {
  const { server, client } = await setup(t, { keepaliveTimeoutSeconds: 0.25, grace: 120 });
  client.start();
  const { sessionId } = await once(client, 'welcome');
  server.hang(sessionId);

  const timeout = await once(client, 'timeout', 3000);
  assert.equal(timeout.phase, 'keepalive');

  const welcome = await once(client, 'welcome', 3000);
  assert.ok(welcome.sessionId);
  assert.equal(client.status, 'connected');
});

test('stop() prevents any further reconnect attempts', async (t) => {
  const { client, server } = await setup(t);
  client.start();
  await once(client, 'welcome');
  client.stop();
  assert.equal(client.status, 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(server.sessions.size, 0);
});
