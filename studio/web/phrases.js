import { renderCorrection } from './correction.js';

export function createPhrasesUI({ api, render, getState, error, storageNote = () => {}, renderMarkup = () => null, beforeWrite = () => {}, speak = () => {} }) {
  const $ = id => document.getElementById(id), input = $('phrase-text');
  let current = null, mounted = '', draftKey = '', working = '', composing = false, requested = '', ordered = '', focusPending = false, helpQueue = Promise.resolve();
  let studyKey = '', studyShownAt = 0, autoTimer = null, idleSince = 0, autoAt = 0, autoDraft = null, hintSeen = null;
  // Hints come in the language being learned; hearing them read aloud is listening practice.
  const autoOn = () => $('writing-help-auto').checked, hintLanguage = () => 'target';
  const context = () => current ? { round_id: current.id, window_start: current.window_start, index: current.phrases?.index } : null;
  const contextKey = () => JSON.stringify(context());
  function stash() { try { if (current && draftKey) { localStorage.setItem(draftKey, input.value); storageNote(false); } } catch { storageNote(true); } }
  function forget(key) { try { localStorage.removeItem(key); } catch {} }
  async function send(action, extra = {}) {
    if (!current) return;
    const body = context();
    if (action === 'ensure') delete body.index;
    working = action; render(getState());
    try { render(await api('/phrases/' + action, { ...body, ...extra })); }
    catch (e) { error(e); }
    finally { working = ''; render(getState()); }
  }
  const studying = () => current?.phrases?.status === 'ready' && current.phrases.step === 'learn';
  // Studied (or skipped): the prepared wording leaves the screen and the learner writes from memory.
  async function write() {
    if (!studying() || working) return;
    beforeWrite();
    await send('write');
  }
  function hint() {
    if (!current || composing || ['check', 'continue'].includes(working) || current.phrases?.status !== 'ready' || studying()) return;
    const key = contextKey();
    helpQueue = helpQueue.then(async () => {
      if (contextKey() !== key) return;
      const level = current.phrases.inputs[current.phrases.index].hint_level;
      if (level < 3) await send('hint', { level: level + 1, draft: input.value, hint_language: hintLanguage() });
    });
  }
  const passed = saved => saved?.result?.cleared && saved.result.text === input.value;
  // The check is done with, as long as the text is still what was checked: passed and talked over, or held
  // back and its correction explained. Changing the text and pressing again checks it again instead.
  const settled = saved => !saved?.completed && saved?.result?.text === input.value && (saved.result.cleared || saved.result.verdict === 'adjust');
  // Hints come by themselves, without a button: a first direction when the chunk opens and the box is
  // still empty, a hint about the draft at every pause, and the key words when nothing has changed for a
  // while after a hint. The prepared wording itself only ever comes from Command + [.
  const PAUSE = 1500, START = 4000, STUCK = 10000;
  function scheduleAuto(delay = PAUSE) {
    clearTimeout(autoTimer);
    if (!autoOn() || !current || studying() || composing) return;
    const now = Date.now();
    autoTimer = setTimeout(autoHint, Math.max(0, idleSince + delay - now, autoAt + 2500 - now));
  }
  function autoHint() {
    // Only the window being used asks; another tab or browser open on the same practice stays quiet.
    if (!autoOn() || !current || studying() || composing || working || current.phrases?.status !== 'ready' || current.phrases.step !== 'write' || !document.hasFocus()) return;
    const saved = current.phrases.inputs[current.phrases.index], draft = input.value;
    // The reference is already out, or a check is already speaking for exactly this text.
    if (saved.hint_level >= 3 || saved.result?.text === draft) return;
    // New text (or the empty box at the start) gets a hint about it; the same text again means stuck.
    const level = draft !== autoDraft ? 1 : saved.hint_level < 2 ? 2 : 0;
    if (!level) return;
    autoDraft = draft; autoAt = Date.now();
    const key = contextKey();
    helpQueue = helpQueue.then(async () => {
      if (contextKey() !== key || input.value !== draft || working) return;
      try { render(await api('/phrases/hint', { ...context(), level, draft, auto: true, hint_language: hintLanguage() })); } catch { return; }
      // Still nothing written a while after this hint: the next one is the key words.
      if (level === 1 && contextKey() === key && input.value === draft) { clearTimeout(autoTimer); autoTimer = setTimeout(autoHint, STUCK); }
    });
  }
  async function submit() {
    if (!current || working || composing || studying() || current.phrases?.step === 'quiz') return;
    const saved = current.phrases?.inputs[current.phrases.index];
    // First Command + Enter checks; once the check is settled, the next one moves on.
    if (settled(saved)) {
      const key = contextKey(); await helpQueue;
      if (contextKey() === key) await send('next');
      return;
    }
    if (!input.value.trim()) return;
    const key = contextKey(); await helpQueue;
    if (contextKey() !== key || saved?.result?.verdict === 'checking') return;
    await send('check', { text: input.value, request_id: crypto.randomUUID(), retry: saved.result?.verdict === 'review' });
  }
  // Revealed chunk references must leave the document, not merely be hidden.
  function clearWork() {
    for (const id of ['phrase-progress', 'phrase-meaning', 'phrase-hint-text', 'phrase-feedback', 'phrase-marking']) $(id).textContent = '';
    $('phrase-marking').hidden = true;
    input.value = ''; mounted = ''; focusPending = false;
  }
  function update(r, busy) {
    const previous = current;
    current = r?.stage === 'phrases' ? r : null;
    $('phrase-region').hidden = !current;
    if (previous && r?.id === previous.id && r.phrases?.inputs?.[previous.phrases?.index]?.completed) forget(`phrase-draft:${r.id}:${previous.phrases.run || 0}:${previous.phrases.index}`);
    if (!current) { clearWork(); return; }
    const p = current.phrases, ready = p?.status === 'ready';
    $('phrase-work').hidden = !ready;
    $('phrase-retry').hidden = ready || p?.status === 'pending' || working === 'ensure';
    $('phrase-retry').disabled = !!working || busy;
    $('phrase-status').textContent = ready ? '' : p?.status === 'error' ? p.message : p?.status === 'pending' || working === 'ensure' ? '正在按意思拆解这一句…' : '正在准备短语材料…';
    if (!p && requested !== `${r.id}:${r.window_start}` && !busy && !working) {
      requested = `${r.id}:${r.window_start}`;
      queueMicrotask(() => { if (current && `${current.id}:${current.window_start}` === requested) void send('ensure'); });
    }
    if (!ready) { clearWork(); return; }
    // Worked out once per sentence, in the background: it must never hold up writing.
    if (!p.order && ordered !== `${r.id}:${r.window_start}` && !busy && !working) {
      ordered = `${r.id}:${r.window_start}`;
      queueMicrotask(async () => {
        try { render(await api('/phrases/order', { round_id: r.id, window_start: r.window_start })); } catch {}
      });
    }
    const item = p.items[p.index], saved = p.inputs[p.index];
    if (!item) return;
    const reviewing = saved?.result?.cleared && !saved.completed;
    $('phrase-progress').textContent = `短语 ${p.index + 1} / ${p.items.length}${studying() ? ' · 先学' : p.step === 'quiz' ? ' · 改错' : reviewing ? ' · 点评' : ''}`;
    // The Chinese in the order the target language will need it, once that has been worked out.
    const parts = p.order?.[p.index]?.length ? p.order[p.index] : [item.meaning];
    $('phrase-meaning').replaceChildren();
    for (const [i, part] of parts.entries()) {
      if (i) {
        const gap = document.createElement('span');
        gap.className = 'order-gap'; gap.textContent = '·'; $('phrase-meaning').append(gap);
      }
      const span = document.createElement('span');
      span.className = 'order-part'; span.textContent = part; $('phrase-meaning').append(span);
    }
    // While the chunk is studied its wording is on screen, so there is nothing to write into yet; while its
    // corrections are filled back in, the quiz has the desk.
    const quizzing = p.step === 'quiz';
    $('phrase-work').hidden = studying() || quizzing;
    if (studying() || quizzing) {
      for (const id of ['phrase-hint-text', 'phrase-feedback', 'phrase-marking']) $(id).textContent = '';
      $('phrase-marking').hidden = true;
      input.value = ''; mounted = ''; draftKey = ''; focusPending = false;
      const key = `${r.id}:${r.window_start}:${p.index}`;
      if (key !== studyKey) { studyKey = key; studyShownAt = Date.now(); }
      return;
    }
    const key = `${r.id}:${r.window_start}:${p.index}`;
    if (key !== mounted) {
      mounted = key; draftKey = `phrase-draft:${r.id}:${p.run || 0}:${p.index}`; autoDraft = null; hintSeen = null;
      // A chunk that opens with an empty box gets a first direction without waiting to be asked.
      idleSince = Date.now(); scheduleAuto(START);
      try { input.value = localStorage.getItem(draftKey) ?? saved.text; } catch { input.value = saved.text; }
      focusPending = true;
    }
    const checking = saved.result?.verdict === 'checking';
    // While a check runs the box is only read-only: disabling it would throw the cursor out of it, and
    // the next Command + Enter would then land nowhere.
    input.disabled = busy; input.readOnly = checking || ['check', 'continue'].includes(working); input.lang = r.language;
    if (focusPending && !input.disabled) requestAnimationFrame(() => {
      if (mounted === key && current && !input.disabled && focusPending) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); focusPending = false; }
    });
    // Live hints are written for this attempt; the prepared ones remain the fallback.
    const shown = saved.hint_level === 3 ? [`参考：${item.reference}`]
      : Array.from({ length: saved.hint_level }, (_, i) => saved.hints?.[i] || item.hints[i]);
    $('phrase-hint-text').textContent = shown.join(' · ');
    // A hint that arrives while writing is read aloud once — whichever line changed, the newest level
    // first (a fresh pause hint replaces the first line even after the key words); hints already there
    // when the chunk opens are not.
    const lines = saved.hint_level === 3 ? [item.reference] : shown;
    if (hintSeen === null) hintSeen = lines;
    else if (lines.join('\n') !== hintSeen.join('\n')) {
      const fresh = [...lines].reverse().find((line, i) => line !== hintSeen[lines.length - 1 - i]);
      hintSeen = lines;
      if (fresh) speak(fresh, r.language);
    }
    const confirming = settled(saved);
    $('phrase-check').disabled = busy || !!working || checking || (!confirming && !input.value.trim());
    // A running check is only shown by the button resting; no status line announces it.
    $('phrase-check').textContent = confirming ? (passed(saved) ? '继续 · ⌘ ↵' : '不改了，继续 · ⌘ ↵')
      : saved.result?.verdict === 'review' ? '重试检查 · ⌘ ↵' : '检查 · ⌘ ↵';
    $('phrase-continue').hidden = saved.hint_level !== 3;
    $('phrase-continue').disabled = busy || !!working;
    // Gemini's line about this attempt replaces the generic verdict message once it lands.
    const note = saved.note?.attempt_id && saved.note.attempt_id === saved.result?.id ? saved.note : null;
    // Red pen on the chunk they wrote, drawn from the correction that came back with the note.
    const marked = note?.suggestion && saved.result?.text
      ? renderCorrection($('phrase-marking'), { text: saved.result.text, corrected: note.suggestion, changes: note.changes || [], language: r.language }) : null;
    if (!marked) { $('phrase-marking').replaceChildren(); }
    // Once it passed, the card below the box carries the marking and the note alongside the prepared wording.
    $('phrase-marking').hidden = !marked?.changes || reviewing;
    $('phrase-feedback').textContent = !checking && !reviewing && saved.result?.text === input.value ? note?.text || saved.result.message || '' : '';
    $('phrase-feedback').dataset.status = !checking && note && saved.result?.text === input.value ? note.status : '';
  }
  input.oninput = () => { stash(); update(current, false); idleSince = Date.now(); scheduleAuto(); };
  input.oncompositionstart = () => { composing = true; clearTimeout(autoTimer); };
  input.oncompositionend = () => { composing = false; stash(); idleSince = Date.now(); scheduleAuto(); };
  input.onkeydown = event => {
    if (event.isComposing || composing || event.repeat) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) { event.preventDefault(); void submit(); }
  };
  $('phrase-check').onclick = submit;
  $('phrase-continue').onclick = async () => { if (!working && !composing) { const key = contextKey(); await helpQueue; if (contextKey() === key) await send('continue', { text: input.value }); } };
  $('phrase-retry').onclick = () => send('ensure', { retry: true });
  // Command + Enter belongs to the chunk wherever the cursor is, unless it is in another field. Nothing
  // has the cursor while a chunk is studied; the same keys just moved on from the last chunk, so a
  // quick second press must not skip studying this one.
  document.addEventListener('keydown', event => {
    if (!current || composing || event.isComposing || event.repeat || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (studying()) { event.preventDefault(); if (Date.now() - studyShownAt > 800) void write(); return; }
    if (current.phrases?.status !== 'ready' || event.target === input || event.target.closest?.('textarea, input, select, [contenteditable="true"]')) return;
    event.preventDefault(); input.focus(); void submit();
  });
  return { update, hint, write, async flush() { clearTimeout(autoTimer); stash(); await helpQueue; } };
}
