import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, root } from './config.mjs';
import { Store } from './store.mjs';
import { createServer } from './http.mjs';

process.umask(0o077);
const cfg = config();
const data = join(root, 'studio/data'); mkdirSync(data, { recursive: true, mode: 0o700 });
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
const app = createServer({ store, pack, cfg: { ...cfg, ankiPush: true, ttsCacheDir: join(data, 'tts-cache') }, token: readFileSync(tokenPath, 'utf8').trim(), webRoot: join(root, 'studio/web') });
app.server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`生成台 http://127.0.0.1:${cfg.port}`);
  console.log(`Jev: ${cfg.key ? 'configured' : 'not configured'} · ${cfg.model} · native Voice: NOT_RUN`);
  console.log(`Gemini: ${cfg.geminiKey ? 'configured' : 'not configured'} · ${cfg.geminiModel}`);
});
app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port already in use. Choose STUDIO_PORT in .env.' : 'Unable to start server.'); store.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.closeStreams(); app.server.close(() => { store.close(); process.exit(0); });
});
