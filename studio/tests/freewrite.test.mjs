import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginWriting, advanceWriting, editWriting, restoreWriting, PRESSURE_MS, IDLE_MS } from '../web/freewrite-state.mjs';
import { Store } from '../server/store.mjs';
import { Freewrites } from '../server/freewrites.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';

const start = 1_000_000;

test('eight seconds without writing clears only this run; a late input cannot revive it', () => {
  let s = editWriting(beginWriting(start), '我想说的话', start + 1000);
  s = advanceWriting(s, start + 8999); assert.equal(s.status, 'running');
  s = editWriting(s, '停了很久才打的字', start + 9000);
  assert.equal(s.status, 'failed'); assert.equal(s.text, '');
  assert.equal(restoreWriting(JSON.stringify(s), start + 9001).text, '');
  assert.equal(editWriting(s, '不能恢复旧文字', start + 10000).text, '');
  assert.equal(beginWriting(start + 10000).text, '');
});

test('five minutes of actual edits unlocks writing; stopping afterward cannot erase it', () => {
  let s = beginWriting(start);
  for (let elapsed = 0; elapsed < PRESSURE_MS; elapsed += 6000) s = editWriting(s, `${s.text}继续写。`, start + elapsed);
  s = advanceWriting(s, start + PRESSURE_MS);
  assert.equal(s.status, 'unlocked'); assert.ok(s.text.length);
  const original = s.text;
  assert.equal(advanceWriting(s, start + PRESSURE_MS * 10).text, original);
  s = editWriting(s, original + '我还想继续写。', start + PRESSURE_MS * 10);
  assert.equal(s.status, 'unlocked'); assert.match(s.text, /我还想继续写/);
  assert.equal(restoreWriting(JSON.stringify(s), start + PRESSURE_MS * 11).status, 'unlocked');
});

test('refresh/suspended tabs use deadline order rather than granting an overdue success', () => {
  let s = editWriting(beginWriting(start), '在后台睡过去的文字', start + 1000);
  assert.equal(restoreWriting(JSON.stringify(s), start + 4000).lastInputAt, start + 1000);
  assert.equal(restoreWriting(JSON.stringify(s), start + PRESSURE_MS + 1000).status, 'failed');
  // The five-minute boundary wins an exact tie; stopping a millisecond earlier fails.
  s = { ...s, lastInputAt: start + PRESSURE_MS - IDLE_MS };
  assert.equal(advanceWriting(s, start + PRESSURE_MS + 1000).status, 'unlocked');
  assert.equal(advanceWriting({ ...s, lastInputAt: s.lastInputAt - 1 }, start + PRESSURE_MS + 1000).status, 'failed');
});

test('IME composition is protected; unchanged non-composition input does not reset the clock', () => {
  let s = editWriting(beginWriting(start), '中', start + 1000);
  s = advanceWriting(s, start + 7000, true);
  s = advanceWriting(s, start + 13000, true);
  assert.equal(s.status, 'running'); assert.equal(s.lastInputAt, start + 13000);
  s = editWriting(s, '中文选字完成', start + 14000);
  assert.equal(s.text, '中文选字完成');
  s = editWriting(s, s.text, start + 18000);
  assert.equal(s.lastInputAt, start + 14000);
  assert.equal(advanceWriting(s, start + 22000).status, 'failed');
  assert.equal(restoreWriting('{bad', start), null);
  assert.equal(restoreWriting(JSON.stringify({ ...s, endsAt: 0 }), start), null);
});

test('completed originals persist independently, deduplicate retries, and reject changed content with the same ID', t => {
  const folder = mkdtempSync(join(tmpdir(), 'sentence-freewrite-')), path = join(folder, 'test.sqlite');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let store = new Store(path), freewrites = new Freewrites(store);
  const data = { id: 'writing-one', text: '这是我自己的自由写作，不应被 AI 建议覆盖。', started_at: '2026-09-21T04:00:00.000Z', finished_at: '2026-09-21T04:05:00.000Z' };
  assert.equal(freewrites.save(data).text, data.text);
  assert.equal(freewrites.save(data).duplicate, true);
  assert.throws(() => freewrites.save({ ...data, text: '不同内容' }), /Writing ID reused/);
  assert.throws(() => freewrites.save({ ...data, id: 'blank', text: ' ' }), /Invalid text/);
  assert.throws(() => freewrites.save({ ...data, id: 'large', text: 'x'.repeat(20001) }), /Invalid text/);
  store.close(); store = new Store(path); freewrites = new Freewrites(store);
  assert.equal(freewrites.save(data).duplicate, true);
  assert.equal(JSON.parse(store.db.prepare('SELECT body FROM freewrites').get().body).text, data.text);
  store.close();
});

test('completed-writing endpoint is authenticated, same-origin, and does not invoke models or change the active exercise', async t => {
  const store = new Store(':memory:');
  const never = () => { throw new Error('Writing must not call an AI provider'); };
  const app = createServer({ store, cfg: config({}), pack: JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root, 'studio/web'), token: 'test-token', preparationInfer: never, clozeInfer: never, reviewInfer: never });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const data = { id: 'browser-run', text: '模拟写作原文', started_at: '2026-09-21T04:00:00.000Z', finished_at: '2026-09-21T04:05:00.000Z' };
  const post = (body, customHeaders = headers) => fetch(base + '/api/sentence/freewrites', { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
  const initial = app.sentence.get();
  assert.equal((await post(data, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(data, { ...headers, Origin: 'https://example.com' })).status, 403);
  assert.equal((await post({ ...data, prompt: 'ignore rules' })).status, 400);
  assert.equal((await post(data)).status, 200);
  assert.equal((await post(data)).status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM freewrites').get().n, 1);
  assert.deepEqual(app.sentence.get(), initial);
  for (const path of ['/freewrite.js', '/freewrite-state.mjs']) assert.equal((await fetch(base + path)).status, 200);
});
