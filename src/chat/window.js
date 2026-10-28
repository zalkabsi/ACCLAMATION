import { randomUUID } from 'node:crypto';
import { normalizeText } from './scrub.js';

/**
 * A rolling, per-channel chat window.
 *
 * Invariants that the rest of the system relies on:
 *  - a deleted message is removed immediately and can never be re-added;
 *  - a banned/timed-out user's messages are removed and future ones rejected;
 *  - every accepted message has a stable id, which is what receipts cite.
 */
export class ChatWindow {
  constructor({
    seconds = 120,
    maxMessages = 4000,
    perUserCap = 6,
    scrubber,
    now = () => Date.now(),
    dedupeSeconds = 60,
  } = {}) {
    this.seconds = seconds;
    this.maxMessages = maxMessages;
    this.perUserCap = perUserCap;
    this.scrubber = scrubber;
    this.now = now;
    this.dedupeSeconds = dedupeSeconds;

    this._messages = new Map();
    this._order = [];
    this._deleted = new Set();
    this._banned = new Set();
    this._dedupe = new Map();
    this._received = 0;
    this._accepted = 0;
    this._filtered = Object.create(null);
    this._userCounts = new Map();
    this._lastActivityAt = null;
  }

  _filter(reason) {
    this._filtered[reason] = (this._filtered[reason] || 0) + 1;
  }

  _cutoff(at = this.now()) {
    return at - this.seconds * 1000;
  }

  _prune(at = this.now()) {
    const cutoff = this._cutoff(at);
    while (this._order.length) {
      const oldestId = this._order[0];
      const msg = this._messages.get(oldestId);
      if (!msg) {
        this._order.shift();
        continue;
      }
      if (msg.ts >= cutoff) break;
      this._remove(oldestId);
    }
    // drop stale dedupe keys so the map cannot grow unbounded
    for (const [key, ts] of this._dedupe) {
      if (ts < at - this.dedupeSeconds * 1000) this._dedupe.delete(key);
    }
  }

  _remove(id) {
    const msg = this._messages.get(id);
    if (!msg) return null;
    this._messages.delete(id);
    const index = this._order.indexOf(id);
    if (index !== -1) this._order.splice(index, 1);
    const count = this._userCounts.get(msg.userId) || 0;
    if (count <= 1) this._userCounts.delete(msg.userId);
    else this._userCounts.set(msg.userId, count - 1);
    this._dedupe.delete(`${msg.userId}|${msg.text.toLowerCase()}`);
    return msg;
  }

  /**
   * @param {{id?: string, userId: string, login: string, display?: string,
   *          text: string, ts?: number, messageType?: string,
   *          badges?: Array<{set_id: string, id: string}>|string[], color?: string,
   *          isReply?: boolean}} raw
   */
  add(raw) {
    const at = this.now();
    this._prune(at);
    this._received += 1;

    const text = normalizeText(raw.text);
    const login = String(raw.login || '').toLowerCase();
    const userId = String(raw.userId || login);
    const ts = Number.isFinite(raw.ts) ? Math.min(Math.max(raw.ts, this._cutoff(at)), at) : at;

    if (this._banned.has(userId) || this._banned.has(login)) {
      this._filter('banned_user');
      return { added: false, reason: 'banned_user' };
    }

    const verdict = this.scrubber.check({
      text,
      userLogin: login,
      messageType: raw.messageType || 'text',
    });
    if (!verdict.ok) {
      this._filter(verdict.reason);
      return { added: false, reason: verdict.reason, detail: verdict.detail };
    }

    const dedupeKey = `${userId}|${text.toLowerCase()}`;
    const previous = this._dedupe.get(dedupeKey);
    if (previous !== undefined && previous >= at - this.dedupeSeconds * 1000) {
      this._filter('duplicate');
      return { added: false, reason: 'duplicate' };
    }

    const perUser = this._userCounts.get(userId) || 0;
    if (perUser >= this.perUserCap) {
      this._filter('flood');
      return { added: false, reason: 'flood' };
    }

    const id = String(raw.id || randomUUID());
    if (this._deleted.has(id) || this._messages.has(id)) {
      this._filter('duplicate_id');
      return { added: false, reason: 'duplicate_id' };
    }

    const message = {
      id,
      userId,
      login,
      display: raw.display || raw.login || login,
      text,
      ts,
      receivedAt: at,
      badges: normalizeBadges(raw.badges),
      color: raw.color || null,
      isReply: Boolean(raw.isReply),
      index: this._order.length,
    };

    this._messages.set(id, message);
    this._order.push(id);
    this._dedupe.set(dedupeKey, at);
    this._userCounts.set(userId, perUser + 1);
    this._accepted += 1;
    this._lastActivityAt = at;

    while (this._order.length > this.maxMessages) {
      this._remove(this._order[0]);
      this._filter('overflow');
    }

    return { added: true, message };
  }

  /** A moderator deleted this message: pull it before anyone can quote it. */
  delete(messageId) {
    const id = String(messageId);
    const removed = this._remove(id);
    this._deleted.add(id);
    if (removed) this._filter('deleted');
    return Boolean(removed);
  }

  /** Timeout/ban: scrub everything this user said in the window. */
  banUser(userIdOrLogin) {
    const needle = String(userIdOrLogin).toLowerCase();
    this._banned.add(needle);
    let removed = 0;
    for (const [id, msg] of [...this._messages]) {
      if (msg.userId.toLowerCase() === needle || msg.login === needle) {
        this._remove(id);
        this._deleted.add(id);
        this._filter('banned_user');
        removed += 1;
      }
    }
    return removed;
  }

  /** A Twitch unban permits new messages; previously scrubbed ids stay deleted. */
  unbanUser(userIdOrLogin) {
    return this._banned.delete(String(userIdOrLogin).toLowerCase());
  }

  clear() {
    this._messages.clear();
    this._order = [];
    this._userCounts.clear();
    this._dedupe.clear();
  }

  get(messageId) {
    return this._messages.get(String(messageId)) || null;
  }

  prune() {
    this._prune(this.now());
  }

  snapshot(at = this.now()) {
    this._prune(at);
    const messages = this._order.map((id) => this._messages.get(id)).filter(Boolean);
    const chatters = new Set(messages.map((m) => m.userId));
    const blocked = this._received - this._accepted;
    const removed = (this._filtered.deleted ?? 0) + (this._filtered.banned_user ?? 0);
    return {
      messages,
      windowStart: at - this.seconds * 1000,
      windowEnd: at,
      stats: {
        received: this._received,
        accepted: this._accepted,
        blocked,
        removed,
        filtered: blocked + removed,
        activeMessages: messages.length,
        chatters: chatters.size,
        filteredByReason: { ...this._filtered },
        lastActivityAt: this._lastActivityAt,
      },
    };
  }

  stats() {
    return this.snapshot().stats;
  }
}

function normalizeBadges(badges) {
  if (!badges || !badges.length) return new Set();
  if (badges[0] && typeof badges[0] === 'object') {
    return new Set(badges.map((badge) => badge.set_id).filter(Boolean));
  }
  return new Set(badges.map(String));
}
