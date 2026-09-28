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
    e => e.status === 429 && e.message === 'Gemini 朗读今天的 100 次用完了（两个朗读模型都用完了），约 17 小时后恢复。');
  assert.equal(res.head, null, 'no audio headers went out before the refusal');
  assert.equal(asked, 2, 'the other speech model was tried before giving up');
  await assert.rejects(speech.stream({ text: '下一行', language: 'zh-CN', kind: 'explain' }, {}, res), e => e.status === 429);
  assert.equal(asked, 2, 'the second line did not ask Gemini again');
  assert.equal(refusal({ message: 'boom' }), 'Gemini 朗读出错：boom');
});

test('when one speech model has spent its allowance, the other one reads, and the spent one is left alone', async () => {
  const refused = { error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded (limit: 100 requests per day on Tier 1). Please retry in 17h.' } };
  const sse = events => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map(e => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''))); c.close(); } });
  const asked = [];
  const request = async (url, options) => { const { model } = JSON.parse(options.body); asked.push(model);
    return { ok: true, body: sse(model === 'gemini-3.8-flash-lite-tts' ? [{ event_type: 'error', ...refused }]
      : [{ event_type: 'step.delta', delta: { type: 'audio', data: Buffer.from([1, 2]).toString('base64') } }]) }; };
  const speech = new Speech({ geminiKey: 'k', geminiTtsModel: 'gemini-3.8-flash-lite-tts', geminiTtsVoice: 'Kore' }, request);
  const heard = () => { const res = { head: null, chunks: [], on() {}, writeHead(status, headers) { res.head = { status, headers }; }, write(b) { res.chunks.push(b); }, end() {} }; return res; };
  const first = heard();
  await speech.stream({ text: '讲解', language: 'zh-CN', kind: 'explain' }, {}, first);
  assert.equal(first.head.status, 200); assert.match(decodeURIComponent(first.head.headers['X-Voice']), /gemini-3\.8-flash-tts/);
  await speech.stream({ text: '下一行', language: 'zh-CN', kind: 'explain' }, {}, heard());
  assert.deepEqual(asked, ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-tts'], 'the spent model is not asked again');
});

test('a whole line of audio becomes a WAV file an <audio> element can play at any speed', async () => {
  const blob = wavOf([Int16Array.from([1, -2]), Int16Array.from([3])]);
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav'); assert.equal(bytes.byteLength, 44 + 6);
  assert.equal(bytes.getUint32(24, true), 24000); assert.equal(bytes.getUint32(40, true), 6);
  assert.deepEqual([bytes.getInt16(44, true), bytes.getInt16(46, true), bytes.getInt16(48, true)], [1, -2, 3]);
});

test('usage counts each Gemini speech model over Google’s day and says it in a few characters for the toolbar', async t => {
  const { Store } = await import('../server/store.mjs');
  const { Usage, pacificMidnight } = await import('../server/usage.mjs');
  const { badgeDollars, speechModelName, speechCounts } = await import('../web/usage-text.js');
  // 21:00 in Beijing (13:00 UTC) is 06:00 in California, whose day began at 07:00 UTC — 15:00 in Beijing.
  const at = new Date('2026-09-27T13:00:00Z');
  assert.equal(pacificMidnight(at).toISOString(), '2026-09-27T07:00:00.000Z');
  assert.equal(pacificMidnight(new Date('2026-12-01T09:00:00Z')).toISOString(), '2026-12-01T08:00:00.000Z', 'winter time: 16:00 in Beijing');
  const store = new Store(':memory:'); t.after(() => store.close());
  const log = (at, purpose, model, usd) => store.logUsage({ at, purpose, model, round_id: null, text_in: 1, audio_in: 0, text_out: 1, audio_out: 1, thoughts: 0, usd });
  log('2026-09-27T06:59:00.000Z', 'explain_speech', 'gemini-3.8-flash-lite-tts', 0.001);   // before Google's day
  log('2026-09-27T08:00:00.000Z', 'explain_speech', 'gemini-3.8-flash-lite-tts', 0.001);
  log('2026-09-27T08:01:00.000Z', 'hint_speech', 'gemini-3.8-flash-lite-tts', 0.001);
  log('2026-09-27T09:00:00.000Z', 'hint_speech', 'gemini-3.8-flash-tts', 0.002);
  log('2026-09-27T09:30:00.000Z', 'prepare', 'deepseek-flash', null);
  const u = new Usage(store).summary(at);
  assert.equal(u.speech.since, '2026-09-27T07:00:00.000Z');
  assert.deepEqual(u.speech.by_model, [{ model: 'gemini-3.8-flash-lite-tts', calls: 2 }, { model: 'gemini-3.8-flash-tts', calls: 1 }]);
  assert.equal(speechCounts(u.speech), 'Flash Lite 2 次，Flash 1 次');
  assert.equal(u.all.unpriced, 1, 'DeepSeek has no price here, and is counted as such');
  assert.equal(speechModelName('gemini-3.8-flash-lite-tts'), 'Flash Lite');
  assert.deepEqual([0.004, 0.18, 1.25, 9.96, 12.4].map(badgeDollars), ['$.00', '$.18', '$1.3', '$10', '$12']);
});

// Key words are given freely (2026-09-28): on the prepared wording, a pause gets the next word that carries meaning,
// and every canned line stays in one language, since one voice reads it.
test('a pause on the prepared wording names the next word that carries meaning, in one language', async () => {
  const { nextWord } = await import('../server/phrases.mjs');
  assert.equal(nextWord('I enjoy', 'I enjoy cooking,', 'en'), 'cooking');
  assert.equal(nextWord("I've recently started learning", "I've recently started learning to cook,", 'en'), 'cook', 'to is left for the learner');
  assert.equal(nextWord('I enjoy coo', 'I enjoy cooking,', 'en'), 'cooking', 'a word half typed is finished');
  assert.equal(nextWord('私は料理', '私は料理が好きです。', 'ja'), '好き', 'が is left for the learner');
  assert.equal(nextWord('I enjoy', 'I enjoy to', 'en'), 'to', 'a little word when nothing else is left');
  const { localWritingHelp } = await import('../server/writing-help.mjs');
  const ja = localWritingHelp({ language: 'ja', reference: '私は料理が好きです。', meaning: '我喜欢做饭。' }, '私は', 2, 'target');
  assert.equal(ja.meaning, 'その調子。つぎは「料理」。');
  assert.equal(localWritingHelp({ language: 'ja', reference: '料理を始めて、週末に作る。', meaning: '' }, '料理を始めて', 6, 'target').meaning,
    'その調子。つぎは「週末」。', 'the comma before the word is not named with it');
  assert.doesNotMatch(localWritingHelp({ language: 'ja', reference: '私は料理が好きです。', meaning: '' }, '私は料理が好きです。', 10, 'target').meaning, /[A-Za-z]/, 'no English in a Japanese line');
});
