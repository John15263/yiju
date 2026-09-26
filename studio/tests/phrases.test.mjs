import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Phrases, phraseQuestion, readOrder } from '../server/phrases.mjs';
import { phraseState, validatePhrases } from '../server/phrase-material.mjs';
import { preparedExpression } from '../server/preparation.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';

const items = [
  { meaning: '我喜欢做饭', reference: 'I enjoy cooking,', hints: ['喜欢做某事，动词后接 doing', 'I e…'] },
  { meaning: '但我也想保护好双手', reference: 'but I also want to protect my hands.', hints: ['转折，想做某事用不定式', 'but I a…'] },
];
const material = { meaning: '我喜欢做饭，但也想保护双手。', language: 'en', reference: items.map(p => p.reference).join(' '), keywords: ['enjoy'], frame: 'I ___, but I also ___.', explanation: '测试', origin: 'demo' };
const cfg = config({ GEMINI_API_KEY: 'mock-secret', TYPESAFE_API_KEY: 'mock-secret' });
const verdict = (choice = 'accepted') => ({ model: 'jev-test', answers: { next_cue: { type: 'choice', choice, confidence: .99,
  probabilities: Object.fromEntries(Object.keys(phraseQuestion.criteria).map(k => [k, k === choice ? .99 : .0025])) } } });
// gate defaults to 'jev' here because most of these cases describe the classifier path.
// The Gemini gate is production's default and is covered explicitly at the end of this file.
// Chunks studied in an earlier run go straight to writing, which is what the judging cases exercise.
const studied = p => { for (const input of p.inputs) input.learn = { sessions: 1, seconds: 60, skipped: false, started_at: 'earlier', finished_at: 'earlier' }; return p; };
function setup(t, infer = async () => verdict(), prepared = true, prepare = async () => ({ value: { items }, model: 'gemini-test' }), note = null, gate = 'jev', hint = null, learned = true) {
  const noteCalls = [];
  const store = new Store(':memory:'); t.after(() => store.close()); const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  cmd('new', material);
  if (prepared) { const s = board.read(); s.rounds[0].phrases = phraseState(items, material.reference); if (learned) studied(s.rounds[0].phrases); board.save(s); }
  const noteFn = note || (async packet => { noteCalls.push(packet); return { value: { status: 'ok', note: '这样写就可以。' }, model: 'gemini-test' }; });
  const hintFn = hint || (async () => { throw new Error('no live hint in this case'); });
  cmd('start_phrases'); const phrases = new Phrases(board, { ...cfg, phraseGate: gate }, prepare, infer, noteFn, hintFn);
  const request = (extra = {}) => ({ round_id: board.get().active.id, window_start: board.get().active.window_start, index: board.get().active.phrases?.index, ...extra });
  return { store, board, cmd, phrases, request, noteCalls };
}
const finish = async p => {
  await Promise.all([...p.pending.values(), ...p.generating.values()]);
  await Promise.all([...p.notes]);
};

test('new English and Japanese materials contain complete meaning chunks, not generated blanks', () => {
  for (const [language, chunks] of [['en', items], ['ja', [{ meaning: '做饭我喜欢', reference: '料理は好きですが、', hints: ['话题和转折', 'と…'] }, { meaning: '也想保护双手', reference: '手も大切にしたいです。', hints: ['也，想要', 'ゆ…'] }]]]) {
    const reference = chunks.map(p => p.reference).join(language === 'en' ? ' ' : '');
    const value = { outline: { summary: material.meaning, core_logic: ['爱好与保护'], core_structure: ['转折'], supporting_logic: [], supporting_structure: [], uncertainties: [] },
      units: [{ ...Object.fromEntries(['meaning', 'keywords', 'frame', 'explanation'].map(k => [k, material[k]])), reference, phrases: chunks, role: 'core', purpose: '表达', connection: '', source_quotes: [material.meaning] }] };
    const result = preparedExpression(value, { language, source: material.meaning, focus: '' });
    assert.equal(result.units[0].segments, undefined); assert.equal(result.units[0].phrases.length, 2);
    assert.equal(result.units[0].material.reference, reference);
  }
  assert.throws(() => validatePhrases(items.slice(0,1), material.reference), /complete reference/);
  assert.throws(() => validatePhrases([...items].reverse(), material.reference), /complete reference/);
  assert.throws(() => validatePhrases([{ ...items[0], prompt: 'bad' }], material.reference), /Unknown field/);
});

