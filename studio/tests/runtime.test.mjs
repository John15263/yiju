import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Store } from '../server/store.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Decisions, decisionSpec, callJev } from '../server/decisions.mjs';
import { config, root } from '../server/config.mjs';
import { createServer } from '../server/http.mjs';

const pack = JSON.parse(readFileSync(join(root, 'studio/packs/coffee-tea-sleep.json')));
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const runtime = new Runtime(store, pack);
  const session = runtime.create({ pack_id: pack.pack_id, target_language: 'ja' }).session_id;
  let counter = 0;
  const cmd = (type, payload = {}, rev = store.get(session).revision, command_id = `cmd-${++counter}`) => runtime.command(session, { command_id, expected_revision: rev, type, payload });
  const cfg = { ...config({}), key: 'test-only-not-a-real-key', minCueMs: 0 };
  return { store, runtime, session, cmd, cfg };
}
function response(choice, confidence = .97) {
  const keys = Object.keys(decisionSpec(pack, 'ja').question.criteria);
  return { model: 'jev-test', answers: { next_cue: { type: 'choice', choice, confidence,
    probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? .98 : .02 / (keys.length - 1)])) } } };
}
function prepare(c) {
  c.cmd('resume'); c.cmd('set_interaction', { user_control: 'help', recent_input: { text: '咖啡因，日语怎么说？', source: 'simulation' } });
}

