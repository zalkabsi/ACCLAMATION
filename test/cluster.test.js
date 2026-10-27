import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterMessages,
  measureConsensus,
  stem,
  tokenize,
  hasNegation,
} from '../src/chat/cluster.js';

const messages = (lines) =>
  lines.map(([login, text], index) => ({
    id: `m${index}`,
    userId: `u-${login}`,
    login,
    display: login,
    text,
    ts: 1000 + index * 10,
    index,
  }));

const consensusLines = [
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

const dissentLines = [
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
  ['doodle', 'easy win no choke'],
];

test('stemming collapses the variations chat actually types', () => {
  assert.equal(stem('choking'), stem('choke'));
  assert.equal(stem('chokes'), stem('choke'));
  assert.deepEqual(tokenize("you're gonna choke at 20"), tokenize('choke at 20'));
  assert.equal(hasNegation('he will not choke'), true);
  assert.equal(hasNegation('he will choke'), false);
});

test('a one-sided room becomes one stance with a high share', () => {
  const { clusters, totalChatters } = clusterMessages(messages(consensusLines));
  assert.ok(clusters.length <= 3, `expected few clusters, got ${clusters.length}`);
  const measurement = measureConsensus(clusters, { minChatters: 4, totalChatters });
  assert.equal(measurement.mode, 'consensus');
  assert.ok(measurement.topShare >= 0.7, `topShare was ${measurement.topShare}`);
  assert.ok(measurement.confidence >= 55 && measurement.confidence <= 96);
  assert.equal(measurement.split, null);
});

test('a split room is detected and reports both shares', () => {
  const { clusters, totalChatters } = clusterMessages(messages(dissentLines));
  const measurement = measureConsensus(clusters, { minChatters: 4, totalChatters });
  assert.equal(measurement.mode, 'dissent');
  assert.ok(measurement.topShare >= 0.3 && measurement.topShare < 0.62);
  assert.ok(measurement.secondShare >= 0.25);
  assert.ok(measurement.split.a >= measurement.split.b);
  assert.ok(measurement.confidence > 20 && measurement.confidence <= 96);
});

test('two chatters are not a crowd', () => {
  const { clusters, totalChatters } = clusterMessages(messages(consensusLines.slice(0, 2)));
  const measurement = measureConsensus(clusters, { minChatters: 4, totalChatters });
  assert.equal(measurement.mode, 'insufficient');
  assert.equal(measurement.reason, 'sample_too_small');
  assert.equal(measurement.confidence, null);
});

test('an emote wall is reported as unclear, not as agreement', () => {
  const lines = [
    ['a', '😂😂😂'],
    ['b', 'LUL'],
    ['c', '🔥🔥'],
    ['d', '💀💀💀'],
    ['e', '😂'],
    ['f', 'choke at 20'],
  ];
  const { clusters, totalChatters, reactions } = clusterMessages(messages(lines));
  assert.equal(reactions, 5);
  const measurement = measureConsensus(clusters, { minChatters: 4, totalChatters });
  assert.equal(measurement.mode, 'unclear');
  assert.equal(measurement.reason, 'emote_wall');
});

test('scattered takes with no side over 40% are unclear, not invented consensus', () => {
  const lines = [
    ['a', 'choke at 20'],
    ['b', 'actually he is fine'],
    ['c', 'raid incoming'],
    ['d', 'what game is this'],
    ['e', 'love the overlay'],
  ];
  const { clusters, totalChatters } = clusterMessages(messages(lines));
  const measurement = measureConsensus(clusters, { minChatters: 4, totalChatters });
  assert.equal(measurement.mode, 'unclear');
  assert.equal(measurement.confidence, null);
});

test('clustering is deterministic and capped', () => {
  const input = messages(dissentLines);
  const a = clusterMessages(input);
  const b = clusterMessages(input);
  assert.deepEqual(
    a.clusters.map((cluster) => [cluster.id, cluster.userCount, cluster.terms]),
    b.clusters.map((cluster) => [cluster.id, cluster.userCount, cluster.terms]),
  );

  const many = messages(
    Array.from({ length: 40 }, (_, i) => [`user${i}`, `unique topic number ${i} with word${i}`]),
  );
  const capped = clusterMessages(many, { maxClusters: 5 });
  assert.ok(capped.clusters.length <= 5);
});

test('representatives are distinct users and carry real message ids', () => {
  const { clusters } = clusterMessages(messages(consensusLines));
  const cluster = clusters.find((c) => c.kind === 'words');
  assert.ok(cluster.representatives.length > 0);
  assert.equal(new Set(cluster.representatives.map((rep) => rep.login)).size, cluster.representatives.length);
  for (const rep of cluster.representatives) {
    assert.ok(rep.id.startsWith('m'));
    assert.ok(consensusLines.some(([, text]) => text === rep.text));
  }
});
