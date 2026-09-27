import { check, fields, id } from './validation.mjs';
import { textJSON, textConfigured, textKeyMissing } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { sha256 } from './sha256.mjs';
import { voiceMode } from '../web/voice-mode.js';
import { contextOf, ETYMOLOGY } from './voice.mjs';

// Explanations are written once by the text model, shown line by line and read aloud by Gemini TTS
// (2026-09-24), instead of being spoken by the live tutor every time. Per second of speech the two cost
// about the same, but a script can be kept: practising the sentence again replays it for nothing, the
// next chunk's is written while this one is studied so it starts at once, and it follows the prompt's
// order more faithfully. The live tutor is still there, opened by hand, for questions.
const now = () => new Date().toISOString();
const schema = { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', items: { type: 'string' } } } };
export const callExplain = (packet, cfg) => textJSON(packet, { ...cfg, geminiTimeout: cfg.geminiNoteTimeout || cfg.geminiTimeout },
  { instructions: prompt('explain').replace('{{ETYMOLOGY}}', ETYMOLOGY), schema, tokens: 8192, limit: 6000, purpose: packet.mode === 'learn' ? 'explain_learn' : 'explain_fix' });
const MODES = ['learn', 'fix', 'review'];

// Lines are read aloud one by one, so each stays a sentence or two.
export function scriptLines(value) {
  fields(value, ['lines'], ['lines']);
  check(Array.isArray(value.lines), 'Invalid explanation');
  const lines = value.lines.filter(l => typeof l === 'string').map(l => l.trim()).filter(Boolean).slice(0, 10).map(l => l.slice(0, 240));
  check(lines.length, 'Invalid explanation');
  return lines;
}

export class Explanations {
  constructor(board, cfg, write = callExplain) {
    this.board = board; this.cfg = cfg; this.write = write; this.pending = new Map();
  }
  // A chunk is taught the same way whenever it comes up, so its script is found again by what it teaches;
  // a correction is only ever about one attempt, so it is keyed by everything on screen.
  keyOf(r, mode) {
    const chunk = mode.mode === 'learn' ? r.phrases.items[r.phrases.index] : null;
    // v2: foreign words marked (2026-09-27); scripts from before are written again rather than replayed.
    const basis = ['v2', ...(chunk ? ['learn', r.language, chunk.meaning, chunk.reference, chunk.hints?.[0] || ''] : [mode.mode, r.language, contextOf(r, mode)])];
    return sha256(JSON.stringify(basis));
  }
  kept(key) {
    return this.board.store.explanation(key);
  }
  // One writing per script, however many times it is asked for while being written.
  script(key, mode, context) {
    const kept = this.kept(key);
    if (kept) return Promise.resolve({ lines: kept, cached: true });
    if (!this.pending.has(key)) {
      this.pending.set(key, (async () => {
        const result = await this.write({ mode, language: context.语言, context }, this.cfg);
        const lines = scriptLines(result.value);
        this.board.store.saveExplanation({ key, mode, lines, model: result.model, created_at: now() });
        return { lines, cached: false };
      })().finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }
  async request(body) {
    fields(body, ['round_id', 'window_start', 'key'], ['round_id', 'window_start', 'key']);
    id(body.round_id); check(typeof body.key === 'string' && body.key.length <= 200, 'Invalid key');
    check(textConfigured(this.cfg), textKeyMissing(this.cfg), 503);
    const opened = this.here(body);
    const { r, mode } = opened, key = this.keyOf(r, mode);
    // This chunk first; the next one is written behind it.
    const writing = this.script(key, mode.mode, contextOf(r, mode));
    if (mode.mode === 'learn') this.prefetch(r);
    let script;
    try { script = await writing; }
    catch (e) { check(false, e.status ? e.message : '这次没写成讲解稿，可以重试。', e.status || 502); }
    // Heard for this moment: recorded once, and a chunk explained counts as studied.
    try {
      const { s, r: now_, mode: still } = this.here(body);
      if (!(now_.support_events || []).some(e => e.kind === 'explanation' && e.detail?.moment === still.key)) {
        const index = still.correction?.index ?? now_.phrases?.index ?? null;
        now_.support_events.push({ kind: 'explanation', level: 0, at: now(), detail: { moment: still.key, mode: still.mode, index, lines: script.lines, cached: script.cached } });
        const learn = still.mode === 'learn' ? now_.phrases.inputs[now_.phrases.index]?.learn : null;
        if (learn) { learn.explained = (learn.explained || 0) + 1; learn.skipped = false; }
        s.revision++; s.updated_at = now(); this.board.save(s); this.board.publish(this.board.public(s));
      }
    } catch {}
    return { key: body.key, lines: script.lines, cached: script.cached };
  }
  here(body) {
    const s = this.board.read(), r = s.rounds.find(x => x.id === body.round_id), mode = voiceMode(r);
    check(r && s.active_id === r.id && r.window_start === body.window_start && mode && MODES.includes(mode.mode) && mode.key === body.key, '讲解已切换，请读取最新状态。', 409);
    return { s, r, mode };
  }
  // The next chunk's script is written while this one is being studied, so it can start the moment he gets there.
  prefetch(r) {
    const next = r.phrases.index + 1;
    if (next >= r.phrases.items.length) return;
    const ahead = { ...r, phrases: { ...r.phrases, index: next, step: 'learn' } }, mode = voiceMode(ahead);
    if (mode?.mode !== 'learn') return;
    this.script(this.keyOf(ahead, mode), 'learn', contextOf(ahead, mode)).catch(() => {});
  }
}
