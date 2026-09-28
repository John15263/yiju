import { check, fields, id, oneOf, text } from './validation.mjs';
import { textJSON, textConfigured, textError } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { loose } from '../web/voice-mode.js';
import { openTransfer } from '../web/view.js';
import { transferCard } from './anki.mjs';

// 换个场合: the chunk carrying a sentence's core meaning (its axis, marked by meaning, not grammar, when the
// material was prepared) comes back in a new, everyday setting, and the learner says the new sentence. Once right after each
// sentence, with the axis that cost the most; once more when the passage is done, each axis in yet another
// setting, in shuffled order. The design is in studio/docs/transfer.md.
const now = () => new Date().toISOString();
const makeSchema = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['prompt', 'example'], properties: { prompt: { type: 'string' }, example: { type: 'string' } } } } } };
// Judged by meaning, not grammar (the learner, 2026-09-28): was the core meaning carried into the new setting?
const VERDICTS = ['carried', 'partly', 'miss'];
const checkSchema = { type: 'object', additionalProperties: false, required: ['verdict', 'note', 'suggestion'],
  properties: { verdict: { type: 'string', enum: VERDICTS }, note: { type: 'string' }, suggestion: { type: 'string' } } };
export const callTransferMake = (packet, cfg) => textJSON(packet, cfg,
  { instructions: prompt('transfer-make'), schema: makeSchema, tokens: 8192, limit: 8000, purpose: 'transfer_make' });
export const callTransferCheck = (packet, cfg) => textJSON(packet, { ...cfg, geminiTimeout: cfg.geminiNoteTimeout || cfg.geminiTimeout },
  { instructions: prompt('transfer-check'), schema: checkSchema, tokens: 8192, limit: 4000, purpose: 'transfer_check' });

const TRIES = 2, SECOND_ROUND = 4;
// A sentence's question is written once its chunks are done, while the sentence is written and reviewed.
const WRITING = ['practice', 'awaiting_feedback', 'review'];
// Each level adds a line; the newest is shown on top. The last one is the answer.
const HINTS = [item => `想想刚才「${item.chunk_meaning}」那里的说法。`, item => `刚才那一块是这样写的：${item.chunk_reference}`, item => `参考说法：${item.example}`];

// How much a chunk cost the learner: corrected by its check, then hints asked for or waited into (the one that
// comes by itself as the box opens does not count), then nothing at all.
function struggle(r, index) {
  const input = r.phrases.inputs[index];
  if (input?.quiz || input?.result?.verdict === 'adjust') return 3;
  return hintsFor(r, index) ? 2 : 1;
}
const hintsFor = (r, index) => r.support_events.filter(e => e.kind === 'phrase_hint' && e.detail?.index === index && e.detail?.trigger !== 'start').length;
function trouble(r, index) {
  const input = r.phrases.inputs[index], hints = hintsFor(r, index);
  if (input?.quiz) return `写成了「${input.quiz.text}」，被改成「${input.quiz.corrected}」`;
  return hints ? `点过 ${hints} 次提示${input?.hint_level >= 3 ? '，还看了参考写法' : ''}` : '';
}
const roundsOf = (s, c) => c.round_ids.map(id => s.rounds.find(x => x.id === id)).filter(Boolean);

// The axis worth practising in this sentence, if it has one: the chunk that cost the most, earliest first, and
// not an axis another sentence of the passage has already had.
export function pickAxis(s, r) {
  if (r.phrases?.status !== 'ready') return null;
  const c = s.collections?.find(x => x.id === r.collection_id);
  const used = new Set((c ? roundsOf(s, c) : []).filter(x => x.id !== r.id).flatMap(x => x.transfer?.items || []).map(i => loose(i.axis)));
  let best = null;
  r.phrases.items.forEach((item, index) => {
    if (!item.axis || used.has(loose(item.axis))) return;
    const priority = struggle(r, index);
    if (!best || priority > best.priority) best = { index, priority };
  });
  if (!best) return null;
  const item = r.phrases.items[best.index];
  return { round_id: r.id, chunk_index: best.index, axis: item.axis, axis_meaning: item.axis_meaning, chunk_meaning: item.meaning,
    chunk_reference: item.reference.trim(), priority: best.priority, trouble: trouble(r, best.index) };
}
// The passage's second round: every axis of the first, missed ones first when there are too many, shuffled
// so the order gives nothing away.
export function secondRound(s, c, random = Math.random) {
  const firsts = roundsOf(s, c).flatMap(x => x.transfer?.round === 1 ? x.transfer.items : []);
  const rank = item => item.passed === false ? 10 : item.priority;
  const chosen = firsts.map((item, i) => ({ item, i })).sort((a, b) => rank(b.item) - rank(a.item) || a.i - b.i).slice(0, SECOND_ROUND).map(x => x.item);
  for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
  return chosen.map(({ round_id, chunk_index, axis, axis_meaning, chunk_meaning, chunk_reference, priority, trouble, prompt, id }) =>
    ({ round_id, chunk_index, axis, axis_meaning, chunk_meaning, chunk_reference, priority, trouble, earlier: prompt, first_item_id: id }));
}
const finishedPassage = (s, c) => !!c && roundsOf(s, c).every(x => x.stage === 'complete');

