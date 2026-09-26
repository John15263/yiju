import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { check } from './validation.mjs';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (session_id TEXT, id TEXT, fingerprint TEXT, body TEXT,
        PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS view_acks (session_id TEXT, revision INTEGER, body TEXT,
        PRIMARY KEY(session_id,revision));`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
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
  close() { this.db.close(); }
}
