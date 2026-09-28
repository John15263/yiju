// Hints that come by themselves wait until the learner has written a good part on their own (the learner,
// 2026-09-28): 40% of the prepared wording's words, rounded down — 4 of 10, 2 of 6, 8 of 20. Words are
// counted as the language splits them, so Japanese, written without spaces, is counted too.
export const HINT_SHARE = 0.4;
export const wordsIn = (text, language) => [...new Intl.Segmenter(language === 'ja' ? 'ja' : 'en', { granularity: 'word' })
  .segment(text || '')].filter(part => part.isWordLike).length;
export const hintThreshold = (reference, language) => Math.floor(wordsIn(reference, language) * HINT_SHARE);
export const hintsOpen = (draft, reference, language) => wordsIn(draft, language) >= hintThreshold(reference, language);
