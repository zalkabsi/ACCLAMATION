import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, parseModelJson, validateAnswer } from '../src/llm/contract.js';

const messages = [
  { id: 'msg-a', display: 'mochirose', text: "you're gonna choke at 20", clusterId: 'c1' },
  { id: 'msg-b', display: 'kayluv', text: 'choke at 20 for sure', clusterId: 'c1' },
  { id: 'msg-c', display: 'ggmike', text: 'nah he is cracked', clusterId: 'c2' },
];
const allowed = new Map(messages.map((message) => [message.id, message]));

const validConsensus = {
  version: 1,
  mode: 'consensus',
  stance: 'Chat is convinced the run dies at 20.',
  receipts: ['msg-a', 'msg-b'],
};

test('a grounded consensus answer passes and its quotes come from the window', () => {
  const result = validateAnswer(validConsensus, { mode: 'consensus', allowed });
  assert.equal(result.ok, true);
  assert.equal(result.value.receipts.length, 2);
  assert.equal(result.value.receipts[0].user, 'mochirose');
  assert.equal(result.value.receipts[0].text, "you're gonna choke at 20");
  assert.equal(result.value.receipts[0].message_id, 'msg-a');
});

test('invented receipts are rejected', () => {
  const result = validateAnswer(
    { ...validConsensus, receipts: ['msg-a', 'msg-invented'] },
    { mode: 'consensus', allowed },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /msg-invented/);
});

test('an answer with no valid receipt is rejected', () => {
  const result = validateAnswer({ ...validConsensus, receipts: [] }, { mode: 'consensus', allowed });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /at least one message id/);
});

test('URLs in the spoken text are rejected', () => {
  const result = validateAnswer(
    { ...validConsensus, stance: 'go watch https://example.com' },
    { mode: 'consensus', allowed },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /URL/);
});

test('the answer may not change the measured mode', () => {
  const result = validateAnswer(validConsensus, { mode: 'dissent', allowed });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /mode must be "dissent"/);
});

test('unknown fields and wrong versions are rejected', () => {
  const result = validateAnswer({ ...validConsensus, confidence: 99 }, { mode: 'consensus', allowed });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unknown field "confidence"/);

  const versioned = validateAnswer({ ...validConsensus, version: 2 }, { mode: 'consensus', allowed });
  assert.equal(versioned.ok, false);
  assert.match(versioned.errors.join(' '), /version must be 1/);
});

test('a valid dissent answer keeps the two voices apart', () => {
  const result = validateAnswer(
    {
      version: 1,
      mode: 'dissent',
      voices: [
        { label: 'believers', stance: 'Cracked. This is free.', receipts: ['msg-c'] },
        { label: 'doubters', stance: 'Washed. Twenty kills him.', receipts: ['msg-a', 'msg-b'] },
      ],
    },
    { mode: 'dissent', allowed },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.voices.length, 2);
  assert.equal(result.value.voices[0].label, 'believers');
});

test('dissent requires exactly two voices with distinct receipts', () => {
  const oneVoice = validateAnswer(
    {
      version: 1,
      mode: 'dissent',
      voices: [{ label: 'only', stance: 'One side only.', receipts: ['msg-a'] }],
    },
    { mode: 'dissent', allowed },
  );
  assert.equal(oneVoice.ok, false);
  assert.match(oneVoice.errors.join(' '), /exactly two voices/);

  const sameReceipts = validateAnswer(
    {
      version: 1,
      mode: 'dissent',
      voices: [
        { label: 'a', stance: 'first take on it', receipts: ['msg-a'] },
        { label: 'b', stance: 'second take on it', receipts: ['msg-a'] },
      ],
    },
    { mode: 'dissent', allowed },
  );
  assert.equal(sameReceipts.ok, false);
  assert.match(sameReceipts.errors.join(' '), /same receipts/);
});

test('dissent may not smuggle a top-level stance', () => {
  const result = validateAnswer(
    {
      version: 1,
      mode: 'dissent',
      stance: 'one voice pretending to be both',
      voices: [
        { label: 'a', stance: 'first take on it', receipts: ['msg-a'] },
        { label: 'b', stance: 'second take on it', receipts: ['msg-b'] },
      ],
    },
    { mode: 'dissent', allowed },
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /inside each voice/);
});

test('model output is parsed out of fences and preamble, but prose is rejected', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Here is the answer: {"a":1} thanks'), { a: 1 });
  assert.throws(() => parseModelJson('Chat is split.'), ContractError);
  assert.throws(() => parseModelJson(''), ContractError);
});