export class Transfers {
  constructor(board, cfg, make = callTransferMake, judge = callTransferCheck) {
    this.board = board; this.cfg = cfg; this.make = make; this.judge = judge;
    this.making = new Set(); this.judging = new Set();
    // Any saved change may be the moment a question can be written: a sentence's chunks are done, or the
    // passage's last question is settled. Looked at once the change is out, never inside it.
    const publish = board.publish;
    board.publish = state => { publish(state); queueMicrotask(() => this.pump()); };
  }
  commit(s) {
    s.revision++; s.updated_at = now(); this.board.save(s);
    const state = this.board.public(s); this.board.publish(state); return state;
  }
  // Starts writing whatever question is due. Nothing is saved until it is written, so the learner's next
  // command never meets a revision it has not seen.
  pump() {
    try {
      if (!textConfigured(this.cfg)) return;
      const s = this.board.read(), r = s.rounds.find(x => x.id === s.active_id);
      if (!r) return;
      const c = s.collections?.find(x => x.id === r.collection_id);
      const avoid = c?.outline?.summary || r.meaning;
      if (!r.transfer && WRITING.includes(r.stage) && !this.making.has(r.id) && this.making.size < 3) {
        const seed = pickAxis(s, r);
        if (seed) this.start(r.id, 1, [seed], { language: r.language, avoid });
      }
      if (c && !c.transfer && !this.making.has(c.id) && this.settled(s, c)) {
        const seeds = secondRound(s, c);
        if (seeds.length) this.start(c.id, 2, seeds, { language: r.language, avoid });
      }
    } catch {}
  }
  // The passage's second round can be written once every other sentence is done and the one in hand has its
  // own question (or will have none): its prompt is one the second round must steer clear of.
  settled(s, c) {
    return roundsOf(s, c).every(x => x.stage === 'complete' || (x.id === s.active_id && [...WRITING, 'transfer'].includes(x.stage)
      && !this.making.has(x.id) && (x.transfer || !pickAxis(s, x))));
  }
  start(key, round, seeds, { language, avoid }) {
    this.making.add(key);
    const packet = { language, avoid, items: seeds.map(seed => ({ axis: seed.axis, axis_meaning: seed.axis_meaning, chunk_meaning: seed.chunk_meaning,
      chunk_reference: seed.chunk_reference, trouble: seed.trouble, earlier: seed.earlier || '' })) };
    void this.write(key, round, seeds, packet).finally(() => this.making.delete(key));
  }
  async write(key, round, seeds, packet) {
    let made = null, model = null, failure = null;
    try {
      const response = await this.make(packet, this.cfg);
      fields(response.value, ['items'], ['items']);
      check(Array.isArray(response.value.items) && response.value.items.length === seeds.length, 'Invalid transfer items');
      made = response.value.items.map((m, i) => {
        fields(m, ['prompt', 'example'], ['prompt', 'example']); text(m.prompt, 200); text(m.example, 600);
        check(!seeds[i].earlier || loose(m.prompt) !== loose(seeds[i].earlier), 'Repeated transfer prompt');
        return { prompt: m.prompt.trim(), example: m.example.trim() };
      });
      model = typeof response.model === 'string' ? response.model.slice(0, 100) : null;
    } catch (e) { failure = textError(e, this.cfg); }
    const s = this.board.read();
    const transfer = { id: crypto.randomUUID(), round, status: failure ? 'failed' : 'ready', index: 0, created_at: now(),
      ...(failure ? { message: failure } : { provider: this.cfg.textProvider || 'gemini', model }),
      items: failure ? [] : seeds.map((seed, i) => ({ id: crypto.randomUUID(), ...seed, ...made[i],
        status: 'open', tries: 0, inputs: [], results: [], hint_level: 0, hints: [], passed: null })) };
    if (round === 1) {
      const r = s.rounds.find(x => x.id === key);
      // A sentence finished before its question was ready goes on without it.
      if (!r || r.transfer || !WRITING.includes(r.stage)) return;
      r.transfer = transfer;
    } else {
      const c = s.collections?.find(x => x.id === key);
      if (!c || c.transfer) return;
      c.transfer = transfer;
    }
    this.commit(s);
  }
  // The question on screen: the sentence's own while it waits on it, or the passage's once every sentence is done.
  target(body, extra = [], required = []) {
    fields(body, ['transfer_id', 'item_id', ...extra], ['transfer_id', 'item_id', ...required]); id(body.transfer_id); id(body.item_id);
    const s = this.board.read(), r = s.rounds.find(x => x.id === s.active_id);
    const c = s.collections?.find(x => x.id === r?.collection_id);
    const transfer = openTransfer(r, c?.transfer, finishedPassage(s, c));
    const item = transfer?.items[transfer.index];
    check(transfer?.id === body.transfer_id && item?.id === body.item_id, '题目已切换，请读取最新状态。', 409);
    return { s, r, transfer, item, owner: s.rounds.find(x => x.id === item.round_id) || r };
  }
  event(owner, transfer, item, detail = {}) {
    owner.support_events.push({ kind: 'transfer', level: item.hint_level, at: now(),
      detail: { transfer_id: transfer.id, item_id: item.id, round: transfer.round, axis: item.axis, hint_level: item.hint_level, ...detail } });
  }
  async answer(body) {
    const opened = this.target(body, ['answer'], ['answer']); text(body.answer, 800);
    check(opened.item.status === 'open', '这道题已经做完了。', 409);
    // Sent twice while the first is still being judged: the first one's result is what counts.
    if (this.judging.has(opened.item.id)) return this.board.public(opened.s);
    const answer = body.answer.trim(), { item } = opened;
    let result = null;
    // Said as the example: right, locally and for free. Anything else is judged, and another wording that
    // works is not wrong, only not the one being practised.
    if (loose(answer) === loose(item.example)) result = { verdict: 'carried', note: '', suggestion: answer, by: 'local' };
    else if (textConfigured(this.cfg)) {
      this.judging.add(item.id);
      try {
        const value = (await this.judge({ language: opened.r.language, prompt: item.prompt, axis: item.axis, axis_meaning: item.axis_meaning,
          example: item.example, answer, try: item.tries + 1 }, this.cfg)).value;
        fields(value, ['verdict', 'note', 'suggestion'], ['verdict', 'note', 'suggestion']);
        oneOf(value.verdict, VERDICTS); text(value.note, 300, true); text(value.suggestion, 800, true);
        result = { verdict: value.verdict, note: value.note.trim(), suggestion: value.suggestion.trim() || answer, by: this.cfg.textProvider || 'gemini' };
      } catch {} finally { this.judging.delete(item.id); }
    }
    result ||= { verdict: 'unchecked', suggestion: '', by: 'local',
      note: textConfigured(this.cfg) ? '这次没能判定，对照参考说法自己看一下。' : '还没有配好文字服务，对照参考说法自己看一下。' };
    let current;
    // The learner may have moved on while it was judged.
    try { current = this.target(body, ['answer'], ['answer']); } catch { return this.board.get(); }
    const { s, r, transfer, item: saved, owner } = current;
    if (saved.status !== 'open') return this.board.public(s);
    saved.tries++; saved.inputs.push(answer); saved.results.push({ ...result, at: now() });
    const last = saved.tries >= TRIES;
    if (result.verdict === 'carried') saved.passed = true;
    else if (result.verdict === 'unchecked' || last) saved.passed = result.verdict === 'unchecked' ? null : false;
    // Only part of the meaning came through: asked once more, with where it was met.
    else if (result.verdict === 'partly' && saved.hint_level < 1) this.hint(saved, 1);
    const settled = result.verdict === 'carried' || result.verdict === 'unchecked' || last;
    this.event(owner, transfer, saved, { try: saved.tries, answer, verdict: result.verdict });
    if (settled) {
      saved.status = 'done';
      if (transfer.round === 1) this.cfg.anki?.enqueue(transferCard(saved, owner));
      // Right, with nothing to look at: straight on.
      if (result.verdict === 'carried' && !result.note && loose(result.suggestion) === loose(answer)) this.proceed(s, r, transfer);
    }
    return this.commit(s);
  }
  hint(item, level = item.hint_level + 1) {
    item.hint_level = Math.min(level, HINTS.length);
    item.hints = HINTS.slice(0, item.hint_level).map(line => line(item));
  }
  help(body) {
    const { s, transfer, item, owner } = this.target(body);
    check(item.status === 'open', '这道题已经做完了。', 409);
    if (item.hint_level >= HINTS.length) return this.board.public(s);
    this.hint(item); this.event(owner, transfer, item, { hint: true });
    return this.commit(s);
  }
  continue(body) {
    const { s, r, transfer, item } = this.target(body);
    check(item.status === 'done', '先答完这道题。', 409);
    this.proceed(s, r, transfer); return this.commit(s);
  }
  // Leaves the rest of this round for another time; what was answered stays recorded.
  skip(body) {
    const { s, r, transfer, item, owner } = this.target(body);
    for (const left of transfer.items.slice(transfer.index)) if (left.status === 'open') left.status = 'skipped';
    this.event(owner, transfer, item, { skipped: true });
    transfer.index = transfer.items.length - 1; this.proceed(s, r, transfer);
    return this.commit(s);
  }
  proceed(s, r, transfer) {
    transfer.index++;
    if (transfer.index < transfer.items.length) return;
    transfer.index = transfer.items.length - 1; transfer.status = 'done'; transfer.finished_at = now();
    if (transfer.round === 1) this.board.finishRound(s, r, transfer.reason || 'manual');
  }
}
