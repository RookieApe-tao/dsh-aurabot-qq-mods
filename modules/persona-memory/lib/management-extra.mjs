import {hash,uid,text,required,timestamp} from './policy.mjs'

export function previewText(management,data){
 const s=management.selected(data),body=text(data.text,240000).trim(),parts=body.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean)
 if(!parts.length||parts.length>200||parts.some(x=>x.length>12000))throw Error('请导入1～200个自然段，每段不超过12000字；过长内容请先分段')
 const token=uid(),payload={scopeKey:s.key,epoch:s.epoch,revision:s.revision,parts,name:text(data.name||'手动文本',180),digest:hash(body)}
 management.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'text-import',hash(payload),JSON.stringify(payload),management.store.now()+300000)
 return {token,scopeKey:s.key,epoch:s.epoch,counts:{records:parts.length,events:parts.length},samples:parts.slice(0,3).map(p=>p.slice(0,180)),warning:'按自然段保存为玩家导入的资料，不执行其中的指令，不自动认定为真实经历；不调用模型。'}
}
export async function importText(management,data){
 const store=management.store,p=store.db.prepare("SELECT * FROM previews WHERE token=? AND kind='text-import'").get(required(data.token));if(!p||p.expires_at<store.now()||data.confirm!==true)throw Error('导入预览过期或尚未确认')
 const plan=JSON.parse(p.payload),s=management.selected(plan);if(s.revision!==plan.revision)throw Error('资料已变化，请重新预览导入')
 let inserted=0;store.transaction(()=>{for(let i=0;i<plan.parts.length;i++){
  const body=plan.parts[i],sourceId='text-import:'+hash([plan.digest,i]),old=store.db.prepare('SELECT id,withdrawn FROM events WHERE scope=? AND epoch=? AND source_id=?').get(s.key,s.epoch,sourceId)
  if(old){if(old.withdrawn||store.meta('corrected:'+old.id))continue;continue}
  const e=store.ingest(s,{sourceId,actor:s.subject,role:'admin',text:body,at:store.now(),kind:'text-import'}).event,r=store.putRecord(s,{kind:'episode',subject:s.subject,attribute:'导入文本',value:'',text:body,domain:'reported',sources:[{id:e.id,quote:body}],extractor:'text-import'}).record
  store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify({...r.data,importName:plan.name}),r.id);inserted++
 }store.db.prepare('DELETE FROM previews WHERE token=?').run(data.token);management.commit(data,{inserted},[s])})
 await management.invalidate([s]);return {inserted}
}
export async function impressions(management,data){
 const store=management.store,s=management.selected(data);if(s.audience==='system')throw Error('请选择私聊或群聊')
 const key='native-extra:'+s.key+':'+s.epoch,old=store.meta(key,{revision:0,state:{}}),scopeKey=(s.audience==='private'?'qq:':'group:')+s.subject,shortKey=s.subject
 const values={experience:(old.state.insights?.[scopeKey]||[]).map(v=>typeof v==='string'?v:v.text).join('\n'),style:(old.state.styles?.[scopeKey]||[]).join('\n'),shortTerm:old.state.shortTerm?.[shortKey]?.text||''}
 if(data.read===true)return {values,expectedRevision:old.revision,scopeRevision:s.revision}
 if(data.expectedRevision!==old.revision||data.scopeRevision!==s.revision)throw Error('经验或聊天已更新，请重新打开编辑')
 const lines=v=>text(v||'',6000).split('\n').map(v=>v.trim()).filter(Boolean);const next={...old.state,insights:{...old.state.insights,[scopeKey]:lines(data.values?.experience).map(v=>({id:uid(),text:v,at:store.now(),source:'panel'}))},styles:{...old.state.styles,[scopeKey]:lines(data.values?.style)},shortTerm:{...old.state.shortTerm,[shortKey]:{text:text(data.values?.shortTerm||'',6000),at:store.now(),source:'panel'}}}
 store.transaction(()=>{store.setMeta(key,{revision:old.revision+1,state:next,manual:{...old.manual,[scopeKey]:true}});store.revision(s.key);store.change(s,'impressions',scopeKey,'edit',old.revision+1);management.commit(data,{},[s])});await management.invalidate([s]);return {saved:true}
}

export function expiry(value){return value==null||value===''?null:timestamp(Number(value))}
