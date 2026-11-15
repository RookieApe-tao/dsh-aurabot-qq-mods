import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { MemoryWorker } from '../lib/worker.mjs'
import { ResetCoordinator } from '../lib/reset.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { MemoryService } from '../lib/service.mjs'
import definition from '../index.mjs'
import { fixture, serviceFixture, fakeBridge, enable } from './helpers.mjs'

test('never-enabled construction, status and normal settings save have no business effects',t=>{
 const f=serviceFixture(t)
 assert.equal(existsSync(f.file),false)
 assert.equal(f.service.state().lifecycle.state,'never');assert.equal(existsSync(f.file),false)
 f.service.save({expression:'direct'});assert.equal(f.config.enabled,false);assert.equal(existsSync(f.file),false)
 assert.equal(f.bridge.calls.length,0)
 assert.throws(()=>f.service.save({enabled:true}),/保存设置不会启用/)
 assert.throws(()=>f.service.scope({persona:'a',audience:'private',subject:'b'}),/尚未启用/)
})
test('incomplete host cannot enable; config alone never takes over legacy memory',async t=>{
 const f=serviceFixture(t,{bridge:{api:1,capabilities:[]}})
 await assert.rejects(f.service.prepareActivation(),/宿主接管适配/)
 assert.equal(existsSync(f.file),false)
 const s=new MemoryService({file:f.file,readSettings:()=>({...f.config,enabled:true}),bridge:fakeBridge()})
 assert.equal((await s.resume()).status,'disabled');assert.equal(s.active(),false);s.dispose()
})
test('activation requires verified single provider; pause fences writes and resumes by explicit preview',async t=>{
 const f=serviceFixture(t);await enable(f.service)
 assert.equal(f.service.active(),true);const first=f.service.generation()
 const scope=f.service.scope({persona:'alice',audience:'private',subject:'user1'})
 await f.service.pause();assert.equal(f.service.active(),false);assert.ok(f.service.generation()>first)
 assert.equal(f.service.state().lifecycle.state,'paused');assert.equal(f.config.enabled,false)
 assert.throws(()=>f.service.ingest(scope,{}),/尚未启用/)
 await enable(f.service);assert.equal(f.service.active(),true)
 assert.throws(()=>f.service.ingest(scope,{sourceId:'late',role:'user',actor:'user1',at:1794614400000,text:'来自停用前的结果'}),/旧运行实例/)
 assert.deepEqual(f.bridge.calls.map(c=>c[0]),['prepare','activate','pause','prepare','activate'])
})
test('partial activation and uncleared prompt remain visible recovery states',async t=>{
 const f=serviceFixture(t,{bridge:fakeBridge({activate:async()=>({verified:false})})})
 const p=await f.service.prepareActivation();await assert.rejects(f.service.activate(p.token),/未确认/)
 assert.equal(f.service.lifecycle().state,'recovery');assert.equal(f.config.enabled,false)
 const g=serviceFixture(t);await enable(g.service);g.bridge.pause=async()=>({verified:true,contextCleared:false})
 await assert.rejects(g.service.pause(),/未撤下/);assert.equal(g.service.lifecycle().state,'pausing');assert.equal(g.service.active(),false)
})
test('an unsupported host only exposes compatibility status and does not resolve the data path',async t=>{
 const f=serviceFixture(t),routes=[]
 const api={dataDir:()=>assert.fail('unsupported host opened data path'),settings:()=>f.config,saveSettings:()=>{},core:{http:{}},route:(path,fn,opts)=>routes.push({path,fn,opts}),log:{warn(){}},
   on:()=>assert.fail('inactive event hook'),context:()=>assert.fail('inactive context'),tool:()=>assert.fail('inactive tool'),every:()=>assert.fail('inactive timer')}
 const loaded=definition.setup(api)
 assert.deepEqual(routes.map(r=>r.path),['/state'])
 assert.equal(routes[0].opts.access,'panel')
 assert.equal((await routes[0].fn()).capabilities.ready,false)
 assert.equal(existsSync(f.file),false);loaded.dispose()
})
test('budget is persistent, failed/unknown attempts consume it, frontend and backend share it',t=>{
 const f=fixture(t),limits={...f.config,extraAttempts:2}
 f.store.reserveUsage({id:'one',category:'context-foreground',inputTokens:100,outputTokens:30,limits})
 f.store.settleUsage('one','failed')
 f.store.reserveUsage({id:'two',category:'day-background',inputTokens:80,outputTokens:40,limits})
 f.store.settleUsage('two','unknown')
 assert.throws(()=>f.store.reserveUsage({id:'three',category:'retry',inputTokens:1,outputTokens:1,limits}),/额度不足/)
 f.store.close();const db=new MemoryStore(f.file,{now:f.now})
 assert.equal(db.usage().attempts,2);assert.equal(db.usage().inputTokens,180);assert.equal(db.usage().outputTokens,70)
 assert.throws(()=>db.reserveUsage({id:'one',category:'retry',inputTokens:1,outputTokens:1,limits}),/重复提交/);db.close()
})
test('recorded actual usage over a reservation never lowers future budget accounting',t=>{
 const f=fixture(t)
 f.store.reserveUsage({id:'one',category:'summary',inputTokens:100,outputTokens:30,limits:f.config})
 f.store.settleUsage('one','complete',{inputTokens:120,outputTokens:60})
 assert.equal(f.store.usage().inputTokens,120);assert.equal(f.store.usage().outputTokens,60)
 assert.equal(f.store.settleUsage('one','failed'),false)
})
test('unchanged sources yield one job; legitimate empty output is final, not retried',async t=>{
 const f=fixture(t),e=f.event(),sources=[{id:e.id,quote:e.body}],args={kind:'day',sources,generation:1}
 assert.equal(f.store.enqueue(f.scope,args).id,f.store.enqueue(f.scope,args).id)
 let calls=0
 const w=new MemoryWorker(f.store,{getSettings:()=>f.config,getGeneration:()=>1,active:()=>true,model:async()=>{calls++;return {output:{records:[]}}}})
 assert.equal((await w.runOne()).status,'empty');assert.equal((await w.runOne()).status,'idle');assert.equal(calls,1)
})
test('invalid mixed model output rolls back all records, billed request remains counted',async t=>{
 const f=fixture(t),e=f.event(),sources=[{id:e.id,quote:e.body}]
 f.store.enqueue(f.scope,{kind:'day',sources,generation:1})
 const w=new MemoryWorker(f.store,{getSettings:()=>f.config,getGeneration:()=>1,active:()=>true,model:async()=>({output:{records:[
  {kind:'fact',subject:'user1',attribute:'饮品',value:'咖啡',text:e.body,sources},
  {kind:'fact',subject:'user1',attribute:'饮品',value:'红茶',text:'喜欢红茶',sources}
 ]}})})
 assert.equal((await w.runOne()).status,'failed');assert.equal(f.store.records(f.scope).length,0);assert.equal(f.store.usage().attempts,1)
})
test('reset while a model request is in flight cannot repopulate new epoch',async t=>{
 const f=fixture(t),e=f.event(),sources=[{id:e.id,quote:e.body}]
 f.store.enqueue(f.scope,{kind:'day',sources,generation:1})
 let finish,started
 const seen=new Promise(r=>{started=r}),response=new Promise(r=>{finish=r})
 const w=new MemoryWorker(f.store,{getSettings:()=>f.config,getGeneration:()=>1,active:()=>true,model:async()=>{started();return response}})
 const task=w.runOne();await seen
 const reset=new ResetCoordinator(f.store,{now:f.now}),p=await reset.preview({scopeKey:f.scope.key})
 assert.equal((await reset.execute(p.token)).status,'complete')
 finish({output:{records:[{kind:'fact',subject:'user1',attribute:'饮品',value:'咖啡',text:e.body,sources}]}})
 assert.equal((await task).status,'stale');assert.equal(f.store.records(f.store.getScope(f.scope.key)).length,0);assert.equal(f.store.usage().attempts,1)
})
test('correction fences an in-flight extraction so old evidence cannot restore the prior value',async t=>{
 const f=fixture(t),e=f.event('我喜欢咖啡'),old=f.record(e),sources=[{id:e.id,quote:e.body}]
 f.store.enqueue(f.scope,{kind:'day',sources,generation:1})
 let finish,started;const seen=new Promise(r=>{started=r}),response=new Promise(r=>{finish=r})
 const w=new MemoryWorker(f.store,{getSettings:()=>f.config,getGeneration:()=>1,active:()=>true,model:async()=>{started();return response}})
 const pending=w.runOne();await seen;f.advance(1000)
 const fresh=f.event('现在喜欢红茶')
 f.store.revise(f.scope,old.id,{expectedRevision:1,value:'红茶',text:fresh.body,sources:[{id:fresh.id,quote:fresh.body}]})
 finish({output:{records:[{kind:'fact',subject:'user1',attribute:'饮品偏好',value:'咖啡',text:e.body,sources}]}})
 assert.equal((await pending).status,'stale');assert.deepEqual(f.store.records(f.scope).map(r=>r.value),['红茶'])
})
test('cross-process worker lease prevents two simultaneous model requests',async t=>{
 const f=fixture(t),e=f.event(),sources=[{id:e.id,quote:e.body}]
 f.store.enqueue(f.scope,{kind:'day',sources,generation:1})
 f.store.enqueue(f.scope,{kind:'month',sources,generation:1})
 const second=new MemoryStore(f.file,{now:f.now})
 try {
  const first=f.store.claimJob('first');assert.ok(first)
  assert.equal(second.claimJob('second'),null);f.store.releaseWorker('first')
  const next=second.claimJob('second');assert.ok(next);assert.equal(f.store.job(first.id).status,'unknown')
 } finally {second.close()}
})
