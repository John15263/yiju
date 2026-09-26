import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Usage, tokensOf, costOf } from '../server/usage.mjs';
import { geminiJSON } from '../server/gemini.mjs';
import { createServer } from '../server/http.mjs';
import { config, root } from '../server/config.mjs';

// Shapes copied from real responses on 2026-09-23.
const restFlash = { promptTokenCount: 9, candidatesTokenCount: 6, totalTokenCount: 261,
  promptTokensDetails: [{ modality: 'TEXT', tokenCount: 9 }], thoughtsTokenCount: 246 };
const liveTurn = { promptTokenCount: 2965, responseTokenCount: 44, totalTokenCount: 3009,
  promptTokensDetails: [{ modality: 'TEXT', tokenCount: 2632 }, { modality: 'AUDIO', tokenCount: 222 }],
  responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 44 }], thoughtsTokenCount: 116 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

test('usage reports are priced by modality, with thinking billed as output', () => {
  assert.deepEqual(tokensOf(restFlash), { text_in: 9, audio_in: 0, text_out: 6, audio_out: 0, thoughts: 246 });
  close(costOf('gemini-3.8-flash', tokensOf(restFlash), '2026-09-23T00:00:00Z'), (9 * 0.75 + 252 * 3.75) / 1e6);
  close(costOf('gemini-3.8-flash', tokensOf(restFlash), '2027-01-02T00:00:00Z'), (9 * 1.50 + 252 * 7.50) / 1e6);

  // A Live prompt counts text the details leave out; it is billed as text.
  assert.deepEqual(tokensOf(liveTurn), { text_in: 2743, audio_in: 222, text_out: 0, audio_out: 44, thoughts: 116 });
  close(costOf('gemini-3.8-live-extended-thinking', tokensOf(liveTurn)), (2743 * 0.75 + 222 * 3 + 116 * 4.5 + 44 * 12) / 1e6);
  close(costOf('gemini-3.5-flash-lite', { text_in: 1000, audio_in: 0, text_out: 100, audio_out: 0, thoughts: 0 }), (1000 * 0.30 + 100 * 2.50) / 1e6);
  assert.equal(costOf('some-future-model', tokensOf(restFlash)), null, 'an unknown model is not given a made-up price');
});

test('every call is logged by purpose and summed by local day', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const usage = new Usage(store);
  usage.record({ purpose: 'voice_learn', model: 'gemini-3.8-live-extended-thinking', usage: liveTurn, round_id: 'r1' });
  usage.record({ purpose: 'voice_learn', model: 'gemini-3.8-live-extended-thinking', usage: liveTurn, round_id: 'r1' });
  usage.record({ purpose: 'writing_help', model: 'gemini-3.8-flash', usage: restFlash });
  usage.record({ purpose: 'review', model: 'unknown-model', usage: restFlash });
  assert.equal(usage.record({ purpose: 'not-a-purpose', model: 'gemini-3.8-flash', usage: restFlash }), null);
  assert.equal(usage.record({ purpose: 'review', model: 'gemini-3.8-flash', usage: undefined }), null, 'no report, nothing logged');

  const s = usage.summary();
  assert.equal(s.today.calls, 4); assert.equal(s.all.calls, 4); assert.ok(s.since);
  const voice = s.week_by_purpose[0];
  assert.equal(voice.purpose, 'voice_learn', 'the most expensive use comes first');
  assert.equal(voice.label, '语音讲解'); assert.equal(voice.calls, 2); assert.equal(voice.audio_out, 88);
  assert.equal(s.week_by_purpose.find(p => p.purpose === 'review').unpriced, 1);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(usage.summary(tomorrow).today.calls, 0, 'a new day starts from zero');
});

test('a Gemini call is metered from its reply, even a reply that fails the checks', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const cfg = { geminiKey: 'test', geminiModel: 'gemini-3.8-flash', geminiTimeout: 1000, usage: new Usage(store) };
  const reply = (finishReason = 'STOP') => async () => ({ ok: true, json: async () => ({ modelVersion: 'gemini-3.8-flash', usageMetadata: restFlash,
    candidates: [{ finishReason, content: { parts: [{ text: '{"ok":true}' }] } }] }) });
  await geminiJSON({}, cfg, { instructions: 'x', schema: {}, purpose: 'review' }, reply());
  await assert.rejects(geminiJSON({}, cfg, { instructions: 'x', schema: {}, purpose: 'review' }, reply('MAX_TOKENS')));
  const s = cfg.usage.summary();
  assert.equal(s.all.calls, 2, 'a truncated reply was still billed');
  assert.equal(s.week_by_purpose[0].thoughts, 492);
  // Calls without a meter still work.
  assert.deepEqual((await geminiJSON({}, { ...cfg, usage: undefined }, { instructions: 'x', schema: {} }, reply())).value, { ok: true });
});

test('the cost summary is served only to the local page', async t => {
  const store = new Store(':memory:');
  const app = createServer({ store, cfg: config({}), pack: JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'))), webRoot: join(root, 'studio/web'), token: 'usage-test' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.closeStreams(); await new Promise(r => app.server.close(r)); store.close(); });
  app.usage.record({ purpose: 'phrase_check', model: 'gemini-3.5-flash-lite', usage: { promptTokenCount: 2000, candidatesTokenCount: 100 } });
  const url = `http://127.0.0.1:${app.server.address().port}/api/usage`;
  assert.equal((await fetch(url)).status, 401);
  const body = await (await fetch(url, { headers: { Authorization: 'Bearer usage-test' } })).json();
  assert.equal(body.all.calls, 1); assert.equal(body.week_by_purpose[0].label, '短语检查');
});
