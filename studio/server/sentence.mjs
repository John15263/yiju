import { randomUUID } from 'node:crypto';
import { check, fields, id, oneOf, revision, text } from './validation.mjs';
import { prepareCloze, slotsOf, sentenceFrom } from './cloze.mjs';
import { validateOutline, unitDetails } from './expression.mjs';
import { phraseState, beginPhrases, learnedSummary } from './phrase-material.mjs';
import { makeQuiz } from './quiz.mjs';
import { clozeCard } from './anki.mjs';

const now = () => new Date().toISOString();
const empty = () => ({ revision: 0, active_id: null, rounds: [], commands: {}, client_view: null });

export function validateMaterial(p) {
  fields(p, ['meaning', 'language', 'reference', 'keywords', 'frame', 'explanation', 'origin'], ['meaning', 'language', 'reference', 'keywords', 'frame', 'explanation', 'origin']);
  text(p.meaning, 2000); oneOf(p.language, ['en', 'ja']); text(p.reference, 2000); text(p.frame, 2000); text(p.explanation, 4000);
  check(Array.isArray(p.keywords) && p.keywords.length > 0 && p.keywords.length <= 12, 'Supply 1–12 keywords');
  p.keywords.forEach(k => text(k, 200)); oneOf(p.origin, ['user_meaning', 'demo']);
  return structuredClone(p);
}

