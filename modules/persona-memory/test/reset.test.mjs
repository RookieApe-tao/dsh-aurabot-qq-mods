import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResetCoordinator } from '../lib/reset.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { fixture } from './helpers.mjs'

test('reset deletes pinned and derived interaction data, preserves budgets and other personas',async t=>{
 const f=fixture(t),e=f.event(),r=f.record(e,{pinned:true})
 const other=f.store.scope({persona:'bob',audience:'private',subject:'user1'})
 f.store.ingest(other,{sourceId:'other',role:'user',actor:'user1',at:f.now(),text:'别人的资料'})
 f.store.reserveUsage({id:'request1',category:'summary',inputTokens:50,outputTokens:20,limits:f.config})
 f.store.setMeta('native-extra:'+f.scope.key+':0',{state:{shortTerm:{text:'必须被清除的旧原生正文'}}})
 f.store.setMeta('native-extra:'+other.key+':0',{state:{shortTerm:{text:'另一个人格'}}})
 const reset=new ResetCoordinator(f.store,{now:f.now}),preview=await reset.preview({scopeKey:f.scope.key})
 const result=await reset.execute(preview.token)
 assert.equal(result.status,'complete');assert.equal(f.store.record(r.id),null)
 assert.equal(f.store.events(f.store.getScope(f.scope.key)).length,0);assert.equal(f.store.events(other).length,1)
 assert.equal(f.store.usage().attempts,1)
 assert.equal(f.store.meta('native-extra:'+f.scope.key+':0'),null)
 assert.ok(f.store.meta('native-extra:'+other.key+':0'))
 assert.throws(()=>f.store.putRecord(f.scope,{kind:'fact'}),/范围已变化/)
 assert.throws(()=>f.store.ingest(f.store.getScope(f.scope.key),{sourceId:'replay',role:'user',actor:'user1',text:e.body,at:e.at}),/重新开始边界/)
 assert.equal((await reset.execute(preview.token)).duplicate,true)
})
test('a reset preview does not silently authorize data arriving after preview',async t=>{
 const f=fixture(t);f.record(f.event())
 const reset=new ResetCoordinator(f.store,{now:f.now}),p=await reset.preview({persona:'alice'})
 f.event('新消息');await assert.rejects(reset.execute(p.token),/已变化/)
 assert.equal(f.store.getScope(f.scope.key).epoch,0)
})
test('failed external reset stays blocked across restart and resumes idempotently',async t=>{
 const f=fixture(t);f.record(f.event());let attempts=0
 const participant={id:'host',version:1,preview:async()=>({supported:true}),clear:async()=>({verified:++attempts>1})}
 const reset=new ResetCoordinator(f.store,{participants:[participant],now:f.now}),p=await reset.preview({scopeKey:f.scope.key})
 const result=await reset.execute(p.token);assert.equal(result.status,'pending')
 assert.throws(()=>f.store.records(f.store.getScope(f.scope.key)),/正在重置/)
 f.store.close();const db=new MemoryStore(f.file,{now:f.now})
 const next=new ResetCoordinator(db,{participants:[participant],now:f.now})
 assert.equal(next.pending().length,1);assert.equal((await next.resume(result.id)).status,'complete')
 assert.equal(db.getScope(f.scope.key).blocked,0);assert.equal(db.records(db.getScope(f.scope.key)).length,0);db.close()
})
test('missing reset adapters and expired confirmation never report success',async t=>{
 const f=fixture(t);f.event()
 const bad=new ResetCoordinator(f.store,{participants:[{id:'legacy',version:1,preview:async()=>({supported:false,reason:'混合人格无法精确清理'}),clear:async()=>({verified:true})}],now:f.now})
 await assert.rejects(bad.preview({scopeKey:f.scope.key}),/不能完整重置/)
 const reset=new ResetCoordinator(f.store,{now:f.now}),p=await reset.preview({scopeKey:f.scope.key});f.advance(300001)
 await assert.rejects(reset.execute(p.token),/过期/)
})
