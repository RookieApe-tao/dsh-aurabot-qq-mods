import {hash,uid,terms} from './policy.mjs'

// A restore merges into the current archive. It never replaces current deletion,
// reset, revision, permission or usage ledgers with an older file.
export class ArchiveRestore {
 constructor(management){this.management=management}
 get store(){return this.management.store}
 validate(data){
  const s=this.management.selected(data),pack=data.package
  if(pack?.schema!==3||pack.scope?.key!==s.key||pack.scope.persona!==s.persona||pack.scope.audience!==s.audience||pack.scope.subject!==s.subject)throw Error('备份归属不匹配，不能把其他人物或聊天混入此范围')
  if(pack.scope.epoch!==s.epoch)throw Error('此备份早于重新开始边界，不能恢复旧互动')
  if(!pack.tables||['events','records','sources','people','changes'].some(k=>!Array.isArray(pack.tables[k])))throw Error('备份不完整')
  if(JSON.stringify(pack).length>16*1024*1024||pack.tables.events.length>100000||pack.tables.records.length>100000)throw Error('备份超过本页恢复上限')
  const tables=pack.tables;if(tables.extras!=null&&(!Array.isArray(tables.extras)||tables.extras.length>1))throw Error('兼容资料格式不正确');for(const row of tables.extras||[]){if(row.key!=='native-extra:'+s.key+':'+s.epoch||!JSON.parse(row.value)?.state)throw Error('兼容资料归属不正确')}
  for(const name of ['events','records']){const ids=new Set();for(const row of tables[name]){if(typeof row.id!=='string'||!row.id||ids.has(row.id)||row.scope!==s.key||row.epoch!==s.epoch)throw Error('备份包含重复或越界条目');ids.add(row.id)}}
  for(const r of tables.records){const payload=JSON.parse(r.payload);if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof r.body!=='string')throw Error('备份正文无效')}
  return {scope:s,pack}
 }
 preview(data){const {scope:s,pack}=this.validate(data),token=uid(),payload={scopeKey:s.key,epoch:s.epoch,revision:s.revision,digest:hash(pack)}
  this.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'restore',hash(payload),JSON.stringify(payload),this.store.now()+300000)
  return {token,counts:{events:pack.tables.events.length,records:pack.tables.records.length},warning:'合并缺失资料；当前修订、已忘记、停记、重置边界及用量优先。不会覆盖照片、游戏存档或工作区。'}
 }
 async restore(data){
  const {scope:s,pack}=this.validate(data),p=this.store.db.prepare("SELECT * FROM previews WHERE token=? AND kind='restore'").get(String(data.token))
  if(!p||p.expires_at<this.store.now()||data.confirm!==true)throw Error('恢复预览已过期或未确认')
  const plan=JSON.parse(p.payload);if(plan.scopeKey!==s.key||plan.epoch!==s.epoch||plan.revision!==s.revision||plan.digest!==hash(pack))throw Error('资料或备份已变化，请重新预览')
  const pristine=s.revision===0&&!this.store.db.prepare('SELECT 1 FROM events WHERE scope=? LIMIT 1').get(s.key)
  let events=0,records=0,skipped=0
  this.store.transaction(()=>{
   const insert=(table,fields,row)=>this.store.db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...fields.map(k=>row[k]??null))
   for(const e of pack.tables.events){const old=this.store.event(e.id);if(old){if(old.scope!==s.key||old.epoch!==s.epoch)throw Error('来源ID冲突');continue}if(e.withdrawn||this.store.meta('corrected:'+e.id))continue
    if(this.store.db.prepare('SELECT id FROM events WHERE scope=? AND epoch=? AND source_id=?').get(s.key,s.epoch,e.source_id)){skipped++;continue}
    if(typeof e.body!=='string'||e.body.length>100000||!['user','assistant','tool','admin','legacy'].includes(e.role))throw Error('来源格式不正确')
    insert('events',['id','scope','epoch','source_id','revision','role','actor','at','kind','body','fingerprint','withdrawn'],e)
    if(e.kind!=='protocol')this.store.db.prepare('INSERT INTO raw_search(id,words) VALUES (?,?)').run(e.id,terms(e.body,Infinity).join(' '));events++
   }
   for(const r of pack.tables.records){const existing=this.store.record(r.id);if(existing){if(existing.scope!==s.key||existing.epoch!==s.epoch)throw Error('记录ID冲突');skipped++;continue}
    const refs=pack.tables.sources.filter(x=>x.record_id===r.id)
    if(this.store.meta('native-tombstone:'+r.id)||!refs.length||refs.some(ref=>{const e=this.store.event(ref.event_id);return !e||e.scope!==s.key||e.epoch!==s.epoch||e.revision!==ref.event_revision||!this.store.sourceAllowed(s,e)})){skipped++;continue}
    const columns=this.store.db.prepare('PRAGMA table_info(records)').all().map(x=>x.name)
    insert('records',columns,r);for(const ref of refs)insert('sources',['record_id','event_id','event_revision','quote'],ref)
    this.store.reindex(r.id);this.store.change(s,'record',r.id,'restore',r.revision);records++
   }
   // Profiles are restored only when no current profile exists. Stop-memory flags
   // from the current database are never undone by a backup.
   for(const p of pack.tables.people){if(p.persona!==s.persona||p.audience!==s.audience||p.subject!==s.subject)throw Error('人物归属不正确');if(!this.store.db.prepare('SELECT 1 FROM people WHERE persona=? AND audience=? AND subject=?').get(p.persona,p.audience,p.subject)){const values=JSON.parse(p.payload);if(p.subject===this.management.ownerQQ())delete values.noMemory;insert('people',['persona','audience','subject','revision','payload'],{...p,payload:JSON.stringify(values)})}}
   // Unattributed native impressions can only seed an untouched archive. A missing
   // projection in an existing archive may mean a prior correction or forgetting.
   for(const row of pack.tables.extras||[]){if(pristine&&!this.store.meta(row.key))this.store.setMeta(row.key,JSON.parse(row.value));else skipped++}
   this.store.revision(s.key);this.store.db.prepare('DELETE FROM previews WHERE token=?').run(data.token);this.management.commit(data,{events,records,skipped},[s])
  })
  await this.management.invalidate([s]);return {events,records,skipped}
 }
}
