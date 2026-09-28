// 一句's records in the browser's own extension storage, behind the same methods as the local server's SQLite
// store (studio/server/store.mjs). Everything is held in memory so the engine reads it synchronously, exactly as it
// reads SQLite; every write goes through to storage.
const USAGE_LIMIT = 20000;

export class BrowserStore {
  static async open() { return new BrowserStore(await chrome.storage.local.get(null)); }
  constructor(all) {
    this.values = new Map(Object.entries(all));
    this.usage = this.values.get('usage') || [];
    this.outbox = this.values.get('anki') || [];
  }
  read(name) { return this.values.has(name) ? structuredClone(this.values.get(name)) : null; }
  write(name, value) {
    const copy = structuredClone(value);
    this.values.set(name, copy);
    void chrome.storage.local.set({ [name]: copy });
  }
  // Settings and other named values.
  get(name) { return this.read(`meta:${name}`); }
  set(name, value) { this.write(`meta:${name}`, value); }

  // The whole sentence board is one document; callers change what they are given, so they get a copy.
  board() { return this.read('board'); }
  saveBoard(s) { this.write('board', s); }
  freewrite(id) { return this.read(`freewrite:${id}`); }
  saveFreewrite(record) { this.write(`freewrite:${record.id}`, record); }
  explanation(key) { return this.read(`explanation:${key}`)?.lines || null; }
  saveExplanation({ key, mode, lines, model, created_at }) { this.write(`explanation:${key}`, { mode, lines, model: model || '', created_at }); }

  // What each model call used; the newest are kept.
  logUsage(row) {
    this.usage.push(row);
    if (this.usage.length > USAGE_LIMIT) this.usage.splice(0, this.usage.length - USAGE_LIMIT);
    void chrome.storage.local.set({ usage: this.usage });
  }
  usageTotal(since) {
    const rows = this.usage.filter(r => r.at >= since);
    return { calls: rows.length, usd: rows.reduce((n, r) => n + (r.usd || 0), 0), unpriced: rows.filter(r => r.usd === null).length };
  }
  usageByModel(since, purposes) {
    const calls = new Map();
    for (const r of this.usage) if (r.at >= since && purposes.includes(r.purpose)) calls.set(r.model, (calls.get(r.model) || 0) + 1);
    return [...calls].map(([model, n]) => ({ model, calls: n })).sort((a, b) => b.calls - a.calls);
  }
  usageFirst() { return this.usage.reduce((first, r) => (!first || r.at < first ? r.at : first), null); }
  usageByPurpose(since) {
    const groups = new Map();
    for (const r of this.usage) {
      if (r.at < since) continue;
      const g = groups.get(r.purpose) || { purpose: r.purpose, calls: 0, usd: 0, unpriced: 0, text_in: 0, audio_in: 0, text_out: 0, audio_out: 0, thoughts: 0 };
      g.calls++; g.usd += r.usd || 0; if (r.usd === null) g.unpriced++;
      for (const k of ['text_in', 'audio_in', 'text_out', 'audio_out', 'thoughts']) g[k] += r[k] || 0;
      groups.set(r.purpose, g);
    }
    return [...groups.values()].sort((a, b) => b.usd - a.usd);
  }

  // Anki cards waiting to be pushed; a quiz makes at most one.
  ankiEnqueue(card, at) {
    if (this.outbox.some(e => e.quiz_id === card.quiz_id)) return;
    const id = this.outbox.reduce((n, e) => Math.max(n, e.id), 0) + 1;
    this.outbox.push({ id, created_at: at, quiz_id: card.quiz_id, card, status: 'pending', note_id: null, error: null, pushed_at: null });
    void chrome.storage.local.set({ anki: this.outbox });
  }
  ankiPending() { return this.outbox.filter(e => e.status === 'pending').sort((a, b) => a.id - b.id).map(e => ({ id: e.id, card: structuredClone(e.card) })); }
  ankiMark(id, { status, note_id = null, error = null, pushed_at }) {
    const entry = this.outbox.find(e => e.id === id);
    if (!entry) return;
    Object.assign(entry, { status, note_id, error, pushed_at });
    void chrome.storage.local.set({ anki: this.outbox });
  }
  ankiCounts() {
    const counts = {};
    for (const e of this.outbox) counts[e.status] = (counts[e.status] || 0) + 1;
    return counts;
  }
}