// A separate board keeps the original pack sessions and Jev contracts intact.
export class SentenceBoard {
  constructor(store, publish = () => {}) {
    this.store = store; this.publish = publish;
    store.db.exec('CREATE TABLE IF NOT EXISTS sentence_board (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  }
  read() {
    const row = this.store.db.prepare('SELECT body FROM sentence_board WHERE id=1').get();
    return row ? JSON.parse(row.body) : empty();
  }
  save(s) {
    this.store.db.prepare('INSERT INTO sentence_board VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(s));
  }
  public(s) {
    const active = s.rounds.find(r => r.id === s.active_id) || null;
    const collection = s.collections?.find(c => c.id === active?.collection_id);
    const units = collection?.round_ids.map((id, index) => {
      const r = active.unit.index === index ? active : s.rounds.find(r => r.id === id);
      return { id: r.id, index, meaning: r.meaning, reference: r.reference, stage: r.stage,
        role: r.unit.role, purpose: r.unit.purpose, connection: r.unit.connection };
    });
    const completed = s.completion?.next_round_id && s.completion.next_round_id === active?.id ? s.rounds.find(r => r.id === s.completion.round_id) : null;
    const attempt = completed?.attempts.at(-1);
    return { revision: s.revision, active,
      completion: completed ? { ...s.completion, unit_index: completed.unit.index, text: attempt?.text || '',
        feedback: completed.feedback.findLast(f => f.attempt_id === attempt?.id) || null } : null,
      collection: collection ? { id: collection.id, outline: collection.outline, units, active_index: active.unit.index } : null,
      history: s.rounds.map(r => ({ id: r.id, meaning: r.meaning, language: r.language, origin: r.origin, stage: r.stage,
        ...(r.unit ? { collection_id: r.collection_id, unit_index: r.unit.index } : {}) })),
      preparation: s.preparation || null, client_view: s.client_view, updated_at: s.updated_at || null };
  }
  get() { return this.public(this.read()); }
  // Finish and select the next unit in the same saved revision; never reset its existing work.
  finishRound(s, r, reason) {
    check(s.active_id === r.id && r.stage === 'review', '先完成一次表达和反馈。', 409);
    r.stage = 'complete';
    const collection = s.collections?.find(c => c.id === r.collection_id);
    const index = collection?.round_ids.indexOf(r.id) ?? -1;
    const nextID = index >= 0 ? collection.round_ids[index + 1] : null;
    s.completion = { round_id: r.id, next_round_id: nextID || null, reason };
    if (nextID) {
      s.active_id = nextID;
      const next = s.rounds.find(r => r.id === nextID);
      // A fresh unit opens on its first chunk, which is studied aloud before it is written.
      if (next.stage === 'study') { beginPhrases(next, s.revision + 1); next.updated_at = now(); }
    }
  }
  command(body) {
    fields(body, ['command_id', 'expected_revision', 'type', 'payload'], ['command_id', 'expected_revision', 'type', 'payload']);
    id(body.command_id); text(body.type, 40);
    const s = this.read(), fingerprint = JSON.stringify(body);
    if (Object.hasOwn(s.commands, body.command_id)) {
      check(s.commands[body.command_id].fingerprint === fingerprint, 'Command ID reused', 409);
      return { ...this.public(s), duplicate: true };
    }
    revision(body.expected_revision, s.revision);
    const p = body.payload;
    let r = s.rounds.find(r => r.id === s.active_id);
    const event = (kind, detail = null) => r.support_events.push({ kind, detail, level: r.support_level, at: now(), revision: s.revision + 1 });
    if (['new', 'accept_preparation', 'repeat'].includes(body.type)) {
      const build = (material, segments, provenance, phrases) => {
        const next = { ...validateMaterial(material), id: randomUUID(), stage: 'study', support_level: 3, attempts: [], feedback: [], support_events: [],
          window_start: null, created_at: now(), updated_at: now() };
        if (segments) next.cloze = prepareCloze({ segments }, next);
        if (phrases) next.phrases = phraseState(phrases, next.reference);
        if (provenance) next.preparation = structuredClone(provenance);
        next.support_events.push({ kind: 'reference', detail: null, level: 3, at: now(), revision: s.revision + 1 });
        return next;
      };
      let created;
      if (body.type === 'new') created = [build(p)];
      else if (body.type === 'accept_preparation') {
        fields(p, ['preparation_id'], ['preparation_id']);
        const draft = s.preparation;
        check(draft?.id === p.preparation_id && draft.status === 'ready', '材料已改变，请重新查看预览。', 409);
        const provenance = { provider: 'gemini', model: draft.model, preparation_id: draft.id,
          source: draft.source, focus: draft.focus, confirmed_at: now() };
        if (draft.units) {
          const outline = validateOutline(draft.outline), collectionID = randomUUID();
          check(Array.isArray(draft.units) && draft.units.length >= 1 && draft.units.length <= 12, 'Invalid expression units');
          // Validate every unit before changing history or publishing anything.
          created = draft.units.map((unit, index) => {
            fields(unit, ['material', 'segments', 'phrases', 'role', 'purpose', 'connection', 'source_quotes'], ['material', 'role', 'purpose', 'connection', 'source_quotes']);
            check(unit.segments || unit.phrases, 'Supply phrase material');
            const details = unitDetails(unit, draft.source, draft.focus);
            check(unit.material.language === draft.language, 'Mixed expression languages');
            return { ...build(unit.material, unit.segments, provenance, unit.phrases), collection_id: collectionID, unit: { ...details, index } };
          });
          (s.collections ||= []).push({ id: collectionID, outline, round_ids: created.map(r => r.id), created_at: now() });
          draft.collection_id = collectionID;
        } else created = [build(draft.material, draft.segments, provenance, draft.phrases)]; // Previously saved one-sentence previews.
        Object.assign(draft, { status: 'accepted', round_id: created[0].id });
      } else {
        fields(p, []); check(r && ['review', 'complete'].includes(r.stage), '先完成这一轮反馈再重新练习。', 409);
        const material = Object.fromEntries(['meaning', 'language', 'reference', 'keywords', 'frame', 'explanation', 'origin'].map(k => [k, r[k]]));
        const next = { ...build(material, r.cloze?.segments, r.preparation, r.phrases?.items), repeated_from: r.id };
        // Practising the same sentence again does not unlearn it; each chunk's study record carries over.
        r.phrases?.inputs?.forEach((input, i) => { if (input.learn && next.phrases?.inputs[i]) next.phrases.inputs[i].learn = structuredClone(input.learn); });
        if (r.unit) {
          next.collection_id = r.collection_id; next.unit = structuredClone(r.unit);
          s.collections.find(c => c.id === r.collection_id).round_ids[r.unit.index] = next.id;
        }
        created = [next];
      }
      s.rounds.push(...created); r = created[0]; s.active_id = r.id; s.completion = null;
      if (body.type !== 'new') beginPhrases(r, s.revision + 1);
    } else if (body.type === 'select') {
      fields(p, ['id'], ['id']); id(p.id); r = s.rounds.find(r => r.id === p.id);
      check(r, 'Sentence not found', 404); s.active_id = r.id; s.completion = null;
    } else {
      check(r, '先准备一句练习。', 409);
      check(r.stage !== 'paused' || body.type === 'resume', '练习已暂停，请先继续。', 409);
      switch (body.type) {
        case 'start_phrases':
          fields(p, []); check(['study', 'practice', 'cloze', 'review', 'complete'].includes(r.stage), '当前不能开始短语试写。', 409);
          beginPhrases(r, s.revision + 1); break;
        case 'prepare_cloze':
          check(!r.cloze, 'This sentence already has blanks; create a new sentence to change the exercise.', 409);
          r.cloze = prepareCloze(p, r); break;
        case 'start_cloze':
          fields(p, []); check(r.cloze, '先准备填空材料。', 409);
          check(['study', 'practice', 'phrases', 'review', 'complete'].includes(r.stage), '当前不能开始填空。', 409);
          r.stage = 'cloze'; r.support_level = 0; r.window_start = r.support_events.length;
          event('cloze_scaffold', { scaffold: r.cloze.segments.map(s => typeof s === 'string' ? s : '[空]').join(''), hints: Object.fromEntries(slotsOf(r).map(slot => [slot.id, r.cloze.inputs[slot.id].hint_level])) }); break;
        case 'cloze_submit': {
          fields(p, ['source']); check(r.stage === 'cloze', '当前不是填空练习。', 409);
          check(slotsOf(r).every(slot => r.cloze.inputs[slot.id].text.trim()), '先填完所有空格再提交。');
          r.attempts.push({ id: randomUUID(), text: sentenceFrom(r), source: oneOf(p.source || 'typed_original', ['typed_original', 'simulation']), at: now(),
            support_level: 2, support_events: structuredClone(r.support_events.slice(r.window_start)), previous_support_count: r.window_start,
            evidence_scope: 'prompted_cloze', cloze: structuredClone(r.cloze), learned: learnedSummary(r),
            note: '在给定句子结构中填空，不等于独立生成整句。' });
          r.stage = 'awaiting_feedback'; break;
        }
        case 'practice':
          fields(p, []);
          check(['study', 'review', 'complete', 'cloze', 'phrases'].includes(r.stage), '当前已有一次表达正在进行。', 409);
          if (r.stage !== 'phrases') r.window_start = r.support_events.length;
          r.stage = 'practice'; r.support_level = 0; event('practice_start'); break;
        case 'support':
          fields(p, ['level'], ['level']);
          check(r.stage === 'practice', '请先选择“我来试写”。', 409);
          check(Number.isInteger(p.level) && p.level >= 0 && p.level <= 3, 'Invalid support level');
          r.support_level = p.level; event('visual_support'); break;
        case 'record_support':
          fields(p, ['text'], ['text']); text(p.text, 4000);
          event('codex_chat_support', p.text); break;
        case 'study':
          fields(p, []); check(r.stage !== 'awaiting_feedback', '先处理已经提交的表达。', 409);
          r.stage = 'study'; r.support_level = 3; r.window_start = null; event('reference'); break;
        case 'attempt': {
          fields(p, ['text', 'source', 'parent_attempt_id'], ['text', 'source']);
          check(r.stage === 'practice', '先开始一次表达，再保存实际回答。', 409);
          text(p.text, 4000); oneOf(p.source, ['typed_original', 'user_revision', 'voice_transcript', 'simulation']);
          if (p.parent_attempt_id != null) check(r.attempts.some(a => a.id === p.parent_attempt_id), 'Unknown parent attempt');
          r.attempts.push({ id: randomUUID(), ...p, at: now(), support_level: r.support_level,
            support_events: structuredClone(r.support_events.slice(r.window_start)),
            previous_support_count: r.window_start, learned: learnedSummary(r),
            note: '先前看过示范；本次记录不证明长期掌握。' });
          r.stage = 'awaiting_feedback'; r.support_level = 0; break;
        }
        case 'feedback':
          fields(p, ['attempt_id', 'message', 'suggestion'], ['attempt_id', 'message']);
          check(r.stage === 'awaiting_feedback', '没有等待反馈的表达。', 409);
          check(p.attempt_id === r.attempts.at(-1)?.id, 'Feedback must address the latest attempt', 409);
          text(p.message, 4000); if (p.suggestion !== undefined) text(p.suggestion, 2000);
          r.feedback.push({ ...p, source: 'ai_feedback', at: now() }); r.stage = 'review';
          event('feedback', { message: p.message, suggestion: p.suggestion || null }); break;
        case 'complete': {
          fields(p, []);
          // Done with the feedback: what it corrected is filled back in from memory before moving on.
          const attempt = r.attempts.at(-1), feedback = r.feedback.findLast(f => f.attempt_id === attempt?.id);
          check(!(attempt && r.quiz?.attempt_id === attempt.id && r.quiz.status === 'open'), '先做完这道改错小测。', 409);
          if (r.stage === 'review' && feedback && r.quiz?.attempt_id !== attempt.id) {
            const quiz = makeQuiz({ kind: 'sentence', attemptID: attempt.id, text: attempt.text, corrected: feedback.suggestion,
              meaning: r.meaning, changes: feedback.changes || [], language: r.language });
            if (quiz) { r.quiz = quiz; this.anki?.enqueue(clozeCard(quiz, r)); break; }
          }
          this.finishRound(s, r, 'manual'); break;
        }
        case 'pause':
          fields(p, []); r.resume_stage = r.stage; r.stage = 'paused'; break;
        case 'resume':
          fields(p, []); check(r.stage === 'paused', '当前没有暂停。', 409); r.stage = r.resume_stage; delete r.resume_stage; break;
        default: check(false, 'Unknown sentence command');
      }
    }
    s.revision++; s.updated_at = now(); r.updated_at = s.updated_at;
    s.commands[body.command_id] = { fingerprint, revision: s.revision };
    this.save(s); const result = this.public(s); this.publish(result); return result;
  }
  ack(body) {
    fields(body, ['rendered_revision'], ['rendered_revision']);
    const s = this.read();
    check(Number.isInteger(body.rendered_revision) && body.rendered_revision >= 0 && body.rendered_revision <= s.revision, 'Invalid rendered_revision');
    if (body.rendered_revision > (s.client_view?.rendered_revision ?? -1)) {
      s.client_view = { rendered_revision: body.rendered_revision, at: now() }; this.save(s);
    }
    return s.client_view;
  }
}
