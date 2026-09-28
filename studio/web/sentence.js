import { createClozeUI } from './cloze.js';
import { createComposeUI } from './compose.js';
import { createFreewriteUI } from './freewrite.js';
import { renderOutline, roleLabel } from './expression.js';
import { createWritingHelpUI } from './writing-help.js';
import { createPhrasesUI } from './phrases.js';
import { createVoiceUI } from './voice.js';
import { createSpeech } from './speech.js';
import { renderCorrection } from './correction.js';
import { createQuizUI } from './quiz.js';
import { createTransferUI } from './transfer.js';
import { createExplainUI } from './explain.js';
import { voiceMode, chunkComparison, loose } from './voice-mode.js';
import { deskView, markup, openQuiz, supportSummary, SUPPORT_LEVELS } from './view.js';
import { request, subscribe, speak, onSource } from './backend.js';
import { createSettings } from './settings.js';
import { dollars, googleDayStart, speechCounts } from './usage-text.js';
const $ = id => document.getElementById(id);
let state = null, busy = false, reviewBusy = false, settings = null, writingKey = null, drawer = null;
// The moment that starts a call by itself (a chunk to study, a correction to explain) at the last render;
// undefined until the first state, so a reload never starts a call.
const stages = { study: '理解', phrases: '短语学习与试写', cloze: '旧版填空', practice: '整句试写', awaiting_feedback: '等待反馈', review: '反馈', transfer: '换个场合', complete: '本轮完成', paused: '已暂停' };
const panels = { chapter: '这段表达', completion: '上一句', voice: '语音陪练', feedback: '完整点评', records: '练习记录与设置' };
const footButtons = ['phrase-write', 'start-phrases', 'practice', 'complete', 'gemini-review', 'resume', 'repeat', 'finish-new', 'phrase-retry', 'start-cloze', 'voice-open'];
const show = (id, visible) => { $(id).hidden = !visible; };
const put = (id, value) => { $(id).textContent = value; };
const api = (path, body) => request('/api/sentence' + path, body);
// Who wrote a piece of feedback, by the service that was set when it was asked for.
const WRITERS = { gemini: 'Gemini', deepseek: 'DeepSeek', qwen: '千问' };
// Hints and explanations are read by Gemini's speech model or by the browser's own voices, as set in settings.
// Who reads aloud: 'mixed' has Gemini read the explanations and the browser the hints.
const speechBy = () => settings?.speech_provider || 'browser';
const hintsByBrowser = () => speechBy() !== 'gemini', explainByBrowser = () => speechBy() === 'browser';
function error(e) { put('error', e.message); show('error', true); }
// The learner's own sentence, marked against the returned suggestion. Nothing here is invented.
function renderMarkup(id, text, suggestion, language) {
  const node = $(id); node.replaceChildren(); node.lang = language || '';
  if (!text) return null;
  const marked = suggestion ? markup(text, suggestion, language) : null;
  if (!marked || !marked.changes) { node.textContent = text; return marked; }
  let touching = false;
  for (const part of marked.parts) {
    if (part.type === 'kept') { node.append(part.text); touching = false; continue; }
    // The mark hugs its words; the spaces around it stay plain, so the text reads unchanged.
    const [, lead, core, tail] = part.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const mark = document.createElement(part.type === 'cut' ? 'del' : 'ins');
    mark.textContent = core;
    // "butBut" needs air between the crossed-out word and its replacement.
    if (touching && !lead) mark.classList.add('after-mark');
    if (lead) node.append(lead);
    if (core) node.append(mark);
    if (tail) node.append(tail);
    touching = !!core && !tail;
  }
  return marked;
}
// A draft that could not be written locally is said plainly; the text itself is never dropped.
function storageNote(failed) { put('storage-note', failed ? '这次草稿没能保存在本机。文字还在输入框里，离开这一句前请先复制。' : ''); show('storage-note', failed); }
async function command(type, payload = {}) {
  if (busy || !state) return;
  const startingRound = state.active?.id;
  busy = true; render(state); show('error', false);
  try {
    if (state.active?.stage === 'practice') await writingHelpUI.flush();
    if (state.active?.stage === 'cloze') await clozeUI.flush();
    if (state.active?.stage === 'phrases') await phrasesUI.flush();
    voiceUI.stop();
    if (state.active?.id !== startingRound) return;
    render(await api('/commands', { command_id: crypto.randomUUID(), expected_revision: state.revision, type, payload })); return true;
  }
  catch (e) { error(e); try { render(await api('')); } catch {} }
  finally { busy = false; render(state); }
}
// One drawer at a time; closing returns to the writing position that opened it.
function openDrawer(mode, { focus = true } = {}) {
  drawer = mode; render(state);
  // The voice panel is opened while writing continues, so it never takes the cursor.
  if (focus) requestAnimationFrame(() => $('drawer-close').focus());
}
function closeDrawer() {
  if (!drawer) return;
  drawer = null; render(state);
  const input = state?.active?.stage === 'phrases' ? 'phrase-text' : state?.active?.stage === 'practice' ? 'writing-text' : null;
  if (input && !$(input).disabled) requestAnimationFrame(() => $(input).focus());
}
function drawerFor(r, view) {
  if (!drawer) return null;
  if (drawer === 'chapter') return state.collection ? 'chapter' : null;
  if (drawer === 'completion') return state.completion ? 'completion' : null;
  if (drawer === 'voice') return voiceMode(r) ? 'voice' : null;
  if (drawer === 'feedback') return view?.input === 'response' ? 'feedback' : null;
  return drawer;
}
function render(next) {
  if (!next || (state && next.revision < state.revision)) return;
  const oldRound = state?.active?.id, oldStage = state?.active?.stage, oldCompletion = state?.completion?.round_id;
  state = next; const r = state.active;
  put('gemini-setting', !settings ? '正在读取服务设置…' : settings.gemini_configured ? `文字：${settings.text_name} · ${settings.gemini_model}；语音陪练：${settings.voice_configured ? settings.voice_name : settings.voice_provider === 'none' ? '不用' : '还没配好'}；朗读：${{ mixed: '讲解 Gemini、提示浏览器自带', gemini: 'Gemini', browser: '浏览器自带' }[speechBy()] || '浏览器自带'}` : '还没有配好文字服务：点下面的「服务与 key」选服务商、填 key。');
  put('cloze-review-note', !settings ? '正在读取整句审查设置…' : settings.gemini_configured ? `保存后由 ${settings.text_name} 自动检查整句，反馈直接显示在这里。` : '整句审查尚未启用：先在「服务与 key」里配好文字服务。仍可保存。');
  const composing = composeUI.update(state, settings);
  const freewriting = freewriteUI.isOpen();
  clozeUI.update(composing || freewriting ? null : r);
  phrasesUI.update(composing || freewriting ? null : r, busy);
  document.body.classList.toggle('is-freewriting', freewriting);
  show('compose', composing && !freewriting);
  $('board').classList.toggle('is-cloze', r?.stage === 'cloze');
  document.body.classList.toggle('has-cloze', r?.stage === 'cloze');
  const onDesk = !!r && !composing && !freewriting;
  show('board', onDesk);
  if (oldRound !== r?.id || oldStage !== r?.stage) { $('explanation-panel').open = false; storageNote(false); }

  const view = onDesk ? deskView({ state, settings }) : null;
  if (!onDesk && drawer) drawer = null;
  // A finished sentence takes its conversation with it: the panel closes here and opens again, empty,
  // when the next sentence's first lesson starts.
  if (drawer === 'voice' && oldRound && r && oldRound !== r.id) drawer = null;
  if (oldRound !== r?.id || oldStage !== r?.stage) $('collection-reference-panel').open = false;

  // Top bar stays quiet: sentence position and the more menu, nothing else.
  show('unit-badge', !!view);
  put('language', view ? (r.language === 'en' ? '英语' : '日语') : '');
  put('unit-position', state.collection ? ` · ${state.collection.active_index + 1} / ${state.collection.units.length}` : '');
  // A single sentence has no passage to open; the badge then only names the language.
  $('unit-badge').querySelector('.caret').hidden = !state.collection;
  show('demo', !!view && view.demo);
  show('more-menu', onDesk);

  const completion = state.completion;
  if (oldCompletion !== completion?.round_id && drawer === 'completion') drawer = null;
  show('completion-hint', !!view && !!view.completion);
  put('completion-label', view?.completion || '');
  const priorScore = completion?.feedback?.score;
  put('completion-score', Number.isInteger(priorScore) ? `${priorScore} / 100 · ${completion.reason === 'score' ? '已通过' : '已完成'}` : completion ? '已完成' : '');
  renderMarkup('completion-answer', completion?.text || '', completion?.feedback?.suggestion, r?.language);
  put('completion-feedback', completion?.feedback?.message || '');
  put('completion-suggestion', completion?.feedback?.suggestion ? `参考表达：${completion.feedback.suggestion}` : '');

  $('unit-select').replaceChildren();
  const collection = state.collection;
  if (collection && view) {
    const index = collection.active_index, units = collection.units;
    put('unit-purpose', `${roleLabel(r.unit.role)} · ${r.unit.purpose}`);
    put('unit-connection', r.unit.connection);
    put('collection-summary', collection.outline.summary);
    renderOutline($('collection-outline'), collection.outline);
    for (const unit of units) $('unit-select').add(new Option(`${unit.index + 1}. ${unit.purpose} · ${unit.meaning}`, unit.id));
    $('unit-select').value = r.id;
    const navigating = busy || r.stage === 'awaiting_feedback';
    $('unit-select').disabled = navigating;
    $('unit-prev').disabled = navigating || index === 0;
    $('unit-next').disabled = navigating || index === units.length - 1;
    // The whole-passage reference is only reachable from the demonstration stage.
    const referencesVisible = r.stage === 'study';
    show('collection-reference-panel', referencesVisible);
    put('collection-reference', referencesVisible ? units.map(u => u.reference).join(r.language === 'ja' ? '' : ' ') : '');
    $('collection-reference').lang = r.language;
  } else {
    for (const id of ['unit-purpose', 'unit-connection', 'collection-summary', 'collection-reference']) put(id, '');
    $('collection-outline').replaceChildren();
  }

  $('history').replaceChildren();
  if (!state.history.length) $('history').add(new Option('还没有练习记录', ''));
  for (const item of [...state.history].reverse()) {
    const matching = state.history.filter(h => h.meaning === item.meaning && h.language === item.language);
    const roundLabel = matching.length > 1 ? `第 ${matching.findIndex(h => h.id === item.id) + 1} 轮 · ` : '';
    $('history').add(new Option(`${item.origin === 'demo' ? '示例 · ' : ''}${item.language === 'en' ? '英语' : '日语'} · ${item.unit_index !== undefined ? `第 ${item.unit_index + 1} 句 · ` : ''}${roundLabel}${item.meaning}`, item.id));
  }
  $('history').value = r?.id || ''; $('history').disabled = busy || !r;
  put('stage-label', r ? `当前状态：${stages[r.stage]}` : '');
  $('attempt-history').replaceChildren();

  if (view) {
    const phraseContext = view.context.source === 'phrase';
    show('task-label', !phraseContext && !!view.context.eyebrow); put('task-label', view.context.eyebrow);
    show('meaning', !phraseContext && !!view.context.heading); put('meaning', view.context.heading);
    show('phrase-progress', phraseContext); show('phrase-meaning', phraseContext);

    show('writing-region', view.input === 'writing');
    // The chunk's wording is in the document only while it is being studied, never while it is written.
    show('learn-region', view.input === 'learn');
    put('learn-reference', view.learn?.reference.trim() || ''); $('learn-reference').lang = r.language;
    put('learn-hint', view.learn?.hint || '');
    show('study-region', r.stage === 'study');
    show('response', view.input === 'response');
    put('study-text', r.stage === 'study' ? r.reference : ''); $('study-text').lang = r.language;
    put('explanation', r.stage === 'study' ? r.explanation : '');

    // Scaffolds exist in the document only while the learner is asking for them.
    show('prompt-region', view.showPrompt);
    $('prompt-text').replaceChildren(); $('prompt-text').classList.remove('empty'); $('prompt-text').lang = r.language;
    if (view.showPrompt) {
      const level = r.support_level;
      put('prompt-label', SUPPORT_LEVELS[level]);
      if (level === 1) for (const word of r.keywords) { const span = document.createElement('span'); span.className = 'chunk'; span.textContent = word; $('prompt-text').append(span); }
      else put('prompt-text', level === 2 ? r.frame : r.reference);
    }
    // A chunk that passed but reads differently from its prepared wording waits here with its feedback —
    // what was written (red pen where the check suggested a change), the prepared wording, the note —
    // until the learner moves on. The next chunk starts clean.
    // The card would give the quiz away, so it is off the desk while the corrections are filled back in.
    const comparison = r.stage === 'phrases' && r.phrases?.status === 'ready' && r.phrases.step === 'write' ? chunkComparison(r, r.phrases.index) : null;
    show('chunk-note', !!comparison);
    if (comparison) {
      // Corrected by the check: what was written against the correction, with the prepared wording below
      // when it differs again. Otherwise: what was written against the prepared wording itself.
      const rewritten = comparison.suggestion && loose(comparison.suggestion) !== loose(comparison.text);
      const corrected = rewritten ? comparison.suggestion : comparison.reference;
      put('chunk-note-label', '这一块 · 点评');
      renderCorrection($('chunk-note-marking'), { text: comparison.text, corrected, language: r.language,
        label: rewritten ? '改成' : '参考写法', changes: rewritten ? r.phrases.inputs[r.phrases.index].note?.changes || [] : [] });
      show('chunk-note-reference-row', rewritten && loose(comparison.reference) !== loose(comparison.suggestion));
      put('chunk-note-reference', comparison.reference); $('chunk-note-reference').lang = r.language;
      put('chunk-note-text', comparison.note);
      $('chunk-note').dataset.status = '';
    } else { $('chunk-note-marking').replaceChildren(); put('chunk-note-reference', ''); put('chunk-note-text', ''); }


    if (view.input === 'writing') {
      const key = `sentence-writing:${r.id}:${r.attempts.length}`;
      if (writingKey !== key) {
        writingKey = key;
        let stored = null; try { stored = localStorage.getItem(key); } catch {}
        // A revision starts from the previous answer, but never over a draft the learner already has.
        $('writing-text').value = stored ?? (r.attempts.at(-1)?.text || '');
      }
      $('writing-text').lang = r.language; $('writing-text').disabled = busy;
      $('writing-submit').disabled = busy || !$('writing-text').value.trim();
      put('writing-submit', settings?.gemini_configured ? '看看表达 · ⌘ ↵' : '保存这次表达 · ⌘ ↵');
    }

    const latest = r.attempts.at(-1), feedback = r.feedback.findLast(f => f.attempt_id === latest?.id);
    const geminiReview = r.reviews?.findLast(f => f.attempt_id === latest?.id);
    const reviewing = geminiReview?.status === 'pending';
    const responding = view.input === 'response';
    const marked = renderCorrection($('attempt-text'), { text: responding ? latest?.text || '' : '', corrected: feedback?.suggestion,
      changes: feedback?.changes || [], language: r.language });
    put('answer-label', marked?.changes ? `这次的表达 · ${marked.summary}` : '这次的表达');
    show('feedback-label', responding && !!feedback);
    put('feedback-label', feedback ? `${WRITERS[feedback.provider] || 'Codex'} 的反馈` : '');
    put('feedback-text', responding ? feedback?.message || '' : '');
    show('feedback-open', responding && !!feedback);
    const scored = responding && Number.isInteger(feedback?.score);
    show('feedback-score', scored);
    put('feedback-score', scored ? `本句表达 ${feedback.score} / 100${feedback.score > 95 ? ' · 已通过' : ''}` : '');
    show('suggestion-region', responding && !!feedback?.suggestion);
    put('suggestion', responding ? feedback?.suggestion || '' : '');
    put('direction', view.note); show('direction', !!view.note);

    for (const id of footButtons) show(id, view.primary?.id === id || view.weak.some(w => w.id === id));
    if (view.primary?.label) put(view.primary.id, view.primary.label);
    for (const item of view.weak) if (item.label) put(item.id, item.label);
    for (const id of footButtons) $(id).classList.toggle('primary', view.primary?.id === id);
    $('phrase-check').classList.toggle('primary', view.primary?.id === 'phrase-check');
    $('phrase-continue').classList.toggle('primary', view.primary?.id === 'phrase-continue');
    if (view.primary?.id === 'gemini-review') $('gemini-review').disabled = reviewBusy || busy || reviewing;
    for (const id of footButtons) if (id !== 'gemini-review' && id !== 'phrase-retry') $(id).disabled = busy;

    // Practice keeps prior answers and feedback out of sight; records stay complete in the drawer.
    if (['practice', 'phrases', 'cloze'].includes(r.stage)) {
      const note = document.createElement('p'); note.className = 'footnote'; note.textContent = '试写时先收起旧答案；完成或回看示范后可以查看记录。'; $('attempt-history').append(note);
    } else for (const a of r.attempts) {
      const item = document.createElement('div'); item.className = 'attempt';
      const label = document.createElement('small');
      const score = r.feedback.findLast(f => f.attempt_id === a.id)?.score;
      label.textContent = `${a.source === 'simulation' ? '模拟回答' : '实际表达'} · ${new Date(a.at).toLocaleString()}${Number.isInteger(score) ? ` · ${score} / 100` : ''} · ${supportSummary(a).text}`;
      const content = document.createElement('p'); content.textContent = a.text; item.append(label, content); $('attempt-history').append(item);
    }
  } else {
    for (const id of footButtons) show(id, false);
    for (const id of ['meaning', 'task-label', 'phrase-progress', 'phrase-meaning', 'learn-reference', 'learn-hint', 'study-text', 'explanation', 'attempt-text', 'feedback-text', 'direction']) put(id, '');
    show('completion-hint', false); writingKey = null;
  }

  const panel = drawerFor(r, view);
  if (drawer && !panel) drawer = null;
  show('drawer', !!panel);
  put('drawer-title', panel ? panels[panel] : '');
  for (const name of Object.keys(panels)) show('panel-' + name, panel === name);
  document.body.classList.toggle('has-drawer', !!panel);

  writingHelpUI.update(composing || freewriting ? null : r, busy);
  quizUI.update(composing || freewriting || !onDesk ? null : r);
  transferUI.update(composing || freewriting || !onDesk ? null : state);
  voiceUI.update(composing || freewriting ? null : r);
  // Arriving at a chunk's study, at a correction, or at the sentence's feedback reads its explanation;
  // the live tutor is only ever opened by hand now, to ask about it.
  explainUI.update(view ? r : null);
  if (oldStage === 'phrases' && r?.stage === 'practice' && oldRound === r.id) requestAnimationFrame(() => { if (state.active?.id === r.id && state.active.stage === 'practice') $('writing-text').focus(); });
  const renderedRevision = state.revision;
  requestAnimationFrame(() => requestAnimationFrame(() => { api('/view-ack', { rendered_revision: renderedRevision }).catch(() => {}); }));
}
const clozeUI = createClozeUI({ getState: () => state, api, render, error, command });
// Hints are also read aloud, except while the tutor is talking.
// The hint being read is marked in whichever list holds it.
const hintLists = [];
const speech = createSpeech({ enabled: () => $('hint-speech').checked, busy: () => voiceUI.isOpen() || explainUI.busy(), engine: () => hintsByBrowser() ? 'system' : 'gemini', fetcher: speak,
  onReading: text => { for (const list of hintLists) list.reading(text); },
  report: result => put('hint-speech-status', result.ok ? `最近一次：已出声（${result.voice}）` : `最近一次：没出声，${result.reason}`) });
