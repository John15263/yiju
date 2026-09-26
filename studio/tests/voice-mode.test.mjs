import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceMode, chunkCorrection, chunkComparison, loose } from '../web/voice-mode.js';

const items = [
  { meaning: '但我不想', reference: 'But I do not want', hints: ['否定', 'B...'] },
  { meaning: '就这样过下去', reference: 'to live like that.', hints: ['不定式', 't...'] },
];
const input = (extra = {}) => ({ text: '', hint_level: 0, attempts: [], result: null, completed: false, ...extra });
const round = (phrases, extra = {}) => ({ id: 'r1', window_start: 3, stage: 'phrases', attempts: [], feedback: [],
  phrases: { status: 'ready', items, index: 0, step: 'write', inputs: [input(), input()], ...phrases }, ...extra });
const checked = (text, verdict, suggestion, note = '说明') => ({ text, completed: verdict !== 'adjust',
  result: { id: `a-${text}`, text, verdict }, note: { status: verdict === 'adjust' ? 'adjust' : 'ok', text: note, suggestion, attempt_id: `a-${text}` } });

test('each moment names its own kind of call, and only teaching and feedback start one by themselves', () => {
  assert.equal(loose('But I don’t want.'), loose("but i don't want"));
  assert.notEqual(loose('But I dont want'), loose("But I don't want"), 'the apostrophe is part of the word');

  const learn = voiceMode(round({ step: 'learn' }));
  assert.equal(learn.mode, 'learn'); assert.equal(learn.auto, true);
  assert.equal(learn.previous, undefined, 'a lesson is about its own chunk only');

  const writing = voiceMode(round({}));
  assert.equal(writing.mode, 'write'); assert.equal(writing.auto, false);

  // Held back on a chunk with a correction: explained where it happens, without the prepared wording.
  const held = round({ inputs: [input(checked('But I not want', 'adjust', "But I don't want")), input()] });
  const fix = voiceMode(held);
  assert.equal(fix.mode, 'fix'); assert.equal(fix.auto, true);
  assert.deepEqual(fix.correction, { index: 0, meaning: '但我不想', text: 'But I not want', suggestion: "But I don't want", note: '说明', passed: false });
  // A fresh check of new text is a new moment.
  held.phrases.inputs[0].result = { id: 'a-2', text: 'But I dont want', verdict: 'checking' };
  assert.equal(voiceMode(held).mode, 'write');

  // Passed but worded differently from the prepared chunk (a real case: "or" where the reference says
  // "and"): it waits on this chunk, talked over with the prepared wording alongside.
  const waiting = round({ inputs: [input({ ...checked('But I really do not want', 'accepted', '', 'and 更贴近原意，但这样也能懂。'), completed: false }), input()] });
  waiting.phrases.inputs[0].result.cleared = true;
  const compared = voiceMode(waiting);
  assert.equal(compared.mode, 'fix'); assert.equal(compared.auto, true);
  assert.deepEqual(compared.correction, { index: 0, meaning: '但我不想', text: 'But I really do not want', reference: 'But I do not want',
    suggestion: '', note: 'and 更贴近原意，但这样也能懂。', passed: true });
  // Once he moves on, the next chunk's lesson starts clean.
  waiting.phrases.inputs[0].completed = true; waiting.phrases.index = 1; waiting.phrases.step = 'learn';
  assert.equal(voiceMode(waiting).mode, 'learn');
  assert.equal(chunkComparison(waiting, 0), null);

  // Passed exactly as prepared: nothing to talk over.
  const clean = round({ inputs: [input({ ...checked('But I do not want.', 'accepted', ''), completed: false }), input()] });
  clean.phrases.inputs[0].result.cleared = true;
  assert.equal(chunkComparison(clean, 0), null);
  assert.equal(chunkCorrection(clean, 0), null);

  // The sentence after the last chunk is plain writing; every chunk was talked over on its own screen.
  const last = round({ index: 2, inputs: [input(), input(checked('to live like this.', 'accepted', 'to live like that.'))] }, { stage: 'practice' });
  assert.equal(voiceMode(last).mode, 'write');
});

test('feedback on the whole sentence starts a call only when it changed something', () => {
  const reviewed = (suggestion, score = 88) => round({}, { stage: 'review', attempts: [{ id: 'x1', text: 'But I not want live like that.' }],
    feedback: [{ attempt_id: 'x1', message: '否定要用 do not。', suggestion, score }] });
  const changed = voiceMode(reviewed("But I don't want to live like that."));
  assert.equal(changed.mode, 'review'); assert.equal(changed.auto, true); assert.equal(changed.correction.score, 88);
  const same = voiceMode(reviewed('But I not want live like that.', 100));
  assert.equal(same.mode, 'review'); assert.equal(same.auto, false, 'a sentence left as written needs no explaining');
  assert.equal(voiceMode(round({}, { stage: 'awaiting_feedback' })), null);
});
