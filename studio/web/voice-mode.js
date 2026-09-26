// Which conversation the voice tutor is in, read from the practice state alone. The server builds the
// tutor's prompt from it and the page decides when to open or end a call from it, so both sides agree.
//
//   learn  — a chunk is being studied: the tutor is given that chunk's wording, and only that.
//   fix    — a chunk came back from its check and the learner is still on it: held back with a
//            correction (what was written and how it was corrected, both on screen), or passed but
//            worded differently from the prepared chunk, which is then on screen beside it too.
//   review — the whole sentence came back with feedback: the same, for the sentence.
//   write  — plain writing: the tutor sees the meaning and the draft, never prepared wording.

// Two wordings count as the same when only case, spacing and punctuation differ. The apostrophe is part
// of the word ("dont" is not "don't"); only its curly and straight forms are treated alike.
export const loose = value => (value || '').normalize('NFKC').toLowerCase().replace(/[‘’]/gu, "'").replace(/[\s.,!?;:"“”。，！？；：、]/gu, '');
const changed = (text, suggestion) => !!suggestion?.trim() && loose(text) !== loose(suggestion);

// The marking a checked chunk came back with, when it asked for anything to change.
export function chunkCorrection(r, index) {
  const input = r?.phrases?.inputs?.[index], item = r?.phrases?.items?.[index], note = input?.note;
  if (!input || !item || !note?.text || note.attempt_id !== input.result?.id) return null;
  const text = input.result.text || '';
  if (input.result.verdict !== 'adjust' && !changed(text, note.suggestion)) return null;
  return { index, meaning: item.meaning, text, suggestion: note.suggestion || '', note: note.text, passed: !!input.completed };
}
// A chunk that passed but is waiting on its feedback: it was worded differently from the prepared chunk
// ("or" where the reference says "and"), or its check still suggested a change. The learner stays on
// it until done talking it over; its prepared wording is on screen now, so it goes along.
export function chunkComparison(r, index) {
  const input = r?.phrases?.inputs?.[index], item = r?.phrases?.items?.[index], result = input?.result;
  if (!result?.cleared || input.completed || !item || !result.text?.trim()) return null;
  const fresh = input.note?.text && input.note.attempt_id === result.id ? input.note : null;
  if (!changed(result.text, item.reference) && !changed(result.text, fresh?.suggestion)) return null;
  return { index, meaning: item.meaning, text: result.text, reference: item.reference.trim(), suggestion: fresh?.suggestion || '', note: fresh?.text || '', passed: true };
}

// `auto` says whether arriving here should start the tutor without a key press.
export function voiceMode(r) {
  if (!r) return null;
  if (r.stage === 'phrases' && r.phrases?.status === 'ready' && r.phrases.index < r.phrases.items.length) {
    const p = r.phrases, i = p.index;
    // Filling the corrections back in is done from memory, with no one talking.
    if (p.step === 'quiz') return null;
    if (p.step === 'learn') return { mode: 'learn', auto: true, key: `learn:${r.id}:${r.window_start}:${i}` };
    const own = p.inputs[i].result?.verdict === 'adjust' ? chunkCorrection(r, i) : chunkComparison(r, i);
    if (own) return { mode: 'fix', auto: true, key: `fix:${r.id}:${p.inputs[i].result.id}`, correction: own };
    return { mode: 'write', auto: false, key: `write:${r.id}:${r.window_start}:${i}` };
  }
  if (r.stage === 'practice') return { mode: 'write', auto: false, key: `write:${r.id}:${r.window_start}:sentence` };
  if (r.stage === 'review') {
    const attempt = r.attempts.at(-1), feedback = r.feedback.findLast(f => f.attempt_id === attempt?.id);
    if (!feedback || r.quiz?.attempt_id === attempt.id) return null;
    return { mode: 'review', auto: changed(attempt.text, feedback.suggestion), key: `review:${r.id}:${attempt.id}`,
      correction: { text: attempt.text, suggestion: feedback.suggestion || '', note: feedback.message, score: Number.isInteger(feedback.score) ? feedback.score : null } };
  }
  return null;
}
