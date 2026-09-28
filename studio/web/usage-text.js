// How usage is put into words: in 「模型花费」 on the page, and on the extension's toolbar icon.
export const dollars = v => v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : v > 0 ? `$${v.toFixed(4)}` : '$0';
// At most four characters fit on the toolbar icon: $.18, $1.3, $12.
export const badgeDollars = v => v >= 9.95 ? `$${Math.round(v)}` : v >= 0.995 ? `$${v.toFixed(1)}` : `$.${String(Math.round(v * 100)).padStart(2, '0')}`;
// gemini-3.8-flash-lite-tts → Flash Lite
export const speechModelName = model => String(model).replace(/^gemini-[\d.]+-/, '').replace(/-tts$/, '')
  .split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
// When Google's day began, on the learner's own clock (15:00 in Beijing while California keeps summer time).
export const googleDayStart = since => new Date(since).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
// The speech models' readings in Google's day, e.g. "Flash Lite 37 次，Flash 2 次".
export const speechCounts = speech => (speech?.by_model || []).map(m => `${speechModelName(m.model)} ${m.calls} 次`).join('，');
