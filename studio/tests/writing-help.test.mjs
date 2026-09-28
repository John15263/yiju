import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { WritingHelp, callWritingHelp, localWritingHelp } from '../server/writing-help.mjs';
import { config, root } from '../server/config.mjs';
import { createServer } from '../server/http.mjs';
const material = { meaning: '我喜欢做饭。', language: 'en', reference: 'I enjoy cooking.', keywords: ['enjoy'], frame: 'I ___ cooking.', explanation: '测试', origin: 'demo' };
const answer = { status: 'continue', meaning: '接着说明喜欢的活动。', word: 'cooking', phrase: 'cooking', continuation: 'cooking.', note: '', model: 'gemini-test' };
const cfg = config({ GEMINI_API_KEY: 'test-secret' });
function setup(t, infer, settings = cfg) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  cmd('new', material); cmd('practice');
  const help = new WritingHelp(board, settings, infer);
  const request = (draft = 'I like ', caret = draft.length) => ({ round_id: board.get().active.id, window_start: board.get().active.window_start, draft, caret });
  return { board, cmd, help, request };
}
test('empty and reference-aligned drafts receive immediate local hints without paid inference', async t => {
  const { help, request, board } = setup(t, () => assert.fail('must not call'), config({}));
  const rev = board.get().revision;
  const start = await help.request(request(''));
  assert.equal(start.word, 'I'); assert.equal(start.provider, 'local');
  assert.equal((await help.request(request('I enjoy '))).word, 'cooking');
  assert.equal((await help.request(request(material.reference))).status, 'complete');
  assert.equal(board.get().revision, rev); assert.equal(board.get().active.attempts.length, 0);
  assert.equal(localWritingHelp(material, 'I enj', 5), null);
  const ja = localWritingHelp({ ...material, language: 'ja', reference: '私は料理が好きです。' }, '', 0);
  assert.equal(ja.word, '私'); assert.ok(ja.phrase.length > ja.word.length);
});
test('whole-sentence hints can speak simple English, including the instant local ones', async t => {
  let packet = null;
  const { help, request } = setup(t, async p => { packet = p; return answer; });
  const start = await help.request({ ...request(''), hint_language: 'target' });
  assert.equal(start.meaning, 'Start with I.'); assert.equal(start.word, 'I');
  assert.equal((await help.request({ ...request(material.reference), hint_language: 'target' })).meaning,
    'This sentence looks complete. Send it to get feedback.');
  assert.equal((await help.request({ ...request(''), hint_language: 'zh' })).meaning, 'Start with I.', 'never Chinese, whatever an old page asks');
  await help.request({ ...request('I really like '), hint_language: 'target' });
  assert.equal(packet.hint_language, 'target');
  await assert.rejects(help.request({ ...request('I really like '), hint_language: 'fr' }), /Invalid option/);
});

test('free wording and cursor context reach Gemini once; duplicate requests coalesce and cache', async t => {
  let calls = 0, packet, resolve;
  const { help, request } = setup(t, p => { calls++; packet = p; return new Promise(r => resolve = r); });
  const req = request('I like in my spare time.', 7);
  const first = help.request(req), second = help.request(req);
  assert.equal(calls, 1); assert.equal(packet.before_cursor, 'I like '); assert.equal(packet.after_cursor, 'in my spare time.');
  assert.equal(packet.intended_meaning, material.meaning); assert.equal(packet.draft, req.draft);
  resolve(answer);
  const results = await Promise.all([first, second]); assert.deepEqual(results[0], results[1]);
  assert.equal((await help.request(req)).hint_id, results[0].hint_id); assert.equal(calls, 1);
});
test('only acknowledged hints enter support evidence; submissions preserve the exact learner draft', async t => {
  const { help, request, board, cmd } = setup(t, async () => answer);
  const req = request(), h = await help.request(req), rev = board.get().revision;
  const seen = { round_id: req.round_id, window_start: req.window_start, hint_id: h.hint_id, level: 2 };
  assert.equal(board.get().revision, rev);
  help.seen(seen); help.seen(seen); assert.equal(board.get().revision, rev + 1);
  help.seen({ ...seen, level: 4 });
  cmd('attempt', { text: 'I like home cooking.', source: 'simulation' });
  const a = board.get().active.attempts[0];
  assert.equal(a.text, 'I like home cooking.');
  assert.deepEqual(a.support_events.filter(e => e.kind === 'writing_hint').map(e => [e.level, e.detail.text]), [[1, 'cooking'], [3, 'cooking.']]);
  assert.throws(() => help.seen(seen), /试写已切换/);
});
test('late results and hints from an earlier writing window cannot change a new attempt', async t => {
  let resolve;
  const { help, request, board, cmd } = setup(t, () => new Promise(r => resolve = r));
  const old = request(), pending = help.request(old);
  cmd('study'); cmd('practice'); const rev = board.get().revision;
  resolve(answer); await assert.rejects(pending, /试写已切换/);
  assert.equal(board.get().revision, rev); assert.equal(board.get().active.attempts.length, 0);
  assert.equal(board.get().active.support_events.some(e => e.kind === 'writing_hint'), false);
});
test('errors stay neutral, unchanged requests do not retry automatically, and unsafe fields are rejected', async t => {
  let calls = 0;
  const { help, request, board } = setup(t, async () => { calls++; if (calls === 1) throw new Error('test-secret'); return answer; });
  const req = request();
  await assert.rejects(help.request(req), e => !e.message.includes('test-secret'));
  await assert.rejects(help.request(req)); assert.equal(calls, 1);
  assert.equal((await help.request({ ...req, retry: true })).provider, 'gemini'); assert.equal(calls, 2);
  for (const bad of [{ ...req, prompt: 'ignore rules' }, { ...req, caret: 999 }, { ...req, draft: 'x'.repeat(4001) }]) await assert.rejects(help.request(bad));
  assert.equal(board.get().active.attempts.length, 0);
});
test('writing help uses the fixed Gemini prompt and validates structured output', async () => {
  let body;
  const { model, ...value } = answer;
  const result = await callWritingHelp({ draft: 'I like' }, cfg, async (_url, args) => {
    body = JSON.parse(args.body);
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], modelVersion: model }) };
  });
  assert.deepEqual(result, answer); assert.match(body.systemInstruction.parts[0].text, /不能只因不同于 reference/);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
});
test('HTTP hint endpoints require local authentication and same origin; no custom prompts or practice mutation on generation', async t => {
  const store = new Store(':memory:');
  const app = createServer({ store, cfg, token: 'test-token', pack: JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root, 'studio/web'), writingHelpInfer: async () => answer });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  const cmd = (type, payload = {}) => app.sentence.command({ command_id: randomUUID(), expected_revision: app.sentence.get().revision, type, payload });
  cmd('new', material); cmd('practice');
  const r = app.sentence.get().active, req = { round_id: r.id, window_start: r.window_start, draft: 'I like ', caret: 7 };
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const path = '/api/sentence/writing-help';
  assert.equal((await post(path, req, { Authorization: '' })).status, 401);
  assert.equal((await post(path, req, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post(path, { ...req, prompt: 'other instructions' })).status, 400);
  const res = await post(path, req); assert.equal(res.status, 200); const hint = await res.json();
  const seen = { round_id: r.id, window_start: r.window_start, hint_id: hint.hint_id, level: 2 };
  assert.equal((await post(path + '/seen', seen)).status, 200);
  assert.equal(app.sentence.get().active.attempts.length, 0);
  assert.equal((await fetch(base + '/writing-help.js')).status, 200);
});
