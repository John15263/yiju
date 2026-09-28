// Plain JavaScript: runs in Node for the local server and in the browser for the extension, which has no
// project folder (root is then empty).
const url = globalThis.process?.getBuiltinModule?.('node:url');
export const root = url ? url.fileURLToPath(new URL('../../', import.meta.url)) : '';

export function config(env = process.env) {
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const model = (key, fallback) => {
    const value = env[key]?.trim() || fallback;
    if (!/^[a-zA-Z0-9.-]{1,100}$/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const choice = (key, options, fallback) => {
    const value = env[key]?.trim().toLowerCase() || fallback;
    if (!options.includes(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const endpoint = env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
  // Credentials may only be sent to the official endpoint, never a browser-provided URL.
  if (endpoint !== 'https://api.typesafe.ai/v1/systemone') throw new Error('JEV_API_URL must be the official TypeSafe endpoint');
  const port = number('STUDIO_PORT', 4317, 1, 65535);
  if (!Number.isInteger(port)) throw new Error('Invalid STUDIO_PORT');
  const geminiKey = env.GEMINI_API_KEY?.trim() || '';
  const geminiModel = model('GEMINI_MODEL', 'gemini-3.8-flash');
  // How much the text model thinks before answering. 3.8-flash defaults to medium, which roughly doubled
  // the wait on a hint (6.8 s → 3.2 s at low, measured 2026-09-23). Empty leaves the model's default.
  const geminiThinkingLevel = (env.GEMINI_THINKING_LEVEL ?? 'low').trim().toLowerCase();
  if (!['', 'minimal', 'low', 'medium', 'high'].includes(geminiThinkingLevel)) throw new Error('Invalid GEMINI_THINKING_LEVEL');
  // Who answers the text calls (preparing, checks, hints, reviews, explanations): Gemini by default, or DeepSeek,
  // or Qwen on Alibaba Cloud Model Studio (百炼), which shares its key and region with the Qwen voice.
  const textProvider = choice('TEXT_PROVIDER', ['gemini', 'deepseek', 'qwen'], 'gemini');
  const deepseekModel = model('DEEPSEEK_MODEL', 'deepseek-flash');
  const qwenTextModel = model('QWEN_TEXT_MODEL', 'qwen3.8-max');
  // Thinking first made Qwen's checks take 9–14 s in 一题 (2026-09-26), too slow to wait on, so it is off unless asked for.
  const qwenThinking = choice('QWEN_THINKING', ['on', 'off'], 'off') === 'on';
  // DeepSeek thinks first by default: a preparation took 27–39 s that way and 7–11 s without (2026-09-27), and
  // its checks outran their 20 s. Off unless asked for.
  const deepseekThinking = choice('DEEPSEEK_THINKING', ['on', 'off'], 'off') === 'on';
  // The chunk gate: the text model both decides and explains. 'jev' keeps the older classifier path.
  const phraseGate = env.PHRASE_GATE?.trim() || 'gemini';
  if (!['gemini', 'jev'].includes(phraseGate)) throw new Error('Invalid PHRASE_GATE');
  // Who speaks in the voice tutor: Gemini Live, Qwen-Omni-Realtime on Model Studio, or nobody.
  const voiceProvider = choice('VOICE_PROVIDER', ['gemini', 'qwen', 'none'], 'gemini');
  // Live models answer only on bidiGenerateContent, so they are named separately from the text model.
  const geminiLiveModel = model('GEMINI_LIVE_MODEL', 'gemini-3.8-live-extended-thinking');
  // Low keeps the tutor's turns quick; the level only applies to thinking-capable live models.
  const voiceThinkingLevel = (env.VOICE_THINKING_LEVEL?.trim() || 'LOW').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(voiceThinkingLevel)) throw new Error('Invalid VOICE_THINKING_LEVEL');
  const dashscopeRegion = env.DASHSCOPE_REGION?.trim() || 'cn-beijing';
  if (!['cn-beijing', 'ap-southeast-1'].includes(dashscopeRegion)) throw new Error('Invalid DASHSCOPE_REGION');
  const dashscopeWorkspace = env.DASHSCOPE_WORKSPACE_ID?.trim() || '';
  if (dashscopeWorkspace && !/^[A-Za-z0-9-]{1,64}$/.test(dashscopeWorkspace)) throw new Error('Invalid DASHSCOPE_WORKSPACE_ID');
  const qwenRealtimeModel = model('QWEN_REALTIME_MODEL', 'qwen3.8-omni-flash-realtime');
  const qwenVoice = env.QWEN_VOICE?.trim() || 'longanlingxin';
  if (!/^[A-Za-z][\w-]{0,40}$/.test(qwenVoice)) throw new Error('Invalid QWEN_VOICE');
  // Correction cards go to Anki through AnkiConnect, only ever on this machine.
  const ankiUrl = env.ANKI_CONNECT_URL?.trim() || 'http://127.0.0.1:8765';
  const ankiHost = (() => { try { return new URL(ankiUrl).hostname; } catch { return ''; } })();
  if (!['127.0.0.1', 'localhost'].includes(ankiHost)) throw new Error('ANKI_CONNECT_URL must point at this machine');
  const ankiDeck = env.ANKI_DECK?.trim() || '一句::改错';
  // Hints and explanations read aloud: by Gemini's speech models, or by the browser's own voices, which cost
  // nothing and need no key but sound flatter (Chrome's once went silent without saying why, 2026-09-24). 'mixed',
  // the default with a Gemini key, has Gemini read the explanations and the browser the many short hints: each
  // speech model allows only 100 readings a day on Tier 1, and hints alone used them up (2026-09-27).
  const speechProvider = choice('SPEECH_PROVIDER', ['mixed', 'gemini', 'browser'], geminiKey ? 'mixed' : 'browser');
  // Flash-Lite TTS is a third cheaper than Flash TTS ($6 against $9 per million audio tokens, 2026 prices) and
  // plenty clear for this, so it is the default (2026-09-24).
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
    textProvider, geminiKey, geminiModel, geminiThinkingLevel, deepseekKey: env.DEEPSEEK_API_KEY?.trim() || '', deepseekModel, deepseekThinking,
    qwenTextModel, qwenThinking, dashscopeKey: env.DASHSCOPE_API_KEY?.trim() || '', dashscopeRegion, dashscopeWorkspace,
    voiceProvider, geminiLiveModel, voiceThinkingLevel, qwenRealtimeModel, qwenVoice,
    speechProvider, geminiTtsModel, geminiTtsVoice,
    // Cards are pushed only where the runner turns this on: the local server by default, the extension when asked.
    ankiPush: choice('ANKI_PUSH', ['on', 'off'], 'off') === 'on',
    // The calls the learner waits on while writing. With the full model thinking first, a check takes
    // 2.5–5 s and a hint about 6 s (measured 2026-09-23), so the limit leaves room above that.
    geminiNoteTimeout: number('GEMINI_NOTE_TIMEOUT_MS', 20000, 1000, 60000),
    voiceMaxSeconds: number('VOICE_MAX_SECONDS', 600, 30, 3600),
    // Calls start by themselves now, so one nobody is using ends before it runs up the bill.
    voiceIdleSeconds: number('VOICE_IDLE_SECONDS', 90, 15, 3600),
    geminiTimeout: number('GEMINI_TIMEOUT_MS', 30000, 100, 120000),
    geminiPreparationTimeout: number('GEMINI_PREPARATION_TIMEOUT_MS', 60000, 100, 180000),
  };
}
