import { hash } from './policy.mjs'
import { compatibility } from './compat.mjs'

/** Compatibility reads never infer a private scope from a bare person ID. Legacy calls
 * without a captured scope get empty results and cannot contaminate another persona.
 */
export function memoryFacade(service){
  const scoped=o=>{if(!o?.memoryScope)return null;service.assertSnapshot(o.memoryScope);return o.memoryScope}
  const items=o=>{const s=scoped(o);return s?service.store.records(s,{limit:40}):[]}
  const base={
    memoryAPI:1,
    list:(_about,o)=>items(o).map(r=>({...r,text:r.body,about:r.subject})),
    recall:(q,o)=>{const s=scoped(o);return s?service.recall(s,{query:q,explicit:true}).text:''},
    recentEvents:(_hours,_limit,o)=>items(o).filter(r=>r.kind==='episode'),
    topicScore:()=>0,dislikes:()=>false,personaPerson:()=>null,person:()=>null,
    add:()=>({ok:false,message:'请在新记忆管理页添加或纠正；旧接口缺少可信来源。'}),
    async handleCommand(chat,text){
      if(!service.active()||chat?.kind!=='private'||!chat.messageId||chat.chatId!=='private:'+chat.userId)return null
      const m=String(text||'').trim().match(/^(?:请|麻烦|你)?\s*(记住|你要记得|要记得|忘掉|忘记|别记|不要记)(?:[：:,，\s]+)?(.+?)\s*[。！!]*$/s)
      if(!m||m[2].length<3||m[2].length>1200||/密码|口令|验证码|token|api.?key|身份证|银行卡/i.test(m[2]))return null
      const captured=service.bridge.currentScope(chat),s=captured.snapshot;if(!s)return null
      const origin=service.store.db.prepare('SELECT * FROM events WHERE scope=? AND epoch=? AND source_id=? AND role=? AND withdrawn=0').get(s.key,s.epoch,'qq:'+chat.messageId,'user')
      if(!origin||origin.actor!==String(chat.userId)||origin.body!==text)return null
      if(!/^(忘|别|不要)/.test(m[1]))return service.remember(s,{kind:'fact',subject:origin.actor,attribute:'明确记住:'+hash(m[2]).slice(0,16),value:m[2],text:m[2],sources:[{id:origin.id,quote:m[2]}],extractor:'user-command'})
      let count=0
      service.store.transaction(()=>{
        const sources=service.store.db.prepare('SELECT id FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND instr(body,?)>0').all(s.key,s.epoch,m[2])
        for(const e of sources){for(const ref of service.store.db.prepare('SELECT record_id FROM sources WHERE event_id=?').all(e.id)){service.store.forget(s,ref.record_id);count++}service.store.db.prepare("UPDATE events SET body='',withdrawn=1,revision=revision+1 WHERE id=?").run(e.id)}
        service.store.db.prepare("UPDATE events SET body='',withdrawn=1,revision=revision+1 WHERE scope=? AND epoch=? AND kind='protocol'").run(s.key,s.epoch)
        service.store.revision(s.key)
      })
      await service.invalidateSessions([s]);return {ok:true,forgotten:count}
    },
    addEvent:o=>{
      const s=scoped(o)
      if(!s||!o.confirmed||!o.sourceId)return {ok:false,message:'缺少成功结果或隔离范围，未写入互动记忆'}
      const previous=service.store.db.prepare('SELECT at FROM events WHERE scope=? AND epoch=? AND source_id=?').get(s.key,s.epoch,o.sourceId)
      const e=service.ingest(s,{sourceId:o.sourceId,role:'tool',actor:o.actor||'self',text:o.text,at:previous?.at||o.at||service.now(),kind:o.kind||'reported'}).event
      const result=service.remember(s,{kind:'episode',subject:o.actor||'self',attribute:o.kind||'event',value:'',text:o.text,domain:o.domain||'reported',sources:[{id:e.id,quote:e.body}]});return {...result,...result.record,ok:true}
    },
    stats:()=>({provider:'persona-memory',active:service.active()}),
  }
  return compatibility(service,base)
}
