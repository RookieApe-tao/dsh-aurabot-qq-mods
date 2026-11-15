import { DATA_RULE, estimateTokens, terms } from './policy.mjs'

const facts = new Set(['fact','state','promise'])
export function recall(store, snapshot, { query, settings, explicit = false, turn = 0, recent = '', now = Date.now(), maxTokens, tokenCount = estimateTokens, kinds,extraCandidates=[] } = {}) {
  store.assertScope(snapshot)
  const budget = Math.min(maxTokens ?? Infinity, explicit ? settings.explicitTokens : settings.ordinaryTokens)
  const queryTerms = terms(query)
  if (!queryTerms.length) return { status:'no-query',items:[],text:'',estimatedTokens:0,skipped:[] }
  const own = store.records(snapshot,{query,limit:200,at:now}).filter(r=>(!kinds||kinds.includes(r.kind))&&store.recordAllowed(snapshot,r))
  const candidates=[...new Map([...own,...extraCandidates.filter(r=>!kinds||kinds.includes(r.kind))].map(r=>[r.id,r])).values()]
  const recentTerms = new Set(terms(recent)), skipped = []
  const scored = candidates.map(r=>{
    const rterms = terms([r.body,r.subject,r.attribute].join(' ')), overlap = queryTerms.filter(t=>rterms.includes(t)).length
    return { r, score:overlap*5 + r.priority*2 + (r.pinned ? 1 : 0) + (facts.has(r.kind) ? 1 : 0) }
  }).sort((a,b)=>b.score-a.score || b.r.at-a.r.at)
  const output = [], includedSources = new Set()
  const render = rows => DATA_RULE+'\n'+JSON.stringify(rows)
  for (const {r} of scored) {
    const foreign=r.scope!==snapshot.key,exposure='exposure:'+snapshot.key+':'+snapshot.epoch+':'+r.id,lastTurn=foreign?store.meta(exposure,-9999):r.last_turn
    if(!explicit&&r.data.suppressed){skipped.push({id:r.id,reason:'suppressed'});continue}
    const refs = store.sources(r.id)
    if (!refs.length || refs.some(s => {
      const e=store.event(s.event_id)
      return !e || e.withdrawn || e.revision !== s.event_revision
    })) { skipped.push({id:r.id,reason:'invalid-source'}); continue }
    const stable = facts.has(r.kind) && !['completed','cancelled','expired','unknown'].includes(r.state)
    const old = now-r.at > 90*86400000
    if (!explicit && !stable && turn-lastTurn<settings.cooldownTurns) { skipped.push({id:r.id,reason:'cooldown'}); continue }
    if (!explicit && recent && recent.includes(r.value || r.body) && terms(r.body).every(t=>recentTerms.has(t))) { skipped.push({id:r.id,reason:'already-in-context'}); continue }
    // An entire event may be summarized at multiple levels; distinct necessary facts from
    // one utterance remain selectable (a shared source does not make two facts equivalent).
    const coverage = refs.map(s=>s.event_id)
    if (!facts.has(r.kind) && coverage.every(id=>includedSources.has(id))) { skipped.push({id:r.id,reason:'same-source-summary'}); continue }
    const body = !explicit && (foreign||old&&!stable&&!r.pinned&&settings.detail==='natural') && r.summary ? r.summary : r.body
    const item = { id:r.id, kind:r.kind, at:r.at, state:r.state, domain:r.data.domain, text:body }
    if(!explicit&&foreign&&tokenCount(JSON.stringify([...output.filter(x=>candidates.find(c=>c.id===x.id)?.scope!==snapshot.key),item]))>Math.max(180,Math.floor(budget*.5))){skipped.push({id:r.id,reason:'activity-share'});continue}
    if (tokenCount(render([...output,item]))>budget) { skipped.push({id:r.id,reason:'budget'}); continue }
    output.push(item); for(const id of coverage) includedSources.add(id)
  }
  if(explicit&&!kinds){
    for(const e of store.searchEvents(snapshot,{query,limit:20})){
      if(includedSources.has(e.id)||e.kind.startsWith('retained:')||!store.scopeAllowed(snapshot)||!store.sourceAllowed(snapshot,e))continue
      const item={id:e.id,kind:'raw',role:e.role,actor:e.actor,at:e.at,state:'source',domain:e.role==='legacy'?'legacy':'source-only',text:e.body}
      if(tokenCount(render([...output,item]))>budget)continue
      output.push(item);includedSources.add(e.id)
    }
  }
  // Exposure does not modify evidence timestamps, confidence, priority or permanence.
  for(const item of output) if(candidates.find(c=>c.id===item.id)?.scope!==snapshot.key)store.setMeta('exposure:'+snapshot.key+':'+snapshot.epoch+':'+item.id,turn);else store.db.prepare('UPDATE records SET last_turn=? WHERE id=?').run(turn,item.id)
  const rendered = output.length ? render(output) : ''
  store.setMeta('recall-diagnostic:'+snapshot.key+':'+snapshot.epoch,{at:now,status:output.length?'hit':'no-hit',ids:output.map(x=>x.id),estimatedTokens:tokenCount(rendered),skipped:skipped.slice(0,100)})
  return { status:output.length ? 'hit' : 'no-hit',items:output,text:rendered,estimatedTokens:tokenCount(rendered),skipped }
}