test('language tracks share meaning but isolate drafts and cues', t => {
  const c = setup(t), en = c.runtime.create({ pack_id: pack.pack_id, target_language: 'en' });
  c.cmd('save_draft', { text: '私の言葉' }); c.cmd('show_hint', { hint_id: 'sleep' });
  assert.equal(c.runtime.get(en.session_id).draft, '');
  assert.equal(c.runtime.get(c.session).target_language, 'ja');
  assert.equal(pack.tracks.en.cues.sleep, 'affect my sleep');
});
test('commands are idempotent; stale revisions and reused IDs are rejected', t => {
  const c = setup(t);
  const b = { command_id: 'same', expected_revision: 0, type: 'resume', payload: {} };
  c.runtime.command(c.session, b);
  assert.equal(c.runtime.command(c.session, b).duplicate, true);
  assert.equal(c.runtime.get(c.session).revision, 1);
  assert.throws(() => c.cmd('hide_hint', {}, 0), /Revision conflict/);
  assert.throws(() => c.runtime.command(c.session, { ...b, type: 'park' }), /reused/);
  assert.throws(() => c.cmd('patch', { phase: 'parked' }), /Unknown command/);
  assert.throws(() => c.cmd('show_hint', { hint_id: '../anything' }), /Unregistered/);
  assert.throws(() => c.cmd('set_scaffold', { reference_visible: true }), /Unknown field/);
});
test('meaning and language axes independently hide complete references', t => {
  const c = setup(t); c.cmd('set_scaffold', { meaning_support: 'full', language_support: 'reference' });
  c.cmd('set_scaffold', { language_support: 'none' });
  const s = c.runtime.get(c.session);
  assert.equal(s.scaffold.meaning_support, 'full'); assert.equal(s.scaffold.reference_visible, false);
});
test('mid-attempt visual and spoken support survive hiding and stop', t => {
  const c = setup(t); c.cmd('resume'); c.cmd('begin_attempt');
  assert.throws(() => c.cmd('hide_hint'), /natural pause/);
  c.cmd('show_hint', { hint_id: 'sleep', explicit_help: true });
  c.cmd('record_spoken_support', { text: '睡眠への影響' });
  c.cmd('set_interaction', { is_user_speaking: false }); c.cmd('hide_hint'); c.cmd('park');
  const result = c.runtime.attempt(c.session, { attempt_id: 'a1', expected_revision: c.store.get(c.session).revision, text: '睡眠への影響が気になります。', source: 'simulation', user_confirmed: false });
  assert.equal(result.state.phase, 'parked');
  assert.equal(result.state.attempts[0].source, 'simulation');
  assert.ok(result.state.attempts[0].support_events.some(e => e.kind === 'show_hint'));
  assert.ok(result.state.attempts[0].support_events.some(e => e.kind === 'spoken_support'));
  assert.equal(result.state.attempts[0].final_support.scaffold.language_support, 'none');
});
test('view acknowledgement is monotonic and never changes session revision', t => {
  const c = setup(t); c.cmd('resume'); const before = c.store.get(c.session).revision;
  c.runtime.ack(c.session, { rendered_revision: 1 }); c.runtime.ack(c.session, { rendered_revision: 0 });
  assert.equal(c.store.get(c.session).revision, before); assert.equal(c.store.get(c.session).client_view.rendered_revision, 1);
  assert.equal(c.store.viewAck(c.session, 1).rendered_revision, 1);
  assert.throws(() => c.runtime.ack(c.session, { rendered_revision: 100 }), /Invalid/);
});
test('attempt retry is idempotent and AI revisions never overwrite the original', t => {
  const c = setup(t);
  const original = { attempt_id: 'original', expected_revision: 0, text: 'original words', source: 'typed_original', user_confirmed: true };
  c.runtime.attempt(c.session, original);
  assert.equal(c.runtime.attempt(c.session, original).duplicate, true);
  assert.throws(() => c.runtime.attempt(c.session, { ...original, text: 'changed' }), /reused/);
  c.runtime.attempt(c.session, { attempt_id: 'suggestion', expected_revision: 1, text: 'AI alternative', source: 'ai_suggestion', user_confirmed: false, parent_attempt_id: 'original' });
  const attempts = c.runtime.get(c.session).attempts;
  assert.equal(attempts.length, 2); assert.equal(attempts[0].text, 'original words');
  assert.equal(attempts[1].source, 'ai_suggestion'); assert.equal(attempts[1].parent_attempt_id, 'original');
  assert.throws(() => c.runtime.attempt(c.session, { ...original, attempt_id: 'control', expected_revision: 2, source: 'control' }), /Invalid option/);
});
test('park rejects changes but permits saving drafts and explicit resume', t => {
  const c = setup(t); c.cmd('park', { next_entry: '下次重说' });
  assert.throws(() => c.cmd('show_hint', { hint_id: 'sleep' }), /parked/);
  c.cmd('save_draft', { text: '保留' }); c.cmd('resume');
  assert.equal(c.store.get(c.session).draft, '保留'); assert.equal(c.store.get(c.session).next_entry, '下次重说');
});
test('persistence restores revisions, products, drafts and command receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
  try {
    const path = join(dir, 'state.sqlite'); let store = new Store(path); let r = new Runtime(store, pack);
    const s = r.create({ pack_id: pack.pack_id, target_language: 'en' });
    const cmd = { command_id: 'persist', expected_revision: 0, type: 'save_draft', payload: { text: 'hello' } };
    r.command(s.session_id, cmd);
    r.attempt(s.session_id, { attempt_id: 'persisted-attempt', expected_revision: 1, text: 'An earlier expression', source: 'simulation', user_confirmed: false });
    r.command(s.session_id, { command_id: 'draft2', expected_revision: 2, type: 'save_draft', payload: { text: 'hello' } });
    store.close(); store = new Store(path); r = new Runtime(store, pack);
    assert.equal(r.get(s.session_id).draft, 'hello'); assert.equal(r.command(s.session_id, cmd).duplicate, true);
    assert.equal(r.get(s.session_id).attempts[0].text, 'An earlier expression');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('high confidence mapped choice applies once; duplicate decision avoids second inference', async t => {
  const c = setup(t); prepare(c); let calls = 0;
  const d = new Decisions(c.runtime, c.cfg, async packet => { calls++; assert.equal(packet.recent_input.source, 'simulation'); return response('show_sleep'); });
  const b = { decision_id: 'd1', expected_revision: c.store.get(c.session).revision };
  const trace = await d.next(c.session, b);
  assert.equal(trace.disposition, 'applied'); assert.equal(c.runtime.get(c.session).scaffold.visible_hint_ids[0], 'sleep');
  assert.ok(trace.command_id); assert.equal(trace.state_hash.length, 64);
  assert.equal((await d.next(c.session, b)).command_id, trace.command_id); assert.equal(calls, 1);
  assert.equal(trace.view_ack, null);
  c.runtime.ack(c.session, { rendered_revision: trace.applied_revision });
  c.cmd('save_draft', { text: 'a later revision' });
  c.runtime.ack(c.session, { rendered_revision: c.runtime.get(c.session).revision });
  assert.equal((await d.next(c.session, b)).view_ack.rendered_revision, trace.applied_revision);
});
for (const [choice, conf, disposition] of [['show_sleep', .4, 'escalated'], ['ask_astra', .99, 'escalated'], ['keep_current', .99, 'ignored']]) {
  test(`${choice} ${conf} returns ${disposition} without changing state`, async t => {
    const c = setup(t); prepare(c); const before = c.runtime.get(c.session).revision;
    const d = new Decisions(c.runtime, c.cfg, async () => response(choice, conf));
    assert.equal((await d.next(c.session, { decision_id: 'd', expected_revision: before })).disposition, disposition);
    assert.equal(c.runtime.get(c.session).revision, before);
  });
}
for (const kind of ['unknown choice', 'missing probability', 'invalid probability', 'not maximum', 'invalid confidence']) {
  test(`malformed Jev response blocked: ${kind}`, async t => {
    const c = setup(t); prepare(c); const result = response('show_sleep'), a = result.answers.next_cue;
    if (kind === 'unknown choice') a.choice = 'execute_shell';
    if (kind === 'missing probability') delete a.probabilities.ask_astra;
    if (kind === 'invalid probability') a.probabilities.ask_astra = -1;
    if (kind === 'not maximum') a.choice = 'show_caffeine';
    if (kind === 'invalid confidence') a.confidence = '0.99';
    const d = new Decisions(c.runtime, c.cfg, async () => result);
    assert.equal((await d.next(c.session, { decision_id: 'd', expected_revision: c.store.get(c.session).revision })).disposition, 'blocked');
  });
}
for (const [change, outcome] of [['save_draft', 'stale'], ['park', 'blocked']]) {
  test(`late result after ${change} cannot change support`, async t => {
    const c = setup(t); prepare(c); let resolve;
    const d = new Decisions(c.runtime, c.cfg, () => new Promise(r => { resolve = r; }));
    const pending = d.next(c.session, { decision_id: 'd', expected_revision: c.store.get(c.session).revision });
    c.cmd(change, change === 'save_draft' ? { text: 'new draft' } : {});
    resolve(response('show_sleep'));
    assert.equal((await pending).disposition, outcome); assert.deepEqual(c.runtime.get(c.session).scaffold.visible_hint_ids, []);
  });
}
test('candidate set version is checked again after inference', async t => {
  const c = setup(t); prepare(c); let resolve;
  const d = new Decisions(c.runtime, c.cfg, () => new Promise(r => { resolve = r; }));
  const p = d.next(c.session, { decision_id: 'd', expected_revision: c.store.get(c.session).revision });
  const s = c.store.get(c.session); s.decision.candidate_set_version = 'new-version'; c.store.put(s); resolve(response('show_sleep'));
  assert.equal((await p).disposition, 'stale');
});
test('pending requests coalesce and reject concurrent distinct decisions', async t => {
  const c = setup(t); prepare(c); let calls = 0, resolve;
  const d = new Decisions(c.runtime, c.cfg, () => { calls++; return new Promise(r => { resolve = r; }); });
  const b = { decision_id: 'same', expected_revision: c.store.get(c.session).revision };
  const first = d.next(c.session, b), second = d.next(c.session, b);
  await assert.rejects(d.next(c.session, { ...b, decision_id: 'other' }), /in flight/);
  resolve(response('show_sleep')); assert.deepEqual(await first, await second); assert.equal(calls, 1);
});
for (const [setting, payload, reason] of [
  ['hold_conditions', { enabled: true }, 'conditions_held'],
  ['set_interaction', { user_control: 'no_hints' }, 'user_requested_no_hints'],
  ['set_interaction', { is_user_speaking: true, user_control: null }, 'user_speaking'],
]) {
  test(`deterministic gate: ${reason}`, async t => {
    const c = setup(t); prepare(c); c.cmd(setting, payload);
    const d = new Decisions(c.runtime, c.cfg, async () => response('show_sleep'));
    const trace = await d.next(c.session, { decision_id: 'd', expected_revision: c.store.get(c.session).revision });
    assert.equal(trace.disposition, 'blocked'); assert.equal(trace.reason, reason);
  });
}
test('minimum display time and cue dedup prevent visual flicker', async t => {
  const c = setup(t); prepare(c); c.cmd('show_hint', { hint_id: 'caffeine' });
  const d = new Decisions(c.runtime, { ...c.cfg, minCueMs: 60000 }, async () => response('show_sleep'));
  assert.equal((await d.next(c.session, { decision_id: 'a', expected_revision: c.store.get(c.session).revision })).reason, 'minimum_cue_display_time');
  d.infer = async () => response('show_caffeine');
  assert.equal((await d.next(c.session, { decision_id: 'b', expected_revision: c.store.get(c.session).revision })).reason, 'cue_already_visible');
});
test('missing key and provider errors escalate, without pretending to apply a command', async t => {
  const c = setup(t); prepare(c); let calls = 0;
  const d = new Decisions(c.runtime, { ...c.cfg, key: '' }, async () => { calls++; });
  assert.equal((await d.next(c.session, { decision_id: 'no-key', expected_revision: c.store.get(c.session).revision })).reason, 'api_key_missing'); assert.equal(calls, 0);
  d.cfg = c.cfg; d.infer = async () => { throw new Error('Jev HTTP 429'); };
  const result = await d.next(c.session, { decision_id: 'rate-limit', expected_revision: c.store.get(c.session).revision });
  assert.equal(result.reason, 'Jev HTTP 429'); assert.equal(result.command_id, null);
});
test('probability gap gate and stricter hide threshold', async t => {
  const c = setup(t); prepare(c);
  const result = response('show_sleep');
  for (const k of Object.keys(result.answers.next_cue.probabilities)) result.answers.next_cue.probabilities[k] = 0;
  result.answers.next_cue.probabilities.show_sleep = .51; result.answers.next_cue.probabilities.show_caffeine = .49;
  const d = new Decisions(c.runtime, c.cfg, async () => result);
  assert.equal((await d.next(c.session, { decision_id: 'gap', expected_revision: c.store.get(c.session).revision })).reason, 'below_configured_threshold');
  d.infer = async () => response('hide_current', .85);
  assert.equal((await d.next(c.session, { decision_id: 'hide', expected_revision: c.store.get(c.session).revision })).disposition, 'escalated');
});
test('parked decisions never contact provider', async t => {
  const c = setup(t); prepare(c); c.cmd('park'); let calls = 0;
  const d = new Decisions(c.runtime, c.cfg, async () => { calls++; return response('show_sleep'); });
  assert.equal((await d.next(c.session, { decision_id: 'parked', expected_revision: c.store.get(c.session).revision })).reason, 'session_parked');
  assert.equal(calls, 0);
});
test('provider HTTP contract and timeout are exercised with a local mock server', async t => {
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received = { headers: req.headers, body: JSON.parse(raw) };
    if (req.url === '/timeout') return;
    if (req.url === '/rate-limit') { res.writeHead(429); res.end('do not log this provider body'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response('show_sleep')));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  // Only the call that is meant to time out gets a short wait; under a busy test run 100 ms was not always
  // enough for the calls that should succeed.
  const cfg = { ...config({}), endpoint, key: 'fake-test-key', timeout: 5000 };
  const packet = { session_revision: 3, recent_input: 'local mock only' }, spec = decisionSpec(pack, 'ja');
  assert.equal((await callJev(packet, spec, cfg)).answers.next_cue.choice, 'show_sleep');
  assert.deepEqual(received.body.state, packet); assert.equal(received.body.model, 'jev-latest');
  assert.deepEqual(received.body.questions.next_cue, spec.question); assert.equal(received.headers.authorization, 'Bearer fake-test-key');
  await assert.rejects(callJev(packet, spec, { ...cfg, endpoint: endpoint + '/timeout', timeout: 100 }), /network error or timeout/);
  await assert.rejects(callJev(packet, spec, { ...cfg, endpoint: endpoint + '/rate-limit' }), /^Error: Jev HTTP 429$/);
});
test('SSE initial connection and reconnect return full current state', async t => {
  const c = setup(t), app = createServer({ ...c, webRoot: join(root, 'studio/web'), pack, token: 'sse-token' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => { app.closeStreams(); app.server.closeAllConnections(); return new Promise(r => app.server.close(r)); });
  const url = `http://127.0.0.1:${app.server.address().port}/api/sessions/${c.session}/events`;
  async function firstEvent() {
    const controller = new AbortController();
    const res = await fetch(url, { headers: { Authorization: 'Bearer sse-token' }, signal: controller.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader(); const chunk = await reader.read(); controller.abort();
    return JSON.parse(new TextDecoder().decode(chunk.value).split('data: ')[1].split('\n')[0]);
  }
  assert.equal((await firstEvent()).revision, 0); c.cmd('save_draft', { text: 'during disconnect' });
  const latest = await firstEvent(); assert.equal(latest.revision, 1); assert.equal(latest.draft, 'during disconnect');
});
test('HTTP authentication, Host, Origin, path and untrusted fields are enforced', async t => {
  const c = setup(t), app = createServer({ ...c, webRoot: join(root, 'studio/web'), pack, token: 'test-local-token' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => { app.closeStreams(); return new Promise(r => app.server.close(r)); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  assert.equal((await fetch(origin + '/api/sessions')).status, 401);
  assert.equal((await fetch(origin + '/', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    http.get(origin + '/', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const page = await fetch(origin + '/'); const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(origin + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ pack_id: pack.pack_id, target_language: 'en' }) })).status, 403);
  headers.Origin = origin;
  assert.equal((await fetch(origin + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ pack_id: pack.pack_id, target_language: 'en' }) })).status, 201);
  const auth = { Authorization: 'Bearer test-local-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(origin + '/.env', { headers: auth })).status, 404);
  const decision = await fetch(`${origin}/api/sessions/${c.session}/decisions/next`, { method: 'POST', headers: auth, body: JSON.stringify({ decision_id: 'bad', expected_revision: 0, questions: {} }) });
  assert.equal(decision.status, 400);
  const conf = await (await fetch(origin + '/api/config', { headers: auth })).text(); assert.ok(!conf.includes(c.cfg.key));
});