test('known phrases advance locally; reference assistance does not invent learner answers; final chunk opens whole writing', async t => {
  const { board, cmd, phrases, request } = setup(t, () => assert.fail('no paid check'));
  phrases.check(request({ text: 'I enjoy cooking', request_id: 'first' }));
  assert.equal(board.get().active.phrases.index, 1); assert.equal(board.get().active.attempts.length, 0);
  assert.throws(() => phrases.continue(request({ text: '' })), /先查看参考/);
  await phrases.hint(request({ level: 3 })); phrases.continue(request({ text: '' }));
  let r = board.get().active;
  assert.equal(r.stage, 'practice'); assert.equal(r.phrases.inputs[1].text, ''); assert.equal(r.attempts.length, 0);
  assert.equal(r.phrases.inputs[0].attempts[0].text, 'I enjoy cooking');
  cmd('attempt', { text: 'I like cooking, but I also care about my hands.', source: 'simulation' });
  r = board.get().active; assert.match(r.attempts[0].text, /I like cooking/);
  assert.ok(r.attempts[0].support_events.some(e => e.kind === 'phrase_hint' && e.level === 3));
  assert.ok(r.attempts[0].support_events.some(e => e.kind === 'phrase_expression' && e.detail.source === 'reference_assisted' && e.detail.text === ''));
  cmd('feedback', { attempt_id: r.attempts[0].id, message: '测试反馈' }); cmd('start_phrases');
  r = board.get().active;
  assert.equal(r.phrases.run, 1); assert.equal(r.phrases.inputs[0].text, '');
  assert.equal(r.phrases.inputs[0].attempts[0].text, 'I enjoy cooking'); assert.equal(r.attempts.length, 1);
});

test('Jev accepts alternate chunks using meaning context, coalesces duplicate submissions, and advances once', async t => {
  let calls = 0, packet, resolve;
  const { phrases, request, board } = setup(t, p => { calls++; packet = p; return new Promise(r => resolve = r); });
  const req = request({ text: 'I like home cooking', request_id: 'one' });
  phrases.check(req); phrases.check(req);
  assert.equal(calls, 1); assert.equal(packet.chunk_meaning, items[0].meaning); assert.equal(packet.candidate_text, req.text);
  assert.equal(packet.candidate_sentence, undefined);
  resolve(verdict()); await finish(phrases);
  assert.equal(board.get().active.phrases.index, 1);
  assert.throws(() => phrases.check(req), /当前短语已改变/); assert.equal(calls, 1);
});

test('late accepted checks cannot advance after skipping, pausing, or leaving the round', async t => {
  for (const change of ['skip', 'pause', 'select']) {
    let resolve; const { phrases, request, board, cmd } = setup(t, () => new Promise(r => resolve = r));
    const original = board.get().active.id; phrases.check(request({ text: 'I like cooking', request_id: randomUUID() }));
    if (change === 'skip') cmd('practice');
    if (change === 'pause') cmd('pause');
    if (change === 'select') cmd('new', { ...material, meaning: '另一句话' });
    const before = board.get().active.id;
    resolve(verdict()); await finish(phrases);
    assert.equal(board.get().active.id, before);
    const r = board.read().rounds.find(r => r.id === original);
    assert.equal(r.phrases.index, 0); assert.equal(r.phrases.inputs[0].attempts[0].stale, true);
  }
});

test('uncertain and failed judgments preserve text without auto retries; explicit retry is allowed', async t => {
  let calls = 0;
  const holds = async () => ({ value: { status: 'adjust', note: '这一块再看一眼。' }, model: 'gemini-test' });
  const { phrases, request, board } = setup(t, async () => { calls++; throw new Error('mock-secret'); }, true, undefined, holds);
  phrases.check(request({ text: 'I lik cooking', request_id: 'bad' })); await finish(phrases);
  assert.equal(board.get().active.phrases.inputs[0].result.verdict, 'review');
  assert.equal(board.get().active.phrases.inputs[0].text, 'I lik cooking');
  assert.doesNotMatch(JSON.stringify(board.get()), /mock-secret/);
  phrases.check(request({ text: 'I lik cooking', request_id: 'again' })); await finish(phrases); assert.equal(calls, 1);
  phrases.check(request({ text: 'I lik cooking', request_id: 'retry', retry: true })); await finish(phrases); assert.equal(calls, 2);
});

