import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Settings, testServices } from '../server/settings.mjs';
import { config } from '../server/config.mjs';
import { Anki } from '../server/anki.mjs';

test('the settings page may move AnkiConnect to another port on this computer, and pushing follows at once', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  // As the runners do it: one shared settings object, changed in place when the page saves.
  const settings = new Settings(), base = { ANKI_CONNECT_URL: 'http://127.0.0.1:8765', ANKI_PUSH: 'on' };
  const cfg = config(settings.env(base));
  const asked = [];
  const anki = new Anki(store, cfg, async url => { asked.push(url); return { json: async () => ({ result: [], error: null }) }; });
  assert.equal(settings.view(cfg).anki_url, 'http://127.0.0.1:8765', 'the page is shown where cards go now');

  for (const bad of ['http://192.168.1.5:8765', 'https://example.com', 'http://127.0.0.1:8765/api', 'file:///tmp/x', 'http://localhost.example.com:8765']) {
    assert.throws(() => settings.patch({ ANKI_CONNECT_URL: bad }), /这台电脑上/, bad);
  }
  const values = settings.patch({ ANKI_CONNECT_URL: ' http://127.0.0.1:8766 ' });
  settings.save(values);
  Object.assign(cfg, config(settings.env(base, values)));
  assert.equal(settings.view(cfg).anki_url, 'http://127.0.0.1:8766');
  anki.enqueue({ text: 'I enjoy {{c1::cooking}},', extra: '', tags: [], quiz_id: 'q1' });
  await anki.flush();
  assert.ok(asked.length && asked.every(url => url === 'http://127.0.0.1:8766'), 'the new address, without a restart');
  assert.equal(anki.status().url, 'http://127.0.0.1:8766');

  // Left empty, the page's address is dropped and the runner's default counts again.
  const cleared = settings.patch({ ANKI_CONNECT_URL: '' });
  assert.equal('ANKI_CONNECT_URL' in cleared, false);
  assert.equal(config(settings.env(base, cleared)).ankiUrl, 'http://127.0.0.1:8765');
  assert.equal(settings.patch({ ANKI_CONNECT_URL: 'http://localhost:8765/' }).ANKI_CONNECT_URL, 'http://localhost:8765/');
});

test('with Anki on, saving the settings asks Anki to trust this page; until it does, cards wait', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  // AnkiConnect as it behaves: 403 with no body to a page it does not trust; requestPermission answered by the learner.
  let trusted = false, answer = 'granted';
  const request = async (url, options) => {
    const { action } = JSON.parse(options.body);
    if (action === 'requestPermission') { trusted = answer === 'granted'; return { status: 200, json: async () => ({ result: { permission: answer }, error: null }) }; }
    if (!trusted) return { status: 403, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
    return { status: 200, json: async () => ({ result: action === 'modelNames' ? [] : 1, error: null }) };
  };
  const cfg = config({ ANKI_PUSH: 'on', VOICE_PROVIDER: 'none', SPEECH_PROVIDER: 'browser' });
  cfg.anki = new Anki(store, cfg, request);
  cfg.anki.enqueue({ text: 'I enjoy {{c1::cooking}},', extra: '', tags: [], quiz_id: 'q1' });
  await cfg.anki.flush();
  assert.equal(cfg.anki.status().pending, 1, 'kept for later, not failed');
  assert.match(cfg.anki.status().last_error, /还没允许.*点「是」/, 'says what to do, not that Anki is closed');

  const noNetwork = async () => assert.fail('no provider is asked here');
  assert.deepEqual((await testServices(cfg, { request: noNetwork })).anki, { ok: true });
  await cfg.anki.flush();
  assert.equal(cfg.anki.status().sent, 1); assert.equal(cfg.anki.status().last_error, '');

  answer = 'denied';
  assert.deepEqual(await cfg.anki.permission(), { ok: false, message: 'Anki 里没有允许：要在它弹出的窗口里点「是」' });
  const closed = new Anki(store, cfg, async () => { throw new TypeError('fetch failed'); });
  assert.match((await closed.permission()).message, /连不上 Anki（http:\/\/127\.0\.0\.1:8765）.*打开 Anki 后自动推送/);
  cfg.ankiPush = false;
  assert.equal('anki' in await testServices(cfg, { request: noNetwork }), false, 'no Anki line when cards do not go there');
});
