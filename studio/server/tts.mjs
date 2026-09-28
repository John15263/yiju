import { check, fields, oneOf, text } from './validation.mjs';
import { sha256 } from './sha256.mjs';

// Hints read aloud by Gemini's speech models instead of the browser's own voices, which in Chrome went
// silent without saying why. The key stays here: the page sends the words and gets back raw audio as it
// is made (24 kHz, mono, 16-bit little-endian PCM), so the voice starts about 1.2 s after the request
// (measured 2026-09-24), well before the whole hint is spoken.
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse';
// A hint is said the way it would be to a child learning the language: warm, clear, a little slow.
const STYLE = {
  'en-US': 'a warm, patient teacher speaking clearly and a little slowly to a child learning English',
  'ja-JP': 'やさしく、はっきり、少しゆっくり話す先生',
  'zh-CN': '一位温和耐心的老师，吐字清楚，语速稍慢',
};
// An explanation is Chinese with the foreign words left as they are; each is said in its own language.
const EXPLAIN_STYLE = '一位温和耐心的中文老师在给学生讲外语，吐字清楚，语速自然；遇到英语或日语的词句（日语写成假名，或放在「」里），用那门语言地道的发音念出来，不要念成中文';
// Everything said is kept by what was said and how, so hearing it again costs nothing: a script replayed when a
// sentence is practised again, the fixed hint lines that recur. Oldest go past the cap. The local server keeps
// it on disk (ttsCacheDir); the extension hands over its own store as ttsCache, with the same read and write.
const CACHE_CAP = 300 * 1024 * 1024;
export function diskCache(dir) {
  // Asked for at run time rather than imported, so this module also loads where there is no Node.
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs) return null;
  const path = name => `${dir}/${name}.pcm`;
  const prune = () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pcm')).map(f => ({ f, ...fs.statSync(`${dir}/${f}`) })).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) { if (total <= CACHE_CAP * 0.8) break; try { fs.unlinkSync(`${dir}/${x.f}`); total -= x.size; } catch {} }
  };
  return {
    read(name) {
      if (!fs.existsSync(path(name))) return null;
      try { const t = new Date(); fs.utimesSync(path(name), t, t); } catch {}
      return fs.readFileSync(path(name));
    },
    write(name, bytes) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path(name), bytes); prune(); },
  };
}
// A header may only carry Latin-1: Node refuses anything else (ERR_INVALID_CHAR), and so does a browser's Response.
const voiceHeader = value => encodeURIComponent(value);
const fromBase64 = value => { const binary = atob(value), bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes; };
const concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

// The interactions API reports usage in its own shape; metering reads the generateContent one.
export function usageOf(u) {
  if (!u) return null;
  const details = list => (Array.isArray(list) ? list : []).map(d => ({ modality: String(d?.modality || '').toUpperCase(), tokenCount: d?.tokens }));
  return { promptTokenCount: u.total_input_tokens, promptTokensDetails: details(u.input_tokens_by_modality),
    candidatesTokenCount: u.total_output_tokens, candidatesTokensDetails: details(u.output_tokens_by_modality), thoughtsTokenCount: u.total_thought_tokens };
}

// Why nothing was said, in words the page can show. The speech model's allowance is small (100 requests a day on
// Tier 1, met on 2026-09-27) and every line and every hint is one request.
export function refusal(error) {
  const message = String(error?.message || '');
  if (error?.code === 'rate_limit_exceeded' || /rate limit/i.test(message)) {
    const perDay = /limit: (\d+) requests? per day/i.exec(message)?.[1];
    const wait = /retry in (?:(\d+)h)?(?:(\d+)m)?/i.exec(message);
    const hours = wait ? Number(wait[1] || 0) + (Number(wait[2] || 0) >= 30 ? 1 : 0) : 0;
    return perDay ? `Gemini 朗读今天的 ${perDay} 次用完了${hours ? `，约 ${hours} 小时后恢复` : ''}` : 'Gemini 朗读的请求太频繁，稍等一会儿';
  }
  return message ? `Gemini 朗读出错：${message.slice(0, 120)}` : 'Gemini 朗读没有返回声音';
}
// How long to stop asking after a refusal: until the allowance comes back, or a minute.
const restFor = error => {
  const wait = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(String(error?.message || ''));
  return wait ? ((Number(wait[1] || 0) * 60 + Number(wait[2] || 0)) * 60 + Number(wait[3] || 0)) * 1000 : 60000;
};

// Each speech model has its own allowance (on Tier 1, 10 a minute and 100 a day each, seen 2026-09-27), so when
// one is spent the other speaks: twice the readings a day before the page's own voice has to take over.
const PAIR = { 'gemini-3.8-flash-lite-tts': 'gemini-3.8-flash-tts', 'gemini-3.8-flash-tts': 'gemini-3.8-flash-lite-tts' };
export const speechModels = model => PAIR[model] ? [model, PAIR[model]] : [model];

