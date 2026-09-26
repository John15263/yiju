import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech, langOf } from '../web/speech.js';

const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
function fakeSynth(t, voices, { starts = true } = {}) {
  const synth = { spoken: [], cancelled: 0, speaking: false, pending: false, paused: false,
    getVoices: () => voices, cancel() { this.cancelled++; }, resume() { this.paused = false; },
    speak(u) { this.spoken.push(u); if (starts) u.onstart?.(); },
    // The voice reaches the end of what it was saying.
    finish() { this.spoken.at(-1)?.onend?.(); } };
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  t.after(() => { delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance; });
  return synth;
}

test('a Chinese hint is read by a Chinese voice even when it quotes the target language', () => {
  assert.equal(langOf('想一个表示“逐渐磨垮”的动词短语，用被动。'), 'zh-CN');
  assert.equal(langOf('worn down（被逐渐磨垮、消耗掉）'), 'zh-CN');
  assert.equal(langOf('but I also want to protect my hands.'), 'en-US');
  assert.equal(langOf('料理は好きですが、', 'ja'), 'ja-JP');
  assert.equal(langOf('到这里都对，接着往下写。', 'ja'), 'zh-CN');
});

test('hints are spoken once, with the best voice, never over the tutor, and each outcome is reported', async t => {
  const voices = [
    { name: 'Google 普通话（中国大陆）', lang: 'zh-CN', localService: false },
    { name: 'Eddy (Chinese (China mainland))', lang: 'zh-CN', localService: true },
    { name: 'Tingting', lang: 'zh-CN', localService: true },
    { name: 'Tingting (Enhanced)', lang: 'zh-CN', localService: true },
    { name: 'Albert', lang: 'en-US', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true },
  ];
  const synth = fakeSynth(t, voices), reports = [];
  let on = true, talking = false;
  const speech = createSpeech({ enabled: () => on, busy: () => talking, report: r => reports.push(r) });

  speech.say('到这里都对，接着往下写。', 'en'); await tick();
  assert.equal(synth.spoken[0].voice.name, 'Tingting (Enhanced)', 'a downloaded voice first; robotic, novelty and network voices last');
  assert.deepEqual(reports.at(-1), { ok: true, voice: 'Tingting (Enhanced)' });
  speech.say('到这里都对，接着往下写。', 'en'); await tick();
  assert.equal(synth.spoken.length, 1, 'the same words are not read twice in a row');

  // Still being read when newer hints come: it is read to the end, then only the newest of them.
  speech.say('这一句会被跳过。', 'en');
  speech.say('这一块看起来写完整了，按 ⌘ ↵ 检查。', 'en'); await tick();
  assert.equal(synth.spoken.length, 1, 'nothing cut off halfway');
  synth.finish(); await tick();
  assert.equal(synth.spoken.length, 2, 'the stale one in between is dropped');
  assert.equal(synth.spoken[1].text, '这一块看起来写完整了，按 Command 回车 检查。', 'key symbols are read by name');
  synth.finish();

  // Something else speaking in the browser is cancelled, and the hint waits a beat after the cancel.
  synth.speaking = true;
  speech.say('又一条。', 'en');
  assert.equal(synth.spoken.length, 2, 'not in the same instant as the cancel');
  await tick();
  assert.equal(synth.cancelled, 1); assert.equal(synth.spoken[2].text, '又一条。');
  synth.speaking = false; synth.finish();

  speech.say('I enjoy cooking,', 'en'); await tick(); synth.finish();
  assert.equal(synth.spoken.at(-1).voice.name, 'Samantha'); assert.ok(synth.spoken.at(-1).rate < 1, 'the language being learned is read a touch slower');

  voices.push({ name: 'Microsoft Ava Online (Natural) - English (United States)', lang: 'en-US', localService: false });
  speech.say('Good so far. Keep going.', 'en'); await tick(); synth.finish();
  assert.equal(synth.spoken.at(-1).voice.name, 'Microsoft Ava Online (Natural) - English (United States)', 'in Edge, the Natural voices lead');

  const before = synth.spoken.length;
  talking = true; speech.say('这一句不该出声。', 'en');
  on = false; talking = false; speech.say('关掉之后也不该出声。', 'en');
  await tick();
  assert.equal(synth.spoken.length, before);
});

test('speech that never starts is tried once more, then reported as silent', async t => {
  const synth = fakeSynth(t, [{ name: 'Samantha', lang: 'en-US', localService: true }], { starts: false }), reports = [];
  const speech = createSpeech({ enabled: () => true, busy: () => false, report: r => reports.push(r) });
  speech.say('Good so far.', 'en');
  await tick(5300);
  assert.equal(synth.spoken.length, 2, 'one retry after a stuck queue is cleared');
  assert.equal(reports.at(-1).ok, false); assert.match(reports.at(-1).reason, /没有开始/);
});

