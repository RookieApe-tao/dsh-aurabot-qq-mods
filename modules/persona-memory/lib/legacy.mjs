import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hash, uid } from './policy.mjs'
import { importPage } from './transfer.mjs'

const sources=[['native','memory.sqlite'],['vault','modules-data/history-vault/vault.sqlite']]
function inspect(file,kind){
  if(!existsSync(file))return {present:false,count:0}
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name))
    const expected=kind==='vault'?['vault_lines','vault_days','vault_months']:['items','gists','kv','meta']
    if(expected.some(t=>!tables.has(t)))throw new Error('旧库结构变化，请更新迁移适配')
    const counts=Object.fromEntries(expected.map(t=>[t,db.prepare('SELECT COUNT(*) n FROM '+t).get().n]))
    return {present:true,counts,count:Object.values(counts).reduce((a,b)=>a+b,0)}
  }finally{db.close()}
}

/** Consistent snapshots are kept outside live retrieval. Untagged legacy rows are never
 * silently assigned to the current persona; the administrator maps each chat explicitly.
 */
export class LegacyMigration {
  constructor({root,dir,service}){this.root=root;this.dir=dir;this.service=service}
  async preview({mode}){
    const fallback=existsSync(join(this.root,'memories.json'))&&existsSync(join(this.root,'memory-json-fallback.json'))
    const inventory=sources.map(([kind,path])=>({kind,path,...(kind==='native'&&fallback?{present:existsSync(join(this.root,path)),count:0,skip:'json-authoritative'}:inspect(join(this.root,path),kind))}))
    const jsonFiles=['memories.json','memory-json-fallback.json'].filter(f=>existsSync(join(this.root,f)))
    return {mode,inventory,jsonFiles,impact:[mode==='continue'?'旧库先做一致性快照；无人格标记的旧记录待你按聊天指定归属后导入。':'新互动从空白开始，不整理旧历史。',`旧库 ${inventory.reduce((a,b)=>a+b.count,0)} 条；旧 JSON ${jsonFiles.length} 份。旧备份隔离保存，不参与角色召回。`]}
  }
  async commit(preview){
    const previous=this.service.store.meta('legacy-snapshot',null)
    if(previous)return previous
    const id=uid(),dest=join(this.dir,id);mkdirSync(dest,{recursive:true})
    const report={id,mode:preview.mode,at:Date.now(),files:[],mapping:[],status:'snapshotting'}
    writeFileSync(join(dest,'manifest.json'),JSON.stringify(report,null,2))
    for(const [kind,path]of sources){
      const source=join(this.root,path);if(!existsSync(source)||preview.inventory.find(r=>r.kind===kind)?.skip)continue
      const db=new DatabaseSync(source,{readOnly:true}),target=join(dest,kind+'.sqlite')
      try{await backup(db,target)}finally{db.close()}
      report.files.push({kind,name:kind+'.sqlite',sha256:hash(readFileSync(target).toString('base64')),...inspect(target,kind)})
    }
    for(const name of preview.jsonFiles){const bytes=readFileSync(join(this.root,name));writeFileSync(join(dest,name),bytes);report.files.push({kind:'legacy-json',name,sha256:hash(bytes.toString('base64'))})}
    report.status='quarantined';writeFileSync(join(dest,'manifest.json'),JSON.stringify(report,null,2))
    this.service.store.setMeta('legacy-snapshot',report)
    return report
  }
  list(){
    const report=this.service.store.meta('legacy-snapshot',null)
    if(!report)return {snapshot:null,chats:[]}
    const file=join(this.dir,report.id,'vault.sqlite')
    const chats=[]
    if(existsSync(file)){const db=new DatabaseSync(file,{readOnly:true});try{chats.push(...db.prepare('SELECT chatId,COUNT(*) count,MIN(t) first,MAX(t) last FROM (SELECT chatId,t FROM vault_lines UNION ALL SELECT chatId,updatedAt t FROM vault_days UNION ALL SELECT chatId,updatedAt t FROM vault_months) GROUP BY chatId').all().map(r=>({...r,source:'vault'})))}finally{db.close()}}
    const native=join(this.dir,report.id,'native.sqlite'),json=join(this.dir,report.id,'memories.json'),fallback=existsSync(json)&&(existsSync(join(this.dir,report.id,'memory-json-fallback.json'))||!existsSync(native))
    if(fallback){const state=JSON.parse(readFileSync(json,'utf8'));for(const name of ['items','gists']){const groups=new Map();for(const row of state[name]||[]){const key=row.chatId||'unassigned';groups.set(key,(groups.get(key)||0)+1)}for(const [chatId,count]of groups)chats.push({source:'json-'+name,chatId,count})}}
    else if(existsSync(native)){const db=new DatabaseSync(native,{readOnly:true});try{for(const table of ['items','gists'])chats.push(...db.prepare("SELECT COALESCE(NULLIF(json_extract(json,'$.chatId'),''),'unassigned') chatId,COUNT(*) count FROM "+table+' GROUP BY chatId').all().map(r=>({...r,source:table})))}finally{db.close()}}
    for(const qq of Object.keys(this.profiles(report).profiles))chats.push({source:'profiles',chatId:'private:'+qq,count:1})
    return {snapshot:report,chats}
  }
  profiles(report){
    const base=join(this.dir,report.id),json=join(base,'memories.json'),native=join(base,'native.sqlite')
    if(existsSync(json)&&(existsSync(join(base,'memory-json-fallback.json'))||!existsSync(native))){const s=JSON.parse(readFileSync(json,'utf8'));return {profiles:s.profiles||{},relations:s.relations||[]}}
    if(!existsSync(native))return {profiles:{},relations:[]}
    const db=new DatabaseSync(native,{readOnly:true});try{const get=k=>{const r=db.prepare('SELECT json FROM kv WHERE key=?').get(k);return r?JSON.parse(r.json):null};return {profiles:get('profiles')||{},relations:get('relations')||[]}}finally{db.close()}
  }
  importChat({chatId,targetChatId,source='vault',persona,confirmed=false,expectedEpoch,cursor=0}){
    if(!confirmed)throw new Error('请明确确认这些旧记录属于所选人格')
    const report=this.service.store.meta('legacy-snapshot',null)
    if(!report||report.mode!=='continue')throw new Error('此次开启选择了从头开始，不回填旧记录')
    const match=/^(private|group):([^:]+)$/.exec(chatId==='unassigned'?targetChatId:chatId||'');if(!match)throw new Error('无归属记录需明确指定 private:QQ 或 group:群号')
    const scope=this.service.store.scope({persona,audience:match[1],subject:match[2]})
    if(expectedEpoch!==scope.epoch || scope.cutoff>0)throw new Error('此范围已重新开始，不能再导入旧备份')
    if(source==='profiles'){
      if(scope.audience!=='private')throw Error('人物资料只接入已确认的私聊')
      const state=this.profiles(report),profile=state.profiles[scope.subject];if(!profile)return {done:true,imported:0,cursor:1,scope}
      const relations=state.relations.filter(r=>r.subj_qq===scope.subject||r.obj_qq===scope.subject),value={...profile,relations}
      const result=importPage(this.service.store,scope,{namespace:'profiles:'+report.id,snapshotId:report.id,expectedEpoch:scope.epoch,mappingConfirmed:true,records:[{id:scope.subject,actor:scope.subject,text:'旧人物资料（待核对）：'+JSON.stringify(value),at:Math.min(Number(profile.at)||report.at,report.at),kind:'day',confirmedScope:true,profile:value}],cursor:1});return {...result,done:true,scope}
    }
    const row=r=>({id:r.id,actor:r.about||'legacy',text:r.text||'',at:Number(r.saidAt||r.at)||report.at,kind:'day',confirmedScope:true,followUp:r.followUp,invalid:!r.text||!!r.invalidAt||!!r.deletedAt||!!r.forgottenAt||['invalid','deleted','superseded'].includes(r.status)||(Number(r.validUntil)>0&&Number(r.validUntil)<=this.service.now())})
    if(['json-items','json-gists'].includes(source)){
      const state=JSON.parse(readFileSync(join(this.dir,report.id,'memories.json'),'utf8')),all=(state[source.slice(5)]||[]).filter(r=>(r.chatId||'unassigned')===chatId),rows=all.slice(Number(cursor)||0,(Number(cursor)||0)+200)
      const result=importPage(this.service.store,scope,{namespace:source+':'+report.id,snapshotId:report.id,expectedEpoch:scope.epoch,mappingConfirmed:true,records:rows.map(row),cursor:(Number(cursor)||0)+rows.length})
      return {...result,done:result.cursor>=all.length,scope}
    }
    if(['items','gists'].includes(source)){
      const db=new DatabaseSync(join(this.dir,report.id,'native.sqlite'),{readOnly:true})
      try{
        const rows=db.prepare("SELECT id,json FROM "+source+" WHERE COALESCE(NULLIF(json_extract(json,'$.chatId'),''),'unassigned')=? ORDER BY id LIMIT 200 OFFSET ?").all(chatId,Math.max(0,Number(cursor)||0))
        const result=importPage(this.service.store,scope,{namespace:'native-'+source+':'+report.id,snapshotId:report.id,expectedEpoch:scope.epoch,mappingConfirmed:true,records:rows.map(r=>row({...JSON.parse(r.json),id:r.id})),cursor:Number(cursor)+rows.length})
        return {...result,done:rows.length<200,scope}
      }finally{db.close()}
    }
    if(source!=='vault')throw new Error('未知旧资料层')
    const db=new DatabaseSync(join(this.dir,report.id,'vault.sqlite'),{readOnly:true})
    try{
      const c=typeof cursor==='object'&&cursor?cursor:{layer:'raw',id:Number(cursor)||0},layer=c.layer||'raw'
      if(!['raw','day','month'].includes(layer))throw new Error('无效迁移页')
      if(layer==='raw'){
        const rows=db.prepare('SELECT * FROM vault_lines WHERE chatId=? AND id>? ORDER BY id LIMIT 200').all(chatId,Number(c.id)||0)
        const result=importPage(this.service.store,scope,{namespace:'vault:'+report.id,snapshotId:report.id,expectedEpoch:scope.epoch,mappingConfirmed:true,records:rows.map(r=>({id:String(r.id),actor:r.uid||'legacy',text:r.text,at:r.t,kind:'raw',confirmedScope:true}))})
        const hasSummary=Boolean(db.prepare('SELECT 1 FROM vault_days WHERE chatId=? UNION ALL SELECT 1 FROM vault_months WHERE chatId=? LIMIT 1').get(chatId,chatId))
        return {...result,done:rows.length<200&&!hasSummary,cursor:rows.length<200?{layer:'day',id:''}:{layer:'raw',id:rows.at(-1).id},scope}
      }
      const table=layer==='day'?'vault_days':'vault_months',rows=db.prepare(`SELECT * FROM ${table} WHERE chatId=? AND ${layer}>? ORDER BY ${layer} LIMIT 200`).all(chatId,String(c.id||''))
      const result=importPage(this.service.store,scope,{namespace:table+':'+report.id,snapshotId:report.id,expectedEpoch:scope.epoch,mappingConfirmed:true,records:rows.map(r=>({id:chatId+':'+r[layer],actor:'legacy',text:r.abstract,at:r.updatedAt,kind:layer,confirmedScope:true}))})
      return {...result,done:layer==='month'&&rows.length<200,cursor:rows.length<200?{layer:'month',id:''}:{layer,id:rows.at(-1)[layer]},scope}
    }finally{db.close()}
  }
}
