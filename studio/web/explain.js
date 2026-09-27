import { voiceMode } from './voice-mode.js';
import { browserVoice } from './speech.js';
import { renderLine, spokenText, spokenRuns } from './foreign.js';

// The explanation of a chunk before it is written, of a chunk's correction, and of the sentence's
// feedback: a script written once by the engine, shown here line by line and read aloud — by Gemini's speech
// model, or, with the browser's own voices chosen in settings, by the best voice this browser has for each
// language in the line. Arriving at such a moment starts it; the line being read is marked. Clicking a line
// reads from there, and clicking the line being read pauses or resumes it (a double click would also select
// a word, and would make every single click wait to see whether a second follows). Questions go to the live
// tutor, opened by hand, which is given the script.
const RATE = 24000;
const MODES = ['learn', 'fix', 'review'];
const TITLES = { learn: '讲解 · 这一块', fix: '讲解 · 这次批改', review: '讲解 · 这次点评' };
// Reading speed, kept in this browser.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2], SPEED_KEY = 'explain-speed';
const savedSpeed = () => { try { const v = Number(localStorage.getItem(SPEED_KEY)); return SPEEDS.includes(v) ? v : 1; } catch { return 1; } };

// A whole line's audio as a WAV file, for an <audio> element: it can play faster or slower without changing
// the pitch of the voice, which Web Audio cannot.
export function wavOf(parts) {
  const length = parts.reduce((n, p) => n + p.length, 0), buffer = new ArrayBuffer(44 + length * 2), view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * 2, true);
  let at = 44;
  for (const part of parts) for (const sample of part) { view.setInt16(at, sample, true); at += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function createExplainUI({ api, auto, before = () => {}, engine = () => 'gemini', fetcher = (...args) => globalThis.fetch(...args) }) {
  const $ = id => document.getElementById(id);
  let moment = null, lastKey, lines = [], status = '', loading = false, speed = savedSpeed();
  // Playing: one run at a time; audio per line is kept for the moment, so replaying costs nothing. `how` is
  // what is playing it: streamed through Web Audio at normal speed, a whole line per <audio> element at any
  // other speed, or the browser's own voices.
  let context = null, run = 0, playing = false, paused = false, current = -1, poll = null, playHead = 0, how = '';
  let audio = [], starts = [], element = null;
  const sources = new Set();
  const target = () => moment?.language || 'en';

  function paint() {
    $('explain-region').hidden = !moment;
    if (!moment) return;
    $('explain-title').textContent = TITLES[moment.mode];
    $('explain-status').textContent = status;
    const list = $('explain-lines');
    if (list.dataset.key !== moment.key || list.children.length !== lines.length) {
      list.dataset.key = moment.key;
      list.replaceChildren(...lines.map((text, i) => {
        const item = document.createElement('li');
        renderLine(item, text, target());
        item.title = '点一下从这一行听；正在念的这一行，点一下暂停或继续';
        item.onclick = () => {
          // Selecting a word to look at it is not a click on the line.
          if (String(globalThis.getSelection?.() || '').trim()) return;
          if (playing && i === current) toggle(); else void play(i);
        };
        return item;
      }));
    }
    [...list.children].forEach((item, i) => {
      item.classList.toggle('reading', playing && i === current);
      item.classList.toggle('paused', playing && paused && i === current);
    });
    $('explain-toggle').textContent = loading ? '正在写讲解…' : !lines.length ? '听讲解' : playing ? (paused ? '继续' : '暂停') : '播放';
    $('explain-toggle').disabled = loading;
    $('explain-replay').hidden = !lines.length;
    $('explain-speed').value = String(speed);
  }

  function halt() {
    run++;
    if (how === 'browser') globalThis.speechSynthesis?.cancel();
    for (const source of sources) { try { source.stop(); } catch {} }
    sources.clear(); clearInterval(poll); poll = null;
    if (element) { element.pause(); element.removeAttribute('src'); element = null; }
    playing = false; paused = false; current = -1; how = '';
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }
  function reset() {
    halt();
    for (const line of audio) line?.control.abort();
    audio = []; starts = []; lines = []; status = ''; loading = false;
  }
  function finish(mine) {
    if (mine !== run) return;
    clearInterval(poll); poll = null; playing = false; paused = false; current = -1; how = ''; element = null; paint();
  }
  function toggle() {
    if (!playing) return;
    paused = !paused;
    const synth = globalThis.speechSynthesis;
    if (how === 'browser') { if (paused) synth?.pause(); else synth?.resume(); }
    else if (how === 'stream') { if (paused) context.suspend().catch(() => {}); else context.resume().catch(() => {}); }
    else if (element) { if (paused) element.pause(); else element.play().catch(() => {}); }
    paint();
  }

  // One line's audio, fetched once; whoever plays it reads the parts as they arrive. Japanese goes as its kana.
  function fetchLine(i) {
    if (audio[i]) return audio[i];
    const line = audio[i] = { parts: [], done: false, error: '', wake: null, control: new AbortController() };
    const wake = () => { const w = line.wake; line.wake = null; w?.(); };
    (async () => {
      try {
        const response = await fetcher('/api/sentence/speak', { method: 'POST', signal: line.control.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spokenText(lines[i], target()), language: 'zh-CN', kind: 'explain' }) });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
        const reader = response.body.getReader();
        let carry = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // Samples are two bytes; a chunk can end halfway through one.
          let bytes = carry ? new Uint8Array([...carry, ...value]) : value;
          carry = bytes.length % 2 ? bytes.slice(-1) : null;
          if (carry) bytes = bytes.subarray(0, bytes.length - 1);
          if (bytes.length) { line.parts.push(new Int16Array(bytes.slice().buffer)); wake(); }
        }
        if (!line.parts.length) throw new Error('没有收到声音');
      } catch (e) { if (e?.name !== 'AbortError') line.error = e.message; }
      finally { line.done = true; wake(); }
    })();
    return line;
  }
  const settled = async (line, mine) => { while (!line.done && mine === run) await new Promise(r => { line.wake = r; }); };
  function schedule(samples) {
    const buffer = context.createBuffer(1, samples.length, RATE), channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer; source.connect(context.destination);
    playHead = Math.max(playHead, context.currentTime + 0.05);
    source.start(playHead); playHead += buffer.duration;
    sources.add(source); source.onended = () => sources.delete(source);
  }

  // The browser's own voices: one line after another, each marked while it is said, and within a line each
  // language by a voice of that language — a Chinese voice would read 毎日 as měirì.
  async function sayLines(from, mine, why = '') {
    const synth = globalThis.speechSynthesis;
    if (!synth) { status = `${why ? `${why}；` : ''}这个浏览器不支持朗读，文字都在上面。`; finish(mine); return; }
    how = 'browser';
    // Chrome can keep its queue paused after a cancel; nothing would be heard.
    if (synth.paused && !paused) synth.resume();
    if (why) { status = why; paint(); }
    for (let i = from; i < lines.length; i++) {
      if (mine !== run) return;
      current = i; paint();
      for (const part of spokenRuns(lines[i], target())) {
        const said = await new Promise(resolve => {
          const utterance = new SpeechSynthesisUtterance(part.text);
          utterance.lang = part.lang; utterance.rate = speed;
          const voice = browserVoice(part.lang, synth);
          if (voice) utterance.voice = voice;
          utterance.onend = () => resolve(true);
          utterance.onerror = event => resolve(['interrupted', 'canceled'].includes(event.error) ? null : false);
          synth.speak(utterance);
          if (paused) synth.pause();
        });
        if (mine !== run) return;
        if (said === false) { status = '浏览器没有念出来，文字都在上面。'; finish(mine); return; }
      }
    }
    finish(mine);
  }

  // Gemini's voice at normal speed: streamed, so the first line starts about a second after it is asked for.
  async function stream(from, mine) {
    how = 'stream';
    playHead = context.currentTime + 0.05; starts = [];
    // The marked line follows what is actually heard; when the last one is over, playing stops.
    poll = setInterval(() => {
      if (mine !== run) return;
      const at = context.currentTime;
      let i = current;
      for (let k = from; k < starts.length; k++) if (starts[k] !== undefined && starts[k] <= at) i = k;
      if (i !== current) { current = i; paint(); }
    }, 150);
    for (let i = from; i < lines.length; i++) {
      const line = fetchLine(i);
      let n = 0;
      for (;;) {
        if (mine !== run) return;
        while (n < line.parts.length) { if (n === 0) starts[i] = Math.max(playHead, context.currentTime + 0.05); schedule(line.parts[n++]); }
        // The next line is fetched while this one plays, so it follows without a gap.
        if (n && i + 1 < lines.length) fetchLine(i + 1);
        if (line.done) break;
        await new Promise(r => { line.wake = r; });
      }
      // Gemini could not read this line (no allowance left today, say): what was scheduled plays out, then the
      // browser's own voices read the rest.
      if (!n) {
        await new Promise(r => setTimeout(r, Math.max(0, playHead - context.currentTime) * 1000 + 50));
        if (mine !== run) return;
        clearInterval(poll); poll = null;
        return sayLines(i, mine, `${(line.error || 'Gemini 没念成').replace(/[。.]$/, '')}；接下来用浏览器自带的声音念。`);
      }
    }
    await new Promise(r => setTimeout(r, Math.max(0, playHead - context.currentTime) * 1000 + 100));
    finish(mine);
  }

  // Gemini's voice at any other speed: each line whole, played by an <audio> element that keeps the pitch.
  async function buffered(from, mine) {
    how = 'buffered';
    for (let i = from; i < lines.length; i++) {
      if (mine !== run) return;
      current = i; paint();
      const line = fetchLine(i);
      await settled(line, mine);
      if (mine !== run) return;
      if (i + 1 < lines.length) fetchLine(i + 1);
      if (!line.parts.length) return sayLines(i, mine, `${(line.error || 'Gemini 没念成').replace(/[。.]$/, '')}；接下来用浏览器自带的声音念。`);
      const url = URL.createObjectURL(wavOf(line.parts));
      const heard = await new Promise(resolve => {
        const player = element = new Audio(url);
        player.preservesPitch = true; player.playbackRate = speed;
        player.onended = () => resolve(true);
        player.onerror = () => resolve(false);
        if (!paused) player.play().catch(() => resolve(false));
      });
      URL.revokeObjectURL(url);
      if (mine !== run) return;
      if (!heard) { status = '浏览器这次没有允许出声，点“播放”开始。'; finish(mine); return; }
    }
    finish(mine);
  }

  async function play(from = 0) {
    if (!lines.length) return;
    halt();
    const mine = run;
    before();
    playing = true; current = from; status = ''; paint();
    if (engine() === 'browser') return sayLines(from, mine);
    if (speed !== 1) return buffered(from, mine);
    try {
      context ||= new AudioContext({ sampleRate: RATE });
      if (context.state !== 'running') await Promise.race([context.resume().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
    } catch {}
    if (mine !== run) return;
    if (context?.state !== 'running') { status = '浏览器这次没有允许自动出声，点“播放”开始。'; finish(mine); return; }
    return stream(from, mine);
  }

  async function load(start) {
    if (!moment || loading) return;
    const asked = moment;
    loading = true; status = ''; paint();
    try {
      const result = await api('/explain', { round_id: asked.round_id, window_start: asked.window_start, key: asked.key });
      if (moment !== asked) return;
      lines = result.lines; loading = false; paint();
      if (start) void play(0);
    } catch (e) {
      if (moment !== asked) return;
      loading = false; status = `讲解没写成：${e.message}。点“听讲解”再试。`; paint();
    }
  }

  $('explain-toggle').onclick = () => {
    if (!lines.length) return void load(true);
    if (!playing) return void play(0);
    toggle();
  };
  $('explain-replay').onclick = () => void play(0);
  $('explain-speed').onchange = () => {
    const next = Number($('explain-speed').value);
    if (!SPEEDS.includes(next) || next === speed) return;
    speed = next;
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch {}
    // A line playing whole takes the new speed at once; the streamed one starts over from the line being read.
    if (how === 'buffered' && element) element.playbackRate = speed;
    else if (how === 'stream' && playing) void play(Math.max(0, current));
  };

  return {
    busy: () => playing && !paused,
    stop() { if (playing) { halt(); paint(); } },
    update(r) {
      const mode = voiceMode(r), key = mode?.auto && MODES.includes(mode.mode) ? mode.key : '';
      // Arriving at a new moment (not the page opening on one) starts it; a second window left open does not.
      const arrived = lastKey !== undefined && key && key !== lastKey;
      if (key !== (moment?.key || '')) {
        reset();
        moment = key ? { key, mode: mode.mode, round_id: r.id, window_start: r.window_start, language: r.language } : null;
        // Already heard here once: the script is shown, and plays again only when asked.
        const heard = key ? (r.support_events || []).findLast(e => e.kind === 'explanation' && e.detail?.moment === key) : null;
        if (heard) lines = heard.detail.lines;
        if (arrived && auto() && document.hasFocus()) { if (lines.length) void play(0); else void load(true); }
      }
      lastKey = key;
      paint();
    },
  };
}
