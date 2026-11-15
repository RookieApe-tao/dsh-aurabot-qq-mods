import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MemoryRuntime,boundMessages,expressionInstruction} from '../lib/runtime.mjs'
import {fixture,serviceFixture,enable} from './helpers.mjs'

test('request compaction archives complete turns and never splits a tool exchange',()=>{
  const messages=[{id:'old',role:'user',content:'a'.repeat(500)},{id:'old-a',role:'assistant',content:'answer'},
    {id:'now',role:'user',content:'now'},{id:'call',role:'assistant',content:[{type:'tool-call',id:'x'}]},{id:'result',role:'tool',content:[{type:'tool-result',id:'x'}]}]
  const saved=[];const r=boundMessages(messages,400,m=>saved.push(m.id))
  assert.deepEqual(saved,['old','old-a']);assert.deepEqual(r.messages.map(m=>m.id),['now','call','result'])
  assert.equal(boundMessages(messages,20,()=>{}).oversizedCurrent,true)
  assert.throws(()=>boundMessages(messages,400,()=>{throw new Error('disk full')}),/disk full/)
})
test('actual request middleware bounds history, removes foreign tools and records each call',async t=>{
  const f=serviceFixture(t);await enable(f.service);const runtime=new MemoryRuntime(f.service)
  const scope=f.service.scope({persona:'alice',audience:'private',subject:'user1'});runtime.attach('s1',{chatId:'private:user1'},scope)
  const options={sessionId:'s1',system:'persona instructions',messages:[{id:'old',role:'user',content:'old '.repeat(6000)},{id:'new',role:'user',content:[{type:'text',text:'今天好呀'}]}],tools:[{name:'memory_save'},{name:'qq_draw_image'},{name:'persona_memory_recall'}],maxTokens:3000}
  const next=async function*(){assert.equal(options.messages.length,1);assert.match(options.system,/persona instructions/);assert.equal(options.maxTokens,3000);assert.deepEqual(options.tools.map(t=>t.name),['qq_draw_image','persona_memory_recall']);yield {type:'usage',usage:{inputTokens:300,outputTokens:10}}}
  for await(const _ of runtime.stream(options,next)){}
  assert.equal(f.service.store.usage(undefined,'chat').attempts,1)
  assert.equal(f.service.store.usage().attempts,0,'chat requests must not consume extraction quota')
  assert.equal(f.service.store.events(scope)[0].kind,'protocol')
})
test('reset during an actual request invalidates subsequent chunks',async t=>{
  const f=serviceFixture(t);await enable(f.service);const runtime=new MemoryRuntime(f.service)
  const scope=f.service.scope({persona:'alice',audience:'private',subject:'user1'});runtime.attach('s',{chatId:'private:user1'},scope)
  const options={sessionId:'s',messages:[{id:'u',role:'user',content:'你好'}]}
  const next=async function*(){const p=await f.service.previewReset({scopeKey:scope.key});await f.service.reset(p.token);yield {type:'text-delta',text:'stale'}}
  await assert.rejects(async()=>{for await(const _ of runtime.stream(options,next)){}},/代际|失效|范围已变化/)
  assert.equal(f.service.store.db.prepare("SELECT state FROM usage WHERE category='chat'").get().state,'unknown')
})
test('incremental scheduling ignores AI echoes, same user repetitions and already submitted batches',async t=>{
  const f=serviceFixture(t);await enable(f.service);const r=new MemoryRuntime(f.service),chat={kind:'private',chatId:'private:user1',userId:'user1'}
  for(let i=0;i<12;i++)r.capture(chat,'alice',{sourceId:'u'+i,role:'user',actor:'user1',at:f.service.now(),text:'我喜欢茶'})
  for(let i=0;i<10;i++)r.capture(chat,'alice',{sourceId:'a'+i,role:'assistant',actor:'self',at:f.service.now(),text:'我喜欢咖啡',delivery:'sent'})
  assert.equal(r.schedule().queued,1);assert.equal(r.schedule({force:true}).queued,0)
  const job=f.service.store.db.prepare('SELECT payload FROM jobs').get();assert.equal(JSON.parse(job.payload).sources.length,1)
})
test('recall expression is selectable without turning missing evidence into fabricated history',()=>{
  assert.match(expressionInstruction('persona'),/按当前人设/);assert.match(expressionInstruction('direct'),/没有找到可靠记录/)
  assert.match(expressionInstruction('persona','unavailable'),/不能补造/)
})
