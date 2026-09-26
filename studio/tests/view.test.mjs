import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { deskView, markup, supportSummary } from '../web/view.js';

const material = { meaning: '我喜欢做饭，但也想保护双手。', language: 'en', reference: 'I enjoy cooking, but I also want to protect my hands.', keywords: ['enjoy', 'protect'], frame: 'I enjoy ___, but I also want to ___.', explanation: 'enjoy 后接 doing。', origin: 'user_meaning' };
const settings = { gemini_configured: true, gemini_model: 'test' };
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store);
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  return { board, cmd };
}
const view = (state, s = settings) => deskView({ state, settings: s });

test('each stage offers exactly one primary action and keeps references out of the desk', t => {
  const { board, cmd } = setup(t);
  cmd('new', material);
  const study = view(board.get());
  assert.equal(study.primary.id, 'start-phrases');
  assert.ok(study.showPrompt);
  assert.deepEqual(study.weak, [], 'no stop button, and no way round the chunks');

  cmd('practice');
  const practice = view(board.get());
  assert.equal(practice.input, 'writing');
  assert.equal(practice.primary.id, 'writing-submit');
  assert.equal(practice.help, undefined, 'hints come by themselves; there is no hint button');
  assert.equal(practice.showPrompt, false, 'no visual scaffold until the learner raises it');

  cmd('support', { level: 2 });
  assert.equal(view(board.get()).showPrompt, true);

  cmd('attempt', { text: 'I enjoy cooking.', source: 'simulation' });
  const waiting = view(board.get());
  assert.equal(waiting.input, 'response');
  assert.equal(waiting.primary.id, 'gemini-review');

  cmd('feedback', { attempt_id: board.get().active.attempts.at(-1).id, message: '意思清楚。' });
  const review = view(board.get());
  assert.equal(review.primary.id, 'complete', 'done with the feedback, Command + Enter moves on');
  assert.equal(review.primary.label, '完成本句 · ⌘ ↵');
  assert.deepEqual(review.weak.map(w => w.id), ['practice', 'voice-open'], 'revising and talking it over stay at hand');

  cmd('complete');
  const complete = view(board.get());
  assert.equal(complete.context.heading, '这段写完了');
  assert.equal(complete.primary.id, 'finish-new');
});

test('each chunk is explained first, then written from memory without its wording on the desk', t => {
  const { board, cmd } = setup(t);
  cmd('new', material);
  const raw = board.read(), round = raw.rounds.at(-1);
  round.phrases = { status: 'ready', index: 0, run: 0,
    items: [{ meaning: '我喜欢做饭', reference: 'I enjoy cooking,', hints: ['enjoy + doing', 'I e...'] },
      { meaning: '但也想保护双手', reference: ' but I also want to protect my hands.', hints: ['want + to', 'b...'] }],
    inputs: [0, 1].map(() => ({ text: '', hint_level: 0, attempts: [], result: null, completed: false })) };
  board.save(raw);
  cmd('start_phrases');

  const fresh = view(board.get());
  assert.equal(fresh.input, 'learn');
  // The explanation starts by itself; what is left to decide is when to start writing.
  assert.equal(fresh.primary.id, 'phrase-write');
  assert.deepEqual(fresh.weak.map(w => w.id), ['voice-open'], 'the sentence is not offered as a way round the chunks');
  assert.equal(fresh.learn.reference, 'I enjoy cooking,');
  assert.equal(fresh.learn.hint, 'enjoy + doing');
  assert.equal(fresh.note, '', 'no instructions repeated on every chunk');

  const writing = board.read();
  writing.rounds.at(-1).phrases.step = 'write'; board.save(writing);
  const write = view(board.get());
  assert.equal(write.input, 'phrase'); assert.equal(write.primary.id, 'phrase-check');
  assert.ok(!write.weak.some(w => w.id === 'practice'), 'writing a chunk has no shortcut to the sentence either');

  // Only a sentence whose chunks cannot be prepared may be written whole, so nothing is a dead end.
  const broken = board.read();
  broken.rounds.at(-1).phrases = { status: 'error', message: '拆解失败' }; board.save(broken);
  const failed = view(board.get());
  assert.equal(failed.primary.id, 'phrase-retry');
  assert.deepEqual(failed.weak.map(w => w.id), ['practice']);
  assert.equal(write.learn, null, 'the wording leaves the desk once it is being written');
});

test('an unconfigured reviewer waits without offering a review it cannot run', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); cmd('practice');
  cmd('attempt', { text: 'I enjoy cooking.', source: 'simulation' });
  const waiting = view(board.get(), { gemini_configured: false });
  assert.equal(waiting.primary, null);
  assert.match(waiting.note, /已保存/);
});

