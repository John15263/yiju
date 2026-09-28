import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { validatePhrases, axisOf } from '../server/phrase-material.mjs';
import { Transfers, pickAxis, secondRound } from '../server/transfer.mjs';
import { deskView, openTransfer } from '../web/view.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const source = '我最近总被琐碎小事搞得很累。周末我开始学做饭。';
const outline = { summary: source, core_logic: ['累，于是学做饭'], core_structure: ['第1句说累，第2句说做饭'], supporting_logic: [], supporting_structure: [], uncertainties: [] };
const sentences = [
  { meaning: '我最近总被琐碎小事搞得很累。', quote: '我最近总被琐碎小事搞得很累。', chunks: [
    { meaning: '我最近', reference: "Lately I've", hints: ['时间', 'lately'], axis: '', axis_meaning: '' },
    { meaning: '被琐碎小事搞得很累', reference: 'been worn down by small daily things.', hints: ['被磨垮', 'worn down'], axis: 'be worn down by ＋某事', axis_meaning: '被某事一点点耗尽' },
  ] },
  { meaning: '周末我开始学做饭。', quote: '周末我开始学做饭。', chunks: [
    { meaning: '周末', reference: 'On weekends,', hints: ['时间', 'weekend'], axis: '', axis_meaning: '' },
    { meaning: '我开始学做饭', reference: "I've taken up cooking.", hints: ['开始一个爱好', 'take up'], axis: 'take up ＋爱好', axis_meaning: '开始一项新爱好' },
  ] },
];

function setup(t, { make, judge } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store), cards = [], made = [], judged = [];
  const cfg = { geminiKey: 'test', anki: { enqueue: card => cards.push(card) } };
  const transfers = new Transfers(board, cfg, async packet => {
    made.push(packet);
    return make ? make(packet) : { value: { items: packet.items.map((item, i) => ({ prompt: `新场合 ${made.length}-${i}：${item.axis}`, example: `Example ${made.length}-${i}.` })) }, model: 'fake' };
  }, async packet => { judged.push(packet); return { value: judge(packet) }; });
  const cmd = (type, payload = {}) => board.command({ command_id: randomUUID(), expected_revision: board.get().revision, type, payload });
  const s = board.read();
  s.preparation = { id: 'prep-1', status: 'ready', provider: 'gemini', model: 'fake', source, focus: '', language: 'en', outline,
    units: sentences.map(x => ({ material: { meaning: x.meaning, language: 'en', reference: x.chunks.map(c => c.reference).join(' '), keywords: ['k'], frame: '___', explanation: '-', origin: 'user_meaning' },
      phrases: x.chunks, role: 'core', purpose: '说', connection: '', source_quotes: [x.quote] })) };
  board.save(s);
  cmd('accept_preparation', { preparation_id: 'prep-1' });
  // The chunks done, as the chunk stage leaves them, and the whole sentence open for writing.
  const write = () => { const raw = board.read(), r = raw.rounds.find(x => x.id === raw.active_id);
    r.phrases.index = r.phrases.items.length; r.stage = 'practice'; board.save(raw); transfers.pump(); };
  // Written and reviewed as prepared, so no correction quiz stands in the way.
  const review = () => { const r = board.get().active; cmd('attempt', { text: r.reference, source: 'typed_original' });
    cmd('feedback', { attempt_id: board.get().active.attempts.at(-1).id, message: '成立', suggestion: r.reference }); };
  const at = () => { const st = board.get(), transfer = openTransfer(st.active, st.collection?.transfer, st.collection?.units.every(u => u.stage === 'complete'));
    return transfer && { transfer_id: transfer.id, item_id: transfer.items[transfer.index].id }; };
  return { board, transfers, cmd, write, review, at, cards, made, judged };
}

test('an axis is kept only when its words are in the chunk, and a missing one does not hold up the chunks', () => {
  assert.equal(axisOf({ reference: 'been worn down by small daily things.', axis: 'be worn down by ＋某事', axis_meaning: '磨垮' }).axis, 'be worn down by ＋某事');
  assert.equal(axisOf({ reference: '最近料理を作るようになった。', axis: '〜ようになる', axis_meaning: '渐渐会' }).axis, '〜ようになる');
  assert.equal(axisOf({ reference: 'I enjoy cooking,', axis: 'be worn down by ＋某事', axis_meaning: '磨垮' }).axis, '', 'an axis from somewhere else is dropped');
  const [chunk] = validatePhrases([{ meaning: '我喜欢做饭', reference: 'I enjoy cooking.', hints: ['a', 'b'] }], 'I enjoy cooking.');
  assert.deepEqual([chunk.axis, chunk.axis_meaning], ['', ''], 'DeepSeek may leave it out');
});

