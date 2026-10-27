import test from 'node:test';
import assert from 'node:assert/strict';
import { Scrubber, containsLink, findPii, normalizeText, redact, buildBlockedTermMatcher } from '../src/chat/scrub.js';

const base = { blockedTerms: ['skill issue', 'kys'], blockedUsers: ['trollking'], bots: ['nightbot'] };
const scrubber = new Scrubber(base);

const check = (text, overrides = {}, messageOverrides = {}) =>
  new Scrubber({ ...base, ...overrides }).check({ text, userLogin: 'viewer', ...messageOverrides });

test('links are detected without false positives', () => {
  assert.equal(containsLink('go to https://example.com'), true);
  assert.equal(containsLink('www.shop.example'), true);
  assert.equal(containsLink('discord.gg/abc'), true);
  assert.equal(containsLink('twitch.tv/someone'), true);
  assert.equal(containsLink('gg ez'), false);
  assert.equal(containsLink('5.5k viewers'), false);
  assert.equal(containsLink('he is 6.2 feet tall'), false);
});

test('email and phone are labelled as personal data, not links', () => {
  assert.deepEqual(check('email me at viewer@example.com'), { ok: false, reason: 'pii_email' });
  assert.deepEqual(check('call 555-123-4567'), { ok: false, reason: 'pii_phone' });
  assert.deepEqual(check('my number is +1 (555) 123 4567'), { ok: false, reason: 'pii_phone' });
});

test('blocked terms match whole words and phrases', () => {
  assert.deepEqual(check('that was a skill issue honestly'), {
    ok: false,
    reason: 'blocked_term',
    detail: 'skill issue',
  });
  assert.equal(check('skilled player').ok, true);
  const matcher = buildBlockedTermMatcher(['a.b', 'c']);
  assert.equal(matcher('a.b is bad'), 'a.b');
  assert.equal(matcher('axb is fine'), null);
});

test('commands, bots, blocked users and non-text messages are rejected', () => {
  assert.equal(check('!drop').reason, 'command');
  assert.equal(check('hello').ok, true);
  assert.equal(check('Welcome to the stream!', {}, { userLogin: 'nightbot' }).reason, 'bot');
  assert.equal(check('hi', {}, { userLogin: 'TrollKing' }).reason, 'blocked_user');
  assert.equal(check('hi', {}, { messageType: 'channel_points_highlighted' }).ok, true);
  assert.equal(check('hi', {}, { messageType: 'resub' }).reason, 'non_text');
});

test('empty and wall-of-text messages are rejected', () => {
  assert.equal(check('   ').reason, 'empty');
  assert.equal(check('a').reason, 'empty');
  assert.equal(check('x'.repeat(600)).reason, 'wall');
});

test('links are allowed when the channel opts in, but PII never is', () => {
  const open = new Scrubber({ ...base, allowLinks: true });
  assert.equal(open.check({ text: 'clip at https://clips.twitch.tv/x', userLogin: 'viewer' }).ok, true);
  assert.equal(open.check({ text: 'mail viewer@example.com', userLogin: 'viewer' }).reason, 'pii_email');
});

test('normalizeText and redact keep display output safe', () => {
  assert.equal(normalizeText('  hello \n  world '), 'hello world');
  assert.equal(findPii('555-123-4567'), 'phone');
  const cleaned = redact('site https://x.example mail a@b.co phone 555-123-4567');
  assert.match(cleaned, /\[link\]/);
  assert.match(cleaned, /\[email\]/);
  assert.match(cleaned, /\[number\]/);
});
