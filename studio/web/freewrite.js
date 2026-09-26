import { PRESSURE_MS, IDLE_MS, WARNING_MS, beginWriting, advanceWriting, editWriting, restoreWriting } from './freewrite-state.mjs';

export function createFreewriteUI({ api, onUse, onChange, onReturn }) {
  const $ = id => document.getElementById(id), key = 'sentence-freewrite:v1';
  let saved = null;
  try { saved = sessionStorage.getItem(key); } catch {}
  let session = restoreWriting(saved, Date.now()), open = !!session, composing = false, saving = false, message = '';
  let editor = $('freewrite-text');
  const format = ms => { const sec = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  function persist() {
    try { if (session) sessionStorage.setItem(key, JSON.stringify(session)); else sessionStorage.removeItem(key); }
    catch { message = '浏览器暂存不可用，请保持此页打开，完成后再进入学习。'; }
  }
  function paint() {
    $('freewrite').hidden = !open;
    const running = session?.status === 'running', unlocked = session?.status === 'unlocked', failed = session?.status === 'failed';
    const now = Date.now(), left = running ? Math.max(0, session.endsAt - now) : 0;
    const idle = running ? Math.max(0, IDLE_MS - (now - session.lastInputAt)) : IDLE_MS;
    const warning = running && idle <= WARNING_MS;
    $('freewrite').classList.toggle('is-warning', warning);
    $('freewrite-clock').textContent = running ? format(left) : unlocked ? '已解锁' : '本轮已清空';
    $('freewrite-idle').textContent = running ? `停笔倒计时 ${Math.ceil(idle / 1000)} 秒` : unlocked ? '文字不会再因停笔消失' : '可以重新开始';
    $('freewrite-message').textContent = message || (failed ? '停笔超过 8 秒，本轮文字已消失。准备好后再写一次。' : unlocked ? '已写满 5 分钟。可以继续写，或保留原文进入语言学习。' : warning ? '继续写，想到什么就写什么，不用组织好。' : '先把想法写出来，不急着整理，也不用判断对错。');
    $('freewrite-count').textContent = `${session?.text.length || 0} / 20,000 字符`;
    $('freewrite-progress').value = unlocked ? PRESSURE_MS : running ? PRESSURE_MS - left : 0;
    $('freewrite-progress').max = PRESSURE_MS;
    editor.disabled = saving || failed;
    editor.hidden = failed;
    editor.style.opacity = warning ? String(0.25 + 0.75 * idle / WARNING_MS) : '1';
    $('freewrite-use').hidden = failed;
    $('freewrite-use').disabled = !unlocked || saving || !session.text.trim();
    $('freewrite-use').textContent = saving ? '正在保留原文…' : unlocked ? '保留原文，进入语言学习' : '写满 5 分钟后进入学习';
    $('freewrite-retry').hidden = !failed;
    $('freewrite-exit').textContent = failed ? '回到内容入口' : '放弃并清空本轮';
    $('freewrite-exit').disabled = saving;
  }
  function update(next) {
    const changed = session !== next, previousStatus = session?.status;
    session = next;
    if (changed) persist();
    if (session?.status === 'failed') { editor.value = ''; composing = false; }
    paint();
    if (previousStatus !== session?.status) onChange();
  }
  function tick() {
    if (!open || !session) return;
    update(advanceWriting(session, Date.now(), composing && !document.hidden));
  }
  function bindEditor() {
    editor.oninput = event => {
      const next = editWriting(session, editor.value, Date.now(), composing || event.isComposing);
      update(next);
      if (next?.status === 'failed') editor.value = '';
    };
    editor.oncompositionstart = () => {
      update(advanceWriting(session, Date.now()));
      if (session?.status === 'running') { composing = true; update({ ...session, lastInputAt: Date.now() }); }
    };
    editor.oncompositionend = () => { update(advanceWriting(session, Date.now(), composing && !document.hidden)); composing = false; editor.oninput({ isComposing: false }); };
    editor.onblur = () => { composing = false; tick(); };
    editor.onkeydown = event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault(); if (!event.repeat && session?.status === 'unlocked') void useWriting();
      }
    };
  }
  function start() {
    // New element removes the previous round's native undo buffer.
    const fresh = editor.cloneNode(false); editor.replaceWith(fresh); editor = fresh; editor.value = ''; bindEditor();
    session = beginWriting(Date.now()); open = true; composing = false; message = ''; persist(); paint(); onChange();
    editor.focus(); $('freewrite').scrollIntoView({ block: 'start' });
  }
  async function useWriting() {
    tick();
    if (saving || session?.status !== 'unlocked' || !session.text.trim()) return;
    const content = session.text;
    session.submission ||= { id: crypto.randomUUID(), text: content, started_at: new Date(session.startedAt).toISOString(), finished_at: new Date().toISOString() };
    saving = true; message = ''; persist(); paint();
    try {
      await api('/freewrites', session.submission);
      // Save before handing off. A failed Gemini request can never erase this original.
      onUse(content);
      session = null; open = false; persist();
    } catch { message = '未能完成交接，文字仍在这里。可以重试；不会因停笔清空。'; }
    finally { saving = false; paint(); onChange(); }
  }
  $('freewrite-use').onclick = useWriting;
  $('freewrite-retry').onclick = start;
  $('freewrite-exit').onclick = () => {
    if (saving) return;
    session = null; editor.value = ''; open = false; composing = false; message = ''; persist(); paint(); onReturn(); onChange();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) composing = false; tick(); });
  window.addEventListener('pageshow', tick);
  setInterval(tick, 250);
  bindEditor(); editor.value = session?.text || ''; persist(); paint();
  return { start, isOpen: () => open };
}
