import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Channel memory: lore the streamer pins, every call Chorus made, and the
 * running Streamer-vs-Chat scoreboard. SQLite when available (node:sqlite),
 * otherwise the same API in memory so tests and odd Node builds still run.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lore (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  question TEXT,
  mode TEXT NOT NULL,
  stance TEXT,
  confidence INTEGER,
  provider TEXT,
  receipts TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scoreboard (
  channel TEXT PRIMARY KEY,
  chat_wins INTEGER NOT NULL DEFAULT 0,
  streamer_wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

/**
 * Open the channel store. Prefers SQLite; falls back to memory only if the
 * runtime has no node:sqlite. Always awaited so the import stays lazy.
 */
export async function openMemory({ file = ':memory:', channel = 'default', logger = null } = {}) {
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    if (logger) logger.warn('node:sqlite unavailable — memory will not persist');
    return new MemoryStore({ channel });
  }
  if (file !== ':memory:') {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* directory already exists */
    }
  }
  return new SqliteStore({ DatabaseSync, file, channel, logger });
}

export class SqliteStore {
  constructor({ DatabaseSync, file, channel, logger }) {
    this.kind = 'sqlite';
    this.channel = channel;
    this.logger = logger;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  addLore(text, { kind = 'note', at = new Date().toISOString() } = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('lore text is empty');
    const result = this.db
      .prepare('INSERT INTO lore (channel, text, kind, created_at) VALUES (?, ?, ?, ?)')
      .run(this.channel, clean, kind, at);
    return { id: Number(result.lastInsertRowid), text: clean, kind, created_at: at };
  }

  listLore(limit = 10) {
    return this.db
      .prepare('SELECT id, text, kind, created_at FROM lore WHERE channel = ? ORDER BY id DESC LIMIT ?')
      .all(this.channel, limit)
      .map((row) => ({ ...row, id: Number(row.id) }));
  }

  deleteLore(id) {
    const result = this.db.prepare('DELETE FROM lore WHERE id = ? AND channel = ?').run(Number(id), this.channel);
    return Number(result.changes) > 0;
  }

  recordCall({ question, mode, stance, confidence, provider, receipts, at = new Date().toISOString() }) {
    const result = this.db
      .prepare(
        'INSERT INTO calls (channel, question, mode, stance, confidence, provider, receipts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.channel,
        question ?? null,
        mode,
        stance ?? null,
        confidence ?? null,
        provider ?? null,
        JSON.stringify(receipts ?? []),
        at,
      );
    return Number(result.lastInsertRowid);
  }

  recentCalls(limit = 10) {
    return this.db
      .prepare(
        'SELECT id, question, mode, stance, confidence, provider, receipts, created_at FROM calls WHERE channel = ? ORDER BY id DESC LIMIT ?',
      )
      .all(this.channel, limit)
      .map((row) => ({ ...row, id: Number(row.id), receipts: safeParse(row.receipts) }));
  }

  score(winner) {
    const column = winner === 'streamer' ? 'streamer_wins' : 'chat_wins';
    this.db
      .prepare(
        `INSERT INTO scoreboard (channel, chat_wins, streamer_wins, updated_at) VALUES (?, 0, 0, ?)
         ON CONFLICT(channel) DO NOTHING`,
      )
      .run(this.channel, new Date().toISOString());
    this.db
      .prepare(`UPDATE scoreboard SET ${column} = ${column} + 1, updated_at = ? WHERE channel = ?`)
      .run(new Date().toISOString(), this.channel);
    return this.getScoreboard();
  }

  getScoreboard() {
    const row = this.db
      .prepare('SELECT chat_wins, streamer_wins FROM scoreboard WHERE channel = ?')
      .get(this.channel);
    return {
      chat: Number(row?.chat_wins ?? 0),
      streamer: Number(row?.streamer_wins ?? 0),
    };
  }

  close() {
    this.db.close();
  }
}

export class MemoryStore {
  constructor({ channel }) {
    this.kind = 'memory';
    this.channel = channel;
    this.lore = [];
    this.calls = [];
    this.board = { chat: 0, streamer: 0 };
    this._nextLoreId = 1;
    this._nextCallId = 1;
  }

  addLore(text, { kind = 'note', at = new Date().toISOString() } = {}) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('lore text is empty');
    const entry = { id: this._nextLoreId++, text: clean, kind, created_at: at };
    this.lore.push(entry);
    return entry;
  }

  listLore(limit = 10) {
    return this.lore.slice(-limit).reverse();
  }

  deleteLore(id) {
    const before = this.lore.length;
    this.lore = this.lore.filter((entry) => entry.id !== Number(id));
    return this.lore.length !== before;
  }

  recordCall({ question, mode, stance, confidence, provider, receipts, at = new Date().toISOString() }) {
    const id = this._nextCallId++;
    this.calls.push({ id, question, mode, stance, confidence, provider, receipts: receipts ?? [], created_at: at });
    return id;
  }

  recentCalls(limit = 10) {
    return this.calls.slice(-limit).reverse();
  }

  score(winner) {
    if (winner === 'streamer') this.board.streamer += 1;
    else this.board.chat += 1;
    return this.getScoreboard();
  }

  getScoreboard() {
    return { ...this.board };
  }

  close() {}
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