// Gemini's audio arrives as raw 16-bit PCM in chunks of any length; this page plays them as they come.
function fakeAudio() {
  const played = [];
  const context = { state: 'suspended', currentTime: 0, destination: {}, resume: async () => { context.state = 'running'; },
    createBuffer: (channels, length, rate) => { const data = new Float32Array(length); return { duration: length / rate, getChannelData: () => data }; },
    createBufferSource: () => { const source = { connect() {}, start(at) { played.push({ at, samples: [...source.buffer.getChannelData(0)] }); }, stop() { source.stopped = true; } }; return source; } };
  return { context, played };
}
function pcmResponse(chunks, voice = 'gemini-3.8-flash-tts · Kore') {
  let i = 0;
  return { ok: true, headers: { get: name => name === 'X-Voice' ? voice : null },
    body: { getReader: () => ({ read: async () => i < chunks.length ? { value: Uint8Array.from(chunks[i++]), done: false } : { done: true } }) } };
}

test('Gemini reads the hint as the audio streams in, a sample split across chunks included, and hearing it again is free', async t => {
  fakeSynth(t, []);
  const { context, played } = fakeAudio(), asked = [], reports = [];
  // 0x4000 = half scale, sent little-endian with one sample split over two chunks.
  const fetcher = async (url, options) => { asked.push({ url, body: JSON.parse(options.body) }); return pcmResponse([[0x00, 0x40, 0x00], [0xc0]]); };
  const speech = createSpeech({ enabled: () => true, busy: () => false, report: r => reports.push(r), engine: () => 'gemini', fetcher, makeContext: () => context });
  speech.say('Try the word for liking ⌘ ↵', 'en'); await tick();
  assert.equal(asked[0].url, '/api/sentence/speak');
  assert.deepEqual(asked[0].body, { text: 'Try the word for liking Command 回车', language: 'en-US' });
  assert.deepEqual(played.flatMap(p => p.samples), [0.5, -0.5]);
  assert.deepEqual(reports.at(-1), { ok: true, voice: 'gemini-3.8-flash-tts · Kore' });
  speech.stop(); speech.say('Try the word for liking ⌘ ↵', 'en'); await tick();
  assert.equal(asked.length, 1, 'kept from last time, not asked for again');
  assert.equal(played.length, 4, "both chunks played again from what was kept");
});

test('when Gemini cannot read it, the system voice does, and the reason is kept', async t => {
  const synth = fakeSynth(t, [{ name: 'Samantha', lang: 'en-US', localService: true }]), reports = [];
  const { context } = fakeAudio();
  const fetcher = async () => ({ ok: false, status: 503, json: async () => ({ error: '请在 .env 中填写 GEMINI_API_KEY 并重启服务。' }) });
  const speech = createSpeech({ enabled: () => true, busy: () => false, report: r => reports.push(r), engine: () => 'gemini', fetcher, makeContext: () => context });
  speech.say('Good so far.', 'en'); await tick();
  assert.equal(synth.spoken[0].text, 'Good so far.');
  assert.match(reports.at(-1).voice, /Samantha；Gemini 没念成：请在 \.env/);
});

test('a hint Gemini is saying is said to the end; then only the newest that came meanwhile, fetched while waiting', async t => {
  fakeSynth(t, []);
  const { context, played } = fakeAudio(), asked = [];
  const audio = { A: [0x00, 0x40], B: [0x00, 0x20], C: [0x00, 0xc0] };
  const fetcher = async (url, options) => { const { text } = JSON.parse(options.body); asked.push({ text, signal: options.signal }); return pcmResponse([audio[text]]); };
  const speech = createSpeech({ enabled: () => true, busy: () => false, engine: () => 'gemini', fetcher, makeContext: () => context });
  speech.say('A', 'en'); speech.say('B', 'en'); speech.say('C', 'en');
  await tick(20);
  assert.deepEqual(played.map(p => p.samples[0]), [0.5], 'A is not cut off');
  assert.ok(asked.find(a => a.text === 'B').signal.aborted, 'B went stale while waiting: its request is dropped');
  assert.ok(!asked.find(a => a.text === 'C').signal.aborted);
  await tick(200);
  assert.deepEqual(played.map(p => p.samples[0]), [0.5, -0.5], 'C follows A');
  assert.ok(played[1].at >= played[0].at, 'after it, not over it');
  // Stopping (the tutor starting) silences both at once.
  speech.say('A2', 'en'); speech.stop(); await tick(200);
  assert.equal(played.length, 2);
});
