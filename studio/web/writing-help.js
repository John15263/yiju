import { createHintLog, sentenceHints } from './hint-log.js';

export function createWritingHelpUI({ api, render, speak = () => {}, replay = () => {} }) {
  const $ = id => document.getElementById(id), input = $('writing-text');
  // Every hint shown while the sentence is written stays in the list, the newest at the bottom.
  const log = createHintLog($('writing-help-log'), { onPick: entry => replay(entry.spoken, round?.language) });
  // Background preparation is separate from display: an unrequested hint never rises above the Chinese idea.
  const AUTO_LEVEL = 1;
  let round = null, locked = false, composing = false, observed = '', practiceKey = '', version = 0, timer = null, idleSince = 0;
  let hint = null, level = 1, displayed = 0, flight = null, queuedManual = '', lastRequest = 0, seenQueue = Promise.resolve(), stuckTimer = null;
  // Still nothing written a while after the idea was shown: the next word follows by itself. Only the
  // word; the phrase and the full continuation still wait for Command + [.
  const STUCK = 10000;
  const snapshot = () => round ? { round_id: round.id, window_start: round.window_start, draft: input.value, caret: input.selectionStart } : null;
  const key = s => s ? JSON.stringify(s) : '';
  const status = message => { $('writing-help-status').textContent = message; };
  function clear() { log.clear(); }
  function valid(s, v) { return version === v && key(snapshot()) === key(s); }
  function present(result, s, v, showing) {
    seenQueue = seenQueue.then(async () => {
      if (!valid(s, v)) return;
      const state = await api('/writing-help/seen', { round_id: s.round_id, window_start: s.window_start, hint_id: result.hint_id, level: showing });
      render(state);
      if (!valid(s, v) || showing !== level) return;
      displayed = Math.max(displayed, showing);
      // The list shows it once the practice has recorded it (render above); here it is read aloud.
      status('');
      speak(showing === 1 ? result.meaning : result[['', '', 'word', 'phrase', 'continuation'][showing]], round.language);
      clearTimeout(stuckTimer);
      if (showing === 1 && result.status !== 'complete' && result.word && $('writing-help-auto').checked) stuckTimer = setTimeout(() => {
        if (valid(s, v) && displayed < 2 && !locked && !composing) { level = 2; present(result, s, v, 2); }
      }, STUCK);
    }).catch(e => { if (valid(s, v)) status(`${e.message} 草稿保留，可以再按 Command + [。`); });
  }
  function schedule(manual = false) {
    clearTimeout(timer);
    // Only the window being used asks by itself; another one open on the same practice stays quiet.
    if (!round || locked || composing || (!manual && (!$('writing-help-auto').checked || !document.hasFocus()))) return;
    const now = Date.now();
    // Every hint stays in the list, so they may come quickly: after a 1 s pause, 1.5 s apart (2026-09-27; was 1.5 s and 2.5 s).
    timer = setTimeout(() => request(manual), manual ? 0 : Math.max(0, idleSince + 1000 - now, lastRequest + 1500 - now));
  }
  async function request(manual = false) {
    if (!round || locked || composing) return;
    const s = snapshot(), currentKey = key(s), v = version;
    const showing = manual ? level : AUTO_LEVEL;
    if (!manual) level = AUTO_LEVEL;
    if (hint) { present(hint, s, v, showing); return; }
    if (flight) { if (manual) queuedManual = currentKey; return; }
    const running = { key: currentKey }; flight = running; lastRequest = Date.now();
    try {
      const result = await api('/writing-help', { ...s, retry: manual, hint_language: 'target' });
      if (!valid(s, v)) return;
      hint = result; present(result, s, v, showing);
    } catch (e) { if (valid(s, v)) status(`${e.message} 草稿保留；需要时再按 Command + [。`); }
    finally {
      flight = null;
      const latest = key(snapshot()), manualQueued = queuedManual === latest;
      queuedManual = '';
      // Changed drafts get their own hint; failed requests never auto-retry unchanged text.
      if (latest && !hint && (latest !== running.key || manualQueued)) schedule(manualQueued);
    }
  }
  function changed() {
    const s = snapshot(), next = key(s);
    if (next === observed) return;
    observed = next; version++; idleSince = Date.now(); clearTimeout(timer); clearTimeout(stuckTimer); hint = null; level = 1; displayed = 0;
    const nextPractice = s ? JSON.stringify([s.round_id, s.window_start]) : '';
    // Invalidate the request snapshot immediately, but keep visible help until its replacement is ready.
    if (nextPractice !== practiceKey) {
      // The list follows the practice's own record, so it is not emptied here.
      practiceKey = nextPractice;
      // The helper area stays empty until help is asked for.
      status('');
    }
    schedule();
  }
  function advance() {
    if (!round || locked || composing) return;
    changed(); clearTimeout(timer);
    // The ladder always starts at the Chinese idea and rises one step per request.
    level = Math.min(4, displayed + 1);
    void request(true);
  }
  input.addEventListener('input', changed);
  input.addEventListener('focus', changed);
  input.addEventListener('click', changed);
  input.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) changed(); });
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); version++; hint = null; });
  input.addEventListener('compositionend', () => { composing = false; observed = ''; changed(); });
  $('writing-help-auto').onchange = () => {
    clearTimeout(timer);
    if ($('writing-help-auto').checked) schedule();
    else { version++; queuedManual = ''; }
  };
  return {
    advance,
    update(r, busy) {
      const wasLocked = locked;
      round = r?.stage === 'practice' ? r : null; locked = busy;
      if (round) log.render(sentenceHints(round)); else log.clear();
      changed();
      // The sentence often opens while the page is still busy with the command that opened it, when
      // nothing may be scheduled; once that ends, the empty box still gets its first hint.
      if (wasLocked && !locked) schedule();
    },
    reading: text => log.reading(text),
    async flush() {
      // Submission/navigation waits only for displayed-help records, never for generation.
      clearTimeout(timer); clearTimeout(stuckTimer); version++; queuedManual = ''; hint = null; displayed = 0; clear(); await seenQueue;
    },
  };
}
