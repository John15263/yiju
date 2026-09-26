const $ = id => document.getElementById(id);
let state, pack, language = localStorage.getItem('studio-language') || 'en', events;
let dirty = false, draftTimer, serial = Promise.resolve(), viewSeq = 0;
const labels = { ready: '准备开始', practising: '练习中', parked: '已停靠', reviewing: '回顾中' };
const sourceLabels = { typed_original: '本人键入', voice_transcript: '实际语音转写', user_confirmed_text: '用户确认文本', user_revision: '用户修订', agent_summary: 'AI 摘要', ai_suggestion: 'AI 建议', simulation: '模拟回答' };
function notice(message = '') { $('notice').textContent = message; }
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await r.json();
  if (!r.ok) { const e = new Error(result.error || '请求失败'); e.status = r.status; throw e; }
  return result;
}
const endpoint = suffix => `/api/sessions/${state.session_id}${suffix}`;
function queue(fn) {
  const next = serial.then(fn);
  serial = next.catch(async e => {
    notice(e.status === 409 ? '状态已更新。你的草稿已保留，请再执行一次操作。' : e.message);
    if (e.status === 409 && state) render(await api(endpoint('')));
  });
  return serial;
}
async function command(type, payload = {}) {
  const result = await api(endpoint('/commands'), { command_id: crypto.randomUUID(), expected_revision: state.revision, type, payload });
  render(result.state); return result;
}
function updateText(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
function element(tag, text, cls) { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; }
function render(s) {
  if (state && s.session_id !== state.session_id) return;
  if (state && s.revision < state.revision) return;
  const old = state, scrollPosition = old ? { x: window.scrollX, y: window.scrollY } : null; state = s;
  $('workspace').hidden = false; $('phase').textContent = labels[s.phase];
  $('lang-en').classList.toggle('selected', s.target_language === 'en'); $('lang-ja').classList.toggle('selected', s.target_language === 'ja');
  const track = pack.tracks[s.target_language];
  updateText('pack-title', pack.title); updateText('scene', pack.scene); updateText('goal', pack.communicative_goal);
  updateText('opening', track.opening); updateText('variant', pack.variants[s.variation].description);
  $('variant').hidden = s.variation === 'none';
  $('meaning-card-01').hidden = s.scaffold.meaning_support === 'none';
  $('meaning-support').value = s.scaffold.meaning_support; $('language-support').value = s.scaffold.language_support;
  const meaningChanged = !old || old.scaffold.meaning_support !== s.scaffold.meaning_support;
  if (meaningChanged) {
    const meaning = $('meaning'); meaning.replaceChildren();
    if (s.scaffold.meaning_support === 'full') meaning.append(element('p', pack.meaning_source.text));
    if (s.scaffold.meaning_support === 'outline') { const list = document.createElement('ul'); for (const item of pack.meaning_source.outline) list.append(element('li', item)); meaning.append(list); }
    // Meaning and goal are independently hidden; the stable scene remains as context.
    $('goal').parentElement.hidden = s.scaffold.meaning_support === 'none';
    updateText('source-label', ['full', 'outline'].includes(s.scaffold.meaning_support) ? '依据已确认中文意义整理 · 非逐字转写' : '');
  }
  const languageChanged = !old || old.target_language !== s.target_language || old.scaffold.language_support !== s.scaffold.language_support || JSON.stringify(old.scaffold.visible_hint_ids) !== JSON.stringify(s.scaffold.visible_hint_ids);
  if (languageChanged) {
    const support = $('support'); support.replaceChildren();
    const mode = s.scaffold.language_support;
    updateText('support-label', { reference: 'AI 重构参考', chunks: '目标语言词块', keywords: '少量关键词', none: '留给你自己表达' }[mode]);
    if (mode === 'reference') { support.append(element('p', track.reference, 'reference'), element('p', '教学参考，不是你已经说过的内容。', 'small muted')); }
    if (mode === 'chunks') {
      const ids = s.scaffold.visible_hint_ids.length ? s.scaffold.visible_hint_ids : Object.keys(track.cues);
      for (const key of ids) support.append(element('span', track.cues[key], ids.length === 1 ? 'single-cue' : 'chunk'));
    }
    if (mode === 'keywords') for (const word of track.keywords) support.append(element('span', word, 'chunk'));
    if (mode === 'none') support.append(element('p', '不急，试着用自己的话说。', 'muted'));
  }
  if (!dirty && document.activeElement !== $('draft')) $('draft').value = s.draft;
  if (document.activeElement !== $('next-entry')) $('next-entry').value = localStorage.getItem(`studio-next-${s.session_id}`) ?? s.next_entry ?? '';
  $('hold').classList.toggle('selected', s.interaction.hold_conditions);
  updateText('speaking-state', s.interaction.is_user_speaking ? '表达中 · 保持场景与提示' : s.active_attempt ? '本次表达尚未保存' : '');
  const parked = s.phase === 'parked', speaking = s.interaction.is_user_speaking;
  for (const name of ['less-help', 'hold', 'vary', 'reference', 'show-cue', 'meaning-support', 'language-support', 'begin-attempt', 'pause-speaking', 'jev-help', 'park']) $(name).disabled = parked;
  for (const name of ['less-help', 'vary', 'reference', 'meaning-support', 'language-support']) $(name).disabled ||= speaking;
  $('begin-attempt').disabled ||= Boolean(s.active_attempt); $('resume').disabled = s.phase === 'practising';
  $('resume').hidden = s.phase === 'practising';
  $('park').hidden = s.phase === 'ready' || parked;
  $('show-cue').hidden = parked; $('less-help').hidden = parked;
  $('pause-speaking').disabled ||= !speaking;
  $('export').href = endpoint('/export');
  updateText('attempt-count', String(s.attempts.length));
  if (!old || old.attempts.length !== s.attempts.length) {
    $('attempts').replaceChildren(...[...s.attempts].reverse().map(a => {
      const section = element('article', '', 'attempt');
      section.append(element('small', `${sourceLabels[a.source]} · ${a.user_confirmed ? '用户已确认' : '待确认'} · ${new Date(a.at).toLocaleString()}`), element('p', a.text), element('small', `包含 ${a.support_events.length} 条支持事件；${a.initial_support ? '记录了表达开始时的支架' : '保守保留会话支持历史'}。`));
      return section;
    }));
  }
  updateText('connection', `已连接本机 · ${s.target_language.toUpperCase()} · 版本 ${s.revision}`);
  if (scrollPosition) window.scrollTo(scrollPosition.x, scrollPosition.y);
  // Acknowledge only after two animation frames; this is a render report, not proof of reading.
  const seq = ++viewSeq, session = s.session_id, rev = s.revision;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (seq === viewSeq && state.session_id === session && state.revision === rev) api(`/api/sessions/${session}/view-ack`, { rendered_revision: rev }).catch(() => {});
  }));
}
async function refreshList() {
  const all = await api('/api/sessions');
  $('session-list').replaceChildren(...all.filter(s => s.target_language === language).map(s => { const o = element('option', `${new Date(s.updated_at).toLocaleString()} · ${labels[s.phase]}`); o.value = s.session_id; return o; }));
  if (state) $('session-list').value = state.session_id;
  return all;
}
async function openSession(session) {
  if (state) await saveDraft();
  events?.close(); const s = await api(`/api/sessions/${session}`);
  state = null; dirty = false; language = s.target_language;
  localStorage.setItem('studio-language', language); localStorage.setItem(`studio-session-${language}`, session);
  render(s);
  const backup = localStorage.getItem(`studio-draft-${session}`);
  if (backup !== null && backup !== s.draft) { $('draft').value = backup; dirty = true; notice('已恢复本机未保存草稿。'); }
  events = new EventSource(`/api/sessions/${session}/events`);
  events.addEventListener('state', event => render(JSON.parse(event.data)));
  events.onerror = () => updateText('connection', '连接暂时中断 · 草稿保留在本机，正在重连');
  events.onopen = () => api(`/api/sessions/${session}`).then(render).catch(e => notice(e.message));
  await refreshList();
}
async function switchLanguage(next, fresh = false) {
  if (state) await saveDraft();
  language = next;
  const all = await api('/api/sessions');
  const saved = localStorage.getItem(`studio-session-${next}`);
  const found = !fresh && (all.find(s => s.session_id === saved && s.target_language === next) || all.find(s => s.target_language === next));
  const s = found || await api('/api/sessions', { pack_id: pack.pack_id, target_language: next });
  await openSession(s.session_id);
}
async function saveDraft() {
  clearTimeout(draftTimer);
  if (!state || !dirty) return;
  const value = $('draft').value, session = state.session_id;
  await command('save_draft', { text: value });
  if (state.session_id === session && $('draft').value === value) {
    dirty = false; localStorage.removeItem(`studio-draft-${session}`); updateText('draft-status', '草稿已保存');
  }
}
function on(id, fn) { $(id).addEventListener('click', () => queue(async () => { notice(); await fn(); })); }
on('lang-en', () => switchLanguage('en')); on('lang-ja', () => switchLanguage('ja')); on('new-session', () => switchLanguage(language, true));
$('session-list').addEventListener('change', e => { const session = e.target.value; queue(() => openSession(session)); });
on('resume', async () => { await command('resume'); await refreshList(); });
on('park', async () => { const next = $('next-entry').value; await saveDraft(); await command('park', { next_entry: next }); localStorage.removeItem(`studio-next-${state.session_id}`); await refreshList(); notice('已停在这里，表达和当前条件均已保存。'); });
on('hold', () => command('hold_conditions', { enabled: !state.interaction.hold_conditions }));
on('vary', () => command('apply_variant', { variant_id: state.variation === 'none' ? 'clarify' : state.variation === 'clarify' ? 'rephrase' : 'none' }));
on('less-help', () => {
  const lang = state.scaffold.language_support;
  if (lang !== 'none') return command('set_scaffold', { language_support: { reference: 'chunks', chunks: 'keywords', keywords: 'none' }[lang] });
  return command('set_scaffold', { meaning_support: { full: 'outline', outline: 'scene', scene: 'none', none: 'none' }[state.scaffold.meaning_support] });
});
on('reference', () => command('set_scaffold', { language_support: state.scaffold.reference_visible ? 'none' : 'reference' }));
on('show-cue', () => {
  const keys = Object.keys(pack.tracks[state.target_language].cues);
  const previous = keys.indexOf(state.scaffold.visible_hint_ids[0]);
  return command('show_hint', { hint_id: keys[(previous + 1) % keys.length], explicit_help: true });
});
for (const [name, key] of [['meaning-support', 'meaning_support'], ['language-support', 'language_support']]) $(name).addEventListener('change', e => { const value = e.target.value; queue(() => command('set_scaffold', { [key]: value })); });
on('begin-attempt', async () => { await saveDraft(); if (state.phase !== 'practising') await command('resume'); await command('begin_attempt'); });
on('pause-speaking', () => command('set_interaction', { is_user_speaking: false }));
$('draft').addEventListener('input', () => {
  dirty = true; localStorage.setItem(`studio-draft-${state.session_id}`, $('draft').value); updateText('draft-status', '正在保存草稿…');
  clearTimeout(draftTimer); draftTimer = setTimeout(() => queue(saveDraft), 800);
});
$('next-entry').addEventListener('input', () => localStorage.setItem(`studio-next-${state.session_id}`, $('next-entry').value));
on('save-attempt', async () => {
  const content = $('draft').value; if (!content.trim()) { notice('先留下一点实际表达。'); return; }
  await saveDraft();
  const result = await api(endpoint('/attempts'), { attempt_id: crypto.randomUUID(), expected_revision: state.revision, text: content, source: $('attempt-source').value, user_confirmed: $('confirmed').checked });
  // Keep text typed during the save round-trip as the next draft.
  const hasNewText = $('draft').value !== content;
  if (!hasNewText) { dirty = false; $('draft').value = ''; localStorage.removeItem(`studio-draft-${state.session_id}`); }
  render(result.state); $('confirmed').checked = false; notice('这次表达已保存。');
});
on('jev-help', async () => {
  const content = $('help-input').value.trim(); if (!content) { notice('写下你需要的局部帮助。'); return; }
  await saveDraft(); if (state.phase !== 'practising') await command('resume');
  await command('set_interaction', { user_control: 'help', recent_input: { text: content, source: 'control' } });
  const session = state.session_id;
  $('jev-help').disabled = true; updateText('decision-result', '正在选择已有提示…');
  // Do not hold the UI command queue during provider inference; stop/resume must remain usable.
  api(`/api/sessions/${session}/decisions/next`, { decision_id: crypto.randomUUID(), expected_revision: state.revision }).then(async trace => {
    if (state.session_id !== session) return;
    updateText('decision-trace', JSON.stringify(trace, null, 2));
    updateText('decision-result', ({ applied: '提示已保存到会话。', ignored: '保留当前提示。', escalated: '这次需要 Codex 帮你继续，请回到当前对话。', stale: '期间状态已改变，这次判断没有覆盖现场。', blocked: '已按当前练习条件保留现场。' }[trace.disposition] || trace.disposition) + (trace.latency_ms !== null ? ` · ${trace.latency_ms} ms` : ''));
    render(await api(`/api/sessions/${session}`));
  }).catch(e => notice(e.message)).finally(() => { if (state.session_id === session) $('jev-help').disabled = state.phase === 'parked'; });
});
$('font-size').value = localStorage.getItem('studio-font') || 'normal'; document.body.className = $('font-size').value;
$('font-size').addEventListener('change', e => { document.body.className = e.target.value; localStorage.setItem('studio-font', e.target.value); });
try {
  const [packs, cfg] = await Promise.all([api('/api/packs'), api('/api/config')]); pack = packs[0];
  updateText('jev-status', cfg.jev_configured ? 'Jev 已配置' : '未配置 API Key');
  await switchLanguage(language);
} catch (e) { notice(`连接失败：${e.message}。请确认本机服务已启动。`); }