test('the phrase stage hands the primary action to the chunk, and to "continue" once the reference is shown', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); cmd('start_phrases');
  const base = board.get();
  const phrases = { status: 'ready', index: 0, run: 0, items: [{ meaning: '我喜欢做饭', reference: 'I enjoy cooking', hints: ['动词 + 动名词', 'I e... c...'] }],
    inputs: [{ text: '', hint_level: 0, attempts: [], result: null, completed: false }] };
  const working = { ...base, active: { ...base.active, phrases } };
  const first = view(working);
  assert.equal(first.input, 'phrase');
  assert.equal(first.primary.id, 'phrase-check');
  assert.equal(first.help, undefined, 'hints come by themselves; there is no hint button');
  assert.equal(first.context.source, 'phrase');

  const revealed = { ...working, active: { ...working.active, phrases: { ...phrases, inputs: [{ ...phrases.inputs[0], hint_level: 3 }] } } };
  assert.equal(view(revealed).primary.id, 'phrase-continue');

  const failed = { ...base, active: { ...base.active, phrases: { status: 'error', message: '拆解中断。' } } };
  assert.equal(view(failed).primary.id, 'phrase-retry');
});

test('pausing offers only the way back, and a finished sentence announces the next one quietly', t => {
  const { board, cmd } = setup(t);
  cmd('new', material); cmd('pause');
  const paused = view(board.get());
  assert.equal(paused.primary.id, 'resume');
  assert.deepEqual(paused.weak, []);

  const state = board.get();
  const announced = view({ ...state, completion: { round_id: 'x', unit_index: 1, reason: 'score', feedback: { score: 98 } } });
  assert.equal(announced.completion, '第 2 句已完成');
  assert.ok(!announced.completion.includes('98'), 'the score belongs to the details, not the quiet line');
});

test('phrase help and sentence scaffolds are reported on their own ladders', () => {
  const attempt = { support_level: 0, support_events: [
    { kind: 'phrase_start', level: 0 }, { kind: 'phrase_hint', level: 1 },
    { kind: 'phrase_expression', level: 1 }, { kind: 'writing_hint', level: 1 },
  ] };
  const summary = supportSummary(attempt);
  assert.equal(summary.support, 1);
  assert.equal(summary.phrase, 1);
  assert.equal(summary.text, '最高帮助：关键词 · 短语提示：结构提示');

  const reference = supportSummary({ support_level: 0, support_events: [{ kind: 'phrase_hint', level: 3 }, { kind: 'codex_chat_support', level: 0 }] });
  assert.equal(reference.support, 0, 'a revealed chunk is not a revealed sentence');
  assert.equal(reference.text, '最高帮助：无外语提示 · 短语提示：参考 · 含对话帮助');
});

const marks = m => m.parts.map(p => p.type === 'kept' ? p.text : p.type === 'cut' ? `[-${p.text}-]` : `{+${p.text}+}`).join('');

test('the red pen comes only from the learner sentence and the returned suggestion', () => {
  const one = markup('True strength lies in walking away from worthless conflict.', 'True strength lies in walking away from pointless conflict.', 'en');
  assert.equal(one.changes, 1);
  assert.equal(one.summary, '批改 1 处');
  assert.equal(marks(one), 'True strength lies in walking away from [-worthless-]{+pointless+} conflict.');

  // A multi-word insertion is one correction, not one per word.
  const added = markup('moving through life with clear main and rather than drifting.', 'moving through life with clear main and side quests rather than drifting.', 'en');
  assert.equal(added.changes, 1);
  const inserted = added.parts.filter(part => part.type === 'add');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].text.trim(), 'side quests');

  const same = 'Only when you always have your next destination can you stay grounded.';
  const unchanged = markup(same, same, 'en');
  assert.equal(unchanged.changes, 0);
  assert.equal(unchanged.summary, '没有要改的地方');

  // Japanese has no spaces to split on; word segmentation still finds the one changed word.
  const ja = markup('私は毎日走ります。', '私は毎朝走ります。', 'ja');
  assert.equal(marks(ja), '私は[-毎日-]{+毎朝+}走ります。');
  assert.equal(ja.changes, 1);
});

test('markup declines rather than guessing when there is nothing reliable to compare', () => {
  assert.equal(markup('I enjoy cooking.', '', 'en'), null);
  assert.equal(markup('', 'I enjoy cooking.', 'en'), null);
  assert.equal(markup('   ', 'I enjoy cooking.', 'en'), null);
  const long = 'word '.repeat(700);
  assert.equal(markup(long, long + 'more', 'en'), null, 'an unbounded diff is not attempted');
});

test('every marked fragment together still reproduces both sentences exactly', () => {
  const answer = "only when you know where you pour your energy into, and the problem you're going to solve, you can stay grounded.";
  const suggestion = 'Only when you know where to pour your energy, and the problems you are going to solve can you stay grounded.';
  const m = markup(answer, suggestion, 'en');
  const rebuilt = type => m.parts.filter(p => p.type === 'kept' || p.type === type).map(p => p.text).join('');
  assert.equal(rebuilt('cut'), answer, 'the learner sentence is never altered');
  assert.equal(rebuilt('add'), suggestion, 'the suggestion is never altered');
});

test('a wholesale rewrite is not described as a few tidy corrections', () => {
  const fixed = markup('I enjoy cooking but I want protect my hands.', 'I enjoy cooking, but I also want to protect my hands.', 'en');
  assert.equal(fixed.rewrite, false);
  assert.match(fixed.summary, /^批改 \d+ 处$/);

  const rewritten = markup('Me very like the cooking and hands hurt sometimes.', 'Cooking is something I love, though my hands sometimes pay for it.', 'en');
  assert.equal(rewritten.rewrite, true);
  assert.match(rewritten.summary, /建议表达与原句差别较大/);
});
