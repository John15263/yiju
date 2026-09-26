// Hints read aloud. By default Gemini's speech model says them (through the local server, which holds
// the key), streamed so the voice starts about a second after the hint. The browser's own speech is the
// other choice and the fallback: the Mac's system voices, and in Microsoft Edge its "Natural" neural
// voices, which are free but read the text through Microsoft's service.

// Chinese hints often quote a word or two of the target language; they are still read by a Chinese
// voice. Kana means Japanese; text with no Han characters is read in the target language.
export function langOf(text, target = 'en') {
  if (/[぀-ヿ]/u.test(text)) return 'ja-JP';
  if (/\p{Script=Han}/u.test(text)) return 'zh-CN';
  return target === 'ja' ? 'ja-JP' : 'en-US';
}
// Enhanced and premium voices are the ones someone chose to download; they sound far better. After
// them come the Mac's standard voices. The robotic "Eddy (Chinese (China mainland))" family and the
// novelty voices (Bells, Bubbles, Zarvox…) are last resorts.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Kathy|Fred|Ralph)\b/i;
const STANDARD = /^(Tingting|Ting-Ting|Lili|Lilian|Yu-shu|Meijia|Samantha|Alex|Ava|Allison|Susan|Tom|Zoe|Nicky|Kyoko|Otoya|O-ren)\b/i;
const NATURAL = /^Microsoft .*\(Natural\)/i;
const rank = voice => (NATURAL.test(voice.name) ? 10 : 0) - (!voice.localService && !NATURAL.test(voice.name) ? 4 : 0)
  + (/premium|高品质|高音质/i.test(voice.name) ? 6 : /enhanced|增强/i.test(voice.name) ? 5 : 0)
  + (STANDARD.test(voice.name) ? 3 : 0) + (voice.default ? 1 : 0) - (voice.name.includes('(') && !/enhanced|premium|natural/i.test(voice.name) ? 2 : 0)
  - (NOVELTY.test(voice.name) ? 6 : 0);

// Chrome can drop speech silently: an utterance collected before it starts, a queue left paused, a speak
// sent in the same instant as a cancel. Each of those is guarded here, and what happened to the last one
// (spoken, failed, never started) is reported so it can be seen in settings.
// Key symbols are for the eye; a voice says their names.
const spoken = text => text.trim().replace(/⌘\s*↵/g, 'Command 回车').replace(/⌘\s*\[/g, 'Command 左方括号').replace(/⌘\s*\]/g, 'Command 右方括号');
const RATE = 24000;

