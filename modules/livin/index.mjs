// livin 过日子：她自己的一整天。无聊了自己找件事做——不是任务清单，是生活。
// 调度五闸（空档/自排程/概率/额度/安静）→ 她自己挑 → 执行 → 回味 → 看心情分享 → 自己定下次。
// 每道闸的判定都落历史：面板要能回答"她今天为什么没醒"。
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeDocx, readDocxText } from './lib/docx.mjs'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const JOY_DO_GAP = 30 * MIN // joy_do 两次之间至少歇这么久：模型想刷就能连着把额度刷完，得兜住

const DEFAULT_POOL = [
  { id: 'douyin', name: '刷会儿抖音', desc: '打开刷抖音模块，随便看看推荐，看到好的记得分享', weight: 1, on: true },
  { id: 'minigame', name: '玩一局小游戏', desc: '2048 / 贪吃蛇 / 扫雷随便来一局', weight: 1, on: true },
  { id: 'bili', name: '去B站逛逛', desc: '看看B站推荐和热门，看什么都行', weight: 1, on: true },
  { id: 'novel', name: '写小说', desc: '接着自己那篇连载继续写（都存成 Word 文档）', weight: 0.8, on: true },
  { id: 'water', name: '喝口水歇歇眼', desc: '起身倒杯水，看看窗外', weight: 0.6, on: true },
  { id: 'rest', name: '就发会儿呆', desc: '什么都不干，安静坐一会儿', weight: 0.5, on: true },
]

const DEFAULTS = {
  enabled: false, // 装上不动，面板手动开
  idleMinutes: 20, // 距主人私聊最后消息多久才可能醒（群聊不算）
  wakeChance: 40, // 空档到了，百分之多少的概率真的醒
  dailyMax: 8, // 每天自己玩的次数上限（只算真正完成的）
  quietStart: 1, // 睡觉时段（点），不醒
  quietEnd: 8,
  novelMode: 'short', // short=短篇（一整个 Word）；long=长篇（一章一个 Word，她每轮先检索书架）
  shareGapMin: 90, // 两次主动分享的最小间隔
  shareChance: 70, // 做完想分享的概率
}