export class TurnBudget {
  constructor({ maxRequests = 4, maxInputTokens = 16000, maxOutputTokens = 4000, maxHistoryTokens = 1600, count = estimateTokens } = {}) {
    this.limits = {maxRequests,maxInputTokens,maxOutputTokens,maxHistoryTokens}; this.count=count
    this.requests=0;this.input=0;this.output=0;this.history=0;this.ids=new Set()
  }
  request(id, completeInput, outputAllowance) {
    if(this.ids.has(id)) throw new Error('重复请求ID')
    const size=this.count(completeInput)
    if(this.requests+1>this.limits.maxRequests || this.input+size>this.limits.maxInputTokens || this.output+outputAllowance>this.limits.maxOutputTokens) throw new Error('本回合累计额度不足')
    this.ids.add(id);this.requests++;this.input+=size;this.output+=outputAllowance
    return {inputReserved:size,outputReserved:outputAllowance}
  }
  historyResult(value) {
    const size=this.count(value)
    if(this.history+size>this.limits.maxHistoryTokens) throw new Error('本回合历史读取额度不足')
    this.history+=size; return value
  }
}

export function compactContext({ recent = [], current = [], memories = [], maxTokens, count = estimateTokens }) {
  // Deterministic compaction only: caller-provided validated state; never generates a fact.
  // Do not truncate individual messages or unpair an unfinished tool invocation.
  const selected = [], ids = new Set(), older = [], used = new Set()
  for (let i=recent.length-1;i>=0;i--) {
    const message=recent[i]
    if (!message.id || ids.has(message.id)) continue
    if (message.toolOpen || message.toolResult) throw new Error('工具回合未收束，需宿主提供完整配对后接续')
    const candidate=[message,...selected]
    if(count(JSON.stringify({recent:candidate,current,memories}))>maxTokens) { older.unshift(...recent.slice(0,i+1)); break }
    ids.add(message.id);selected.unshift(message)
  }
  const filtered=memories.filter(m=>{
    const signature=m.id || m.text
    if(used.has(signature) || selected.some(s=>s.text===m.text) || current.some(s=>s.id===m.id)) return false
    used.add(signature);return true
  })
  const result={recent:selected,current,memories:filtered}
  if(count(JSON.stringify(result))>maxTokens) throw new Error('关键状态超出上下文预算，需有界接续')
  return { ...result, archiveBeforeDrop:older, estimatedTokens:count(JSON.stringify(result)) }
}
