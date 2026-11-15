import {hash,estimateTokens} from './policy.mjs'

/** Local maintenance is incremental and never calls the model itself. */
export function scheduleMonth(store,scope,generation,now){
  const days=store.db.prepare("SELECT id,at,revision FROM records r WHERE scope=? AND epoch=? AND kind='day' AND state='valid' AND at<? AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='monthly-record:'||r.id||':'||r.revision) ORDER BY at,id LIMIT 128").all(scope.key,scope.epoch,now-32*86400000)
  const groups=new Map()
  for(const day of days){const month=new Date(day.at+8*3600000).toISOString().slice(0,7);if(!groups.has(month))groups.set(month,[]);groups.get(month).push(day)}
  for(const [month,records]of groups){
    const refs=new Map(),consumed=[];let bytes=0
    for(const record of records){
      const candidates=store.sources(record.id).map(s=>({source:s,event:store.event(s.event_id)})).filter(({source,event})=>event&&!event.withdrawn&&event.revision===source.event_revision)
      const additional=candidates.filter(({event})=>!refs.has(event.id)),size=additional.reduce((n,{source})=>n+estimateTokens(source.quote),0)
      if(size>7000||additional.length>32){store.setMeta('monthly-record:'+record.id+':'+record.revision,{skipped:'source-too-large',at:now});continue}
      if(bytes+size>7000||refs.size+additional.length>32)break
      for(const {source,event:e}of additional){refs.set(e.id,{id:e.id,revision:e.revision,quote:source.quote});bytes+=estimateTokens(source.quote)}
      consumed.push(record)
    }
    if(refs.size){store.transaction(()=>{store.enqueue(scope,{kind:'month',sources:[...refs.values()],generation});for(const r of consumed)store.setMeta('monthly-record:'+r.id+':'+r.revision,true)});return 1}
  }
  return 0
}

export function retainRaw(store,{rawDays},now){
  if(!rawDays)return {expired:0}
  const rows=store.db.prepare(`SELECT e.* FROM events e WHERE e.withdrawn=0 AND e.kind NOT LIKE 'retained:%' AND e.at<?
    AND NOT EXISTS(SELECT 1 FROM jobs j,json_each(j.payload,'$.sources') ref WHERE j.scope=e.scope AND j.epoch=e.epoch AND j.status IN ('pending','running','unknown','failed','paused','stale') AND json_extract(ref.value,'$.id')=e.id)
    AND NOT (EXISTS(SELECT 1 FROM meta m WHERE m.key='oversized-source:'||e.id) AND NOT EXISTS(SELECT 1 FROM sources src JOIN records r ON r.id=src.record_id WHERE src.event_id=e.id AND r.state NOT IN ('invalid','superseded','disputed')))
    ORDER BY e.at,e.id LIMIT 100`).all(now-rawDays*86400000)
  let expired=0
  store.transaction(()=>{
    for(const e of rows){
      // A pending extraction must keep the exact input it was scheduled with.
      const pending=store.db.prepare("SELECT 1 FROM jobs j,json_each(j.payload,'$.sources') ref WHERE j.scope=? AND j.epoch=? AND j.status IN ('pending','running','unknown','failed','paused','stale') AND json_extract(ref.value,'$.id')=? LIMIT 1").get(e.scope,e.epoch,e.id)
      if(pending)continue
      const quotes=store.db.prepare('SELECT DISTINCT quote FROM sources WHERE event_id=?').all(e.id).map(r=>r.quote)
      const retained=[...new Set(quotes)].filter((q,i,a)=>!a.some((other,j)=>i!==j&&other.includes(q))).join('\n')
      store.db.prepare('UPDATE events SET body=?,kind=? WHERE id=?').run(retained,'retained:'+e.kind,e.id)
      store.db.prepare('DELETE FROM raw_search WHERE id=?').run(e.id)
      // Retained evidence remains addressable through records/sources, not a fake full transcript.
      expired++
    }
  })
  return {expired}
}