export class Speech {
  constructor(cfg, request = fetch) {
    // Called on its own: a browser's fetch refuses to run as a method of this object ("Illegal invocation").
    this.cfg = cfg; this.request = (...args) => request(...args);
    this.cache = cfg.ttsCache || (cfg.ttsCacheDir ? diskCache(cfg.ttsCacheDir) : null);
    // A model refused for its allowance rests until it comes back; what a refusal said the daily limit is, is kept.
    this.resting = new Map(); this.limits = new Map();
  }
  ready(model) { return !(this.resting.get(model)?.until > Date.now()); }
  rest(model, failure) {
    const perDay = /limit: (\d+) requests? per day/i.exec(String(failure?.message || ''))?.[1];
    if (perDay) this.limits.set(model, Number(perDay));
    this.resting.set(model, { until: Date.now() + restFor(failure) });
  }
  // Why no speech model can speak now, and when one can again.
  spent(models) {
    const left = Math.min(...models.map(m => this.resting.get(m)?.until ?? Infinity)) - Date.now();
    if (left < 45 * 60000) return 'Gemini 朗读的请求太频繁，稍等一会儿再试。';
    const limit = this.limits.get(models[0]);
    return `Gemini 朗读今天的${limit ? ` ${limit} 次` : '次数'}用完了${models.length > 1 ? '（两个朗读模型都用完了）' : ''}，约 ${Math.max(1, Math.round(left / 3600000))} 小时后恢复。`;
  }
  // `res` is the local server's HTTP response, or anything with its writeHead, write, end and on('close').
  async stream(input, req, res) {
    fields(input, ['text', 'language', 'kind'], ['text', 'language']);
    text(input.text, 400); check(input.text.trim(), 'Invalid text');
    check(Object.hasOwn(STYLE, input.language), 'Invalid language');
    const kind = input.kind === undefined ? 'hint' : oneOf(input.kind, ['hint', 'explain']);
    const words = input.text.trim(), style = kind === 'explain' ? EXPLAIN_STYLE : STYLE[input.language];
    const models = speechModels(this.cfg.geminiTtsModel), voice = this.cfg.geminiTtsVoice;
    const nameOf = model => this.cache ? sha256(JSON.stringify([model, voice, style, words])) : null;
    // Said before, by either model: heard again for nothing.
    for (const model of models) {
      const name = nameOf(model), pcm = name ? await this.cache.read(name) : null;
      if (pcm) {
        res.writeHead(200, { 'Content-Type': 'audio/l16; rate=24000; channels=1', 'X-Voice': voiceHeader(`${model} · ${voice} · 已存，不花钱`) });
        res.end(pcm); return;
      }
    }
    check(this.cfg.geminiKey, '朗读用的是 Gemini，请在「设置」里填写 Gemini 的 API key，或者改用浏览器自带的朗读。', 503);
    // A model refused a moment ago is not asked again until its allowance is back; with both resting, the page's own
    // voice takes over at once.
    const ready = models.filter(m => this.ready(m));
    check(ready.length, this.spent(models), 429);
    const page = { closed: false, abort: null };
    res.on('close', () => { page.closed = true; page.abort?.abort(); });
    let refused = null;
    for (const model of ready) {
      refused = await this.attempt(model, { voice, style, words, kind, name: nameOf(model) }, res, page);
      if (!refused?.limited) break;
    }
    if (!refused || page.closed) return;
    check(false, refused.limited && !models.some(m => this.ready(m)) ? this.spent(models) : refused.message, refused.status);
  }
  // One model's reading. Nothing comes back when it was said (or the page went away); a refusal before any sound
  // comes back as { limited, message, status }.
  async attempt(model, { voice, style, words, kind, name }, res, page) {
    // A newer hint, or the page going away, drops the request so no audio nobody hears is paid for.
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20000);
    page.abort = abort;
    let upstream;
    try {
      upstream = await this.request(ENDPOINT, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'x-goog-api-key': this.cfg.geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, response_format: { type: 'audio' },
          input: [{ type: 'user_input', content: [{ type: 'text', text: words,
            annotations: [{ type: 'speech_metadata', style }] }] }],
          generation_config: { speech_config: [{ voice }] } }) });
    } catch { clearTimeout(timeout); return page.closed ? null : { message: 'Gemini 朗读连接不上或超时。', status: 502 }; }
    if (!upstream.ok) {
      clearTimeout(timeout);
      const limited = upstream.status === 429;
      if (limited) this.rest(model, null);
      return { limited, message: `Gemini 朗读没有接受请求（HTTP ${upstream.status}）。`, status: limited ? 429 : 502 };
    }
    // The audio headers go out with the first sound: a refusal comes inside the stream, before any, and is then
    // answered as an error instead of as silence.
    let usage = null, buffer = '', started = false, failure = null;
    const kept = [];
    const handle = block => {
      const line = block.split('\n').find(l => l.startsWith('data:'));
      if (!line) return;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { return; }
      if (event.error) failure ||= event.error;
      if (typeof event.delta?.data === 'string' && event.delta.type !== 'text') {
        const pcm = fromBase64(event.delta.data); kept.push(pcm);
        if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'audio/l16; rate=24000; channels=1', 'X-Voice': voiceHeader(`${model} · ${voice}`) }); }
        res.write(pcm);
      }
      usage = event.interaction?.usage || event.usage || usage;
    };
    try {
      const decoder = new TextDecoder(), reader = upstream.body.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      }
      if (buffer.trim()) handle(buffer);
    } catch {}
    finally {
      clearTimeout(timeout);
      // Billed whether or not it was heard to the end.
      if (usage) this.cfg.usage?.record({ purpose: kind === 'explain' ? 'explain_speech' : 'hint_speech', model, usage: usageOf(usage) });
      // Only a reading that came through whole is kept.
      if (name && usage && kept.length && !abort.signal.aborted) {
        try { await this.cache.write(name, concat(kept)); } catch {}
      }
      if (started) res.end();
    }
    if (started || page.closed) return null;
    const limited = failure?.code === 'rate_limit_exceeded';
    if (limited) this.rest(model, failure);
    return { limited, status: limited ? 429 : 502,
      message: abort.signal.aborted && !failure ? 'Gemini 朗读等了 20 秒还没有声音。' : `${refusal(failure)}。` };
  }
}
