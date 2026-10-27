/**
 * Message hygiene. Everything that must never leave the machine as a quote is
 * decided here, before a message ever reaches the window, the model or the
 * overlay.
 *
 * Reasons are deliberately explicit so the dashboard can show a real trust
 * panel ("14 held back: 6 links, 4 bots, 2 deleted…") instead of a black box.
 */

const LINK_PATTERNS = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|gg|tv|io|dev|co|me|ly|link|xyz|app|site|shop|stream|to|ru|cn)\b/i,
  /\bdiscord(?:app)?\.(?:gg|com)\b/i,
  /\bt\.me\b/i,
];

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/;
const LONG_DIGITS = /\b\d{9,}\b/;

export const IS_EMOTE_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsLink(text) {
  return LINK_PATTERNS.some((pattern) => pattern.test(text));
}

/** Returns the kind of personal data found, or null. */
export function findPii(text) {
  if (EMAIL.test(text)) return 'email';
  if (PHONE.test(text)) return 'phone';
  if (LONG_DIGITS.test(text) && !/\b(?:19|20)\d{2}\b/.test(text)) return 'digits';
  return null;
}

export function redact(text) {
  return normalizeText(text)
    .replace(new RegExp(EMAIL.source, 'gi'), '[email]')
    .replace(new RegExp(PHONE.source, 'g'), '[number]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]');
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Blocked terms are matched as whole words/phrases, case-insensitively.
 * Multi-word phrases are supported ("skill issue"). Empty and whitespace-only
 * entries are ignored so a trailing comma cannot block everything.
 */
export function buildBlockedTermMatcher(terms) {
  const cleaned = terms
    .map((t) => normalizeText(t))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!cleaned.length) return () => null;
  const pattern = new RegExp(`\\b(?:${cleaned.map(escapeRegExp).join('|')})\\b`, 'i');
  return (text) => {
    const match = pattern.exec(text);
    return match ? match[0].toLowerCase() : null;
  };
}

export class Scrubber {
  constructor({
    blockedTerms = [],
    blockedUsers = [],
    bots = [],
    allowLinks = false,
    minLength = 2,
    maxLength = 480,
  } = {}) {
    this.blockedUserSet = new Set(blockedUsers.map((u) => String(u).toLowerCase()));
    this.botSet = new Set(bots.map((u) => String(u).toLowerCase()));
    this.matchBlockedTerm = buildBlockedTermMatcher(blockedTerms);
    this.allowLinks = allowLinks;
    this.minLength = minLength;
    this.maxLength = maxLength;
  }

  /** @returns {{ok: true} | {ok: false, reason: string, detail?: string}} */
  check({ text, userLogin, messageType = 'text' }) {
    const body = normalizeText(text);
    if (messageType && messageType !== 'text' && messageType !== 'channel_points_highlighted') {
      // sub/resub/raid notices come through chat as non-text message types
      return { ok: false, reason: 'non_text' };
    }
    if (body.length < this.minLength) return { ok: false, reason: 'empty' };
    if (body.length > this.maxLength) return { ok: false, reason: 'wall' };
    if (body.startsWith('!')) return { ok: false, reason: 'command' };

    const login = String(userLogin || '').toLowerCase();
    if (this.botSet.has(login)) return { ok: false, reason: 'bot', detail: login };
    if (this.blockedUserSet.has(login)) return { ok: false, reason: 'blocked_user', detail: login };

    const term = this.matchBlockedTerm(body);
    if (term) return { ok: false, reason: 'blocked_term', detail: term };

    const pii = findPii(body);
    if (pii) return { ok: false, reason: `pii_${pii}` };
    if (!this.allowLinks && containsLink(body)) return { ok: false, reason: 'link' };

    return { ok: true };
  }
}
