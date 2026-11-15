import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { hash, uid, required, text, scopeOf, timestamp, normalized, terms, dayKey } from './policy.mjs'
import {categorySQL,inputSQL,outputSQL,finalUsage,nextBudgetDay} from './usage.mjs'

const SCHEMA = 3
const unpack = row => row ? { ...row, ...(row.payload ? { data: JSON.parse(row.payload) } : {}) } : null

export class MemoryStore {
  constructor(file, { now = Date.now,readOnly=false } = {}) {
    this.now = now
    this.readOnly=readOnly
    if (file !== ':memory:'&&!readOnly) mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file,{readOnly})
    try {
      if(readOnly){if(this.db.prepare('PRAGMA user_version').get().user_version!==SCHEMA)throw Error('只读档案版本不匹配');return}
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (version > SCHEMA) throw new Error('数据库版本较新，拒绝降级读取')
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE scopes (key TEXT PRIMARY KEY, persona TEXT NOT NULL, audience TEXT NOT NULL, subject TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, cutoff INTEGER NOT NULL DEFAULT -1, revision INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE events (id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(key), epoch INTEGER NOT NULL, source_id TEXT NOT NULL, role TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, withdrawn INTEGER NOT NULL DEFAULT 0, UNIQUE(scope,epoch,source_id));
        CREATE INDEX events_scope ON events(scope,epoch,at,id);
        CREATE TABLE records (id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(key), epoch INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, body TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, until_at INTEGER, state TEXT NOT NULL, priority REAL NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_turn INTEGER NOT NULL DEFAULT -9999, payload TEXT NOT NULL);
        CREATE INDEX records_scope ON records(scope,epoch,state,at);
        CREATE INDEX record_identity ON records(scope,epoch,subject,attribute);
        CREATE TABLE sources (record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, event_revision INTEGER NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(record_id,event_id));
        CREATE VIRTUAL TABLE record_search USING fts5(id UNINDEXED, words, tokenize='unicode61');
        CREATE TABLE jobs (id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(key), epoch INTEGER NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, request_id TEXT, error TEXT NOT NULL DEFAULT '');
        CREATE INDEX jobs_pending ON jobs(status,created_at);
        CREATE TABLE usage (id TEXT PRIMARY KEY, day TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL, input_reserved INTEGER NOT NULL, output_reserved INTEGER NOT NULL, input_actual INTEGER, output_actual INTEGER, created_at INTEGER NOT NULL);
        CREATE INDEX usage_day ON usage(day,category);
        CREATE TABLE leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until_at INTEGER NOT NULL);
        CREATE TABLE resets (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload TEXT NOT NULL, completed TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '');
        CREATE TABLE previews (token TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE imports (namespace TEXT NOT NULL, source_id TEXT NOT NULL, scope TEXT NOT NULL, epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(namespace,source_id,scope));
        PRAGMA user_version=1; COMMIT;`)
      if(version<2)this.transaction(()=>{
        this.db.exec("CREATE VIRTUAL TABLE raw_search USING fts5(id UNINDEXED,words,tokenize='unicode61'); CREATE TRIGGER raw_delete AFTER DELETE ON events BEGIN DELETE FROM raw_search WHERE id=old.id; END; CREATE TRIGGER raw_withdraw AFTER UPDATE OF withdrawn,body ON events WHEN new.withdrawn=1 OR new.body='' BEGIN DELETE FROM raw_search WHERE id=old.id; END;")
        const insert=this.db.prepare('INSERT INTO raw_search(id,words) VALUES (?,?)')
        for(const e of this.db.prepare("SELECT id,body FROM events WHERE withdrawn=0 AND kind!='protocol'").iterate())insert.run(e.id,terms(e.body,Infinity).join(' '))
        this.db.exec('PRAGMA user_version=2')
      })
      if(version<3)this.transaction(()=>{
        this.db.exec(`CREATE TABLE IF NOT EXISTS people (persona TEXT NOT NULL, audience TEXT NOT NULL, subject TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL, PRIMARY KEY(persona,audience,subject));
          CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, epoch INTEGER NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS changes_scope ON changes(scope,seq); PRAGMA user_version=3;`)
      })
    } catch (error) { this.db.close(); throw error }
  }
  close() { this.db.close() }
  transaction(fn) {
    if(this.inTransaction)return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.inTransaction=true
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
    finally {this.inTransaction=false}
  }
  meta(key, fallback = null) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  scope(input) {
    const s = scopeOf(input)
    this.db.prepare('INSERT OR IGNORE INTO scopes(key,persona,audience,subject) VALUES (?,?,?,?)').run(s.key, s.persona, s.audience, s.subject)
    return this.db.prepare('SELECT * FROM scopes WHERE key=?').get(s.key)
  }
  getScope(key) { return this.db.prepare('SELECT * FROM scopes WHERE key=?').get(key) }
  person(snapshot, subject=snapshot.subject, audience=snapshot.audience) {
    const row=this.db.prepare('SELECT * FROM people WHERE persona=? AND audience=? AND subject=?').get(snapshot.persona,audience,String(subject))
    if(row)return {...row,data:JSON.parse(row.payload)}
    const legacy=this.db.prepare("SELECT r.payload FROM records r JOIN scopes s ON s.key=r.scope AND s.epoch=r.epoch WHERE s.persona=? AND s.audience=? AND s.subject=? AND r.attribute='legacy-profile' AND r.state='valid' ORDER BY r.at DESC LIMIT 1").get(snapshot.persona,audience,String(subject))
    return {persona:snapshot.persona,audience,subject:String(subject),revision:0,data:legacy?JSON.parse(legacy.payload).legacyProfile||{}:{}}
  }
  scopeAllowed(snapshot){return !this.person(snapshot).data.noMemory}
  actorAllowed(snapshot,actor){return !this.person(snapshot,String(actor),'private').data.noMemory}
  sourceAllowed(snapshot,event){return !!event&&!event.withdrawn&&this.actorAllowed(snapshot,event.actor)&&!this.meta('corrected:'+event.id,false)}
  recordAllowed(snapshot,record){return this.scopeAllowed(snapshot)&&this.actorAllowed(snapshot,record.subject)&&this.sources(record.id).every(ref=>{const e=this.event(ref.event_id);return e&&this.actorAllowed(snapshot,e.actor)})}
  change(snapshot,entity,id,operation,revision){this.db.prepare('INSERT INTO changes(scope,epoch,entity,entity_id,operation,revision,at) VALUES (?,?,?,?,?,?,?)').run(snapshot.key,snapshot.epoch,entity,id,operation,revision,this.now())}
  scopes(persona) { return persona ? this.db.prepare('SELECT * FROM scopes WHERE persona=? ORDER BY key').all(persona) : this.db.prepare('SELECT * FROM scopes ORDER BY key').all() }
  assertScope(snapshot, { permitBlocked = false } = {}) {
    const current = this.getScope(snapshot.key)
    if (!current || current.epoch !== snapshot.epoch || (!permitBlocked && current.blocked)) throw new Error('记忆范围已变化或正在重置')
    return current
  }
  revision(key) { this.db.prepare('UPDATE scopes SET revision=revision+1 WHERE key=?').run(key) }
  ingest(snapshot, input) {
    return this.transaction(() => {
      const s = this.assertScope(snapshot)
      const sourceId = required(input.sourceId, 240), role = required(input.role), actor = required(input.actor)
      if (!['user', 'assistant', 'tool', 'admin', 'legacy'].includes(role)) throw new Error('未知证据来源')
      if (role === 'assistant' && input.delivery !== 'sent') throw new Error('发送未确认，不能归档为已发出')
      const at = timestamp(input.at), body = text(input.text, 200000), kind = required(input.kind || 'message')
      if (!body) throw new Error('空消息')
      if (at <= s.cutoff) throw new Error('来源早于重新开始边界')
      if (at > this.now() + 300000) throw new Error('来源时间超前，需校正')
      const fingerprint = hash([role, actor, kind, at, body])
      const old = this.db.prepare('SELECT * FROM events WHERE scope=? AND epoch=? AND source_id=?').get(s.key, s.epoch, sourceId)
      if (old) {
        if (old.withdrawn) throw new Error('来源已撤回，不可重放')
        if (old.fingerprint !== fingerprint) throw new Error('同一消息ID内容变化，需显式纠正')
        return { event: old, inserted: false }
      }
      const id = uid()
      this.db.prepare('INSERT INTO events(id,scope,epoch,source_id,role,actor,kind,at,body,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, s.key, s.epoch, sourceId, role, actor, kind, at, body, fingerprint)
      if(kind!=='protocol')this.db.prepare('INSERT INTO raw_search(id,words) VALUES (?,?)').run(id,terms(body,Infinity).join(' '))
      this.revision(s.key)
      return { event: this.event(id), inserted: true }
    })
  }
  event(id) { return this.db.prepare('SELECT * FROM events WHERE id=?').get(id) }
  events(snapshot, { before, limit = 50, after = -1 } = {}) {
    this.assertScope(snapshot)
    const n = Math.min(200, Math.max(1, Number(limit) || 50))
    // Cursor has a timestamp AND ID so events with equal timestamps are never skipped.
    const cursor = before || { at: 8640000000000000, id: '\uffff' }
    return this.db.prepare('SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND at>? AND (at<? OR (at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT ?').all(snapshot.key, snapshot.epoch, after, cursor.at, cursor.at, cursor.id, n)
  }
  searchEvents(snapshot,{query='',before,limit=50}={}){
    this.assertScope(snapshot)
    const words=terms(query)
    if(!words.length){const c=before||{at:8640000000000000,id:'\uffff'};return this.db.prepare("SELECT * FROM events WHERE scope=? AND epoch=? AND withdrawn=0 AND kind!='protocol' AND kind NOT LIKE 'retained:%' AND (at<? OR(at=? AND id<?)) ORDER BY at DESC,id DESC LIMIT ?").all(snapshot.key,snapshot.epoch,c.at,c.at,c.id,Math.min(200,Math.max(1,Number(limit)||50)))}
    const match=words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR '),cursor=before||{at:8640000000000000,id:'\uffff'}
    return this.db.prepare('SELECT e.* FROM events e WHERE e.scope=? AND e.epoch=? AND e.withdrawn=0 AND e.id IN (SELECT id FROM raw_search WHERE raw_search MATCH ?) AND (e.at<? OR (e.at=? AND e.id<?)) ORDER BY e.at DESC,e.id DESC LIMIT ?').all(snapshot.key,snapshot.epoch,match,cursor.at,cursor.at,cursor.id,Math.min(200,Math.max(1,Number(limit)||50)))
  }
  evidence(snapshot, list) {
    if (!Array.isArray(list) || !list.length || list.length > 32) throw new Error('记忆必须引用有效来源')
    const seen = new Set()
    return list.map(ref => {
      const id = required(ref.id), e = this.event(id), quote = text(ref.quote, 12000)
      if (seen.has(id)) throw new Error('来源重复')
      seen.add(id)
      if (!e || e.scope !== snapshot.key || e.epoch !== snapshot.epoch || e.withdrawn || (ref.revision != null && e.revision !== ref.revision)) throw new Error('来源不属于当前范围或已失效')
      if(this.meta('corrected:'+e.id,false))throw Error('来源已被人工更正，仅可查看原始历史，不可重新提炼')
      if (!quote || !e.body.includes(quote)) throw new Error('引用不是来源原文')
      return { ...e, quote }
    })
  }
  putRecord(snapshot, input) {
    return this.transaction(() => this.putRecordInTransaction(snapshot, input))
  }
  putRecordInTransaction(snapshot, input) {
    this.assertScope(snapshot)
    const kind = required(input.kind), subject = required(input.subject), attribute = required(input.attribute)
    if (!['fact', 'episode', 'promise', 'state', 'context', 'day', 'month'].includes(kind)) throw new Error('未知记忆类型')
    const value = text(input.value, 2000), body = text(input.text, 12000), summary = text(input.summary || '', 4000)
    if (!body) throw new Error('记忆正文为空')
    const evidence = this.evidence(snapshot, input.sources)
    const domain = input.domain || 'real'
    if (!['real', 'roleplay', 'reported', 'legacy'].includes(domain)) throw new Error('未知经历类型')
    if (kind === 'fact' && domain === 'real' && !evidence.some(e => e.role === 'admin' || (e.role === 'user' && e.actor === subject))) throw new Error('缺少本人事实证据，AI回复不能证明玩家事实')
    if (kind === 'fact' && value && !evidence.some(e => normalized(e.quote).includes(normalized(value)))) throw new Error('事实值未出现在引用中，需人工确认或保留为待核对事件')
    if (domain === 'legacy' && kind === 'fact') throw new Error('旧摘要不能直接升级为事实')
    const at = timestamp(input.at ?? Math.max(...evidence.map(e => e.at)))
    const until = input.until == null ? null : timestamp(input.until)
    if (until != null && until <= at) throw new Error('有效期必须晚于发生时间')
    const allowed = kind === 'promise' ? ['proposed', 'agreed', 'due', 'completed', 'cancelled', 'expired', 'unknown'] : ['valid', 'superseded', 'disputed', 'invalid']
    const state = input.state || (kind === 'promise' ? 'proposed' : 'valid')
    if (!allowed.includes(state)) throw new Error('无效状态')
    const priority = Number(input.priority ?? 0.5)
    if (!Number.isFinite(priority) || priority < 0 || priority > 1) throw new Error('重要性超出范围')
    // Exact facts may merge. Different wording is not evidence of semantic equivalence:
    // especially "喜欢咖啡" vs "不喜欢咖啡" must never collapse because both contain 咖啡.
    const identity = hash([snapshot.key, snapshot.epoch, kind, subject, attribute, normalized(value), domain, kind === 'fact' ? normalized(body) : input.eventKey || evidence.map(e => e.id).sort()])
    const existing = this.db.prepare("SELECT * FROM records WHERE scope=? AND epoch=? AND signature=? AND state NOT IN ('invalid','superseded')").get(snapshot.key, snapshot.epoch, identity)
    if(existing&&JSON.parse(existing.payload).manualRevision&&existing.body!==body)throw Error('人工更正已生效，旧来源不能覆盖或混入')
    if (existing && (existing.state !== state || (until != null && existing.until_at !== until))) throw new Error('状态变化需显式修订，不能被去重吞掉')
    if(kind==='fact' && !existing && state==='valid'){
      const conflicting=this.db.prepare("SELECT id FROM records WHERE scope=? AND epoch=? AND kind='fact' AND subject=? AND attribute=? AND state='valid'").get(snapshot.key,snapshot.epoch,subject,attribute)
      if(conflicting)throw new Error('同一属性已有不同内容，需显式修订或确认同义，不能按关键词合并')
      const superseded=this.db.prepare("SELECT s.event_id FROM sources s JOIN records r ON r.id=s.record_id WHERE r.scope=? AND r.epoch=? AND r.kind='fact' AND r.subject=? AND r.attribute=? AND r.state IN ('superseded','invalid')").all(snapshot.key,snapshot.epoch,subject,attribute)
      const oldIds=new Set(superseded.map(s=>s.event_id))
      if(evidence.every(e=>oldIds.has(e.id)))throw new Error('来源已被更正，不能恢复旧事实')
    }
    const recordId = existing?.id || (input.recordId?required(input.recordId):uid())
    if (!existing) {
      const data = { domain, eventKey: input.eventKey || '', extractor: input.extractor || 'manual', rawAvailable: true }
      this.db.prepare('INSERT INTO records(id,scope,epoch,kind,subject,attribute,value,body,summary,at,until_at,state,priority,pinned,signature,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(recordId,snapshot.key,snapshot.epoch,kind,subject,attribute,value,body,summary,at,until,state,priority,input.pinned ? 1 : 0,identity,JSON.stringify(data))
      this.db.prepare('INSERT INTO record_search(id,words) VALUES (?,?)').run(recordId, terms([body, summary, value, subject, attribute].join(' '),Infinity).join(' '))
    }
    let changes = 0
    for (const e of evidence) changes += this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?,?)').run(recordId,e.id,e.revision,e.quote).changes
    if (!existing || changes) this.revision(snapshot.key)
    return { record: this.record(recordId), inserted: !existing, evidenceAdded: changes }
  }
  record(id) { return unpack(this.db.prepare('SELECT * FROM records WHERE id=?').get(id)) }
  reindex(id){const r=this.record(id);if(r)this.db.prepare('INSERT INTO record_search(id,words) VALUES (?,?)').run(id,terms([r.body,r.summary,r.value,r.subject,r.attribute].join(' '),Infinity).join(' '))}
  sources(id) { return this.db.prepare('SELECT * FROM sources WHERE record_id=? ORDER BY event_id').all(id) }
  allSources(id){const refs=this.sources(id),seen=new Set(refs.map(r=>r.event_id));for(const event_id of this.record(id)?.data.replacedSources||[])if(!seen.has(event_id)){refs.push({event_id});seen.add(event_id)}return refs}
  records(snapshot, { query = '', limit = 100, includeHistory = false, at = this.now() } = {}) {
    this.assertScope(snapshot)
    const n = Math.min(200, Math.max(1, Number(limit) || 100)), tokens = terms(query)
    const clause = includeHistory ? '' : "AND r.state NOT IN ('invalid','superseded','disputed','expired') AND (r.until_at IS NULL OR r.until_at>?)"
    const args = [snapshot.key, snapshot.epoch, ...(includeHistory ? [] : [at])]
    const querySql = tokens.length ? 'AND r.id IN (SELECT id FROM record_search WHERE record_search MATCH ?)' : ''
    if (tokens.length) args.push(tokens.map(t => '"'+t.replaceAll('"','""')+'"').join(' OR '))
    return this.db.prepare(`SELECT r.* FROM records r WHERE r.scope=? AND r.epoch=? ${clause} ${querySql} ORDER BY r.at DESC,r.id DESC LIMIT ?`).all(...args,n).map(unpack)
  }
  revise(snapshot, id, replacement) {
    return this.transaction(() => {
      const old = this.record(id)
      if (!old || old.scope !== snapshot.key || old.epoch !== snapshot.epoch) throw new Error('条目不属于当前范围')
      if (replacement.expectedRevision !== old.revision) throw new Error('条目已更新，请刷新')
      this.assertScope(snapshot)
      this.db.prepare("UPDATE records SET state='superseded',revision=revision+1 WHERE id=?").run(id)
      const next = this.putRecordInTransaction(snapshot, { ...replacement, kind: old.kind, subject: old.subject, attribute: old.attribute })
      this.invalidateDerived(snapshot, this.sources(id).map(s => s.event_id), [id, next.record.id])
      const oldSources=new Set(this.sources(id).map(s=>s.event_id))
      for(const job of this.db.prepare("SELECT id,payload FROM jobs WHERE scope=? AND epoch=? AND status IN ('pending','running','unknown')").all(snapshot.key,snapshot.epoch)){
        if((JSON.parse(job.payload).sources || []).some(s=>oldSources.has(s.id)))this.finishJob(job.id,'stale','source-superseded')
      }
      return next
    })
  }
  invalidateDerived(snapshot, eventIds, exclude = []) {
    this.db.prepare('DELETE FROM meta WHERE key LIKE ?').run('native-extra:'+snapshot.key+':%')
    for (const id of eventIds) {
      const rows = this.db.prepare("SELECT r.id FROM records r JOIN sources s ON s.record_id=r.id WHERE s.event_id=? AND r.scope=? AND r.epoch=? AND r.kind IN ('context','day','month','episode')").all(id,snapshot.key,snapshot.epoch)
      for (const row of rows) if (!exclude.includes(row.id)) this.db.prepare("UPDATE records SET state='invalid',revision=revision+1 WHERE id=?").run(row.id)
    }
  }
  forget(snapshot, id) {
    return this.transaction(() => {
      this.assertScope(snapshot)
      const old = this.record(id)
      if (!old || old.scope !== snapshot.key || old.epoch !== snapshot.epoch) throw new Error('条目不属于当前范围')
      // A source may contain several facts. Forgetting withdraws the whole source and its
      // dependents, and reports collateral records rather than leaking through a raw replay.
      const refs = this.allSources(id), affected = new Set([id])
      for (const ref of refs) {
        for (const r of this.db.prepare('SELECT record_id FROM sources WHERE event_id=?').all(ref.event_id)) affected.add(r.record_id)
        this.db.prepare("UPDATE events SET body='',withdrawn=1,revision=revision+1 WHERE id=?").run(ref.event_id)
      }
      for (const recordId of affected) {
        this.setMeta('native-tombstone:'+recordId,{scope:snapshot.key,epoch:snapshot.epoch,at:this.now()})
        this.db.prepare('DELETE FROM record_search WHERE id=?').run(recordId)
        this.db.prepare('DELETE FROM records WHERE id=?').run(recordId)
      }
      this.db.prepare("UPDATE jobs SET status=CASE WHEN status IN ('pending','running','unknown') THEN 'stale' ELSE status END,payload='{}',error='source-withdrawn' WHERE scope=? AND epoch=?").run(snapshot.key,snapshot.epoch)
      this.db.prepare("UPDATE events SET body='',withdrawn=1,revision=revision+1 WHERE scope=? AND epoch=? AND kind='protocol'").run(snapshot.key,snapshot.epoch)
      this.db.prepare("DELETE FROM meta WHERE key LIKE ?").run('native-extra:'+snapshot.key+':%')
      this.revision(snapshot.key)
      return { removedRecords: affected.size, withdrawnSources: refs.length }
    })
  }
  pin(snapshot, id, pinned) {
    this.assertScope(snapshot)
    const r = this.record(id)
    if (!r || r.scope !== snapshot.key || r.epoch !== snapshot.epoch) throw new Error('条目不属于当前范围')
    this.db.prepare('UPDATE records SET pinned=?,revision=revision+1 WHERE id=?').run(pinned ? 1 : 0,id)
    this.revision(snapshot.key)
  }
  usage(day = dayKey(this.now()), category = 'background') {
    return this.db.prepare(`SELECT COUNT(*) attempts, COALESCE(SUM(${inputSQL}),0) inputTokens, COALESCE(SUM(${outputSQL}),0) outputTokens FROM usage WHERE day=? AND ${categorySQL(category)}`).get(day)
  }
  budgetStatus(limits) {
    const used=this.usage(),day=dayKey(this.now()),remaining={attempts:Math.max(0,limits.extraAttempts-used.attempts),inputTokens:Math.max(0,limits.dailyInputTokens-used.inputTokens),outputTokens:Math.max(0,limits.dailyOutputTokens-used.outputTokens)}
    const ledger=this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='complete' AND input_actual IS NOT NULL AND output_actual IS NOT NULL THEN input_actual ELSE 0 END),0) settledInput,COALESCE(SUM(CASE WHEN state='complete' AND input_actual IS NOT NULL AND output_actual IS NOT NULL THEN output_actual ELSE 0 END),0) settledOutput,COALESCE(SUM(state!='complete' OR input_actual IS NULL OR output_actual IS NULL),0) estimatedRequests FROM usage WHERE day=? AND ${categorySQL('background')}`).get(day)
    const waiting=this.db.prepare("SELECT j.id,j.created_at,m.value FROM jobs j JOIN meta m ON m.key='job-wait:'||j.id WHERE j.status='pending' ORDER BY j.created_at,j.id LIMIT 50").all().map(r=>({id:r.id,at:r.created_at,...JSON.parse(r.value)}))
    const unresolved="FROM meta m JOIN events e ON m.key='oversized-source:'||e.id JOIN scopes s ON s.key=e.scope AND s.epoch=e.epoch WHERE e.withdrawn=0 AND NOT EXISTS(SELECT 1 FROM sources src JOIN records r ON r.id=src.record_id WHERE src.event_id=e.id AND r.state NOT IN ('invalid','superseded','disputed'))"
    const oversized=this.db.prepare('SELECT COUNT(*) count '+unresolved+" AND e.kind NOT LIKE 'retained:%' AND length(e.body)>0").get().count
    const unavailableSources=this.db.prepare('SELECT COUNT(*) count '+unresolved+" AND (e.kind LIKE 'retained:%' OR length(e.body)=0)").get().count
    const monthlyBlocked=this.db.prepare("SELECT COUNT(*) n FROM meta m JOIN records r ON m.key='monthly-record:'||r.id||':'||r.revision JOIN scopes s ON s.key=r.scope AND s.epoch=r.epoch WHERE json_extract(m.value,'$.skipped')='source-too-large' AND r.state='valid'").get().n
    return {day,used,remaining,ledger,waiting,oversized,unavailableSources,monthlyBlocked,resetsAt:nextBudgetDay(this.now()),rule:'成功且用量完整时按实际结算；在途、未知或缺用量保留估算。原生、聊天和玩法单独记账。'}
  }
  wakeBudgetJobs() { this.db.prepare("DELETE FROM meta WHERE key LIKE 'job-wait:%' AND json_extract(value,'$.code')='PM_BUDGET' AND json_extract(value,'$.permanent')=0").run() }
  deferJob(id,error) {
    this.setMeta('job-wait:'+id,{code:error.code,reason:error.message,until:error.permanent?8640000000000000:nextBudgetDay(this.now()),permanent:!!error.permanent,dimension:error.dimension||'',needed:error.needed,remaining:error.remaining})
  }
  reserveUsage({ id, category, inputTokens, outputTokens, limits }) {
    return this.transaction(() => {
      required(id)
      if (this.db.prepare('SELECT id FROM usage WHERE id=?').get(id)) throw new Error('请求已登记，不可重复提交')
      for (const n of [inputTokens, outputTokens]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('无效用量预占')
      const day = dayKey(this.now()), total = this.usage(day,category==='native-memory'?'native':['chat','gameplay'].includes(category)?category:'background')
      if(limits)for(const [dimension,needed,used,cap,label] of [['attempts',1,total.attempts,limits.extraAttempts,'次数'],['inputTokens',inputTokens,total.inputTokens,limits.dailyInputTokens,'输入'],['outputTokens',outputTokens,total.outputTokens,limits.dailyOutputTokens,'输出']]){
        if(used+needed>cap){const remaining=Math.max(0,cap-used),permanent=needed>cap;throw Object.assign(new Error(`记忆整理额度不足：${label}剩余${remaining}，本批需要${needed}；${permanent?'单批超过每日上限，请调整设置或处理批次':'等待额度恢复后继续'}`),{code:'PM_BUDGET',dimension,needed,remaining,permanent})}
      }
      this.db.prepare('INSERT INTO usage(id,day,category,state,input_reserved,output_reserved,created_at) VALUES (?,?,?,?,?,?,?)').run(id,day,required(category), 'reserved',inputTokens,outputTokens,this.now())
      return id
    })
  }
  settleUsage(id, state, usage = {}) {
    if (!['complete','failed','unknown'].includes(state)) throw new Error('未知请求结果')
    const row = this.db.prepare('SELECT * FROM usage WHERE id=?').get(id)
    if (!row) throw new Error('请求未预占')
    if (row.state !== 'reserved') return false
    const {input,output}=finalUsage(usage)
    const updated=this.db.prepare("UPDATE usage SET state=?,input_actual=?,output_actual=? WHERE id=? AND state='reserved'").run(state,input,output,id)
    if(!updated.changes)return false
    if(state==='complete'&&input!==null&&output!==null)this.wakeBudgetJobs()
    return true
  }
  enqueue(snapshot, { kind, sources, generation, version = 1 }) {
    this.assertScope(snapshot)
    const refs = this.evidence(snapshot,sources).map(e => ({ id:e.id,revision:e.revision,quote:e.quote }))
    const payload = { sources:refs,version }, fingerprint = hash([snapshot.key,snapshot.epoch,kind,version,refs.slice().sort((a,b)=>a.id.localeCompare(b.id))])
    const existing=this.db.prepare('SELECT * FROM jobs WHERE fingerprint=?').get(fingerprint)
    if(existing)return unpack(existing)
    // Only coalesce unpaid, unstarted work. Never silently retry a billed/unknown job.
    const queued=this.db.prepare("SELECT * FROM jobs WHERE scope=? AND epoch=? AND generation=? AND kind=? AND status='pending' AND request_id IS NULL ORDER BY created_at LIMIT 1").get(snapshot.key,snapshot.epoch,generation,kind)
    if(queued){const old=JSON.parse(queued.payload),merged=new Map(old.sources.map(s=>[s.id,s]));let compatible=old.version===version
      for(const ref of refs){const prev=merged.get(ref.id);if(prev&&(prev.revision!==ref.revision||prev.quote!==ref.quote))compatible=false;merged.set(ref.id,ref)}
      const values=[...merged.values()]
      if(compatible&&values.length<=32&&values.reduce((n,s)=>n+Buffer.byteLength(s.quote,'utf8'),0)<=7000){
        const joined=hash([snapshot.key,snapshot.epoch,kind,version,values.slice().sort((a,b)=>a.id.localeCompare(b.id))])
        if(!this.db.prepare('SELECT 1 FROM jobs WHERE fingerprint=? AND id!=?').get(joined,queued.id)){
          this.db.prepare('UPDATE jobs SET payload=?,fingerprint=? WHERE id=?').run(JSON.stringify({sources:values,version}),joined,queued.id)
          // Re-evaluate a changed batch; a previous small-batch decision is no longer valid.
          this.db.prepare('DELETE FROM meta WHERE key=?').run('job-wait:'+queued.id)
          return unpack(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(queued.id))
        }
      }
    }
    const id = uid()
    this.db.prepare('INSERT OR IGNORE INTO jobs(id,scope,epoch,generation,kind,fingerprint,status,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,snapshot.key,snapshot.epoch,generation,required(kind),fingerprint,'pending',JSON.stringify(payload),this.now())
    return unpack(this.db.prepare('SELECT * FROM jobs WHERE fingerprint=?').get(fingerprint))
  }
  claimJob(owner, leaseMs = 120000) {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT * FROM leases WHERE name=?').get('worker')
      if (lease && lease.until_at > this.now()) return null
      // An expired in-flight request has unknown billing/outcome. Never silently retry it.
      this.db.prepare("UPDATE usage SET state='unknown' WHERE state='reserved' AND id IN (SELECT request_id FROM jobs WHERE status='running')").run()
      this.db.prepare("UPDATE jobs SET status='unknown',error='worker-interrupted' WHERE status='running'").run()
      const turn=this.meta('worker-fair-turn',0),preferPrivate=turn%3!==2
      const job = this.db.prepare("SELECT j.* FROM jobs j JOIN scopes s ON s.key=j.scope WHERE j.status='pending' AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.key='job-wait:'||j.id AND json_extract(m.value,'$.until')>?) ORDER BY CASE WHEN (s.audience='private')=? THEN 0 ELSE 1 END,COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='worker-served:'||j.scope),-1),j.created_at,j.id LIMIT 1").get(this.now(),preferPrivate?1:0)
      if (!job) return null
      this.setMeta('worker-fair-turn',turn+1);this.setMeta('worker-served:'+job.scope,turn+1)
      this.db.prepare('INSERT INTO leases VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at').run('worker',owner,this.now()+leaseMs)
      this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id)
      this.db.prepare('DELETE FROM meta WHERE key=?').run('job-wait:'+job.id)
      return unpack(job)
    })
  }
  releaseWorker(owner) { this.db.prepare("DELETE FROM leases WHERE name='worker' AND owner=?").run(owner) }
  job(id) { return unpack(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)) }
  finishJob(id, status, error = '') {
    this.db.prepare('UPDATE jobs SET status=?,error=? WHERE id=?').run(status,String(error).slice(0,300),id)
  }
  statistics(snapshot) {
    this.assertScope(snapshot,{permitBlocked:true})
    const events = this.db.prepare('SELECT COUNT(*) count,MIN(at) earliest,MAX(at) latest FROM events WHERE scope=? AND epoch=? AND withdrawn=0').get(snapshot.key,snapshot.epoch)
    const records = this.db.prepare('SELECT COUNT(*) count FROM records WHERE scope=? AND epoch=?').get(snapshot.key,snapshot.epoch).count
    return { ...events, records, epoch:snapshot.epoch, blocked:!!snapshot.blocked }
  }
}