test('the axis chosen is the one that cost the most, and one axis is practised once per passage', t => {
  const { board } = setup(t);
  const s = board.read(), [first, second] = s.rounds;
  first.phrases.items[0].axis = "have been ＋-ing"; first.phrases.items[0].axis_meaning = '一直在';
  assert.equal(pickAxis(s, first).chunk_index, 0, 'a tie goes to the earlier chunk');
  first.support_events.push({ kind: 'phrase_hint', detail: { index: 0, trigger: 'start' } });
  assert.equal(pickAxis(s, first).chunk_index, 0, 'the hint that comes by itself as the box opens is not a struggle');
  first.phrases.inputs[1].quiz = { text: 'been worn out with small daily things.', corrected: 'been worn down by small daily things.' };
  const picked = pickAxis(s, first);
  assert.equal(picked.chunk_index, 1); assert.equal(picked.priority, 3);
  assert.match(picked.trouble, /worn out with/);
  second.phrases.items[1].axis = 'be worn down by ＋某事';
  first.transfer = { round: 1, items: [picked] };
  assert.equal(pickAxis(s, second), null, 'the second sentence does not practise the same axis again');
});

test('right after a sentence: the question is written while it is practised, stands before the next sentence, and is filed for Anki', async t => {
  const { board, cmd, write, review, at, cards, made, judged, transfers } = setup(t, {
    judge: packet => packet.try === 1 ? { verdict: 'form', note: 'by 前面还少一个词', suggestion: 'He has been worn down by overtime.' }
      : { verdict: 'form', note: '还是少了 been', suggestion: 'He has been worn down by overtime.' } });
  write(); await tick();
  assert.equal(made.length, 1);
  assert.equal(made[0].items[0].axis, 'be worn down by ＋某事'); assert.equal(made[0].avoid, source);
  let r = board.get().active;
  assert.equal(r.transfer.status, 'ready'); assert.equal(r.stage, 'practice', 'written without interrupting the sentence');
  review(); cmd('complete');
  r = board.get().active;
  assert.equal(r.stage, 'transfer'); assert.equal(r.unit.index, 0, 'the next sentence waits');
  const view = deskView({ state: board.get() });
  assert.equal(view.input, 'transfer'); assert.equal(view.context.heading, r.transfer.items[0].prompt);

  await transfers.answer({ ...at(), answer: 'He worn down overtime.' });
  let item = board.get().active.transfer.items[0];
  assert.equal(item.status, 'open'); assert.equal(item.results[0].note, 'by 前面还少一个词');
  assert.equal(judged[0].axis, 'be worn down by ＋某事'); assert.equal(judged[0].example, item.example);
  await transfers.answer({ ...at(), answer: 'He is worn down by overtime.' });
  item = board.get().active.transfer.items[0];
  assert.equal(item.status, 'done'); assert.equal(item.passed, false);
  assert.equal(cards.length, 1); assert.match(cards[0].text, /\{\{c1::Example 1-0\.\}\}/); assert.deepEqual(cards[0].tags.slice(-1), ['换个场合']);
  assert.equal(board.get().active.support_events.filter(e => e.kind === 'transfer').length, 2);

  transfers.continue(at());
  const st = board.get();
  assert.equal(st.active.unit.index, 1, 'on to the next sentence');
  assert.equal(st.completion.unit_index, 0);
  assert.equal(st.collection.units[0].stage, 'complete');
});

test('said right another way, it is asked for once more with where the wording was met; said as the example, it goes straight on', async t => {
  const { board, cmd, write, review, at, transfers } = setup(t, { judge: () => ({ verdict: 'other', note: '意思对了，试试刚才那个说法？', suggestion: 'He is exhausted by overtime.' }) });
  write(); await tick(); review(); cmd('complete');
  await transfers.answer({ ...at(), answer: 'He is exhausted by overtime.' });
  const item = board.get().active.transfer.items[0];
  assert.equal(item.status, 'open'); assert.equal(item.hint_level, 1);
  assert.match(item.hints[0], /被琐碎小事搞得很累/);
  transfers.help(at()); transfers.help(at());
  assert.equal(board.get().active.transfer.items[0].hints[2], `参考说法：${item.example}`);
  await transfers.answer({ ...at(), answer: item.example });
  assert.equal(board.get().active.unit.index, 1, 'the example itself is right, locally, and moves on');
});

