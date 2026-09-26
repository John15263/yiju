// Every correction's fill-in check also becomes an Anki cloze card, for spaced review later. Cards wait
// in a local outbox and are pushed through AnkiConnect whenever Anki is open; nothing is lost while it
// is closed, and a card Anki already has counts as pushed.
const escape = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const MODEL = {
  name: '一句 · 改错填空',
  front: '<div class="text">{{cloze:Text}}</div>\n{{type:cloze:Text}}',
  back: '<div class="text">{{cloze:Text}}</div>\n{{type:cloze:Text}}\n<hr>\n<div class="extra">{{Extra}}</div>',
  css: '.card{font-family:-apple-system,"PingFang SC",sans-serif;font-size:22px;line-height:1.6;text-align:left;color:#253f33;background:#fdfdfb;padding:12px}'
    + ' .cloze{font-weight:600;color:#2f6b45} .extra{font-size:16px;color:#6e7d74} input{font-size:20px}',
};

export function clozeCard(quiz, r) {
  const text = quiz.segments.map(seg => typeof seg === 'string' ? escape(seg) : `{{c${seg.blank + 1}::${escape(quiz.answers[seg.blank])}}}`).join('');
  const extra = [`中文：${escape(quiz.meaning)}`, `当时写的：${escape(quiz.text)}`,
    ...quiz.changes.map(c => `${escape(c.from)} → ${escape(c.to)}${c.why ? `：${escape(c.why)}` : ''}`)].join('<br>');
  return { text, extra, tags: ['一句', r.language === 'ja' ? '日语' : '英语', quiz.kind === 'chunk' ? '短语' : '整句'], round_id: r.id, quiz_id: quiz.id };
}

export class Anki {
  constructor(store, cfg, request = fetch) {
    this.db = store.db; this.url = cfg.ankiUrl; this.deck = cfg.ankiDeck; this.request = request;
    // Only the real practice server pushes; tests and previews keep cards in the outbox, away from the learner's Anki.
    this.live = cfg.ankiPush === true;
    this.flushing = null; this.lastError = ''; this.lastPushed = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS anki_outbox (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, quiz_id TEXT UNIQUE,
      body TEXT NOT NULL, status TEXT NOT NULL, note_id INTEGER, error TEXT, pushed_at TEXT)`);
  }
  // Retried in the background, so a card made while Anki was closed goes over once it is opened.
  start(every = 5 * 60 * 1000) { this.timer = setInterval(() => { void this.flush(); }, every); this.timer.unref?.(); void this.flush(); }
  enqueue(card) {
    try {
      this.db.prepare('INSERT OR IGNORE INTO anki_outbox (created_at, quiz_id, body, status) VALUES (?,?,?,?)')
        .run(new Date().toISOString(), card.quiz_id, JSON.stringify(card), 'pending');
    } catch { return; }
    void this.flush();
  }
  async call(action, params = {}) {
    const response = await this.request(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, version: 6, params }) });
    const data = await response.json();
    if (data?.error) throw Object.assign(new Error(String(data.error)), { anki: true });
    return data?.result;
  }
  // Cards go into a note type of their own, made here the first time, so they never land in one of the
  // learner's own templates (a collection may have no built-in Cloze type, only custom ones with other
  // fields). Reviewing, the blank is typed in, as it was in practice.
  async model() {
    const name = MODEL.name;
    if (!(await this.call('modelNames')).includes(name)) {
      await this.call('createModel', { modelName: name, inOrderFields: ['Text', 'Extra'], isCloze: true, css: MODEL.css,
        cardTemplates: [{ Name: '改错填空', Front: MODEL.front, Back: MODEL.back }] });
    }
    return { name, text: 'Text', extra: 'Extra' };
  }
  flush() {
    this.flushing ||= this.push().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async push() {
    if (!this.live) return;
    const rows = this.db.prepare("SELECT id, body FROM anki_outbox WHERE status = 'pending' ORDER BY id").all();
    if (!rows.length) return;
    let model;
    try { model = await this.model(); await this.call('createDeck', { deck: this.deck }); }
    catch (e) { this.lastError = e.anki ? e.message : `连不上 Anki（${this.url}）：Anki 没打开，或者 AnkiConnect 没在这个端口上`; return; }
    this.lastError = '';
    for (const row of rows) {
      const card = JSON.parse(row.body);
      try {
        const noteID = await this.call('addNote', { note: { deckName: this.deck, modelName: model.name,
          fields: { [model.text]: card.text, ...(model.extra ? { [model.extra]: card.extra } : {}) }, tags: card.tags, options: { allowDuplicate: false } } });
        this.db.prepare("UPDATE anki_outbox SET status='sent', note_id=?, pushed_at=? WHERE id=?").run(noteID, new Date().toISOString(), row.id);
        this.lastPushed = new Date().toISOString();
      } catch (e) {
        if (!e.anki) { this.lastError = `推送中途连不上 Anki（${this.url}）`; return; }
        // Already in the deck: that is what was wanted.
        const duplicate = /duplicate/i.test(e.message);
        this.db.prepare('UPDATE anki_outbox SET status=?, error=?, pushed_at=? WHERE id=?')
          .run(duplicate ? 'sent' : 'failed', duplicate ? null : e.message.slice(0, 300), new Date().toISOString(), row.id);
        if (!duplicate) this.lastError = e.message;
      }
    }
  }
  status() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM anki_outbox GROUP BY status').all().map(r => [r.status, r.n]));
    return { deck: this.deck, url: this.url, sent: counts.sent || 0, pending: counts.pending || 0, failed: counts.failed || 0,
      last_error: this.lastError, last_pushed: this.lastPushed };
  }
}
