import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, root } from './config.mjs';
import { Store } from './store.mjs';
import { createServer } from './http.mjs';
import { Settings } from './settings.mjs';
import { settingsFile } from './settings-file.mjs';
import { textName, textModel } from './llm.mjs';
import { voiceProvider } from './voice-providers.mjs';

process.umask(0o077);
const data = join(root, 'studio/data'); mkdirSync(data, { recursive: true, mode: 0o700 });
// Keys and choices made on the settings page take precedence over .env. The local server pushes to Anki unless told not to.
const settings = new Settings(settingsFile(join(data, 'settings.json')));
const env = { ANKI_PUSH: 'on', ...process.env };
const cfg = config(settings.env(env));
const tokenPath = join(data, '.local-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600 });
chmodSync(tokenPath, 0o600);
const pack = JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json'), 'utf8'));
const store = new Store(join(data, 'studio.sqlite'));
// Interrupted calls are never replayed on restart (avoids surprise API charges).
for (const s of store.list()) for (const trace of store.decisions(s.session_id)) if (trace.disposition === 'pending') {
  const saved = store.decision(s.session_id, trace.decision_id);
  store.saveDecision(s.session_id, saved.fingerprint, { ...trace, disposition: 'escalated', reason: 'runtime_restarted_before_completion' });
}
const app = createServer({ store, pack, cfg: { ...cfg, ttsCacheDir: join(data, 'tts-cache') }, settings, env, token: readFileSync(tokenPath, 'utf8').trim(), webRoot: join(root, 'studio/web') });
app.server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`生成台 http://127.0.0.1:${cfg.port}`);
  console.log(`Jev: ${cfg.key ? 'configured' : 'not configured'} · ${cfg.model} · native Voice: NOT_RUN`);
  console.log(`Text: ${textName(cfg)} · ${textModel(cfg)} · Voice: ${voiceProvider(cfg).name} · Speech: ${cfg.speechProvider} · Anki: ${cfg.ankiPush ? 'on' : 'off'}`);
});
app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port already in use. Choose STUDIO_PORT in .env.' : 'Unable to start server.'); store.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.closeStreams(); app.server.close(() => { store.close(); process.exit(0); });
});
