import {AsyncLocalStorage} from 'node:async_hooks'
import {hash,uid,text,required} from './policy.mjs'

const names={bili:'B站',douyin:'抖音',xhs:'小红书',stardew:'星露谷',imagegen:'生图',song:'唱歌',diary:'空间日记','character-photo':'角色照片',autotelic:'自驱',night:'梦境'}
const states=new Set(['observed','confirmed','created','failed','unknown','retracted','reported'])
export class ActivityLedger {
 constructor(bridge){this.bridge=bridge;this.context=new AsyncLocalStorage();this.proxies=new WeakMap();this.now=()=>bridge.management.getStore()?.now()??Date.now()}
 run(moduleId,chat,fn){if(!this.bridge.managed())return fn();const parent=this.context.getStore();if(parent?.moduleId===moduleId)return fn();const id=chat?.chatId||'system:'+moduleId,kind=id.split(':')[0],subject=id.slice(kind.length+1),captured=this.bridge.currentScope({kind,chatId:id,userId:kind==='private'?subject:'',groupId:kind==='group'?subject:''});return this.context.run({moduleId,captured,id:uid(),at:this.now()},fn)}
 wrap(moduleId,api){if(!api||!names[moduleId]||typeof api!=='object')return api;let cached=this.proxies.get(api);if(cached)return cached;const self=this;cached=new Proxy(api,{get(target,key){const v=target[key];return typeof v==='function'?function(...args){return self.run(moduleId,null,()=>v.apply(target,args))}:v}});this.proxies.set(api,cached);return cached}
 tools(moduleId,builder){return info=>{const list=builder(info),wrap=tool=>({...tool,execute:(...args)=>this.run(moduleId,info?.chat,()=>tool.execute(...args))});return Array.isArray(list)?list.map(wrap):list?wrap(list):list}}
 client(moduleId){return {version:1,run:(chat,fn)=>this.run(moduleId,chat,fn),record:event=>this.record(moduleId,event),legacy:event=>this.legacy(moduleId,event)}}
 legacy(moduleId,o){
  const c=this.context.getStore();if(!c||c.moduleId!==moduleId)return {ok:false,status:'unsupported-context',message:'此调用未提供活动开始范围，未推断归属'}
  if(o.activity?.version===1)return this.record(moduleId,{...o.activity,id:o.activity.id||c.id+':'+hash(o.text||'').slice(0,16),summary:o.activity.summary||o.text})
  if(moduleId==='bili'&&o.kind==='seen'&&o.meta?.id)return this.record(moduleId,{id:'read:'+o.meta.id+':'+new Date(c.at).toISOString().slice(0,10),status:'observed',summary:'读取了B站内容《'+String(o.meta.title||o.meta.id).slice(0,160)+'》',evidence:'站点返回内容ID：'+o.meta.id,coverage:'站点标题、可取得的摘要和评论；不表示完整观看视频或知道全部画面',visibility:'owner'})
  // Unadapted legacy writers are not treated as external confirmations. Their own
  // report remains manageable, with no automatic recall or synthesized user facts.
  return this.record(moduleId,{id:'report:'+new Date(c.at).toISOString().slice(0,10)+':'+hash(o.text||'').slice(0,20),status:'reported',summary:String(o.text||'').slice(0,1200),coverage:'旧接口自述，尚无结构化结果依据',visibility:'owner'})
 }
 record(moduleId,event){
  const c=this.context.getStore();if(!c||c.moduleId!==moduleId||!this.bridge.managed())return {ok:false,status:'unsupported-context'}
  if(this.bridge.acceptsActivity?!this.bridge.acceptsActivity(c.captured):!c.captured?.activity?.eligible||this.bridge.mode()==='paused')return {ok:false,status:'not-recording'}
  try{this.bridge.assertActivity(c.captured)}catch{return {ok:false,status:'stale-activity'}}
  const coverageRows=this.bridge.activityCoverage?.().entries||[],adapterRows=coverageRows.filter(r=>r.file.startsWith(moduleId+'/')||r.file.startsWith('src/modules/'+moduleId+'/')||r.file.startsWith('src/'+moduleId+'/'))
  if(adapterRows.some(r=>r.status!=='adapted'))return {ok:false,status:'adapter-version-changed',message:'玩法版本已变化，记忆结果适配待核对'}
  const status=required(event.status),id=required(String(event.id||''),300);if(!states.has(status))throw Error('未知活动结果')
  if(event.dryRun)return {ok:false,status:'dry-run'}
  const summary=text(event.summary||'',1200),coverage=text(event.coverage||'模块确认了动作结果，未验证内容中的每项说法',300)
  if(!summary)throw Error('活动摘要为空')
  if(['confirmed','observed','created','retracted'].includes(status)&&!String(event.evidence||'').trim())throw Error('已确认经历必须包含结果依据')
  const store=this.bridge.management.getStore(),scope=store?.scope(c.captured.input);if(!scope)return {ok:false,status:'not-recording'}
  const op='activity-op:'+hash([scope.key,moduleId,id]),prior=store.meta(op),revision=Number(event.revision||1)
  if(!Number.isSafeInteger(revision)||revision<1)throw Error('活动修订无效')
  if(prior&&(prior.epoch!==scope.epoch||!store.record(prior.recordId)))return {ok:false,status:'forgotten'}
  if(prior&&revision<=prior.revision)return {ok:true,status:'duplicate',id:prior.recordId}
  if(prior&&store.record(prior.recordId)?.data.manualRevision)return {ok:false,status:'manually-corrected',id:prior.recordId}
  if(prior&&!['unknown','reported'].includes(prior.status)&&status!=='retracted')throw Error('已确认结果不能被迟到的旧回执改写')
  const visibility=['public','owner','scope'].includes(event.visibility)?event.visibility:'owner'
  const prefix=({observed:'读取到',confirmed:'已确认',created:'已生成',failed:'未完成',unknown:'结果待核对',retracted:'已撤回',reported:'模块报告，未经结果核对'})[status]
  const body=`【${names[moduleId]||moduleId} · ${prefix}】${summary}\n可知范围：${coverage}`
  return store.transaction(()=>{
    const result=this.bridge.recordActivity(c.captured,{sourceId:'activity:'+hash([op,revision]),text:body,kind:'activity',domain:event.domain==='roleplay'?'roleplay':'reported',at:Number(event.occurredAt)||c.at})
    if(!result?.ok)return result
    const r=store.record(result.record.id),activity={version:1,moduleId,operationId:id,revision,status,visibility,coverage,evidence:text(String(event.evidence||''),1200),occurredAt:Number(event.occurredAt)||c.at,confirmedAt:Date.now(),attachments:Array.isArray(event.attachments)?event.attachments.slice(0,8).map(x=>({id:required(String(x.id)),kind:text(String(x.kind||'file'),40)})):[]}
    const brief=`【${names[moduleId]||moduleId}·${prefix}】${summary}`+(status==='observed'?'（仅取得的部分内容）':'')
    store.db.prepare('UPDATE records SET summary=?,payload=? WHERE id=?').run(brief.length<=120?brief:'',JSON.stringify({...r.data,activity,suppressed:['reported','unknown','failed','retracted'].includes(status)}),r.id)
    store.db.prepare('DELETE FROM record_search WHERE id=?').run(r.id);store.reindex(r.id)
    if(prior){store.db.prepare("UPDATE records SET state='superseded',revision=revision+1 WHERE id=?").run(prior.recordId);store.invalidateDerived(scope,store.sources(prior.recordId).map(x=>x.event_id),[r.id,prior.recordId])}
    store.setMeta(op,{recordId:r.id,epoch:scope.epoch,revision,status});store.change(scope,'activity',r.id,status,r.revision)
    return {ok:true,status:'saved',id:r.id}
  })
 }
}

export function activityCandidates(store,snapshot,query,{ownerQQ='',limit=120}={}){
 const overview=/你.*(?:今天|昨天|最近|干了|做了|玩了)|(?:今天|昨天|最近).*你.*(?:做|玩|看)/.test(query||''),expanded=/照片|拍照|画图|生图/.test(query||'')?query+' 图片 照片 生成':/游戏|农场|星露谷|玩了/.test(query||'')?query+' 游戏 星露谷':query
 const out=[];for(const scope of store.scopes(snapshot.persona).filter(s=>!s.blocked&&s.audience==='system'))for(const r of store.records(scope,{query:overview?'':expanded,limit})){const a=r.data?.activity;if(!a||!['observed','confirmed','created'].includes(a.status)||overview&&store.now()-r.at>7*86400000||!store.recordAllowed(scope,r))continue
  if(a.visibility==='public'||a.visibility==='owner'&&snapshot.audience==='private'&&snapshot.subject===ownerQQ)out.push(r)
 }return out.slice(0,limit)
}
