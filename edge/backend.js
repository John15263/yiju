// The extension's backend: the local server's engine, running inside the side panel. Records and keys live in
// the browser's own storage, and every model is called directly from here, with the learner's own key.
// Nothing passes through a server of ours. Same exports as web/backend.js, which reaches the local server instead.
import { SentenceBoard } from '../server/sentence.js';
import { Cloze } from '../server/cloze.js';
import { Reviews } from '../server/review.js';
import { Preparations } from '../server/preparation.js';
import { Freewrites } from '../server/freewrites.js';
import { WritingHelp } from '../server/writing-help.js';
import { Phrases } from '../server/phrases.js';
import { Voice } from '../server/voice.js';
import { Usage } from '../server/usage.js';
import { Quizzes } from '../server/quiz.js';
import { Transfers } from '../server/transfer.js';
import { Anki } from '../server/anki.js';
import { Speech, speechModels } from '../server/tts.js';
import { Explanations } from '../server/explain.js';
import { config } from '../server/config.js';
import { Settings, testServices } from '../server/settings.js';
import { textConfigured } from '../server/llm.js';
import { appConfig } from '../server/app-config.js';
import { usePrompts } from '../server/prompts.js';
import { HttpError } from '../server/validation.js';
import PROMPTS from '../prompts.js';
import { BrowserStore } from './store.js';
import { speechCache } from './speech-cache.js';
import { rtcUpstream, qwenRtcCheck } from './rtc.js';
import { dollars, badgeDollars, speechModelName, googleDayStart, speechCounts } from './usage-text.js';

export const local = false;
usePrompts(PROMPTS);
const store = await BrowserStore.open();
const settings = new Settings({ read: () => store.get('settings'), write: values => store.set('settings', values) });
// There is no .env in a browser: the settings page is the only source. AnkiConnect is at its default address unless
// the settings page gives another (any port on this computer is covered by the optional permission).
const base = { ANKI_CONNECT_URL: 'http://127.0.0.1:8765' };
const cfg = config(settings.env(base));
cfg.ttsCache = speechCache();
cfg.usage = new Usage(store);
const anki = new Anki(store, cfg); cfg.anki = anki;

const listeners = new Set();
const sentence = new SentenceBoard(store, state => { for (const listener of listeners) listener(state); });
sentence.anki = anki;
const cloze = new Cloze(sentence, cfg);
const reviews = new Reviews(sentence, cfg);
const preparations = new Preparations(sentence, cfg);
const freewrites = new Freewrites(store);
const writingHelp = new WritingHelp(sentence, cfg);
const phrases = new Phrases(sentence, cfg);
const quizzes = new Quizzes(sentence, cfg, phrases);
const transfers = new Transfers(sentence, cfg);
const speech = new Speech(cfg);

