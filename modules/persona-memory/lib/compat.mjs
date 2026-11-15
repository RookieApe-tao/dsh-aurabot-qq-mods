import { scopeOf } from './policy.mjs'

// Host-only compatibility adapter. A module or explicit chat identifies the destination;
// a person's name is never used to widen a private scope to other conversations.
export function compatibility(service, base, {moduleId='',chatId=''}={}) {
  const bridge=service.bridge
  const dashboard=['starmap','moodboard'].includes(moduleId)&&!chatId
  const dashboardScopes=()=>service.active()?service.store.scopes(bridge.persona()).filter(s=>!s.blocked&&service.allows(s,'recall')):[]
  const target=(about,o={})=>{
    if(!service.active())return null
    const destination=String(o.where||o.chatId||chatId).replace(/（翻记忆）$/,'')
    if(o.memoryScope){service.assertSnapshot(o.memoryScope);if(destination&&destination!==o.memoryScope.audience+':'+o.memoryScope.subject)throw Error('查询目的地与记忆范围不一致');return service.allows(o.memoryScope,'recall')?o.memoryScope:null}
    const id=destination||(about&&/^\d+$/.test(String(about))?'private:'+about:'')||(['purpose','autotelic','beliefs'].includes(moduleId)?'private:'+bridge.ownerQQ():'')
    const m=/^(private|group|system):(.+)$/.exec(id);if(!m)return null
    const found=service.store.getScope(scopeOf({persona:bridge.persona(),audience:m[1],subject:m[2]}).key)
    return found&&!found.blocked&&service.allows(found,'recall')?{...found,generation:service.generation()}:null
  }
  const raw=(about='',o={})=>{const s=target(about,o),subjects=Array.isArray(o.onlyAbout)?o.onlyAbout:Array.isArray(about)?about:[about];return s?service.store.records(s,{query:o.query||'',limit:Math.min(100,o.limit||60)}).filter(r=>service.store.recordAllowed(s,r)&&(!(o.onlyAbout||o.requireAbout)||subjects.map(String).includes(r.subject))&&(!o.excludeAbout||!(Array.isArray(o.excludeAbout)?o.excludeAbout:[o.excludeAbout]).map(String).includes(r.subject))):[]}
  const legacy=r=>({...r,id:r.id,text:r.body,about:r.subject,importance:r.priority,source:r.data?.extractor||'persona-memory',scope:service.store.getScope(r.scope)?.audience,chatId:(()=>{const s=service.store.getScope(r.scope);return s?s.audience+':'+s.subject:''})(),lastHit:r.at,status:r.kind==='day'?'reported':'fact',followUp:r.data?.followUp})
  const visible=r=>!r.data?.suppressed&&!r.data?.legacyProfile
  const list=(about='',o={})=>(dashboard&&!o.where&&!o.chatId&&!o.memoryScope&&!about?dashboardScopes().flatMap(s=>raw('',{...o,memoryScope:{...s,generation:service.generation()}})):raw(about,o)).filter(visible).map(legacy)
  const extraScopes=o=>dashboard?dashboardScopes():[target('',o||{})].filter(Boolean)
  const extras=o=>extraScopes(o).map(s=>service.store.meta('native-extra:'+s.key+':'+s.epoch,{state:{}}).state||{})
  const person=(qq,o={})=>{
    const s=target(qq,o);if(!s)return null
    if(!service.store.actorAllowed(s,qq))return null
    const rows=raw(qq,{...o,onlyAbout:true}),profileId=service.store.db.prepare("SELECT id FROM records WHERE scope=? AND epoch=? AND subject=? AND attribute='legacy-profile' AND state='valid' ORDER BY at DESC LIMIT 1").get(s.key,s.epoch,String(qq))?.id,imported=(profileId?service.store.record(profileId)?.data?.legacyProfile:null)||{}
    const values=Object.fromEntries(rows.filter(r=>r.kind==='fact'&&r.subject===String(qq)&&/^person:/.test(r.attribute)).map(r=>[r.attribute.slice(7),r.value||r.body]))
    const managed=s.audience==='private'&&s.subject===String(qq)?service.store.person(s,String(qq),'private').data:{}
    if(!rows.length&&!Object.keys(imported).length&&!Object.keys(managed).length)return null
    const p={...imported,...values,...managed,qq:String(qq),name:managed.name||values.name||imported.name||String(qq),notes:list(qq,{...o,onlyAbout:true}).length}
    p.tags=Array.isArray(p.tags)?p.tags:[];return p
  }
  const api={...base,
    capabilities:{provider:'persona-memory',contextOwner:true,scopeRequired:true,activityAPI:1,dashboardRead:dashboard,source:'unified-archive'},
    addEvent:o=>o?.memoryScope?base.addEvent(o):moduleId&&bridge.activities?bridge.activities.legacy(moduleId,o||{}):base.addEvent(o),
    forChat:id=>compatibility(service,base,{moduleId,chatId:id}),
    forModule:id=>compatibility(service,base,{moduleId:id}),
    list,
    recall:(query,o={})=>list(o.about||'',{...o,query}).slice(0,Math.min(12,o.limit||8)).map(it=>({it,score:1})),
    recentEvents:(hours=24,limit=20,o={})=>list(o.about||'',o).filter(r=>r.kind==='episode'&&r.at>=service.now()-hours*3600000).slice(0,limit),
    person,
    personaPerson:(qq,o={})=>{const p=person(qq,o);if(!p)return null;const notes=list(qq,o);return {person:p,notes:notes.slice(0,o.notesLimit||20),notesTotal:notes.length,notesLive:notes.length,notesOld:0,relations:[...(p.relations||[]),...raw(qq,o).filter(r=>r.attribute.startsWith('relation:')).map(legacy)],shortTerm:[],gists:notes.filter(r=>['day','month'].includes(r.kind)),insights:[],styles:[]}},
    profiles:()=> (dashboard?dashboardScopes():[target('',{})].filter(Boolean)).filter(s=>s.audience==='private').map(s=>person(s.subject,{memoryScope:{...s,generation:service.generation()}})).filter(Boolean),
    personaOverview:()=>api.profiles().map(p=>({...p,notes:list(p.qq).length})),
    gists:(o={})=>list(o.about||'',o).filter(r=>['day','month','context'].includes(r.kind)).map(r=>({...r,kind:'gist',level:r.kind==='month'?2:1})).filter(r=>o.level==null||o.level===''||String(r.level)===String(o.level)),
    insights:(o={})=>extras(o).flatMap(s=>Object.entries(s.insights||{}).map(([key,list])=>({key,name:s.insightNames?.[key]||'',list}))),
    styles:(o={})=>Object.assign({},...extras(o).map(s=>s.styles||{})),
    dislikes:(qq,o={})=>person(qq,o)?.tags.includes('讨厌')||false,
    topicScore:(query,o={})=>{const s=target('',o);if(!s)return 0;return Math.min(1,raw('',{...o,query}).filter(visible).length/4)},
    dueFollowUp:(qq,at=service.now())=>{const s=target(qq);if(!s)return null;const id=service.store.db.prepare("SELECT id FROM records WHERE scope=? AND epoch=? AND state NOT IN ('invalid','superseded','disputed','completed','cancelled','expired') AND (until_at IS NULL OR until_at>?) AND json_extract(payload,'$.followUp.at')<=? AND COALESCE(json_extract(payload,'$.followUp.tries'),0)<3 AND json_extract(payload,'$.followUp.question')!='' ORDER BY json_extract(payload,'$.followUp.at'),id LIMIT 1").get(s.key,s.epoch,at,at)?.id;return id?legacy(service.store.record(id)):null},
    markFollowUpAsked:(id,at=service.now())=>{const r=service.store.record(id);if(!r)return false;const s=target(r.subject);if(!s||r.scope!==s.key||r.epoch!==s.epoch||api.dueFollowUp(r.subject,at)?.id!==id)return false;const f=r.data.followUp,tries=(f.tries||0)+1;service.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify({...r.data,followUp:tries>=3?null:{...f,tries,at:at+(tries===1?2:5)*86400000}}),id);return true},
  }
  return api
}
