import test from 'node:test';
import assert from 'node:assert/strict';
import { HelixClient, TwitchApiError, chatSubscriptions, subscribeAll } from '../src/eventsub/helix.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const { status = 200, body = {} } = handler(String(url), options) ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const client = (handler) => {
  const { fetchImpl, calls } = fakeFetch(handler);
  return { helix: new HelixClient({ clientId: 'client-id', token: 'token', fetchImpl }), calls };
};

test('chat subscriptions carry the conditions Twitch actually requires', () => {
  const subscriptions = chatSubscriptions({ broadcasterUserId: '111', userId: '111' });
  const byType = Object.fromEntries(subscriptions.map((subscription) => [subscription.type, subscription]));
  assert.deepEqual(byType['channel.chat.message'].condition, {
    broadcaster_user_id: '111',
    user_id: '111',
  });
  assert.deepEqual(byType['channel.chat.message_delete'].condition, {
    broadcaster_user_id: '111',
    user_id: '111',
  });
  assert.deepEqual(byType['channel.raid'].condition, { to_broadcaster_user_id: '111' });
  assert.deepEqual(byType['channel.subscribe'].condition, { broadcaster_user_id: '111' });
  assert.equal(byType['channel.raid'].scope, null);
});

test('subscription requests are bound to the websocket session id', async () => {
  const { helix, calls } = client(() => ({ body: { data: [{ id: 'sub-1' }] } }));
  const result = await helix.createSubscription({
    type: 'channel.chat.message',
    condition: { broadcaster_user_id: '111', user_id: '111' },
    sessionId: 'session-abc',
  });
  assert.equal(result.alreadyExists, false);
  assert.equal(result.data.id, 'sub-1');
  const [call] = calls;
  assert.match(call.url, /\/helix\/eventsub\/subscriptions$/);
  assert.equal(call.options.method, 'POST');
  const request = JSON.parse(call.options.body);
  assert.deepEqual(request.transport, { method: 'websocket', session_id: 'session-abc' });
  assert.equal(request.version, '1');
  assert.equal(call.options.headers['client-id'], 'client-id');
  assert.equal(call.options.headers.authorization, 'Bearer token');
});

test('an existing subscription is reported instead of treated as an error', async () => {
  const { helix } = client(() => ({ status: 409, body: { message: 'subscription already exists' } }));
  const result = await helix.createSubscription({
    type: 'channel.chat.message',
    condition: { broadcaster_user_id: '111', user_id: '111' },
    sessionId: 'session-abc',
  });
  assert.deepEqual(result, { alreadyExists: true, data: null });
});

test('Twitch API errors surface the message and status', async () => {
  const { helix } = client(() => ({ status: 403, body: { message: 'Missing scope: user:read:chat' } }));
  await assert.rejects(
    () =>
      helix.createSubscription({
        type: 'channel.chat.message',
        condition: {},
        sessionId: 'session-abc',
      }),
    (error) => {
      assert.ok(error instanceof TwitchApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Missing scope/);
      return true;
    },
  );
});

test('user lookup returns the channel and rejects an unknown login', async () => {
  const found = client(() => ({ body: { data: [{ id: '111', login: 'zalkabsi', display_name: 'zalkabsi' }] } }));
  const user = await found.helix.getUser('zalkabsi');
  assert.equal(user.id, '111');
  assert.match(found.calls[0].url, /\/users\?login=zalkabsi$/);

  const missing = client(() => ({ body: { data: [] } }));
  await assert.rejects(() => missing.helix.getUser('nobody'), /no Twitch user found/);
});

test('token validation uses the OAuth header and reports an expired token', async () => {
  const ok = client(() => ({ body: { user_id: '111', login: 'zalkabsi', scopes: ['user:read:chat'] } }));
  const validation = await ok.helix.validate();
  assert.equal(validation.login, 'zalkabsi');
  assert.equal(ok.calls[0].options.headers.authorization, 'OAuth token');

  const expired = client(() => ({ status: 401, body: { message: 'invalid access token' } }));
  await assert.rejects(() => expired.helix.validate(), /invalid or expired/);
});

test('subscribeAll skips the optional types when scopes are missing', async () => {
  const created = [];
  const helix = {
    async createSubscription(request) {
      created.push(request.type);
      return { alreadyExists: false, data: { id: `id-${request.type}` } };
    },
  };
  const results = await subscribeAll({
    helix,
    sessionId: 'session-abc',
    broadcasterUserId: '111',
    userId: '111',
    scopes: ['user:read:chat'],
    logger,
  });
  assert.deepEqual(created, ['channel.chat.message', 'channel.chat.message_delete', 'channel.raid']);
  assert.equal(results.find((result) => result.type === 'channel.subscribe').status, 'skipped');
  assert.ok(results.filter((result) => result.status === 'created').length === 3);
});

test('subscribeAll reports failures without aborting the rest', async () => {
  const helix = {
    async createSubscription(request) {
      if (request.type === 'channel.chat.message') throw new Error('invalid condition');
      return { alreadyExists: false, data: { id: 'sub' } };
    },
  };
  const results = await subscribeAll({
    helix,
    sessionId: 'session-abc',
    broadcasterUserId: '111',
    userId: '111',
    scopes: ['user:read:chat', 'channel:read:subscriptions'],
    logger,
  });
  assert.equal(results.find((result) => result.type === 'channel.chat.message').status, 'failed');
  assert.equal(results.find((result) => result.type === 'channel.raid').status, 'created');
});
