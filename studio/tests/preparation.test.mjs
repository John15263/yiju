import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Preparations, preparedMaterial, preparedExpression, callPreparation } from '../server/preparation.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';
import { Cloze } from '../server/cloze.mjs';
import { Reviews } from '../server/review.mjs';

const value = { meaning: '我喜欢做饭。', keywords: ['enjoy：喜欢'], frame: 'I ___ cooking.', explanation: 'enjoy 表示喜欢。', segments: [
  { text: 'I ', blank: false, hints: [], role: '' },
  { text: 'enjoy', blank: true, hints: ['喜欢', '主语是 I，动词用原形', 'e 开头'], role: '表达喜欢的动词；可以用 like' },
  { text: ' cooking.', blank: false, hints: [], role: '' },
] };
const outline = { summary: '我喜欢做饭。', core_logic: ['表达对做饭的喜欢'], core_structure: ['第1句表达爱好'], supporting_logic: [], supporting_structure: [], uncertainties: [] };
const expression = { outline, units: [{ ...value, role: 'core', purpose: '表达爱好', connection: '', source_quotes: ['我喜欢做饭。'] }] };
const answer = { value: expression, model: 'gemini-test' }, cfg = config({ GEMINI_API_KEY: 'secret-test' });
const request = () => ({ request_id: randomUUID(), source: '我喜欢做饭。偶尔也弹吉他。', language: 'en', focus: '说做饭就好' });
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  return { store, board, cmd };
}

test('prepare/confirm is one atomic new round, coalesces duplicate calls, and retains old practice', async t => {
  const { board, cmd } = setup(t); let resolve, calls = 0;
  cmd('new', { ...preparedMaterial(value, 'en').material, origin: 'demo' });
  const oldID = board.get().active.id;
  const preparations = new Preparations(board, cfg, packet => {
    calls++; assert.equal(packet.focus, '说做饭就好'); return new Promise(r => { resolve = r; });
  });
  const req = request(); preparations.start(req); preparations.start(req);
  assert.equal(calls, 1); assert.equal(board.get().active.id, oldID);
  assert.throws(() => preparations.start({ ...req, source: 'changed' }), /Request ID reused/);
  assert.throws(() => preparations.start(request()), /正在整理/);
  assert.throws(() => cmd('accept_preparation', { preparation_id: req.request_id }), /材料已改变/);
  resolve(answer); await preparations.pending;
  assert.equal(board.get().preparation.status, 'ready'); assert.equal(board.get().active.id, oldID);
  // A revision conflict cannot accept stale previews or lose another user's edits.
  assert.throws(() => board.command({ command_id: randomUUID(), expected_revision: 0, type: 'accept_preparation', payload: { preparation_id: req.request_id } }), /Revision conflict/);
  const before = board.get().revision;
  const result = cmd('accept_preparation', { preparation_id: req.request_id });
  assert.equal(result.revision, before + 1); assert.equal(result.history.length, 2);
  assert.equal(result.active.reference, 'I enjoy cooking.'); assert.equal(result.active.cloze.inputs['blank-1'].text, '');
  assert.equal(result.active.preparation.source, req.source); assert.equal(result.active.attempts.length, 0);
  assert.throws(() => cmd('accept_preparation', { preparation_id: req.request_id }), /材料已改变/);
});

test('invalid generated scaffolds cannot become exercises; Japanese chunks and whitespace reconstruct exactly', () => {
  const jp = structuredClone(value);
  jp.segments = [{ text: '私は', blank: false, hints: [], role: '' }, { text: '料理', blank: true, hints: ['做饭', '名词', 'り'], role: '一种活动' }, { text: 'が好きです。', blank: false, hints: [], role: '' }];
  assert.equal(preparedMaterial(jp, 'ja').material.reference, '私は料理が好きです。');
  const spaces = structuredClone(value); spaces.segments.splice(1, 0, { text: ' ', blank: false, hints: [], role: '' });
  assert.equal(preparedMaterial(spaces, 'en').material.reference, 'I  enjoy cooking.');
  for (const mutate of [v => v.segments[1].hints.pop(), v => v.segments[1].text = ' enjoy ', v => v.segments = [], v => v.meaning = '', v => v.segments[1].url = 'https://example.com', v => v.segments[1].role = 'x'.repeat(1001)]) {
    const broken = structuredClone(value); mutate(broken); assert.throws(() => preparedMaterial(broken, 'en'));
  }
});