test('low-confidence accepted responses advance while API failures preserve the current phrase without leaking errors', async t => {
  const cases = [
    ['below_threshold', () => ({ model: 'jev-test', answers: { next_cue: { type: 'choice', choice: 'accepted', confidence: .63,
      probabilities: { accepted: .7, form: .13, meaning: .16, review: .01, spelling: 0 } } } }), /倾向认为这个表达可接受/],
    ['network_or_timeout', () => { throw new Error('Jev network error or timeout'); }, /连接失败或请求超时/],
    ['authentication', () => { throw new Error('Jev HTTP 401'); }, /API 凭据/],
    ['rate_limit', () => { throw new Error('Jev HTTP 429'); }, /额度或请求频率/],
    ['invalid_response', () => ({ model: 'jev-test', answers: {} }), /判断格式不完整/],
    ['provider_error', () => { throw new Error('mock-secret'); }, /未能取得有效/],
  ];
  // With no referee available the gate falls back to Jev alone, which is what these messages describe.
  const noReferee = async () => { throw new Error('no referee'); };
  for (const [reason, infer, message] of cases) {
    const { phrases, request, board } = setup(t, infer, true, undefined, noReferee);
    phrases.check(request({ text: 'I like cooking', request_id: randomUUID() })); await finish(phrases);
    const r = board.get().active, result = r.phrases.inputs[0].result;
    assert.equal(result.reason, reason); assert.match(result.message, message);
    assert.equal(result.verdict, 'review'); assert.equal(r.phrases.index, reason === 'below_threshold' ? 1 : 0);
    assert.equal(result.advanced, reason === 'below_threshold');
    assert.equal(r.phrases.inputs[0].text, 'I like cooking');
    assert.ok(result.latency_ms >= 0); assert.doesNotMatch(JSON.stringify(result), /mock-secret/);
    if (reason === 'below_threshold') { assert.equal(result.choice, 'accepted'); assert.equal(result.probabilities.accepted, .7); }
  }
});

test('only confident substantial errors block; uncertain checks advance through the final phrase without claiming correctness', async t => {
  for (const choice of ['spelling', 'form', 'meaning']) {
    const { phrases, request, board } = setup(t, async () => verdict(choice));
    phrases.check(request({ text: 'test expression', request_id: randomUUID() })); await finish(phrases);
    assert.equal(board.get().active.phrases.index, 0);
    assert.equal(board.get().active.phrases.inputs[0].result.verdict, choice);
    assert.equal(board.get().active.phrases.inputs[0].result.advanced, false);
  }
  const { phrases, request, board } = setup(t, async () => verdict('review'));
  for (const text of ['I like cooking', 'but I want to keep my hands safe']) {
    phrases.check(request({ text, request_id: randomUUID() })); await finish(phrases);
  }
  const r = board.get().active;
  assert.equal(r.stage, 'practice'); assert.equal(r.phrases.index, 2);
  assert.equal(r.attempts.length, 0);
  assert.ok(r.phrases.inputs.every(i => i.completed && i.result.verdict === 'review' && i.result.advanced));
});

test('each chunk is studied right before it is written; passing over the study is recorded, not blocked', async t => {
  const { board, cmd, phrases, request } = setup(t, () => assert.fail('no paid check'), true, undefined, null, 'jev', null, false);
  let r = board.get().active;
  assert.equal(r.phrases.step, 'learn', 'the first chunk opens on studying it');
  assert.throws(() => phrases.check(request({ text: 'I enjoy cooking', request_id: randomUUID() })), /先学这一块/);
  await assert.rejects(phrases.hint(request({ level: 3 })), /先学这一块/, 'the reference ladder belongs to writing');
  phrases.write(request());
  r = board.get().active;
  assert.equal(r.phrases.step, 'write');
  assert.ok(r.phrases.inputs[0].learn.finished_at);
  assert.equal(r.phrases.inputs[0].learn.skipped, true, 'no conversation happened, so studying it was passed over');
  assert.ok(r.support_events.some(e => e.kind === 'phrase_learn' && e.detail.index === 0));
  assert.throws(() => phrases.write(request()), /已经在写了/);

  phrases.check(request({ text: 'I enjoy cooking', request_id: randomUUID() }));
  r = board.get().active;
  assert.equal(r.phrases.index, 1);
  assert.equal(r.phrases.step, 'learn', 'the next chunk is studied before it is written, too');

  // Stepping out to the whole sentence leaves that study open, so coming back resumes it.
  cmd('practice'); cmd('start_phrases');
  r = board.get().active;
  assert.equal(r.phrases.index, 1); assert.equal(r.phrases.step, 'learn');
  phrases.write(request()); await phrases.hint(request({ level: 3 })); phrases.continue(request({ text: '' }));
  assert.equal(board.get().active.stage, 'practice');

  const attempt = cmd('attempt', { text: material.reference, source: 'simulation' }).active.attempts.at(-1);
  assert.deepEqual(attempt.learned, { sessions: 0, seconds: 0, studied: 0, chunks: 2, skipped: true },
    'an attempt says how many of its chunks were studied before being written');

  // The next run goes straight to writing what was already settled.
  cmd('feedback', { attempt_id: attempt.id, message: '可以。' }); cmd('start_phrases');
  r = board.get().active;
  assert.equal(r.phrases.run, 1); assert.equal(r.phrases.index, 0); assert.equal(r.phrases.step, 'write');
});

