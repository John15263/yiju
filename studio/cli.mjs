import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, root } from './server/config.mjs';

const cfg = config();
const [action = 'help', session, type, payload] = process.argv.slice(2);
const origin = `http://127.0.0.1:${cfg.port}`;
async function request(path, body) {
  const token = readFileSync(join(root, 'studio/data/.local-token'), 'utf8').trim();
  const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = response.headers.get('content-type')?.startsWith('text/markdown') ? await response.text() : await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const base = `/api/sessions/${encodeURIComponent(session || '')}`;
try {
  let result;
  switch (action) {
    case 'sentence': {
      const state = await request('/api/sentence');
      if (!session || session === 'state') { result = state; break; }
      if (session === 'brief') {
        const r = state.active;
        result = { revision: state.revision, rendered_revision: state.client_view?.rendered_revision,
          collection: state.collection ? { id: state.collection.id, outline: state.collection.outline,
            active_index: state.collection.active_index,
            units: state.collection.units.map(({ id, index, meaning, role, purpose, connection }) => ({ id, index, meaning, role, purpose, connection })) } : null,
          active: r ? {
          id: r.id, stage: r.stage, language: r.language, meaning: r.meaning, reference: r.reference,
          support_level: r.support_level, focused_slot: r.cloze?.focused_slot || null,
          phrases: r.phrases ? { status: r.phrases.status, index: r.phrases.index, step: r.phrases.step || 'write', count: r.phrases.items?.length,
            current: r.phrases.items?.[r.phrases.index], submitted: r.phrases.inputs?.[r.phrases.index] } : null,
          blanks: r.cloze?.segments.filter(p => typeof p !== 'string').map(p => ({ id: p.id, answers: p.answers,
            input: r.cloze.inputs[p.id].text, hint_level: r.cloze.inputs[p.id].hint_level, result: r.cloze.inputs[p.id].result })),
          latest_attempt: r.attempts.at(-1) ? { id: r.attempts.at(-1).id, text: r.attempts.at(-1).text, source: r.attempts.at(-1).source, evidence_scope: r.attempts.at(-1).evidence_scope } : null,
        } : null }; break;
      }
      if (session === 'list') { result = state.history; break; }
      if (!['new', 'command'].includes(session)) throw new Error('Use sentence state | list | new FILE.json | command FILE.json');
      const content = JSON.parse(readFileSync(type, 'utf8'));
      if (session === 'command' && !Number.isInteger(content.expected_revision)) throw new Error('Include expected_revision from sentence state; do not apply a command to an unseen state.');
      result = await request('/api/sentence/commands', {
        command_id: content.command_id || randomUUID(), expected_revision: content.expected_revision ?? state.revision,
        type: session === 'new' ? 'new' : content.type,
        payload: session === 'new' ? content : content.payload || {},
      }); break;
    }
    case 'list': result = await request('/api/sessions'); break;
    case 'new': result = await request('/api/sessions', { pack_id: 'coffee-tea-sleep', target_language: session || 'en' }); break;
    case 'state': result = await request(base); break;
    case 'brief': result = await request(base + '/brief'); break;
    case 'export': result = await request(base + '/export'); break;
    case 'traces': result = await request(base + '/decisions'); break;
    case 'command': {
      const state = await request(base);
      result = await request(base + '/commands', { command_id: randomUUID(), expected_revision: state.revision, type, payload: JSON.parse(payload || '{}') }); break;
    }
    case 'decide': {
      const state = await request(base);
      result = await request(base + '/decisions/next', { decision_id: randomUUID(), expected_revision: state.revision }); break;
    }
    case 'attempt': {
      const state = await request(base);
      // JSON body from a UTF-8 file avoids shell quoting of the user's content.
      const content = JSON.parse(readFileSync(type, 'utf8'));
      result = await request(base + '/attempts', { ...content, attempt_id: randomUUID(), expected_revision: state.revision }); break;
    }
    default:
      console.log('npm run studio -- sentence state | list | new /absolute/sentence.json | command /absolute/command.json');
      console.log('npm run studio -- list | new en|ja | state ID | brief ID | export ID | traces ID\nnpm run studio -- command ID TYPE \'{"key":"value"}\'\nnpm run studio -- decide ID\nnpm run studio -- attempt ID /absolute/path/to/attempt.json'); process.exit(0);
  }
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
