import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Voice } from '../server/voice.mjs';

const material = { meaning: '我喜欢做饭，但也想保护好自己的双手。', language: 'en', reference: 'I enjoy cooking, but I also want to protect my hands.',
  keywords: ['enjoy', 'protect'], frame: 'I enjoy ___, but I also want to ___.', explanation: 'enjoy 后接 doing。', origin: 'demo' };

class Upstream extends EventTarget {
  readyState = 0; sent = []; binaryType = '';
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  push(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

// A call about the first chunk, which is being studied: the tutor is to start explaining on its own.
function call(t, cfg) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: crypto.randomUUID(), expected_revision: board.get().revision, type, payload });
  cmd('new', material);
  const raw = board.read(), round = raw.rounds.at(-1);
  round.phrases = { status: 'ready', index: 0, run: 0,
    items: [{ meaning: '我喜欢做饭', reference: 'I enjoy cooking,', hints: ['enjoy + doing', 'I e...'] },
      { meaning: '但也想保护好双手', reference: 'but I also want to protect my hands.', hints: ['but + want to do', 'b... I a...'] }],
    inputs: [0, 1].map(() => ({ text: '', hint_level: 0, attempts: [], result: null, completed: false })) };
  board.save(raw);
  cmd('start_phrases');
  const up = new Upstream(), page = [], on = {};
  let opened;
  const voice = new Voice(board, { voiceMaxSeconds: 60, voiceIdleSeconds: 30, ...cfg }, (url, options) => { opened = { url, options }; return up; });
  const conn = { send: s => page.push(JSON.parse(s)), close() {}, on: (e, f) => (on[e] = f) };
  const r = board.get().active;
  voice.start(conn, new URLSearchParams({ round_id: r.id, window_start: String(r.window_start) }));
  return { board, up, page, on, opened: () => opened, roundID: r.id };
}
const events = page => page.filter(m => ['audio', 'heard', 'said', 'interrupted', 'turn'].includes(m.voice)).map(m => m.voice);
const recorded = (board, roundID) => board.read().rounds.find(r => r.id === roundID).support_events.filter(e => e.kind === 'voice_session');

test('Qwen-Omni-Realtime: set up with the key in a header, and read back as the same events', t => {
  const metered = [];
  const { board, up, page, on, opened, roundID } = call(t, { voiceProvider: 'qwen', dashscopeKey: 'k', dashscopeRegion: 'cn-beijing', dashscopeWorkspace: 'ws1',
    qwenRealtimeModel: 'qwen3.8-omni-flash-realtime', qwenVoice: 'longanlingxin',
    usage: { record: u => (metered.push(u), { text_in: 10, audio_in: 70, text_out: 5, audio_out: 40, thoughts: 0, usd: null }) } });
  assert.equal(opened().url, 'wss://ws1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime');
  assert.equal(opened().options.headers.Authorization, 'Bearer k');
  up.open();
  const setup = up.sent[0];
  assert.equal(setup.type, 'session.update');
  assert.match(setup.session.instructions, /「一句」的讲解员/);
  assert.match(setup.session.instructions, /I enjoy cooking,/, 'the chunk being studied is handed to the tutor');
  assert.equal(setup.session.audio.output.voice, 'longanlingxin');
  assert.equal(page.find(m => m.voice === 'ready').model, 'qwen3.8-omni-flash-realtime');
  on.message(JSON.stringify({ type: 'audio', data: 'AAAA' }));
  assert.deepEqual(up.sent.at(-1), { type: 'input_audio_buffer.append', audio: 'AAAA' });
  // The tutor is asked to begin only once the session is set up.
  up.push({ type: 'session.updated' });
  assert.deepEqual(up.sent.slice(-2).map(m => m.type), ['conversation.item.create', 'response.create']);
  up.push({ type: 'response.audio.delta', delta: 'UklG' });
  up.push({ type: 'response.audio_transcript.delta', delta: 'enjoy 后面' });
  up.push({ type: 'response.audio_transcript.delta', delta: '接动名词。' });
  up.push({ type: 'input_audio_buffer.speech_started' });
  up.push({ type: 'conversation.item.input_audio_transcription.completed', transcript: '为什么不是 to cook？' });
  // Field names as the service actually sends them (plural "tokens"), not as documented.
  up.push({ type: 'response.done', response: { usage: { input_tokens: 80, output_tokens: 45, input_tokens_details: { audio_tokens: 70 }, output_tokens_details: { audio_tokens: 40 } } } });
  assert.deepEqual(events(page), ['audio', 'said', 'said', 'interrupted', 'heard', 'turn']);
  assert.equal(page.find(m => m.voice === 'audio').data, 'UklG');
  assert.equal(metered[0].usage.promptTokensDetails[0].tokenCount, 70);
  assert.equal(metered[0].purpose, 'voice_learn');
  // A price not known here is never shown as $0.
  assert.equal(page.find(m => m.voice === 'usage').usd, null);
  on.close();
  const saved = recorded(board, roundID)[0].detail;
  assert.deepEqual(saved.transcript, [{ role: 'tutor', text: 'enjoy 后面接动名词。' }, { role: 'user', text: '为什么不是 to cook？' }]);
  assert.equal(saved.model, 'qwen3.8-omni-flash-realtime');
  assert.equal(saved.usage.usd, null);
});

test('Qwen without a workspace id uses the shared address for its region', t => {
  const { opened } = call(t, { voiceProvider: 'qwen', dashscopeKey: 'k', dashscopeRegion: 'ap-southeast-1', dashscopeWorkspace: '', qwenRealtimeModel: 'm', qwenVoice: 'v' });
  assert.equal(opened().url, 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=m');
});

test('Gemini Live reads back as the same events', t => {
  const { board, up, page, on, opened, roundID } = call(t, { voiceProvider: 'gemini', geminiKey: 'g', geminiLiveModel: 'gemini-live', voiceThinkingLevel: 'LOW',
    usage: { record: () => ({ text_in: 1, audio_in: 0, text_out: 1, audio_out: 0, thoughts: 0, usd: 0.002 }) } });
  assert.match(opened().url, /BidiGenerateContent\?key=g$/);
  up.open();
  assert.equal(up.sent[0].setup.model, 'models/gemini-live');
  up.push({ setupComplete: {} });
  assert.equal(up.sent.at(-1).clientContent.turnComplete, true);
  up.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'UklG' } }] }, outputTranscription: { text: '讲完了。' } } });
  up.push({ serverContent: { inputTranscription: { text: '好的' }, interrupted: true } });
  up.push({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 10 } });
  assert.deepEqual(events(page), ['audio', 'said', 'heard', 'interrupted', 'turn']);
  assert.equal(page.find(m => m.voice === 'usage').usd, 0.002);
  on.close();
  assert.equal(recorded(board, roundID)[0].detail.transcript.length, 2);
});

test('an error from the service ends the call and says why', t => {
  const { up, page } = call(t, { voiceProvider: 'qwen', dashscopeKey: 'k', dashscopeRegion: 'cn-beijing', dashscopeWorkspace: 'w', qwenRealtimeModel: 'm', qwenVoice: 'v' });
  up.open();
  up.push({ type: 'error', error: { message: 'voice not found' } });
  assert.match(page.find(m => m.voice === 'closed').reason, /voice not found/);
});

test('with voice switched off, a call is refused and says where to change it', t => {
  const { page } = call(t, { voiceProvider: 'none' });
  assert.match(page.find(m => m.voice === 'error').message, /不用语音/);
});