test('chunks prepared on demand open on studying the first one', async t => {
  const { phrases, request, board } = setup(t, undefined, false);
  const { index, ...req } = request(); phrases.ensure(req); await finish(phrases);
  const p = board.get().active.phrases;
  assert.equal(p.status, 'ready'); assert.equal(p.step, 'learn'); assert.equal(p.inputs[0].learn.sessions, 0);
});

test('legacy chunk generation coalesces, persists, and leaves the sentence and history untouched', async t => {
  let calls = 0, resolve;
  const { phrases, request, board } = setup(t, undefined, false, () => { calls++; return new Promise(r => resolve = r); });
  const { index, ...req } = request(); phrases.ensure(req); phrases.ensure(req); assert.equal(calls, 1);
  resolve({ value: { items }, model: 'gemini-test' }); await finish(phrases);
  assert.equal(board.get().active.phrases.status, 'ready'); assert.equal(board.get().active.reference, material.reference);
  assert.equal(board.get().history.length, 1); assert.equal(board.get().active.attempts.length, 0);
  const restarted = new Phrases(board, cfg, () => assert.fail('must reuse saved chunks'));
  restarted.ensure(req); assert.equal(board.get().active.phrases.items.length, 2);
});

test('interrupted generation/checks become retryable on restart without replaying model calls', t => {
  const { board } = setup(t);
  const s = board.read(), input = s.rounds[0].phrases.inputs[0];
  input.attempts.push({ id: 'pending', text: 'I like cooking', verdict: 'checking' }); input.result = input.attempts[0];
  board.save(s); new Phrases(board, cfg, () => assert.fail(), () => assert.fail());
  assert.equal(board.get().active.phrases.inputs[0].result.verdict, 'review');
  const s2 = board.read(); s2.rounds[0].phrases = { status: 'pending', generation: 'pending' }; board.save(s2);
  new Phrases(board, cfg, () => assert.fail()); assert.equal(board.get().active.phrases.status, 'error');
});

