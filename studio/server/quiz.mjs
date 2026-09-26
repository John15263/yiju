import { check, fields, id, text } from './validation.mjs';
import { textJSON, textConfigured } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { clozeFrom, openQuiz } from '../web/view.js';
import { loose } from '../web/voice-mode.js';

// After a correction has been read and talked over, the corrected wording comes back with each real
// change left blank, to be filled from memory before moving on. Right away is when it sticks.
const now = () => new Date().toISOString();
const schema = { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['ok', 'note'], properties: { ok: { type: 'boolean' }, note: { type: 'string' } } } } } };
export const callQuizCheck = (packet, cfg) => textJSON(packet, { ...cfg, geminiTimeout: cfg.geminiNoteTimeout || cfg.geminiTimeout },
  { instructions: prompt('quiz-check'), schema, tokens: 8192, limit: 4000, purpose: 'quiz_check' });

// Null when nothing but case or punctuation changed: nothing worth filling back in.
export function makeQuiz({ kind, index = null, attemptID, text: written, corrected, meaning, changes = [], language }) {
  const cloze = clozeFrom(written, corrected, language);
  if (!cloze) return null;
  return { id: crypto.randomUUID(), kind, index, attempt_id: attemptID, text: written, corrected, meaning, language, changes,
    segments: cloze.segments, answers: cloze.answers, tries: 0, inputs: [], results: [], status: 'open', passed: null, created_at: now() };
}
const TRIES = 2;

export class Quizzes {
  constructor(board, cfg, phrases, judge = callQuizCheck) { this.board = board; this.cfg = cfg; this.phrases = phrases; this.judge = judge; }
  commit(s) {
    s.revision++; s.updated_at = now(); this.board.save(s);
    const state = this.board.public(s); this.board.publish(state); return state;
  }
  target(body, extra = [], required = []) {
    fields(body, ['round_id', 'quiz_id', ...extra], ['round_id', 'quiz_id', ...required]); id(body.round_id); id(body.quiz_id);
    const s = this.board.read(), r = s.rounds.find(r => r.id === body.round_id), quiz = openQuiz(r);
    check(r && s.active_id === r.id && quiz?.id === body.quiz_id, '小测已切换，请读取最新状态。', 409);
    return { s, r, quiz };
  }
  async answer(body) {
    const opened = this.target(body, ['answers'], ['answers']);
    check(opened.quiz.status === 'open', '这道小测已经做完了。', 409);
    check(Array.isArray(body.answers) && body.answers.length === opened.quiz.answers.length, 'Invalid answers');
    body.answers.forEach(a => text(a, 200, true));
    const { quiz } = opened, answers = body.answers.map(a => a.trim());
    // Written as corrected: right, locally and for free. Anything else is judged by Gemini, which accepts
    // another wording that works; an empty blank is simply not filled.
    const results = answers.map((a, i) => loose(a) === loose(quiz.answers[i]) ? { ok: true, note: '', by: 'local' } : a ? null : { ok: false, note: '这一空还没填。', by: 'local' });
    const pending = results.map((r, i) => r ? null : i).filter(i => i !== null);
    if (pending.length) {
      let judged = null;
      if (textConfigured(this.cfg)) {
        try {
          let blank = 0;
          const sentence = quiz.segments.map(seg => typeof seg === 'string' ? seg : `[${++blank}]`).join('');
          const value = (await this.judge({ language: quiz.language, meaning: quiz.meaning, sentence,
            items: pending.map(i => ({ blank: i + 1, expected: quiz.answers[i], answer: answers[i] })) }, this.cfg)).value;
          fields(value, ['results'], ['results']);
          check(Array.isArray(value.results) && value.results.length === pending.length, 'Invalid quiz judgment');
          judged = value.results.map(r => ({ ok: r?.ok === true, note: typeof r?.note === 'string' ? r.note.slice(0, 200) : '', by: 'gemini' }));
        } catch {}
      }
      pending.forEach((i, n) => { results[i] = judged?.[n] || { ok: false, note: '和批改的写法不一样，这次没能请 Gemini 判定。', by: 'local' }; });
    }
    let current;
    try { current = this.target(body, ['answers'], ['answers']); } catch { return this.board.get(); }
    const { s, r } = current, saved = current.quiz;
    if (saved.status !== 'open') return this.board.public(s);
    Object.assign(saved, { tries: saved.tries + 1, inputs: answers, results, answered_at: now() });
    const passed = results.every(x => x.ok);
    r.support_events.push({ kind: 'quiz', level: 0, at: now(), detail: { quiz_id: saved.id, kind: saved.kind, index: saved.index, try: saved.tries,
      answers, expected: saved.answers, results: results.map(x => x.ok) } });
    // Right: straight on. Still wrong after the last try: the answers are shown, and the next Command + Enter goes on.
    if (passed) { Object.assign(saved, { status: 'done', passed: true }); this.proceed(s, r, saved); }
    else if (saved.tries >= TRIES) Object.assign(saved, { status: 'done', passed: false });
    return this.commit(s);
  }
  continue(body) {
    const { s, r, quiz } = this.target(body);
    check(quiz.status === 'done', '先把这道小测做完。', 409);
    this.proceed(s, r, quiz); return this.commit(s);
  }
  proceed(s, r, quiz) {
    if (quiz.kind === 'chunk') {
      const input = r.phrases.inputs[r.phrases.index];
      input.text = input.result.text;
      this.phrases.advance(s, r, input.result.cleared ? 'typed_original' : 'after_correction');
    } else this.board.finishRound(s, r, 'manual');
  }
}
