import { check, fields, id, oneOf, text } from './validation.mjs';
import { textJSON, textError, textConfigured, textKeyMissing } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { validateMaterial } from './sentence.mjs';
import { prepareCloze } from './cloze.mjs';
import { validateOutline, unitDetails, outlineKeys } from './expression.mjs';
import { phraseSchema, validatePhrases } from './phrase-material.mjs';

const now = () => new Date().toISOString();
const string = { type: 'string' }, strings = { type: 'array', items: string };
const unitProperties = {
  meaning: string, keywords: strings, frame: string, explanation: string,
  role: { type: 'string', enum: ['core', 'support', 'mixed'] }, purpose: string, connection: string, source_quotes: strings,
  reference: string, phrases: phraseSchema,
};
const schema = { type: 'object', properties: {
  outline: { type: 'object', properties: { summary: string, ...Object.fromEntries(outlineKeys.map(k => [k, strings])) }, required: ['summary', ...outlineKeys], additionalProperties: false },
  units: { type: 'array', items: { type: 'object', properties: unitProperties, required: Object.keys(unitProperties), additionalProperties: false } },
}, required: ['outline', 'units'], additionalProperties: false };

export const callPreparation = (packet, cfg, request = fetch) => textJSON(packet, { ...cfg, geminiTimeout: cfg.geminiPreparationTimeout ?? cfg.geminiTimeout }, { instructions: prompt('sentence-prepare'), schema, tokens: 16384, limit: 100000, purpose: 'prepare' }, request);
export function preparedExpression(value, packet) {
  fields(value, ['outline', 'units'], ['outline', 'units']);
  const outline = validateOutline(value.outline);
  check(Array.isArray(value.units) && value.units.length >= 1 && value.units.length <= 12, 'Supply 1–12 expression units');
  const units = value.units.map(unit => {
    const teachingKeys = ['meaning', 'keywords', 'frame', 'explanation', ...(Object.hasOwn(unit, 'segments') ? ['segments'] : ['reference', 'phrases'])];
    const keys = [...teachingKeys, 'role', 'purpose', 'connection', 'source_quotes'];
    fields(unit, keys, keys);
    const teaching = Object.fromEntries(teachingKeys.map(k => [k, unit[k]]));
    return { ...preparedMaterial(teaching, packet.language), ...unitDetails(unit, packet.source, packet.focus) };
  });
  check(units.some(u => u.role !== 'support'), 'Supply at least one core expression');
  return { outline, units };
}

export function preparedMaterial(value, language) {
  if (!Object.hasOwn(value, 'segments')) {
    fields(value, ['meaning', 'keywords', 'frame', 'explanation', 'reference', 'phrases'], ['meaning', 'keywords', 'frame', 'explanation', 'reference', 'phrases']);
    const material = validateMaterial({ ...Object.fromEntries(['meaning', 'keywords', 'frame', 'explanation', 'reference'].map(k => [k, value[k]])), language, origin: 'user_meaning' });
    return { material, phrases: validatePhrases(value.phrases, material.reference) };
  }
  fields(value, ['meaning', 'keywords', 'frame', 'explanation', 'segments'], ['meaning', 'keywords', 'frame', 'explanation', 'segments']);
  check(Array.isArray(value.segments) && value.segments.length <= 41, 'Invalid generated segments');
  let slot = 0;
  const segments = value.segments.map(p => {
    fields(p, ['text', 'blank', 'hints', 'role'], ['text', 'blank', 'hints', 'role']);
    text(p.text, 2000, true); check(p.text.length > 0, 'Empty generated segment'); check(typeof p.blank === 'boolean' && Array.isArray(p.hints), 'Invalid generated segment');
    if (!p.blank) { check(!p.hints.length && p.role === '', 'Invalid fixed segment'); return p.text; }
    check(p.text === p.text.trim(), 'Blank must not contain boundary whitespace');
    return { id: `blank-${++slot}`, answers: [p.text], hints: p.hints, role: p.role };
  });
  check(slot <= 12, 'Too many generated blanks');
  const material = validateMaterial({ meaning: value.meaning, language, reference: value.segments.map(p => p.text).join(''),
    keywords: value.keywords, frame: value.frame, explanation: value.explanation, origin: 'user_meaning' });
  prepareCloze({ segments }, material);
  return { material, segments };
}

// One pending proposal, separate from the current exercise. Accepting is an atomic board command.
export class Preparations {
  constructor(board, cfg, infer = callPreparation) {
    this.board = board; this.cfg = cfg; this.infer = infer; this.pending = null;
    const s = board.read();
    if (s.preparation?.status === 'pending') {
      Object.assign(s.preparation, { status: 'error', message: '服务重启，生成已中断。原文已保存，可以重试。' }); this.commit(s);
    }
  }
  commit(s) {
    s.revision++; s.updated_at = now(); this.board.save(s);
    const state = this.board.public(s); this.board.publish(state); return state;
  }
  start(body) {
    fields(body, ['request_id', 'source', 'language', 'focus'], ['request_id', 'source', 'language']);
    id(body.request_id); text(body.source, 20000); oneOf(body.language, ['en', 'ja']); if (body.focus !== undefined) text(body.focus, 2000, true);
    const packet = { source: body.source, language: body.language, focus: body.focus || '' };
    const s = this.board.read();
    if (s.preparation?.id === body.request_id) {
      check(JSON.stringify(packet) === JSON.stringify({ source: s.preparation.source, language: s.preparation.language, focus: s.preparation.focus }), 'Request ID reused', 409);
      return this.board.public(s);
    }
    check(!this.pending, '正在整理这段想法，请等待本次结果。', 429);
    check(textConfigured(this.cfg), textKeyMissing(this.cfg), 503);
    s.preparation = { id: body.request_id, ...packet, status: 'pending', provider: this.cfg.textProvider, started_at: now() }; this.commit(s);
    this.pending = this.run(body.request_id, packet).finally(() => { this.pending = null; });
    return this.board.get();
  }
  async run(requestID, packet) {
    let result, model, failure;
    // A reply that arrived but failed the checks is asked for once more: a provider without a strict schema
    // (DeepSeek) now and then words a chunk differently from its sentence, and a second answer usually holds.
    // A refused key, an empty balance or a dead connection is not asked again.
    for (let tries = 2; tries-- && !result;) {
      try {
        const response = await this.infer(packet, this.cfg);
        fields(response, ['value', 'model'], ['value', 'model']); text(response.model, 100);
        result = preparedExpression(response.value, packet); model = response.model; failure = null;
      } catch (e) {
        failure = `${textError(e, this.cfg)} 原文已保存。`;
        if (/^(Gemini|DeepSeek|Qwen) (HTTP|network)/.test(e.message)) break;
      }
    }
    const s = this.board.read();
    if (s.preparation?.id !== requestID || s.preparation.status !== 'pending') return;
    Object.assign(s.preparation, failure ? { status: 'error', message: failure } : { status: 'ready', ...result, model });
    s.preparation.finished_at = now(); this.commit(s);
  }
}
