import test from 'node:test';
import assert from 'node:assert/strict';
import { Speech, usageOf } from '../server/tts.mjs';
import { costOf, tokensOf } from '../server/usage.mjs';

const sse = events => new ReadableStream({ start(c) {
  const text = events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  // Cut mid-event, as the network does.
  const bytes = new TextEncoder().encode(text), cut = Math.floor(bytes.length / 2);
  c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close();
} });
function fakeRes() {
  const res = { chunks: [], head: null, ended: false, on() {}, writeHead(status, headers) { res.head = { status, headers }; }, write(b) { res.chunks.push(b); }, end(b) { if (b) res.chunks.push(b); res.ended = true; } };
  return res;
}
const usage = { total_input_tokens: 16, input_tokens_by_modality: [{ modality: 'text', tokens: 16 }], total_output_tokens: 288,
  output_tokens_by_modality: [{ modality: 'audio', tokens: 288 }], total_thought_tokens: 0 };

test('the hint is spoken by Gemini and streamed through as raw audio, and the call is metered', async () => {
  const recorded = [], sent = [];
  const cfg = { geminiKey: 'k', geminiTtsModel: 'gemini-3.8-flash-tts', geminiTtsVoice: 'Kore', usage: { record: r => recorded.push(r) } };
  const request = async (url, options) => { sent.push({ url, body: JSON.parse(options.body), key: options.headers['x-goog-api-key'] });
    return { ok: true, body: sse([{ event_type: 'interaction.created', interaction: { status: 'in_progress' } },
      { event_type: 'step.delta', delta: { type: 'audio', data: Buffer.from([1, 2, 3, 4]).toString('base64') } },
      { event_type: 'step.delta', delta: { type: 'audio', data: Buffer.from([5, 6]).toString('base64') } },
      { event_type: 'interaction.completed', interaction: { status: 'completed', usage } }]) }; };
  const res = fakeRes();
  await new Speech(cfg, request).stream({ text: ' A safe place. ', language: 'en-US' }, {}, res);
  assert.match(sent[0].url, /v1beta\/interactions\?alt=sse$/); assert.equal(sent[0].key, 'k');
  assert.equal(sent[0].body.model, 'gemini-3.8-flash-tts'); assert.equal(sent[0].body.stream, true);
  assert.equal(sent[0].body.input[0].content[0].text, 'A safe place.');
  assert.match(sent[0].body.input[0].content[0].annotations[0].style, /child learning English/);
  assert.deepEqual(sent[0].body.generation_config.speech_config, [{ voice: 'Kore' }]);
  assert.equal(res.head.headers['Content-Type'], 'audio/l16; rate=24000; channels=1');
  assert.deepEqual([...Buffer.concat(res.chunks)], [1, 2, 3, 4, 5, 6]); assert.ok(res.ended);
  assert.equal(recorded[0].purpose, 'hint_speech');
  const tokens = tokensOf(recorded[0].usage);
  assert.deepEqual({ text_in: tokens.text_in, audio_out: tokens.audio_out }, { text_in: 16, audio_out: 288 });
  assert.ok(Math.abs(costOf('gemini-3.8-flash-tts', tokens, '2026-09-24') - (16 * 0.5 + 288 * 9) / 1e6) < 1e-12);
  assert.ok(Math.abs(costOf('gemini-3.8-flash-lite-tts', tokens, '2026-09-24') - (16 * 0.5 + 288 * 6) / 1e6) < 1e-12, 'lite is not priced as flash');
});

test('only a short hint in a known language is sent, and a refused call fails before any audio', async () => {
  const cfg = { geminiKey: 'k', geminiTtsModel: 'gemini-3.8-flash-tts', geminiTtsVoice: 'Kore' };
  const speech = new Speech(cfg, async () => ({ ok: false, status: 429 }));
  await assert.rejects(speech.stream({ text: 'hi', language: 'fr-FR' }, {}, fakeRes()), /Invalid language/);
  await assert.rejects(speech.stream({ text: 'x'.repeat(401), language: 'en-US' }, {}, fakeRes()));
  const res = fakeRes();
  await assert.rejects(speech.stream({ text: 'hi', language: 'en-US' }, {}, res), /HTTP 429/);
  assert.equal(res.head, null);
  assert.equal(usageOf(null), null);
});

test('an explanation line is read in the explaining voice, kept on disk, and heard again for nothing', async t => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tts-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorded = [], sent = [];
  const cfg = { geminiKey: 'k', geminiTtsModel: 'gemini-3.8-flash-lite-tts', geminiTtsVoice: 'Kore', ttsCacheDir: dir, usage: { record: r => recorded.push(r) } };
  const request = async (url, options) => { sent.push(JSON.parse(options.body));
    return { ok: true, body: sse([{ event_type: 'step.delta', delta: { type: 'audio', data: Buffer.from([7, 8]).toString('base64') } },
      { event_type: 'interaction.completed', interaction: { usage } }]) }; };
  const speech = new Speech(cfg, request), line = { text: '第一个词组是 But I do not want。', language: 'zh-CN', kind: 'explain' };
  const first = fakeRes();
  await speech.stream(line, {}, first);
  assert.match(sent[0].input[0].content[0].annotations[0].style, /中文老师.*那门语言地道的发音/);
  assert.equal(recorded[0].purpose, 'explain_speech'); assert.equal(readdirSync(dir).length, 1);
  const again = fakeRes();
  await speech.stream(line, {}, again);
  assert.equal(sent.length, 1, 'not asked for again');
  assert.deepEqual([...Buffer.concat(again.chunks)], [7, 8], 'the same audio, from disk');
  assert.match(again.head.headers['X-Voice'], /已存，不花钱/);
  await assert.rejects(speech.stream({ ...line, kind: 'song' }, {}, fakeRes()), /Invalid option/);
});
