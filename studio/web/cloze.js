export function createClozeUI({ getState, api, render, error, command }) {
  const $ = id => document.getElementById(id);
  let roundID = null, controls = new Map(), selected = null, current = null, submitting = false;
  const backupKey = (round, slot) => `sentence-cloze:${round}:${slot}`;
  function stash(f) { try { localStorage.setItem(backupKey(f.round, f.id), f.input.value); } catch {} }
  function forget(f) { try { localStorage.removeItem(backupKey(f.round, f.id)); } catch {} }
  function active(f) { return getState()?.active?.id === f.round && getState().active.stage === 'cloze'; }
  function payload(f) { return { round_id: f.round, slot_id: f.id }; }
  function help(f, action) {
    if (!f || !active(f) || submitting) return;
    // Queue focus and hint changes so quick repeated shortcuts don't lose levels.
    f.helpPromise = (f.helpPromise || Promise.resolve()).then(async () => {
      if (!active(f)) return;
      if (action === 'focus') render(await api('/cloze/focus', payload(f)));
      if (!active(f)) return;
      const level = getState().active.cloze.inputs[f.id].hint_level;
      const next = action === 'hide' ? 0 : action === 'focus' ? Math.max(1, level) : Math.min(4, level + 1);
      if (next !== level) render(await api('/cloze/hint', { ...payload(f), level: next }));
    }).catch(error);
    return f.helpPromise;
  }
  async function save(f) {
    clearTimeout(f.timer);
    if (f.saving) { await f.saving; if (f.dirty) return save(f); return; }
    if (!f.dirty || !active(f)) return;
    const value = f.input.value, version = getState().active.cloze.inputs[f.id].version;
    f.saving = (async () => {
      try {
        const state = await api('/cloze/input', { ...payload(f), text: value, expected_version: version, edit_id: crypto.randomUUID() });
        if (f.input.value === value) { f.dirty = false; forget(f); }
        render(state);
      } catch (e) {
        f.dirty = true; stash(f);
        try { render(await api('')); } catch {}
        error(e); throw e;
      }
    })();
    try { await f.saving; } finally { f.saving = null; }
    if (f.dirty && active(f)) return save(f);
  }
  function checkSlot(f, retry = false) {
    if (submitting || !f || !active(f) || f.composing || !f.input.value.trim()) return Promise.resolve(false);
    const wanted = f.input.value;
    if (f.checking === wanted) return f.checkPromise;
    f.checking = wanted;
    f.checkPromise = (async () => {
    try {
      await save(f);
      if (!active(f) || f.input.value !== wanted) return false;
      const version = getState().active.cloze.inputs[f.id].version;
      const result = await api('/cloze/check', { ...payload(f), expected_version: version, check_id: crypto.randomUUID(), retry });
      render(result.state);
      const saved = getState()?.active?.cloze?.inputs[f.id];
      return active(f) && f.input.value === wanted && saved?.result?.version === saved?.version && saved.result.verdict !== 'checking';
    } catch (e) { if (active(f) && f.input.value === wanted) error(e); return false; }
    finally { if (f.checking === wanted) f.checking = null; }
    })();
    return f.checkPromise;
  }
  function label(f, state) {
    if (f.dirty || f.saving || f.composing) return { verdict: 'typing', message: '输入中，填完后按 Enter 或 Tab 检查。' };
    const result = state.result;
    if (!result) return { verdict: 'idle', message: state.text ? '已保存，等待检查。' : '填写这个空；也可以先拿一点提示。' };
    const messages = {
      checking: 'Jev 正在检查，可以继续填下一空。',
      accepted: result.source === 'local' ? '✓ 已通过 · 已知表达' : '✓ 可以这样表达 · Jev 判断',
      spelling: '可能有拼写问题。检查一下字母顺序。',
      form: `检查词形。${f.spec.hints[1]}`,
      meaning: `检查意思或搭配。${f.spec.hints[0]}`,
      review: result.reason || '暂不能确定。可以继续填写，或通过 Codex 语音讨论。',
    };
    return { verdict: result.verdict, message: result.message || messages[result.verdict] };
  }
  const shortLabels = { accepted: '可以继续', checking: '正在检查', typing: '输入中', review: '待确认', spelling: '检查拼写', form: '检查词形', meaning: '看看搭配' };
  function move(f, direction) {
    const target = [...controls.values()][f.index + direction];
    if (target) { target.input.focus(); target.input.setSelectionRange(target.input.value.length, target.input.value.length); }
  }
  function latestFeedback() {
    const results = [...controls.values()].filter(f => !f.dirty && !f.saving && current.cloze.inputs[f.id].result && current.cloze.inputs[f.id].result.verdict !== 'checking');
    const latest = results.sort((a,b) => {
      const x = current.cloze.inputs[a.id].result, y = current.cloze.inputs[b.id].result;
      return Date.parse(y.finished_at || y.at) - Date.parse(x.finished_at || x.at);
    })[0];
    $('cloze-last-result').hidden = !latest;
    if (latest) {
      const status = label(latest, current.cloze.inputs[latest.id]);
      $('cloze-last-result').textContent = `第 ${latest.index + 1} 空 · ${status.message}`;
      $('cloze-last-result').dataset.verdict = status.verdict;
    } else $('cloze-last-result').textContent = '';
  }
  function panel() {
    const f = controls.get(selected); if (!f || !current) return;
    const s = current.cloze.inputs[f.id], status = label(f, s);
    $('cloze-slot-title').textContent = `第 ${f.index + 1} 空`;
    $('cloze-feedback').textContent = status.message;
    $('cloze-feedback').dataset.verdict = status.verdict;
    $('cloze-hint-text').textContent = s.hint_level === 4 ? `参考：${f.spec.answers[0]}` : s.hint_level > 0 ? f.spec.hints.slice(0, s.hint_level).join(' · ') : '';
    $('cloze-hint').textContent = ['给一点提示', '再给一点提示', '看首字母', '看这个空的参考', '参考已显示'][s.hint_level];
    $('cloze-hint').disabled = s.hint_level === 4;
    $('cloze-hide').hidden = s.hint_level === 0;
    $('cloze-check').textContent = s.result?.verdict === 'review' ? '重新检查' : '检查这个空';
    $('cloze-check').disabled = !f.input.value.trim() || status.verdict === 'checking';
    for (const item of controls.values()) item.wrap.classList.toggle('selected', item.id === selected);
  }
  function progress() {
    const all = [...controls.values()];
    const filled = all.filter(f => f.input.value.trim()).length;
    const accepted = all.filter(f => !f.dirty && current.cloze.inputs[f.id].result?.verdict === 'accepted').length;
    $('cloze-progress').textContent = `${filled} / ${all.length} 已填 · ${accepted} 已通过`;
    $('cloze-submit').disabled = submitting || filled !== all.length;
    for (const f of all) f.input.disabled = submitting;
  }
  function mount(r) {
    roundID = r.id; controls = new Map(); selected = r.cloze.focused_slot; $('cloze-line').replaceChildren();
    let index = 0;
    for (const part of r.cloze.segments) {
      if (typeof part === 'string') { $('cloze-line').append(document.createTextNode(part)); continue; }
      const wrap = document.createElement('span'); wrap.className = 'cloze-blank';
      const input = document.createElement('input'); input.type = 'text'; input.maxLength = 200; input.size = 8;
      input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); input.setAttribute('autocorrect', 'off');
      input.setAttribute('aria-label', `第 ${index + 1} 空`); input.lang = r.language; input.dataset.slot = part.id;
      const status = document.createElement('span'); status.className = 'blank-status'; status.id = `blank-status-${part.id}`;
      input.setAttribute('aria-describedby', status.id);
      wrap.append(input, status); $('cloze-line').append(wrap);
      const f = { id: part.id, round: r.id, spec: part, index: index++, wrap, input, status, dirty: false, saving: null, checking: null };
      input.value = r.cloze.inputs[part.id].text;
      try { const backup = localStorage.getItem(backupKey(r.id, part.id)); if (backup !== null && backup !== input.value) { input.value = backup; f.dirty = true; } } catch {}
      controls.set(part.id, f);
      input.onfocus = () => { selected = f.id; panel(); help(f, 'focus'); };
      input.oninput = () => {
        f.dirty = true; stash(f); input.size = Math.max(8, Math.min(24, input.value.length + 1));
        f.status.textContent = `${f.index + 1} · 输入中`; f.wrap.dataset.verdict = 'typing'; panel(); progress(); latestFeedback(); clearTimeout(f.timer);
        if (!f.composing) f.timer = setTimeout(() => save(f).catch(() => {}), 450);
      };
      input.oncompositionstart = () => { f.composing = true; clearTimeout(f.timer); };
      input.oncompositionend = () => { f.composing = false; input.oninput(); };
      input.onkeydown = event => {
        if (event.isComposing || f.composing) return;
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'BracketLeft' || event.key === '[')) {
          event.preventDefault();
          if (!event.repeat) help(f, 'more');
          return;
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.shiftKey && !event.altKey && !event.ctrlKey && event.metaKey) {
          event.preventDefault(); move(f, event.key === 'ArrowLeft' ? -1 : 1); return;
        }
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          event.preventDefault(); checkSlot(f);
          move(f, 1);
        }
      };
      input.onblur = () => checkSlot(f);
      if (f.dirty) f.timer = setTimeout(() => save(f).catch(() => {}), 450);
    }
    if (!controls.has(selected)) selected = controls.keys().next().value;
  }
  function update(r) {
    current = r;
    const visible = r?.stage === 'cloze' && r.cloze;
    $('cloze-region').hidden = !visible;
    if (!visible) return;
    if (roundID !== r.id) mount(r);
    for (const f of controls.values()) {
      const s = r.cloze.inputs[f.id];
      if (!f.dirty && !f.saving && !f.composing && f.input.value !== s.text) f.input.value = s.text;
      f.input.size = f.input.value ? Math.max(8, Math.min(24, f.input.value.length + 1)) : 8;
      const status = label(f, s); f.wrap.dataset.verdict = status.verdict;
      f.status.textContent = `${f.index + 1}${shortLabels[status.verdict] ? ` · ${shortLabels[status.verdict]}` : ''}`;
    }
    panel(); progress(); latestFeedback();
  }
  $('cloze-check').onclick = () => checkSlot(controls.get(selected), true);
  $('cloze-hint').onclick = () => help(controls.get(selected), 'more');
  $('cloze-hide').onclick = () => help(controls.get(selected), 'hide');
  async function flush() {
    const fields = [...controls.values()].filter(f => active(f));
    await Promise.all(fields.map(save));
    // Blur checks and focus updates also change the board revision. Finish those
    // before a navigation/submission command uses that revision.
    await Promise.all(fields.flatMap(f => [f.checkPromise, f.helpPromise]));
  }
  async function submit() {
    if (submitting || current?.stage !== 'cloze' || [...controls.values()].some(f => f.composing)) return;
    const missing = [...controls.values()].find(f => !f.input.value.trim());
    if (missing) {
      missing.input.focus();
      error(new Error(`第 ${missing.index + 1} 空还没有填写。填完后再提交整句。`));
      return;
    }
    const submittedRound = current.id;
    submitting = true; progress();
    try {
      await flush();
      if (getState()?.active?.id === submittedRound && getState().active.stage === 'cloze') await command('cloze_submit');
    } catch (e) { error(e); }
    finally { submitting = false; if (current?.stage === 'cloze') progress(); }
  }
  $('cloze-submit').onclick = submit;
  document.addEventListener('keydown', event => {
    if (current?.stage !== 'cloze' || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing) return;
    if ([...controls.values()].some(f => f.composing)) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) void submit();
  }, true);
  return { update, flush };
}
