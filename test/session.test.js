import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelSession, BusyError } from '../src/core/session.js';
import { ChatWindow } from '../src/chat/window.js';
import { Scrubber } from '../src/chat/scrub.js';
import { MemoryStore } from '../src/memory/store.js';

const logger = { warn() {}, info() {}, error() {}, debug() {} };

const config = (overrides = {}) => ({
  provider: 'local',
  defaultQuestion: 'Chat, what do you think?',
  channel: { minChatters: 4, windowSeconds: 120, maxMessages: 500, perUserCap: 6 },
  llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test-model', temperature: 0, timeoutMs: 1000 },
  ...overrides,
});

const chat = (login, text, id = `${login}-${text.length}`) => ({
  message_id: id,
  chatter_user_id: `id-${login}`,
  chatter_user_login: login,
  chatter_user_name: login,
  message: { text },
  message_type: 'text',
  badges: [],
});

const consensusChatters = [
  ['mochirose', "you're gonna choke at 20"],
  ['kayluv', 'choking at 20 for sure'],
  ['pixelpete', 'he always chokes at 20'],
  ['sadgirl', 'choke at 20 incoming'],
  ['wanderer', '20 will cook him'],
  ['ggmike', '20 is where he chokes'],
  ['lurker', 'already choking at 20'],
  ['anon', 'choke at 20 lol'],
  ['beans', 'ez choke at 20'],
  ['toast', '20 is his wall'],
];

function makeSession({ provider = 'local', completeFn, lines = consensusChatters, configOverrides = {}, memory } = {}) {
  const window = new ChatWindow({
    seconds: 120,
    perUserCap: 6,
    scrubber: new Scrubber({ blockedTerms: ['kys'], bots: ['nightbot'] }),
  });
  const store = memory ?? new MemoryStore({ channel: 'test' });
  const session = new ChannelSession({
    config: config({ provider, ...configOverrides }),
    memory: store,
    window,
    logger,
    completeFn,
  });
  lines.forEach(([login, text, id], index) => {
    session.ingest('channel.chat.message', chat(login, text, id || `m${index}`));
  });
  return { session, window, memory: store };
}

test('the local voice answers from the measured window and records the call', async () => {
  const { session, memory } = makeSession();
  const answer = await session.ask();
  assert.equal(answer.mode, 'consensus');
  assert.equal(answer.provider, 'local');
  assert.ok(answer.confidence >= 55 && answer.confidence <= 96, `confidence ${answer.confidence}`);
  assert.ok(answer.receipts.length >= 1);
  assert.ok(answer.receipts.every((receipt) => receipt.message_id.startsWith('m')));
  assert.equal(answer.chatters, 10);
  assert.equal(memory.recentCalls(1)[0].mode, 'consensus');
});

test('a valid model answer is used and its receipts are resolved from the window', async () => {
  let calls = 0;
  const completeFn = async ({ messages }) => {
    calls += 1;
    const payload = JSON.parse(messages[1].content);
    const id = payload.stances[0].samples[0].message_id;
    return {
      text: JSON.stringify({
        version: 1,
        mode: 'consensus',
        stance: 'Chat has decided twenty is the wall.',
        receipts: [id],
      }),
      latencyMs: 12,
      model: 'test-model',
    };
  };
  const { session } = makeSession({ provider: 'openai', completeFn });
  const answer = await session.ask();
  assert.equal(calls, 1);
  assert.equal(answer.provider, 'openai');
  assert.equal(answer.model, 'test-model');
  assert.equal(answer.timings.modelMs, 12);
  assert.equal(answer.receipts.length, 1);
  const [, text] = consensusChatters.find(([, line]) => line === answer.receipts[0].text) ?? [];
  assert.ok(text, 'receipt text must come from a real chat message');
});

test('an invented receipt is repaired once, then rejected in favour of the local voice', async () => {
  let calls = 0;
  const completeFn = async () => {
    calls += 1;
    return {
      text: JSON.stringify({
        version: 1,
        mode: 'consensus',
        stance: 'Trust me, chat said this.',
        receipts: ['m-not-real'],
      }),
      latencyMs: 5,
    };
  };
  const { session } = makeSession({ provider: 'openai', completeFn });
  const errors = [];
  session.on('provider:error', (event) => errors.push(event));
  const answer = await session.ask();
  assert.equal(calls, 2, 'one repair attempt');
  assert.equal(answer.provider, 'local');
  assert.equal(answer.stance.includes('Trust me'), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /m-not-real/);
});