test('an answer sent twice while the first is judged counts once', async t => {
  const { board, cmd, write, review, at, transfers, judged } = setup(t, { judge: () => ({ verdict: 'miss', note: '少了“耗空”的意思', suggestion: 'x' }) });
  write(); await tick(); review(); cmd('complete');
  await Promise.all([transfers.answer({ ...at(), answer: 'He is tired.' }), transfers.answer({ ...at(), answer: 'He is tired.' })]);
  const item = board.get().active.transfer.items[0];
  assert.equal(judged.length, 1); assert.equal(item.tries, 1); assert.equal(item.status, 'open');
  assert.equal(item.results[0].verdict, 'miss');
});

test('a sentence finished before its question was written goes on without it', async t => {
  let release;
  const { board, cmd, write, review, made } = setup(t, { make: packet => new Promise(resolve => { release = () => resolve({ value: { items: packet.items.map(() => ({ prompt: '晚到的题', example: 'Late.' })) }, model: 'fake' }); }) });
  write(); await tick();
  assert.equal(made.length, 1);
  review(); cmd('complete');
  assert.equal(board.get().active.unit.index, 1);
  release(); await tick(); await tick();
  const first = board.read().rounds[0];
  assert.equal(first.stage, 'complete'); assert.equal(first.transfer, undefined);
});

test('when the passage is done, every axis comes back once more in yet another setting', async t => {
  const { board, cmd, write, review, at, made, transfers } = setup(t, { judge: () => ({ verdict: 'axis', note: '', suggestion: 'x' }) });
  for (let n = 0; n < 2; n++) {
    write(); await tick();
    review(); cmd('complete');
    const first = openTransfer(board.get().active, null, false);
    await transfers.answer({ ...at(), answer: first.items[0].example });
    await tick();
  }
  assert.equal(made.length, 3, 'one question per sentence, then the passage');
  const second = made[2];
  assert.deepEqual(second.items.map(i => i.axis).sort(), ['be worn down by ＋某事', 'take up ＋爱好']);
  assert.ok(second.items.every(i => i.earlier.startsWith('新场合')), 'each is told the setting it already had');
  const st = board.get();
  assert.equal(st.collection.transfer.round, 2);
  const view = deskView({ state: st });
  assert.equal(view.input, 'transfer'); assert.match(view.context.eyebrow, /整段回顾 · 换个场合 1 \/ 2/);
  transfers.skip(at());
  assert.equal(board.get().collection.transfer.status, 'done');
  assert.equal(deskView({ state: board.get() }).context.heading, '这段写完了');
});

test('the second round puts missed axes first, keeps at most four, and refuses a setting it already had', async t => {
  const { board } = setup(t);
  const s = board.read(), c = s.collections[0];
  const item = (axis, passed, priority) => ({ id: randomUUID(), axis, passed, priority, prompt: `p-${axis}` });
  s.rounds[0].transfer = { round: 1, items: [item('a', true, 3), item('b', true, 1), item('c', false, 1)] };
  s.rounds[1].transfer = { round: 1, items: [item('d', true, 2), item('e', true, 1)] };
  const chosen = secondRound(s, c, () => 0.999).map(x => x.axis);
  assert.equal(chosen.length, 4);
  assert.deepEqual([...chosen].sort(), ['a', 'b', 'c', 'd'], 'c was missed, a and d cost more; e waits');

  const { board: other, write, review, cmd, at, transfers } = setup(t, { make: packet => ({ value: { items: packet.items.map(i => ({ prompt: i.earlier || `新 ${i.axis}`, example: 'E.' })) }, model: 'fake' }) });
  for (let n = 0; n < 2; n++) { write(); await tick(); review(); cmd('complete'); await transfers.answer({ ...at(), answer: 'E.' }); await tick(); }
  assert.equal(other.get().collection.transfer.status, 'failed', 'the same setting twice is refused');
  assert.equal(deskView({ state: other.get() }).context.heading, '这段写完了');
});
