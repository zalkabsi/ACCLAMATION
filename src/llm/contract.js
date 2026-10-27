/**
 * The answer contract.
 *
 * The model must return strict JSON and may only cite message ids that were in
 * its prompt. Validation is deliberately hostile: an invented id, a URL, an
 * unknown field or a stance that does not match the measured mode is rejected,
 * and the session falls back to the local voice rather than shipping it.
 */

export const ANSWER_VERSION = 1;
export const ALLOWED_KEYS = new Set(['version', 'mode', 'stance', 'receipts', 'voices', 'note']);
export const MAX_RECEIPTS = 6;
const URL_PATTERN = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|gg|tv|io|dev|co|me|ly|link|xyz|app|site|shop|stream)(?:\b|\/))/i;

export class ContractError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ContractError';
    this.errors = errors;
  }
}

/** Tolerate fenced code blocks or a stray preamble, but not prose answers. */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new ContractError('model returned an empty response');
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const candidate = withoutFence.startsWith('{')
    ? withoutFence
    : withoutFence.slice(withoutFence.indexOf('{'), withoutFence.lastIndexOf('}') + 1);
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    throw new ContractError('model response did not contain a JSON object');
  }
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new ContractError(`model returned invalid JSON: ${error.message}`);
  }
}

function cleanText(value, { min, max, field, errors, allowEmpty = false }) {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!allowEmpty && text.length < min) {
    errors.push(`${field} is too short (min ${min} chars)`);
    return null;
  }
  if (text.length > max) {
    errors.push(`${field} is too long (max ${max} chars, got ${text.length})`);
    return null;
  }
  if (URL_PATTERN.test(text)) {
    errors.push(`${field} contains a URL`);
    return null;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    errors.push(`${field} contains control characters`);
    return null;
  }
  return text;
}

function resolveReceipts(ids, allowed, { field, errors }) {
  const resolved = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id) {
      errors.push(`${field}: receipt ids must be non-empty strings`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const message = allowed.get(id);
    if (!message) {
      errors.push(`${field}: id ${id} is not one of the supplied sample messages`);
      continue;
    }
    resolved.push({
      message_id: message.id,
      user: message.display,
      text: message.text,
      cluster_id: message.clusterId,
    });
  }
  return resolved;
}

/**
 * @param {unknown} raw parsed model output
 * @param {{mode: 'consensus'|'dissent', allowed: Map<string, object>}} context
 */
export function validateAnswer(raw, { mode, allowed }) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['answer must be a JSON object'], warnings, value: null };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (raw.version !== ANSWER_VERSION) errors.push(`version must be ${ANSWER_VERSION}`);
  if (raw.mode !== mode) errors.push(`mode must be "${mode}" (measured mode), got ${JSON.stringify(raw.mode)}`);

  if (mode === 'consensus') {
    if ('voices' in raw) errors.push('consensus answers must not include voices');
    const stance = cleanText(raw.stance, { min: 6, max: 240, field: 'stance', errors });
    if (!Array.isArray(raw.receipts) || raw.receipts.length < 1) {
      errors.push('consensus answers need a receipts array with at least one message id');
    }
    const receipts = Array.isArray(raw.receipts)
      ? resolveReceipts(raw.receipts.slice(0, MAX_RECEIPTS), allowed, { field: 'receipts', errors })
      : [];
    if (receipts.length && new Set(receipts.map((r) => r.user)).size < 2) {
      warnings.push('all receipts come from one chatter');
    }
    const note = raw.note === undefined || raw.note === null
      ? null
      : cleanText(raw.note, { min: 1, max: 140, field: 'note', errors, allowEmpty: true });
    if (errors.length) return { ok: false, errors, warnings, value: null };
    return {
      ok: true,
      errors,
      warnings,
      value: { version: ANSWER_VERSION, mode, stance, receipts, note },
    };
  }

  if (!Array.isArray(raw.voices) || raw.voices.length !== 2) {
    errors.push('dissent answers need exactly two voices');
  }
  if ('receipts' in raw) errors.push('dissent answers carry receipts inside voices, not at the top level');
  if ('stance' in raw) errors.push('dissent answers carry a stance inside each voice, not at the top level');

  const voices = [];
  if (Array.isArray(raw.voices)) {
    raw.voices.slice(0, 2).forEach((voice, index) => {
      if (!voice || typeof voice !== 'object') {
        errors.push(`voices[${index}] must be an object`);
        return;
      }
      for (const key of Object.keys(voice)) {
        if (!['label', 'stance', 'receipts'].includes(key)) errors.push(`voices[${index}] has unknown field "${key}"`);
      }
      const label = cleanText(voice.label, { min: 2, max: 28, field: `voices[${index}].label`, errors });
      const stance = cleanText(voice.stance, { min: 6, max: 200, field: `voices[${index}].stance`, errors });
      if (!Array.isArray(voice.receipts) || voice.receipts.length < 1) {
        errors.push(`voices[${index}] needs at least one receipt id`);
      }
      const receipts = Array.isArray(voice.receipts)
        ? resolveReceipts(voice.receipts.slice(0, MAX_RECEIPTS), allowed, {
            field: `voices[${index}].receipts`,
            errors,
          })
        : [];
      voices.push({ label, stance, receipts });
    });
  }
  if (voices.length === 2 && voices[0].label && voices[0].label === voices[1].label) {
    errors.push('the two voices must have distinct labels');
  }
  if (voices.length === 2) {
    const idsA = new Set(voices[0].receipts.map((r) => r.message_id));
    const idsB = new Set(voices[1].receipts.map((r) => r.message_id));
    if ([...idsA].every((id) => idsB.has(id)) && idsA.size) {
      errors.push('both voices cite the same receipts — the split is not grounded');
    }
  }
  const note = raw.note === undefined || raw.note === null
    ? null
    : cleanText(raw.note, { min: 1, max: 140, field: 'note', errors, allowEmpty: true });
  if (errors.length) return { ok: false, errors, warnings, value: null };
  return { ok: true, errors, warnings, value: { version: ANSWER_VERSION, mode, voices, note } };
}
