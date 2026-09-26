const labels = { core_logic: '核心逻辑 · 想说什么', core_structure: '核心结构 · 如何展开', supporting_logic: '辅助逻辑 · 理由与限定', supporting_structure: '辅助结构 · 补充放在哪里' };
export const roleLabel = role => ({ core: '核心', support: '辅助', mixed: '核心＋辅助' })[role] || '';
export function renderUncertainties(container, outline) {
  container.replaceChildren();
  const questions = outline?.uncertainties || [];
  container.hidden = !questions.length;
  if (!questions.length) return;
  const title = document.createElement('p'); title.className = 'label'; title.textContent = '请确认这些含义'; container.append(title);
  for (const question of questions) { const p = document.createElement('p'); p.textContent = question; container.append(p); }
}
// Chinese-only view of the units: what the learner confirms before any foreign text appears.
export function renderPreviewMeanings(container, units) {
  container.replaceChildren();
  for (const [index, unit] of units.entries()) {
    const item = document.createElement('div'); item.className = 'preview-unit';
    const title = document.createElement('p'); title.className = 'label';
    title.textContent = `第 ${index + 1} 句${unit.role ? ` · ${roleLabel(unit.role)} · ${unit.purpose}` : ''}`;
    const meaning = document.createElement('p'); meaning.className = 'unit-meaning-main'; meaning.textContent = unit.material.meaning;
    item.append(title, meaning);
    if (unit.connection) { const link = document.createElement('p'); link.className = 'unit-connection'; link.textContent = `衔接：${unit.connection}`; item.append(link); }
    if (unit.source_quotes?.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '原文依据'; details.append(summary);
      for (const quote of unit.source_quotes) { const p = document.createElement('p'); p.className = 'source-quote'; p.textContent = quote; details.append(p); }
      item.append(details);
    }
    container.append(item);
  }
}
export function renderOutline(container, outline, { uncertainties = true } = {}) {
  container.replaceChildren();
  if (!outline) return;
  for (const [key, label] of Object.entries(labels)) {
    const section = document.createElement('div'); section.className = 'outline-part';
    const title = document.createElement('p'); title.className = 'label'; title.textContent = label; section.append(title);
    if (outline[key].length) {
      const list = document.createElement('ul');
      for (const line of outline[key]) { const item = document.createElement('li'); item.textContent = line; list.append(item); }
      section.append(list);
    } else { const note = document.createElement('p'); note.textContent = '原文没有需要另列的辅助内容。'; section.append(note); }
    container.append(section);
  }
  if (uncertainties && outline.uncertainties.length) {
    const note = document.createElement('div'); note.className = 'outline-uncertain';
    const title = document.createElement('p'); title.className = 'label'; title.textContent = '请确认这些含义'; note.append(title);
    for (const question of outline.uncertainties) { const p = document.createElement('p'); p.textContent = question; note.append(p); }
    container.append(note);
  }
}
export function renderPreviewUnits(container, units, language) {
  container.replaceChildren(); container.lang = language;
  for (const [index, unit] of units.entries()) {
    const item = document.createElement('div'); item.className = 'preview-unit';
    const title = document.createElement('p'); title.className = 'label'; title.textContent = `第 ${index + 1} 句${unit.role ? ` · ${roleLabel(unit.role)} · ${unit.purpose}` : ''}`;
    const meaning = document.createElement('p'); meaning.className = 'unit-meaning'; meaning.textContent = unit.material.meaning;
    const reference = document.createElement('p'); reference.className = 'unit-reference'; reference.textContent = unit.material.reference;
    item.append(title, meaning, reference);
    if (unit.connection) { const link = document.createElement('p'); link.className = 'unit-connection'; link.textContent = `衔接：${unit.connection}`; item.append(link); }
    if (unit.source_quotes?.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '原文依据'; details.append(summary);
      for (const quote of unit.source_quotes) { const p = document.createElement('p'); p.className = 'source-quote'; p.textContent = quote; details.append(p); }
      item.append(details);
    }
    container.append(item);
  }
}
