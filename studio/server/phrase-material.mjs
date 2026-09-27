import { check, fields, text } from './validation.mjs';

// Keep nested provider schemas simple; counts and exact coverage are checked below.
export const phraseSchema = { type: 'array', items: { type: 'object',
  properties: { meaning: { type: 'string' }, reference: { type: 'string' }, hints: { type: 'array', items: { type: 'string' } } },
  required: ['meaning', 'reference', 'hints'], additionalProperties: false } };
export function validatePhrases(items, reference) {
  check(Array.isArray(items) && items.length >= 1 && items.length <= 8, 'Supply 1–8 meaning chunks');
  for (const item of items) {
    fields(item, ['meaning', 'reference', 'hints'], ['meaning', 'reference', 'hints']);
    text(item.meaning, 600); text(item.reference, 800);
    check(Array.isArray(item.hints) && item.hints.length === 2, 'Supply structure and initial hints');
    item.hints.forEach(h => text(h, 500));
  }
  const compact = s => s.normalize('NFKC').replace(/\s+/gu, '');
  const whole = list => compact(list.map(p => p.reference).join('')) === compact(reference);
  const chunks = whole(items) ? items : alignChunks(items, reference);
  check(chunks && whole(chunks), 'Chunks must preserve the complete reference in order');
  return structuredClone(chunks);
}
// Providers without a strict schema (DeepSeek) often leave out the punctuation where a chunk ends or begins:
// "On weekends" for "On weekends,", "cooking" for "cooking.", 「忙しいです」 without its 。. When every chunk is
// otherwise found in the reference, word for word and in order, that punctuation is taken back from the
// reference. Anything else (a word changed, chunks reordered) stays refused.
function alignChunks(items, reference) {
  const mark = /\p{P}/u, space = /\s/u, pieces = [];
  let at = 0;
  for (const [i, item] of items.entries()) {
    const chunk = item.reference.trim(), next = items[i + 1]?.reference.trim();
    while (at < reference.length && space.test(reference[at])) at++;
    const start = at;
    while (at < reference.length && mark.test(reference[at]) && !reference.startsWith(chunk, at)) at++;
    if (!chunk || !reference.startsWith(chunk, at)) return null;
    at += chunk.length;
    while (at < reference.length && mark.test(reference[at]) && !(next && reference.startsWith(next, at))) at++;
    pieces.push(reference.slice(start, at));
  }
  if (reference.slice(at).trim()) return null;
  return items.map((item, i) => ({ ...item, reference: pieces[i] }));
}
export function phraseState(items, reference) {
  return { status: 'ready', items: validatePhrases(items, reference), index: 0, run: 0,
    inputs: items.map(() => ({ text: '', hint_level: 0, attempts: [], result: null, completed: false })) };
}
// Each chunk is talked through right before it is written, so writing recalls an expression
// studied a moment ago instead of guessing one never seen. A chunk studied in an earlier run
// or round goes straight to writing.
export function openChunk(p) {
  const input = p?.status === 'ready' ? p.inputs[p.index] : null;
  if (!input) return;
  if (input.learn?.finished_at) { p.step = 'write'; return; }
  p.step = 'learn';
  input.learn ||= { sessions: 0, seconds: 0, skipped: false, started_at: new Date().toISOString(), finished_at: null };
}
export const learning = r => r?.stage === 'phrases' && r.phrases?.status === 'ready' && r.phrases.step === 'learn';
// Whether a chunk was actually studied is read from what happened, not from which button was pressed.
export function finishLearn(input) {
  input.learn.finished_at = new Date().toISOString();
  // Studied: the script was heard, or the tutor was talked to.
  input.learn.skipped = !input.learn.sessions && !input.learn.explained;
}
export function learnedSummary(r) {
  const records = r.phrases?.status === 'ready' ? r.phrases.inputs.map(input => input.learn).filter(Boolean) : [];
  if (!records.length) return null;
  const studied = records.filter(l => l.sessions > 0 || l.explained > 0).length;
  return { sessions: records.reduce((n, l) => n + l.sessions, 0), seconds: records.reduce((n, l) => n + l.seconds, 0),
    studied, chunks: r.phrases.inputs.length, skipped: !studied };
}
export function beginPhrases(r, revision) {
  if (r.phrases?.status === 'ready' && r.phrases.index >= r.phrases.items.length) {
    r.phrases.index = 0;
    r.phrases.run = (r.phrases.run || 0) + 1;
    for (const input of r.phrases.inputs) Object.assign(input, { text: '', hint_level: 0, result: null, completed: false, note: null });
  }
  r.stage = 'phrases'; r.support_level = 0; r.window_start = r.support_events.length;
  openChunk(r.phrases);
  r.support_events.push({ kind: 'phrase_start', detail: null, level: 0, at: new Date().toISOString(), revision });
}
