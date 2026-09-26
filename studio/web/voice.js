import { voiceMode } from './voice-mode.js';
import { openQuiz } from './view.js';
// Live voice tutor: the page carries the learner's microphone, never the API key.
// The local server owns the prompt and records what was said.
const OUTPUT_RATE = 24000;
// The cost shown is what Google reports each turn used, priced on the server; nothing here guesses it.

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// While a chunk is studied or a correction is on screen the tutor is the task, not a lifeline, so the button says so.
const LABELS = { learn: '问问题 · ⌘ ]', fix: '问问题 · ⌘ ]', review: '问问题 · ⌘ ]', write: '语音陪练 · ⌘ ]' };
// How each conversation is headed in the transcript: which part of the sentence, and what kind of talk.
const KINDS = { learn: '讲解', fix: '批改讲解', review: '点评讲解' };
const sessionLabel = (stage, index) => `${['review', 'practice'].includes(stage) || !Number.isInteger(index) ? '整句' : `短语 ${index + 1}`} · ${KINDS[stage] || '陪练'}`;
// The moment on screen, named the way the server records its calls, so this moment's talk can be told from earlier talk.
function partOf(r) {
  const mode = voiceMode(r);
  if (!mode) return null;
  const index = mode.correction?.index ?? r.phrases?.index ?? null;
  const heading = sessionLabel(mode.mode === 'write' ? r.stage : mode.mode, index), total = r.phrases?.items?.length;
  const title = /^短语/.test(heading) && total ? heading.replace(`短语 ${index + 1}`, `短语 ${index + 1} / ${total}`) : heading;
  return { mode: mode.mode, key: mode.key, heading, title };
}
const IDLE = { learn: '讲解在左边念。有问题再开实时语音问。', fix: '讲解在左边念。有问题再开实时语音问。', review: '讲解在左边念。有问题再开实时语音问。', write: '陪练没有开。' };

