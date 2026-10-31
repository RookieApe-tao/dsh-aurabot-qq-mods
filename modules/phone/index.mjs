// index.mjs —— phone 模块入口（装配层，契约 B 节约定）
// 作用：把底座层（adb/nodes/session/safety/env）与流程/记忆/工作区层装配成完整模块：
//       settings 面板、三个 AI 工具、/phone 命令、消息触发词、定时清扫+cron、面板路由。
// 契约：lib 底座层签名见 .pm-handoff/phone-contract.md A 节（唯一仲裁）。

import { createAdb } from './lib/adb.mjs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createSession } from './lib/session.mjs'
import { createSafety } from './lib/safety.mjs'
import { ensureAdb } from './lib/env.mjs'
import { createFlows } from './lib/flows.mjs'
import { createMemory } from './lib/memory.mjs'
import { createGuides } from './lib/guides.mjs'
import { runWorkspace, cronMatch } from './lib/workspace.mjs'

const BUSY_WAIT_MS = 120000 // 工具触发时忙等上限：超过则改报「已在后台排队」

export default {
  id: 'phone',
  name: '手机逛逛',
  version: '0.1.0',
  api: 1,
  description: '通过 ADB 逛 Android 手机：按主人教好的流程自动签到/浏览/点赞，或自由推理完成一句话任务。',
  panel: 'panel.js',
  settings: [
    { key: 'whitelist', label: '包名白名单', type: 'textarea', defaults: '', hint: '允许操作的包名白名单，每行一个，空 = 不限制；可用面板「包名白名单助手」从手机里选' },
    { key: 'maxSteps', label: '单次步数上限', type: 'number', defaults: 40, hint: '单个工作区回合最大步数' },
    { key: 'rateLimit', label: '每分钟动作上限', type: 'number', defaults: 30, hint: '每分钟最多动作数' },
    { key: 'confirmWrites', label: '写操作需确认', type: 'switch', defaults: true, hint: '发帖/评论/点赞等写操作需主人确认' },
    { key: 'dryRun', label: '试运行', type: 'switch', defaults: false, hint: '试运行：只出计划不真点击' },
    { key: 'sessionTimeoutMs', label: '会话超时（毫秒）', type: 'number', defaults: 900000, hint: '会话超时（毫秒）' },
    { key: 'writeEventMemory', label: '跑完写入她的记忆', type: 'switch', defaults: true, hint: '每次任务结束把结果写一条进记忆模块（像刷抖音那样让她记得做过什么）' },
    // 默认用 'provider::model' 存（面板「决策模型」下拉管理，参考系统菜单模型页的按聊天选模型）
    { key: 'decisionModel', label: '决策模型', type: 'text', defaults: '', hint: '操作决策器（看界面挑动作）用的模型，provider::model；留空 = 跟随全局模型。在面板里选更方便' },
  ],

  setup(api) {
    const dataDir = () => api.dataDir()
    const getSettings = () => {
      const s = api.settings()
      return {
        adbPath: String(s.adbPath || ''),
        deviceSerial: String(s.deviceSerial || ''),
        whitelist: String(s.whitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        maxSteps: Number(s.maxSteps) || 40,
        rateLimit: Number(s.rateLimit) || 30,
        confirmWrites: s.confirmWrites !== false,
        dryRun: !!s.dryRun,
        sessionTimeoutMs: Number(s.sessionTimeoutMs) || 900000,
        writeEventMemory: s.writeEventMemory !== false,
        decisionModel: String(s.decisionModel || ''), // 'provider::model'，空 = 跟随全局模型
      }
    }
    /** 决策模型选择：'provider::model' → { provider, model }；没选返回 null（用全局模型） */
    function modelSel() {
      const v = getSettings().decisionModel
      const i = v.indexOf('::')
      if (i <= 0 || i === v.length - 2) return null
      return { provider: v.slice(0, i), model: v.slice(i + 2) }
    }

    // ---- 子系统（session/safety/flows/memory 不依赖 adb，可直接建）----
    const session = createSession({ timeoutMs: getSettings().sessionTimeoutMs })
    const safety = createSafety({ dataDir: dataDir(), getSettings })
    const flows = createFlows(dataDir())
    const memory = createMemory({ dataDir: dataDir(), ask: (p) => api.ask(p) })
    const guides = createGuides(dataDir())

    // ---- 惰性 adb：首次用到手机功能才 ensureAdb，结果缓存在闭包里 ----
    let adbCache = null // { adbPath, installed, source }
    async function ensureReady() {
      if (adbCache) return adbCache
      adbCache = await ensureAdb({
        adbPath: getSettings().adbPath,
        dataDir: dataDir(),
        log: (t) => api.log.info(`[phone] ${t}`),
      })
      return adbCache
    }
    async function getAdb() {
      const env = await ensureReady()
      if (!env.adbPath) throw new Error('没有可用的 adb：请配置 adbPath 或允许自动安装')
      const s = getSettings()
      return createAdb({ adbPath: env.adbPath, serial: s.deviceSerial, timeoutMs: 10000 })
    }

    // ---- 工作区上下文（adb 由调用方注入，见 startRun）----
    function makeCtx(report) {
      return {
        session, safety, memory,
        // 操作决策器的每次提问走这里：选了「决策模型」就按次覆盖（api.ask 的 opts.cfg 压过全局配置），没选就跟随全局
        ask: (p) => {
          const m = modelSel()
          if (!m) return api.ask(p)
          return api.ask({ ...(typeof p === 'string' ? { text: p } : p), cfg: { model: m } })
        },
        report,
      }
    }
    /** adhoc 临时流程 key：md5(goal) 前 8 位（设计稿 §8） */
    const adhocKey = (goal) => 'adhoc-' + createHash('md5').update(String(goal)).digest('hex').slice(0, 8)

    /** 起一个工作区回合；返回 { ok, message }（工具/命令面统一格式） */
    async function startRun({ flowKey, prompt, packages, report, guide }) {
      const s = getSettings()
      const adb = await getAdb()
      const ctx = { ...makeCtx(report), adb }
      return runWorkspace({ flowKey, prompt, packages, maxSteps: s.maxSteps, guide, ctx })
        .then((r) => ({ ok: r.ok, message: `${r.ok ? '完成' : '未完成'}（${r.steps} 步）：${r.summary}`, steps: r.steps, summary: r.summary }))
        .catch((e) => ({ ok: false, message: `工作区启动失败：${e.message}` }))
    }

    // ---- 跑完流程（参考刷抖音模块）：是否汇报主人（hub.sendText 私聊主人）、是否写入她的记忆 ----
    async function runFlow(flow, { originChatId = '' } = {}) {
      const s = getSettings()
      const guideKey = guides.resolve({ packages: flow.packages, goal: flow.prompt, flowGuide: flow.guide })
      const r = await startRun({ flowKey: flow.id, prompt: flow.prompt, packages: flow.packages, guide: guides.get(guideKey) })
      const text = `${flow.name} ${r.message}`
      const to = flow.reportTo || 'origin'
      if (to === 'owner') {
        const qq = String(api.config().ownerQQ || '').trim()
        if (qq) { try { await api.core.hub.sendText(`private:${qq}`, `📱${text}`) } catch { /* 汇报失败不影响结果 */ } }
        else api.log.warn('[phone] reportTo=owner 但配置里没有 ownerQQ，改回本次来源汇报')
      } else if (to === 'origin' && originChatId && originChatId !== 'cron') {
        try { await api.sendText(originChatId, text) } catch { /* 同上 */ }
      }
      if (s.writeEventMemory !== false) {
        api.use('memory')?.addEvent?.({
          text: `手机任务「${String(flow.prompt).slice(0, 40)}」${r.ok ? '完成' : '未完成'}：${r.summary.slice(0, 80)}`,
          tags: ['手机逛逛'],
          importance: 0.35,
        })
      }
      return { ...r, message: text }
    }

    /** adhoc 自由推理：按 goal 关键词挑指引，跑完同样走记忆（不主动汇报主人） */
    function runGoal(goal) {
      const key = adhocKey(goal)
      const guide = guides.get(guides.resolve({ goal }))
      return startRun({ flowKey: key, prompt: String(goal), packages: [], guide })
    }

    // ---- 忙时竞速：120s 内没等到结果就改报「已在后台排队」 ----
    function busyRace(promiseFactory) {
      return new Promise((resolve) => {
        let settled = false
        api.later(BUSY_WAIT_MS, () => { // 计时到点仍未结束 → 报排队（任务本身继续在后台跑）
          if (!settled) { settled = true; resolve({ ok: true, message: '手机正被其他任务占用，已在后台排队，完成后另行汇报。' }) }
        })
        promiseFactory().then((r) => {
          if (!settled) { settled = true; resolve(r) }
        }).catch((e) => {
          if (!settled) { settled = true; resolve({ ok: false, message: `执行失败：${e.message}` }) }
        })
      })
    }

    // ================= 工具面（api.tool，execute 返回 { ok, message }）=================
    api.tool(() => [
      api.defineTool({
        name: 'phone_run_flows',
        description: '列出主人教好的手机自动流程（名称/触发词/定时/开关）。主人问「能帮我自动做什么」或选流程前先用。',
        properties: {},
        execute: async () => {
          const list = flows.list().filter((f) => f.enabled !== false)
          return {
            ok: true,
            message: list.length
              ? list.map((f) => `${f.id}：${f.name}${f.cron ? `（定时 ${f.cron}）` : ''}`).join('\n')
              : '还没有流程，可用 phone flow add 教一个。',
          }
        },
      }),
      api.defineTool({
        name: 'phone_run_flow',
        description: '触发一个已教好的手机流程（开工作区自动操作手机）。主人点名要跑某流程时用。',
        properties: { id: { type: 'string', description: '流程 id' }, note: { type: 'string', description: '本次附加要求（可选）' } },
        required: ['id'],
        execute: async ({ id, note }) => {
          const flow = flows.get(String(id))
          if (!flow) return { ok: false, message: `没有流程 ${id}` }
          const f = note ? { ...flow, prompt: `${flow.prompt}\n附加：${note}` } : flow
          if (session.status().owner) return busyRace(() => runFlow(f))
          return runFlow(f)
        },
      }),
      api.defineTool({
        name: 'phone_act',
        description: '让 AI 遥控手机自由完成一句话任务（打开应用、点界面、输入文字）。主人说「帮我在手机上做某某事」且没有现成流程时用。',
        properties: { goal: { type: 'string', description: '一句话任务描述' } },
        required: ['goal'],
        execute: async ({ goal }) => {
          if (session.status().owner) return busyRace(() => runGoal(goal))
          return runGoal(goal)
        },
      }),
    ])

    // ================= /phone 命令 =================
    api.command({
      name: 'phone',
      desc: '手机逛逛：flows / flow add|set|del / run / mem / status / confirm',
      async run(arg, msg) {
        const [verb, ...rest] = arg.trim().split(/\s+/)
        try {
          switch (verb) {
            case 'flows': {
              const list = flows.list()
              return list.length
                ? list.map((f) => `${f.id}｜${f.name}${f.enabled === false ? '（停用）' : ''}${f.cron ? ` cron:${f.cron}` : ''}${f.guide ? ` 指引:${f.guide}` : ''}${f.reportTo && f.reportTo !== 'origin' ? ` 汇报:${f.reportTo}` : ''}`).join('\n')
                : '还没有流程。用 phone flow add <名称> 教一个。'
            }
            case 'flow': {
              const [sub, id, field, ...val] = rest
              if (sub === 'add') {
                if (!id) return '用法：phone flow add <id>（流程名用 set name 补）'
                flows.upsert(id, { name: id, prompt: '', triggers: [], packages: [], enabled: true })
                return `已建流程 ${id}。接着用 phone flow set ${id} prompt <目标描述> 教它做什么。`
              }
              if (sub === 'set') {
                if (!id || !field) return '用法：phone flow set <id> <name|prompt|triggers|packages|cron|guide|reportTo|enabled|maxSteps> <值>'
                const flow = flows.get(id)
                if (!flow) return `没有流程 ${id}`
                const value = val.join(' ')
                const patch = {}
                if (field === 'triggers' || field === 'packages') patch[field] = value.split(/[,，\s]+/).filter(Boolean)
                else if (field === 'enabled') patch.enabled = !/^(false|0|off|停用)$/i.test(value)
                else if (field === 'maxSteps') patch.maxSteps = Number(value) || flow.maxSteps
                else if (field === 'reportTo') patch.reportTo = ['origin', 'owner', 'none'].includes(value) ? value : flow.reportTo
                else patch[field] = value
                flows.upsert(id, patch)
                return `已更新 ${id}.${field}。`
              }
              if (sub === 'del') {
                return flows.remove(rest[0]) ? `已删除 ${rest[0]}` : `没有流程 ${rest[0]}`
              }
              return '用法：phone flow add|set|del ...'
            }
            case 'run': {
              const id = rest[0]
              const flow = flows.get(id)
              if (!flow) return `没有流程 ${id}`
              const r = await runFlow(flow, { originChatId: msg.chatId })
              return `${r.ok ? '完成' : '未完成'}（${r.steps} 步）：${r.summary}`
            }
            case 'mem': {
              if (rest[0] === 'clear') {
                memory.clear(rest[1])
                return `已清空 ${rest[1]} 的记忆。`
              }
              const mem = memory.load(rest[0])
              return mem ? `${rest[0]}（已运行 ${mem.runs} 次）：${mem.summary}` : `${rest[0]} 还没有记忆。`
            }
            case 'status': {
              const st = session.status()
              const todayLog = safety.listConfirms()
              let device = 'adb 未就绪'
              try {
                const adb = await getAdb()
                device = (await adb.devices()).join(', ') || '无设备'
              } catch (e) { device = `adb 错误：${e.message}` }
              return `设备：${device}\n会话：${st.owner ? `被 ${st.owner} 占用` : '空闲'}\n待确认写操作：${todayLog.length} 条`
            }
            case 'confirm': {
              const [sub, numStr] = rest
              const list = safety.listConfirms()
              if (!sub || sub === 'list') {
                return list.length
                  ? list.map((c, i) => `${i + 1}. ${c.pkg} 「${c.nodeText}」 ${new Date(c.at).toLocaleTimeString()}`).join('\n')
                  : '没有待确认的写操作。'
              }
              const idx = Number(numStr) - 1
              const item = list[idx]
              if (!item) return '序号不对，先 phone confirm 看列表。'
              if (sub === '批准' || sub === 'approve') { safety.approveConfirm(item.id); return `已批准第 ${idx + 1} 条。` }
              if (sub === '拒绝' || sub === 'reject') { safety.rejectConfirm(item.id); return `已拒绝第 ${idx + 1} 条。` }
              return '用法：phone confirm [批准|拒绝 <序号>]'
            }
            case '':
              return '用法：phone flows|flow add|set|del|run|mem|status|confirm ...'
            default:
              return `未知子命令 ${verb}`
          }
        } catch (e) {
          return `出错了：${e.message}`
        }
      },
    })

    // ================= 消息触发词接管 =================
    api.on('message', async (msg) => {
      const text = String(msg.text || msg.content || '')
      if (!text) return false
      const flow = flows.findTrigger(text)
      if (!flow) return false
      const r = await runFlow(flow, { originChatId: msg.chatId })
      if ((flow.reportTo || 'origin') !== 'none') await api.reply(msg, r.message)
      return true // 接管这条消息
    })

    // ================= 定时：30s 清扫（会话超时 + cron 到点）=================
    let lastCronMinute = '' // 防止同一分钟内 30s tick 重复触发
    function sweep() {
      // cron 扫描：enabled 且带 cron 的流程，当前分钟匹配且未触发过则跑
      const now = new Date()
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`
      if (minuteKey !== lastCronMinute) {
        lastCronMinute = minuteKey
        for (const flow of flows.list()) {
          if (flow.enabled === false || !flow.cron) continue
          if (!cronMatch(flow.cron, now)) continue
          // 忙时不抢：会话被占则这一分钟放弃，下轮 cron 再看
          if (session.status().owner) { api.log.warn(`[phone] 会话被占，跳过 cron 触发 ${flow.id}`); continue }
          startRun({ flowKey: flow.id, prompt: flow.prompt, packages: flow.packages, guide: guides.get(guides.resolve({ packages: flow.packages, goal: flow.prompt, flowGuide: flow.guide })) })
            .then((r) => {
              // cron 触发没有消息来源：reportTo=origin 时改私聊主人（无来源可回）
              const to = flow.reportTo || 'origin'
              const qq = String(api.config().ownerQQ || '').trim()
              if (qq && (to === 'owner' || to === 'origin')) {
                api.core.hub.sendText(`private:${qq}`, `📱${flow.name} ${r.ok ? '完成' : '未完成'}（${r.steps} 步）：${r.summary}`).catch(() => {})
              }
              if (getSettings().writeEventMemory !== false) {
                api.use('memory')?.addEvent?.({ text: `手机任务「${String(flow.prompt).slice(0, 40)}」${r.ok ? '完成' : '未完成'}：${r.summary.slice(0, 80)}`, tags: ['手机逛逛'], importance: 0.35 })
              }
            })
            .catch((e) => api.log.error(`[phone] cron ${flow.id} 失败：${e.message}`))
        }
      }
    }
    api.every(30000, sweep, 'phone-sweep')

    // ================= 面板路由（精确匹配，前缀 /aurabot/api/ext/phone）=================
    const json = (data) => data // route 返回对象即 JSON
    api.route('/flows', async (req, res) => {
      if (req.method === 'GET') return json({ flows: flows.list() })
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (!body.id) return json({ ok: false, error: '缺少 id' })
        const flow = flows.upsert(String(body.id), body.patch || body)
        return json({ ok: true, flow })
      }
      if (req.method === 'DELETE') {
        const id = new URL(req.url, 'http://x').searchParams.get('id')
        return json({ ok: flows.remove(id) })
      }
      return json({ ok: false, error: '不支持的方法' })
    })
    api.route('/run', async (req) => {
      if (req.method !== 'POST') return json({ ok: false, error: '只支持 POST' })
      const body = await api.core.http.body(req).catch(() => ({}))
      if (body.id) {
        const flow = flows.get(String(body.id))
        if (!flow) return json({ ok: false, error: '没有该流程' })
        busyRace(() => runFlow(flow))
        return json({ ok: true, queued: !!session.status().owner })
      }
      if (body.goal) {
        busyRace(() => runGoal(body.goal))
        return json({ ok: true, queued: !!session.status().owner })
      }
      return json({ ok: false, error: '需要 id 或 goal' })
    })
    api.route('/memory', (req, res) => {
      const url = new URL(req.url, 'http://x')
      const key = url.searchParams.get('key')
      if (req.method === 'GET') {
        if (!key) return json({ error: '需要 key 参数' })
        return json({ memory: memory.load(key) })
      }
      if (req.method === 'DELETE') return json({ ok: memory.clear(key) })
      return json({ ok: false })
    })
    api.route('/confirm', async (req) => {
      if (req.method === 'GET') return json({ confirms: safety.listConfirms() })
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (body.approve && body.id) { safety.approveConfirm(String(body.id)); return json({ ok: true }) }
        if (body.reject && body.id) { safety.rejectConfirm(String(body.id)); return json({ ok: true }) }
        return json({ ok: false, error: '需要 { approve|reject, id }' })
      }
      return json({ ok: false })
    })
    // ---- 指引提示词库：面板查看/编辑自定义指引 ----
    api.route('/guides', async (req) => {
      if (req.method === 'GET') return json({ guides: guides.list() })
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        try {
          if (body.reset) return json({ ok: guides.remove(String(body.key || '')) })
          const g = guides.upsert(String(body.key || ''), { name: body.name, text: body.text })
          return json({ ok: true, guide: { key: g.key, name: g.name, source: 'custom' } })
        } catch (e) { return json({ ok: false, error: e.message }) }
      }
      if (req.method === 'DELETE') {
        const key = new URL(req.url, 'http://x').searchParams.get('key')
        return json({ ok: guides.remove(key) })
      }
      return json({ ok: false })
    })
    // ---- 决策模型：列出 DSH 里可用的模型（同宿主 /models，模型页的下拉数据源）----
    api.route('/models', async () => {
      try { return json({ ok: true, list: await api.core.listModels() }) }
      catch (e) { return json({ ok: false, error: e.message, list: [] }) }
    })
    // ---- 面板辅助：不带 serial 的 adb（列设备/列包名用，不依赖已选设备）----
    async function rawAdb() {
      const env = await ensureReady()
      if (!env.adbPath) throw new Error('没有可用的 adb：请先在面板选择或自动安装')
      return createAdb({ adbPath: env.adbPath, serial: '', timeoutMs: 10000 })
    }
    /** 扫描本机常见位置的 adb.exe，返回存在的候选路径 */
    async function scanCandidates() {
      const home = process.env.USERPROFILE || ''
      const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      const cands = [
        getSettings().adbPath,
        join(dataDir(), 'platform-tools', 'platform-tools', 'adb.exe'),
        join(dataDir(), 'platform-tools', 'adb.exe'),
        join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        'C:\\platform-tools\\adb.exe',
        'D:\\platform-tools\\adb.exe',
        join(local, 'Android', 'platform-tools', 'adb.exe'),
      ].filter(Boolean)
      // PATH 里能找到的也列出来
      await new Promise((resolve) => {
        execFile('where', ['adb'], { timeout: 5000 }, (err, stdout) => {
          if (!err && stdout) for (const line of String(stdout).split(/\r?\n/)) if (line.trim()) cands.push(line.trim())
          resolve()
        })
      })
      return [...new Set(cands)].filter((p) => existsSync(p))
    }

    api.route('/adb/candidates', async () => {
      try {
        return json({ ok: true, candidates: await scanCandidates() })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })
    api.route('/adb/install', async () => {
      try {
        const env = await ensureAdb({ adbPath: '', dataDir: dataDir(), log: (t) => api.log.info(`[phone] ${t}`) })
        if (!env.adbPath)
          return json({ ok: false, error: `自动安装失败（${env.error || '所有下载镜像都不可达'}），请点「选择本地 adb」手动挑一个` })
        adbCache = env // 安装成功就更新闭包缓存
        return json({ ok: true, adbPath: env.adbPath })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })
    // 弹出系统文件选择框挑 adb.exe（面板跑在本机浏览器上，服务端 PowerShell 弹原生对话框即可）
    api.route('/adb/pickfile', async () => {
      if (process.platform !== 'win32')
        return json({ ok: false, error: '本功能仅支持 Windows，其他平台请在设置里直接填写 adb 路径' })
      // 置顶隐藏 owner 窗体：保证对话框弹到最前（无 owner 时可能被压在别的窗口后面看不见）
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$o = New-Object System.Windows.Forms.Form",
        "$o.TopMost = $true",
        "$o.ShowInTaskbar = $false",
        "$f = New-Object System.Windows.Forms.OpenFileDialog",
        "$f.Title = '选择 adb 可执行文件'",
        "$f.Filter = 'adb (adb.exe)|adb.exe|程序 (*.exe)|*.exe|所有文件 (*.*)|*.*'",
        "$r = $f.ShowDialog($o)",
        "$o.Dispose()",
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName }",
      ].join('; ')
      // System32 绝对路径优先，PATH 被裁剪的宿主环境也能找到
      const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      try {
        const p = await new Promise((resolve, reject) => {
          execFile(psExe, ['-NoProfile', '-STA', '-Command', ps],
            { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
              if (err) reject(new Error(`${err.code || err.message}${stderr ? ' | ' + String(stderr).trim().slice(0, 300) : ''}`))
              else resolve(String(stdout).trim())
            })
        })
        if (!p) return json({ ok: false, error: '没有选择文件' })
        if (!existsSync(p)) return json({ ok: false, error: '所选文件不存在：' + p })
        return json({ ok: true, path: p })
      } catch (e) {
        const msg = String(e.message || e)
        if (/超时|timeout|ETIMEDOUT/i.test(msg))
          return json({ ok: false, error: '打开选择框超时：请在屏幕最前层找一下「选择 adb 可执行文件」窗口，或改用「扫描本机」' })
        return json({ ok: false, error: '打开选择框失败：' + msg })
      }
    })
    api.route('/adb/devices', async () => {
      try {
        const adb = await rawAdb()
        const out = await adb.devices()
        const devices = out.split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => {
          const [serial, , extra] = l.split(/\s+/)
          const model = (extra || '').match(/model:(\S+)/)?.[1] || ''
          const state = l.split(/\s+/)[1] || ''
          return { serial, model, state }
        })
        return json({ ok: true, devices })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })
    api.route('/adb/packages', async (req) => {
      try {
        const serial = new URL(req.url, 'http://x').searchParams.get('serial') || ''
        const env = await ensureReady()
        if (!env.adbPath) throw new Error('没有可用的 adb：请先在面板选择或自动安装')
        const adb = createAdb({ adbPath: env.adbPath, serial, timeoutMs: 15000 })
        const out = await adb.adb(['shell', 'pm', 'list', 'packages', '-3'])
        const packages = out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort()
        return json({ ok: true, packages })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })

    api.route('/status', async () => {
      let device = 'adb 未就绪'
      try {
        const adb = await getAdb()
        device = (await adb.devices()).join(', ') || '无设备'
      } catch (e) { device = `adb 错误：${e.message}` }
      return json({
        device,
        session: session.status(),
        adbSource: adbCache?.source || 'not-ready',
        confirms: safety.listConfirms().length,
        flows: flows.list().length,
      })
    })

    // ================= 收尾 =================
    api.onDispose(() => session.dispose())

    // setup 返回导出对象（契约 B 节）
    return {
      status: () => ({
        adb: adbCache ? { source: adbCache.source, installed: adbCache.installed } : null,
        session: session.status(),
        flows: flows.list().length,
        confirms: safety.listConfirms().length,
      }),
      ensureReady,
      session,
      safety,
      flows,
      memory,
      guides,
      runWorkspace: (o) => runWorkspace(o),
    }
  },
}
