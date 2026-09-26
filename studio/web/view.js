// Pure presentation decisions for the writing desk: server state in, view model out.
// No DOM access here, so the stage mapping stays testable without a browser.

export const SUPPORT_LEVELS = ['无外语提示', '关键词', '句子骨架', '完整参考'];
export const PHRASE_HINT_LEVELS = ['未看提示', '结构提示', '开头提示', '参考'];
// Phrase hints count 1–3 on their own ladder; support and writing hints share the 0–3 support scale.
const PHRASE_SCALE = new Set(['phrase_hint', 'phrase_expression']);

export function supportSummary(attempt) {
  const events = attempt.support_events || [];
  const peak = (kinds, start) => events.reduce((n, e) => kinds(e.kind) && Number.isInteger(e.level) ? Math.max(n, e.level) : n, start);
  const support = peak(kind => !PHRASE_SCALE.has(kind), attempt.support_level || 0);
  const phrase = peak(kind => PHRASE_SCALE.has(kind), 0);
  const chat = events.some(e => e.kind === 'codex_chat_support');
  const voice = events.filter(e => e.kind === 'voice_session');
  const spoken = voice.reduce((n, e) => n + (e.detail?.seconds || 0), 0);
  return { support, phrase, chat, voice: voice.length,
    text: `最高帮助：${SUPPORT_LEVELS[support]}${phrase ? ` · 短语提示：${PHRASE_HINT_LEVELS[phrase]}` : ''}`
      + `${voice.length ? ` · 含语音陪练 ${Math.round(spoken / 60) || 1} 分钟` : ''}${chat ? ' · 含对话帮助' : ''}` };
}

const weak = (id, label) => ({ id, label });

