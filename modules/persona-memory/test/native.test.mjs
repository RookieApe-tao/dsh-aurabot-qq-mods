import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './helpers.mjs'
import {NativeMemoryAdapter} from '../lib/native.mjs'
import {DEFAULTS} from '../lib/policy.mjs'

function adapter(f){let mode='native',generation=1;const api=new NativeMemoryAdapter({getStore:()=>f.store,persona:()=> 'alice',ownerQQ:()=> 'user1',mode:()=>mode,generation:()=>generation,getSettings:()=>DEFAULTS,now:f.now});return {api,switch:m=>{mode=m;generation++}}}
test('native working view preserves archive-only text and writes short edits to the same archive',t=>{
 const f=fixture(t),n=adapter(f),r=f.record(f.event()),long=f.record(f.event('长正文'.repeat(100)),{kind:'episode',value:'',attribute:'long'})
 n.api.run(f.scope,()=>{const s=n.api.load();assert.equal(s.items.length,1);assert.equal(s.items[0].id,r.id);s.items[0].text='现在喝茶';n.api.save(s)})
 assert.equal(f.store.record(r.id).body,'现在喝茶');assert.equal(f.store.record(long.id).body,'长正文'.repeat(100));assert.equal(n.api.summary().archiveOnly,1)
})
test('native derived records retain source dependencies; deletion prevents re-extraction and ID replay',t=>{
 const f=fixture(t),n=adapter(f),original=f.record(f.event())
 n.api.run(f.scope,()=>{const s=n.api.load();s.items.push({id:'native-1',text:'由原话整理的印象',about:'user1',chatId:'private:user1',source:'auto'});n.api.save(s)})
 assert.equal(f.store.record('native-1').data.domain,'reported');assert.ok(f.store.sources('native-1').some(x=>x.event_id===f.store.sources(original.id)[0].event_id))
 f.store.forget(f.scope,original.id);assert.equal(f.store.record('native-1'),null)
 n.api.run(f.scope,()=>{const s=n.api.load();s.items.push({id:'native-1',text:'旧内容',about:'user1',chatId:'private:user1',source:'auto'});assert.throws(()=>n.api.save(s),/已遗忘/)})
})
test('native pending snapshots cannot commit after changes, mode switches or a reset boundary',t=>{
 const f=fixture(t),n=adapter(f);f.record(f.event());const s=n.api.run(f.scope,()=>n.api.load());f.event('并发消息');assert.throws(()=>n.api.save(s),/档案已变化/)
 const s2=n.api.run(f.scope,()=>n.api.load());n.switch('enhanced');assert.throws(()=>n.api.save(s2),/提供方已变化/)
})
test('native scopes cannot expose another persona or a private profile in a group',t=>{
 const f=fixture(t),n=adapter(f);f.record(f.event());f.store.db.prepare('INSERT INTO people VALUES (?,?,?,?,?)').run('alice','private','user1',1,JSON.stringify({text:'私人资料'}));const g=f.store.scope({persona:'alice',audience:'group',subject:'123'})
 n.api.run(g,()=>{const s=n.api.load();assert.equal(s.items.length,0);assert.equal(s.profiles.user1,undefined)})
 const other=f.store.scope({persona:'bob',audience:'private',subject:'user1'});assert.throws(()=>n.api.run(other,()=>n.api.load()),/人格/)
})
test('native gist progress commits atomically with the derived gist',t=>{
 const f=fixture(t),n=adapter(f);f.record(f.event())
 n.api.run(f.scope,()=>{const s=n.api.load();s.gists.push({id:'gist-1',kind:'gist',level:2,text:'久远概括'.repeat(60),chatId:'private:user1',about:'user1',source:'auto'});s.processed={'2026-11-14':{done:1}};n.api.save(s)})
 n.api.run(f.scope,()=>{const s=n.api.load();assert.equal(s.gists.length,1);assert.equal(s.gists[0].level,2);assert.equal(s.gists[0].text.length,240);assert.equal(s.processed['2026-11-14'].done,1)})
 assert.equal(f.store.record('gist-1').kind,'month')
})
test('native attempts remain accounted without enforcing enhanced limits, including failure',async t=>{
 const f=fixture(t),n=adapter(f);n.api.getSettings=()=>({...DEFAULTS,extraAttempts:0,dailyInputTokens:0,dailyOutputTokens:0})
 await n.api.run(f.scope,async()=>{
  await assert.rejects(async()=>{for await(const c of n.api.stream({messages:[],maxTokens:1500},async function*(){throw Error('synthetic failure')})){}},/synthetic/)
  for await(const c of n.api.stream({messages:[],maxTokens:1500},async function*(){yield {type:'usage',usage:{inputTokens:2,outputTokens:3}};yield {type:'finish',reason:{kind:'stop'}}})){}
 })
 assert.equal(f.store.usage().attempts,0);assert.equal(f.store.usage(undefined,'native').attempts,2);assert.equal(f.store.usage(undefined,'native').outputTokens,1503)
})
