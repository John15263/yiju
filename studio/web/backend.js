// How the page reaches 一句's engine. This one talks to the local server over HTTP; the browser extension ships
// its own backend.js with the same exports, which runs the engine inside the side panel instead.
export const local = true;

// A call to the engine: GET without a body, POST with one. Resolves with the reply, rejects with its message.
export async function request(path, body) {
  let res;
  try { res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('连不上本机的一句服务。'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '本机连接失败');
  return data;
}

// Speech comes back as a stream of raw audio, so it is fetched as a response rather than as JSON.
export const speak = (path, init) => fetch(path, init);

// Every change to the practice arrives as a state; `build` names the page code the server is running, so a page
// left open across a restart can tell it is out of date; up and down say whether the engine is in reach.
export function subscribe({ state, build = () => {}, up = () => {}, down = () => {} }) {
  const events = new EventSource('/api/sentence/events');
  events.addEventListener('build', event => { try { build(JSON.parse(event.data)); } catch {} });
  events.addEventListener('state', event => state(JSON.parse(event.data)));
  events.onopen = () => up();
  events.onerror = () => down();
}

// Without the microphone: in a browser tab the permission is asked for in the address bar.
export function microphoneDenied() { return '没有取得麦克风权限。浏览器地址栏里允许麦克风后再试。'; }

// A live voice call about one moment of one sentence. The server relays it, so the page streams its microphone as
// 16 kHz PCM and plays back 24 kHz PCM ('pcm'); events come back as { voice: 'ready' | 'audio' | 'heard' | … }.
export function openVoice(params, on) {
  const ws = new WebSocket(`ws://${location.host}/api/sentence/voice?${new URLSearchParams(params)}`);
  ws.onmessage = event => { try { on.message(JSON.parse(event.data)); } catch {} };
  ws.onerror = () => on.error?.();
  ws.onclose = () => on.close();
  return {
    transport: 'pcm',
    ready: () => ws.readyState === WebSocket.OPEN,
    send: value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); },
    close: () => { try { ws.close(); } catch {} },
  };
}

// Anki is reached through AnkiConnect on this computer; the local server needs no permission for that.
export const allowAnki = async () => true;
export const ankiNote = 'Anki 要开着，并装好 AnkiConnect 插件（代码 2055492159）。';