export function createSpeech({ enabled, busy, report = () => {}, engine = () => 'system',
  fetcher = (...args) => globalThis.fetch(...args), makeContext = () => new AudioContext({ sampleRate: RATE }) }) {
  const synth = globalThis.speechSynthesis;
  let last = '', current = null, watchdog = null, waitingUtterance = null;
  // Gemini's audio. A hint being said is said to the end: cutting it off halfway leaves nothing usable.
  // A newer hint waits its turn, and only the newest waits (one that went stale while waiting is dropped
  // unheard); its audio is fetched while the other is still speaking, so it follows without a gap. The
  // last few hints are kept, so hearing one again costs nothing.
  let context = null, speaking = null, waiting = null, playHead = 0;
  const cache = new Map();
  function drop(item) {
    if (!item) return;
    item.control.abort();
    for (const source of item.sources) { try { source.stop(); } catch {} }
    item.sources.clear();
  }
  function hush() { drop(waiting); drop(speaking); waiting = speaking = null; playHead = 0; }
  function play(item, samples) {
    const buffer = context.createBuffer(1, samples.length, RATE), channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer; source.connect(context.destination);
    playHead = Math.max(playHead, context.currentTime + 0.05);
    source.start(playHead); playHead += buffer.duration;
    item.sources.add(source); source.onended = () => item.sources.delete(source);
    if (!item.heard) { item.heard = true; report({ ok: true, voice: item.voice }); }
  }
  // The one waiting becomes the one speaking: what has arrived plays now, the rest as it comes.
  function next() {
    const item = waiting; waiting = null; speaking = item;
    if (!item) return;
    item.live = true;
    for (const part of item.parts) play(item, part);
    if (item.done) settle(item);
  }
  // A hint that has all its audio is over when that audio has played; then the next one goes.
  function settle(item) {
    if (item !== speaking) return;
    if (item.error) {
      speaking = null;
      // Heard anyway: the browser's own voice says it, and the reason stays in the report.
      if (synth) utter(item.text, item.target, false, `Gemini 没念成：${item.error}`);
      else report({ ok: false, reason: `Gemini 没念成：${item.error}` });
      next(); return;
    }
    const left = Math.max(0, playHead - context.currentTime);
    setTimeout(() => { if (speaking === item) { speaking = null; next(); } }, left * 1000 + 30);
  }
  async function gemini(text, target) {
    const words = spoken(text), language = langOf(text, target), key = `${language}|${words}`;
    const item = { text, target, key, parts: [], sources: new Set(), control: new AbortController(), voice: 'Gemini', live: false, done: false, heard: false, error: '' };
    if (speaking) { drop(waiting); waiting = item; } else { speaking = item; item.live = true; }
    const gone = () => item.control.signal.aborted;
    try {
      context ||= makeContext();
      if (context.state !== 'running') await Promise.race([context.resume().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
      if (gone()) return;
      if (context.state !== 'running') throw new Error('浏览器这次没有允许自动出声');
      const kept = cache.get(key);
      if (kept) {
        item.voice = `${kept.voice}，重听不花钱`;
        for (const part of kept.parts) { item.parts.push(part); if (item.live) play(item, part); }
      } else {
        const response = await fetcher('/api/sentence/speak', { method: 'POST', signal: item.control.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: words, language }) });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
        item.voice = response.headers.get('X-Voice') || 'Gemini';
        const reader = response.body.getReader();
        let carry = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (gone()) return;
          if (done) break;
          // Samples are two bytes; a chunk can end halfway through one.
          let bytes = carry ? new Uint8Array([...carry, ...value]) : value;
          carry = bytes.length % 2 ? bytes.slice(-1) : null;
          if (carry) bytes = bytes.subarray(0, bytes.length - 1);
          if (!bytes.length) continue;
          const samples = new Int16Array(bytes.slice().buffer);
          item.parts.push(samples);
          if (item.live) play(item, samples);
        }
        if (!item.parts.length) throw new Error('没有收到声音');
        cache.set(key, { parts: item.parts, voice: item.voice });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
      }
    } catch (e) {
      if (e?.name === 'AbortError' || gone()) return;
      item.error = e.message;
    }
    item.done = true;
    settle(item);
  }
  function voiceFor(lang) {
    const want = lang.toLowerCase(), base = want.split('-')[0];
    const voices = synth.getVoices().filter(v => v.lang.replace('_', '-').toLowerCase().startsWith(base));
    const exact = voices.filter(v => v.lang.replace('_', '-').toLowerCase() === want);
    return (exact.length ? exact : voices).sort((a, b) => rank(b) - rank(a))[0] || null;
  }
  function utter(text, target, retried = false, why = '') {
    const utterance = new SpeechSynthesisUtterance(spoken(text));
    utterance.lang = langOf(text, target);
    const voice = voiceFor(utterance.lang);
    if (voice) utterance.voice = voice;
    // A learner listening in the language being learned gets it a touch slower.
    utterance.rate = utterance.lang === 'zh-CN' ? 1 : 0.92;
    utterance.onstart = () => { clearTimeout(watchdog); report({ ok: true, voice: `${voice?.name || '系统默认'}${why ? `；${why}` : ''}` }); };
    utterance.onerror = event => {
      clearTimeout(watchdog);
      if (!['interrupted', 'canceled'].includes(event.error)) report({ ok: false, reason: `出错：${event.error}` });
    };
    // Held until it is done, so the browser cannot collect it mid-sentence.
    current = utterance;
    // The same rule as Gemini's: said to the end, then the newest one that waited.
    utterance.onend = () => {
      if (current !== utterance) return;
      current = null;
      if (waitingUtterance) { const { text: t, target: g } = waitingUtterance; waitingUtterance = null; utter(t, g); }
    };
    const busySpeaking = synth.speaking || synth.pending;
    if (busySpeaking) synth.cancel();
    if (synth.paused) synth.resume();
    // Speaking in the same instant as a cancel is sometimes ignored, so it waits a moment after one.
    setTimeout(() => { if (current === utterance) synth.speak(utterance); }, busySpeaking ? 80 : 0);
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (current !== utterance) return;
      // Never started: a stuck queue is cleared and the words are tried once more.
      synth.cancel();
      if (!retried) utter(text, target, true, why);
      else { current = null; report({ ok: false, reason: '没有开始（浏览器没有出声）' }); }
    }, 2500);
  }
  return {
    // A newer hint waits for the one being read to finish; the same words are not read twice in a row.
    say(text, target) {
      if (!enabled() || busy() || !text?.trim() || text === last) return;
      last = text;
      if (engine() === 'gemini') { void gemini(text, target); return; }
      if (!synth) return;
      hush();
      if (current) waitingUtterance = { text, target }; else utter(text, target);
    },
    // Asked for from settings, so it plays even while other things would keep it quiet.
    test(target) {
      last = '';
      if (engine() === 'gemini') { hush(); void gemini(target === 'ja' ? '提示会这样念出来。ここまで大丈夫、続けて。' : '提示会这样念出来。Good so far. Keep going.', target); return; }
      if (!synth) { report({ ok: false, reason: '这个浏览器不支持朗读' }); return; }
      utter(target === 'ja' ? '提示会这样念出来。ヒントはこう聞こえます。' : '提示会这样念出来。', target);
      setTimeout(() => utter(target === 'ja' ? 'ここまで大丈夫。' : 'Good so far. Keep going.', target), 2200);
    },
    stop() { clearTimeout(watchdog); current = null; waitingUtterance = null; synth?.cancel(); hush(); last = ''; },
  };
}
