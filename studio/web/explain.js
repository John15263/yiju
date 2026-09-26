import { voiceMode } from './voice-mode.js';

// The explanation of a chunk before it is written, of a chunk's correction, and of the sentence's
// feedback: a script written once on the server, shown here line by line and read aloud by Gemini TTS.
// Arriving at such a moment starts it; the line being read is marked, a line can be clicked to hear it
// again. Questions go to the live tutor, opened by hand, which is given the script.
const RATE = 24000;
const MODES = ['learn', 'fix', 'review'];
const TITLES = { learn: '讲解 · 这一块', fix: '讲解 · 这次批改', review: '讲解 · 这次点评' };

export function createExplainUI({ api, auto, before = () => {}, fetcher = (...args) => globalThis.fetch(...args) }) {
  const $ = id => document.getElementById(id);
  let moment = null, lastKey, lines = [], status = '', loading = false;
  // Playing: one run at a time; audio per line is kept for the moment, so replaying costs nothing.
  let context = null, run = 0, playing = false, paused = false, current = -1, poll = null, playHead = 0;
  let audio = [], starts = [];
  const sources = new Set();

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
        item.textContent = text; item.title = '点一下，从这一行听';
        item.onclick = () => void play(i);
        return item;
      }));
    }
    [...list.children].forEach((item, i) => item.classList.toggle('reading', playing && i === current));
    $('explain-toggle').textContent = loading ? '正在写讲解…' : !lines.length ? '听讲解' : playing ? (paused ? '继续' : '暂停') : '播放';
    $('explain-toggle').disabled = loading;
    $('explain-replay').hidden = !lines.length;
  }

  function halt() {
    run++;
    for (const source of sources) { try { source.stop(); } catch {} }
    sources.clear(); clearInterval(poll); poll = null;
    playing = false; paused = false; current = -1;
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }
  function reset() {
    halt();
    for (const line of audio) line?.control.abort();
    audio = []; starts = []; lines = []; status = ''; loading = false;
  }

  // One line's audio, fetched once; whoever plays it reads the parts as they arrive.
  function fetchLine(i) {
    if (audio[i]) return audio[i];
    const line = audio[i] = { parts: [], done: false, error: '', wake: null, control: new AbortController() };
    const wake = () => { const w = line.wake; line.wake = null; w?.(); };
    (async () => {
      try {
        const response = await fetcher('/api/sentence/speak', { method: 'POST', signal: line.control.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lines[i], language: 'zh-CN', kind: 'explain' }) });
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
      } catch (e) { if (e?.name !== 'AbortError') line.error = e.message; }
      finally { line.done = true; wake(); }
    })();
    return line;
  }
  function schedule(samples) {
    const buffer = context.createBuffer(1, samples.length, RATE), channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer; source.connect(context.destination);
    playHead = Math.max(playHead, context.currentTime + 0.05);
    source.start(playHead); playHead += buffer.duration;
    sources.add(source); source.onended = () => sources.delete(source);
  }

  async function play(from = 0) {
    if (!lines.length) return;
    halt();
    const mine = run;
    before();
    playing = true; current = from; paint();
    try {
      context ||= new AudioContext({ sampleRate: RATE });
      if (context.state !== 'running') await Promise.race([context.resume().catch(() => {}), new Promise(r => setTimeout(r, 1000))]);
    } catch {}
    if (mine !== run) return;
    if (context?.state !== 'running') { playing = false; status = '浏览器这次没有允许自动出声，点“播放”开始。'; paint(); return; }
    playHead = context.currentTime + 0.05; starts = [];
    let missed = 0;
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
      if (!n) { missed++; status = `有 ${missed} 行没念成：${line.error || '没有收到声音'}。文字都在上面。`; paint(); }
    }
    await new Promise(r => setTimeout(r, Math.max(0, playHead - context.currentTime) * 1000 + 100));
    if (mine !== run) return;
    clearInterval(poll); poll = null; playing = false; current = -1; paint();
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
    if (paused) { paused = false; context.resume().catch(() => {}); }
    else { paused = true; context.suspend().catch(() => {}); }
    paint();
  };
  $('explain-replay').onclick = () => void play(0);

  return {
    busy: () => playing && !paused,
    stop() { if (playing) { halt(); paint(); } },
    update(r) {
      const mode = voiceMode(r), key = mode?.auto && MODES.includes(mode.mode) ? mode.key : '';
      // Arriving at a new moment (not the page opening on one) starts it; a second window left open does not.
      const arrived = lastKey !== undefined && key && key !== lastKey;
      if (key !== (moment?.key || '')) {
        reset();
        moment = key ? { key, mode: mode.mode, round_id: r.id, window_start: r.window_start } : null;
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
