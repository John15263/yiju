import { randomUUID } from 'node:crypto';
import { check, fields, text, id, oneOf, revision } from './validation.mjs';

export const sources = ['typed_original', 'voice_transcript', 'user_confirmed_text', 'user_revision', 'agent_summary', 'ai_suggestion', 'simulation'];
const meanings = ['full', 'outline', 'scene', 'none'];
const languages = ['reference', 'chunks', 'keywords', 'none'];
const now = () => new Date().toISOString();
export const snapshot = s => structuredClone({ scaffold: s.scaffold, variation: s.variation, revision: s.revision });

export class Runtime {
  constructor(store, pack, publish = () => {}) { this.store = store; this.pack = pack; this.publish = publish; }
  create(body) {
    fields(body, ['pack_id', 'target_language'], ['pack_id', 'target_language']);
    check(body.pack_id === this.pack.pack_id, 'Unknown pack');
    const language = oneOf(body.target_language, ['en', 'ja']);
    const s = {
      schema_version: '0.3', session_id: randomUUID(), revision: 0,
      pack_id: this.pack.pack_id, pack_version: this.pack.pack_version, target_language: language,
      phase: 'ready', interaction_mode: 'conversation', current_task_id: 'explain-choice', current_object_id: 'meaning-card-01',
      scaffold: { meaning_support: 'outline', language_support: 'chunks', visible_hint_ids: [], reference_visible: false },
      variation: 'none', draft: '', attempts: [], active_attempt: null, support_events: [],
      interaction: { is_user_speaking: false, user_control: null, recent_input: null, hold_conditions: false },
      client_view: { rendered_revision: null, received_at: null },
      decision: { candidate_set_version: `${language}-coffee-cues-v1`, last_decision_id: null, last_applied_revision: null },
      latest_attempt_id: null, next_entry: null, cue_changed_at: 0, commands: {}, created_at: now(), updated_at: now(),
    };
    s.support_events.push({ kind: 'initial_support', at: now(), ...snapshot(s) });
    this.store.put(s);
    return this.public(s);
  }
  public(s) { const { commands, ...rest } = s; return rest; }
  get(session) { return this.public(this.store.get(session)); }
  supportEvent(s, kind, detail = null) {
    s.support_events.push({ kind, detail, at: now(), ...snapshot(s) });
  }
  commit(s) { s.updated_at = now(); this.store.put(s); this.publish(s.session_id, this.public(s)); return this.public(s); }
  command(session, body, { publish = true } = {}) {
    fields(body, ['command_id', 'expected_revision', 'type', 'payload'], ['command_id', 'expected_revision', 'type', 'payload']);
    id(body.command_id); text(body.type, 60);
    const s = this.store.get(session);
    const fingerprint = JSON.stringify(body);
    if (Object.hasOwn(s.commands, body.command_id)) {
      check(s.commands[body.command_id].fingerprint === fingerprint, 'Command ID reused with different content', 409);
      return { state: this.public(s), applied_revision: s.commands[body.command_id].revision, duplicate: true };
    }
    revision(body.expected_revision, s.revision);
    const p = body.payload;
    const type = body.type;
    const allowedWhileParked = ['resume', 'save_draft'];
    check(s.phase !== 'parked' || allowedWhileParked.includes(type), 'Session parked: resume explicitly', 409);
    const supportBefore = JSON.stringify(s.scaffold);
    switch (type) {
      case 'resume':
        fields(p, []); s.phase = 'practising'; break;
      case 'park':
        fields(p, ['next_entry']); if (p.next_entry !== undefined) text(p.next_entry, 2000, true);
        s.phase = 'parked'; s.interaction.is_user_speaking = false; s.next_entry = p.next_entry || '从当前场景与保存的表达继续。'; break;
      case 'set_scaffold':
        fields(p, ['meaning_support', 'language_support']);
        check(Object.keys(p).length > 0, 'No scaffold change');
        check(!s.interaction.is_user_speaking, 'Wait for a natural pause', 409);
        if (p.meaning_support !== undefined) s.scaffold.meaning_support = oneOf(p.meaning_support, meanings);
        if (p.language_support !== undefined) {
          s.scaffold.language_support = oneOf(p.language_support, languages);
          s.scaffold.visible_hint_ids = [];
          s.scaffold.reference_visible = p.language_support === 'reference';
          s.interaction.user_control = p.language_support === 'none' ? 'no_hints' : null;
        }
        break;
      case 'show_hint':
        fields(p, ['hint_id', 'explicit_help'], ['hint_id']);
        if (p.explicit_help !== undefined) check(typeof p.explicit_help === 'boolean', 'Invalid explicit_help');
        check(Object.hasOwn(this.pack.tracks[s.target_language].cues, p.hint_id), 'Unregistered cue');
        check(!s.interaction.is_user_speaking || p.explicit_help === true || s.interaction.user_control === 'help', 'No interruption while speaking', 409);
        check(s.interaction.user_control !== 'no_hints' || p.explicit_help === true, 'User requested no hints', 409);
        s.scaffold.language_support = 'chunks'; s.scaffold.reference_visible = false;
        s.scaffold.visible_hint_ids = [p.hint_id];
        if (p.explicit_help) s.interaction.user_control = 'help';
        break;
      case 'hide_hint':
        fields(p, []); check(!s.interaction.is_user_speaking, 'Wait for a natural pause', 409);
        s.scaffold.visible_hint_ids = []; s.scaffold.language_support = 'none'; s.scaffold.reference_visible = false; break;
      case 'apply_variant':
        fields(p, ['variant_id'], ['variant_id']);
        check(Object.hasOwn(this.pack.variants, p.variant_id), 'Unknown variant');
        check(!s.interaction.is_user_speaking, 'Wait for a natural pause', 409);
        s.variation = p.variant_id; break;
      case 'hold_conditions':
        fields(p, ['enabled'], ['enabled']); check(typeof p.enabled === 'boolean', 'Invalid enabled');
        s.interaction.hold_conditions = p.enabled; break;
      case 'set_mode':
        fields(p, ['mode'], ['mode']); s.interaction_mode = oneOf(p.mode, ['conversation', 'absorption', 'regenerate', 'adapt']); break;
      case 'set_task':
        fields(p, ['task_id'], ['task_id']); oneOf(p.task_id, ['explain-choice']); s.current_task_id = p.task_id; break;
      case 'save_draft':
        fields(p, ['text'], ['text']); s.draft = text(p.text, 20000, true); break;
      case 'begin_attempt':
        fields(p, []); check(!s.active_attempt, 'An attempt is already active', 409);
        s.active_attempt = { started_at: now(), start_revision: s.revision, support_event_start: s.support_events.length, initial_support: snapshot(s) };
        s.interaction.is_user_speaking = true; s.interaction.user_control = null; break;
      case 'set_interaction':
        fields(p, ['is_user_speaking', 'user_control', 'recent_input']);
        if (p.is_user_speaking !== undefined) {
          check(typeof p.is_user_speaking === 'boolean', 'Invalid speaking flag'); s.interaction.is_user_speaking = p.is_user_speaking;
        }
        if (p.user_control !== undefined) s.interaction.user_control = oneOf(p.user_control, [null, 'help', 'no_hints', 'keep', 'pause']);
        if (p.recent_input !== undefined) {
          fields(p.recent_input, ['text', 'source'], ['text', 'source']);
          text(p.recent_input.text, 2000); oneOf(p.recent_input.source, ['typed_original', 'voice_transcript', 'control', 'simulation']);
          s.interaction.recent_input = { ...p.recent_input, at: now() };
        }
        break;
      case 'record_spoken_support':
        fields(p, ['text'], ['text']); text(p.text, 2000);
        this.supportEvent(s, 'spoken_support', { text: p.text, source: 'agent_report' }); break;
      default: check(false, 'Unknown command');
    }
    s.revision++;
    if (supportBefore !== JSON.stringify(s.scaffold)) {
      s.cue_changed_at = Date.now(); this.supportEvent(s, type);
    }
    s.commands[body.command_id] = { fingerprint, revision: s.revision };
    if (publish) this.commit(s); else { s.updated_at = now(); this.store.put(s); }
    return { state: this.public(s), applied_revision: s.revision, duplicate: false };
  }
  attempt(session, body) {
    fields(body, ['attempt_id', 'expected_revision', 'text', 'source', 'user_confirmed', 'parent_attempt_id'], ['attempt_id', 'expected_revision', 'text', 'source', 'user_confirmed']);
    id(body.attempt_id); text(body.text, 20000); oneOf(body.source, sources);
    check(typeof body.user_confirmed === 'boolean', 'Invalid confirmation');
    const s = this.store.get(session);
    const previous = s.attempts.find(a => a.attempt_id === body.attempt_id);
    if (previous) {
      check(previous.request_fingerprint === JSON.stringify(body), 'Attempt ID reused', 409);
      return { state: this.public(s), duplicate: true };
    }
    revision(body.expected_revision, s.revision);
    if (body.parent_attempt_id !== undefined && body.parent_attempt_id !== null) {
      check(s.attempts.some(a => a.attempt_id === body.parent_attempt_id), 'Unknown parent attempt');
    }
    const active = s.active_attempt;
    const attempt = {
      ...body, request_fingerprint: JSON.stringify(body), target_language: s.target_language,
      pack_id: s.pack_id, pack_version: s.pack_version, task_id: s.current_task_id,
      at: now(), started_at: active?.started_at || null,
      evidence_scope: active ? 'explicit_attempt_window' : 'conservative_session_history',
      initial_support: active?.initial_support || null,
      support_events: s.support_events.slice(active?.support_event_start ?? 0), final_support: snapshot(s),
    };
    s.attempts.push(attempt); s.latest_attempt_id = body.attempt_id; s.active_attempt = null;
    s.interaction.is_user_speaking = false; s.draft = ''; s.revision++;
    return { state: this.commit(s), duplicate: false };
  }
  ack(session, body) {
    fields(body, ['rendered_revision'], ['rendered_revision']);
    const s = this.store.get(session);
    check(Number.isInteger(body.rendered_revision) && body.rendered_revision >= 0 && body.rendered_revision <= s.revision, 'Invalid rendered_revision');
    const ack = { rendered_revision: body.rendered_revision, received_at: now(),
      save_to_ack_ms: body.rendered_revision === s.revision ? Math.max(0, Date.now() - Date.parse(s.updated_at)) : null };
    this.store.saveViewAck(session, ack);
    if (body.rendered_revision > (s.client_view.rendered_revision ?? -1)) {
      s.client_view = this.store.viewAck(session, body.rendered_revision);
      this.store.put(s);
    }
    return s.client_view;
  }
  brief(session) {
    const s = this.store.get(session), p = this.pack;
    return { session_id: session, target_language: s.target_language, scene: p.scene, partner: p.role_brief,
      communicative_goal: p.communicative_goal, confirmed_meaning: p.meaning_source.outline,
      forbidden_inferences: p.forbidden_inferences, opening: p.tracks[s.target_language].opening,
      current_state: this.public(s), note: 'References are AI teaching adaptations. Hidden references must not be spoken before an independent attempt.' };
  }
  export(session) {
    const s = this.store.get(session);
    const lines = [`# ${this.pack.title} · ${s.target_language}`, '', `会话：${session}`, `状态：${s.phase} · revision ${s.revision}`, '', '## 原始意义（教学整理，非逐字转写）', this.pack.meaning_source.text, '', '## 记录'];
    for (const a of s.attempts) {
      lines.push('', `### ${a.at} · ${a.source}`, `用户确认：${a.user_confirmed ? '是' : '否'} · 证据范围：${a.evidence_scope}`, '', ...a.text.split('\n').map(l => `> ${l}`), '', '支持记录：', '```json', JSON.stringify({ initial: a.initial_support, events: a.support_events, final: a.final_support }, null, 2), '```');
    }
    lines.push('', '## 下次入口', s.next_entry || '尚未填写', '', '提示与范文不作为用户产物；记录不证明长期掌握。');
    return lines.join('\n');
  }
}