// The toolbar icon carries what today has cost; hovering it shows the day's calls and the Gemini speech models'
// readings, so none of it needs the provider's console (asked for by the learner, 2026-09-27). It turns orange
// when one speech model has spent its day's allowance and red when both have. Kept current as calls are made,
// and every ten minutes while the panel is open, so a new day shows as one.
let usageShown = null;
function showUsage() {
  clearTimeout(usageShown);
  usageShown = setTimeout(() => {
    try {
      const u = cfg.usage.summary(), today = u.today, models = speechModels(cfg.geminiTtsModel), spent = models.filter(m => !speech.ready(m));
      const lines = [chrome.i18n.getMessage('actionTitle'), `今天：调用 ${today.calls} 次，Gemini 约 ${dollars(today.usd)}`];
      if (today.unpriced) lines.push(`其中 ${today.unpriced} 次是 DeepSeek 或千问，不估金额`);
      const counts = speechCounts(u.speech);
      if (counts || spent.length) lines.push(`Gemini 朗读（从 ${googleDayStart(u.speech.since)} 算起）：${counts || '还没有'}${spent.length ? `；${spent.map(speechModelName).join('、')} 今天的次数用完了` : ''}`);
      lines.push(`近 7 天：Gemini 约 ${dollars(u.week.usd)}`);
      chrome.action.setTitle({ title: lines.join('\n') });
      chrome.action.setBadgeText({ text: today.calls ? badgeDollars(today.usd) : '' });
      chrome.action.setBadgeBackgroundColor({ color: spent.length >= models.length ? '#b3261e' : spent.length ? '#b7791f' : '#315e48' });
      chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    } catch {}
  }, 300);
}
const recordUsage = cfg.usage.record.bind(cfg.usage);
cfg.usage.record = entry => { const kept = recordUsage(entry); showUsage(); return kept; };
showUsage();
setInterval(showUsage, 10 * 60 * 1000);
const explanations = new Explanations(sentence, cfg);
// Gemini Live takes its key in the address, so a plain socket reaches it; Qwen goes over WebRTC.
let opened = null;
const voice = new Voice(sentence, cfg, (url, options) => (opened = url.startsWith('wss://generativelanguage.googleapis.com/') ? new WebSocket(url) : rtcUpstream(url, options)));
if (cfg.ankiPush) anki.start();

const ACTIONS = {
  phrases: [phrases, ['ensure', 'hint', 'check', 'continue', 'next', 'order', 'write']],
  cloze: [cloze, ['input', 'check', 'hint', 'focus']],
  quiz: [quizzes, ['answer', 'continue']],
  transfer: [transfers, ['answer', 'help', 'continue', 'skip']],
};
async function route(path, body) {
  const get = body === undefined;
  if (path === '/api/sentence' && get) return sentence.get();
  if (path === '/api/sentence/commands') {
    const state = sentence.command(body);
    // Saving an expression asks for its review straight away, as the local server does.
    if (['cloze_submit', 'attempt'].includes(body.type) && !state.duplicate && textConfigured(cfg)) {
      reviews.start({ round_id: state.active.id, attempt_id: state.active.attempts.at(-1).id });
      return sentence.get();
    }
    return state;
  }
  if (path === '/api/sentence/freewrites') return freewrites.save(body);
  if (path === '/api/sentence/prepare') return preparations.start(body);
  if (path === '/api/sentence/review') return reviews.start(body);
  if (path === '/api/sentence/writing-help') return writingHelp.request(body);
  if (path === '/api/sentence/writing-help/seen') return writingHelp.seen(body);
  if (path === '/api/sentence/view-ack') return sentence.ack(body);
  if (path === '/api/sentence/explain') return explanations.request(body);
  const action = path.match(/^\/api\/sentence\/(phrases|cloze|quiz|transfer)\/([a-z]+)$/);
  if (action && !get) {
    const [module, allowed] = ACTIONS[action[1]];
    if (!allowed.includes(action[2])) throw new HttpError(404, 'Not found');
    return module[action[2]](body);
  }
  if (path === '/api/config' && get) return appConfig(cfg);
  if (path === '/api/settings' && get) return settings.view(cfg);
  if (path === '/api/settings') {
    const values = settings.patch(body);
    let next;
    try { next = config(settings.env(base, values)); } catch (e) { throw new HttpError(400, `设置不对：${e.message}`); }
    settings.save(values);
    Object.assign(cfg, next);
    if (cfg.ankiPush && !anki.timer) anki.start();
    return settings.view(cfg);
  }
  if (path === '/api/settings/test') return testServices(cfg, { voiceCheck: qwenRtcCheck });
  if (path === '/api/usage' && get) return cfg.usage.summary();
  if (path === '/api/anki' && get) return anki.status();
  if (path === '/api/anki/flush') { await anki.flush(); return anki.status(); }
  throw new HttpError(404, 'Not found');
}

