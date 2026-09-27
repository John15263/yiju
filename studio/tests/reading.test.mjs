import test from 'node:test';
import assert from 'node:assert/strict';
import { segments, shownText, spokenText, spokenRuns } from '../web/foreign.js';
import { langOf } from '../web/speech.js';
import { chunkHints, sentenceHints } from '../web/hint-log.js';
import { wavOf } from '../web/explain.js';
import { Speech, refusal } from '../server/tts.mjs';

// Reported 2026-09-27: read by a voice speaking Chinese, the Japanese word 毎日 came out as měirì.
test('an explanation line shows its foreign words plainly and has Japanese read by its kana', () => {
  const line = '{毎日|まいにち} 是“每天”的意思，和 {料理|りょうり} 连起来就是{毎日料理を作る|まいにちりょうりをつくる}。';
  assert.equal(shownText(line), '毎日 是“每天”的意思，和 料理 连起来就是毎日料理を作る。');
  assert.equal(spokenText(line), 'まいにち 是“每天”的意思，和 りょうり 连起来就是まいにちりょうりをつくる。');
  assert.deepEqual(spokenRuns(line, 'ja'), [
    { lang: 'ja-JP', text: 'まいにち' }, { lang: 'zh-CN', text: ' 是“每天”的意思，和 ' }, { lang: 'ja-JP', text: 'りょうり' },
    { lang: 'zh-CN', text: ' 连起来就是' }, { lang: 'ja-JP', text: 'まいにちりょうりをつくる' }]);
  // English needs no reading; kana alone neither.
  assert.equal(spokenText('{recently} 是“最近”，{ときどき} 是“有时”'), 'recently 是“最近”，ときどき 是“有时”');
  assert.deepEqual(spokenRuns('{recently} 是“最近”', 'en'), [{ lang: 'en-US', text: 'recently' }, { lang: 'zh-CN', text: ' 是“最近”' }]);
  // Scripts written before the marks, and marks left half-written, still read as text.
  assert.equal(spokenText('I have 是 have 的现在时'), 'I have 是 have 的现在时');
  // Japanese kanji that came without its reading is at least marked as Japanese for the voice.
  assert.equal(spokenText('{始めて} 表示开始', 'ja'), '「始めて」 表示开始');
  assert.equal(spokenText('{料理} 是做菜', 'en'), '料理 是做菜');
  assert.equal(shownText('{毎日|まいにち 是每天'), '毎日まいにち 是每天');
  assert.deepEqual(segments('{毎日|まいにち}').map(s => [s.text, s.foreign, s.reading]), [['毎日', true, 'まいにち']]);
});

test('learning Japanese, a hint written only in kanji is read as Japanese; Chinese stays Chinese', () => {
  assert.equal(langOf('毎日', 'ja'), 'ja-JP');
  assert.equal(langOf('料理', 'ja'), 'ja-JP');
  assert.equal(langOf('料理', 'en'), 'zh-CN');
  assert.equal(langOf('到这里都对，接着往下写。', 'ja'), 'zh-CN');
  assert.equal(langOf('ここまで大丈夫。', 'ja'), 'ja-JP');
});

test('the hint lists hold every hint of this chunk in this run, and of this writing of the sentence', () => {
  const event = (kind, at, level, detail) => ({ kind, at, level, detail });
  const r = { language: 'en', window_start: 2, phrases: { items: [{}, {}], index: 1, run: 1 }, support_events: [
    event('phrase_hint', 't1', 1, { index: 1, run: 0, text: 'from the first time through' }),
    event('phrase_hint', 't2', 1, { index: 0, run: 1, text: 'another chunk' }),
    event('phrase_hint', 't3', 1, { index: 1, run: 1, text: 'Say when it started.' }),
    event('phrase_hint', 't4', 2, { index: 1, run: 1, text: 'recently, started' }),
    event('phrase_hint', 't5', 1, { index: 1, run: 1, text: 'Good so far. Keep going.' }),
    event('phrase_hint', 't6', 3, { index: 1, run: 1, text: "I've recently started" }),
    event('writing_hint', 't7', 0, { hint_level: 1, window_start: 1, meaning: 'an older writing' }),
    event('writing_hint', 't8', 0, { hint_level: 1, window_start: 2, meaning: 'Start with who.', text: '' }),
    event('writing_hint', 't9', 1, { hint_level: 2, window_start: 2, meaning: 'Start with who.', text: 'I', note: 'the one who cooks' }),
    event('phrase_hint', 't10', 1, { index: 1, run: 1, text: "Good so far. Keep going." }),
    event('phrase_hint', 't11', 1, { index: 1, run: 1, text: "Good so far. Keep going." }),
  ] };
  // The same words twice in a row are one message.
  assert.deepEqual(chunkHints(r).map(e => [e.text, e.tag]), [['Say when it started.', ''], ['recently, started', '关键词'], ['Good so far. Keep going.', ''], ["I've recently started", '参考'], ['Good so far. Keep going.', '']]);
  assert.deepEqual(sentenceHints(r).map(e => [e.text, e.tag, e.note]), [['Start with who.', '', ''], ['I', '下一个词', 'the one who cooks']]);
  assert.equal(new Set(chunkHints(r).map(e => e.key)).size, 5, 'each has its own key');
});

test('Gemini speech that is refused says why, and is not asked again until the allowance is back', async () => {
  const refused = { error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded for model gemini-3.8-flash-lite-tts (limit: 100 requests per day on Tier 1). Please retry in 17h13m6s or upgrade your tier.' } };
  let asked = 0;
  const sse = events => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''))); c.close(); } });
  const request = async () => { asked++; return { ok: true, body: sse([{ event_type: 'interaction.created' }, { event_type: 'error', ...refused }]) }; };
  const res = { head: null, on() {}, writeHead(status) { res.head = status; }, write() {}, end() {} };
  const speech = new Speech({ geminiKey: 'k', geminiTtsModel: 'gemini-3.8-flash-lite-tts', geminiTtsVoice: 'Kore' }, request);
  await assert.rejects(speech.stream({ text: '讲解', language: 'zh-CN', kind: 'explain' }, {}, res),
    e => e.status === 429 && e.message === 'Gemini 朗读今天的 100 次用完了，约 17 小时后恢复。');
  assert.equal(res.head, null, 'no audio headers went out before the refusal');
  await assert.rejects(speech.stream({ text: '下一行', language: 'zh-CN', kind: 'explain' }, {}, res), e => e.status === 429);
  assert.equal(asked, 1, 'the second line did not ask Gemini again');
  assert.equal(refusal({ message: 'boom' }), 'Gemini 朗读出错：boom');
});

test('a whole line of audio becomes a WAV file an <audio> element can play at any speed', async () => {
  const blob = wavOf([Int16Array.from([1, -2]), Int16Array.from([3])]);
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav'); assert.equal(bytes.byteLength, 44 + 6);
  assert.equal(bytes.getUint32(24, true), 24000); assert.equal(bytes.getUint32(40, true), 6);
  assert.deepEqual([bytes.getInt16(44, true), bytes.getInt16(46, true), bytes.getInt16(48, true)], [1, -2, 3]);
});
