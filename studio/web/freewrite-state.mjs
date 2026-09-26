// CognosOS mental_dump: five minutes of pressure, eight seconds without input.
export const PRESSURE_MS = 300_000;
export const IDLE_MS = 8_000;
export const WARNING_MS = 4_000;

export function beginWriting(now) {
  return { status: 'running', startedAt: now, endsAt: now + PRESSURE_MS, lastInputAt: now, text: '' };
}
export function advanceWriting(state, now, composing = false) {
  if (!state || state.status !== 'running') return state;
  // Resolve the first deadline, even if the browser slept past both deadlines.
  if (!composing && state.lastInputAt + IDLE_MS < state.endsAt && now >= state.lastInputAt + IDLE_MS) {
    return { ...state, status: 'failed', text: '', submission: null };
  }
  if (now >= state.endsAt) return { ...state, status: 'unlocked' };
  return composing ? { ...state, lastInputAt: now } : state;
}
export function editWriting(state, value, now, composing = false) {
  const next = advanceWriting(state, now, composing);
  if (!next || !['running', 'unlocked'].includes(next.status) || value === next.text) return next;
  return { ...next, text: value, lastInputAt: now, submission: null };
}
export function restoreWriting(raw, now) {
  try {
    const s = JSON.parse(raw);
    if (!s || !['running', 'unlocked', 'failed'].includes(s.status) || typeof s.text !== 'string' || s.text.length > 20000) return null;
    if (![s.startedAt, s.endsAt, s.lastInputAt].every(Number.isFinite) || s.endsAt !== s.startedAt + PRESSURE_MS || s.lastInputAt < s.startedAt) return null;
    return advanceWriting(s.status === 'failed' ? { ...s, text: '', submission: null } : s, now);
  } catch { return null; }
}
