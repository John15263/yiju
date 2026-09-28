// Something to feel when a piece is written right (the learner, 2026-09-28): a chunk written without the
// prepared wording gets a short sound and a burst, each one in a row within the sentence a little bigger; a
// finished sentence gets more; a finished passage gets a burst over the whole page. Sounds are made here
// with Web Audio, so there are no files and no calls. Nothing waits for any of it: the practice goes on.
const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];
const COLORS = ['#2f6b45', '#5f9b6e', '#e0a93b', '#e07a5f', '#6d8fa6', '#b78fd6', '#f2cc5b'];

// Which step of the ladder a chunk just finished stands on: how many chunks in a row, since this run of the
// sentence began, were written by the learner. One seen with the key words counts, a step lower; one that
// needed the prepared wording, or was moved on from with a correction, ends the row and gets nothing.
export function chunkTier(events) {
  const last = events.findLastIndex(e => e.kind === 'phrase_start');
  const done = events.slice(last + 1).filter(e => e.kind === 'phrase_expression');
  const latest = done.at(-1);
  if (!latest || !own(latest)) return 0;
  let row = 0;
  for (let i = done.length - 1; i >= 0 && own(done[i]); i--) row++;
  return Math.max(1, Math.min(4, row) - (latest.level >= 2 ? 1 : 0));
}
const own = e => e.detail?.source === 'typed_original' && (e.level ?? 0) < 3;

export function createRewards({ sound = () => true } = {}) {
  let context = null, until = 0;
  const still = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function tone(freq, at, length, gain = 0.12, type = 'triangle') {
    const c = context, osc = c.createOscillator(), amp = c.createGain(), start = c.currentTime + at;
    osc.type = type; osc.frequency.setValueAtTime(freq, start);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(amp).connect(c.destination); osc.start(start); osc.stop(start + length + 0.02);
  }
  function play(notes) {
    if (!sound()) return;
    try {
      context ||= new AudioContext();
      if (context.state === 'suspended') void context.resume();
      let end = 0;
      for (const [freq, at, length, gain, type] of notes) { tone(freq, at, length, gain, type); end = Math.max(end, at + length); }
      until = Math.max(until, Date.now() + end * 1000);
    } catch {}
  }
  function layer() {
    let node = document.getElementById('reward-layer');
    if (!node) { node = Object.assign(document.createElement('div'), { id: 'reward-layer' }); node.setAttribute('aria-hidden', 'true'); document.body.append(node); }
    return node;
  }
  // A burst of little pieces from a point, flying out and falling.
  function burst(x, y, count, spread, { fall = 40, size = 7, time = 800 } = {}) {
    if (still()) return;
    const node = layer();
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('span'), angle = (Math.PI * 2 * i) / count + Math.random() * 0.6, reach = spread * (0.55 + Math.random() * 0.45);
      piece.className = 'reward-piece';
      piece.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size * (Math.random() < 0.5 ? 1 : 0.5)}px;background:${COLORS[i % COLORS.length]};`
        + `--dx:${Math.cos(angle) * reach}px;--dy:${Math.sin(angle) * reach}px;--fall:${fall + Math.random() * fall}px;--turn:${Math.round(Math.random() * 540 - 270)}deg;animation-duration:${time}ms`;
      piece.addEventListener('animationend', () => piece.remove());
      node.append(piece);
    }
  }
  function banner(text, big = false) {
    const node = layer(), line = document.createElement('div');
    line.className = 'reward-banner' + (big ? ' big' : ''); line.textContent = text;
    line.addEventListener('animationend', () => line.remove());
    node.append(line);
  }
  const centre = element => {
    const box = element?.getBoundingClientRect?.();
    return box && box.width ? [box.left + box.width / 2, box.top + Math.min(box.height / 2, 60)] : [innerWidth / 2, innerHeight / 3];
  };
  function pop(element) {
    if (!element || still()) return;
    element.classList.remove('reward-pop'); void element.offsetWidth; element.classList.add('reward-pop');
  }
  return {
    // How long the sound still has to run, so an explanation starting by itself waits for it.
    remaining: () => Math.max(0, until - Date.now()),
    chunk(tier, element) {
      const base = Math.min(tier, 4) - 1;
      play([[NOTES[base * 2], 0, 0.16, 0.1], [NOTES[base * 2 + 1], 0.07, 0.22 + tier * 0.03, 0.11]]);
      const [x, y] = centre(element);
      burst(x, y, 6 + tier * 6, 50 + tier * 28, { size: 5 + tier, time: 650 + tier * 60 });
      pop(element);
    },
    sentence(element) {
      play([[NOTES[0], 0, 0.3], [NOTES[2], 0.08, 0.3], [NOTES[3], 0.16, 0.3], [NOTES[5], 0.24, 0.55, 0.13], [NOTES[3] / 2, 0.24, 0.55, 0.06, 'sine']]);
      const [x, y] = centre(element);
      burst(x, y, 44, 190, { size: 8, fall: 70, time: 1100 });
      banner('这一句完成');
    },
    passage() {
      play([[NOTES[0], 0, 0.25], [NOTES[2], 0.09, 0.25], [NOTES[3], 0.18, 0.25], [NOTES[5], 0.27, 0.25], [NOTES[7], 0.36, 0.3], [NOTES[8], 0.45, 0.9, 0.13],
        [NOTES[0] / 2, 0.45, 1.1, 0.07, 'sine'], [NOTES[2] / 2, 0.45, 1.1, 0.05, 'sine'], [NOTES[5], 0.6, 0.8, 0.06, 'sine']]);
      for (let n = 0; n < 5; n++) setTimeout(() => burst(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.2 + Math.random() * 0.35), 60, 260, { size: 9, fall: 160, time: 1500 }), n * 160);
      banner('整段写完！', true);
    },
  };
}
