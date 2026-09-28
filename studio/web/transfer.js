import { openTransfer } from './view.js';
import { renderCorrection } from './correction.js';

// 换个场合: the Chinese of a new sentence is on the desk (as its heading); here it is said in the language
// being learned, with the wording just practised. Hints come a line at a time, newest on top, the last one
// being the answer. After the last try, what was written is shown against its correction and the example.
const LANGUAGE = { en: '英语', ja: '日语' };
export function currentTransfer(state) {
  const r = state?.active, c = state?.collection;
  return openTransfer(r, c?.transfer, !!c && c.units.every(u => u.stage === 'complete'));
}

export function createTransferUI({ api, render, getState, error }) {
  const $ = id => document.getElementById(id);
  let mounted = '', working = false;
  const at = () => { const transfer = currentTransfer(getState()); return transfer ? { transfer, item: transfer.items[transfer.index] } : null; };
  const ids = ({ transfer, item }) => ({ transfer_id: transfer.id, item_id: item.id });
  function update(state) {
    const transfer = state ? currentTransfer(state) : null;
    $('transfer-region').hidden = !transfer;
    if (!transfer) { mounted = ''; return; }
    const item = transfer.items[transfer.index], last = item.results.at(-1), done = item.status === 'done';
    const language = state.active.language, box = $('transfer-text');
    const key = `${item.id}:${item.tries}:${item.status}`;
    if (key !== mounted) {
      mounted = key; box.lang = language; box.value = item.inputs.at(-1) ?? '';
      // A wrong answer comes back selected, so the next try is typed over it.
      requestAnimationFrame(() => { if (done) $('transfer-submit').focus(); else { box.focus(); if (item.tries) box.select(); } });
    }
    box.disabled = done || working;
    box.placeholder = `用${LANGUAGE[language] || '外语'}把这个意思说出来，可以用刚才练过的说法。`;
    $('transfer-hints').replaceChildren(...[...item.hints].reverse().map(text => Object.assign(document.createElement('li'), { textContent: text, lang: 'zh-CN' })));
    $('transfer-hints').hidden = !item.hints.length;
    const note = last?.note || (last && !done && ['partly', 'miss'].includes(last.verdict) ? '还差一点，再试一次。' : '');
    $('transfer-note').textContent = note;
    $('transfer-result').hidden = !done;
    if (done) {
      renderCorrection($('transfer-marking'), { text: item.inputs.at(-1) || '', corrected: last?.suggestion, language });
      $('transfer-example').textContent = item.example; $('transfer-example').lang = language;
      $('transfer-axis').textContent = `练的说法：${item.axis}（${item.axis_meaning}）· 原来那一块：${item.chunk_reference}`;
    } else $('transfer-marking').replaceChildren();
    $('transfer-status').textContent = done ? (item.passed ? '说对了。⌘ ↵ 继续。' : '看一眼参考说法，⌘ ↵ 继续。')
      : item.tries ? '再试一次，⌘ ↵ 检查。' : '⌘ ↵ 检查，⌘ [ 要提示。';
    $('transfer-submit').textContent = working ? '正在检查…' : done ? '继续 · ⌘ ↵' : '检查 · ⌘ ↵';
    $('transfer-submit').disabled = working;
    $('transfer-help').hidden = done || item.hint_level >= 3; $('transfer-help').disabled = working;
    $('transfer-skip').textContent = transfer.items.length - transfer.index > 1 ? '跳过剩下的' : '跳过';
    $('transfer-skip').disabled = working;
  }
  async function send(path, body) {
    if (working) return;
    working = true; update(getState());
    try { render(await api(path, body)); } catch (e) { error(e); }
    finally { working = false; update(getState()); }
  }
  function submit() {
    const open = at();
    if (!open) return;
    if (open.item.status === 'done') return send('/transfer/continue', ids(open));
    const answer = $('transfer-text').value;
    if (!answer.trim()) { $('transfer-text').focus(); return; }
    return send('/transfer/answer', { ...ids(open), answer });
  }
  function help() {
    const open = at();
    if (open && open.item.status === 'open' && open.item.hint_level < 3) return send('/transfer/help', ids(open));
  }
  $('transfer-submit').onclick = () => void submit();
  $('transfer-help').onclick = () => void help();
  $('transfer-skip').onclick = () => { const open = at(); if (open) void send('/transfer/skip', ids(open)); };
  // Command + Enter belongs to the question wherever the cursor is while it is on screen.
  document.addEventListener('keydown', event => {
    if ($('transfer-region').hidden || event.isComposing || event.repeat || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault(); event.stopImmediatePropagation(); void submit();
  }, true);
  return { update, help, isOpen: () => !$('transfer-region').hidden };
}
