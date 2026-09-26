import { openQuiz } from './view.js';

// The corrections, filled back in from memory right after they were explained. Each blank is a box in
// the line; blanks already right stay locked, only the wrong ones are tried again, and after the last
// try the answers are shown beside them.
export function createQuizUI({ api, render, getState, error }) {
  const $ = id => document.getElementById(id);
  let mounted = '', boxes = [], working = false;
  const current = () => openQuiz(getState()?.active);
  function build(quiz) {
    const line = $('quiz-line'); line.replaceChildren(); line.lang = quiz.language; boxes = [];
    const done = quiz.status === 'done';
    for (const segment of quiz.segments) {
      if (typeof segment === 'string') { line.append(segment); continue; }
      const i = segment.blank, result = quiz.results[i], wrap = document.createElement('span'), box = document.createElement('input');
      wrap.className = 'quiz-blank' + (result ? (result.ok ? ' right' : ' wrong') : '');
      box.type = 'text'; box.autocomplete = 'off'; box.spellcheck = false; box.lang = quiz.language;
      box.value = quiz.inputs[i] ?? ''; box.size = Math.max(4, quiz.answers[i].length + 2);
      box.setAttribute('aria-label', `第 ${i + 1} 空`);
      box.disabled = done || !!result?.ok;
      box.onkeydown = event => {
        if (event.isComposing || event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
        // Enter walks to the next open blank; on the last one it checks.
        event.preventDefault();
        const next = boxes.slice(boxes.indexOf(box) + 1).find(b => !b.disabled);
        if (next) next.focus(); else void submit();
      };
      wrap.append(box);
      if (done && !result?.ok) { const answer = document.createElement('span'); answer.className = 'quiz-answer'; answer.textContent = quiz.answers[i]; wrap.append(answer); }
      boxes.push(box); line.append(wrap);
    }
    $('quiz-notes').replaceChildren(...quiz.results.flatMap((result, i) => result && !result.ok && result.note
      ? [Object.assign(document.createElement('li'), { textContent: `第 ${i + 1} 空：${result.note}` })] : []));
    // A wrong answer comes back selected, so the next try is typed over it.
    requestAnimationFrame(() => { const box = boxes.find(b => !b.disabled); if (box) { box.focus(); box.select(); } else $('quiz-submit').focus(); });
  }
  function update(r) {
    const quiz = r ? openQuiz(r) : null;
    $('quiz-region').hidden = !quiz;
    if (!quiz) { mounted = ''; boxes = []; $('quiz-line').replaceChildren(); $('quiz-notes').replaceChildren(); return; }
    const key = `${quiz.id}:${quiz.tries}:${quiz.status}`;
    if (key !== mounted) { mounted = key; build(quiz); }
    $('quiz-title').textContent = quiz.kind === 'chunk' ? '改错小测 · 把刚才改过的地方填回去' : '改错小测 · 把这句改过的地方填回去';
    $('quiz-meaning').textContent = quiz.meaning;
    const done = quiz.status === 'done';
    $('quiz-status').textContent = done ? '答案写在旁边了，看一眼，⌘ ↵ 继续。'
      : quiz.tries ? '还有没填对的，再试一次。' : '凭记忆填，Enter 跳到下一空，⌘ ↵ 检查。';
    $('quiz-submit').textContent = working ? '正在检查…' : done ? '继续 · ⌘ ↵' : '检查 · ⌘ ↵';
    $('quiz-submit').disabled = working;
  }
  async function submit() {
    const r = getState()?.active, quiz = current();
    if (!quiz || working) return;
    working = true; update(r);
    try {
      render(await api(quiz.status === 'done' ? '/quiz/continue' : '/quiz/answer',
        quiz.status === 'done' ? { round_id: r.id, quiz_id: quiz.id } : { round_id: r.id, quiz_id: quiz.id, answers: boxes.map(b => b.value) }));
    } catch (e) { error(e); }
    finally { working = false; update(getState()?.active); }
  }
  $('quiz-submit').onclick = submit;
  // Command + Enter belongs to the quiz wherever the cursor is while it is on screen.
  document.addEventListener('keydown', event => {
    if ($('quiz-region').hidden || event.isComposing || event.repeat || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }, true);
  return { update };
}