test('a provider failure falls back to the local voice instead of failing the trigger', async () => {
  const completeFn = async () => {
    throw new Error('upstream timeout');
  };
  const { session } = makeSession({ provider: 'openai', completeFn });
  const answer = await session.ask();
  assert.equal(answer.provider, 'local');
  assert.equal(answer.mode, 'consensus');
});

test('too little chat is refused before the model is ever called', async () => {
  let calls = 0;
  const completeFn = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  const { session } = makeSession({
    provider: 'openai',
    completeFn,
    lines: consensusChatters.slice(0, 3),
  });
  const answer = await session.ask();
  assert.equal(calls, 0);
  assert.equal(answer.mode, 'insufficient');
  assert.equal(answer.confidence, null);
  assert.match(answer.stance, /not a crowd yet/);
});

test('a deleted message can never appear in an answer', async () => {
  const { session } = makeSession({
    lines: [...consensusChatters, ['shyone', 'his hands are shaking at 20', 'm-deleted']],
  });
  session.ingest('channel.chat.message_delete', { message_id: 'm-deleted', target_user_login: 'shyone' });
  const answer = await session.ask();
  assert.ok(answer.receipts.every((receipt) => receipt.message_id !== 'm-deleted'));
  assert.ok(answer.basis.filtered.deleted >= 1);
});

test('split chat produces two voices, and forcing dissent on one stance does not invent a split', async () => {
  const split = [
    ['mochirose', 'he is washed, easy choke'],
    ['kayluv', 'washed, he will choke'],
    ['pixelpete', 'total choke incoming'],
    ['sadgirl', 'washed player, choke'],
    ['wanderer', 'he chokes every time'],
    ['ggmike', 'nah he is cracked, easy win'],
    ['lurker', 'cracked, he will win easy'],
    ['anon', 'easy win for him'],
    ['beans', 'he is so cracked, win'],
    ['toast', 'win easy, cracked'],
  ];
  const splitSession = makeSession({ lines: split }).session;
  const splitAnswer = await splitSession.ask();
  assert.equal(splitAnswer.mode, 'dissent');
  assert.equal(splitAnswer.voices.length, 2);
  assert.ok(splitAnswer.split.a > 0 && splitAnswer.split.b > 0);
  const splitReceipts = splitAnswer.voices.flatMap((voice) => voice.receipts.map((receipt) => receipt.message_id));
  assert.ok(new Set(splitReceipts).size > 1);

  const { session } = makeSession();
  const forced = await session.ask({ forceMode: 'dissent' });
  assert.equal(forced.mode, 'consensus', 'a one-stance room has nothing to split');
});

test('only one answer runs at a time', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const completeFn = async () => {
    await gate;
    return {
      text: JSON.stringify({ version: 1, mode: 'consensus', stance: 'Held for the test.', receipts: ['m0'] }),
      latencyMs: 1,
    };
  };
  const { session } = makeSession({ provider: 'openai', completeFn });
  const first = session.ask();
  await assert.rejects(() => session.ask(), BusyError);
  release();
  await first;
});

test('hype events and scoreboard updates are emitted', async () => {
  const { session } = makeSession();
  const hype = [];
  session.on('hype', (event) => hype.push(event));
  session.ingest('channel.raid', { from_broadcaster_user_name: 'toast', viewers: 42 });
  session.ingest('channel.subscribe', { user_name: 'sadgirl', tier: '1000', is_gift: false });
  assert.equal(hype.length, 2);
  assert.equal(hype[0].kind, 'raid');
  assert.equal(hype[0].viewers, 42);

  const scores = [];
  session.on('score', (event) => scores.push(event));
  assert.deepEqual(session.markScore('chat'), { chat: 1, streamer: 0 });
  assert.deepEqual(session.markScore('streamer'), { chat: 1, streamer: 1 });
  assert.equal(scores.length, 2);
  assert.deepEqual(session.state().scoreboard, { chat: 1, streamer: 1 });
});
