// Every hint given while writing, one message per hint in the order they came, newest at the bottom. Hints can
// come faster than they are read aloud, and each new one used to replace the last on screen; here none is lost,
// the one being read is marked, and clicking one reads it again (asked for by the learner, 2026-09-27).
// An entry: { key, text, spoken, lang, tag?, note? } — `spoken` is what is read aloud and what the voice
// reports back while reading it.
export function createHintLog(list, { onPick = () => {} } = {}) {
  let entries = [], reading = null;
  function mark() {
    // The newest entry with the words being read is the one marked, should the same words come twice.
    const at = reading ? entries.findLastIndex(e => e.spoken === reading) : -1;
    [...list.children].forEach((item, i) => item.classList.toggle('reading', i === at));
  }
  function itemOf(entry) {
    const item = document.createElement('li');
    if (entry.tag) { const tag = document.createElement('span'); tag.className = 'hint-tag'; tag.textContent = entry.tag; item.append(tag); }
    const words = document.createElement('span');
    words.textContent = entry.text; words.lang = entry.lang || '';
    item.append(words);
    if (entry.note) { const note = document.createElement('span'); note.className = 'hint-note'; note.textContent = entry.note; item.append(note); }
    item.title = '点一下再听一遍';
    item.onclick = () => { if (!String(globalThis.getSelection?.() || '').trim()) onPick(entry); };
    return item;
  }
  return {
    render(next) {
      // A new hint is added below the others, which stay where they are; another chunk starts a new list.
      const grows = entries.length <= next.length && entries.every((e, i) => e.key === next[i]?.key);
      if (grows && next.length === entries.length) return;
      if (grows) list.append(...next.slice(entries.length).map(itemOf));
      else list.replaceChildren(...next.map(itemOf));
      entries = next;
      list.hidden = !entries.length;
      mark();
      // The newest is always in view: the list scrolls down to it as it comes.
      list.scrollTo({ top: list.scrollHeight, behavior: grows ? 'smooth' : 'instant' });
    },
    reading(text) { reading = text || null; mark(); },
    clear() { entries = []; list.replaceChildren(); list.hidden = true; },
  };
}

// The same words again right after themselves ("Keep going" at every pause along the prepared wording) are one
// message, not a column of repeats; they are not read aloud twice either.
const distinct = entries => entries.filter((e, i) => i === 0 || e.text !== entries[i - 1].text);

// The hints of the chunk being written, in this run through the sentence, from what the practice recorded.
export function chunkHints(r) {
  const p = r?.phrases;
  if (!p?.items) return [];
  const run = p.run || 0, lang = r.language === 'ja' ? 'ja' : 'en';
  return distinct((r.support_events || []).filter(e => e.kind === 'phrase_hint' && e.detail?.index === p.index && (e.detail.run ?? 0) === run && e.detail.text)
    .map((e, n) => ({ key: `${e.at}:${n}`, text: e.detail.text, spoken: e.detail.text, lang, tag: e.level === 3 ? '参考' : e.level === 2 ? '关键词' : '' })));
}
// The hints shown while the whole sentence is written, in this writing of it: the idea, then the next word,
// a short phrase, the rest.
export function sentenceHints(r) {
  const lang = r?.language === 'ja' ? 'ja' : 'en';
  return distinct((r?.support_events || []).filter(e => e.kind === 'writing_hint' && e.detail?.window_start === r.window_start)
    .map((e, n) => {
      const d = e.detail, level = d.hint_level, text = level === 1 ? d.meaning : d.text;
      return { key: `${e.at}:${n}`, text, spoken: text, lang, tag: ['', '', '下一个词', '一小段', '续写'][level] || '', note: level > 1 ? d.note || '' : '' };
    }).filter(e => e.text));
}
