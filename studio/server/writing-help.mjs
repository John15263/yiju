import { check, fields, id, oneOf, text } from './validation.mjs';
import { textJSON, textError, textConfigured, textKeyMissing } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { callPhraseHint } from './phrases.mjs';

const keys = ['status', 'meaning', 'word', 'phrase', 'continuation', 'note'];
const schema = { type: 'object', properties: Object.fromEntries(keys.map(k => [k, k === 'status'
  ? { type: 'string', enum: ['continue', 'revise', 'complete'] } : { type: 'string' }])), required: keys, additionalProperties: false };
function validate(value) {
  fields(value, keys, keys); oneOf(value.status, ['continue', 'revise', 'complete']);
  text(value.meaning, 600); text(value.word, 120, value.status === 'complete');
  text(value.phrase, 400, value.status === 'complete'); text(value.continuation, 2000, value.status === 'complete'); text(value.note, 600, true);
  return value;
}
export async function callWritingHelp(packet, cfg, request = fetch) {
  const result = await textJSON(packet, cfg, { instructions: prompt('writing-help'), schema, tokens: 4096, limit: 14000, purpose: 'writing_help' }, request);
  return { ...validate(result.value), model: result.model };
}
function opening(value, language, count) {
  const words = [...new Intl.Segmenter(language, { granularity: 'word' }).segment(value)].filter(s => s.isWordLike);
  const last = words[Math.min(count, words.length) - 1];
  return last ? value.slice(0, last.index + last.segment.length).trim() : value.trim();
}
// What the instant, model-free path says, in the language the hints are read in.
const LOCAL = {
  zh: { complete: '这一句已经写完整，可以提交看看反馈。', next: '接着把这一句的意思表达完整。', note: '沿已有参考的一种接法，也可以用自己的表达。' },
  en: { complete: 'This sentence looks complete. Send it to get feedback.', start: 'Start with the first part of your idea.',
    next: 'Keep going. Say the next part of your idea.', note: 'This is one way to go on. Your own words are fine too.' },
  ja: { complete: 'この文はできたみたい。送ってフィードバックを見てね。', start: '言いたいことの最初の部分から書いてみて。',
    next: 'その調子。次の部分を書いてみて。', note: 'これは続け方の一つ。自分の言葉でも大丈夫。' },
};
// A literal reference prefix can be continued instantly. Other phrasings go to Gemini.
export function localWritingHelp(r, draft, caret, hintLanguage = 'zh') {
  const say = (hintLanguage === 'target' && LOCAL[r.language]) || LOCAL.zh, chinese = say === LOCAL.zh;
  if (caret !== draft.length || !r.reference.toLowerCase().startsWith(draft.trimStart().toLowerCase())) return null;
  const offset = draft.trimStart().length, rest = r.reference.slice(offset).trimStart();
  if (offset && r.language === 'en' && /[\p{L}\p{N}]$/u.test(draft) && /^[\p{L}\p{N}]/u.test(rest) && !/^\s/u.test(r.reference.slice(offset))) return null;
  if (!rest) return { status: 'complete', meaning: say.complete, word: '', phrase: '', continuation: '', note: '' };
  let cursor = 0, cue = '';
  for (const segment of r.cloze?.segments || []) {
    const content = typeof segment === 'string' ? segment : segment.answers[0];
    cursor += content.length;
    if (typeof segment !== 'string' && cursor > offset) { cue = segment.hints[0]; break; }
  }
  // The prepared cues are Chinese, so a target-language hint does without them. The next word itself is not
  // named here: it is the next level (word), given when the learner is still stuck (the learner, 2026-09-28:
  // naming it at once was too fast). With a text service, the request below describes it in other words.
  const word = opening(rest, r.language, 1);
  const meaning = chinese ? (!offset ? r.meaning : cue ? `接下来的一处关键意思：${cue}` : say.next) : !offset ? say.start : say.next;
  return { status: 'continue', meaning,
    word, phrase: opening(rest, r.language, r.language === 'ja' ? 4 : 5), continuation: rest,
    note: say.note };
}
export class WritingHelp {
  constructor(board, cfg, infer = callWritingHelp, describe = callPhraseHint) { this.board = board; this.cfg = cfg; this.infer = infer; this.describe = describe; this.cache = new Map(); this.pending = 0; }
  target(body) {
    id(body.round_id); check(Number.isInteger(body.window_start) && body.window_start >= 0, 'Invalid writing window');
    const s = this.board.read(), r = s.rounds.find(r => r.id === body.round_id);
    check(r && s.active_id === r.id && r.stage === 'practice' && r.window_start === body.window_start, '试写已切换，请读取最新状态。', 409);
    return { s, r };
  }
  async request(body) {
    fields(body, ['round_id', 'window_start', 'draft', 'caret', 'retry', 'hint_language'], ['round_id', 'window_start', 'draft', 'caret']);
    // Always the language being learned (2026-09-24); an old page's choice is checked and set aside.
    if (body.hint_language !== undefined) oneOf(body.hint_language, ['target', 'zh']);
    const hintLanguage = 'target';
    text(body.draft, 4000, true); check(Number.isInteger(body.caret) && body.caret >= 0 && body.caret <= body.draft.length, 'Invalid cursor');
    if (body.retry !== undefined) check(typeof body.retry === 'boolean', 'Invalid retry');
    const { s, r } = this.target(body), key = JSON.stringify([r.id, r.window_start, body.draft, body.caret, hintLanguage]);
    let entry = this.cache.get(key);
    if (entry?.error && body.retry) { this.cache.delete(key); entry = null; }
    if (!entry) {
      const local = localWritingHelp(r, body.draft, body.caret, hintLanguage);
      check(local || textConfigured(this.cfg), `本地参考可直接提示；其它表达需要先配好文字服务。${textKeyMissing(this.cfg)}`, 503);
      check(local || this.pending < 2, '正在准备其它提示，可以继续写，稍后再按 Option + /。', 429);
      const collection = s.collections?.find(c => c.id === r.collection_id);
      // The language meaning and note are written in, said outright (some services mixed languages without it).
      const packet = { language: r.language, write_in: r.language === 'ja' ? '日语（日本語）' : '英语（English）', hint_language: hintLanguage, intended_meaning: r.meaning, reference: r.reference, draft: body.draft,
        before_cursor: body.draft.slice(0, body.caret), after_cursor: body.draft.slice(body.caret),
        ...(collection ? { expression_context: { summary: collection.outline.summary, purpose: r.unit.purpose, connection: r.unit.connection } } : {}) };
      entry = { id: crypto.randomUUID(), round_id: r.id, window_start: r.window_start, draft: body.draft, caret: body.caret, seen: new Set() };
      this.cache.set(key, entry);
      if (!local) this.pending++;
      entry.promise = (async () => {
        try {
          let result = local ? { ...local, model: 'prepared-reference' } : await this.infer(packet, this.cfg), described = false;
          // Still on the prepared wording: the next word is described in other words first; the word itself waits
          // for the next level. Without a text service, or if this fails, the plain local line stays.
          const named = local?.status === 'continue' ? local.word.replace(/^[\p{P}\s]+/u, '') : '';
          if (named && textConfigured(this.cfg)) {
            try {
              const live = (await this.describe({ language: r.language, write_in: packet.write_in, chunk_meaning: r.meaning, chunk_reference: r.reference,
                draft: body.draft, level: 1, trigger: 'describe', next_word: named, hint_language: hintLanguage }, this.cfg)).value;
              fields(live, ['hint'], ['hint']); text(live.hint, 500);
              result = { ...result, meaning: live.hint }; described = true;
            } catch {}
          }
          fields(result, [...keys, 'model'], [...keys, 'model']); text(result.model, 100);
          entry.result = { hint_id: entry.id, ...validate(Object.fromEntries(keys.map(k => [k, result[k]]))), provider: local && !described ? 'local' : this.cfg.textProvider || 'gemini', model: result.model };
        } catch (e) { entry.error = textError(e, this.cfg); }
        finally { if (!local) this.pending--; entry.finished = true; }
      })();
      for (const [oldKey, old] of this.cache) if (this.cache.size > 64 && old.finished && old !== entry) this.cache.delete(oldKey);
    }
    await entry.promise;
    this.target(body); check(!entry.error, entry.error, 503);
    return entry.result;
  }
  seen(body) {
    fields(body, ['round_id', 'window_start', 'hint_id', 'level'], ['round_id', 'window_start', 'hint_id', 'level']);
    id(body.hint_id); check(Number.isInteger(body.level) && body.level >= 1 && body.level <= 4, 'Invalid hint level');
    const { s, r } = this.target(body), entry = [...this.cache.values()].find(e => e.id === body.hint_id);
    check(entry?.result && entry.round_id === r.id && entry.window_start === r.window_start, '提示已过期，请重新获取。', 409);
    if (entry.seen.has(body.level)) return this.board.public(s);
    const h = entry.result, detail = { hint_id: entry.id, hint_level: body.level, window_start: r.window_start, provider: h.provider, model: h.model,
      draft: entry.draft, caret: entry.caret, meaning: h.meaning, note: h.note,
      text: body.level === 1 ? '' : h[['', '', 'word', 'phrase', 'continuation'][body.level]] };
    r.support_events.push({ kind: 'writing_hint', at: new Date().toISOString(), level: body.level - 1, detail });
    s.revision++; s.updated_at = new Date().toISOString(); r.updated_at = s.updated_at;
    this.board.save(s); entry.seen.add(body.level);
    const state = this.board.public(s); this.board.publish(state); return state;
  }
}
