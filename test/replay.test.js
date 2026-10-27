import test from 'node:test';
import assert from 'node:assert/strict';
import { runReplay } from '../replay/replay.js';

const logger = { warn() {}, info() {}, debug() {}, error() {} };

test('the replay harness drives the production path end to end', async () => {
  const result = await runReplay({
    fixture: 'replay/fixtures/consensus.jsonl',
    speed: 100000,
    ask: true,
    logger,
  });
  assert.equal(result.answer.mode, 'consensus');
  assert.equal(result.answer.provider, 'local');
  assert.ok(result.answer.confidence >= 55);
  assert.ok(result.stats.filteredByReason.deleted >= 1);
  assert.equal(
    result.answer.receipts.some((receipt) => receipt.message_id === 'c16'),
    false,
    'the deleted message must never be quoted',
  );
  assert.equal(
    result.answer.receipts.some((receipt) => /hands are shaking/.test(receipt.text)),
    false,
  );
});

test('the messy fixture is refused instead of inventing a consensus', async () => {
  const result = await runReplay({
    fixture: 'replay/fixtures/messy.jsonl',
    speed: 100000,
    ask: true,
    logger,
  });
  assert.equal(result.answer.mode, 'insufficient');
  assert.equal(result.answer.confidence, null);
  assert.ok(result.stats.filtered >= 10);
  assert.ok(result.stats.filteredByReason.bot >= 2);
  assert.ok(result.stats.filteredByReason.command >= 2);
});