test('provider failure and restart preserve source, avoid automatic paid retries, and protect existing round', async t => {
  const { board, cmd } = setup(t); cmd('new', { ...preparedMaterial(value, 'en').material, origin: 'demo' });
  const oldID = board.get().active.id;
  const preparations = new Preparations(board, cfg, async () => { throw new Error('secret-test provider dump'); });
  const req = request(); preparations.start(req); await preparations.pending;
  assert.equal(board.get().preparation.status, 'error'); assert.equal(board.get().active.id, oldID);
  assert.equal(board.get().preparation.source, req.source); assert.doesNotMatch(JSON.stringify(board.get()), /secret-test/);
  const s = board.read(); s.preparation.status = 'pending'; board.save(s);
  new Preparations(board, cfg, () => { throw new Error('must not call'); });
  assert.equal(board.get().preparation.status, 'error');
  assert.throws(() => new Preparations(board, config({})).start(request()), /GEMINI_API_KEY/);
});

test('fresh cloze retry keeps every original attempt and starts with no answers or hints', t => {
  const { board, cmd } = setup(t), p = preparedMaterial(value, 'en');
  cmd('new', p.material); cmd('prepare_cloze', { segments: p.segments }); cmd('practice');
  cmd('attempt', { text: 'I like cooking.', source: 'simulation' });
  cmd('feedback', { attempt_id: board.get().active.attempts[0].id, message: '成立' });
  const oldID = board.get().active.id, s = board.read();
  s.rounds[0].cloze.inputs['blank-1'].text = 'like'; s.rounds[0].cloze.inputs['blank-1'].hint_level = 3; board.save(s);
  const next = cmd('repeat').active;
  assert.equal(next.repeated_from, oldID); assert.equal(next.attempts.length, 0);
  assert.equal(next.cloze.inputs['blank-1'].text, ''); assert.equal(next.cloze.inputs['blank-1'].hint_level, 0);
  const old = cmd('select', { id: oldID }).active;
  assert.equal(old.attempts[0].text, 'I like cooking.'); assert.equal(old.cloze.inputs['blank-1'].text, 'like');
});

test('HTTP whole workflow needs no Codex command; new endpoints reject foreign writes and custom prompts', async t => {
  const store = new Store(':memory:'); let prepareCalls = 0, reviewCalls = 0;
  const app = createServer({ store, cfg, pack: JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root, 'studio/web'), token: 'test-token',
    preparationInfer: async () => { prepareCalls++; return answer; },
    reviewInfer: async () => { reviewCalls++; return { message: '意思成立', suggestion: 'I like cooking.', score: 95, model: 'gemini-test' }; },
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.preparations.pending; await Promise.all([...app.reviews.pending.values()]); app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const cmd = (type, payload = {}) => post('/api/sentence/commands', { command_id: randomUUID(), expected_revision: app.sentence.get().revision, type, payload });
  const req = request();
  assert.equal((await post('/api/sentence/prepare', req, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/api/sentence/prepare', { ...req, prompt: 'different system' })).status, 400);
  assert.equal((await post('/api/sentence/prepare', { ...req, source: '字'.repeat(20001) })).status, 400);
  assert.equal((await post('/api/sentence/prepare', req)).status, 200); await app.preparations.pending;
  assert.equal((await cmd('accept_preparation', { preparation_id: req.request_id })).status, 200);
  assert.equal((await cmd('practice')).status, 200);
  const submission = { command_id: 'only-once', expected_revision: app.sentence.get().revision, type: 'attempt', payload: { text: 'I like cooking.', source: 'simulation' } };
  assert.equal((await post('/api/sentence/commands', submission)).status, 200);
  await Promise.all([...app.reviews.pending.values()]);
  assert.equal((await post('/api/sentence/commands', submission)).status, 200);
  assert.equal(prepareCalls, 1); assert.equal(reviewCalls, 1);
  assert.equal(app.sentence.get().active.stage, 'review'); assert.equal(app.sentence.get().active.attempts[0].text, 'I like cooking.');
});

test('preparation has its own fixed prompt and structured-output contract', async () => {
  let body;
  const result = await callPreparation(request(), cfg, async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(expression) }] } }], modelVersion: 'gemini-test' }) };
  });
  assert.deepEqual(result, answer); assert.match(body.systemInstruction.parts[0].text, /待确认的候选/);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  assert.equal(body.generationConfig.maxOutputTokens, 16384);
});