export function deskView({ state, settings = null } = {}) {
  const r = state?.active;
  if (!r) return null;
  const collection = state.collection || null;
  const units = collection?.units || [];
  const index = collection ? collection.active_index : 0;
  const lastUnit = !collection || index === units.length - 1;
  const gemini = !!settings?.gemini_configured;
  const phrases = r.phrases;
  const phraseReady = phrases?.status === 'ready' && phrases.index < (phrases.items?.length ?? 0);
  const latest = r.attempts.at(-1) || null;
  const review = r.reviews?.findLast(x => x.attempt_id === latest?.id) || null;
  const reviewing = review?.status === 'pending';
  const finished = collection ? units.every(u => u.stage === 'complete') : r.stage === 'complete';
  const completion = state.completion;

  const view = {
    stage: r.stage,
    language: r.language,
    demo: r.origin === 'demo',
    badge: `${r.language === 'en' ? '英语' : '日语'}${collection ? ` · ${index + 1} / ${units.length}` : ''}`,
    context: { source: 'sentence', eyebrow: r.origin === 'demo' ? '示例：一个想表达的意思' : '你想表达的意思', heading: r.meaning },
    input: 'none',
    showPrompt: false,
    learn: null,
    primary: null,
    weak: [],
    note: '',
    completion: completion ? `第 ${completion.unit_index + 1} 句已完成` : '',
  };

  switch (r.stage) {
    case 'study':
      view.context.eyebrow = '先看一遍这句的表达';
      view.showPrompt = true;
      view.primary = { id: 'start-phrases', label: '先练短语' };
      break;
    case 'phrases':
      view.context = { source: 'phrase', eyebrow: '', heading: '' };
      // Chunks first, then the sentence: the sentence opens by itself after the last chunk and is not
      // offered as a way round them. The only exception is a sentence whose chunks cannot be prepared.
      // The voice button owns its own label, because it also shows the running timer.
      view.weak = phraseReady ? [weak('voice-open', null)] : [];
      // Filling the corrections back in has its own button and keys, and nothing else to do.
      if (phraseReady && phrases.step === 'quiz') { view.input = 'quiz'; view.weak = []; break; }
      // Each chunk is talked through first, and the explanation starts by itself, so the one thing
      // left to decide here is when to start writing it.
      if (phraseReady && phrases.step === 'learn') {
        const item = phrases.items[phrases.index];
        view.input = 'learn';
        view.learn = { reference: item.reference, hint: item.hints[0] };
        view.primary = { id: 'phrase-write', label: '开始默写 · ⌘ ↵' };
      } else if (phraseReady) {
        const hinted = phrases.inputs[phrases.index]?.hint_level === 3;
        view.input = 'phrase';
        view.primary = { id: hinted ? 'phrase-continue' : 'phrase-check', label: null };
      } else if (phrases?.status === 'error') {
        view.primary = { id: 'phrase-retry', label: '重新准备短语' };
        view.weak = [weak('practice', '拆不出短语，先写整句')];
      }
      break;
    case 'practice':
      view.context.eyebrow = '把这一句连起来';
      view.input = 'writing';
      view.showPrompt = r.support_level > 0;
      view.primary = { id: 'writing-submit', label: null };
      view.weak = [weak('voice-open', null)];
      break;
    case 'awaiting_feedback':
      view.context.eyebrow = '这次的表达';
      view.input = 'response';
      // Nothing announces the review while it runs; the answer stays on screen until the feedback lands.
      view.note = reviewing ? ''
        : review?.status === 'error' ? `${review.message || '点评没有完成。'}回答已保存，可以重试。`
        : gemini ? '回答已保存，点评暂未完成。' : '回答已保存。配置 Gemini 后可以自动点评。';
      if (!reviewing && gemini) view.primary = { id: 'gemini-review', label: review ? '重新点评' : '请 Gemini 点评' };
      break;
    case 'review':
      view.context.eyebrow = '这次的表达';
      if (openQuiz(r)) { view.context.eyebrow = '改错小测'; view.input = 'quiz'; break; }
      view.input = 'response';
      // Done with the feedback and its explanation: the same Command + Enter moves on.
      view.primary = { id: 'complete', label: `${lastUnit ? '完成本句' : '完成并进入下一句'} · ⌘ ↵` };
      view.weak = [weak('practice', '继续修改'), weak('voice-open', null)];
      break;
    case 'complete':
      view.context.eyebrow = finished ? '' : '这一句已完成';
      view.context.heading = finished ? '这段写完了' : r.meaning;
      view.input = 'response';
      view.primary = finished ? { id: 'finish-new', label: '新的想法' } : { id: 'start-phrases', label: '再练短语' };
      view.weak = [weak('repeat', '清空重练一轮')];
      break;
    case 'paused':
      view.context.eyebrow = '停在这里了';
      view.note = '草稿和位置都已保存。';
      view.primary = { id: 'resume', label: '继续练习' };
      break;
    case 'cloze':
      view.context.eyebrow = '逐空试写';
      break;
  }
  return view;
}