// Starting to write ends the learning conversation first, so it never runs on into writing.
const phrasesUI = createPhrasesUI({ getState: () => state, api, render, error, storageNote, renderMarkup, beforeWrite: () => voiceUI.stop(), speak: speech.say, replay: speech.replay });
const composeUI = createComposeUI({ api, render, command, getState: () => state, error, beforeOpen: async () => { drawer = null; await clozeUI.flush(); await phrasesUI.flush(); } });
const freewriteUI = createFreewriteUI({ api, onChange: () => render(state), onUse: text => composeUI.useWriting(text), onReturn: () => composeUI.openEntry() });
const writingHelpUI = createWritingHelpUI({ api, render, speak: speech.say, replay: speech.replay });
hintLists.push(phrasesUI, writingHelpUI);
const quizUI = createQuizUI({ api, render, getState: () => state, error });
const transferUI = createTransferUI({ api, render, getState: () => state, error });
// A hint read aloud never talks over an explanation, and an explanation starting ends one.
const explainUI = createExplainUI({ api, auto: () => $('voice-auto').checked, before: () => speech.stop(), engine: () => explainByBrowser() ? 'browser' : 'gemini', fetcher: speak });
const voiceUI = createVoiceUI({ getState: () => state, render, error, quiet: () => { speech.stop(); explainUI.stop(); },
  // Nothing is being written while a chunk is studied or feedback is read, so the tutor is not told about a draft box.
  draftOf: () => {
    const r = state?.active, mode = voiceMode(r)?.mode;
    if (!r || mode === 'learn' || mode === 'review') return '';
    return (r.stage === 'phrases' ? $('phrase-text') : $('writing-text')).value;
  } });