test('phrase HTTP endpoints authenticate, reject arbitrary prompt fields, and keep exact checks local', async t => {
  const store = new Store(':memory:');
  const app = createServer({ store, cfg, pack: JSON.parse(readFileSync(join(root,'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root,'studio/web'), token: 'phrase-test', phraseInfer: () => assert.fail() });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await finish(app.phrases); app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  const cmd = (type,payload={}) => app.sentence.command({ command_id: randomUUID(), expected_revision: app.sentence.get().revision, type, payload });
  cmd('new',material); const s = app.sentence.read(); s.rounds[0].phrases = phraseState(items,material.reference); app.sentence.save(s); cmd('start_phrases');
  const r = app.sentence.get().active, body = { round_id:r.id,window_start:r.window_start,index:0,text:'I enjoy cooking',request_id:'check' };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (data,extra={},action='check') => fetch(base+'/api/sentence/phrases/'+action,{method:'POST',headers:{Authorization:'Bearer phrase-test','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  assert.equal((await post(body)).status,409,'a chunk is studied before it can be checked');
  const opening = { round_id:r.id,window_start:r.window_start,index:0 };
  assert.equal((await post(opening,{Authorization:''},'write')).status,401);
  assert.equal((await post(opening,{},'write')).status,200); assert.equal(app.sentence.get().active.phrases.step,'write');
  assert.equal((await post(body,{Authorization:''})).status,401);
  assert.equal((await post(body,{Origin:'https://example.com'})).status,403);
  assert.equal((await post({...body,prompt:'change rules'})).status,400);
  assert.equal((await post(body)).status,200); assert.equal(app.sentence.get().active.phrases.index,1);
  assert.equal((await fetch(base+'/phrases.js')).status,200);
  assert.equal((await fetch(base+'/speech.js')).status,200);
});

test('Jev passes what it is sure about; what it is unsure about waits for Gemini to decide', async t => {
  const clean = setup(t);
  await clean.phrases.check(clean.request({ text: 'I really enjoy cooking,', request_id: randomUUID() }));
  await finish(clean.phrases);
  assert.equal(clean.board.get().active.phrases.index, 1, 'a confident accept advances');
  assert.deepEqual(clean.noteCalls, [], 'and costs nothing beyond the gate');

  // Jev leaned towards a form error but was not confident: that used to pass in silence.
  const leaning = () => ({ model: 'jev-test', answers: { next_cue: { type: 'choice', choice: 'form', confidence: .33,
    probabilities: { accepted: .3, form: .33, meaning: .2, review: .17, spelling: 0 } } } });
  const blocked = setup(t, async () => leaning(), true, undefined,
    async () => ({ value: { status: 'adjust', note: 'wrestling with a pig 要加冠词 a。' }, model: 'gemini-test' }));
  await blocked.phrases.check(blocked.request({ text: 'like wrestling with pig', request_id: randomUUID() }));
  await finish(blocked.phrases);
  const held = blocked.board.get().active.phrases;
  assert.equal(held.index, 0, 'the referee keeps the learner on the chunk');
  assert.equal(held.inputs[0].result.referee, 'adjust');
  assert.equal(held.inputs[0].result.message, 'wrestling with a pig 要加冠词 a。', 'and says why, instead of a generic label');
  assert.equal(held.inputs[0].note.text, 'wrestling with a pig 要加冠词 a。');

  let judged = null;
  const waved = setup(t, async () => leaning(), true, undefined,
    async packet => { judged = packet; return { value: { status: 'ok', note: '这样写也成立。' }, model: 'gemini-test' }; });
  await waved.phrases.check(waved.request({ text: 'like wrestling with a pig', request_id: randomUUID() }));
  await finish(waved.phrases);
  assert.equal(waved.board.get().active.phrases.index, 1, 'a referee that clears the chunk lets it through');

  assert.equal(judged.chunk_reference, items[0].reference);
  assert.ok(!('sentence_reference' in judged), 'the referee judges one chunk, not the whole sentence');
  assert.ok(!JSON.stringify(judged).includes(items[1].reference), 'nor any chunk the learner has not reached');
});

test('a correct chunk written in the learner\'s own words still surfaces the prepared expression', async t => {
  const { phrases, board, request, noteCalls } = setup(t);
  // Confidently accepted, but almost none of the prepared wording survives.
  // Confidently accepted, and almost none of the prepared wording survives.
  await phrases.check(request({ text: 'scaling rocks makes me happy,', request_id: randomUUID() }));
  await finish(phrases);
  assert.equal(board.get().active.phrases.index, 1, 'it is correct, so nothing blocks');
  assert.equal(noteCalls.length, 1, 'but the expression they routed around is still mentioned');
  assert.equal(noteCalls[0].learner_text, 'scaling rocks makes me happy,');

  // Nearly the prepared wording: nothing new to point out, so nothing is bought.
  const close = setup(t);
  await close.phrases.check(close.request({ text: 'I enjoy the cooking,', request_id: randomUUID() }));
  await finish(close.phrases);
  assert.deepEqual(close.noteCalls, []);
});

test('when Jev cannot answer at all, the referee decides instead of leaving a dead end', async t => {
  const { phrases, board, request } = setup(t, async () => { throw new Error('Jev network error or timeout'); }, true, undefined,
    async () => ({ value: { status: 'ok', note: '这一块没问题。' }, model: 'gemini-test' }));
  await phrases.check(request({ text: 'I really enjoy cooking,', request_id: randomUUID() }));
  await finish(phrases);
  const r = board.get().active;
  assert.equal(r.phrases.index, 1);
  assert.equal(r.phrases.inputs[0].result.reason, 'network_or_timeout', 'the record still says Jev never answered');
  assert.equal(r.phrases.inputs[0].result.referee, 'ok');
});

test('a note that arrives after the chunk was rewritten never lands on the new attempt', async t => {
  const releases = [];
  const slowNote = packet => new Promise(resolve => releases.push(() => resolve({ value: { status: 'adjust', note: `关于：${packet.learner_text}` }, model: 'gemini-test' })));
  const { phrases, board, request } = setup(t, async () => verdict('form'), true, undefined, slowNote);

  const first = randomUUID();
  await phrases.check(request({ text: 'I enjoys cooking,', request_id: first }));
  const second = randomUUID();
  await phrases.check(request({ text: 'I enjoy cooking very much,', request_id: second, retry: true }));

  // The first note comes back last, describing text the learner has already replaced.
  releases.pop()();
  releases.pop()();
  await finish(phrases);

  const input = board.read().rounds[0].phrases.inputs[0];
  assert.equal(input.attempts.at(-1).id, second);
  assert.equal(input.note.attempt_id, second, 'the note on show belongs to what is in the box now');
  assert.equal(input.note.text, '关于：I enjoy cooking very much,');
});

test('the Gemini gate decides and explains in one step, and never calls the classifier', async t => {
  const noJev = () => assert.fail('the retired classifier must not be called');

  // Exactly the prepared wording still passes locally, for free, and still needs no second look.
  const exact = setup(t, noJev, true, undefined, async () => assert.fail('no paid check for an exact match'), 'gemini');
  await exact.phrases.check(exact.request({ text: items[0].reference, request_id: randomUUID() }));
  await finish(exact.phrases);
  assert.equal(exact.board.get().active.phrases.index, 1);
  assert.equal(exact.board.get().active.phrases.inputs[0].result.provider, 'local');

  const passing = setup(t, noJev, true, undefined,
    async () => ({ value: { status: 'ok', suggestion: '', note: '这样写完全成立。' }, model: 'lite' }), 'gemini');
  await passing.phrases.check(passing.request({ text: 'I really enjoy cooking,', request_id: randomUUID() }));
  await finish(passing.phrases);
  let p = passing.board.get().active.phrases;
  assert.equal(p.index, 0, 'a pass worded differently from the prepared chunk waits here with its feedback');
  assert.equal(p.inputs[0].result.cleared, true); assert.equal(p.inputs[0].completed, false);
  assert.equal(p.inputs[0].result.provider, 'gemini');
  assert.equal(p.inputs[0].result.message, '这样写完全成立。', 'every decision arrives with words the learner can read');
  assert.equal(p.inputs[0].note.text, '这样写完全成立。');

  // Done talking it over: Command + Enter moves on.
  passing.phrases.next(passing.request());
  p = passing.board.get().active.phrases;
  assert.equal(p.index, 1); assert.equal(p.inputs[0].completed, true);
  assert.equal(p.inputs[0].text, 'I really enjoy cooking,', 'and keeps what the learner wrote');

  const blocking = setup(t, noJev, true, undefined,
    async () => ({ value: { status: 'adjust', suggestion: 'I enjoy cooking,', note: 'enjoy 后面要接动名词。' }, model: 'lite' }), 'gemini');
  await blocking.phrases.check(blocking.request({ text: 'I enjoy to cook,', request_id: randomUUID() }));
  await finish(blocking.phrases);
  const held = blocking.board.get().active.phrases;
  assert.equal(held.index, 0, 'a chunk with a real problem stays put');
  assert.equal(held.inputs[0].result.cleared, false); assert.equal(held.inputs[0].result.advanced, false);
  assert.equal(held.inputs[0].note.suggestion, 'I enjoy cooking,', 'the corrected wording is kept for the red pen');
  assert.equal(held.inputs[0].text, 'I enjoy to cook,', 'and the learner keeps what they wrote');
  // The correction explained, going on first means filling the corrected words back in from memory.
  blocking.phrases.next(blocking.request());
  const quizzing = blocking.board.get().active.phrases;
  assert.equal(quizzing.index, 0); assert.equal(quizzing.step, 'quiz');
  assert.deepEqual(quizzing.inputs[0].quiz.answers, ['cooking']);
  assert.deepEqual(quizzing.inputs[0].quiz.segments, ['I enjoy ', { blank: 0 }, ',']);
});

test('a pass written exactly as prepared moves straight on; there is nothing to talk over', async t => {
  const { phrases, board, request } = setup(t, () => assert.fail('no classifier'), true, undefined,
    async () => ({ value: { status: 'ok', suggestion: '', note: '完全正确。' }, model: 'flash' }), 'gemini');
  // Differs from the prepared chunk only in a comma the local match does not forgive, so Gemini judges it.
  await phrases.check(request({ text: 'I enjoy, cooking', request_id: randomUUID() }));
  await finish(phrases);
  const p = board.get().active.phrases;
  assert.equal(p.index, 1); assert.equal(p.inputs[0].completed, true); assert.equal(p.inputs[0].result.advanced, true);
});

test('an unreachable judge lets practice continue instead of stranding the learner', async t => {
  const { phrases, board, request } = setup(t, () => assert.fail('no classifier'), true, undefined,
    async () => { throw new Error('Gemini HTTP 503'); }, 'gemini');
  await phrases.check(request({ text: 'I really enjoy cooking,', request_id: randomUUID() }));
  await finish(phrases);
  let r = board.get().active;
  assert.equal(r.phrases.inputs[0].result.cleared, true, 'an outage clears the chunk rather than blocking it');
  assert.equal(r.phrases.inputs[0].result.reason, 'judge_unavailable');
  assert.match(r.phrases.inputs[0].result.message, /没能取得点评/);
  assert.equal(r.phrases.inputs[0].note, undefined, 'and nothing is recorded as feedback that was never given');
  assert.equal(r.phrases.index, 0, 'it still waits to be compared with the prepared wording');
  phrases.next(request());
  assert.equal(board.get().active.phrases.index, 1);
});

test('a hint is written for the chunk in front of the learner, and falls back when it cannot be', async t => {
  let asked = null;
  const live = async packet => { asked = packet; return { value: { hint: '这里要说的是被一点点磨垮、累到没力气的意思。' }, model: 'lite' }; };
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini', live);

  await phrases.hint(request({ level: 1, draft: 'I am enjoying cook' }));
  assert.equal(asked.draft, 'I am enjoying cook', 'the hint sees what is already in the box');
  assert.equal(asked.level, 1);
  assert.equal(asked.chunk_meaning, items[0].meaning);

  const input = board.get().active.phrases.inputs[0];
  assert.equal(input.hint_level, 1);
  assert.equal(input.hints[0], '这里要说的是被一点点磨垮、累到没力气的意思。', 'the live wording is what gets shown');
  const event = board.read().rounds[0].support_events.findLast(e => e.kind === 'phrase_hint');
  assert.equal(event.detail.source, 'gemini');
  assert.equal(event.detail.text, '这里要说的是被一点点磨垮、累到没力气的意思。', 'and what was shown is what gets recorded');

  // Level 3 is the prepared fragment: local, instant, never bought.
  await phrases.hint(request({ level: 3 }));
  assert.equal(board.read().rounds[0].support_events.findLast(e => e.kind === 'phrase_hint').detail.source, 'reference');

  const offline = setup(t, undefined, true, undefined, null, 'gemini', async () => { throw new Error('Gemini HTTP 503'); });
  await offline.phrases.hint(offline.request({ level: 1, draft: '' }));
  const fallback = offline.board.get().active.phrases.inputs[0];
  assert.equal(fallback.hint_level, 1, 'an outage still gives the learner something about the meaning');
  assert.equal(fallback.hints[0], 'Look at the meaning above. Say it in easy words, one small part at a time.', 'back to the meaning on screen, in English, not the prepared structure note');
  assert.equal(offline.board.read().rounds[0].support_events.findLast(e => e.kind === 'phrase_hint').detail.source, 'prepared');
});

test('a pause in writing brings a Chinese hint about the draft, without climbing the ladder', async t => {
  const asked = [];
  const live = async packet => { asked.push(packet); return { value: { hint: `针对：${packet.draft}` }, model: 'lite' }; };
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini', live);

  // Still following the prepared wording: said locally, nothing bought.
  await phrases.hint(request({ level: 1, draft: 'I enjoy', auto: true }));
  let input = board.get().active.phrases.inputs[0];
  assert.equal(asked.length, 0);
  assert.equal(input.hints[0], 'Good so far. Keep going.'); assert.equal(input.hint_level, 1);

  // Its own wording goes to Gemini, told this was a pause rather than a request, and follows the draft.
  await phrases.hint(request({ level: 1, draft: 'I really love', auto: true }));
  await phrases.hint(request({ level: 1, draft: 'I really love to', auto: true }));
  assert.equal(asked.length, 2); assert.equal(asked[0].trigger, 'pause'); assert.equal(asked[0].level, 1);
  input = board.get().active.phrases.inputs[0];
  assert.equal(input.hints[0], '针对：I really love to', 'the latest pause replaces the last automatic hint');
  assert.equal(input.hint_level, 1, 'pausing never climbs the ladder by itself');
  const events = board.read().rounds[0].support_events.filter(e => e.kind === 'phrase_hint');
  assert.equal(events.length, 3, 'every hint that was shown is recorded');
  assert.ok(events.every(e => e.detail.auto === true), 'and marked as automatic');
  assert.equal(events.at(-1).detail.draft, 'I really love to');

  // Asking still climbs, and pauses after that keep following the draft without taking the level down.
  await phrases.hint(request({ level: 2, draft: 'I really love to' }));
  assert.equal(asked.at(-1).trigger, 'request');
  await phrases.hint(request({ level: 1, draft: 'I really love to go', auto: true }));
  assert.equal(asked.length, 4); assert.equal(board.get().active.phrases.inputs[0].hint_level, 2);
  assert.equal(board.get().active.phrases.inputs[0].hints[0], '针对：I really love to go');

  await assert.rejects(phrases.hint(request({ level: 3, draft: 'x', auto: true })), /Invalid automatic hint/, 'never the reference by itself');

  // Without a live hint, a pause does not repeat the canned one.
  await assert.rejects(phrases.hint(request({ level: 1, draft: 'x', auto: true, hint_language: 'fr' })), /Invalid option/);
  const offline = setup(t, undefined, true, undefined, null, 'gemini', async () => { throw new Error('Gemini HTTP 503'); });
  await offline.phrases.hint(offline.request({ level: 1, draft: 'I love', auto: true }));
  assert.equal(offline.board.get().active.phrases.inputs[0].hint_level, 0);
  assert.ok(!offline.board.read().rounds[0].support_events.some(e => e.kind === 'phrase_hint'));
});

test('hints need no button: a first direction on an empty box, and the key words once when nothing moves', async t => {
  const asked = [];
  const live = async packet => { asked.push(packet); return { value: { hint: `${packet.trigger}:${packet.level}` }, model: 'lite' }; };
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini', live);
  await phrases.hint(request({ level: 1, draft: '', auto: true }));
  assert.equal(asked[0].trigger, 'start');
  let input = board.get().active.phrases.inputs[0];
  assert.equal(input.hints[0], 'start:1'); assert.equal(input.hint_level, 1);

  await phrases.hint(request({ level: 2, draft: '', auto: true }));
  assert.equal(asked[1].trigger, 'stuck'); assert.equal(asked[1].level, 2);
  input = board.get().active.phrases.inputs[0];
  assert.equal(input.hint_level, 2); assert.equal(input.hints[1], 'stuck:2');
  await phrases.hint(request({ level: 2, draft: '', auto: true }));
  assert.equal(asked.length, 2, 'the key words are given once');

  await phrases.hint(request({ level: 1, draft: 'I really love', auto: true }));
  assert.equal(asked[2].trigger, 'pause');
  const events = board.read().rounds[0].support_events.filter(e => e.kind === 'phrase_hint');
  assert.deepEqual(events.map(e => e.detail.trigger), ['start', 'stuck', 'pause'], 'each one recorded as it came');
});

test('hints can speak simple English like a mentor, down to the lines said without a model', async t => {
  const asked = [];
  const live = async packet => { asked.push(packet); return { value: { hint: 'Nice. Now say which activity you like.' }, model: 'lite' }; };
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini', live);
  await phrases.hint(request({ level: 1, draft: 'I enjoy', auto: true, hint_language: 'target' }));
  assert.equal(board.get().active.phrases.inputs[0].hints[0], 'Good so far. Keep going.');
  await phrases.hint(request({ level: 1, draft: 'I enjoy cooking,', auto: true, hint_language: 'target' }));
  assert.equal(board.get().active.phrases.inputs[0].hints[0], 'That looks complete. Press Command Enter to check it.');
  await phrases.hint(request({ level: 1, draft: 'I really love', auto: true, hint_language: 'target' }));
  assert.equal(asked[0].hint_language, 'target', 'Gemini is told which language to hint in');
  await phrases.hint(request({ level: 2, draft: 'I really love' }));
  assert.equal(asked[1].hint_language, 'target', 'always the language being learned, even when not asked for');
  await phrases.hint(request({ level: 1, draft: 'I really lov', auto: true, hint_language: 'zh' }));
  assert.equal(asked[2].hint_language, 'target', 'a page still offering Chinese gets the target language too');
});

test('a hint is shown and read as written; the prompt, not a filter, keeps it to meaning', async t => {
  const live = async () => ({ value: { hint: 'Good. Now say which sport you love, like on a verb list.' }, model: 'flash' });
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini', live);
  await phrases.hint(request({ level: 1, draft: 'I really love', auto: true, hint_language: 'target' }));
  assert.equal(board.get().active.phrases.inputs[0].hints[0], 'Good. Now say which sport you love, like on a verb list.');
});

test('the Chinese is recut to follow the target language, and only ever recut', async t => {
  const { phrases, board, request } = setup(t, undefined, true, undefined, null, 'gemini');
  let calls = 0;
  phrases.readOrder = async packet => {
    calls++;
    assert.equal(packet.chunks.length, items.length, 'one call covers the whole sentence');
    assert.equal(packet.chunks[0].meaning, items[0].meaning);
    return { value: { chunks: [{ parts: ['我喜欢', '做饭'] }, { parts: [items[1].meaning] }] }, model: 'lite' };
  };

  const target = () => ({ round_id: board.get().active.id, window_start: board.get().active.window_start });
  await phrases.order(target());
  const p = board.get().active.phrases;
  assert.deepEqual(p.order[0], ['我喜欢', '做饭']);
  assert.deepEqual(p.order[1], [items[1].meaning]);

  await phrases.order(target());
  assert.equal(calls, 1, 'the split is kept with the material, not bought again');
});

test('a split that invents or rewords Chinese is discarded rather than shown', () => {
  const meaning = '很多人被日常琐事一点点消磨';
  assert.deepEqual(readOrder(['很多人', '一点点消磨', '被日常琐事'], meaning), ['很多人', '一点点消磨', '被日常琐事']);

  // Anything that is not a run of the learner's own Chinese falls back to the whole line.
  assert.deepEqual(readOrder(['很多人', '被生活磨损'], meaning), [meaning], 'reworded pieces are refused');
  assert.deepEqual(readOrder(['很多人'], meaning), [meaning], 'a split that drops most of the meaning is refused');
  assert.deepEqual(readOrder([], meaning), [meaning]);
  assert.deepEqual(readOrder(null, meaning), [meaning]);
  assert.deepEqual(readOrder(['很多人', '', '被日常琐事'], meaning), [meaning]);
});
