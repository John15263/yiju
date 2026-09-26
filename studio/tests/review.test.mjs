import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Reviews, callGemini } from '../server/review.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';

const material = { meaning: '我喜欢做饭。', language: 'en', reference: 'I enjoy cooking.', keywords: ['enjoy'], frame: 'I ___ cooking.', explanation: '测试材料', origin: 'demo' };
const answer = { message: '意思清楚，like 也是合理表达。', suggestion: 'I like cooking.', score: 92, changes: [], model: 'gemini-test' };
const cfg = config({ GEMINI_API_KEY: 'test-secret' });
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  cmd('new', material); cmd('practice'); cmd('attempt', { text: 'I like cooking.', source: 'simulation' });
  const request = () => ({ round_id: board.get().active.id, attempt_id: board.get().active.attempts.at(-1).id });
  return { store, board, cmd, request };
}
const finish = reviews => Promise.all([...reviews.pending.values()]);
function collectionSetup(t) {
  const fixture = setup(t), { board, cmd } = fixture;
  const first = board.get().active.id;
  const second = cmd('new', { ...material, meaning: '我也弹吉他。', reference: 'I also play the guitar.' }).active.id;
  const s = board.read(), collectionID = randomUUID();
  s.collections = [{ id: collectionID, outline: { summary: '我喜欢做饭，也弹吉他。' }, round_ids: [first, second] }];
  s.rounds.forEach((r, index) => { r.collection_id = collectionID; r.unit = { index, purpose: '表达爱好', connection: '', role: index ? 'support' : 'core' }; });
  board.save(s); cmd('select', { id: first });
  return { ...fixture, first, second };
}

test('Gemini receives only this sentence; duplicate requests coalesce and feedback preserves original evidence', async t => {
  const { board, request } = setup(t); let packet, resolve, calls = 0;
  const reviews = new Reviews(board, cfg, data => { calls++; packet = data; return new Promise(r => { resolve = r; }); });
  reviews.start(request()); reviews.start(request());
  assert.equal(calls, 1); assert.equal(board.get().active.reviews[0].status, 'pending');
  assert.equal(packet.learner_sentence, 'I like cooking.');
  assert.deepEqual(Object.keys(packet).sort(), ['exercise_type', 'intended_meaning', 'language', 'learner_sentence', 'reference', 'support_level']);
  resolve(answer); await finish(reviews);
  const r = board.get().active;
  assert.equal(r.stage, 'review'); assert.equal(r.feedback[0].provider, 'gemini');
  assert.equal(r.feedback[0].score, 92); assert.equal(r.reviews[0].score, 92);
  assert.equal(r.attempts.length, 1); assert.equal(r.attempts[0].text, 'I like cooking.');
  assert.equal(r.attempts[0].source, 'simulation');
  reviews.start(request()); assert.equal(calls, 1);
});

test('late Gemini responses cannot overwrite a paused round, another round, or Codex feedback', async t => {
  for (const change of ['pause', 'switch', 'codex']) await t.test(change, async sub => {
    const { board, cmd, request } = setup(sub); let resolve;
    const originalID = board.get().active.id;
    const reviews = new Reviews(board, cfg, () => new Promise(r => { resolve = r; }));
    reviews.start(request());
    if (change === 'pause') cmd('pause');
    if (change === 'switch') cmd('new', { ...material, meaning: '另一个意思' });
    if (change === 'codex') cmd('feedback', { attempt_id: request().attempt_id, message: 'Codex 已反馈' });
    resolve({ ...answer, score: 100 }); await finish(reviews);
    const original = board.read().rounds.find(r => r.id === originalID);
    assert.equal(original.reviews[0].status, 'cancelled');
    assert.equal(original.feedback.some(f => f.provider === 'gemini'), false);
    if (change === 'codex') assert.equal(original.feedback[0].message, 'Codex 已反馈');
  });
});

test('errors are neutral and redacted; retry is explicit; missing credentials never call Gemini', async t => {
  const { board, request } = setup(t); let calls = 0;
  const reviews = new Reviews(board, cfg, async () => { calls++; if (calls === 1) throw new Error('test-secret provider error'); return answer; });
  reviews.start(request()); await finish(reviews);
  assert.equal(board.get().active.stage, 'awaiting_feedback');
  assert.equal(board.get().active.attempts.length, 1);
  assert.doesNotMatch(JSON.stringify(board.get()), /test-secret/);
  reviews.start(request()); assert.equal(calls, 1);
  reviews.start({ ...request(), retry: true }); await finish(reviews);
  assert.equal(calls, 2); assert.equal(board.get().active.feedback.length, 1);
  const next = setup(t);
  const noKey = new Reviews(next.board, config({}), () => { throw new Error('must not call'); });
  assert.throws(() => noKey.start(next.request()), /GEMINI_API_KEY/);
  assert.equal(next.board.get().active.reviews, undefined);
});

