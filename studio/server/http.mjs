import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { check, HttpError } from './validation.mjs';
import { Runtime } from './runtime.mjs';
import { Decisions } from './decisions.mjs';
import { SentenceBoard } from './sentence.mjs';
import { Cloze } from './cloze.mjs';
import { Reviews } from './review.mjs';
import { Preparations } from './preparation.mjs';
import { Freewrites } from './freewrites.mjs';
import { WritingHelp } from './writing-help.mjs';
import { Phrases } from './phrases.mjs';
import { Voice } from './voice.mjs';
import { Usage } from './usage.mjs';
import { Quizzes } from './quiz.mjs';
import { Anki } from './anki.mjs';
import { Speech } from './tts.mjs';
import { Explanations } from './explain.mjs';
import { accept } from './ws.mjs';
import { config } from './config.mjs';
import { Settings, testServices } from './settings.mjs';
import { textConfigured } from './llm.mjs';
import { appConfig } from './app-config.mjs';

export function createServer({ store, pack, cfg, settings = new Settings(), env = process.env, connect, webRoot, token = randomBytes(32).toString('hex'), infer, clozeInfer, reviewInfer, preparationInfer, writingHelpInfer, phrasePreparationInfer, phraseInfer }) {
  const streams = new Map();
  // Every model call below meters itself through cfg.usage. Every part shares this one cfg, so a change made on
  // the settings page reaches all of them at once.
  const usage = new Usage(store); cfg = { ...cfg, usage };
  const anki = new Anki(store, cfg); cfg.anki = anki;
  const runtime = new Runtime(store, pack, (session, state) => {
    for (const res of streams.get(session) || []) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  });
  const decisions = new Decisions(runtime, cfg, infer);
  const sentence = new SentenceBoard(store, state => {
    for (const res of streams.get('sentence-board') || []) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  });
  const files = new Map([
    ['/phrases.js', ['phrases.js', 'text/javascript; charset=utf-8']],
    ['/backend.js', ['backend.js', 'text/javascript; charset=utf-8']],
    ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
    ['/writing-help.js', ['writing-help.js', 'text/javascript; charset=utf-8']],
    ['/freewrite.js', ['freewrite.js', 'text/javascript; charset=utf-8']],
    ['/freewrite-state.mjs', ['freewrite-state.mjs', 'text/javascript; charset=utf-8']],
    ['/expression.js', ['expression.js', 'text/javascript; charset=utf-8']],
    ['/view.js', ['view.js', 'text/javascript; charset=utf-8']],
    ['/voice.js', ['voice.js', 'text/javascript; charset=utf-8']],
    ['/speech.js', ['speech.js', 'text/javascript; charset=utf-8']],
    ['/voice-mode.js', ['voice-mode.js', 'text/javascript; charset=utf-8']],
    ['/correction.js', ['correction.js', 'text/javascript; charset=utf-8']],
    ['/quiz.js', ['quiz.js', 'text/javascript; charset=utf-8']],
    ['/explain.js', ['explain.js', 'text/javascript; charset=utf-8']],
    ['/voice-worklet.js', ['voice-worklet.js', 'text/javascript; charset=utf-8']],
    ['/compose.js', ['compose.js', 'text/javascript; charset=utf-8']],
    ['/cloze.js', ['cloze.js', 'text/javascript; charset=utf-8']],
    ['/', ['sentence.html', 'text/html; charset=utf-8']], ['/legacy', ['index.html', 'text/html; charset=utf-8']],
    ['/sentence.js', ['sentence.js', 'text/javascript; charset=utf-8']], ['/sentence.css', ['sentence.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  // What the page's code is, so a page left open across a restart can tell it is running old code.
  const build = (() => { const hash = createHash('sha256'); for (const [file] of files.values()) { try { hash.update(readFileSync(join(webRoot, file))); } catch {} } return hash.digest('hex').slice(0, 12); })();
  const cloze = new Cloze(sentence, cfg, clozeInfer);
  const reviews = new Reviews(sentence, cfg, reviewInfer);
  const preparations = new Preparations(sentence, cfg, preparationInfer);
  const freewrites = new Freewrites(store);
  const writingHelp = new WritingHelp(sentence, cfg, writingHelpInfer);
  const phrases = new Phrases(sentence, cfg, phrasePreparationInfer, phraseInfer);
  const voice = new Voice(sentence, cfg, connect);
  const quizzes = new Quizzes(sentence, cfg, phrases);
  const speech = new Speech(cfg);
  const explanations = new Explanations(sentence, cfg);
  // The sentence board makes the sentence's fill-in check when feedback is done, and files its card too.
  sentence.anki = anki;
  if (cfg.ankiPush) anki.start();
  const sockets = new Set();
  const equal = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  async function body(req) {
    check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Expected application/json', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; check(size <= 100000, 'Request too large', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      check(hosts.includes(req.headers.host), 'Invalid Host', 403);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin) check(req.headers.origin === origin, 'Cross-origin request denied', 403);
      check(!['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']), 'Cross-site request denied', 403);
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, { service: 'generative-studio', version: '0.4.1' });
      if (req.method === 'GET' && files.has(path)) {
        const [file, mime] = files.get(path);
        if (path === '/' || path === '/legacy') res.setHeader('Set-Cookie', `studio_auth=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': mime }); return res.end(readFileSync(join(webRoot, file)));
      }
      const bearer = req.headers.authorization?.startsWith('Bearer ') && equal(req.headers.authorization.slice(7));
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('studio_auth='))?.slice(12);
      check(bearer || equal(cookie), 'Authentication required', 401);
      if (req.method !== 'GET' && !bearer) check(req.headers.origin === origin, 'Same-origin write required', 403);
      if (path === '/api/sentence' && req.method === 'GET') return json(res, sentence.get());
      if (path === '/api/sentence/commands' && req.method === 'POST') {
        const command = await body(req), state = sentence.command(command);
        if (['cloze_submit', 'attempt'].includes(command.type) && !state.duplicate && textConfigured(cfg)) {
          reviews.start({ round_id: state.active.id, attempt_id: state.active.attempts.at(-1).id });
          return json(res, sentence.get());
        }
        return json(res, state);
      }
      if (path === '/api/sentence/freewrites' && req.method === 'POST') return json(res, freewrites.save(await body(req)));
      if (path === '/api/sentence/prepare' && req.method === 'POST') return json(res, preparations.start(await body(req)));
      if (path === '/api/sentence/review' && req.method === 'POST') return json(res, reviews.start(await body(req)));
      if (path === '/api/sentence/writing-help' && req.method === 'POST') return json(res, await writingHelp.request(await body(req)));
      if (path === '/api/sentence/writing-help/seen' && req.method === 'POST') return json(res, writingHelp.seen(await body(req)));
      if (req.method === 'POST' && path.startsWith('/api/sentence/phrases/')) {
        const action = path.slice('/api/sentence/phrases/'.length);
        check(['ensure', 'hint', 'check', 'continue', 'next', 'order', 'write'].includes(action), 'Not found', 404);
        return json(res, await phrases[action](await body(req)));
      }
      if (req.method === 'POST' && path.startsWith('/api/sentence/cloze/')) {
        const action = path.slice('/api/sentence/cloze/'.length);
        check(['input', 'check', 'hint', 'focus'].includes(action), 'Not found', 404);
        return json(res, await cloze[action](await body(req)));
      }
      if (path === '/api/sentence/view-ack' && req.method === 'POST') return json(res, sentence.ack(await body(req)));
      if (path === '/api/sentence/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (!streams.has('sentence-board')) streams.set('sentence-board', new Set());
        streams.get('sentence-board').add(res);
        res.write(`event: build\ndata: ${JSON.stringify(build)}\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(sentence.get())}\n\n`);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); streams.get('sentence-board')?.delete(res); });
        return;
      }
      if (req.method === 'GET' && path === '/api/config') return json(res, appConfig(cfg));
      if (req.method === 'GET' && path === '/api/settings') return json(res, settings.view(cfg));
      if (req.method === 'POST' && path === '/api/settings') {
        const values = settings.patch(await body(req));
        let next;
        try { next = config(settings.env(env, values)); } catch (e) { throw new HttpError(400, `设置不对：${e.message}`); }
        settings.save(values);
        Object.assign(cfg, next);
        if (cfg.ankiPush && !anki.timer) anki.start();
        return json(res, settings.view(cfg));
      }
      if (req.method === 'POST' && path === '/api/settings/test') return json(res, await testServices(cfg, { connect }));
      if (req.method === 'POST' && path === '/api/sentence/explain') return json(res, await explanations.request(await body(req)));
      if (req.method === 'POST' && path === '/api/sentence/speak') return await speech.stream(await body(req), req, res);
      if (req.method === 'GET' && path === '/api/usage') return json(res, usage.summary());
      if (req.method === 'GET' && path === '/api/anki') return json(res, anki.status());
      if (req.method === 'POST' && path === '/api/anki/flush') { await anki.flush(); return json(res, anki.status()); }
      if (req.method === 'POST' && path.startsWith('/api/sentence/quiz/')) {
        const action = path.slice('/api/sentence/quiz/'.length);
        check(['answer', 'continue'].includes(action), 'Not found', 404);
        return json(res, await quizzes[action](await body(req)));
      }
      if (req.method === 'GET' && path === '/api/packs') return json(res, [pack]);
      if (path === '/api/sessions') {
        if (req.method === 'GET') return json(res, store.list());
        if (req.method === 'POST') return json(res, runtime.create(await body(req)), 201);
      }
      const match = path.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)(?:\/(commands|attempts|view-ack|events|export|brief|decisions)(?:\/([a-zA-Z0-9_-]+))?)?$/);
      check(match, 'Not found', 404);
      const [, session, action, decisionID] = match;
      runtime.get(session);
      if (req.method === 'GET') {
        if (!action) return json(res, runtime.get(session));
        if (action === 'brief') return json(res, runtime.brief(session));
        if (action === 'export') {
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="studio-${session}.md"` });
          return res.end(runtime.export(session));
        }
        if (action === 'decisions') {
          if (!decisionID) return json(res, store.decisions(session).map(t => decisions.decorate(session, t)));
          const saved = store.decision(session, decisionID); check(saved, 'Decision not found', 404);
          return json(res, decisions.decorate(session, saved.trace));
        }
        if (action === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          if (!streams.has(session)) streams.set(session, new Set()); streams.get(session).add(res);
          res.write(`event: state\ndata: ${JSON.stringify(runtime.get(session))}\n\n`);
          const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
          res.on('close', () => { clearInterval(heartbeat); streams.get(session)?.delete(res); if (!streams.get(session)?.size) streams.delete(session); });
          return;
        }
      }
      if (req.method === 'POST') {
        const b = await body(req);
        if (action === 'commands') return json(res, runtime.command(session, b));
        if (action === 'attempts') return json(res, runtime.attempt(session, b), 201);
        if (action === 'view-ack') return json(res, runtime.ack(session, b));
        if (action === 'decisions' && decisionID === 'next') return json(res, await decisions.next(session, b));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      json(res, { error: e instanceof HttpError ? e.message : 'Internal server error' }, e instanceof HttpError ? e.status : 500);
    }
  });
  // The voice relay is the one upgraded connection; it carries the learner's audio, never the key.
  server.on('upgrade', (req, socket) => {
    try {
      const port = server.address().port;
      const origin = `http://${req.headers.host}`;
      check([`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host), 'Invalid Host', 403);
      if (req.headers.origin) check(req.headers.origin === origin, 'Cross-origin request denied', 403);
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('studio_auth='))?.slice(12);
      check(equal(cookie), 'Authentication required', 401);
      const url = new URL(req.url, origin);
      check(url.pathname === '/api/sentence/voice', 'Not found', 404);
      const conn = accept(req, socket);
      if (!conn) return;
      sockets.add(conn); conn.on('close', () => sockets.delete(conn));
      voice.start(conn, url.searchParams);
    } catch { socket.destroy(); }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return { server, runtime, decisions, sentence, cloze, reviews, preparations, freewrites, phrases, voice, usage, anki, quizzes, token,
    closeStreams: () => { for (const set of streams.values()) for (const res of set) res.end(); for (const conn of sockets) conn.close(1001, 'Server stopping'); } };
}
