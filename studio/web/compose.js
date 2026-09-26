import { renderOutline, renderPreviewUnits, renderPreviewMeanings, renderUncertainties } from './expression.js';
export function createComposeUI({ api, render, command, getState, error, beforeOpen }) {
  const $ = id => document.getElementById(id);
  let open = false, working = false, initialized = false, lastID = null, lastStatus = null;
  const storage = 'sentence-source-draft';
  const packet = () => ({ source: $('source-text').value, language: $('source-language').value, focus: $('source-focus').value });
  try {
    const draft = JSON.parse(localStorage.getItem(storage));
    if (draft) { $('source-text').value = draft.source || ''; $('source-language').value = draft.language === 'ja' ? 'ja' : 'en'; $('source-focus').value = draft.focus || ''; }
  } catch {}
  $('source-focus-panel').open = !!$('source-focus').value;
  function stash() { try { localStorage.setItem(storage, JSON.stringify(packet())); } catch {} }
  function matches(p) { const v = packet(); return p && v.source === p.source && v.language === p.language && v.focus === p.focus; }
  function update(state, settings) {
    if (!state) return open;
    const p = state.preparation;
    if (!initialized) { initialized = true; open = !state.active || ['pending', 'ready', 'error'].includes(p?.status); }
    if (p?.id !== lastID) {
      lastID = p?.id;
      if (p && p.status !== 'accepted' && !$('source-text').value) {
        $('source-text').value = p.source; $('source-language').value = p.language; $('source-focus').value = p.focus; $('source-focus-panel').open = !!p.focus;
      }
    }
    $('compose').hidden = !open;
    $('cancel-compose').hidden = !state.active;
    const pending = p?.status === 'pending', ready = p?.status === 'ready' && matches(p);
    for (const id of ['source-text', 'source-language', 'source-focus']) $(id).disabled = pending || working;
    $('start-freewrite').disabled = pending || working;
    $('generate-sentence').disabled = pending || working || !settings?.gemini_configured || !packet().source.trim();
    $('generate-sentence').textContent = pending ? '正在整理…' : p && p.status !== 'accepted' ? '重新整理' : '整理我的想法';
    $('source-count').textContent = `${$('source-text').value.length.toLocaleString()} / 20,000 字符`;
    $('prepare-status').textContent = pending ? '正在梳理核心与辅助结构，再准备逐句表达、短语拆解和提示。长内容会多等一会儿；原文已保存。' : !settings ? '正在读取 Gemini 配置…' : !settings.gemini_configured ? '请在 .env 填写 GEMINI_API_KEY，并重启本地服务。' : 'Gemini 整理内容与评审整句 · Jev 检查短语表达 · Codex 可提供语音帮助';
    $('prepare-error').hidden = p?.status !== 'error'; $('prepare-error').textContent = p?.message || '';
    $('prepare-preview').hidden = !ready;
    const units = ready ? p.units || [{ material: p.material, segments: p.segments }] : [];
    $('preview-meaning').textContent = ready ? p.outline?.summary || p.material.meaning : '';
    // Clarifications stay outside the collapsed detail: they are the reason this step exists.
    renderUncertainties($('preview-uncertain'), ready ? p.outline : null);
    renderPreviewMeanings($('preview-units'), units);
    renderOutline($('preview-outline'), ready ? p.outline : null, { uncertainties: false });
    renderPreviewUnits($('preview-reference'), units, p?.language || 'en');
    if (lastStatus !== `${p?.id}:${p?.status}`) $('preview-detail-panel').open = false;
    const chunks = units.reduce((n, unit) => n + (unit.phrases?.length || 0), 0);
    $('preview-details').textContent = ready ? `共 ${units.length} 句${chunks ? `、${chunks} 个表达块` : ''}。确认后先试写短语，再组织整句，完成后继续下一句。` : '';
    $('accept-preparation').disabled = working;
    if (open && ready && lastStatus !== `${p.id}:ready`) requestAnimationFrame(() => $('prepare-preview').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    lastStatus = p ? `${p.id}:${p.status}` : null;
    return open;
  }
  for (const id of ['source-text', 'source-language', 'source-focus']) $(id).addEventListener('input', () => { stash(); render(getState()); });
  async function openCompose() {
    try { await beforeOpen(); open = true; render(getState()); $('source-text').focus(); $('compose').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { error(e); }
  }
  $('new-sentence').onclick = openCompose;
  $('cancel-compose').onclick = () => { open = false; render(getState()); };
  $('generate-sentence').onclick = async () => {
    if (working || getState()?.preparation?.status === 'pending' || !packet().source.trim()) return;
    working = true; stash(); render(getState());
    try { render(await api('/prepare', { request_id: crypto.randomUUID(), ...packet() })); }
    catch (e) { error(e); }
    finally { working = false; render(getState()); }
  };
  $('accept-preparation').onclick = async () => {
    const p = getState()?.preparation;
    if (working || p?.status !== 'ready' || !matches(p)) return;
    working = true; render(getState());
    try {
      if (await command('accept_preparation', { preparation_id: p.id })) {
        open = false;
        requestAnimationFrame(() => $('board').scrollIntoView({ behavior: 'smooth', block: 'start' }));
        for (const id of ['source-text', 'source-focus']) $(id).value = '';
        $('source-focus-panel').open = false;
        try { localStorage.removeItem(storage); } catch {}
      }
    } finally { working = false; render(getState()); }
  };
  function useWriting(content) {
    const previous = packet();
    if (previous.source.trim() || previous.focus.trim()) localStorage.setItem('sentence-source-before-freewrite', JSON.stringify(previous));
    const next = { source: content, language: previous.language, focus: '' };
    // Persist before replacing the visible draft; if storage fails the writing room keeps its text.
    localStorage.setItem(storage, JSON.stringify(next));
    $('source-text').value = content; $('source-focus').value = ''; $('source-focus-panel').open = false;
    open = true;
    $('restore-source').hidden = !(previous.source.trim() || previous.focus.trim());
  }
  try { $('restore-source').hidden = !localStorage.getItem('sentence-source-before-freewrite'); } catch {}
  $('restore-source').onclick = () => {
    try {
      const previous = JSON.parse(localStorage.getItem('sentence-source-before-freewrite'));
      if (!previous) return;
      // Swap so the completed writing remains recoverable too.
      localStorage.setItem('sentence-source-before-freewrite', JSON.stringify(packet()));
      localStorage.setItem(storage, JSON.stringify(previous));
      $('source-text').value = previous.source; $('source-language').value = previous.language; $('source-focus').value = previous.focus;
      $('source-focus-panel').open = !!previous.focus; render(getState());
    } catch (e) { error(e); }
  };
  return { update, useWriting, openCompose, openEntry: () => { open = true; } };
}