// A call to the engine: GET without a body, POST with one. Resolves with the reply, rejects with its message.
export async function request(path, body) {
  try { return structuredClone(await route(path, body)); }
  catch (e) { throw new Error(e instanceof HttpError ? e.message : `出错了：${e.message || e}`); }
}

// Every change to the practice arrives as a state. The engine is in this page, so it is always in reach.
export function subscribe({ state, up = () => {} }) {
  listeners.add(value => state(structuredClone(value)));
  up();
  state(sentence.get());
}

// Speech streams back as raw audio, like the local server's response: a Response whose body is fed as it arrives.
export function speak(path, init = {}) {
  if (path !== '/api/sentence/speak') return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
  let input = {};
  try { input = JSON.parse(init.body || '{}'); } catch {}
  return new Promise(resolve => {
    let controller = null, answered = false;
    const closers = [];
    const stream = new ReadableStream({ start: c => { controller = c; }, cancel: () => { for (const close of closers) close(); } });
    const res = {
      writeHead(status, headers) { answered = true; resolve(new Response(stream, { status, headers })); },
      write(bytes) { try { controller.enqueue(new Uint8Array(bytes)); } catch {} },
      end(bytes) { if (bytes) this.write(bytes); try { controller.close(); } catch {} },
      on(event, handler) { if (event === 'close') closers.push(handler); },
    };
    init.signal?.addEventListener('abort', () => {
      for (const close of closers) close();
      try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {}
    });
    speech.stream(input, {}, res).catch(e => {
      showUsage();
      if (!answered) resolve(Response.json({ error: e instanceof HttpError ? e.message : '朗读出错了。' }, { status: e.status || 500 }));
      else try { controller.error(e); } catch {}
    });
  });
}

// A voice call, relayed in this page the way the local server relays it. The page streams PCM for Gemini;
// for Qwen it hands over its microphone as a track and the service's voice plays from the WebRTC stream.
export function openVoice(params, on) {
  const handlers = {};
  let upstream = null, microphone = null;
  const conn = {
    send: text => queueMicrotask(() => { try { on.message(JSON.parse(text)); } catch {} }),
    close: () => queueMicrotask(() => on.close()),
    on: (event, handler) => { (handlers[event] ||= []).push(handler); },
  };
  setTimeout(() => {
    opened = null;
    voice.start(conn, new URLSearchParams(params));
    upstream = opened;
    if (microphone) upstream?.useMicrophone?.(microphone);
  });
  return {
    transport: cfg.voiceProvider === 'qwen' ? 'track' : 'pcm',
    ready: () => Boolean(handlers.message),
    send: value => { for (const handler of handlers.message || []) handler(JSON.stringify(value)); },
    close: () => { for (const handler of handlers.close || []) handler(); },
    useMicrophone(stream) { microphone = stream; upstream?.useMicrophone?.(stream); },
  };
}

// A side panel may not be allowed to ask for the microphone itself; a tab of the extension can, once.
export function microphoneDenied() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  return '已打开一个授权页：在那里允许麦克风，再回来按 ⌘ ]。';
}

// Reaching Anki on this computer is an optional permission, asked for when pushing is turned on.
export const allowAnki = () => chrome.permissions.request({ origins: ['http://127.0.0.1/*', 'http://localhost/*'] }).catch(() => false);
export const ankiNote = `Anki 要开着，并装好 AnkiConnect 插件（代码 2055492159）。点「保存并测试」时，Anki 会弹出窗口问是否允许，点「是」就好；没有弹窗的话，在 Anki 的「工具 → 插件 → AnkiConnect → 配置」里把 chrome-extension://${chrome.runtime.id} 加进 webCorsOriginList。`;

// Text chosen with the right-click menu on any page: handed over once, as a new idea to practise.
export function onSource(use) {
  const take = async () => {
    const { source } = await chrome.storage.session.get('source');
    if (!source?.text) return;
    await chrome.storage.session.remove('source');
    use(source.text);
  };
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.source?.newValue) void take(); });
  void take();
}
