import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/http.js';
import { ChannelSession } from '../src/core/session.js';
import { ChatWindow } from '../src/chat/window.js';
import { Scrubber } from '../src/chat/scrub.js';
import { MemoryStore } from '../src/memory/store.js';
import { loadConfig } from '../src/config.js';

const logger = { warn() {}, info() {}, error() {}, debug() {} };

async function setup(t) {
  const config = loadConfig({ env: {}, cwd: '/tmp/acclamation-server-test' });
  config.server.port = 0;
  const memory = new MemoryStore({ channel: 'test' });
  const session = new ChannelSession({
    config,
    memory,
    window: new ChatWindow({ seconds: 120, scrubber: new Scrubber({}) }),
    logger,
  });
  const lines = [
    ['mochirose', "you're gonna choke at 20"],
    ['kayluv', 'choking at 20 for sure'],
    ['pixelpete', 'he always chokes at 20'],
    ['sadgirl', 'choke at 20 incoming'],
    ['wanderer', '20 will cook him'],
  ];
  lines.forEach(([login, text], index) => {
    session.ingest('channel.chat.message', {
      message_id: `m${index}`,
      chatter_user_id: `id-${login}`,
      chatter_user_login: login,
      chatter_user_name: login,
      message: { text },
      message_type: 'text',
    });
  });

  const app = createApp({ config, session, memory, logger, connection: () => ({ status: 'replay' }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, session, memory, app };
}

test('health and state endpoints expose the room without secrets', async (t) => {
  const { base } = await setup(t);
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.provider, 'local');

  const state = await fetch(`${base}/api/state`).then((response) => response.json());
  assert.equal(state.session.stats.chatters, 5);
  assert.equal(state.connection.status, 'replay');
  assert.equal(state.config.provider, 'local');
  assert.equal(JSON.stringify(state).includes('"apiKey"'), false);
});

test('trigger produces a measured answer and records it in state', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Chat, what do you think?' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.answer.mode, 'consensus');
  assert.ok(body.answer.receipts.length > 0);

  const state = await fetch(`${base}/api/state`).then((result) => result.json());
  assert.equal(state.session.lastAnswer.id, body.answer.id);
});

test('scores, lore and static pages are served', async (t) => {
  const { base } = await setup(t);
  const score = await fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ winner: 'chat' }),
  }).then((response) => response.json());
  assert.deepEqual(score.scoreboard, { chat: 1, streamer: 0 });

  const lore = await fetch(`${base}/api/lore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'chat still calls the 20-choke run' }),
  }).then((response) => response.json());
  assert.equal(lore.lore.text, 'chat still calls the 20-choke run');

  const list = await fetch(`${base}/api/lore`).then((response) => response.json());
  assert.equal(list.lore.length, 1);
  const removed = await fetch(`${base}/api/lore/${lore.lore.id}`, { method: 'DELETE' }).then((response) => response.json());
  assert.equal(removed.ok, true);

  const dashboard = await fetch(`${base}/`);
  assert.match(await dashboard.text(), /ACCLAMATION/);
  const overlay = await fetch(`${base}/overlay`);
  assert.match(await overlay.text(), /overlay\/face\.js/);

  const tts = await fetch(`${base}/api/tts?text=hello`);
  assert.equal(tts.status, 501);
});

test('the SSE stream opens with a hello event', async (t) => {
  const { base } = await setup(t);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /event: hello/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('unknown routes return JSON 404s', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).ok, false);
});