test('interrupted reviews become retryable on restart without replaying a paid call', async t => {
  const { board, request } = setup(t);
  const s = board.read();
  s.rounds[0].reviews = [{ id: 'interrupted', attempt_id: request().attempt_id, status: 'pending', provider: 'gemini' }]; board.save(s);
  let calls = 0;
  new Reviews(board, cfg, async () => { calls++; return answer; });
  assert.equal(calls, 0); assert.equal(board.get().active.reviews[0].status, 'error');
});

test('Gemini REST contract uses header auth, a fixed endpoint and validated JSON; unsafe or incomplete responses fail', async () => {
  let options;
  const response = { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning' }, { text: JSON.stringify({ message: answer.message, suggestion: answer.suggestion, score: answer.score }) }] } }], modelVersion: answer.model };
  const result = await callGemini({ learner_sentence: 'I like cooking.' }, cfg, async (url, args) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    options = args; return { ok: true, json: async () => response };
  });
  assert.deepEqual(result, answer); assert.equal(options.headers['x-goog-api-key'], 'test-secret');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(options.body);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  assert.match(body.systemInstruction.parts[0].text, /参考句只是一种表达/);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low', 'the text model thinks briefly by default');
  assert.equal(config({ GEMINI_THINKING_LEVEL: '' }).geminiThinkingLevel, '', 'and can be left to the model');
  assert.throws(() => config({ GEMINI_THINKING_LEVEL: 'lots' }), /GEMINI_THINKING_LEVEL/);
  assert.equal(body.generationConfig.responseFormat.text.schema.properties.score.type, 'integer');
  assert.ok(body.generationConfig.responseFormat.text.schema.required.includes('score'));
  for (const invalid of [
    { candidates: [{ ...response.candidates[0], finishReason: 'MAX_TOKENS' }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"message":"ok"}' }] } }] },
    { candidates: [] },
  ]) await assert.rejects(callGemini({}, cfg, async () => ({ ok: true, json: async () => invalid })));
  await assert.rejects(callGemini({}, cfg, async () => ({ ok: false, status: 403, json: () => { throw new Error('Do not read provider body'); } })), /Gemini HTTP 403/);
  for (const score of [undefined, null, '98', 95.5, -1, 101]) {
    const invalid = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ message: answer.message, suggestion: answer.suggestion, score }) }] } }] };
    await assert.rejects(callGemini({}, cfg, async () => ({ ok: true, json: async () => invalid })));
  }
});

test('only scores above 95 complete and advance atomically; duplicate commands and reloads do not skip units', async t => {
  for (const score of [0, 95, 96, 100]) await t.test(String(score), async sub => {
    const { board, cmd, request, first, second } = collectionSetup(sub);
    let calls = 0;
    const reviews = new Reviews(board, cfg, async () => { calls++; return { ...answer, score }; });
    const original = request();
    const submission = Object.values(board.read().commands).map(c => JSON.parse(c.fingerprint)).find(c => c.type === 'attempt');
    reviews.start(original); await finish(reviews);
    const state = board.get(), r = board.read().rounds.find(r => r.id === first);
    assert.equal(state.active.id, score > 95 ? second : first);
    assert.equal(r.stage, score > 95 ? 'complete' : 'review');
    assert.equal(r.feedback[0].score, score); assert.equal(r.attempts[0].text, 'I like cooking.');
    if (score > 95) {
      assert.equal(state.active.stage, 'phrases', 'the next sentence opens on its chunks, each studied before it is written');
      assert.equal(state.completion.feedback.score, score); assert.equal(state.completion.text, r.attempts[0].text);
      assert.throws(() => reviews.start(original), /表达已切换/);
    } else assert.equal(state.completion, null);
    assert.equal(board.command(submission).duplicate, true);
    new Reviews(board, cfg, () => assert.fail('must not regrade on restart'));
    assert.equal(board.get().active.id, state.active.id); assert.equal(calls, 1);
    if (score > 95) { cmd('select', { id: first }); assert.equal(board.get().completion, null); assert.equal(board.get().active.feedback[0].score, score); }
  });
});

