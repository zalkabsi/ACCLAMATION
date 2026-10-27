import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatWindow } from '../src/chat/window.js';
import { Scrubber } from '../src/chat/scrub.js';

function makeWindow({ now = () => 1_000_000, seconds = 120 } = {}) {
  return new ChatWindow({
    seconds,
    maxMessages: 20,
    perUserCap: 3,
    scrubber: new Scrubber({ blockedTerms: ['kys'], bots: ['nightbot'] }),
    now,
  });
}

const message = (overrides = {}) => ({
  id: 'm1',
  userId: 'u1',
  login: 'mochirose',
  text: 'choke at 20',
  ts: 1_000_000,
  ...overrides,
});

test('accepts a message and reports it in the snapshot', () => {
  const win = makeWindow();
  const result = win.add(message());
  assert.equal(result.added, true);
  const snapshot = win.snapshot();
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.stats.chatters, 1);
  assert.equal(snapshot.messages[0].text, 'choke at 20');
});

test('deleted messages are removed and can never be re-added', () => {
  const win = makeWindow();
  win.add(message());
  assert.equal(win.delete('m1'), true);
  assert.equal(win.get('m1'), null);
  assert.equal(win.add(message()).reason, 'duplicate_id');
  const snapshot = win.snapshot();
  assert.equal(snapshot.stats.filteredByReason.deleted, 1);
  assert.equal(snapshot.stats.removed, 1);
});

test('banning a user scrubs their existing messages and future ones', () => {
  const win = makeWindow();
  win.add(message({ id: 'a' }));
  win.add(message({ id: 'b', text: 'different line' }));
  assert.equal(win.banUser('u1'), 2);
  assert.equal(win.snapshot().messages.length, 0);
  assert.equal(win.add(message({ id: 'c', text: 'after the ban' })).reason, 'banned_user');
});

test('duplicate messages and per-user floods are rejected', () => {
  const win = makeWindow();
  assert.equal(win.add(message()).added, true);
  assert.equal(win.add(message({ id: 'm2' })).reason, 'duplicate');
  assert.equal(win.add(message({ id: 'u1-0', text: 'line 0' })).added, true);
  assert.equal(win.add(message({ id: 'u1-1', text: 'line 1' })).added, true);
  assert.equal(win.add(message({ id: 'flood', text: 'one more' })).reason, 'flood');
});

test('blocked terms and bots are filtered before they reach the window', () => {
  const win = makeWindow();
  assert.equal(win.add(message({ text: 'just kys already' })).reason, 'blocked_term');
  assert.equal(win.add(message({ id: 'bot', login: 'nightbot', userId: 'bot' })).reason, 'bot');
  const stats = win.snapshot().stats;
  assert.equal(stats.accepted, 0);
  assert.equal(stats.blocked, 2);
  assert.equal(stats.filtered, 2);
});

test('messages evict after the window elapses', () => {
  let now = 1_000_000;
  const win = makeWindow({ now: () => now, seconds: 30 });
  win.add(message({ ts: now }));
  now += 31_000;
  assert.equal(win.snapshot().messages.length, 0);
  now += 1;
  win.add(message({ id: 'later', ts: now }));
  assert.equal(win.snapshot().messages.length, 1);
});

test('timestamps are clamped into the window', () => {
  const win = makeWindow();
  win.add(message({ ts: 1_000_000 - 500_000 }));
  assert.equal(win.snapshot().messages[0].ts, 1_000_000 - 120_000);
});

test('the oldest message is dropped when the window cap is hit', () => {
  const win = makeWindow();
  for (let i = 0; i < 25; i += 1) {
    win.add(message({ id: `cap-${i}`, userId: `user-${i}`, login: `user${i}`, text: `message number ${i}` }));
  }
  const snapshot = win.snapshot();
  assert.equal(snapshot.messages.length, 20);
  assert.equal(snapshot.messages[0].id, 'cap-5');
  assert.equal(snapshot.stats.filteredByReason.overflow, 5);
});
