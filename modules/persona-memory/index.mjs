import { MemoryService } from './lib/service.mjs'
import { DEFAULTS, required } from './lib/policy.mjs'
import { MemoryManagement } from './lib/management.mjs'
import { MemoryRuntime } from './lib/runtime.mjs'
import { LegacyMigration } from './lib/legacy.mjs'
import { memoryFacade } from './lib/facade.mjs'

export default {
  id:'persona-memory',name:'人设记忆管理',version:'0.1.0',api:1,
  description:'整理长期聊天与角色经历，按需回忆、减少重复上下文，支持查看编辑和保留人设重置。与「跨会话记忆」互斥，需完整适配包。问题反馈：QQ1365641547。',
  panel:'panel.js',defaults:DEFAULTS,settings:[],flag:'enabled',
  setup(api){
    // The bridge is an explicit supported host contract, not an attempt to monkey-patch
    // arbitrary live memory methods. No consumer hook is installed while disabled.
    const service=new MemoryService({
      file:api.dataDir('memory.sqlite'),readSettings:()=>api.settings(),writeSettings:value=>api.saveSettings(value),
      bridge:api.core.personaMemoryBridge || null,
      model:api.core.personaMemoryBridge?.model,
    })
    const runtime=new MemoryRuntime(service),bridge=api.core.personaMemoryBridge
    let migration
    if(bridge?.bind){
      migration=new LegacyMigration({root:bridge.root,dir:api.dataDir('legacy'),service})
      bridge.bind(service,runtime,memoryFacade(service))
      const dependent=id=>({id,version:1,
        preview:()=>{const m=api.use(id);return {supported:!m||m.memoryResetAPI===1,reason:'关联模块未安装记忆重置适配'}},
        activate:args=>{const m=api.use(id);return m?.memoryTakeover?.(args)},
        clear:args=>{const m=api.use(id);if(!m)return {verified:true};if(m.memoryResetAPI!==1)throw new Error('缺少关联模块重置适配：'+id);return m.memoryReset(args)},
      })
      bridge.configure({migration,participants:[{id:'host-sessions',version:3,preview:(scopes,selection)=>bridge.previewSessionReset(scopes,selection),validatePreview:(preview,scopes,selection)=>bridge.validateSessionReset(preview,scopes,selection),clear:args=>bridge.clearSessions(args)},{id:'auxiliary-state',version:1,preview:()=>({supported:true,impact:'所涉角色的心情、夜间状态和自驱笔记一并重新开始；这些旧模块不能按单个聊天精确分离。配置保留，旧资料隔离，不再供角色读取。'}),clear:args=>bridge.clearAuxiliary(args)},dependent('character-photo'),dependent('diary')]})
    }
    const management=bridge?.management || new MemoryManagement({getStore:()=>service._store,currentPersona:()=>bridge?.persona?.()||'',ownerQQ:()=>bridge?.ownerQQ?.()||'',invalidate:scopes=>service.invalidateSessions(scopes)})
    const http=api.core.http
    const action=fn=>async req=>{
      if(req.method!=='POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || ''))return {ok:false,message:'请从管理页操作'}
      try{
        const bytes=await http.raw(req,128*1024),data=JSON.parse(bytes.toString('utf8'))
        if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('参数格式不正确')
        return {ok:true,...await fn(data)}
      }catch(error){return {ok:false,message:String(error.message).slice(0,400)}}
    }
    const route=(path,handler)=>api.route(path,handler,{access:'panel'})
    const selected=data=>{
      const scope=service.store.getScope(required(data.scopeKey))
      if(!scope)throw new Error('请先选择已有互动范围')
      if(data.epoch!==scope.epoch)throw new Error('资料已重新开始，请刷新')
      return scope
    }
    route('/state',()=>{let personas=[];try{personas=api.lib('persona/personas.js').listPersonas().map(({id,name})=>({id,name}))}catch{}return {ok:true,...service.state(),currentPersona:bridge?.persona?.()||'',personas}})
    route('/save',action(data=>({settings:service.save(data)})))
    route('/prepare',action(data=>service.prepareActivation(data)))
    route('/activate',action(data=>service.activate(data.token)))
    route('/pause',action(()=>service.pause()))
    route('/native-preview',action(()=>bridge.prepareNative()))
    route('/retry-preview',action(()=>service.previewRetry()))
    route('/retry',action(data=>service.retryJobs(data)))
    route('/native-activate',action(data=>bridge.activateNative(data.token)))
    route('/organize',action(()=>{service.assertActive();return runtime.schedule({force:true})}))
    route('/legacy',()=>({ok:true,...(migration?.list()||{snapshot:null,chats:[]})}))
    route('/legacy-import',action(data=>{if(!migration)throw new Error('宿主未安装迁移适配');service.assertActive();return migration.importChat(data)}))
    route('/search',action(data=>management.list({...data,status:'all'})))
    route('/archive',action(data=>{const r=management.list({...data,layer:'raw'});return {...r,events:r.items}}))
    route('/sources',action(data=>management.detail(data)))
    route('/pin',action(data=>management.mark({...data,action:'pin',value:data.pinned})))
    route('/correct',action(data=>management.edit(data)))
    route('/suppress',action(data=>management.mark({...data,action:'suppress',value:data.suppressed})))
    route('/export',action(data=>management.export(data)))
    route('/forget-preview',action(data=>management.forgetPreview(data)))
    route('/forget',action(data=>management.forget(data)))
    route('/reset-preview',action(data=>service.previewReset({scopeKey:data.scopeKey,persona:data.persona,all:data.all===true,archiveWindows:data.archiveWindows===true})))
    route('/reset',action(data=>service.reset(data.token)))
    route('/reset-resume',action(data=>service.resetter().resume(required(data.id))))
    // Resume only a previously active validated installation. An enabled setting by itself
    // is insufficient to silently take over a never-initialized system.
    if(api.settings().enabled===true)service.resume().catch(error=>api.log.warn('记忆尚未恢复：'+error.message))
    if(api.tool&&api.defineTool)api.tool(({sessionId})=>!service.active()||!runtime.session(sessionId)?.snapshot||runtime.session(sessionId).snapshot.audience==='system'?[]:[api.defineTool({name:'persona_memory_recall',description:'按当前人格和聊天范围查以前的互动。可选原话、日摘要或月印象。返回未命中或故障时不得编造。多次读取共享本轮额度。',properties:{query:{type:'string'},layer:{type:'string',enum:['records','raw','day','month']},before:{type:'object',properties:{at:{type:'number'},id:{type:'string'}}}},execute:async args=>{try{return runtime.history(sessionId,args)}catch(error){return {status:'unavailable',message:error.message}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]})])
    if(api.tool&&api.defineTool)api.tool(({sessionId})=>!service.active()||!runtime.session(sessionId)?.snapshot||runtime.session(sessionId).snapshot.audience==='system'?[]:[api.defineTool({name:'persona_memory_note',description:'用户明确要记住或给出重要的新偏好时，保存最近用户原话。不要逐轮调用、保存AI自述或重复已有记忆。只保留原话中的否定和条件；冲突时先查来源，不能自行覆盖。',properties:{quote:{type:'string'},attribute:{type:'string'},value:{type:'string'},kind:{type:'string',enum:['fact','episode']},domain:{type:'string',enum:['real','roleplay','reported']}},execute:async args=>{try{return runtime.remember(sessionId,args)}catch(error){return {status:'not-saved',message:error.message}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]})])
    return { service, runtime, memoryAPI:1, dispose:()=>{bridge?.unbind?.(service);runtime.stop();return service.dispose()} }
  },
}