// On unless this browser was told otherwise; the choices are per-viewer conveniences.
for (const [id, key] of [['writing-help-auto', 'auto-hint'], ['voice-auto', 'auto-voice'], ['hint-speech', 'hint-speech']]) {
  try { $(id).checked = localStorage.getItem(key) !== 'off'; } catch {}
  $(id).addEventListener('change', () => { try { localStorage.setItem(key, $(id).checked ? 'on' : 'off'); } catch {} });
}
$('hint-speech').addEventListener('change', () => { if (!$('hint-speech').checked) speech.stop(); });
$('hint-speech-test').onclick = () => { put('hint-speech-status', '正在试听…'); speech.test(state?.active?.language); };
$('start-freewrite').onclick = () => freewriteUI.start();
$('repeat').onclick = () => command('repeat');
$('writing-text').oninput = () => {
  try { if (writingKey) localStorage.setItem(writingKey, $('writing-text').value); storageNote(false); } catch { storageNote(true); }
  $('writing-submit').disabled = busy || !$('writing-text').value.trim();
};
async function submitWriting() {
  if (busy || state?.active?.stage !== 'practice' || !$('writing-text').value.trim()) return;
  const r = state.active, key = writingKey, parent = r.attempts.at(-1);
  const payload = { text: $('writing-text').value, source: parent ? 'user_revision' : 'typed_original' };
  if (parent) payload.parent_attempt_id = parent.id;
  if (await command('attempt', payload)) { try { localStorage.removeItem(key); } catch {} }
}
$('writing-submit').onclick = submitWriting;
$('writing-text').onkeydown = event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !event.repeat) { event.preventDefault(); submitWriting(); }
};
$('start-cloze').onclick = () => command('start_cloze');
$('phrase-write').onclick = () => phrasesUI.write();
$('start-phrases').onclick = () => command('start_phrases');
$('practice').onclick = () => command('practice');
$('complete').onclick = () => command('complete');
$('resume').onclick = () => command('resume');
$('finish-new').onclick = () => composeUI.openCompose();
$('unit-select').onchange = () => { const id = $('unit-select').value; closeDrawer(); command('select', { id }); };
$('unit-prev').onclick = () => { const c = state.collection; if (c?.active_index > 0) { closeDrawer(); command('select', { id: c.units[c.active_index - 1].id }); } };
$('unit-next').onclick = () => { const c = state.collection; if (c && c.active_index + 1 < c.units.length) { closeDrawer(); command('select', { id: c.units[c.active_index + 1].id }); } };
$('history').onchange = () => { const id = $('history').value; closeDrawer(); command('select', { id }); };
$('unit-badge').onclick = () => { if (state?.collection) openDrawer('chapter'); };
$('more-menu').onclick = () => { if (drawer === 'records') closeDrawer(); else { openDrawer('records'); void showUsage(); void showAnki(); } };
// Cards made from corrections, and whether they have reached Anki yet.
function ankiLine(a) {
  return `牌组「${a.deck}」· 已推送 ${a.sent} 张${a.pending ? ` · 待推送 ${a.pending} 张` : ''}${a.failed ? ` · ${a.failed} 张推送失败` : ''}${a.last_error ? `。${a.last_error}` : ''}`;
}
async function showAnki(flush = false) {
  try { put('anki-status', ankiLine(await request('/api/anki' + (flush ? '/flush' : ''), flush ? {} : undefined))); }
  catch { put('anki-status', '暂时读不到 Anki 推送的情况。'); }
}
$('anki-flush').onclick = () => { put('anki-status', '正在推送…'); void showAnki(true); };
// What the practice has cost so far, from the usage Google reported on each call.
async function showUsage() {
  try {
    const u = await request('/api/usage');
    put('usage-totals', u.since
      ? `今天 ${dollars(u.today.usd)}（${u.today.calls} 次调用）· 近 7 天 ${dollars(u.week.usd)} · 累计 ${dollars(u.all.usd)} · 从 ${new Date(u.since).toLocaleDateString()} 开始记录`
      : '还没有记录到调用。之后每次调用模型都会记在这里。');
    // Gemini's speech models count their allowance per model, over Google's day.
    const counts = speechCounts(u.speech);
    put('usage-speech', counts ? `Gemini 朗读（Google 的一天从 ${googleDayStart(u.speech.since)} 算起）：${counts}。Tier 1 每个朗读模型每天 100 次、每分钟 10 次；一个用完自动换另一个，都用完就改用浏览器自带的声音。` : '');
    show('usage-speech', !!counts);
    $('usage-breakdown').replaceChildren(...u.week_by_purpose.map(p => {
      const li = document.createElement('li'), name = document.createElement('span'), cost = document.createElement('span');
      name.textContent = p.label || p.purpose;
      cost.textContent = `${dollars(p.usd)} · ${p.calls} 次${p.unpriced ? `（${p.unpriced} 次未定价）` : ''}`;
      li.append(name, cost); return li;
    }));
  } catch { put('usage-totals', '暂时读不到花费记录。'); }
}
$('completion-hint').onclick = () => openDrawer('completion');
$('feedback-open').onclick = () => openDrawer('feedback');
$('drawer-close').onclick = () => closeDrawer();
$('voice-open').onclick = () => { const starting = !voiceUI.isOpen(); openDrawer('voice', { focus: false }); if (starting) voiceUI.toggle(); };
$('voice-stop').onclick = () => voiceUI.stop();
// ⌘ on a Mac, Ctrl elsewhere: Windows has no ⌘, and its Windows key belongs to the system. Everything on the page
// is written with ⌘, so elsewhere the labels are shown with Ctrl as they appear.
const MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
if (!MAC) {
  const relabel = node => {
    if (node.nodeType === Node.TEXT_NODE) { if (node.data.includes('⌘')) node.data = node.data.replace(/⌘\s?/g, 'Ctrl '); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.title?.includes('⌘')) node.title = node.title.replace(/⌘\s?/g, 'Ctrl ');
    for (const child of node.childNodes) relabel(child);
  };
  relabel(document.body);
  new MutationObserver(changes => { for (const c of changes) { if (c.type === 'characterData') relabel(c.target); else for (const n of c.addedNodes) relabel(n); } })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
}
// Both keys belong to the desk wherever the cursor is, so the browser never steals them for history.
document.addEventListener('keydown', event => {
  const command = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.isComposing || event.repeat || !command || event.altKey || event.shiftKey) return;
  const bracket = event.code === 'BracketLeft' || event.key === '[' ? 'hint'
    : event.code === 'BracketRight' || event.key === ']' ? 'voice' : null;
  if (!bracket || $('board').hidden) return;
  event.preventDefault();
  const stage = state?.active?.stage;
  if (bracket === 'voice') {
    if (!voiceMode(state?.active)) return;
    if (!voiceUI.isOpen()) openDrawer('voice', { focus: false });
    voiceUI.toggle();
  } else if (transferUI.isOpen()) transferUI.help();
  else if (stage === 'phrases') phrasesUI.hint();
  else if (stage === 'practice') writingHelpUI.advance();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && drawer && !event.isComposing) { event.preventDefault(); closeDrawer(); } });
