import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { MemoryStore } from '../lib/store.mjs'
import { DEFAULTS } from '../lib/policy.mjs'
import { MemoryService, REQUIRED_CAPABILITIES } from '../lib/service.mjs'

function cleanup(dir){
  const target=resolve(dir)
  if(dirname(target)!==resolve(tmpdir()) || !basename(target).startsWith('persona-memory-'))throw new Error('Refusing to clean an unexpected directory')
  rmSync(target,{recursive:true,force:true})
}
export function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'persona-memory-test-'))
  let clock=1794614400000
  const now=()=>clock,file=join(dir,'memory.sqlite'),store=new MemoryStore(file,{now})
  t.after(()=>{try{store.close()}catch{}cleanup(dir)})
  const scope=store.scope({persona:'alice',audience:'private',subject:'user1'})
  let seq=0
  const event=(body='我不喜欢咖啡',extra={})=>store.ingest(scope,{sourceId:'message-'+(++seq),role:'user',actor:'user1',text:body,at:clock,...extra}).event
  const record=(e,extra={})=>store.putRecord(scope,{kind:'fact',subject:'user1',attribute:'饮品偏好',value:'咖啡',text:e.body,sources:[{id:e.id,revision:e.revision,quote:e.body}],...extra}).record
  return {dir,file,store,scope,now,event,record,advance:ms=>{clock+=ms},config:{...DEFAULTS}}
}
export function fakeBridge(overrides={}){
  const calls=[]
  return {api:1,capabilities:[...REQUIRED_CAPABILITIES],calls,
    prepare:async input=>{calls.push(['prepare',input]);return {verified:true,id:'verified-preview',impact:['合成测试资料'] }},
    activate:async input=>{calls.push(['activate',input.mode]);return {verified:true,singleProvider:true}},
    pause:async input=>{calls.push(['pause',input]);return {verified:true,contextCleared:true}},
    currentScope:()=>({persona:'alice',audience:'private',subject:'user1'}),resetParticipants:()=>[],...overrides}
}
export function serviceFixture(t,overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'persona-memory-service-')),file=join(dir,'memory.sqlite')
  let cfg={...DEFAULTS},now=1794614400000
  const bridge=overrides.bridge??fakeBridge()
  const service=new MemoryService({file,bridge,readSettings:()=>cfg,writeSettings:next=>{cfg=next},now:()=>now,...overrides})
  t.after(()=>{service.dispose();cleanup(dir)})
  return {service,bridge,dir,file,get config(){return cfg},advance:ms=>{now+=ms}}
}
export async function enable(service){ const p=await service.prepareActivation();await service.activate(p.token) }
