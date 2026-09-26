import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { SentenceBoard } from '../server/sentence.mjs';
import { Cloze, clozeQuestion } from '../server/cloze.mjs';
import { config } from '../server/config.mjs';

const material = { meaning:'保持克制，避免无谓的争斗。', language:'en', reference:'Show restraint and avoid needless conflict.', keywords:['restraint'], frame:'Show ___ and avoid ___ conflict.', explanation:'restraint 是名词。', origin:'demo' };
const blanks = {segments:['Show ',{id:'restraint',answers:['restraint','self-control'],role:'Noun meaning self-control after show.',hints:['克制自己','这里需要名词','参考词以 r 开头']},' and avoid ',{id:'needless',answers:['needless','unnecessary'],role:'Adjective describing conflict that serves no purpose.',hints:['无谓的','这里需要形容词','参考词以 n 开头']},' conflict.']};
const response = (choice='accepted',confidence=.95) => ({model:'test-jev',answers:{next_cue:{type:'choice',choice,confidence,probabilities:Object.fromEntries(Object.keys(clozeQuestion.criteria).map(k=>[k,k===choice?.96:.01]))}}});
function setup(t,infer=async()=>response(),key='test') {
 const store=new Store(':memory:'); t.after(()=>store.close()); const board=new SentenceBoard(store);
 const cmd=(type,payload={})=>board.command({command_id:randomUUID(),expected_revision:board.get().revision,type,payload});
 cmd('new',material);cmd('prepare_cloze',blanks);cmd('start_cloze');
 const cloze=new Cloze(board,{...config({}),key},infer);
 const args=(slot_id='restraint')=>({round_id:board.get().active.id,slot_id});
 const edit=(value,slot='restraint')=>cloze.input({...args(slot),text:value,edit_id:randomUUID(),expected_version:board.get().active.cloze.inputs[slot].version});
 const checkSlot=(slot='restraint',extra={})=>cloze.check({...args(slot),expected_version:board.get().active.cloze.inputs[slot].version,check_id:randomUUID(),...extra});
 return {store,board,cmd,cloze,args,edit,checkSlot};
}
test('known words and registered alternatives pass locally without Jev, incomplete input is only saved',async t=>{
 let calls=0;const c=setup(t,async()=>{calls++;return response();});
 c.edit('res');assert.equal(c.board.get().active.cloze.inputs.restraint.result,null);assert.equal(calls,0);
 c.edit('  RESTRAINT ');assert.equal((await c.checkSlot()).result.source,'local');
 c.edit('unnecessary','needless');assert.equal((await c.checkSlot('needless')).result.verdict,'accepted');assert.equal(calls,0);
});
test('Jev evaluates unknown alternatives with fixed sentence context and deduplicates repeated checks',async t=>{
 let calls=0,packet;const c=setup(t,async p=>{calls++;packet=p;return response();});
 c.edit('composure');const r=await c.checkSlot();await c.checkSlot();
 assert.equal(calls,1);assert.equal(r.result.verdict,'accepted');assert.equal(packet.candidate_sentence,'Show composure and avoid needless conflict.');
 assert.equal(packet.intended_meaning,material.meaning);assert.equal(packet.candidate_text,'composure');
});
test('concurrent identical check coalesces and delayed result cannot overwrite revised text',async t=>{
 let resolve,calls=0;const c=setup(t,()=>{calls++;return new Promise(r=>resolve=r);});
 c.edit('restaint');const a=c.checkSlot(),b=c.checkSlot();assert.equal(calls,1);
 c.edit('restraint');await c.checkSlot();resolve(response('spelling'));const old=await a;await b;
 assert.equal(old.stale,true);const input=c.board.get().active.cloze.inputs.restraint;
 assert.equal(input.text,'restraint');assert.equal(input.result.verdict,'accepted');assert.equal(input.result.source,'local');assert.equal(input.checks.length,2);
});
test('late Jev result after pause is recorded but cannot modify active feedback',async t=>{
 let resolve;const c=setup(t,()=>new Promise(r=>resolve=r));c.edit('restaint');const p=c.checkSlot();c.cmd('pause');resolve(response('spelling'));
 assert.equal((await p).stale,true);assert.equal(c.board.get().active.stage,'paused');assert.equal(c.board.get().active.cloze.inputs.restraint.result,null);
 assert.throws(()=>c.edit('something'),/暂停/);
});
test('uncertain, malformed, failed and missing-key judgments stay neutral; retries must be explicit',async t=>{
 let calls=0;const c=setup(t,async()=>{calls++;return response('meaning',.3);});c.edit('other');
 assert.equal((await c.checkSlot()).result.verdict,'review');await c.checkSlot();assert.equal(calls,1);
 await c.checkSlot('restraint',{retry:true});assert.equal(calls,2);
 const bad=setup(t,async()=>({answers:{next_cue:{choice:'accepted'}}}));bad.edit('x');assert.equal((await bad.checkSlot()).result.verdict,'review');
 const failed=setup(t,async()=>{throw new Error('provider unavailable');});failed.edit('x');assert.equal((await failed.checkSlot()).result.verdict,'review');
 const noKey=setup(t,async()=>{assert.fail('must not call provider');},'');noKey.edit('x');assert.equal((await noKey.checkSlot()).result.verdict,'review');
});
test('stale drafts cannot erase another edit; hints remain in evidence after hiding; submit preserves learner text',async t=>{
 const c=setup(t);c.edit('restraint');
 assert.throws(()=>c.cloze.input({...c.args(),text:'overwrite',expected_version:0,edit_id:'stale'}),/Revision conflict/);
 c.cloze.hint({...c.args(),level:4});c.cloze.hint({...c.args(),level:0});
 assert.throws(()=>c.cmd('cloze_submit'),/填完/);c.edit('pointless','needless');c.cmd('cloze_submit',{source:'simulation'});
 const a=c.board.get().active.attempts[0];assert.equal(a.text,'Show restraint and avoid pointless conflict.');assert.equal(a.source,'simulation');assert.equal(a.evidence_scope,'prompted_cloze');
 assert.ok(a.support_events.some(e=>e.kind==='cloze_hint'&&e.detail.hint_level===4));assert.equal(a.cloze.inputs.needless.result,null);
 assert.equal(c.board.get().active.stage,'awaiting_feedback');
});
test('invalid preparation is rejected and service restart does not replay pending API calls',async t=>{
 const c=setup(t);assert.throws(()=>c.cmd('prepare_cloze',blanks),/already/);
 c.cmd('new',material);assert.throws(()=>c.cmd('prepare_cloze',{segments:['Different ',blanks.segments[1]]}),/reconstruct/);
 c.cmd('prepare_cloze',blanks);c.cmd('start_cloze');c.edit('restaint');
 const s=c.board.read(),r=s.rounds.find(r=>r.id===s.active_id),input=r.cloze.inputs.restraint;
 input.checks.push({check_id:'interrupted',verdict:'checking',version:input.version,text:input.text});input.result=input.checks[0];c.board.save(s);
 new Cloze(c.board,config({}),()=>assert.fail('must not replay'));
 assert.equal(c.board.get().active.cloze.inputs.restraint.result.verdict,'review');
});
