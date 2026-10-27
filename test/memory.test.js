import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemory, MemoryStore } from '../src/memory/store.js';

test('sqlite store persists lore, calls and the scoreboard', async () => {
  const store = await openMemory({ file: ':memory:', channel: 'zalkabsi' });
  assert.equal(store.kind, 'sqlite');

  const lore = store.addLore('chat still calls the 20-choke run');
  assert.ok(lore.id > 0);
  assert.equal(store.listLore()[0].text, 'chat still calls the 20-choke run');
  assert.equal(store.deleteLore(lore.id), true);
  assert.equal(store.listLore().length, 0);

  const callId = store.recordCall({
    question: 'Chat, what do you think?',
    mode: 'consensus',
    stance: 'Twenty is the wall.',
    confidence: 87,
    provider: 'local',
    receipts: [{ message_id: 'm1', user: 'mochirose', text: 'choke at 20' }],
  });
  assert.ok(callId > 0);
  const [call] = store.recentCalls(1);
  assert.equal(call.mode, 'consensus');
  assert.equal(call.receipts[0].message_id, 'm1');
  assert.equal(call.confidence, 87);

  assert.deepEqual(store.getScoreboard(), { chat: 0, streamer: 0 });
  store.score('chat');
  store.score('streamer');
  store.score('chat');
  assert.deepEqual(store.getScoreboard(), { chat: 2, streamer: 1 });

  store.close();
});

test('in-memory store exposes the same interface', () => {
  const store = new MemoryStore({ channel: 'test' });
  const lore = store.addLore('hello');
  assert.equal(store.listLore()[0].text, 'hello');
  assert.equal(store.deleteLore(lore.id), true);
  store.recordCall({ question: 'q', mode: 'dissent', stance: 's', confidence: 50, provider: 'local' });
  assert.equal(store.recentCalls()[0].mode, 'dissent');
  store.score('streamer');
  assert.deepEqual(store.getScoreboard(), { chat: 0, streamer: 1 });
});

test('empty lore is rejected', async () => {
  const store = new MemoryStore({ channel: 'test' });
  assert.throws(() => store.addLore('   '), /empty/);
});