test('missing or invalid scores keep the saved answer retryable and never advance', async t => {
  for (const score of [undefined, null, '99', 99.5, -1, 101, NaN, Infinity]) {
    const { board, request, first } = collectionSetup(t);
    const reviews = new Reviews(board, cfg, async () => ({ ...answer, score }));
    reviews.start(request()); await finish(reviews);
    const r = board.get().active;
    assert.equal(r.id, first); assert.equal(r.stage, 'awaiting_feedback');
    assert.equal(r.reviews[0].status, 'error'); assert.equal(r.feedback.length, 0);
    assert.equal(r.attempts[0].text, 'I like cooking.');
  }
});

test('manual completion advances legacy unscored feedback while preserving the next unit draft and stage', t => {
  const { board, cmd, first, second } = collectionSetup(t);
  cmd('select', { id: second }); cmd('practice'); cmd('support', { level: 1 });
  const next = structuredClone(board.get().active);
  cmd('select', { id: first });
  cmd('feedback', { attempt_id: board.get().active.attempts[0].id, message: '原有反馈，没有分数。' });
  new Reviews(board, cfg, () => assert.fail('legacy feedback must not be regraded'));
  assert.equal(board.get().active.id, first); assert.equal(board.get().active.stage, 'review');
  cmd('complete');
  assert.deepEqual(board.get().active, next);
  assert.equal(board.get().completion.reason, 'manual'); assert.equal(board.get().completion.feedback.score, undefined);
  assert.equal(board.read().rounds.find(r => r.id === first).stage, 'complete');
});

test('the final unit and standalone sentences finish without creating or wrapping to another unit', async t => {
  for (const collection of [false, true]) {
    const f = collection ? collectionSetup(t) : setup(t);
    if (collection) { f.cmd('select', { id: f.second }); f.cmd('practice'); f.cmd('attempt', { text: 'I play guitar too.', source: 'simulation' }); }
    const before = f.board.get().active.id, count = f.board.get().history.length;
    const reviews = new Reviews(f.board, cfg, async () => ({ ...answer, score: 99 }));
    reviews.start(f.request()); await finish(reviews);
    assert.equal(f.board.get().active.id, before); assert.equal(f.board.get().active.stage, 'complete');
    assert.equal(f.board.get().active.feedback[0].score, 99); assert.equal(f.board.get().history.length, count);
    assert.equal(f.board.get().completion, null);
  }
});

test('HTTP cloze submission starts Gemini once; foreign writes and client-supplied prompts are rejected', async t => {
  const store = new Store(':memory:'); let calls = 0;
  const app = createServer({ store, cfg, pack: JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root, 'studio/web'), token: 'test-token', reviewInfer: async () => { calls++; return answer; } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await finish(app.reviews); app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const cmd = (type, payload = {}) => app.sentence.command({ command_id: randomUUID(), expected_revision: app.sentence.get().revision, type, payload });
  cmd('new', material); cmd('prepare_cloze', { segments: ['I ', { id: 'verb', answers: ['enjoy'], hints: ['喜欢', '动词', 'e'], role: 'Verb' }, ' cooking.'] }); cmd('start_cloze');
  app.cloze.input({ round_id: app.sentence.get().active.id, slot_id: 'verb', text: 'like', expected_version: 0, edit_id: 'edit-1' });
  const submission = { command_id: 'submit-once', expected_revision: app.sentence.get().revision, type: 'cloze_submit', payload: { source: 'simulation' } };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/sentence/commands', submission)).status, 200);
  await finish(app.reviews);
  assert.equal((await post('/api/sentence/commands', submission)).status, 200);
  assert.equal(calls, 1); assert.equal(app.sentence.get().active.feedback[0].provider, 'gemini');
  const request = { round_id: app.sentence.get().active.id, attempt_id: app.sentence.get().active.attempts[0].id };
  assert.equal((await post('/api/sentence/review', request, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/sentence/review', { ...request, prompt: 'do other work' })).status, 400);
  const publicConfig = await (await fetch(base + '/api/config', { headers })).text();
  assert.doesNotMatch(publicConfig, /test-secret/); assert.match(publicConfig, /"gemini_configured":true/);
});
