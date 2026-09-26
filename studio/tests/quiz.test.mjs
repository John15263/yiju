import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Phrases } from '../server/phrases.mjs';
import { phraseState } from '../server/phrase-material.mjs';
import { Quizzes, makeQuiz } from '../server/quiz.mjs';
import { Anki, clozeCard } from '../server/anki.mjs';

const items = [
  { meaning: '我喜欢做饭', reference: 'I enjoy cooking,', hints: ['喜欢做某事', 'I e…'] },
  { meaning: '但我也想保护好双手', reference: 'but I also want to protect my hands.', hints: ['转折', 'but I a…'] },
];
const material = { meaning: '我喜欢做饭，但也想保护双手。', language: 'en', reference: items.map(p => p.reference).join(' '), keywords: ['enjoy'], frame: '___', explanation: '-', origin: 'demo' };

function setup(t, judge = async () => assert.fail('no judge needed')) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store), cards = [];
  const cfg = { geminiKey: 'test', anki: { enqueue: card => cards.push(card) } };
  board.anki = cfg.anki;
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  cmd('new', material);
  const s = board.read(); s.rounds[0].phrases = phraseState(items, material.reference);
  for (const input of s.rounds[0].phrases.inputs) input.learn = { sessions: 1, seconds: 1, skipped: false, started_at: 'x', finished_at: 'x' };
  board.save(s);
  cmd('start_phrases');
  const phrases = new Phrases(board, cfg), quizzes = new Quizzes(board, cfg, phrases, judge);
  const at = () => { const r = board.get().active; return { round_id: r.id, window_start: r.window_start, index: r.phrases.index }; };
  // A chunk held back with a correction, as the check leaves it.
  const correct = (text, suggestion) => {
    const raw = board.read(), input = raw.rounds[0].phrases.inputs[raw.rounds[0].phrases.index];
    Object.assign(input, { text, result: { id: 'c1', text, verdict: 'adjust' }, attempts: [{ id: 'c1', text, verdict: 'adjust' }],
      note: { status: 'adjust', text: 'enjoy 后面接 -ing。', suggestion, changes: [{ from: 'to cook', to: 'cooking', why: 'enjoy 后面接 -ing' }], attempt_id: 'c1' } });
    board.save(raw);
  };
  const quizOf = () => { const r = board.get().active; return { round_id: r.id, quiz_id: (r.phrases?.inputs?.[r.phrases.index]?.quiz || r.quiz).id }; };
  return { board, cmd, phrases, quizzes, at, correct, quizOf, cards };
}

test('the corrected words are filled back in before moving on, and a right answer goes straight on', async t => {
  const { board, phrases, quizzes, at, correct, quizOf, cards } = setup(t);
  correct('I enjoy to cook,', 'I enjoy cooking,');
  phrases.next(at());
  let r = board.get().active;
  assert.equal(r.phrases.step, 'quiz'); assert.equal(r.phrases.index, 0);
  assert.equal(cards.length, 1, 'the mistake is filed for Anki as soon as it is known');
  assert.equal(cards[0].text, 'I enjoy {{c1::cooking}},');
  assert.match(cards[0].extra, /当时写的：I enjoy to cook,/); assert.match(cards[0].extra, /enjoy 后面接 -ing/);

  await quizzes.answer({ ...quizOf(), answers: ['Cooking'] });
  r = board.get().active;
  assert.equal(r.phrases.index, 1, 'right, locally and for free: on to the next chunk');
  assert.equal(r.phrases.inputs[0].quiz.passed, true);
  assert.equal(r.support_events.findLast(e => e.kind === 'quiz').detail.results[0], true);
});

test('a wrong answer gets one more try; then the answer is shown and Command + Enter goes on', async t => {
  let judged = 0;
  const { board, phrases, quizzes, at, correct, quizOf } = setup(t, async packet => {
    judged++; assert.equal(packet.sentence, 'I enjoy [1],'); assert.equal(packet.items[0].expected, 'cooking');
    return { value: { results: [{ ok: false, note: '这里要用 -ing 形式。' }] }, model: 'flash' };
  });
  correct('I enjoy to cook,', 'I enjoy cooking,');
  phrases.next(at());
  await quizzes.answer({ ...quizOf(), answers: ['to cook'] });
  let quiz = board.get().active.phrases.inputs[0].quiz;
  assert.equal(quiz.status, 'open'); assert.equal(quiz.tries, 1); assert.equal(quiz.results[0].note, '这里要用 -ing 形式。');
  await quizzes.answer({ ...quizOf(), answers: ['cook'] });
  quiz = board.get().active.phrases.inputs[0].quiz;
  assert.equal(quiz.status, 'done'); assert.equal(quiz.passed, false); assert.equal(judged, 2);
  assert.equal(board.get().active.phrases.index, 0, 'waits so the answer can be read');
  quizzes.continue(quizOf());
  const r = board.get().active;
  assert.equal(r.phrases.index, 1);
  assert.equal(r.support_events.findLast(e => e.kind === 'phrase_expression').detail.source, 'after_correction');
});

