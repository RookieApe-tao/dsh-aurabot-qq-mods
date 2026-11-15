import {describeScope} from './presentation.mjs'
import { required, text, uid, hash } from './policy.mjs'
import { ArchiveRestore } from './restore.mjs'
import {archiveOverview,archiveMetrics,recordDiagnostics} from './overview.mjs'
import {previewText,importText,impressions,expiry} from './management-extra.mjs'
const TYPES=['fact','episode','promise','state','context','day','month']
const decode=row=>({...row,data:JSON.parse(row.payload)})
const sizeOf=v=>Math.min(100,Math.max(1,Number(v)||40))
const fields=['name','nickname','alias','style','persona','handle','text','address','bio','relationship','interactionStyle','tags','relations','notes','noMemory','vibe','topics','impression']

// Panel-only service, independent of the running extraction/recall engine. No model calls.
export class MemoryManagement {
  constructor({getStore,currentPersona=()=>'',personas=()=>[],ownerQQ=()=>'',invalidate=async()=>{},diagnostics=()=>({})}){Object.assign(this,{getStore,currentPersona,personas,ownerQQ,invalidator:invalidate,diagnostics})}
  commit(data,result,scopes){
    const old=this.store.meta('management-sync',{scopes:[]});this.store.setMeta('management-sync',{id:uid(),at:this.store.now(),scopes:[...new Set([...old.scopes,...scopes.map(s=>s.key)])]})
    if(data.operationId)this.store.setMeta('management-op:'+required(data.operationId,100),{fingerprint:hash(data),at:this.store.now(),committed:true})
    return result
  }
  async invalidate(scopes){
    const old=this.store.meta('management-sync',{scopes:[]}),pending={id:uid(),at:this.store.now(),scopes:[...new Set([...old.scopes,...scopes.map(s=>s.key)])]};this.store.setMeta('management-sync',pending)
    try{await this.invalidator(pending.scopes.map(k=>this.store.getScope(k)).filter(Boolean));if(this.store.meta('management-sync')?.id===pending.id)this.store.db.prepare('DELETE FROM meta WHERE key=?').run('management-sync');return {ok:true}}
    catch(error){if(this.store.meta('management-sync')?.id===pending.id)this.store.setMeta('management-sync',{...pending,error:String(error.message).slice(0,200)});return {ok:false,committed:true,message:'资料已保存，上下文清理待恢复；请勿重复提交。'}}
  }
  async retrySync(){const pending=this.store.meta('management-sync');return pending?this.invalidate(pending.scopes.map(k=>this.store.getScope(k)).filter(Boolean)):{ok:true}}
  get store(){const s=this.getStore();if(!s)throw Error('尚未接管，没有增强记忆档案');return s}
  selected(data){const s=this.store.getScope(required(data.scopeKey));if(!s||s.epoch!==data.epoch)throw Error('范围已变化，请刷新后重试');this.store.assertScope(s);return s}
  checked(s,data){const r=this.store.record(required(data.id));if(!r||r.scope!==s.key||r.epoch!==s.epoch)throw Error('资料不属于当前范围');if(r.revision!==data.expectedRevision)throw Error('资料已被其他页面更新，请刷新后重试');return r}
  state(){const store=this.getStore(),life=store?.meta('lifecycle',{state:'never'})||{state:'never'};return {readOnly:!!store?.readOnly,pendingSync:store?.meta('management-sync'),managed:!!life.managed,lifecycle:life,currentPersona:this.currentPersona(),personas:this.personas(),scopes:store?store.scopes().map(s=>({...s,...describeScope(s,store.person(s).data),counts:store.statistics(s),profile:store.person(s)})):[],diagnostics:this.diagnostics()}}
  list(data){
    const db=this.store.db,layer=data.layer||'records',size=sizeOf(data.limit),s=data.scopeKey?this.selected(data):null,persona=s?.persona||required(data.persona),scopes=s?[s]:this.store.scopes(persona),revision=s?s.revision:hash(scopes.map(x=>[x.key,x.epoch,x.revision,x.blocked])),table=layer==='raw'?'events':'records'
    const args=s?[s.key,s.epoch]:[persona],query=text(data.query||'',300),clauses=s?['scope=?','epoch=?']:[`EXISTS (SELECT 1 FROM scopes scope_filter WHERE scope_filter.key=${table}.scope AND scope_filter.epoch=${table}.epoch AND scope_filter.persona=?)`]
    if(data.audience){if(!['private','group','system'].includes(data.audience))throw Error('未知内容分类');clauses.push(`EXISTS (SELECT 1 FROM scopes audience_filter WHERE audience_filter.key=${table}.scope AND audience_filter.audience=?)`);args.push(data.audience)}
    if(layer==='raw')clauses.push("withdrawn=0 AND kind!='protocol' AND kind NOT LIKE 'retained:%'");else if(layer!=='records')throw Error('未知列表类型')
    if(layer==='records'&&data.status!=='all'){clauses.push("state NOT IN ('invalid','superseded','disputed','expired') AND (until_at IS NULL OR until_at>?)");args.push(this.store.now())}
    if(query){clauses.push('instr(body,?)>0');args.push(query)}
    if(layer==='records'&&data.kind){if(!TYPES.includes(data.kind))throw Error('未知记忆类型');clauses.push('kind=?');args.push(data.kind)}
    if(layer==='records'&&data.subject){clauses.push('subject=?');args.push(required(data.subject))}
    const where=clauses.join(' AND '),filter=hash([s?.key||persona,s?.epoch,layer,query,data.kind||'',data.subject||'',data.status||'current',data.audience||'']),c=data.cursor
    if(c&&(c.revision!==revision||c.filter!==filter))throw Error('列表已变化，请刷新第一页')
    const total=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n
    const rows=db.prepare(`SELECT * FROM ${table} WHERE ${where}${c?' AND (at<? OR (at=? AND id<?))':''} ORDER BY at DESC,id DESC LIMIT ?`).all(...args,...(c?[c.at,c.at,c.id]:[]),size+1)
    const more=rows.length>size;rows.length=Math.min(rows.length,size);const last=rows.at(-1)
    return {items:layer==='records'?rows.map(decode):rows,total,revision,next:more?{at:last.at,id:last.id,revision,filter}:null}
  }
  detail(data){const s=this.selected(data),r=this.store.record(required(data.id));if(!r||r.scope!==s.key||r.epoch!==s.epoch)throw Error('资料不属于当前范围');return {item:r,sources:this.store.sources(r.id).map(x=>({...x,event:this.store.event(x.event_id)})),changes:this.store.db.prepare('SELECT * FROM changes WHERE scope=? AND entity_id=? ORDER BY seq DESC LIMIT 50').all(s.key,r.id),diagnostics:recordDiagnostics(this.store,s,r)}}
  async add(data){
    const s=this.selected(data),body=text(data.text,12000).trim(),kind=data.kind||'episode';if(!body||!TYPES.includes(kind))throw Error('请填写有效记忆类型与内容')
    const result=this.store.transaction(()=>{const subject=required(data.subject||s.subject),e=this.store.ingest(s,{sourceId:'admin:'+uid(),role:'admin',actor:subject,text:body,at:this.store.now(),kind:'manual'}).event
      const r=this.store.putRecord(s,{kind,subject,attribute:text(data.attribute||'手工补充:'+e.id,200),text:body,value:kind==='fact'?body.slice(0,2000):'',domain:data.domain||'reported',sources:[{id:e.id,quote:body}],extractor:'panel'}).record
      this.store.change(s,'record',r.id,'add',r.revision);return this.commit(data,{item:r},[s])})
    await this.invalidate([s]);return result
  }
  async edit(data){
    const s=this.selected(data),body=text(data.text,12000).trim();if(!body)throw Error('请填写更正内容')
    const result=this.store.transaction(()=>{
      const old=this.checked(s,data),subject=required(data.subject||old.subject),refs=this.store.sources(old.id),e=this.store.ingest(s,{sourceId:'admin-edit:'+uid(),role:'admin',actor:subject,text:body,at:this.store.now(),kind:'correction'}).event
      if(old.data.activity&&subject!==old.subject)throw Error('动作执行者由原模块确认，不能修改为其他人物')
      if(old.kind==='fact'&&subject!==old.subject&&this.store.db.prepare("SELECT 1 FROM records WHERE scope=? AND epoch=? AND subject=? AND attribute=? AND kind='fact' AND state='valid' AND id!=?").get(s.key,s.epoch,subject,old.attribute,old.id))throw Error('此对象已有同类事实，请先核对，不能覆盖')
      const states=old.kind==='promise'?['proposed','agreed','due','completed','cancelled','expired','unknown']:['valid','superseded','disputed','invalid'],state=data.state||old.state
      if(!states.includes(state))throw Error('无效状态');if(old.data.activity&&state!==old.state)throw Error('动作结果需由原模块回执修订，不能手改为平台成功')
      this.store.invalidateDerived(s,refs.map(x=>x.event_id),[old.id])
      for(const ref of refs)this.store.setMeta('corrected:'+ref.event_id,{record:old.id,at:this.store.now()})
      this.store.db.prepare('UPDATE records SET body=?,value=?,summary=?,state=?,revision=revision+1,payload=? WHERE id=?').run(body,old.kind==='fact'?body.slice(0,2000):old.value,'',state,JSON.stringify({...old.data,manualRevision:true,extractor:'panel',replacedSources:[...new Set([...(old.data.replacedSources||[]),...refs.map(r=>r.event_id)])]}),old.id)
      this.store.db.prepare('DELETE FROM sources WHERE record_id=?').run(old.id);this.store.db.prepare('INSERT INTO sources VALUES (?,?,?,?)').run(old.id,e.id,e.revision,body)
      this.store.db.prepare('UPDATE records SET subject=?,signature=? WHERE id=?').run(subject,hash(['manual-revision',old.id,old.revision+1,subject,body]),old.id)
      this.store.db.prepare('DELETE FROM record_search WHERE id=?').run(old.id);this.store.reindex(old.id)
      if(Object.hasOwn(data,'until'))this.store.db.prepare('UPDATE records SET until_at=? WHERE id=?').run(expiry(data.until),old.id)
      for(const j of this.store.db.prepare("SELECT id,payload FROM jobs WHERE scope=? AND epoch=? AND status IN ('pending','running','unknown')").all(s.key,s.epoch))if(JSON.parse(j.payload).sources?.some(x=>refs.some(y=>x.id===y.event_id)))this.store.finishJob(j.id,'stale','admin-correction')
      this.store.revision(s.key);this.store.change(s,'record',old.id,'edit',old.revision+1);return this.commit(data,{item:this.store.record(old.id)},[s])
    });await this.invalidate([s]);return result
  }
  async mark(data){
    const s=this.selected(data),result=this.store.transaction(()=>{const r=this.checked(s,data);if(!['pin','suppress'].includes(data.action))throw Error('未知修改')
      this.store.db.prepare('UPDATE records SET pinned=?,payload=?,revision=revision+1 WHERE id=?').run(data.action==='pin'?(data.value===true?1:0):r.pinned,JSON.stringify({...r.data,...(data.action==='suppress'?{suppressed:data.value===true}:{})}),r.id)
      this.store.revision(s.key);this.store.change(s,'record',r.id,data.action,r.revision+1);return this.commit(data,{item:this.store.record(r.id)},[s])})
    await this.invalidate([s]);return result
  }
  forgetPreview(data){
    const s=this.selected(data),r=this.checked(s,data),refs=this.store.allSources(r.id),ids=new Set([r.id])
    for(const ref of refs)for(const x of this.store.db.prepare('SELECT record_id FROM sources WHERE event_id=?').all(ref.event_id))ids.add(x.record_id)
    const token=uid(),payload={scopeKey:s.key,epoch:s.epoch,id:r.id,expectedRevision:r.revision,scopeRevision:s.revision,ids:[...ids].sort()}
    this.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'forget',hash(payload),JSON.stringify(payload),this.store.now()+300000)
    return {token,items:payload.ids.map(id=>({id,kind:this.store.record(id)?.kind,summary:this.store.record(id)?.body.slice(0,100)})),sourceCount:refs.length,warning:'以下关联记忆和来源将一并撤回；原平台消息、照片文件和游戏存档保留。'}
  }
  async forget(data){
    const result=this.store.transaction(()=>{const p=this.store.db.prepare("SELECT * FROM previews WHERE token=? AND kind='forget'").get(required(data.token));if(!p||p.expires_at<this.store.now()||data.confirm!==true)throw Error('删除预览已过期或尚未确认')
      const plan=JSON.parse(p.payload),s=this.selected(plan);if(s.revision!==plan.scopeRevision)throw Error('资料已变化，请重新预览删除范围')
      this.checked(s,plan);this.store.forget(s,plan.id);for(const id of plan.ids)this.store.change(s,'record',id,'forget',plan.expectedRevision+1)
      this.store.db.prepare('DELETE FROM previews WHERE token=?').run(data.token);return this.commit(data,{scope:s,deleted:plan.ids.length},[s])})
    await this.invalidate([result.scope]);return {deleted:result.deleted}
  }
  async profile(data){
    const s=this.selected(data),subject=required(data.subject||s.subject),audience=data.audience||s.audience;if(!['private','group'].includes(audience))throw Error('人物或群范围不正确')
    if(data.read===true)return {profile:this.store.person(s,subject,audience)}
    const result=this.store.transaction(()=>{const p=this.store.person(s,subject,audience);if(p.revision!==data.expectedRevision)throw Error('人物资料已更新，请刷新')
      const values={...p.data};for(const k of fields)if(Object.hasOwn(data.values||{},k)){const v=data.values[k];if(k==='noMemory')values[k]=v===true;else if(k==='tags'){if(!Array.isArray(v)||v.length>8||v.some(x=>typeof x!=='string'||!x.trim()||[...x.trim()].length>8))throw Error('标签最多8个，每个最多8字');values[k]=[...new Set(v.map(x=>x.trim()))];if(values.tags.includes('喜欢')&&values.tags.includes('讨厌'))throw Error('喜欢和讨厌不能同时选择');if(subject===this.ownerQQ()&&values.tags.includes('讨厌'))throw Error('不能对主人设置讨厌标签')}else if(k==='relations'){if(!Array.isArray(v)||v.length>50)throw Error('关系格式不正确');values[k]=v.map(x=>typeof x==='string'?text(x,500):JSON.parse(text(JSON.stringify(x),2000)))}else values[k]=text(v,4000)}
      for(const [old,key]of [['alias','address'],['text','bio'],['handle','interactionStyle']]){if(Object.hasOwn(data.values||{},old))values[key]=values[old];else if(Object.hasOwn(data.values||{},key))values[old]=values[key]}
      if(audience==='private'&&subject===this.ownerQQ()&&values.noMemory)throw Error('主人不能用人物停记按钮；可暂停全部长期记忆')
      this.store.db.prepare('INSERT INTO people VALUES (?,?,?,?,?) ON CONFLICT(persona,audience,subject) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(s.persona,audience,subject,p.revision+1,JSON.stringify(values))
      for(const peer of this.store.scopes(s.persona))this.store.revision(peer.key)
      this.store.change(s,'person',audience+':'+subject,'edit',p.revision+1)
      if(values.noMemory)this.store.db.prepare("UPDATE jobs SET status='stale',error='person-excluded' WHERE scope IN (SELECT key FROM scopes WHERE persona=?) AND status IN ('pending','running','unknown')").run(s.persona)
      return this.commit(data,{profile:this.store.person(s,subject,audience)},this.store.scopes(s.persona))})
    await this.invalidate(this.store.scopes(s.persona));return result
  }
  export(data){
    const s=this.selected(data);if(data.revision!=null&&data.revision!==s.revision)throw Error('导出期间资料已变化，请重新导出')
    const tables=['events','records','sources','people','changes','extras'],table=data.table||'events';if(!tables.includes(table))throw Error('未知导出内容')
    const n=sizeOf(data.limit),after=Number(data.after)||0,db=this.store.db;let sql,args
    if(table==='extras'){sql='SELECT rowid position,key,value FROM meta WHERE key=? AND rowid>? LIMIT ?';args=['native-extra:'+s.key+':'+s.epoch,after,n+1]}
    else if(table==='sources'){sql='SELECT x.rowid position,x.* FROM sources x JOIN records r ON r.id=x.record_id WHERE r.scope=? AND r.epoch=? AND x.rowid>? ORDER BY x.rowid LIMIT ?';args=[s.key,s.epoch,after,n+1]}
    else if(table==='people'){sql='SELECT rowid position,* FROM people WHERE persona=? AND audience=? AND subject=? AND rowid>? ORDER BY rowid LIMIT ?';args=[s.persona,s.audience,s.subject,after,n+1]}
    else {sql=`SELECT rowid position,* FROM ${table} WHERE scope=? AND epoch=? AND rowid>? ORDER BY rowid LIMIT ?`;args=[s.key,s.epoch,after,n+1]}
    const rows=db.prepare(sql).all(...args),more=rows.length>n;rows.length=Math.min(rows.length,n)
    return {schema:3,scope:s,revision:s.revision,table,rows,next:more?{table,after:rows.at(-1).position}:tables.indexOf(table)<tables.length-1?{table:tables[tables.indexOf(table)+1],after:0}:null}
  }
  async dispatch(action,data={}){data={...data,operationKind:action};if(data.operationId){const old=this.store.meta('management-op:'+required(data.operationId,100));if(old){if(old.fingerprint!==hash(data))throw Error('重复操作编号对应的内容不同');return {ok:true,duplicate:true,committed:true,reload:true}}}const restore=new ArchiveRestore(this),actions={'text-preview':()=>previewText(this,data),'text-import':()=>importText(this,data),impressions:()=>impressions(this,data),'retry-sync':()=>this.retrySync(),state:()=>this.state(),list:()=>this.list(data),detail:()=>this.detail(data),add:()=>this.add(data),edit:()=>this.edit(data),mark:()=>this.mark(data),'forget-preview':()=>this.forgetPreview(data),forget:()=>this.forget(data),profile:()=>this.profile(data),export:()=>this.export(data),'restore-preview':()=>restore.preview(data),'restore':()=>restore.restore(data),overview:()=>archiveOverview(this,data),metrics:()=>archiveMetrics(this)};if(!actions[action])throw Error('未知管理操作');const result=await actions[action]();return {ok:true,...result,...(this.getStore()?.meta('management-sync')?{warning:'资料已保存，上下文清理待恢复；请勿重复提交。'}:{})}}
}
