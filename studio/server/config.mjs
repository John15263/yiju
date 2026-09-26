import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export function config(env = process.env) {
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const endpoint = env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
  // Credentials may only be sent to the official endpoint, never a browser-provided URL.
  if (endpoint !== 'https://api.typesafe.ai/v1/systemone') throw new Error('JEV_API_URL must be the official TypeSafe endpoint');
  const port = number('STUDIO_PORT', 4317, 1, 65535);
  if (!Number.isInteger(port)) throw new Error('Invalid STUDIO_PORT');
  const geminiModel = env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  // How much the text model thinks before answering. 3.8-flash defaults to medium, which roughly doubled
  // the wait on a hint (6.8 s → 3.2 s at low, measured 2026-09-23). Empty leaves the model's default.
  const geminiThinkingLevel = (env.GEMINI_THINKING_LEVEL ?? 'low').trim().toLowerCase();
  if (!['', 'minimal', 'low', 'medium', 'high'].includes(geminiThinkingLevel)) throw new Error('Invalid GEMINI_THINKING_LEVEL');
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(geminiModel)) throw new Error('Invalid GEMINI_MODEL');
  // Live models answer only on bidiGenerateContent, so they are named separately from the review model.
  // The chunk gate: Gemini both decides and explains. 'jev' keeps the older classifier path.
  // Every text call — chunk checks, hints and the Chinese reordering included — uses GEMINI_MODEL.
  const phraseGate = env.PHRASE_GATE?.trim() || 'gemini';
  if (!['gemini', 'jev'].includes(phraseGate)) throw new Error('Invalid PHRASE_GATE');
  const geminiLiveModel = env.GEMINI_LIVE_MODEL?.trim() || 'gemini-3.8-live-extended-thinking';
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(geminiLiveModel)) throw new Error('Invalid GEMINI_LIVE_MODEL');
  // Low keeps the tutor's turns quick; the level only applies to thinking-capable live models.
  const voiceThinkingLevel = (env.VOICE_THINKING_LEVEL?.trim() || 'LOW').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(voiceThinkingLevel)) throw new Error('Invalid VOICE_THINKING_LEVEL');
  // Correction cards go to Anki through AnkiConnect, only ever on this machine.
  const ankiUrl = env.ANKI_CONNECT_URL?.trim() || 'http://127.0.0.1:8766';
  const ankiHost = (() => { try { return new URL(ankiUrl).hostname; } catch { return ''; } })();
  if (!['127.0.0.1', 'localhost'].includes(ankiHost)) throw new Error('ANKI_CONNECT_URL must point at this machine');
  const ankiDeck = env.ANKI_DECK?.trim() || '一句::改错';
  // Hints and explanations read aloud. Flash-Lite TTS is a third cheaper than Flash TTS ($6 against $9 per
  // million audio tokens, 2026 prices) and plenty clear for this, so it is the default (2026-09-24).
  const geminiTtsModel = env.GEMINI_TTS_MODEL?.trim() || 'gemini-3.8-flash-lite-tts';
  if (!/^gemini-[\w.-]+-tts$/.test(geminiTtsModel)) throw new Error('Invalid GEMINI_TTS_MODEL');
  const geminiTtsVoice = env.GEMINI_TTS_VOICE?.trim() || 'Kore';
  if (!/^[A-Za-z][\w-]{1,40}$/.test(geminiTtsVoice)) throw new Error('Invalid GEMINI_TTS_VOICE');
  return {
    port, endpoint, ankiUrl, ankiDeck, key: env.TYPESAFE_API_KEY?.trim() || '', model: env.JEV_MODEL || 'jev-latest',
    timeout: number('JEV_TIMEOUT_MS', 10000, 100, 60000),
    confidence: number('JEV_MIN_CONFIDENCE', 0.8, 0, 1),
    gap: number('JEV_MIN_PROBABILITY_GAP', 0.2, 0, 1),
    hideConfidence: number('JEV_HIDE_MIN_CONFIDENCE', 0.9, 0, 1),
    minCueMs: number('JEV_MIN_CUE_MS', 3000, 0, 60000),
    phraseGate,
    geminiKey: env.GEMINI_API_KEY?.trim() || '', geminiModel, geminiThinkingLevel, geminiLiveModel, geminiTtsModel, geminiTtsVoice,
    // The calls the learner waits on while writing. With the full model thinking first, a check takes
    // 2.5–5 s and a hint about 6 s (measured 2026-09-23), so the limit leaves room above that.
    geminiNoteTimeout: number('GEMINI_NOTE_TIMEOUT_MS', 20000, 1000, 60000),
    voiceMaxSeconds: number('VOICE_MAX_SECONDS', 600, 30, 3600), voiceThinkingLevel,
    // Calls start by themselves now, so one nobody is using ends before it runs up the bill.
    voiceIdleSeconds: number('VOICE_IDLE_SECONDS', 90, 15, 3600),
    geminiTimeout: number('GEMINI_TIMEOUT_MS', 30000, 100, 120000),
    geminiPreparationTimeout: number('GEMINI_PREPARATION_TIMEOUT_MS', 60000, 100, 180000),
  };
}
