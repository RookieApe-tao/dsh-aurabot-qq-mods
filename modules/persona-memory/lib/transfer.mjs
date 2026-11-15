import { hash, required, uid } from './policy.mjs'

/** Import a bounded page from a CONSISTENT snapshot, never a live WAL-less file copy.
 * Persona attribution is supplied by the trusted management cutover plan, not inferred.
 * Unknown identities remain quarantined outside online memory, with counts returned.
 */
export function importPage(store, snapshot, { namespace, snapshotId, records, mappingConfirmed, expectedEpoch, cursor = '' }) {
  store.assertScope(snapshot)
  if(!mappingConfirmed)throw new Error('旧资料尚未明确角色与可见范围，不能自动猜测归属')
  if(expectedEpoch!==snapshot.epoch)throw new Error('导入代际已变化')
  required(namespace);required(snapshotId)
  if(!Array.isArray(records)||records.length>200)throw new Error('导入必须分批且每页不超过200条')
  const results={imported:0,duplicates:0,rejected:[],cursor}
  for(const source of records){
    if(source.invalid){results.rejected.push({id:String(source.id),reason:'inactive-legacy-record'});continue}
    const sourceId=required(String(source.id)),fingerprint=hash(source)
    const old=store.db.prepare('SELECT * FROM imports WHERE namespace=? AND source_id=? AND scope=?').get(namespace,sourceId,snapshot.key)
    if(old){
      if(old.epoch!==snapshot.epoch) {results.rejected.push({id:sourceId,reason:'reset-boundary'});continue}
      if(old.fingerprint!==fingerprint)throw new Error('同一导入ID内容变化，需新快照或明确修订')
      results.duplicates++;continue
    }
    if(!source.confirmedScope){results.rejected.push({id:sourceId,reason:'unknown-scope'});continue}
    const input={sourceId:`import:${hash([namespace,sourceId])}`,role:'legacy',actor:source.actor||'legacy-unverified',text:source.text,at:source.at,kind:'legacy-'+(source.kind||'raw')}
    try{
      const {event}=store.ingest(snapshot,input)
      // Crash after event insert is harmless: the deterministic source ID makes replay idempotent.
      if(source.kind==='day'||source.kind==='month'){
        const {record}=store.putRecord(snapshot,{kind:source.kind,subject:snapshot.subject,attribute:source.profile?'legacy-profile':'旧'+source.kind+'摘要',value:'',text:event.body,domain:'legacy',sources:[{id:event.id,quote:event.body}],at:event.at,extractor:'legacy-import'})
        const f=source.followUp,followUp=f&&Number.isFinite(f.at)&&f.at>0&&typeof f.question==='string'&&Number.isInteger(f.tries||0)&&(f.tries||0)<3?{at:f.at,tries:f.tries||0,question:f.question.slice(0,120)}:undefined
        if(source.profile||followUp)store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify({...record.data,...(source.profile?{legacyProfile:source.profile,suppressed:true}:{}),...(followUp?{followUp}:{})}),record.id)
      }
      store.db.prepare('INSERT INTO imports VALUES (?,?,?,?,?)').run(namespace,sourceId,snapshot.key,snapshot.epoch,fingerprint)
      results.imported++
    }catch(error){
      if(/重新开始边界/.test(error.message))results.rejected.push({id:sourceId,reason:'reset-boundary'})
      else throw error
    }
  }
  store.setMeta('import:'+hash([namespace,snapshot.key]),{snapshotId,cursor,epoch:snapshot.epoch,at:store.now()})
  return results
}

export function exportPage(store,snapshot,{before,limit=100}={}){
  const events=store.events(snapshot,{before,limit})
  const last=events.at(-1)
  return {schema:1,persona:snapshot.persona,audience:snapshot.audience,subject:snapshot.subject,epoch:snapshot.epoch,events,
    next:events.length===Math.min(200,limit)&&last?{at:last.at,id:last.id}:null}
}

export function correctFromPanel(store,snapshot,{id,expectedRevision,text:body,value,state,until}){
  const current=store.record(required(id))
  if(!current||current.scope!==snapshot.key||current.epoch!==snapshot.epoch)throw new Error('条目不属于当前范围')
  if(current.revision!==expectedRevision)throw new Error('条目已更新，请刷新')
  if(!body?.trim())throw new Error('请填写更正内容')
  const event=store.ingest(snapshot,{sourceId:'panel:'+uid(),role:'admin',actor:current.subject,at:store.now(),text:body,kind:'correction'}).event
  try {
    return store.revise(snapshot,id,{expectedRevision,text:body,value:value??body,state:state||current.state,until:until??current.until_at,domain:current.data.domain,priority:current.priority,pinned:!!current.pinned,sources:[{id:event.id,quote:event.body}]})
  }catch(error){
    // Failed edits are not evidence for future extraction.
    store.db.prepare("UPDATE events SET body='',withdrawn=1,revision=revision+1 WHERE id=?").run(event.id)
    throw error
  }
}
