import { hash, uid, required } from './policy.mjs'

export class ResetCoordinator {
  constructor(store, { participants = [], now = Date.now } = {}) {
    this.store = store; this.participants = participants; this.now = now
    const ids = participants.map(p => required(p.id))
    if (new Set(ids).size !== ids.length) throw new Error('重置适配器ID重复')
  }
  targets({ persona, scopeKey, all = false }) {
    if (all && (persona || scopeKey)) throw new Error('请选择一个清理范围')
    if (!all && !persona && !scopeKey) throw new Error('必须指定清理范围')
    let rows = this.store.scopes(persona)
    if (scopeKey) rows = rows.filter(r => r.key === scopeKey)
    if (!rows.length) throw new Error('范围不存在或没有互动资料')
    if (rows.some(r => r.blocked)) throw new Error('此范围还有未完成重置，请恢复原任务')
    return rows
  }
  async preview(selection) {
    const scopes = this.targets(selection)
    const external = []
    for (const p of this.participants) {
      if (typeof p.preview !== 'function' || typeof p.clear !== 'function') throw new Error('缺少完整重置适配：'+p.id)
      const result = await p.preview(scopes,selection)
      if (!result?.supported) throw new Error('不能完整重置：'+p.id+' '+(result?.reason || '接口不支持'))
      external.push({ id:p.id, version:required(String(p.version)), ...result })
    }
    // Re-check revisions after asynchronous adapters; a preview never authorizes new scopes.
    const current = scopes.map(s => this.store.getScope(s.key))
    if (hash(scopes) !== hash(current)) throw new Error('资料已变化，请重新预览')
    const payload = { selection, scopes: scopes.map(s => ({ key:s.key, persona:s.persona, audience:s.audience, subject:s.subject, epoch:s.epoch, revision:s.revision })), participants:external.map(p => ({id:p.id,version:p.version})), external }
    const token = uid(), fingerprint = hash(payload)
    this.store.db.prepare('INSERT INTO previews VALUES (?,?,?,?,?)').run(token,'reset',fingerprint,JSON.stringify(payload),this.now()+300000)
    return { token, expiresAt:this.now()+300000, scopes:scopes.map(s=>({...s,counts:this.store.statistics(s)})), external, retained:['人格卡与配置（包括写在设定中的称呼或关系）','静态形象与照片文件',selection.archiveWindows?'DSH会话日志（相关窗口已移出左侧，禁止继续使用）':'左侧历史窗口与DSH会话日志（停止复用旧上下文）','外部平台内容、游戏存档与备份','用量账本'], warning:'互动固定记忆也会清除；不删除外部聊天平台和外部备份。' }
  }
  async execute(token) {
    const existing = this.store.db.prepare('SELECT id FROM resets WHERE token=?').get(token)
    if (existing) return this.resume(existing.id)
    const initial=this.store.db.prepare('SELECT * FROM previews WHERE token=? AND kind=?').get(required(token),'reset')
    if(!initial||initial.expires_at<this.now())throw Error('预览已过期，请重新确认范围')
    const expected=JSON.parse(initial.payload)
    for(const p of this.participants)await p.validatePreview?.(expected.external.find(x=>x.id===p.id),expected.scopes,expected.selection)
    const id = this.store.transaction(() => {
      const p = this.store.db.prepare('SELECT * FROM previews WHERE token=? AND kind=?').get(required(token),'reset')
      if (!p || p.expires_at < this.now()) throw new Error('预览已过期，请重新确认范围')
      const data = JSON.parse(p.payload)
      const currentKeys = this.targets(data.selection).map(s=>s.key)
      if(hash(currentKeys)!==hash(data.scopes.map(s=>s.key))) throw new Error('清理范围已变化，请重新预览')
      for (const target of data.scopes) {
        const current = this.store.getScope(target.key)
        if (!current || current.blocked || current.epoch !== target.epoch || current.revision !== target.revision) throw new Error('资料已变化，请重新预览')
      }
      const participantVersion = this.participants.map(p=>({id:p.id,version:String(p.version)}))
      if (hash(data.participants) !== hash(participantVersion)) throw new Error('重置适配器已变化，请重新预览')
      const jobId = uid(), cutoff = this.now()
      data.cutoff = cutoff
      this.store.db.prepare('INSERT INTO resets(id,token,status,payload,created_at) VALUES (?,?,?,?,?)').run(jobId,token,'running',JSON.stringify(data),cutoff)
      for (const target of data.scopes) {
        this.store.db.prepare('UPDATE scopes SET epoch=epoch+1,cutoff=MAX(cutoff,?),revision=revision+1,blocked=1 WHERE key=?').run(cutoff,target.key)
        this.store.db.prepare("UPDATE jobs SET status='stale',payload='{}',error='reset' WHERE scope=?").run(target.key)
      }
      this.store.db.prepare('DELETE FROM previews WHERE token=?').run(token)
      return jobId
    })
    return this.resume(id)
  }
  async resume(id) {
    const row = this.store.db.prepare('SELECT * FROM resets WHERE id=?').get(id)
    if (!row) throw new Error('重置任务不存在')
    if (row.status === 'complete') return { id, status:'complete', duplicate:true }
    const data = JSON.parse(row.payload), completed = new Set(JSON.parse(row.completed))
    try {
      for (const requiredAdapter of data.participants) {
        const adapter = this.participants.find(p=>p.id===requiredAdapter.id && String(p.version)===requiredAdapter.version)
        if (!adapter) throw new Error('缺少原版本重置适配：'+requiredAdapter.id)
        if (completed.has(adapter.id)) continue
        // clear is idempotent with resetId; it must verify its own persistent deletion/cutoff.
        const result = await adapter.clear({ resetId:id, scopes:data.scopes, cutoff:data.cutoff, selection:data.selection, participantPreview:data.external.find(p=>p.id===adapter.id) })
        if (!result?.verified) throw new Error('尚未确认清理完成：'+adapter.id)
        completed.add(adapter.id)
        this.store.db.prepare('UPDATE resets SET completed=? WHERE id=?').run(JSON.stringify([...completed]),id)
      }
      this.store.transaction(() => {
        for (const target of data.scopes) {
          const current = this.store.getScope(target.key)
          if (!current?.blocked || current.epoch !== target.epoch+1) throw new Error('重置代际已变化，停止清理')
          this.store.db.prepare('DELETE FROM record_search WHERE id IN (SELECT id FROM records WHERE scope=?)').run(target.key)
          this.store.db.prepare('DELETE FROM records WHERE scope=?').run(target.key)
          this.store.db.prepare('DELETE FROM events WHERE scope=?').run(target.key)
          this.store.db.prepare('DELETE FROM jobs WHERE scope=?').run(target.key)
          this.store.db.prepare('DELETE FROM people WHERE persona=? AND audience=? AND subject=?').run(target.persona,target.audience,target.subject)
          this.store.change(current,'scope',target.key,'reset',current.revision)
          for(const row of this.store.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'session:%'").all())if(JSON.parse(row.value)?.snapshot?.key===target.key)this.store.db.prepare('DELETE FROM meta WHERE key=?').run(row.key)
          // Working views can contain conversation bodies. Epoch fencing alone is
          // insufficient for a physical reset; remove every generation of this scope.
          this.store.db.prepare("DELETE FROM meta WHERE key LIKE ? OR key=? OR key=?").run('native-extra:'+target.key+':%','last-recall:'+target.key,'worker-served:'+target.key)
          this.store.db.prepare("DELETE FROM meta WHERE key LIKE ?").run('recall-diagnostic:'+target.key+':%')
          // Previews may embed exported bodies or deletion evidence. Invalidate them
          // globally rather than leaving an old confirmation able to revive content.
          this.store.db.prepare('DELETE FROM previews').run()
          // imports retain only identifiers/fingerprints as replay tombstones, never payloads.
          this.store.db.prepare('UPDATE scopes SET blocked=0 WHERE key=?').run(target.key)
        }
        this.store.db.prepare("UPDATE resets SET status='complete',error='' WHERE id=?").run(id)
      })
      return { id, status:'complete', scopes:data.scopes.length }
    } catch (error) {
      // Remaining scopes stay frozen across restarts; never report success on a partial clear.
      this.store.db.prepare("UPDATE resets SET status='pending',error=? WHERE id=?").run(String(error.message).slice(0,300),id)
      return { id,status:'pending',message:String(error.message).slice(0,300) }
    }
  }
  pending() {
    return this.store.db.prepare("SELECT id,status,created_at,error FROM resets WHERE status!='complete' ORDER BY created_at").all()
  }
}
