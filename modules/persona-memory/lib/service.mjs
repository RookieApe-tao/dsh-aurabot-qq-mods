import {describeScope,queueHealth} from './presentation.mjs'
import { existsSync } from 'node:fs'
import { MemoryStore } from './store.mjs'
import { ResetCoordinator } from './reset.mjs'
import { MemoryWorker } from './worker.mjs'
import { recall } from './recall.mjs'
import {activityCandidates} from './activity.mjs'
import { DEFAULTS, settings, preset, uid, required, hash, permits, estimateTokens } from './policy.mjs'

export const REQUIRED_CAPABILITIES = Object.freeze([
  'single-provider', 'persona-scope', 'incoming-message-id', 'confirmed-delivery',
  'request-context-replace', 'request-usage', 'session-boundary', 'legacy-import',
  'legacy-replay-cutoff', 'reset-participants', 'inflight-fence',
])

export class MemoryService {
  constructor({file,readSettings=()=>DEFAULTS,writeSettings=()=>{},bridge=null,now=Date.now,model=null}={}) {
    this.file=file;this.readSettings=readSettings;this.writeSettings=writeSettings;this.bridge=bridge;this.now=now;this.model=model
    this._store=null;this._worker=null;this.started=false;this.busy=false;this.disposed=false
    // No database, hook, timer, model or legacy API is touched by a never-enabled constructor.
  }
  get store(){ if(!this._store)this._store=new MemoryStore(this.file,{now:this.now});return this._store }
  config(){return settings(this.readSettings())}
  lifecycle(){return (this._store || (this.file && existsSync(this.file))) ? this.store.meta('lifecycle',{state:'never',generation:0}) : {state:'never',generation:0}}
  generation(){return this.lifecycle().generation}
  active(){return !this.disposed && this.started && this.config().enabled && this.lifecycle().state==='active'}
  assertActive(){if(!this.active())throw new Error('长期记忆尚未启用或正在暂停');if(this.store.meta('management-sync'))throw Error('资料已保存，上下文清理待恢复')}
  state(){
    const life=this.lifecycle()
    const zero={attempts:0,inputTokens:0,outputTokens:0}
    const queue=this._store?this.store.db.prepare('SELECT status,COUNT(*) count,MIN(created_at) oldest FROM jobs GROUP BY status').all():[],budget=this._store?this.store.budgetStatus(this.config()):null
    return {settings:this.config(),presets:{balanced:preset('balanced'),economy:preset('economy')},health:queueHealth(queue,budget||{}),compatibility:this.bridge?.compatibilityStatus?.()||null,lifecycle:life,active:this.active(),scopes:this._store ? this.store.scopes().map(s=>({...s,...describeScope(s,this.store.person(s).data),counts:this.store.statistics(s)})):[],usage:this._store ? this.store.usage():zero,nativeUsage:this._store?this.store.usage(undefined,'native'):zero,budget,chatUsage:this._store?this.store.usage(undefined,'chat'):zero,gameplayUsage:this._store?this.store.usage(undefined,'gameplay'):zero,queue,archiveGap:this._store?this.store.meta('archive-gap'):null,capabilities:this.preflight(),pendingResets:this._store ? this.resetter().pending():[]}
  }
  preflight(){
    const supported=new Set(Array.isArray(this.bridge?.capabilities) ? this.bridge.capabilities : [])
    const missing=REQUIRED_CAPABILITIES.filter(c=>!supported.has(c))
    for(const method of ['prepare','activate','pause','currentScope','resetParticipants']) if(typeof this.bridge?.[method]!=='function')missing.push('接口:'+method)
    return {ready:missing.length===0 && this.bridge?.api===1,missing,api:this.bridge?.api || 0}
  }
  save(input){
    if(Object.hasOwn(input,'enabled') && input.enabled!==this.config().enabled)throw new Error('请使用页首开启操作，保存设置不会启用模块')
    const allowed=Object.fromEntries(Object.entries(input).filter(([key])=>Object.hasOwn(DEFAULTS,key) && key!=='enabled'))
    if(allowed.mode && allowed.mode!=='custom' && !Object.keys(allowed).some(k=>['ordinaryTokens','explicitTokens','extraAttempts','dailyInputTokens','dailyOutputTokens','maxOutputTokens'].includes(k))) Object.assign(allowed,preset(allowed.mode))
    else if(Object.keys(allowed).some(k=>['ordinaryTokens','explicitTokens','extraAttempts','dailyInputTokens','dailyOutputTokens','maxOutputTokens'].includes(k)))allowed.mode='custom'
    const next=settings({...this.config(),...allowed})
    const visibility=['recordGroups','recallGroups','groupList','privateList','recallGroupList','recallPrivateList']
    if(this.active()&&visibility.some(k=>next[k]!==this.config()[k]))this.store.setMeta('lifecycle',{...this.lifecycle(),generation:this.generation()+1})
    this.writeSettings(next);if(this._store)this.store.db.prepare("DELETE FROM meta WHERE key LIKE 'job-wait:%'").run();return next
  }
  async prepareActivation({mode='continue'}={}){
    if(!['continue','new'].includes(mode))throw new Error('未知接续模式')
    const check=this.preflight()
    if(!check.ready)throw new Error('宿主接管适配未完成：'+check.missing.join('、'))
    if(this.busy || this.disposed)throw new Error('模块正在处理其他操作')
    if(this.lifecycle().state==='active')throw new Error('已经启用')
    const preview=await this.bridge.prepare({mode,lifecycle:this.lifecycle()})
    if(!preview?.verified || !preview.id)throw new Error('宿主未完成接续预检')
    const token=uid(),payload={mode,previewId:preview.id,generation:this.generation()}
    this.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'activation',hash(payload),JSON.stringify(payload),this.now()+300000)
    return {token,mode,impact:preview.impact || [],expiresAt:this.now()+300000}
  }
  async activate(token){
    if(this.busy || this.disposed)throw new Error('模块正在处理其他操作')
    if(!this.preflight().ready)throw new Error('宿主接管适配不完整')
    const p=this.store.db.prepare('SELECT * FROM previews WHERE token=? AND kind=?').get(required(token),'activation')
    if(!p || p.expires_at<this.now())throw new Error('开启预检已过期')
    const data=JSON.parse(p.payload),before=this.lifecycle()
    if(data.generation!==before.generation)throw new Error('模块状态已变化，请重新预检')
    this.busy=true
    this.store.setMeta('lifecycle',{...before,state:'preparing',generation:before.generation+1,operation:uid()})
    try{
      const result=await this.bridge.activate({previewId:data.previewId,mode:data.mode,service:this,operation:this.lifecycle().operation,lifecycle:before})
      if(!result?.verified || result.singleProvider!==true)throw new Error('尚未确认原生与跨会话旧链退出')
      this.writeSettings({...this.config(),enabled:true})
      this.store.setMeta('lifecycle',{state:'active',generation:this.generation(),managed:true})
      this.store.db.prepare('DELETE FROM previews WHERE token=?').run(token)
      this.started=true
      this.store.db.prepare("UPDATE jobs SET status='pending',generation=? WHERE status='paused'").run(this.generation())
      return this.state()
    }catch(error){
      // Keep the durable operation state. Only the host's recovery protocol can determine
      // whether its cutover happened; blindly returning to the old provider can resurrect data.
      this.started=false
      this.store.setMeta('lifecycle',{...this.lifecycle(),state:'recovery',error:String(error.message).slice(0,300)})
      throw error
    }finally{this.busy=false}
  }
  async resume(){
    const life=this.lifecycle()
    if(!this.config().enabled || life.state==='never')return {status:'disabled'}
    if(!this.preflight().ready)throw new Error('宿主适配不完整，记忆未恢复')
    if(life.state!=='active')return {status:'recovery-required'}
    const result=await this.bridge.activate({resume:true,service:this,lifecycle:life})
    if(!result?.verified || !result.singleProvider)throw new Error('无法确认单一记忆服务')
    this.started=true;this.store.db.prepare("UPDATE jobs SET status='pending',generation=? WHERE status='paused'").run(this.generation());return {status:'active'}
  }
  async pause(){
    const life=this.lifecycle()
    if(life.state==='never'){this.writeSettings({...this.config(),enabled:false});return this.state()}
    if(this.busy)throw new Error('模块正在切换')
    this.busy=true;this.started=false
    this.store.setMeta('lifecycle',{...life,state:'pausing',generation:life.generation+1})
    this._worker?.cancel()
    for(const c of this.auxControllers||[])c.abort()
    this.writeSettings({...this.config(),enabled:false})
    try{
      const result=await this.bridge?.pause?.({generation:this.generation()})
      if(!result?.verified || !result.contextCleared)throw new Error('宿主尚未撤下旧上下文，正在停用')
      this.store.db.prepare("UPDATE jobs SET status='paused',error='paused' WHERE status='pending'").run()
      this.store.setMeta('lifecycle',{state:'paused',generation:this.generation(),managed:true,pausedAt:this.now()})
      return this.state()
    }finally{this.busy=false}
  }
  scope(input){this.assertActive();return {...this.store.scope(input),generation:this.generation()}}
  allows(scope,operation='recall'){return permits(this.config(),scope,operation)&&this.store.scopeAllowed(scope)}
  async auxAsk(opts={}){
    this.assertActive();const generation=this.generation(),persona=this.bridge.persona(),cfg=this.config(),id=uid(),controller=new AbortController()
    const input={task:'role-opinion',instruction:String(opts.system||''),text:String(opts.text||'')},maxOutputTokens=Math.min(cfg.maxOutputTokens,Number(opts.maxTokens)||cfg.maxOutputTokens)
    this.store.reserveUsage({id,category:'role-opinion',inputTokens:estimateTokens(JSON.stringify(input)),outputTokens:maxOutputTokens,limits:cfg})
    this.auxControllers ||= new Set();this.auxControllers.add(controller);let timer
    try{
      const response=await Promise.race([this.model({input,maxOutputTokens,requestId:id,signal:controller.signal}),new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Error('观点整理中止，结果未知')),{once:true});timer=setTimeout(()=>{controller.abort();reject(Error('观点整理超时，结果未知'))},60000)})])
      this.store.settleUsage(id,'complete',response.usage||{});this.assertActive();if(generation!==this.generation()||persona!==this.bridge.persona())throw Error('人格或记忆已变化，旧观点未提交')
      return response.output
    }catch(e){if(this.store.db.prepare('SELECT state FROM usage WHERE id=?').get(id)?.state==='reserved')this.store.settleUsage(id,'unknown');throw e}
    finally{clearTimeout(timer);this.auxControllers.delete(controller);this.finishClose?.()}
  }
  assertSnapshot(snapshot){this.assertActive();if(snapshot.generation!==this.generation())throw new Error('旧运行实例的结果已失效');this.store.assertScope(snapshot)}
  ingest(snapshot,event){this.assertSnapshot(snapshot);if(!this.allows(snapshot,'record')||!this.store.actorAllowed(snapshot,event.actor))throw new Error('当前范围或人物已停止记录');return this.store.ingest(snapshot,event)}
  remember(snapshot,record){this.assertSnapshot(snapshot);if(!this.allows(snapshot,'record')||!this.store.actorAllowed(snapshot,record.subject))throw new Error('当前范围或人物已停止记录');return this.store.putRecord(snapshot,record)}
  async invalidateSessions(scopes){
    this.store.setMeta('lifecycle',{...this.lifecycle(),generation:this.generation()+1})
    this._worker?.cancel()
    for(const c of this.auxControllers||[])c.abort()
    if(this.lifecycle().managed)await this.bridge.clearSessions?.({scopes,resetId:'revision-'+uid()})
  }
  recall(snapshot,input){this.assertSnapshot(snapshot);if(!this.allows(snapshot,'recall'))return {status:'excluded',items:[],text:'',estimatedTokens:0};return recall(this.store,snapshot,{...input,extraCandidates:activityCandidates(this.store,snapshot,input.query,{ownerQQ:this.bridge?.ownerQQ?.()||''}),settings:this.config(),now:this.now()})}
  previewRetry(){
    this.assertActive();const persona=this.bridge.persona(),jobs=[];let skipped=0
    for(const j of this.store.db.prepare("SELECT j.* FROM jobs j JOIN scopes s ON j.scope=s.key AND j.epoch=s.epoch WHERE s.persona=? AND s.blocked=0 AND j.status IN ('failed','unknown','stale') ORDER BY j.created_at LIMIT 100").all(persona)){
      try{const s=this.store.getScope(j.scope);this.store.evidence(s,JSON.parse(j.payload).sources);jobs.push({id:j.id,scope:j.scope,epoch:j.epoch,revision:s.revision,fingerprint:j.fingerprint,status:j.status})}catch{skipped++}
    }
    const token=uid(),payload={persona,generation:this.generation(),jobs};this.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'retry',hash(payload),JSON.stringify(payload),this.now()+300000)
    return {token,count:jobs.length,skipped,warning:'只重新安排这些失败或结果未知的记忆整理，不重做外部玩法。未知请求可能已收费；新尝试仍占用今天剩余额度。'}
  }
  retryJobs(data){
    this.assertActive();const p=this.store.db.prepare("SELECT * FROM previews WHERE token=? AND kind='retry'").get(required(data.token));if(!p||p.expires_at<this.now()||data.confirm!==true)throw Error('重试预览过期或未确认');const plan=JSON.parse(p.payload)
    if(plan.persona!==this.bridge.persona()||plan.generation!==this.generation())throw Error('人格或引擎已变化，请重新预览')
    this.store.transaction(()=>{for(const old of plan.jobs){const j=this.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(old.id),s=this.store.getScope(old.scope);if(!j||j.status!==old.status||j.fingerprint!==old.fingerprint||s.epoch!==old.epoch||s.revision!==old.revision)throw Error('任务或来源已变化，请重新预览');this.store.evidence(s,JSON.parse(j.payload).sources);this.store.db.prepare("UPDATE jobs SET status='pending',generation=?,request_id=NULL,error='' WHERE id=?").run(this.generation(),j.id)}this.store.db.prepare('DELETE FROM previews WHERE token=?').run(data.token)})
    return {queued:plan.jobs.length}
  }
  resetter(){return new ResetCoordinator(this.store,{participants:this.bridge?.resetParticipants?.() || [],now:this.now})}
  async previewReset(selection){
    if(this.lifecycle().managed && !this.preflight().ready)throw new Error('缺少宿主清理适配，不能声称完整重置')
    return this.resetter().preview(selection)
  }
  async reset(token){
    const result=await this.resetter().execute(token)
    return {...result,extent:this.lifecycle().managed?'host-and-module':'module-only'}
  }
  worker(){
    if(!this._worker)this._worker=new MemoryWorker(this.store,{getSettings:()=>this.config(),getGeneration:()=>this.generation(),active:()=>this.active(),model:this.model,now:this.now})
    return this._worker
  }
  dispose(){
    this.disposed=true;this.started=false
    const close=()=>{if(this._worker?.busy||this.auxControllers?.size)return;this._store?.close();this._store=null}
    this.finishClose=close
    for(const c of this.auxControllers||[])c.abort()
    if(this._worker?.busy){this._worker.onIdle=close;this._worker.cancel();return false}
    if(this.auxControllers?.size)return false
    close();return true
  }
}
