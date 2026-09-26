import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';

const material = { meaning: '我喜欢做饭，但也想保护双手。', language: 'en', reference: 'I enjoy cooking, but I also want to protect my hands.', keywords: ['enjoy', 'protect'], frame: 'I enjoy ___, but I also want to ___.', explanation: 'enjoy 后接 doing；want 后接 to + 动词原形。', origin: 'demo' };
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  return { store, board, cmd };
}
test('one sentence completes a full loop with actual text separate from AI feedback', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); cmd('practice');
  cmd('attempt', { text: 'I like cooking, but I want protect my hands.', source: 'simulation' });
  const first = board.get().active.attempts[0];
  cmd('feedback', { attempt_id: first.id, message: '意思清楚。want 后需要 to。', suggestion: material.reference });
  cmd('practice');
  cmd('attempt', { text: 'I like cooking, but I want to protect my hands.', source: 'simulation', parent_attempt_id: first.id });
  cmd('feedback', { attempt_id: board.get().active.attempts[1].id, message: '这句话表达清楚了。' }); cmd('complete');
  const r = board.get().active;
  assert.equal(r.stage, 'complete'); assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].text, first.text); assert.equal(r.feedback[0].source, 'ai_feedback');
  assert.equal(r.attempts[1].parent_attempt_id, first.id);
});
test('help revealed then hidden remains in attempt evidence, including Codex chat help', t => {
  const { cmd } = setup(t); cmd('new', material); cmd('practice');
  cmd('support', { level: 3 }); cmd('record_support', { text: 'protect my hands' }); cmd('support', { level: 0 });
  const r = cmd('attempt', { text: material.reference, source: 'simulation' }).active;
  assert.equal(r.attempts[0].support_level, 0);
  assert.ok(r.attempts[0].support_events.some(e => e.level === 3));
  assert.ok(r.attempts[0].support_events.some(e => e.kind === 'codex_chat_support'));
  assert.ok(r.attempts[0].previous_support_count > 0);
});
test('stale and duplicate commands cannot append duplicate attempts or overwrite state', t => {
  const { board, cmd } = setup(t); cmd('new', material); cmd('practice');
  const b = { command_id: 'answer-1', expected_revision: board.get().revision, type: 'attempt', payload: { text: 'test', source: 'simulation' } };
  board.command(b); assert.equal(board.command(b).duplicate, true); assert.equal(board.get().active.attempts.length, 1);
  assert.throws(() => board.command({ ...b, command_id: 'answer-2' }), /Revision conflict/);
  assert.throws(() => board.command({ ...b, payload: { ...b.payload, text: 'changed' } }), /reused/);
});
test('stage, sources, feedback target and payloads are validated', t => {
  const { board, cmd } = setup(t);
  assert.throws(() => cmd('practice'), /准备一句/);
  cmd('new', material);
  assert.throws(() => cmd('complete'), /先完成/); assert.throws(() => cmd('new', { ...material, script: 'x' }), /Unknown field/);
  cmd('practice'); assert.throws(() => cmd('support', { level: 4 }), /Invalid/);
  assert.throws(() => cmd('attempt', { text: 'AI text', source: 'ai_suggestion' }), /Invalid option/);
  cmd('attempt', { text: 'test', source: 'simulation' });
  assert.throws(() => cmd('feedback', { attempt_id: 'wrong', message: 'feedback' }), /latest attempt/);
  assert.equal(board.get().active.feedback.length, 0);
});
test('English and Japanese remain separate; pause, resume and history selection preserve progress', t => {
  const { cmd, board } = setup(t); const en = cmd('new', material).active;
  cmd('practice'); cmd('support', { level: 1 }); cmd('pause');
  assert.throws(() => cmd('support', { level: 2 }), /暂停/); cmd('resume');
  assert.equal(board.get().active.support_level, 1);
  const ja = cmd('new', { ...material, language: 'ja', reference: '料理は好きだけど、手も大切にしたい。', keywords: ['好き', '大切にしたい'], frame: '___は好きだけど、___も大切にしたい。' }).active;
  assert.notEqual(ja.id, en.id); assert.equal(ja.stage, 'study'); cmd('select', { id: en.id });
  assert.equal(board.get().active.stage, 'practice'); assert.equal(board.get().active.language, 'en');
  assert.equal(board.get().active.support_level, 1);
});
test('board and render acknowledgement survive reopening SQLite without changing legacy sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentence-test-'));
  try {
    let store = new Store(join(dir, 'db.sqlite')), board = new SentenceBoard(store);
    board.command({ command_id: 'create', expected_revision: 0, type: 'new', payload: material }); board.ack({ rendered_revision: 1 });
    store.close(); store = new Store(join(dir, 'db.sqlite')); board = new SentenceBoard(store);
    assert.equal(board.get().active.meaning, material.meaning); assert.equal(board.get().client_view.rendered_revision, 1);
    board.ack({ rendered_revision: 0 }); assert.equal(board.get().client_view.rendered_revision, 1);
    assert.throws(() => board.ack({ rendered_revision: 2 }), /Invalid/);
    assert.equal(store.list().length, 0); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('authenticated HTTP commands stream the active sentence and reject foreign writes', async t => {
  const store = new Store(':memory:');
  const pack = JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json')));
  const app = createServer({ store, pack, cfg: config({}), webRoot: join(root, 'studio/web'), token: 'sentence-test-token' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeStreams(); await new Promise(resolve => app.server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer sentence-test-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(origin + '/api/sentence')).status, 401);
  assert.equal((await fetch(origin + '/api/sentence/commands', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/')).status, 200); assert.equal((await fetch(origin + '/legacy')).status, 200);
  const controller = new AbortController();
  const stream = await fetch(origin + '/api/sentence/events', { headers, signal: controller.signal }), reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"active":null/);
  const res = await fetch(origin + '/api/sentence/commands', { method: 'POST', headers, body: JSON.stringify({ command_id: 'http-new', expected_revision: 0, type: 'new', payload: material }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).active.meaning, material.meaning);
  assert.match(new TextDecoder().decode((await reader.read()).value), /I enjoy cooking/);
  controller.abort();
});
function withChunks(board) {
  const raw = board.read(), round = raw.rounds.at(-1);
  round.phrases = { status: 'ready', index: 0, run: 0,
    items: [{ meaning: '我喜欢做饭', reference: 'I enjoy cooking,', hints: ['动词 + 动名词', 'I e...'] },
      { meaning: '但也想保护双手', reference: ' but I also want to protect my hands.', hints: ['want + to', 'b... I a...'] }],
    inputs: [0, 1].map(() => ({ text: '', hint_level: 0, attempts: [], result: null, completed: false })) };
  board.save(raw);
}
test('writing opens on studying the first chunk, and going straight to the sentence is recorded rather than blocked', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); withChunks(board);

  const phrases = cmd('start_phrases').active;
  assert.equal(phrases.stage, 'phrases');
  assert.equal(phrases.phrases.step, 'learn');
  assert.equal(phrases.phrases.inputs[0].learn.sessions, 0);
  assert.equal(phrases.phrases.inputs[1].learn, undefined, 'a chunk is opened for study only when it comes up');

  // Nothing traps the learner: the whole sentence is always reachable, and the record says what happened.
  cmd('practice');
  const attempt = cmd('attempt', { text: material.reference, source: 'simulation' }).active.attempts.at(-1);
  assert.equal(attempt.learned.skipped, true, 'an attempt says whether its expressions were ever studied');
  assert.equal(attempt.learned.studied, 0);
});
test('repeating a sentence keeps what was already studied instead of teaching it again', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); withChunks(board);
  cmd('start_phrases');
  const raw = board.read(), round = raw.rounds.at(-1);
  Object.assign(round.phrases.inputs[0].learn, { sessions: 1, seconds: 90, finished_at: new Date().toISOString() });
  round.phrases.step = 'write'; board.save(raw);

  cmd('practice');
  cmd('attempt', { text: material.reference, source: 'simulation' });
  cmd('feedback', { attempt_id: board.get().active.attempts.at(-1).id, message: '可以。' });
  const repeated = cmd('repeat').active;
  assert.equal(repeated.stage, 'phrases');
  assert.equal(repeated.phrases.step, 'write', 'an already studied chunk goes straight back to writing');
  assert.equal(repeated.phrases.inputs[0].learn.sessions, 1, 'the earlier study record travels with it');
  assert.equal(repeated.phrases.inputs[1].learn, undefined);
});
