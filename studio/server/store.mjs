import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { check } from './validation.mjs';

// The local server's records, in SQLite. The browser extension keeps the same records in its own storage
// (edge/store.js) behind the same methods, so the engine does not know which it is using.
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (session_id TEXT, id TEXT, fingerprint TEXT, body TEXT,
        PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS view_acks (session_id TEXT, revision INTEGER, body TEXT,
        PRIMARY KEY(session_id,revision));
      CREATE TABLE IF NOT EXISTS sentence_board (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS freewrites (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explanations (key TEXT PRIMARY KEY, mode TEXT NOT NULL, lines TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL,
        round_id TEXT, text_in INTEGER, audio_in INTEGER, text_out INTEGER, audio_out INTEGER, thoughts INTEGER, usd REAL);
      CREATE TABLE IF NOT EXISTS anki_outbox (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, quiz_id TEXT UNIQUE,
        body TEXT NOT NULL, status TEXT NOT NULL, note_id INTEGER, error TEXT, pushed_at TEXT);`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  // The practice sessions of /legacy.
  get(id) {
    const row = this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id);
    check(row, 'Session not found', 404);
    return JSON.parse(row.body);
  }
  put(state) {
    this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(state.session_id, JSON.stringify(state));
  }
  list() {
    return this.db.prepare('SELECT body FROM sessions ORDER BY rowid DESC').all().map(r => {
      const s = JSON.parse(r.body);
      return { session_id: s.session_id, target_language: s.target_language, phase: s.phase, updated_at: s.updated_at, revision: s.revision };
    });
  }
  decision(session, id) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE session_id=? AND id=?').get(session, id);
    return row && { fingerprint: row.fingerprint, trace: JSON.parse(row.body) };
  }
  saveDecision(session, fingerprint, trace) {
    this.db.prepare('INSERT INTO decisions VALUES (?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET body=excluded.body')
      .run(session, trace.decision_id, fingerprint, JSON.stringify(trace));
  }
  decisions(session) {
    return this.db.prepare('SELECT body FROM decisions WHERE session_id=? ORDER BY rowid').all(session).map(r => JSON.parse(r.body));
  }
  viewAck(session, revision) {
    const row = this.db.prepare('SELECT body FROM view_acks WHERE session_id=? AND revision=?').get(session, revision);
    return row ? JSON.parse(row.body) : null;
  }
  saveViewAck(session, ack) {
    this.db.prepare('INSERT OR IGNORE INTO view_acks VALUES (?,?,?)').run(session, ack.rendered_revision, JSON.stringify(ack));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // 一句: the whole sentence board is one document.
  board() {
    const row = this.db.prepare('SELECT body FROM sentence_board WHERE id=1').get();
    return row ? JSON.parse(row.body) : null;
  }
  saveBoard(s) {
    this.db.prepare('INSERT INTO sentence_board VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(s));
  }
  // Free writing, kept as written.
  freewrite(id) {
    const row = this.db.prepare('SELECT body FROM freewrites WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  saveFreewrite(record) {
    this.db.prepare('INSERT INTO freewrites VALUES (?,?)').run(record.id, JSON.stringify(record));
  }
  // Explanation scripts, found again by what they teach.
  explanation(key) {
    const row = this.db.prepare('SELECT lines FROM explanations WHERE key = ?').get(key);
    return row ? JSON.parse(row.lines) : null;
  }
  saveExplanation({ key, mode, lines, model, created_at }) {
    this.db.prepare('INSERT OR REPLACE INTO explanations (key, mode, lines, model, created_at) VALUES (?,?,?,?,?)')
      .run(key, mode, JSON.stringify(lines), model || '', created_at);
  }
  // What each model call used.
  logUsage(r) {
    this.db.prepare('INSERT INTO usage_log (at,purpose,model,round_id,text_in,audio_in,text_out,audio_out,thoughts,usd) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(r.at, r.purpose, r.model, r.round_id, r.text_in, r.audio_in, r.text_out, r.audio_out, r.thoughts, r.usd);
  }
  usageTotal(since) {
    return this.db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(usd),0) AS usd FROM usage_log WHERE at >= ?').get(since);
  }
  usageFirst() { return this.db.prepare('SELECT MIN(at) AS at FROM usage_log').get().at; }
  usageByPurpose(since) {
    return this.db.prepare(`SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(usd),0) AS usd, SUM(usd IS NULL) AS unpriced,
      SUM(text_in) AS text_in, SUM(audio_in) AS audio_in, SUM(text_out) AS text_out, SUM(audio_out) AS audio_out, SUM(thoughts) AS thoughts
      FROM usage_log WHERE at >= ? GROUP BY purpose ORDER BY usd DESC`).all(since);
  }
  // Anki cards waiting to be pushed; a quiz makes at most one.
  ankiEnqueue(card, at) {
    this.db.prepare('INSERT OR IGNORE INTO anki_outbox (created_at, quiz_id, body, status) VALUES (?,?,?,?)')
      .run(at, card.quiz_id, JSON.stringify(card), 'pending');
  }
  ankiPending() {
    return this.db.prepare("SELECT id, body FROM anki_outbox WHERE status = 'pending' ORDER BY id").all().map(r => ({ id: r.id, card: JSON.parse(r.body) }));
  }
  ankiMark(id, { status, note_id = null, error = null, pushed_at }) {
    this.db.prepare('UPDATE anki_outbox SET status=?, note_id=?, error=?, pushed_at=? WHERE id=?').run(status, note_id, error, pushed_at, id);
  }
  ankiCounts() {
    return Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM anki_outbox GROUP BY status').all().map(r => [r.status, r.n]));
  }
  close() { this.db.close(); }
}
