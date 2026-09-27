// An explanation line marks every piece of the language being learned: {recently}, {ときどき}, and Japanese written
// with kanji together with how it is read here, {毎日|まいにち}. On screen the marks disappear and the pieces are set
// apart; read aloud, each piece is said in its own language. A Chinese-speaking voice sees 毎日 and says měirì, so
// what it is given is the kana, which have no Chinese reading at all (reported by the learner, 2026-09-27).
const MARK = /\{([^{}|]+)(?:\|([^{}|]+))?\}/gu;

// The line in order: plain Chinese parts, and marked parts with their reading, if any.
export function segments(line) {
  const out = [];
  let at = 0;
  for (const m of String(line).matchAll(MARK)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ text: m[1].trim(), foreign: true, reading: m[2]?.trim() || '' });
    at = m.index + m[0].length;
  }
  if (at < String(line).length) out.push({ text: String(line).slice(at) });
  // A mark the model left half-written is dropped rather than shown or read out.
  return out.map(s => s.foreign ? s : { text: s.text.replace(/[{}|]/g, '') }).filter(s => s.text);
}
// What is shown, and what the text model or the tutor is given back.
export const shownText = line => segments(line).map(s => s.text).join('');
// What Gemini's voice is given: the Chinese and the English as written, the Japanese by its kana. Japanese with
// kanji that came without its reading is set in 「」, which its instructions say to read as Japanese.
export const spokenText = (line, target = 'en') => segments(line).map(s => !s.foreign ? s.text : s.reading
  || (target === 'ja' && /\p{Script=Han}/u.test(s.text) ? `「${s.text}」` : s.text)).join('');
// For a browser voice, which speaks one language at a time: runs of the same language, in order.
export function spokenRuns(line, target = 'en') {
  const foreign = target === 'ja' ? 'ja-JP' : 'en-US', runs = [];
  for (const s of segments(line)) {
    const lang = s.foreign ? foreign : 'zh-CN', text = s.foreign ? s.reading || s.text : s.text;
    if (!text.trim()) continue;
    const last = runs.at(-1);
    if (last?.lang === lang) last.text += text; else runs.push({ lang, text });
  }
  return runs.filter(r => /[\p{L}\p{N}]/u.test(r.text));
}
// The line as page content, with the marked pieces set apart and labelled with their language.
export function renderLine(item, line, target = 'en') {
  item.replaceChildren(...segments(line).map(s => {
    if (!s.foreign) return document.createTextNode(s.text);
    const span = document.createElement('span');
    span.className = 'foreign'; span.lang = target === 'ja' ? 'ja' : 'en'; span.textContent = s.text;
    if (s.reading && s.reading !== s.text) span.title = s.reading;
    return span;
  }));
}
