import {required,dayKey} from './policy.mjs'
import {inputSQL,outputSQL} from './usage.mjs'

export function archiveOverview(management,data={}){
 const store=management.store,s=data.scopeKey?management.selected(data):null,persona=s?.persona||required(data.persona),scopes=s?[s]:store.scopes(persona),scopeKeys=new Set(scopes.map(x=>x.key)),people=[],groups=[],relations=[],impressions=[],pending=[]
 for(const scope of scopes){
  const p=store.person(scope),extra=store.meta('native-extra:'+scope.key+':'+scope.epoch)?.state||{}
  const persons=store.db.prepare("SELECT actor,COUNT(*) messages,MAX(at) lastAt FROM events WHERE scope=? AND epoch=? AND role='user' AND withdrawn=0 GROUP BY actor ORDER BY lastAt DESC LIMIT 100").all(scope.key,scope.epoch)
  for(const person of persons){const profile=scope.audience==='private'&&person.actor===scope.subject?p.data:extra.profiles?.[person.actor]||{};people.push({scopeKey:scope.key,epoch:scope.epoch,audience:scope.audience,subject:person.actor,name:profile.name||profile.alias||person.actor,...person,stopped:!store.actorAllowed(scope,person.actor)})}
  if(scope.audience==='private'&&!persons.some(x=>x.actor===scope.subject))people.push({scopeKey:scope.key,epoch:scope.epoch,audience:'private',subject:scope.subject,name:p.data.name||p.data.alias||scope.subject,messages:0,stopped:!store.scopeAllowed(scope)})
  if(scope.audience==='group')groups.push({scopeKey:scope.key,epoch:scope.epoch,id:scope.subject,...p.data,...extra.chats?.['group:'+scope.subject]})
  for(const relation of [...(p.data.relations||[]),...(extra.relations||[])])relations.push({scopeKey:scope.key,value:relation})
  for(const type of ['shortTerm','insights','styles'])if(extra[type])impressions.push({scopeKey:scope.key,type,value:extra[type]})
  for(const r of store.db.prepare("SELECT id,state,body,at,until_at FROM records WHERE scope=? AND epoch=? AND kind='promise' AND state NOT IN ('completed','cancelled','expired','invalid','superseded') ORDER BY at DESC LIMIT 20").all(scope.key,scope.epoch))pending.push({...r,scopeKey:scope.key})
 }
 return {people,groups,relations,impressions,pending,scopeCount:scopeKeys.size}
}
export function archiveMetrics(management){
 const store=management.getStore();if(!store)return {available:false}
 const since=store.now()-7*86400000,db=store.db,usage=db.prepare(`SELECT day,CASE WHEN category IN ('chat','gameplay','native-memory') THEN category ELSE 'background' END category,COUNT(*) attempts,SUM(${inputSQL}) inputTokens,SUM(${outputSQL}) outputTokens,SUM(state='unknown') unknown FROM usage WHERE day>=? GROUP BY day,CASE WHEN category IN ('chat','gameplay','native-memory') THEN category ELSE 'background' END ORDER BY day DESC LIMIT 90`).all(dayKey(since))
 const repeats=db.prepare("SELECT SUM(n) messages,SUM(CASE WHEN n>1 THEN n-1 ELSE 0 END) repeated FROM (SELECT COUNT(*) n FROM events e JOIN scopes s ON s.key=e.scope AND s.epoch=e.epoch WHERE e.role='assistant' AND e.withdrawn=0 AND e.at>=? GROUP BY e.body)").get(since)
 const capacity=db.prepare("SELECT COUNT(*) events,COALESCE(SUM(length(CAST(body AS BLOB))),0) rawBytes,SUM(withdrawn=1) withdrawn FROM events").get()
 const capacityTrend=db.prepare("SELECT strftime('%Y-%m-%d',at/1000,'unixepoch','+8 hours') day,COUNT(*) events,SUM(length(CAST(body AS BLOB))) bytes FROM events WHERE at>=? AND withdrawn=0 GROUP BY day ORDER BY day DESC").all(since)
 return {available:true,usage,capacityTrend,capacityTrendRule:'近7天新增来源，按当前仍保留的归档统计；不冒充历史磁盘快照。删除或原文到期会改变此统计。',capacity:{...capacity,records:db.prepare('SELECT COUNT(*) n FROM records').get().n,databaseBytes:db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size},repeat:{messages:repeats.messages||0,repeated:repeats.repeated||0,rule:'近7天完全相同的已发送文本，仅作重复提示，不提升记忆重要性；不同措辞的重复需人工判断。'},queue:db.prepare('SELECT status,COUNT(*) n,MIN(created_at) oldest FROM jobs GROUP BY status').all(),lastError:store.meta('last-worker-error')||store.meta('archive-gap'),rule:'本地记账覆盖受管聊天、系统玩法和额外记忆调用；第三方自带的直接API费用请结合Aurabot总用量，不能把此表当全部账单。'}
}
export function recordDiagnostics(store,s,r){const reasons=[]
 if(!store.scopeAllowed(s)||!store.recordAllowed(s,r))reasons.push('此范围或人物已停止供角色回忆')
 if(r.data.suppressed)reasons.push('不主动提及')
 if(['invalid','superseded','disputed'].includes(r.state))reasons.push('已过时、失效或待核对')
 if(r.until_at&&r.until_at<=store.now())reasons.push('已到有效期')
 if((r.body.length>200&&!['day','month','context'].includes(r.kind))||r.data.nativeArchive)reasons.push('原生模式仅存档；增强模式仍按适用条件检索')
 if(r.data.activity)reasons.push('动作结果：'+r.data.activity.status+'；'+(r.data.activity.coverage||'未声明内容覆盖范围'))
 return {reasons,eligible:store.recordAllowed(s,r),lastRecall:store.meta('recall-diagnostic:'+s.key+':'+s.epoch),activity:r.data.activity||null}
}