// 批改标记：学习者的句子与建议表达之间可靠可算的词级差异。
// 只做差异，不推断错误类型；后端没有返回的结构（错误位置、诊断）一律不编造。
const MARKUP_LIMIT = 600;
function tokenize(text, language) {
  return [...new Intl.Segmenter(language === 'ja' ? 'ja' : 'en', { granularity: 'word' }).segment(text)].map(part => part.segment);
}
function diffTokens(a, b) {
  const n = a.length, m = b.length, width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1
      : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  }
  const parts = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { parts.push({ type: 'kept', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { parts.push({ type: 'cut', text: a[i] }); i++; }
    else { parts.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) parts.push({ type: 'cut', text: a[i++] });
  while (j < m) parts.push({ type: 'add', text: b[j++] });
  return parts;
}
// Neighbouring tokens of one kind become one mark, so "side quests" reads as a single edit.
// Every part keeps the text it really came from: the kept and cut parts still spell the
// learner's sentence, the kept and add parts still spell the suggestion.
function join(parts) {
  const merged = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last && last.type === part.type) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged.filter(part => part.text);
}
export function markup(answer, suggestion, language = 'en') {
  if (!answer?.trim() || !suggestion?.trim()) return null;
  const a = tokenize(answer, language), b = tokenize(suggestion, language);
  if (a.length > MARKUP_LIMIT || b.length > MARKUP_LIMIT) return null;
  const parts = join(diffTokens(a, b));
  // A deletion and the replacement next to it are one correction, not two.
  let changes = 0;
  for (const [index, part] of parts.entries()) {
    if (part.type !== 'kept' && parts[index - 1]?.type !== 'kept' && index > 0) continue;
    if (part.type !== 'kept') changes++;
  }
  // When little of the original survives, the suggestion is a rewrite rather than a correction;
  // the marks still show, but they are not described as a few tidy fixes.
  const kept = parts.reduce((n, part) => part.type === 'kept' ? n + part.text.trim().length : n, 0);
  const rewrite = changes > 0 && kept < answer.replace(/\s/g, '').length * 0.4;
  return { parts, changes, rewrite,
    summary: !changes ? '没有要改的地方' : rewrite ? `批改 ${changes} 处 · 建议表达与原句差别较大` : `批改 ${changes} 处` };
}

const bare = value => value.normalize('NFKC').toLowerCase().replace(/[\s.,!?;:'"“”‘’。，！？；：、]/gu, '');
// The changes between what was written and its correction, one entry each, in the order written. A
// space between two edits does not split one correction; a word only added or only dropped is placed by
// its neighbours ("is escape" became "is to escape").
export function changeList(text, corrected, language = 'en') {
  const marked = corrected ? markup(text, corrected, language) : null;
  if (!marked?.changes) return [];
  const parts = marked.parts, groups = [];
  let group = null;
  parts.forEach((part, i) => {
    if (part.type === 'kept' && (!group || part.text.trim())) { if (group) { group.end = i; groups.push(group); group = null; } return; }
    group ||= { start: i, from: '', to: '' };
    if (part.type !== 'add') group.from += part.text;
    if (part.type !== 'cut') group.to += part.text;
  });
  if (group) { group.end = parts.length; groups.push(group); }
  const ja = language === 'ja', before = t => ja ? t.slice(-3) : t.trim().split(/\s+/).at(-1) || '', after = t => ja ? t.slice(0, 3) : t.trim().split(/\s+/)[0] || '';
  // Only case or punctuation changed: not a change worth a row of its own.
  return groups.filter(g => bare(g.from) !== bare(g.to)).map(g => {
    if (g.from.trim() && g.to.trim()) return { from: g.from.trim(), to: g.to.trim() };
    const around = middle => [before(parts[g.start - 1]?.text || ''), middle.trim(), after(parts[g.end]?.text || '')].filter(Boolean).join(ja ? '' : ' ');
    return { from: around(g.from), to: around(g.to) };
  });
}

// A fill-in check made from a correction: the corrected text with each real change left blank. Changes
// of case or punctuation stay written in, and a dropped word leaves nothing to fill.
export function clozeFrom(text, corrected, language = 'en') {
  const marked = corrected ? markup(text, corrected, language) : null;
  if (!marked?.changes) return null;
  const segments = [], answers = [];
  const write = value => { if (!value) return; if (typeof segments.at(-1) === 'string') segments[segments.length - 1] += value; else segments.push(value); };
  let cut = '', added = '';
  const close = () => {
    if (added.trim() && bare(added) !== bare(cut)) {
      const [, lead, core, tail] = added.match(/^(\s*)([\s\S]*?)(\s*)$/);
      write(lead); segments.push({ blank: answers.length }); answers.push(core); write(tail);
    } else write(added);
    cut = ''; added = '';
  };
  for (const part of marked.parts) {
    if (part.type === 'kept' && part.text.trim()) { close(); write(part.text); continue; }
    if (part.type === 'cut') cut += part.text;
    else added += part.text;
  }
  close();
  return answers.length ? { segments, answers } : null;
}

// The fill-in check standing between the learner and the next step, if there is one: a chunk's, while
// its step is 'quiz', or the sentence's, on the attempt whose feedback it came from.
export function openQuiz(r) {
  if (r?.stage === 'phrases' && r.phrases?.step === 'quiz') return r.phrases.inputs[r.phrases.index]?.quiz || null;
  const attempt = r?.attempts?.at(-1);
  if (r?.stage === 'review' && r.quiz && r.quiz.attempt_id === attempt?.id) return r.quiz;
  return null;
}
