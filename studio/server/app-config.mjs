import { textConfigured, textModel, textName } from './llm.mjs';
import { voiceProvider, voiceConfigured } from './voice-providers.mjs';

// What the page is told about the services, without any key. The gemini_* names are kept from when every text
// call was Gemini's; they now describe whichever text service is set.
export function appConfig(cfg) {
  const voice = voiceProvider(cfg);
  return { jev_configured: Boolean(cfg.key), model: cfg.model,
    text_provider: cfg.textProvider, text_name: textName(cfg), gemini_configured: textConfigured(cfg), gemini_model: textModel(cfg),
    voice_provider: cfg.voiceProvider, voice_name: voice.name, voice_configured: voiceConfigured(cfg), voice_model: voice.model(cfg),
    speech_provider: cfg.speechProvider, speech_configured: cfg.speechProvider === 'browser' || Boolean(cfg.geminiKey),
    speech_model: cfg.speechProvider === 'browser' ? '' : cfg.geminiTtsModel, speech_voice: cfg.speechProvider === 'browser' ? '' : cfg.geminiTtsVoice,
    anki: cfg.ankiPush, voice_max_seconds: cfg.voiceMaxSeconds, native_voice: 'NOT_RUN', transcript_subscription: false };
}
