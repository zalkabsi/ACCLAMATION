/**
 * The offline voice.
 *
 * This is not a stub that says "no API key configured": it composes a real
 * answer from the measured clusters and cites only real message ids, so the
 * replay harness, the tests and a laptop with no network all behave like the
 * product. When a model is configured it replaces the wording, not the
 * structure.
 */

const MAX = 200;

function clip(text, max = MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function receiptIds(cluster, limit = 3) {
  return cluster.representatives.slice(0, limit).map((rep) => rep.id);
}

export function composeLocalAnswer({ measurement, clusters }) {
  const words = clusters.filter((c) => c.kind === 'words');

  if (measurement.mode === 'dissent') {
    const [a, b] = words;
    const leadA = a?.representatives[0];
    const leadB = b?.representatives[0];
    return {
      version: 1,
      mode: 'dissent',
      voices: [
        {
          label: 'the loud half',
          stance: clip(
            `${Math.round(a.share * 100)}% of chat is with ${leadA?.display ?? 'them'}: “${leadA?.text ?? '…'}”`,
          ),
          receipts: receiptIds(a, 2),
        },
        {
          label: 'the other half',
          stance: clip(
            `${Math.round(b.share * 100)}% is not having it — ${leadB?.display ?? 'they'}: “${leadB?.text ?? '…'}”`,
          ),
          receipts: receiptIds(b, 2),
        },
      ],
      note: null,
    };
  }

  const top = words[0];
  const lead = top?.representatives[0];
  const share = Math.round((measurement.topShare ?? 0) * 100);
  const head = share >= 99 ? `All ${measurement.totalChatters} chatters` : `${share}% of ${measurement.totalChatters} chatters`;
  return {
    version: 1,
    mode: 'consensus',
    stance: clip(
      `${head} are on the same page. ${lead?.display ?? 'Chat'} said it first: “${lead?.text ?? '…'}”`,
    ),
    receipts: receiptIds(top, 3),
    note: null,
  };
}

/** Answers that are honest refusals rather than measured stances. */
export function composeRefusal({ measurement, clusters, reason }) {
  const words = clusters.filter((c) => c.kind === 'words');
  if (reason === 'sample_too_small') {
    return {
      mode: 'insufficient',
      stance: `Only ${measurement.totalChatters} ${measurement.totalChatters === 1 ? 'person has' : 'people have'} said anything. That is not a crowd yet — ask again in a minute.`,
      receipts: [],
    };
  }
  if (reason === 'emote_wall') {
    return {
      mode: 'unclear',
      stance: `Chat is ${Math.round(measurement.reactionShare * 100)}% emotes. There are feelings in here, but no words to quote.`,
      receipts: [],
    };
  }
  if (reason === 'no_words') {
    return {
      mode: 'insufficient',
      stance: 'Chat has not said enough yet. Nothing to aggregate.',
      receipts: [],
    };
  }
  const top = words[0];
  const second = words[1];
  return {
    mode: 'unclear',
    stance: `No consensus. Chat is scattered across ${words.length} takes — “${clip(top?.messages?.[0]?.text ?? '', 60)}” and “${clip(second?.messages?.[0]?.text ?? '', 60)}” are not the same answer.`,
    receipts: [...receiptIds(top, 1), ...receiptIds(second, 1)],
  };
}
