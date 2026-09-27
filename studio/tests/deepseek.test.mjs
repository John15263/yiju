import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Preparations } from '../server/preparation.mjs';
import { validatePhrases } from '../server/phrase-material.mjs';
import { deepseekJSON, textError, trimmed } from '../server/llm.mjs';
import { config } from '../server/config.mjs';

const chunk = (reference, meaning = '意思') => ({ meaning, reference, hints: ['结构', `${reference.trim()[0] || ''}…`] });
const refs = list => list.map(p => p.reference);

// DeepSeek without thinking left out the punctuation at the edges of its chunks in 7 of 8 preparations (2026-09-27).
test('chunks that only left out the punctuation at their edges get it back from the sentence', () => {
  assert.deepEqual(refs(validatePhrases([chunk("I've recently"), chunk('started learning'), chunk('cooking')], "I've recently started learning cooking.")),
    ["I've recently", 'started learning', 'cooking.']);
  assert.deepEqual(refs(validatePhrases([chunk('On weekends'), chunk('I often'), chunk('cook for my friends')], 'On weekends, I often cook for my friends.')),
    ['On weekends,', 'I often', 'cook for my friends.']);
  assert.deepEqual(refs(validatePhrases([chunk('でも'), chunk('最近仕事がとても忙しいです')], 'でも、最近仕事がとても忙しいです。')),
    ['でも、', '最近仕事がとても忙しいです。']);
  assert.deepEqual(refs(validatePhrases([chunk('He said'), chunk('yes')], 'He said, "yes."')), ['He said,', '"yes."'], 'an opening quote goes with the chunk after it');
  // Chunks already right are kept as they are, the next one's opening mark included.
  assert.deepEqual(refs(validatePhrases([chunk('彼は'), chunk('「はい」と言った。')], '彼は「はい」と言った。')), ['彼は', '「はい」と言った。']);
  // A changed word or a changed order is still refused: that is not the sentence being taught.
  for (const [items, sentence] of [
    [[chunk('But lately'), chunk('work has been really busy')], 'But work has been really busy lately.'],
    [[chunk('I recently'), chunk('start cooking')], 'I recently started cooking.'],
    [[chunk('I like'), chunk('cooking')], 'I like cooking and music.'],
  ]) assert.throws(() => validatePhrases(items, sentence), /preserve the complete reference/);
});

test('DeepSeek is asked not to think first unless the settings say so, and a reply cut off midway is a network error', async () => {
  const bodies = [];
  const reply = { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], model: 'deepseek-flash' };
  const request = async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => reply }; };
  const opts = { instructions: '只返回 JSON', schema: { type: 'object' }, purpose: 'check' };
  await deepseekJSON({ q: 1 }, config({ TEXT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key' }), opts, request);
  await deepseekJSON({ q: 1 }, config({ TEXT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_THINKING: 'on' }), opts, request);
  assert.deepEqual(bodies.map(b => b.thinking), [{ type: 'disabled' }, { type: 'enabled' }]);
  // Its headers come at once and the answer only when done, so a dropped connection shows up while reading it.
  const cut = async () => ({ ok: true, json: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(deepseekJSON({ q: 1 }, config({ TEXT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key' }), opts, cut), /^Error: DeepSeek network error or timeout$/);
});

test('fields nobody asked for are dropped from a reply without a strict schema; what was asked for is left to the checks', () => {
  const schema = { type: 'object', properties: { outline: { type: 'object', properties: { summary: { type: 'string' } } },
    units: { type: 'array', items: { type: 'object', properties: { reference: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } } } };
  assert.deepEqual(trimmed({ outline: { summary: '做饭', mood: 'happy' }, units: [{ reference: 'I cook.', tags: ['a'], note: 'extra' }], extra: 1 }, schema),
    { outline: { summary: '做饭' }, units: [{ reference: 'I cook.', tags: ['a'] }] });
  assert.deepEqual(trimmed({ outline: 'not an object' }, schema), { outline: 'not an object' }, 'a wrong shape is not hidden');
});

test('a failed text call is told by the provider that was asked, never as Gemini when it was DeepSeek', () => {
  const deepseek = { textProvider: 'deepseek' }, qwen = { textProvider: 'qwen' };
  assert.equal(textError(new Error('Chunks must preserve the complete reference in order'), deepseek), '这次未取得有效的 DeepSeek 内容，可以重试。');
  assert.equal(textError(new Error('DeepSeek network error or timeout'), deepseek), 'DeepSeek 暂时连接不上或等待超时，可以重试。');
  assert.equal(textError(new Error('DeepSeek HTTP 402'), deepseek), 'DeepSeek 账户余额不足，充值后可以重试。');
  assert.equal(textError(new Error('Invalid score'), qwen), '这次未取得有效的千问内容，可以重试。');
  assert.equal(textError(new Error('Invalid score'), {}), '这次未取得有效的 Gemini 内容，可以重试。');
});

test('a preparation whose reply fails the checks is asked for once more; a refused key is not', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const board = new SentenceBoard(store), cfg = config({ TEXT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key' });
  const outline = { summary: '我喜欢做饭。', core_logic: ['喜欢做饭'], core_structure: ['第1句表达爱好'], supporting_logic: [], supporting_structure: [], uncertainties: [] };
  const unit = phrases => ({ meaning: '我喜欢做饭。', keywords: ['enjoy：喜欢'], frame: 'I ___ cooking.', explanation: 'enjoy 表示喜欢。', reference: 'I enjoy cooking.',
    phrases, role: 'core', purpose: '表达爱好', connection: '', source_quotes: ['我喜欢做饭。'] });
  const reworded = { value: { outline, units: [unit([chunk('I like'), chunk('cooking')])] }, model: 'deepseek-flash' };
  const good = { value: { outline, units: [unit([chunk('I enjoy'), chunk('cooking')])] }, model: 'deepseek-flash' };
  const answers = [reworded, good]; let calls = 0;
  const preparations = new Preparations(board, cfg, async () => { calls++; return answers.shift(); });
  preparations.start({ request_id: randomUUID(), source: '我喜欢做饭。', language: 'en' });
  await preparations.pending;
  assert.equal(calls, 2);
  assert.equal(board.get().preparation.status, 'ready');
  assert.deepEqual(refs(board.get().preparation.units[0].phrases), ['I enjoy', 'cooking.'], 'and its dropped full stop taken back');

  calls = 0;
  const refused = new Preparations(board, cfg, async () => { calls++; throw new Error('DeepSeek HTTP 401'); });
  refused.start({ request_id: randomUUID(), source: '我喜欢做饭。', language: 'en' });
  await refused.pending;
  assert.equal(calls, 1);
  assert.equal(board.get().preparation.message, 'DeepSeek 没有接受请求：key 不对，或者没有这个模型的权限。 原文已保存。');
});
