import { markup, changeList } from './view.js';

// A correction laid out line by line instead of crossed out and inserted in one line: what was written,
// with the words that change in red; the corrected (or prepared) wording under it, with the new words in
// green; then each change on its own row with why. Only text that really came back is marked.
export function renderCorrection(node, { text, corrected, changes = [], language = 'en', label = '改成' }) {
  node.replaceChildren(); node.lang = language;
  if (!text?.trim()) return null;
  const marked = corrected ? markup(text, corrected, language) : null;
  const line = (title, kind) => {
    const wrap = document.createElement('div'); wrap.className = 'c-line';
    const head = document.createElement('span'); head.className = 'c-label'; head.textContent = title;
    const body = document.createElement('p'); body.className = 'c-text'; body.lang = language;
    for (const part of marked?.changes ? marked.parts : [{ type: 'kept', text }]) {
      if (part.type === 'kept') { body.append(part.text); continue; }
      if (part.type !== kind) continue;
      // The mark hugs its words; the spaces around it stay plain.
      const [, lead, core, tail] = part.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (lead) body.append(lead);
      if (core) { const mark = document.createElement('mark'); mark.className = kind === 'cut' ? 'c-cut' : 'c-add'; mark.textContent = core; body.append(mark); }
      if (tail) body.append(tail);
    }
    wrap.append(head, body); return wrap;
  };
  node.append(line('你写的', 'cut'));
  if (!marked?.changes) return marked;
  node.append(line(label, 'add'));
  const rows = changes.length ? changes : changeList(text, corrected, language);
  if (rows.length) {
    const list = document.createElement('ul'); list.className = 'c-rows';
    for (const change of rows) {
      const item = document.createElement('li'), from = document.createElement('span'), to = document.createElement('span');
      from.className = 'c-from'; from.textContent = change.from; from.lang = language;
      to.className = 'c-to'; to.textContent = change.to; to.lang = language;
      item.append(from, ' → ', to);
      if (change.why) { const why = document.createElement('span'); why.className = 'c-why'; why.textContent = change.why; item.append(why); }
      list.append(item);
    }
    node.append(list);
  }
  return marked;
}