export function createVoiceUI({ getState, render, error, draftOf, quiet = () => {} }) {
  const $ = id => document.getElementById(id);
  // This page load, as the server and the other open pages know it.
  const pageID = globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2);
  // Other pages of the practice open in this browser (tabs or windows). Each would start the tutor on its
  // own, so the panel says so; they find each other over a same-origin channel and are forgotten when quiet.
  const others = new Map();
  try {
    const channel = new BroadcastChannel('yiju-pages');
    const prune = () => { for (const [id, seen] of others) if (Date.now() - seen > 12000) others.delete(id); };
    channel.onmessage = ({ data }) => {
      if (!data?.id || data.id === pageID) return;
      if (data.type === 'bye') others.delete(data.id);
      else { others.set(data.id, Date.now()); if (data.type === 'hello') channel.postMessage({ type: 'here', id: pageID }); }
      paint();
    };
    channel.postMessage({ type: 'hello', id: pageID });
    setInterval(() => { channel.postMessage({ type: 'here', id: pageID }); prune(); paint(); }, 5000);
    addEventListener('pagehide', () => channel.postMessage({ type: 'bye', id: pageID }));
  } catch {}
  let socket = null, capture = null, stream = null, playback = null, playHead = 0, sources = new Set();
  let status = '', live = false, startedAt = 0, ticker = null, lines = [], settings = null, sentDraft = '', usd = 0;
  // A start that is still opening the microphone is abandoned the moment a stop or a newer start comes.
  let sessionKey = '', scopeKey = '', sessionMode = '', generation = 0;
  // The whole sentence's conversations stay readable: the recorded ones come from the practice state, the
  // live one from here, and one just ended stays here until it shows up among the recorded (by its id).
  let sessionID = '', sessionHeading = '', ended = null, painted = '', shownRound, shownKey;

  const open = () => live;
  // The top of the panel always answers two things: which part of the sentence this is, and what the tutor is doing now.
  function paint() {
    const r = getState()?.active, part = partOf(r), running = live, mode = part?.mode || 'write';
    $('voice-part').textContent = part ? part.title : openQuiz(r) ? '正在做改错小测，这时不开语音。' : '这一步不开语音。';
    $('voice-live').hidden = !running;
    $('voice-idle').hidden = running || !part;
    $('voice-idle-text').textContent = IDLE[mode] || '';
    $('voice-state').textContent = running ? liveState() : '';
    $('voice-status').textContent = status;
    $('voice-status').hidden = !status;
    $('voice-elsewhere').hidden = !others.size;
    $('voice-elsewhere').textContent = `这个练习还开在另外 ${others.size} 个标签页或窗口里。每个都会自己开讲，对话记录也分在各自那边；只留一个就好。`;
    $('voice-timer').textContent = running ? elapsed() : '';
    $('voice-hint').hidden = mode !== 'write';
    $('voice-hint-learn').hidden = mode !== 'learn';
    $('voice-hint-fix').hidden = !['fix', 'review'].includes(mode);
    $('voice-open').textContent = running ? `● 语音 ${elapsed()}` : LABELS[mode];
    $('voice-cost').textContent = running ? ` · ${money(usd)}` : '';
    paintTranscript(r, part);
  }
  function liveState() {
    if (!sessionID) return '正在连接…';
    if (sources.size) return '陪练在讲';
    if (sessionMode !== 'write' && !lines.some(line => line.role === 'tutor')) return '陪练准备开讲…';
    return sessionMode === 'write' ? '在听' : '在听，你可以提问';
  }
  function paintLines(list, blocks, headings) {
    list.replaceChildren();
    for (const block of blocks) {
      if (!block.lines.length) continue;
      if (headings) {
        const heading = document.createElement('p');
        heading.className = 'voice-session'; heading.textContent = block.heading;
        list.append(heading);
      }
      for (const line of block.lines) {
        const item = document.createElement('p');
        item.className = line.role === 'tutor' ? 'voice-tutor' : line.role === 'moved' ? 'voice-moved' : 'voice-user';
        item.textContent = line.text;
        list.append(item);
      }
    }
  }
  // This moment's conversation in full; the sentence's earlier ones folded away underneath, still there to reread.
  function paintTranscript(r, part) {
    const past = (r?.support_events || []).filter(e => e.kind === 'voice_session');
    if (ended && (ended.round !== r?.id || past.some(e => e.detail?.session_id === ended.id))) ended = null;
    const blocks = past.map(e => ({ heading: sessionLabel(e.detail?.stage, e.detail?.index), lines: e.detail?.transcript || [] }));
    if (ended) blocks.push({ heading: ended.heading, lines: ended.lines });
    if (live) blocks.push({ heading: sessionHeading, lines });
    const signature = `${r?.id}|${part?.heading}|${past.length}|${ended?.id}|${live}|${lines.length}|${lines.at(-1)?.text.length || 0}`;
    if (signature === painted) return;
    painted = signature;
    const here = blocks.filter(b => b.heading === part?.heading && b.lines.length), earlier = blocks.filter(b => b.heading !== part?.heading && b.lines.length);
    const list = $('voice-transcript');
    // Follow new words only if he is not scrolled up reading something earlier.
    const following = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    // Several calls about the same moment (reopened after a stop) read on as one, divided by a rule.
    paintLines(list, here.map((b, i) => ({ ...b, heading: i ? '又开了一次' : '' })), here.length > 1);
    list.hidden = !here.length;
    $('voice-earlier').hidden = !earlier.length;
    $('voice-earlier-title').textContent = `这一句的其它对话 · ${earlier.length} 段`;
    paintLines($('voice-earlier-list'), earlier, true);
    if (following) list.scrollTop = list.scrollHeight;
  }
  function elapsed() {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  const money = value => !value ? '$0' : value < 0.001 ? '< $0.001' : `$${value.toFixed(3)}`;
  function note(role, text) {
    const last = lines.at(-1);
    if (last && last.role === role && !last.done) last.text += text;
    else lines.push({ role, text });
    paint();
  }

  // The mode's key names the moment a call belongs to; only a writing call follows the learner from chunk to chunk.
  const scopeLabel = r => r.stage === 'practice' ? '已切到：整句'
    : `已切到：短语 ${(r.phrases?.index ?? 0) + 1} / ${r.phrases?.items?.length ?? '?'}`;
  // The microphone and speakers of one start. They become the session's only while that start is still
  // the current one; otherwise they are closed on the spot, so an abandoned start never leaves the mic on.
  async function openAudio() {
    const audio = { stream: await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) };
    try {
      audio.capture = new AudioContext({ sampleRate: 16000 });
      audio.playback = new AudioContext({ sampleRate: OUTPUT_RATE });
      await audio.capture.audioWorklet.addModule('/voice-worklet.js');
      const source = audio.capture.createMediaStreamSource(audio.stream);
      const worklet = new AudioWorkletNode(audio.capture, 'voice-capture', { processorOptions: { target: 16000, chunk: 1600 } });
      worklet.port.onmessage = event => {
        if (capture === audio.capture && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'audio', data: toBase64(event.data) }));
      };
      source.connect(worklet);
      // Safari starts audio contexts suspended; the opening click is the gesture that resumes them.
      // A session started on its own may have no gesture behind it, and resume can then hang.
      await Promise.race([Promise.all([audio.capture.resume(), audio.playback.resume()].map(p => p.catch(() => {}))), new Promise(r => setTimeout(r, 1500))]);
      // Talking into a page that cannot play the answer would only cost money.
      if (audio.playback.state !== 'running') throw Object.assign(new Error('Audio blocked'), { name: 'AudioBlocked' });
      return audio;
    } catch (e) { free(audio); throw e; }
  }
  function free(audio) {
    for (const track of audio?.stream?.getTracks() || []) track.stop();
    audio?.capture?.close().catch(() => {});
    audio?.playback?.close().catch(() => {});
  }
  function play(base64) {
    if (!playback) return;
    const bytes = fromBase64(base64), samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!samples.length) return;
    const buffer = playback.createBuffer(1, samples.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 0x8000;
    const source = playback.createBufferSource();
    source.buffer = buffer; source.connect(playback.destination);
    playHead = Math.max(playHead, playback.currentTime + 0.06);
    source.start(playHead);
    playHead += buffer.duration;
    sources.add(source);
    source.onended = () => sources.delete(source);
  }
  function silence() {
    for (const source of sources) { try { source.stop(); } catch {} }
    sources.clear();
    playHead = playback ? playback.currentTime : 0;
  }

  async function start(auto = false) {
    const r = getState()?.active, mode = voiceMode(r);
    if (live || !mode) return;
    // A hint being read aloud must not talk over the tutor.
    globalThis.speechSynthesis?.cancel(); quiet();
    if (!settings?.voice_configured) { status = '语音陪练需要配置 GEMINI_API_KEY。'; paint(); return; }
    const run = ++generation;
    live = true; lines = []; sentDraft = ''; usd = 0; startedAt = Date.now(); sessionID = '';
    sessionKey = `${r.id}:${r.window_start}`; scopeKey = mode.key; sessionMode = mode.mode;
    sessionHeading = sessionLabel(mode.mode === 'write' ? r.stage : mode.mode, mode.correction?.index ?? (r.stage === 'phrases' ? r.phrases.index : null));
    status = ''; paint();
    let audio;
    try { audio = await openAudio(); }
    catch (e) {
      if (run !== generation) return;
      live = false;
      status = e.name === 'NotAllowedError' ? '没有取得麦克风权限。浏览器地址栏里允许麦克风后再试。'
        : e.name === 'AudioBlocked' ? '浏览器这次没有允许自动播放声音，按 ⌘ ] 开始讲解。' : '打不开麦克风，这次没有开始。';
      paint(); return;
    }
    // Stopped, or replaced by a newer start, while the microphone was opening.
    if (run !== generation) { free(audio); return; }
    ({ stream, capture, playback } = audio); playHead = 0;
    // Each socket answers only for itself: an old one still closing must never end the call that replaced it.
    const ws = new WebSocket(`ws://${location.host}/api/sentence/voice?round_id=${encodeURIComponent(r.id)}&window_start=${r.window_start}&page=${encodeURIComponent(pageID)}${auto ? '&auto=1' : ''}`);
    socket = ws;
    ws.onmessage = event => {
      if (socket !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.voice === 'ready') { status = ''; startedAt = Date.now(); sessionID = message.session || 'ready'; paint(); return; }
      if (message.voice === 'error') { status = message.message; paint(); return; }
      if (message.voice === 'usage') { usd = message.usd; paint(); return; }
      if (message.voice === 'closed') { status = message.reason; stop(false); return; }
      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted) silence();
      for (const part of content.modelTurn?.parts || []) if (part.inlineData?.data) play(part.inlineData.data);
      if (content.inputTranscription?.text) note('user', content.inputTranscription.text);
      if (content.outputTranscription?.text) note('tutor', content.outputTranscription.text);
      if (content.turnComplete) for (const line of lines) line.done = true;
    };
    ws.onerror = () => { if (socket === ws) status = '语音连接出错，已结束。'; };
    ws.onclose = () => { if (socket === ws && live) { status = status || '语音已结束。'; stop(false); } };
    ticker = setInterval(() => { if (live) { paint(); sendDraft(); } }, 1000);
  }
  function sendDraft() {
    const value = draftOf();
    if (value === sentDraft || socket?.readyState !== WebSocket.OPEN) return;
    sentDraft = value;
    socket.send(JSON.stringify({ type: 'draft', data: value }));
  }
  function stop(closeSocket = true) {
    generation++;
    if (!live && !socket) return;
    // Time and cost only for a call that actually got through.
    if (live && sessionID) status = `${status || '语音已结束。'} 用时 ${elapsed()} · 实际花费 ${money(usd)}`;
    live = false;
    // What was just said stays on screen until the recorded copy of it arrives.
    if (sessionID && lines.some(line => line.role !== 'moved')) ended = { id: sessionID, round: getState()?.active?.id, heading: sessionHeading, lines };
    lines = []; sessionID = '';
    clearInterval(ticker); ticker = null;
    const ws = socket; socket = null;
    if (ws && closeSocket) { try { ws.close(); } catch {} }
    release();
    paint();
    render(getState());
  }
  function release() {
    silence();
    free({ stream, capture, playback });
    stream = null; capture = null; playback = null;
  }
  $('voice-begin').onclick = () => { if (!live) void start(); };
  return {
    isOpen: open,
    toggle() { if (live) { status = '语音已结束。'; stop(); } else void start(); },
    // Started by the page on arriving somewhere, not by a key: it gives way to another window already talking about it.
    auto() { if (!live) void start(true); },
    stop() { if (live) { status = ''; stop(); } },
    configure(value) { settings = value; },
    elapsed,
    update(r) {
      const mode = voiceMode(r);
      // A new sentence starts with a clean panel: no status or conversation left over from the last one.
      if (r?.id !== shownRound) {
        if (shownRound !== undefined && !live) { status = ''; ended = null; painted = ''; }
        shownRound = r?.id;
      }
      const key = partOf(r)?.key;
      if (live) {
        if (!mode) { status = '练习已切换，语音结束。'; stop(); }
        else if (`${r.id}:${r.window_start}` !== sessionKey) { status = '换了一句，语音结束。'; stop(); }
        // A call handed a chunk's wording or a correction belongs to that moment and ends with it; a
        // writing call does not stretch into teaching or explaining either.
        else if (mode.key !== scopeKey && (sessionMode !== 'write' || mode.mode !== 'write')) {
          status = sessionMode === 'learn' ? '这一块学完了，语音结束。' : sessionMode !== 'write' ? '批改讲解结束，语音结束。'
            : mode.mode === 'learn' ? '到了新的一块，语音结束。' : '有新的批改，语音结束。';
          stop();
        } else if (mode.key !== scopeKey) {
          // Same sentence, next chunk: keep talking, but tell the tutor where we are now.
          scopeKey = mode.key; sentDraft = null;
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'scope' }));
          lines.push({ role: 'moved', text: scopeLabel(r), done: true });
        }
      }
      // A new moment starts with a clean top: why the last call ended belongs to the last moment.
      if (key !== shownKey) { if (!live && shownKey !== undefined) status = ''; shownKey = key; }
      paint();
    },
  };
}