// On the sentence's feedback, Command + Enter ends the explanation and moves on, as it does for a chunk.
document.addEventListener('keydown', event => {
  if (event.isComposing || event.repeat || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (state?.active?.stage !== 'review' || openQuiz(state.active) || $('board').hidden || busy) return;
  if (event.target.closest?.('textarea, input, select, [contenteditable="true"]')) return;
  event.preventDefault(); void command('complete');
});
$('gemini-review').onclick = async () => {
  if (reviewBusy || busy || state?.active?.stage !== 'awaiting_feedback') return;
  const r = state.active;
  reviewBusy = true; render(state);
  try { render(await api('/review', { round_id: r.id, attempt_id: r.attempts.at(-1).id, retry: true })); }
  catch (e) { error(e); }
  finally { reviewBusy = false; render(state); }
};
// Which services are set; with no text service yet, the settings open by themselves the first time.
const settingsUI = createSettings({ onSaved: () => void loadConfig() });
let askedForKeys = false;
async function loadConfig() {
  try {
    settings = await request('/api/config');
    voiceUI.configure(settings);
    put('speech-engine-note', hintsByBrowser() ? '（用浏览器自带的声音）' : '（用 Gemini 朗读）');
    render(state);
    if (!settings.gemini_configured && !askedForKeys) { askedForKeys = true; void settingsUI.open(); }
  } catch (e) { error(new Error(`无法读取服务设置：${e.message}`)); }
}
// On the desk it is under ⋯; while composing, where ⋯ is not shown, it sits among the compose buttons.
$('settings-open').onclick = $('compose-settings').onclick = () => void settingsUI.open();
// Something to practise on without writing anything first: a short, made-up paragraph.
const EXAMPLE = '我最近开始学做饭。周末常常给朋友做几道家常菜，不过切菜的时候总是特别小心，怕伤到手。';
const takeSource = text => { composeUI.useWriting(text); render(state); $('source-text').focus(); };
$('use-example').onclick = () => takeSource(EXAMPLE);
// Text chosen with the extension's right-click menu on another page becomes a new idea to practise.
onSource(takeSource);
void loadConfig();
const connection = (text, trouble) => { put('connection', text); show('connection', trouble); };
// The first build this page hears is its own; a different one after a reconnect means the server was
// restarted with new code, and this page (its hints, its voice) is out of date until it is reloaded.
let build = null;
$('update-note').onclick = () => location.reload();
subscribe({
  state: value => { try { render(value); connection('已连接 · 本地保存', false); } catch (e) { error(e); } },
  build: value => { if (build === null) build = value; else if (value !== build) $('update-note').hidden = false; },
  up: () => connection('已连接 · 本地保存', false),
  down: () => connection('连接中断 · 正在重连', true),
});