function longerExpression() {
  const second = { ...structuredClone(expression.units[0]), meaning: '偶尔也弹吉他。', purpose: '补充另一个爱好', connection: '与前句并列，补充频率', role: 'support', source_quotes: ['偶尔也弹吉他。'],
    frame: 'I also play the guitar ___.', segments: [{ text: 'I also play the guitar ', blank: false, hints: [], role: '' }, { text: 'sometimes', blank: true, hints: ['偶尔', '频率副词', 's 开头'], role: '频率' }, { text: '.', blank: false, hints: [], role: '' }] };
  return { outline: { ...outline, summary: '我喜欢做饭，偶尔也弹吉他。', core_structure: ['第1句表达爱好，第2句补充另一个爱好'], supporting_logic: ['吉他是另一个偶尔参与的爱好'], supporting_structure: ['第2句补充'] }, units: [structuredClone(expression.units[0]), second] };
}
test('multi-unit confirmation is atomic; switching and repeating preserve each original and review context', async t => {
  const { board, cmd } = setup(t), req = { ...request(), focus: '' };
  const preparations = new Preparations(board, cfg, async () => ({ value: longerExpression(), model: 'gemini-test' }));
  preparations.start(req); await preparations.pending;
  const rev = board.get().revision, accepted = cmd('accept_preparation', { preparation_id: req.request_id });
  assert.equal(accepted.revision, rev + 1); assert.equal(accepted.history.length, 2);
  assert.equal(accepted.collection.outline.summary, longerExpression().outline.summary);
  const [first, second] = accepted.collection.units;
  cmd('start_cloze');
  const cloze = new Cloze(board, cfg);
  cloze.input({ round_id: first.id, slot_id: 'blank-1', text: 'like', expected_version: 0, edit_id: randomUUID() });
  cmd('select', { id: second.id }); assert.equal(board.get().active.cloze.inputs['blank-1'].text, '');
  cmd('select', { id: first.id }); assert.equal(board.get().active.cloze.inputs['blank-1'].text, 'like');
  cmd('cloze_submit', { source: 'simulation' });
  let packet;
  const reviews = new Reviews(board, cfg, async p => { packet = p; return { message: '成立', suggestion: 'I like cooking.', score: 95, model: 'gemini-test' }; });
  reviews.start({ round_id: first.id, attempt_id: board.get().active.attempts[0].id });
  await Promise.all([...reviews.pending.values()]);
  assert.equal(packet.learner_sentence, 'I like cooking.');
  assert.equal(packet.expression_context.summary, longerExpression().outline.summary);
  assert.equal(packet.expression_context.next_meaning, '偶尔也弹吉他。');
  assert.equal(packet.expression_context.previous_meaning, '');
  assert.ok(!JSON.stringify(packet).includes('I also play the guitar'));
  const repeated = cmd('repeat');
  assert.equal(repeated.collection.units[0].id, repeated.active.id);
  assert.equal(repeated.active.cloze.inputs['blank-1'].text, '');
  assert.equal(repeated.history.length, 3); assert.equal(repeated.active.unit.index, 0);
  cmd('select', { id: second.id }); assert.equal(board.get().collection.units[0].id, repeated.active.id);
  cmd('select', { id: first.id }); assert.equal(board.get().active.attempts[0].text, 'I like cooking.');
});
test('unattributed or malformed units cannot publish a partial expression; legacy previews still confirm', async t => {
  const { board, cmd } = setup(t), req = { ...request(), focus: '' };
  for (const mutate of [v => v.units[1].source_quotes = ['凭空编造的理由'], v => v.outline.core_logic = [], v => v.units.forEach(u => u.role = 'support'), v => v.units[1].segments[1].hints.pop()]) {
    const broken = longerExpression(); mutate(broken);
    assert.throws(() => preparedExpression(broken, req));
  }
  const p = new Preparations(board, cfg, async () => ({ value: longerExpression(), model: 'gemini-test' }));
  p.start(req); await p.pending;
  const s = board.read(); s.preparation.units[1].material.reference = 'Broken reference'; board.save(s);
  const before = board.get();
  assert.throws(() => cmd('accept_preparation', { preparation_id: req.request_id }), /reconstruct/);
  assert.deepEqual(board.get(), before);
  const legacy = board.read(); legacy.preparation = { ...req, id: req.request_id, status: 'ready', model: 'legacy', ...preparedMaterial(value, 'en') }; board.save(legacy);
  const accepted = cmd('accept_preparation', { preparation_id: req.request_id });
  assert.equal(accepted.active.reference, 'I enjoy cooking.'); assert.equal(accepted.collection, null);
});
