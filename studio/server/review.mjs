import { changeRows, check, fields, id, text } from './validation.mjs';
import { textJSON, textError, textConfigured, textKeyMissing, textModel, textName } from './llm.mjs';
import { prompt } from './prompts.mjs';

const now = () => new Date().toISOString();
const schema = {
  type: 'object', properties: { message: { type: 'string' }, suggestion: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'why'],
      properties: { from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' } } } } },
  required: ['message', 'suggestion', 'changes', 'score'], additionalProperties: false,
};
const validateScore = score => check(Number.isInteger(score) && score >= 0 && score <= 100, 'Invalid Gemini score');

export async function callGemini(packet, cfg, request = fetch) {
  const { value: result, model } = await textJSON(packet, cfg, { instructions: prompt('sentence-review'), schema, purpose: 'review' }, request);
  fields(result, ['message', 'suggestion', 'changes', 'score'], ['message', 'suggestion', 'score']);
  text(result.message, 4000); text(result.suggestion, 2000); validateScore(result.score);
  return { ...result, changes: changeRows(result.changes), model };
}

const errorMessage = error => `${textError(error)} 答案已保存。`;

export class Reviews {
  constructor(board, cfg, infer = callGemini) {
    this.board = board; this.cfg = cfg; this.infer = infer; this.pending = new Map();
    const s = board.read(); let changed = false;
    for (const r of s.rounds) for (const review of r.reviews || []) if (review.status === 'pending') {
      Object.assign(review, { status: 'error', finished_at: now(), message: '服务重启，审查已中断。答案已保存，可以重试。' }); changed = true;
    }
    if (changed) this.commit(s);
  }
  commit(s) {
    s.revision++; s.updated_at = now(); this.board.save(s);
    const state = this.board.public(s); this.board.publish(state); return state;
  }
  start(body) {
    fields(body, ['round_id', 'attempt_id', 'retry'], ['round_id', 'attempt_id']); id(body.round_id); id(body.attempt_id);
    if (body.retry !== undefined) check(typeof body.retry === 'boolean', 'Invalid retry');
    const s = this.board.read(), r = s.rounds.find(r => r.id === body.round_id), attempt = r?.attempts.at(-1);
    check(r && s.active_id === r.id && attempt?.id === body.attempt_id, '表达已切换，请读取最新状态。', 409);
    const previous = r.reviews?.findLast(x => x.attempt_id === attempt.id);
    if (previous && (['pending', 'completed'].includes(previous.status) || !body.retry)) return this.board.public(s);
    check(r.stage === 'awaiting_feedback', '当前没有等待审查的表达。', 409);
    check(textConfigured(this.cfg), textKeyMissing(this.cfg), 503);
    check(this.pending.size < 2, `${textName(this.cfg)} 正在检查其他表达，请稍后再试。`, 429);
    const review = { id: crypto.randomUUID(), attempt_id: attempt.id, provider: this.cfg.textProvider, model: textModel(this.cfg), status: 'pending', started_at: now() };
    (r.reviews ||= []).push(review); this.commit(s);
    const packet = { language: r.language, intended_meaning: r.meaning, reference: r.reference, learner_sentence: attempt.text,
      exercise_type: attempt.evidence_scope || 'sentence_practice',
      support_level: Math.max(attempt.support_level, ...attempt.support_events.map(e => e.level)),
    };
    const collection = s.collections?.find(c => c.id === r.collection_id);
    if (collection) {
      const at = index => s.rounds.find(x => x.id === collection.round_ids[index])?.meaning || '';
      packet.expression_context = { summary: collection.outline.summary, core_logic: collection.outline.core_logic,
        supporting_logic: collection.outline.supporting_logic, unit_purpose: r.unit.purpose, connection: r.unit.connection,
        previous_meaning: at(r.unit.index - 1), next_meaning: at(r.unit.index + 1) };
    }
    const promise = this.run(r.id, review.id, packet).finally(() => this.pending.delete(review.id));
    this.pending.set(review.id, promise);
    return this.board.get();
  }
  async run(roundID, reviewID, packet) {
    let result, failure;
    try {
      result = await this.infer(packet, this.cfg);
      fields(result, ['message', 'suggestion', 'changes', 'score', 'model'], ['message', 'suggestion', 'score', 'model']);
      text(result.message, 4000); text(result.suggestion, 2000); text(result.model, 100); validateScore(result.score);
    } catch (e) { failure = errorMessage(e); }
    const s = this.board.read(), r = s.rounds.find(r => r.id === roundID), review = r?.reviews.find(x => x.id === reviewID);
    if (!review || review.status !== 'pending') return;
    review.finished_at = now();
    if (s.active_id !== roundID || r.stage !== 'awaiting_feedback' || r.attempts.at(-1)?.id !== review.attempt_id) {
      review.status = 'cancelled'; review.message = '练习状态已改变，本次返回未应用。';
    } else if (failure) { review.status = 'error'; review.message = failure; }
    else {
      review.status = 'completed'; review.model = result.model; review.score = result.score;
      const feedback = { attempt_id: review.attempt_id, message: result.message, suggestion: result.suggestion, changes: changeRows(result.changes), score: result.score, source: 'ai_feedback', provider: review.provider, model: result.model, at: now() };
      r.feedback.push(feedback); r.stage = 'review';
      r.support_events.push({ kind: 'feedback', detail: { message: result.message, suggestion: result.suggestion, score: result.score, provider: review.provider }, level: r.support_level, at: now(), revision: s.revision + 1 });
      if (result.score > 95) this.board.finishRound(s, r, 'score');
    }
    r.updated_at = now(); this.commit(s);
  }
}