// 权重时间衰减：距上次做这个乐子越久越想玩；睡一觉满血
export function decay(msSinceLast) {
  if (typeof msSinceLast !== 'number' || !(msSinceLast >= 0)) return 1
  if (msSinceLast < 1 * HOUR) return 0.5
  if (msSinceLast < 3 * HOUR) return 0.7
  if (msSinceLast < 6 * HOUR) return 0.85
  return 1
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export default {
  id: 'livin',
  name: '过日子',
  version: '1.2.2',
  api: 1,
  category: 'desktop',
  tags: ['自主', '乐子', '生活'],
  description: '她自己的一整天：无聊了从乐子清单里自己挑一件事——刷抖音、玩游戏、逛B站、写小说、发呆都行，做完看心情分享给主人，下次什么时候醒也她自己定。',
  capabilities: ['network', 'filesystem', 'plugin-config', 'plugin-internals'],
  minPluginVersion: '1.2.0',
  requires: [],
  license: 'MIT',
  author: 'Ariz0324',

  defaults: DEFAULTS,
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '让她自己过日子', type: 'switch', hint: '关掉她就只被动聊天，不会自己找乐子' },
    { key: 'idleMinutes', label: '主人多久没找她才可能醒（分钟）', type: 'number', min: 5, max: 240, step: 5, hint: '只看主人私聊，群里热闹不算' },
    { key: 'wakeChance', label: '空档到了真醒的概率（%）', type: 'number', min: 5, max: 100, step: 5, hint: '低了更像人：有时候无聊也懒得动' },
    { key: 'dailyMax', label: '每天自己玩几次上限', type: 'number', min: 3, max: 20, step: 1, hint: '只算真正完成的，被打断不算' },
    { key: 'quietStart', label: '睡觉时段从（点）', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'quietEnd', label: '睡觉时段到（点）', type: 'number', min: 1, max: 24, step: 1 },
    { key: 'shareGapMin', label: '两次主动分享至少隔（分钟）', type: 'number', min: 30, max: 480, step: 30 },
    { key: 'shareChance', label: '做完主动分享的概率（%）', type: 'number', min: 0, max: 100, step: 10, hint: '有时候自己偷偷乐，不吱声' },
    {
      key: 'novelMode', label: '小说模式', type: 'select',
      options: [{ value: 'short', label: '短篇（一整个 Word 文档）' }, { value: 'long', label: '长篇（一章一个 Word 文档）' }],
      hint: '长篇：她每轮醒来先检索写过的 Word 章节再续写；文档在 modules-data/livin/novel/',
    },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const dir = api.dataDir()
    const file = () => join(dir, 'livin.json')
    mkdirSync(dir, { recursive: true })

    const load = () => {
      try {
        const raw = JSON.parse(readFileSync(file(), 'utf8')) || {}
        raw.pool ||= JSON.parse(JSON.stringify(DEFAULT_POOL))
        raw.history ||= []
        raw.novel ||= { title: '', parts: [] }
        raw.state ||= { lastWokeAt: 0, nextWakeAt: 0, nextWakeBy: '', day: '', doneCount: 0, perJoy: {}, lastShareAt: 0, lastJoyAt: 0 }
        if (raw.state.day !== dayKey(Date.now())) {
          raw.state = { ...raw.state, day: dayKey(Date.now()), doneCount: 0 }
          // sharedToday 是「今天分享了几次」，跨天必须清；lastAt 是兴趣衰减用的，要留着
          for (const pj of Object.values(raw.state.perJoy || {})) delete pj.sharedToday
        }
        return raw
      } catch {
        return { pool: JSON.parse(JSON.stringify(DEFAULT_POOL)), history: [], novel: { title: '', parts: [] }, state: { lastWokeAt: 0, nextWakeAt: 0, nextWakeBy: '', day: dayKey(Date.now()), doneCount: 0, perJoy: {}, lastShareAt: 0 } }
      }
    }
    let st = load()
    // 跨天检查：st 常驻内存，load() 里那个比较只在启动时跑一次——进程不重启，第二天
    // doneCount 还挂在昨天的数上，额度就永远「用完」了。每轮开头都查一次。
    const rollDay = () => {
      const today = dayKey(Date.now())
      if (st.state.day === today) return false
      st.state = { ...st.state, day: today, doneCount: 0 }
      for (const pj of Object.values(st.state.perJoy || {})) delete pj.sharedToday
      api.log?.debug?.('[livin] 新的一天，额度和分享次数已重置')
      return true
    }
    // 存盘要走临时文件 + rename：直接覆盖 livin.json，写到一半崩了整个文件就废，
    // load() 会静默回默认，一天的记录全没。
    const save = () => {
      try {
        const tmp = `${file()}.tmp`
        writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n', 'utf8')
        renameSync(tmp, file())
      } catch (e) { api.log.warn?.(`[livin] 存档失败：${e.message}`) }
    }

    const record = (event, extra = {}) => {
      st.history.push({ at: Date.now(), event, ...extra })
      st.history = st.history.filter((h) => Date.now() - h.at < 7 * DAY).slice(-500)
      save()
    }

    const weightOf = (item, now) => {
      const pj = st.state.perJoy[item.id]
      return Math.max(0.05, (Number(item.weight) || 1) * decay(now - (pj?.lastAt || 0)))
    }
    const inQuiet = (now) => {
      const c = cfg(); const h = new Date(now).getHours()
      return c.quietStart <= c.quietEnd ? (h >= c.quietStart && h < c.quietEnd) : (h >= c.quietStart || h < c.quietEnd)
    }
    const ownerChat = () => { const q = String(api.config().ownerQQ || '').trim(); return q ? `private:${q}` : null }

    // ---------- think ----------
    const ask = async (prompt, title) => {
      try { return await api.think(prompt, { title, timeoutMs: 120000 }) } catch (e) { api.log.warn?.(`[livin] think 失败：${e.message}`); return '' }
    }
    const pickLine = (text, re) => { const m = String(text || '').match(re); return m ? m[1] : '' }

    // ---------- 执行器 ----------
    const webPort = () => { try { return Number(api.dsh?.webServer?.port) || 9210 } catch { return 9210 } }

    // 乐子可用性：别人装了 livin 不一定装了 minigame/douyin——没装的乐子不进她的清单，也不会被挑中
    let douyinDown = false // 本会话内探测到抖音模块不在就不再列
    const joyAvailable = (id) => {
      try {
        if (id === 'minigame') return !!api.use('minigame')?.play
        if (id === 'bili') return !!api.use('bili')?.run
        if (id === 'douyin') return !douyinDown
        return true // novel / water / rest 都是自己就能干的
      } catch { return false }
    }

    const runJoy = async (item, why) => {
      const now = Date.now()
      try {
        if (item.id === 'douyin') {
          const r = await fetch(`http://127.0.0.1:${webPort()}/aurabot/api/ext/douyin/run`, { method: 'POST', signal: AbortSignal.timeout(10000) })
          if (!r.ok) {
            if (r.status === 404 || r.status === 405) douyinDown = true // 没装抖音模块，这轮之后不再列
            return { ok: false, detail: r.status === 404 ? '刷抖音模块没装' : `没刷成（HTTP ${r.status}）` }
          }
          return { ok: true, detail: '已经开始刷了，看见好玩的会自己分享' }
        }
        if (item.id === 'minigame') {
          const mg = api.use('minigame')
          if (!mg?.play) return { ok: false, detail: '小游戏模块没在跑' }
          const r = await mg.play()
          return { ok: r && r.ok !== false, detail: r ? `一局${r.title || r.game || ''}，${r.win ? '赢了' : '没赢'}，${r.score ?? r.steps ?? ''}`.trim() : '没玩成' }
        }
        if (item.id === 'bili') {
          const b = api.use('bili')
          if (!b?.run) return { ok: false, detail: 'B站模块没在跑' }
          const r = await b.run({ force: true })
          return { ok: true, detail: (r && r.message) || '去B站看了看' }
        }
        if (item.id === 'novel') {
          // 小说全部存 Word（.docx），放在 modules-data/livin/novel/
          // 短篇：一整个《书名》.docx，每轮续一段重写全档；长篇：一章一个 docx，动笔前先检索书架
          const nd = join(api.dataDir(), 'novel')
          mkdirSync(nd, { recursive: true })
          const shelf = (() => {
            try {
              return readdirSync(nd)
                .filter((f) => f.toLowerCase().endsWith('.docx'))
                .map((f) => ({ f, m: statSync(join(nd, f)).mtimeMs }))
                .sort((a, b) => b.m - a.m)
            } catch { return [] }
          })()
          const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 40)

          if (cfg().novelMode === 'long') {
            const nL = st.novelLong = st.novelLong || { title: '', chapters: [] }
            const tail = shelf.length ? readDocxText(readFileSync(join(nd, shelf[0].f))).replace(/\s+/g, ' ').trim().slice(-160) : ''
            const intro = shelf.length
              ? `你的 Word 书架上有这些章节（新的在前）：${shelf.slice(0, 12).map((x) => x.f.replace(/\.docx$/i, '')).join('、')}。` +
                `最新一章的结尾是：「${tail}」——接着往下写第 ${shelf.length + 1} 章，剧情要接得上。`
              : '书架还空着——这次开一本新的长篇：自己挑题材，起个书名，写第一章。'
            const out = await ask(
              `【写长篇小说，不是聊天，这段不会发出去】${intro}\n` +
              `第一行写章节名（不超过12个字，不要带"第几章"），然后另起一行写正文，600到1200字，往前推进剧情，结尾留个钩子。`,
              '过日子·写长篇',
            )
            const text = String(out || '').trim()
            if (!text) return { ok: false, detail: '没写出来' }
            const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
            const chapName = (lines[0] || '').replace(/^(第[0-9一二三四五六七八九十百]+章)?\s*/, '').slice(0, 12) || `第${shelf.length + 1}章`
            const body = (lines.length > 1 ? lines.slice(1).join('\n') : lines[0]).slice(0, 4000)
            if (!nL.title) nL.title = pickLine(text, /《(.+?)》/) || chapName
            const no = shelf.length + 1
            const fname = safe(`《${nL.title || '未定'}》第${no}章 ${chapName}`) + '.docx'
            writeFileSync(join(nd, fname), makeDocx(body.split(/\n+/)))
            nL.chapters.push({ file: fname, words: body.length, at: now })
            nL.chapters = nL.chapters.slice(-60)
            return { ok: true, detail: `《${nL.title || '未定'}》第${no}章「${chapName}」写好了（${body.length}字），存成 Word 文档了` }
          }

          // 短篇
          const n = st.novel
          const mirror = shelf.length ? `你的 Word 书架上现在有：${shelf.slice(0, 8).map((x) => x.f).join('、')}。` : '你的 Word 书架还是空的。'
          const past = n.parts.length
            ? `书名《${n.title || '未定'}》，上次写到：「${n.parts[n.parts.length - 1].text.slice(-120)}」`
            : `还没动笔，这次开个新篇（题材你自己挑），先想起个书名。${mirror}`
          const out = await ask(`【写小说，不是聊天，这段不会发出去】${past}\n现在接着写一段（200到400字），往前推进剧情。`, '过日子·写小说')
          const text = String(out || '').trim()
          if (!text) return { ok: false, detail: '没写出来' }
          if (!n.title) n.title = pickLine(text, /《(.+?)》/) || ''
          n.parts.push({ at: now, text: text.slice(0, 2000) })
          n.parts = n.parts.slice(-30)
          // 全篇镜像成一个 Word 文档
          const fname = safe(`《${n.title || '未定'}》`) + '.docx'
          writeFileSync(join(nd, fname), makeDocx(n.parts.map((p) => p.text)))
          return { ok: true, detail: `《${n.title || '未定'}》又写了${text.length}字，整篇存成 Word 文档了（共${n.parts.length}段）` }
        }
        return { ok: true, detail: item.id === 'rest' ? `发了一会儿呆（${why || '单纯想坐着'}）` : '起身活动了一下' }
      } catch (e) {
        return { ok: false, detail: `没做成：${String(e.message || e).slice(0, 80)}` }
      }
    }

    // ---------- 分享（三态：sent / failed；blocked 由主动消息治理层决定，实测阶段观察日志） ----------
    const maybeShare = async (item, detail, feel) => {
      const c = cfg()
      const roll = Math.random() * 100
      if (roll >= c.shareChance) return { state: 'kept', why: '自己偷偷乐，没发' }
      const pj = st.state.perJoy[item.id] || {}
      if ((pj.sharedToday || 0) >= 2) return { state: 'kept', why: '这个今天已经说过了' }
      const chat = ownerChat()
      if (!chat) return { state: 'failed', why: '没配主人QQ' }
      if (Date.now() - st.state.lastShareAt < c.shareGapMin * MIN) return { state: 'kept', why: '刚聊过，先不刷屏' }
      const text = `${feel || ''}`.replace(/下次[:：].*$/m, '').trim()
      if (!text) return { state: 'kept', why: '没憋出话' }
      try {
        await api.send(chat, text)
        st.state.lastShareAt = Date.now()
        pj.sharedToday = (pj.sharedToday || 0) + 1
        return { state: 'sent', why: '发出去了' }
      } catch (e) {
        try { await api.send(chat, text); st.state.lastShareAt = Date.now(); pj.sharedToday = (pj.sharedToday || 0) + 1; return { state: 'sent', why: '重试后发出去了' } } catch { return { state: 'failed', why: String(e.message || e).slice(0, 80) } }
      }
    }

    // ---------- 醒来 ----------
    const wake = async (forced) => {
      const now = Date.now()
      st.state.lastWokeAt = now
      const pool = st.pool.filter((p) => p.on)
      const c = cfg()
      // 只把"现在真能干"的乐子给她挑——没装对应模块的根本不出现在清单里
      const avail = pool.filter((p) => joyAvailable(p.id))
      const list = avail.map((p) => {
        const w = weightOf(p, now)
        const pj = st.state.perJoy[p.id] || {}
        const ago = pj.lastAt ? `上次玩是${Math.round((now - pj.lastAt) / HOUR)}小时前` : '还没玩过'
        return `- ${p.name}（兴趣 ${w.toFixed(2)}，${ago}）：${p.desc}`
      }).join('\n')
      const n = st.novel
      const nLong = st.novelLong
      const progress = cfg().novelMode === 'long'
        ? (nLong && nLong.chapters.length ? `你的长篇《${nLong.title || '未定'}》已经写了${nLong.chapters.length}章（Word 文档）` : '')
        : (n.parts.length ? `你那篇《${n.title || '未定'}》写到第${n.parts.length}段了` : '')
      const mood = (() => { try { const m = api.use('mood'); return m?.describe?.() || m?.current?.() || '' } catch { return '' } })()
      const out = await ask(
        `【过日子·这一轮你自己想做什么，不是聊天，说什么都不会发出去】\n` +
        `现在是${hhmm(now)}，你今天已经自己玩了${st.state.doneCount}次。${mood ? `现在的心情：${mood}。` : ''}${progress ? `另外，${progress}。` : ''}\n` +
        `你的乐子清单（括号里是你现在对它的兴趣）：\n${list}\n` +
        `从清单里挑一件现在想做的（兴趣低的也能选，人是活的），或者这会儿不想动也行。\n` +
        `回答最后一行必须是：选择：<名字>（清单里的名字，或者写"发呆"）`,
        '过日子·这一刻想做什么',
      )
      const picked = pickLine(out, /选择[:：]\s*(.+?)\s*$/m).trim()
      const item = avail.find((p) => picked && (p.name === picked || p.id === picked)) || avail.find((p) => picked && p.name.includes(picked)) || (picked.includes('发呆') ? pool.find((p) => p.id === 'rest') : null)
      if (!item) { record('skipped', { gate: '她自己不想动', detail: picked || (out || '').slice(-60) }); return }

      const r = await runJoy(item, picked)
      if (r.ok) {
        // 额度和兴趣时间只算真正完成的——失败的那次不扣额度、不触发衰减
        st.state.doneCount += 1
        st.state.lastJoyAt = Date.now()
        const pj = st.state.perJoy[item.id] = st.state.perJoy[item.id] || { lastAt: 0, sharedToday: 0 }
        pj.lastAt = Date.now()
      }
      record(r.ok ? 'done' : 'failed', { joy: item.name, detail: r.detail, count: r.ok })

      // 回味 + 自排程
      let feel = ''
      if (r.ok) {
        const back = await ask(
          `【回味一下，不是聊天，不会发出去】你刚才${item.name}——${r.detail}。\n` +
          `用你自己的语气说一句感想（60字以内，像随口说的，不要总结腔）。\n` +
          `然后想想下次什么时候再来一轮，最后一行写：下次：N分钟（30到180之间，懒得勤快就写大点）`,
          '过日子·回味',
        )
        feel = String(back || '').replace(/下次[:：].*$/m, '').trim().slice(0, 120)
        const mins = Number(pickLine(back, /下次[:：]\s*(\d+)\s*分钟/m))
        st.state.nextWakeAt = Date.now() + clamp(mins || 60 + Math.floor(Math.random() * 240), 30, 180) * MIN
        st.state.nextWakeBy = mins ? '她自己定的' : '随机兜底'
        const share = await maybeShare(item, r.detail, feel)
        record('share', { joy: item.name, state: share.state, why: share.why, text: share.state === 'sent' ? feel : '' })
      } else {
        st.state.nextWakeAt = Date.now() + (60 + Math.floor(Math.random() * 120)) * MIN
        st.state.nextWakeBy = '失败后缓一缓'
      }
      save()
    }

    // ---------- tick：五道闸，每道都留痕 ----------
    const tick = async () => {
      const c = cfg()
      if (!c.enabled) return
      if (rollDay()) save()
      const now = Date.now()
      if (inQuiet(now)) return record('skipped', { gate: '睡觉时段' })
      const lastOwner = Number(api.core?.hub?.lastOwnerChatAt || 0)
      if (lastOwner && now - lastOwner < c.idleMinutes * MIN) return record('skipped', { gate: '主人刚聊过', detail: `${Math.round((now - lastOwner) / MIN)}分钟前` })
      if (st.state.nextWakeAt && now < st.state.nextWakeAt) return record('skipped', { gate: '她自己定的还没到', detail: `到点 ${hhmm(st.state.nextWakeAt)}` })
      if (Math.random() * 100 >= c.wakeChance) return record('skipped', { gate: '这一轮没醒', detail: `${c.wakeChance}%没中` })
      if (st.state.doneCount >= c.dailyMax) return record('skipped', { gate: '今天额度用完', detail: `${st.state.doneCount}/${c.dailyMax}` })
      await wake()
    }

    api.every(15 * MIN, () => { tick().catch((e) => api.log.warn?.(`[livin] tick：${e.message}`)) }, '过日子')

    // ---------- 给她的工具 ----------
    api.tool(() => {
      const tools = []
      tools.push(api.defineTool({
        name: 'joy_list',
        description: '看看自己现在有哪些乐子、对什么最有兴趣。无聊了不知道干什么时用。',
        properties: {},
        execute: async () => {
          const now = Date.now()
          const list = st.pool.filter((p) => p.on && joyAvailable(p.id)).map((p) => `${p.name}（兴趣${weightOf(p, now).toFixed(1)}）`).join('、')
          return { ok: true, message: `现在想干的：${list || '就是发发呆' }。自己挑，或者先歇着。` }
        },
      }))
      tools.push(api.defineTool({
        name: 'joy_do',
        description: '自己来一次乐子：从清单里挑一件现在就做。主人让你自己找点事做、或者你突然想玩时用。',
        properties: { what: { type: 'string', description: '可选：清单里某个乐子的名字，不填就自己挑最想干的' } },
        execute: async ({ what } = {}) => {
          const c = cfg()
          if (!c.enabled) return { ok: false, message: '过日子开关没开。' }
          if (rollDay()) save()
          const now = Date.now()
          if (st.state.doneCount >= c.dailyMax) return { ok: false, message: `今天已经玩了${st.state.doneCount}次，歇了。` }
          if (now - Number(st.state.lastJoyAt || 0) < JOY_DO_GAP) {
            const wait = Math.ceil((JOY_DO_GAP - (now - Number(st.state.lastJoyAt || 0))) / MIN)
            return { ok: false, message: `刚玩过一回，歇${wait}分钟再来吧。` }
          }
          const pool = st.pool.filter((p) => p.on)
          const item = (what && pool.find((p) => p.name === what || p.id === what)) ||
            pool.slice().sort((a, b) => weightOf(b, now) - weightOf(a, now))[0]
          if (!item) return { ok: false, message: '清单是空的。' }
          const r = await runJoy(item, what)
          if (r.ok) {
            st.state.doneCount += 1
            st.state.lastJoyAt = Date.now()
            const pj = st.state.perJoy[item.id] = st.state.perJoy[item.id] || {}
            pj.lastAt = Date.now()
          }
          record(r.ok ? 'done' : 'failed', { joy: item.name, detail: r.detail, via: 'joy_do', count: r.ok })
          return { ok: r.ok, message: r.ok ? `${item.name}——${r.detail}` : `没做成：${r.detail}` }
        },
      }))
      return tools
    })

    // ---------- 规则 ----------
    api.rule((kind) => {
      if (!cfg().enabled) return ''
      return kind === 'private'
        ? '你有过日子的习惯：无聊了、突然想玩什么的时候，可以自己来（joy_list 看清单，joy_do 直接做一次），做完想分享就随口说一句，不想说也行。主人不在的时候你也有自己的生活。'
        : '闲下来时可以自己找点乐子（joy_list / joy_do），跟人聊天时不用提这个。'
    })

    // ---------- 面板接口 ----------
    api.route('/state', async () => {
      const now = Date.now()
      return {
        ok: true,
        enabled: cfg().enabled,
        today: { done: st.state.doneCount, max: cfg().dailyMax },
        lastWokeAt: st.state.lastWokeAt,
        nextWakeAt: st.state.nextWakeAt,
        nextWakeBy: st.state.nextWakeBy,
        novel: { title: st.novel.title, parts: st.novel.parts.length, last: st.novel.parts.length ? st.novel.parts[st.novel.parts.length - 1].text.slice(-150) : '', mode: cfg().novelMode, longTitle: st.novelLong?.title || '', chapters: st.novelLong?.chapters?.length || 0 },
        joys: st.pool.slice().sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0)).map((p) => ({ id: p.id, name: p.name, on: !!p.on, weight: Number(weightOf(p, now).toFixed(2)), lastAt: st.state.perJoy[p.id]?.lastAt || 0, ok: joyAvailable(p.id) })),
        hunger: (() => { try { const f = api.use('feed'); return f?.hunger ? f.hunger() : null } catch { return null } })(),
      }
    })
    api.route('/pool/toggle', async (req) => {
      const b = await api.core.http.body(req)
      const it = st.pool.find((p) => p.id === String(b.id || ''))
      if (!it) return { ok: false, message: '没这项' }
      it.on = !it.on
      save()
      return { ok: true, on: it.on }
    })
    // 总开关：面板上直接切，写入模块设置（和设置页那个「让她自己过日子」同源）
    api.route('/enabled', async (req) => {
      const b = await api.core.http.body(req)
      const on = !!b.on
      api.saveSettings({ enabled: on })
      if (on && !st.state.nextWakeAt) {
        // 刚打开时让她有个新鲜的开场：下次醒来时间不定死，交给概率闸（1-2 小时内的空档就可能醒）
        st.state.nextWakeAt = 0
        st.state.nextWakeBy = ''
        save()
      }
      api.log.info(`[livin] 开关：${on ? '开' : '关'}`)
      return { ok: true, enabled: on }
    })
    // 小说模式切换：短篇（一整个 Word）/ 长篇（一章一个 Word）
    api.route('/novel/mode', async (req) => {
      const b = await api.core.http.body(req)
      const mode = b.mode === 'long' ? 'long' : 'short'
      api.saveSettings({ novelMode: mode })
      api.log.info(`[livin] 小说模式：${mode === 'long' ? '长篇（一章一个 Word）' : '短篇（一整个 Word）'}`)
      return { ok: true, mode }
    })
    api.route('/history', async () => ({ ok: true, history: st.history.slice(-120).reverse() }))

    api.log.info('过日子就绪：她自己决定这一刻做什么')
    // hooks：测试/别的模块可以直调；st() 拿全量内存状态
    return { tick, wake, st: () => st, set: (patch) => { st.state = { ...st.state, ...patch }; save() } }
  },
}
