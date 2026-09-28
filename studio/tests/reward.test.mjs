import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkTier } from '../web/reward.js';

const done = (source, level = 0) => ({ kind: 'phrase_expression', level, detail: { source } });

test('each chunk written right in a row within the sentence steps the reward up; key words count a step lower', () => {
  const events = [{ kind: 'phrase_start' }];
  const tiers = [];
  for (const e of [done('typed_original'), done('typed_original'), done('typed_original', 1), done('typed_original'), done('typed_original')]) {
    events.push(e); tiers.push(chunkTier(events));
  }
  assert.deepEqual(tiers, [1, 2, 3, 4, 4], 'a description seen along the way does not matter; the ladder tops out');
  events.push(done('typed_original', 2));
  assert.equal(chunkTier(events), 3, 'seen with the key words: counts, a step lower');
});

test('a chunk that needed the prepared wording, or was moved on from with a correction, gets nothing and ends the row', () => {
  const events = [{ kind: 'phrase_start' }, done('typed_original'), done('typed_original'), done('reference_assisted', 3)];
  assert.equal(chunkTier(events), 0);
  events.push(done('typed_original'));
  assert.equal(chunkTier(events), 1, 'the row starts again');
  events.push(done('after_correction'));
  assert.equal(chunkTier(events), 0);
  assert.equal(chunkTier([done('typed_original'), done('typed_original'), { kind: 'phrase_start' }, done('typed_original')]), 1, 'a new run of the sentence starts a new row');
});