test('another wording that works is accepted by Gemini; without Gemini a different wording is not', async t => {
  const accepting = setup(t, async () => ({ value: { results: [{ ok: true, note: '' }] }, model: 'flash' }));
  accepting.correct('I enjoy to cook,', 'I enjoy cooking,');
  accepting.phrases.next(accepting.at());
  await accepting.quizzes.answer({ ...accepting.quizOf(), answers: ['home cooking'] });
  assert.equal(accepting.board.get().active.phrases.index, 1);

  const offline = setup(t, async () => { throw new Error('Gemini HTTP 503'); });
  offline.correct('I enjoy to cook,', 'I enjoy cooking,');
  offline.phrases.next(offline.at());
  await offline.quizzes.answer({ ...offline.quizOf(), answers: ['home cooking'] });
  const quiz = offline.board.get().active.phrases.inputs[0].quiz;
  assert.equal(quiz.results[0].ok, false); assert.match(quiz.results[0].note, /没能请 Gemini 判定/);
});

test('the sentence\'s feedback is filled back in before the sentence is done; punctuation alone is not', async t => {
  const { board, cmd, quizzes, quizOf, cards } = setup(t);
  cmd('practice');
  let attempt = cmd('attempt', { text: 'I enjoy to cook, but I want protect my hands.', source: 'simulation' }).active.attempts.at(-1);
  cmd('feedback', { attempt_id: attempt.id, message: '两处。', suggestion: 'I enjoy cooking, but I want to protect my hands.' });
  cmd('complete');
  let r = board.get().active;
  assert.equal(r.stage, 'review'); assert.deepEqual(r.quiz.answers, ['cooking', 'to'], 'only the word that was added is left blank');
  assert.equal(cards.at(-1).text, 'I enjoy {{c1::cooking}}, but I want {{c2::to}} protect my hands.');
  assert.throws(() => cmd('complete'), /先做完这道改错小测/, 'there is no way round it');
  await quizzes.answer({ ...quizOf(), answers: ['cooking', 'to'] });
  assert.equal(board.get().active.stage, 'complete');

  const again = setup(t);
  again.cmd('practice');
  attempt = again.cmd('attempt', { text: 'i enjoy cooking', source: 'simulation' }).active.attempts.at(-1);
  again.cmd('feedback', { attempt_id: attempt.id, message: '成立。', suggestion: 'I enjoy cooking.' });
  again.cmd('complete');
  r = again.board.get().active;
  assert.equal(r.stage, 'complete', 'only case and punctuation changed: nothing to fill in');
  assert.equal(again.cards.length, 0);
});

test('cards wait for Anki and go over once it answers; a card it already has counts as sent', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let up = false; const calls = [];
  const request = async (url, options) => {
    if (!up) throw new TypeError('fetch failed');
    const { action, params } = JSON.parse(options.body); calls.push({ action, params });
    const result = { modelNames: ['Basic', 'Manga Cloze Model with Audio'], createModel: {}, createDeck: 1 }[action];
    if (action === 'addNote') return { json: async () => params.note.fields.Text.includes('dup') ? { result: null, error: 'cannot create note because it is a duplicate' } : { result: 42, error: null } };
    return { json: async () => ({ result, error: null }) };
  };
  const anki = new Anki(store, { ankiUrl: 'http://127.0.0.1:8766', ankiDeck: '一句::改错', ankiPush: true }, request);
  assert.equal(new Anki(store, { ankiUrl: 'x', ankiDeck: 'd' }, () => assert.fail('never pushed')).live, false, 'only the practice server pushes');
  const quiz = makeQuiz({ kind: 'chunk', attemptID: 'a', text: 'I enjoy to cook,', corrected: 'I enjoy cooking,', meaning: '我喜欢做饭',
    changes: [{ from: 'to cook', to: 'cooking', why: 'enjoy 后面接 -ing' }], language: 'en' });
  anki.enqueue(clozeCard(quiz, { id: 'r1', language: 'en' }));
  await anki.flush();
  assert.equal(anki.status().pending, 1); assert.match(anki.status().last_error, /连不上 Anki/);

  up = true;
  anki.enqueue({ text: 'a {{c1::dup}}', extra: '', tags: [], quiz_id: 'q-dup' });
  await anki.flush();
  const status = anki.status();
  assert.equal(status.sent, 2); assert.equal(status.pending, 0); assert.equal(status.last_error, '');
  const added = calls.find(c => c.action === 'addNote').params.note;
  assert.equal(added.deckName, '一句::改错');
  assert.equal(added.modelName, '一句 · 改错填空', 'its own note type, never one of the learner\'s custom cloze templates');
  const created = calls.find(c => c.action === 'createModel').params;
  assert.equal(created.isCloze, true); assert.deepEqual(created.inOrderFields, ['Text', 'Extra']);
  assert.match(created.cardTemplates[0].Front, /\{\{type:cloze:Text\}\}/, 'the blank is typed in when reviewing, as in practice');
  assert.equal(added.fields.Text, 'I enjoy {{c1::cooking}},'); assert.deepEqual(added.tags, ['一句', '英语', '短语']);
});
