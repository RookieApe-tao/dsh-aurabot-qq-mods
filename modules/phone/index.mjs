// index.mjs —— phone 模块入口（装配层，契约 B 节约定）
// 作用：把底座层（adb/nodes/session/safety/env）与流程/记忆/工作区层装配成完整模块：
//       settings 面板、三个 AI 工具、/phone 命令、消息触发词、定时清扫+cron、面板路由。
// 契约：lib 底座层签名见 .pm-handoff/phone-contract.md A 节（唯一仲裁）。

import { createAdb } from './lib/adb.mjs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
  // settings 留空：面板字段全部由 panel.js 接管（总开关挂在模块名同一行，避免与原生表单重复）。
  // 默认值兜底有两处：panel.js 的 DEFAULTS（显示用）+ 下面 getSettings()（运行时兜底）。
  settings: [],

  setup(api) {
    const dataDir = () => api.dataDir()
    const getSettings = () => {
      const s = api.settings()
      return {
        enabled: s.enabled === true, // 总开关：默认关，明确 true 才放行
        adbPath: String(s.adbPath || ''),
        deviceSerial: String(s.deviceSerial || ''),
        whitelist: String(s.whitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
        maxSteps: Number(s.maxSteps) || 40,
        rateLimit: Number(s.rateLimit) || 30,
        confirmWrites: s.confirmWrites !== false,
        dryRun: !!s.dryRun,
        closeAppsAfter: s.closeAppsAfter !== false, // 逛完关闭应用进程释放内存：默认开
        sessionTimeoutMs: Number(s.sessionTimeoutMs) || 900000,
        writeEventMemory: s.writeEventMemory !== false,
        decisionModel: String(s.decisionModel || ''), // 'provider::model'，空 = 跟随全局模型
        // 主动逛（照刷B站的节奏三件套）：autoBrowse 默认关、间隔默认 4 小时、每天默认最多 3 轮
        autoBrowse: !!s.autoBrowse,
        intervalHours: Math.max(0.1, Number(s.intervalHours) || 4),
        maxRunsPerDay: (() => { const n = Number(s.maxRunsPerDay); return Number.isFinite(n) && n >= 0 ? n : 3 })(),
      }
    }
    /** 决策模型选择：'provider::model' → { provider, model }；没选返回 null（用全局模型） */
    function modelSel() {
      const v = getSettings().decisionModel
      const i = v.indexOf('::')
      if (i <= 0 || i === v.length - 2) return null
      return { provider: v.slice(0, i), model: v.slice(i + 2) }
    }

    // ---- 总开关拦截提示：工具/触发词/cron/运行入口统一用这句 ----
    const offMsg = () => ({ ok: false, message: '手机逛逛总开关没开：请先到面板打开「总开关」，她才能碰手机。' })

    // ---- 子系统（session/safety/flows/memory 不依赖 adb，可直接建）----
    // 当前工作区任务的取消器（按流程 key 存）：会话超时被强制释放时只 abort 对应任务，
    // 别误伤排队/正在跑的另一轮（一审 #19-6 / 复审第 6 条）
    const aborts = new Map()
    const session = createSession({
      timeoutMs: getSettings().sessionTimeoutMs,
      onSweep: (info) => { try { aborts.get(info?.owner)?.abort(new Error('会话超时被强制释放')) } catch { /* 已结束 */ } },
    })
    const safety = createSafety({ dataDir: dataDir(), getSettings })
    const flows = createFlows(dataDir())
    const memory = createMemory({ dataDir: dataDir(), ask: (p) => api.ask(p) })
    const guides = createGuides(dataDir())

    // ---- 惰性 adb：首次用到手机功能才 ensureAdb，结果缓存在闭包里 ----
    // 测试钩子（照 pet 模块 api.__petTestHooks 模式）：测试注入 fake ensureAdb/createAdb，不打真进程
    const testHooks = api.__phoneTestHooks || {}
    let adbCache = null // { adbPath, installed, source }
    async function ensureReady() {
      if (adbCache) return adbCache
      const env = await (testHooks.ensureAdb || ensureAdb)({
        adbPath: getSettings().adbPath,
        dataDir: dataDir(),
        log: (t) => api.log.info(`[phone] ${t}`),
      })
      adbCache = env
      // 首次解析成功就持久化：自动探测（PATH）/ 自动安装得到的 adb 路径写回设置，
      // 下次（含重启后）直接用配置路径，主人不用每次重新选。配置路径本身不用回写。
      if (env.adbPath && env.source !== 'config') {
        try {
          const cur = api.core.getConfig()
          if (String(cur.ext?.phone?.adbPath || '') !== env.adbPath) {
            api.core.setConfig({ ...cur, ext: { ...cur.ext, phone: { ...(cur.ext?.phone || {}), adbPath: env.adbPath } } })
            api.log.info(`[phone] adb 路径已自动保存：${env.adbPath}`)
          }
        } catch (e) {
          api.log.warn(`[phone] adb 路径自动保存失败：${e.message}`) // 存不上不影响本次使用
        }
      }
      return env
    }
    async function getAdb() {
      const env = await ensureReady()
      if (!env.adbPath) throw new Error('没有可用的 adb：请配置 adbPath 或允许自动安装')
      const s = getSettings()
      return (testHooks.createAdb || createAdb)({ adbPath: env.adbPath, serial: s.deviceSerial, timeoutMs: 10000 })
    }

    // ---- 工作区上下文（adb 由调用方注入，见 startRun）----
    // win 决定决策思考落在哪条工作区会话：
    //   自发（定时器 cron/定时主动逛）→ 共享的「手机逛逛 · 操作决策」一条；
    //   被调用（工具/命令/触发词/面板/跨模块）→ 每次一个独立子智能体会话（key 唯一，互不串上下文），
    //   跑完结果经 Promise 返回给调用方。
    function makeWin(mode, flowKey = '', prompt = '') {
      if (mode !== 'delegate') return { key: 'decision', title: '手机逛逛 · 操作决策' }
      const tag = String(flowKey || adhocKey(prompt)).replace(/[^\w:-]/g, '').slice(0, 20)
      return { key: `task-${tag}-${Date.now().toString(36)}`, title: `手机逛逛 · ${String(prompt).slice(0, 16) || '任务'}` }
    }
    function makeCtx(report, win = { key: 'decision', title: '手机逛逛 · 操作决策' }) {
      return {
        session, safety, memory,
        // 底座层没有 api 句柄，错误经这条回调进插件宿主日志（错误日志统一走插件日志，不单独写文件）
        log: (t) => api.log.warn(`[phone] ${t}`),
        // 操作决策器的每次提问走这里：
        // 默认走 api.think（hub.runSystemTurn）——按 win 落到对应工作区会话窗，主人实时可见；
        // 两个例外仍走 api.ask（直接问模型、不进会话）：① 选了「决策模型」（opts.cfg 压过全局，think 不支持按次换模型）；
        // ② 截图兜底要传整屏图（api.think 只收文字）。
        ask: (p) => {
          const o = typeof p === 'string' ? { text: p } : { ...p }
          const m = modelSel()
          if (m) return api.ask({ ...o, cfg: { model: m } })
          if (Array.isArray(o.images) && o.images.length) return api.ask(o)
          const prompt = [o.system ? `【系统指令（必须严格遵守，只回一个 JSON 动作，不要角色扮演不要多余文字）】\n${o.system}` : '', o.text]
            .filter(Boolean).join('\n\n')
          if (typeof api.think === 'function') {
            return api.think(prompt, { title: win.title, key: win.key, noTools: true, timeoutMs: 180000 })
          }
          return api.ask(o)
        },
        report,
      }
    }
    /** adhoc 临时流程 key：md5(goal) 前 8 位（设计稿 §8） */
    const adhocKey = (goal) => 'adhoc-' + createHash('md5').update(String(goal)).digest('hex').slice(0, 8)

    /** 起一个工作区回合；返回 { ok, message }（工具/命令面统一格式）。
     *  mode：'self' = 定时自发（共享决策会话窗）；
     *        'delegate' = 被调用（默认）——独立决策会话窗（task-*），动作仍由模块执行、每一动过 safety.gate。
     *  方案 A（复审后定）：不再 spawn 子智能体；白名单/限速/写操作确认始终是程序约束，不靠任务书文字。 */
    async function startRun({ flowKey, prompt, packages, report, guide, mode = 'self', maxSteps = 0 }) {
      const s = getSettings()
      const adb = await getAdb()
      // 模块内循环：每一动都过 safety.gate（程序约束）；会话超时被强制释放时 abort 掉本轮（一审 #19-6）
      const ac = new AbortController()
      aborts.set(flowKey, ac)
      const ctx = { ...makeCtx(report, makeWin(mode, flowKey, prompt)), adb, signal: ac.signal }
      return runWorkspace({ flowKey, prompt, packages, maxSteps: Number(maxSteps) || s.maxSteps, guide, ctx })
        .then(async (r) => {
          // 收尾：逛完关掉本轮到过的应用进程，释放手机内存（面板「逛完关闭应用」开关，默认开）。
          // 只关确实到过的前台包，跳过桌面（launcher）；单个关失败只记日志，不影响任务结果汇报。
          let closedNote = ''
          if (s.closeAppsAfter && Array.isArray(r.visited) && r.visited.length) {
            const targets = r.visited.filter((p) => p && !/launcher/i.test(p))
            const closed = []
            for (const p of targets) {
              try { await adb.forceStop(p); closed.push(p) } catch (e) { api.log.warn(`[phone] 关闭应用 ${p} 失败：${e.message}`) }
            }
            if (closed.length) closedNote = `。已关闭应用释放内存：${closed.join('、')}`
          }
          return { ok: r.ok, message: `${r.ok ? '完成' : '未完成'}（${r.steps} 步）：${r.summary}${closedNote}`, steps: r.steps, summary: r.summary }
        })
        .catch((e) => ({ ok: false, message: `工作区启动失败：${e.message}` }))
        .finally(() => { if (aborts.get(flowKey) === ac) aborts.delete(flowKey) })
    }

    // ---- 跑完流程（参考刷抖音模块）：是否汇报主人（hub.sendText 私聊主人）、是否写入她的记忆 ----
    // mode：'self'（定时自发）| 'delegate'（被调用，默认）——决定决策落在共享会话窗还是独立子智能体窗
    async function runFlow(flow, { originChatId = '', mode = 'self' } = {}) {
      const s = getSettings()
      const guideKey = guides.resolve({ packages: flow.packages, goal: flow.prompt, flowGuide: flow.guide })
      // 委派来源由宿主判断（#177 复审），模块不再传 source；单流程的步数上限可覆盖全局设置
      const r = await startRun({ flowKey: flow.id, prompt: flow.prompt, packages: flow.packages, guide: guides.get(guideKey), mode, maxSteps: flow.maxSteps })
      const text = `${flow.name} ${r.message}`
      const to = flow.reportTo || 'origin'
      if (to === 'owner') {
        const qq = String(api.config().ownerQQ || '').trim()
        if (qq) { try { await api.core.hub.sendText(`private:${qq}`, `📱${text}`) } catch (e) { api.log.warn(`[phone] 向主人汇报失败：${e.message}`) } }
        else api.log.warn('[phone] reportTo=owner 但配置里没有 ownerQQ，改回本次来源汇报')
      } else if (to === 'origin' && originChatId && originChatId !== 'cron') {
        try { await api.sendText(originChatId, text) } catch (e) { api.log.warn(`[phone] 向来源汇报失败：${e.message}`) }
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
    function runGoal(goal, mode = 'self') {
      const key = adhocKey(goal)
      const guide = guides.get(guides.resolve({ goal }))
      return startRun({ flowKey: key, prompt: String(goal), packages: [], guide, mode })
    }

    // ================= 主动逛一轮（照刷B站：AI 按总纲自己挑应用，开一个工作区回合自主逛） =================
    const AUTO_STATS = 'auto-stats.json'
    const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    function autoStats() {
      try { return JSON.parse(readFileSync(join(dataDir(), AUTO_STATS), 'utf8')) } catch { return { day: '', runs: 0, lastRun: 0 } }
    }
    function bumpAutoRun() {
      const cur = autoStats()
      const day = dayKey()
      const next = cur.day === day ? { ...cur, runs: cur.runs + 1, lastRun: Date.now() } : { day, runs: 1, lastRun: Date.now() }
      try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(join(dataDir(), AUTO_STATS), JSON.stringify(next), 'utf8') } catch (e) { api.log.warn(`[phone] 主动逛计数写盘失败：${e.message}`) }
      return next
    }
    /** 主动逛一轮：总纲常驻注入 + 决策器落到某个应用时才按需加载该应用手册（省 token）；跑完私聊汇报 + 写记忆 */
    async function runAutoRound(mode = 'self') {
      const guide = guides.get('main') // 总纲（面板「主流程总纲」卡，可改）
      const guideFor = (pkg) => {
        // 按前台包名挑单应用手册；挑不出专属的就退回通用兜底手册，保底不裸奔
        const key = guides.resolve({ packages: [String(pkg || '')] })
        return guides.get(key || 'generic')
      }
      const r = await startRun({
        flowKey: 'auto-' + dayKey(),
        prompt: '主动逛一轮手机：按总纲自己挑 1~3 个已安装的常用应用，逐个签到/刷新内容/适度点赞，只读为主，逛完用 finish 总结这一轮逛了什么。',
        packages: [],
        guide,
        guideFor,
        mode,
      })
      const st = bumpAutoRun()
      const s = getSettings()
      const text = `📱主动逛完一轮（今天第 ${st.runs} 轮${s.maxRunsPerDay ? '，上限 ' + s.maxRunsPerDay : ''}）：${r.message}`
      const qq = String(api.config().ownerQQ || '').trim()
      if (qq) { try { await api.core.hub.sendText(`private:${qq}`, text) } catch (e) { api.log.warn(`[phone] 主动逛汇报失败：${e.message}`) } }
      else api.log.warn('[phone] 主动逛完成但配置里没有 ownerQQ，没处汇报')
      if (s.writeEventMemory !== false) {
        api.use('memory')?.addEvent?.({ text: `主动逛了一轮手机（${r.steps} 步）：${String(r.summary).slice(0, 80)}`, tags: ['手机逛逛'], importance: 0.35 })
      }
      return { ...r, message: text }
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
    /** 工具调用是否来自主人会话（一审 #19-2）：群友/别人会话里一律拒绝，拿不到会话也按非主人处理。 */
    function ownerToolCall(exec) {
      const sid = exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || ''
      const hub = api.core.hub
      if (!sid || typeof hub?.turnSendersAllOwner !== 'function') return false
      try { return hub.turnSendersAllOwner(sid) === true } catch (e) { return false }
    }
    const notOwnerMsg = () => ({ ok: false, message: '手机逛逛的工具只在主人会话里可用（群友/别人的会话不能操作手机）。' })
    api.tool(() => [
      api.defineTool({
        name: 'phone_run_flows',
        description: '列出主人教好的手机自动流程（名称/触发词/定时/开关）。主人问「能帮我自动做什么」或选流程前先用。',
        properties: {},
        execute: async (_args, exec) => {
          if (!ownerToolCall(exec)) return notOwnerMsg()
          if (!getSettings().enabled) return offMsg()
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
        execute: async ({ id, note }, exec) => {
          if (!ownerToolCall(exec)) return notOwnerMsg()
          if (!getSettings().enabled) return offMsg()
          const flow = flows.get(String(id))
          if (!flow) return { ok: false, message: `没有流程 ${id}` }
          const f = note ? { ...flow, prompt: `${flow.prompt}\n附加：${note}` } : flow
          if (session.status().owner) return busyRace(() => runFlow(f))
          return runFlow(f)
        },
      }),
      api.defineTool({
        name: 'phone_auto_browse',
        description: '主动逛一轮手机：按总纲提示词自己挑应用去签到/刷新内容（自主逛，照刷B站那种）。主人私聊说「去逛逛手机」「自己刷会儿手机」时用。',
        properties: {},
        execute: async (_args, exec) => {
          if (!ownerToolCall(exec)) return notOwnerMsg()
          if (!getSettings().enabled) return offMsg()
          if (session.status().owner) return busyRace(() => runAutoRound('self'))
          return runAutoRound('self')
        },
      }),
      api.defineTool({
        name: 'phone_act',
        description: '让 AI 遥控手机自由完成一句话任务（打开应用、点界面、输入文字）。主人说「帮我在手机上做某某事」且没有现成流程时用。',
        properties: { goal: { type: 'string', description: '一句话任务描述' } },
        required: ['goal'],
        execute: async ({ goal }, exec) => {
          if (!ownerToolCall(exec)) return notOwnerMsg()
          if (!getSettings().enabled) return offMsg()
          if (session.status().owner) return busyRace(() => runGoal(goal, 'self'))
          return runGoal(goal, 'self')
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
                if (!id) return '用法：phone flow add <id>（流程名用 set name 补；id 只能字母/数字/短横线/下划线，≤40 字，不支持中文）'
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
              if (!getSettings().enabled) return offMsg().message
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
      if (!getSettings().enabled) return false // 总开关关着：触发词不接管，消息照常走 AI
      // 一审 #19-2：触发词只认主人——群员/别人发同样的词不能让她操作手机
      const ownerQQ = String(api.config().ownerQQ || '').trim()
      if (!ownerQQ || String(msg.userId || '') !== ownerQQ) return false
      const flow = flows.findTrigger(text)
      if (!flow) return false
      const to = flow.reportTo || 'origin'
      const r = await runFlow(flow, { originChatId: msg.chatId })
      // 复审第 2 条：reportTo=owner 时摘要只走私聊，群里/别人私聊只回一句「已处理」
      if (to === 'owner') await api.reply(msg, `手机任务「${flow.name}」已处理完，结果私聊汇报给主人。`)
      else if (to !== 'none') await api.reply(msg, r.message)
      return true // 接管这条消息
    })

    // ================= 定时：30s 清扫（会话超时 + cron 到点）=================
    let lastCronMinute = '' // 防止同一分钟内 30s tick 重复触发
    function sweep() {
      if (!getSettings().enabled) return // 总开关关着：cron 不触发，也不清扫会话
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
          startRun({ flowKey: flow.id, prompt: flow.prompt, packages: flow.packages, guide: guides.get(guides.resolve({ packages: flow.packages, goal: flow.prompt, flowGuide: flow.guide })), mode: 'self' })
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
        // 主动逛：总开关 + autoBrowse 开、醒着时间内、当天没超限、间隔到了、会话空闲才起一轮
        const s = getSettings()
        const su = (typeof api.core.getConfig === 'function' ? api.core.getConfig() : {}).speakUp || {}
        const h = now.getHours()
        if (s.enabled && s.autoBrowse && h >= Number(su.awakeFrom ?? 8) && h < Number(su.awakeTo ?? 23)) {
          const st = autoStats()
          const runs = st.day === dayKey(now) ? st.runs : 0
          if (runs < s.maxRunsPerDay && Date.now() - (st.lastRun || 0) > s.intervalHours * 3600_000) {
            if (session.status().owner) api.log.warn('[phone] 会话被占，主动逛顺延到下轮')
            else runAutoRound('self').catch((e) => api.log.error(`[phone] 主动逛失败：${e.message}`))
          }
        }
      }
    }
    api.every(30000, sweep, 'phone-sweep')

    // ================= 面板路由（精确匹配，前缀 /aurabot/api/ext/phone）=================
    const json = (data) => data // route 返回对象即 JSON
    // id/key 白名单（复审 P0-1）：这些值会被拼进文件路径，路由层先拦一道，报错也好懂
    const SAFE_KEY = /^[A-Za-z0-9_-]{1,40}$/
    let lastPanelRun = null // 面板「对话测试」最近一次任务：{ goal, ok, message, steps, running, at }
    api.route('/flows', async (req, res) => {
      if (req.method === 'GET') return json({ flows: flows.list() })
      if (req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (!body.id) return json({ ok: false, error: '缺少 id' })
        if (!SAFE_KEY.test(String(body.id))) return json({ ok: false, error: `不合法的流程 id（只能字母/数字/短横线/下划线，≤40 字）：${String(body.id).slice(0, 40)}` })
        const flow = flows.upsert(String(body.id), body.patch || body)
        return json({ ok: true, flow })
      }
      if (req.method === 'DELETE') {
        const id = new URL(req.url, 'http://x').searchParams.get('id')
        if (!SAFE_KEY.test(String(id || ''))) return json({ ok: false, error: '不合法的流程 id' })
        return json({ ok: flows.remove(id) })
      }
      return json({ ok: false, error: '不支持的方法' })
    })
    api.route('/run', async (req) => {
      if (!getSettings().enabled) return json({ ok: false, error: '总开关没开，请先在面板打开' })
      if (req.method !== 'POST') return json({ ok: false, error: '只支持 POST' })
      const body = await api.core.http.body(req).catch(() => ({}))
      if (body.id) {
        const flow = flows.get(String(body.id))
        if (!flow) return json({ ok: false, error: '没有该流程' })
        // 面板触发走工作区会话窗（mode self）：主人看着决策过程，不进子智能体
        busyRace(() => runFlow(flow, { mode: 'self' }))
        return json({ ok: true, queued: !!session.status().owner })
      }
      if (body.goal) {
        // 面板「对话测试」：下发后立刻回（任务后台跑），结果记进 lastPanelRun 供 /status 轮询回显
        const goal = String(body.goal).slice(0, 200)
        lastPanelRun = { goal, running: true, at: Date.now() }
        // 面板触发同样走工作区会话窗（mode self），主人在「手机逛逛 · 操作决策」里实时看决策
        busyRace(() => runGoal(goal, 'self')).then((r) => { lastPanelRun = { goal, ok: r.ok, message: r.message, steps: r.steps, running: false, at: Date.now() } })
        return json({ ok: true, queued: !!session.status().owner })
      }
      return json({ ok: false, error: '需要 id 或 goal' })
    })
    api.route('/memory', (req, res) => {
      const url = new URL(req.url, 'http://x')
      const key = url.searchParams.get('key')
      if ((req.method === 'GET' || req.method === 'DELETE') && !SAFE_KEY.test(String(key || ''))) {
        return json({ ok: false, error: '不合法的记忆 key' })
      }
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
        // id 白名单再拦一道（复审残留 P0-1）：safety 底层也校验，这里非法直接回错
        const idOk = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(String(id || ''))
        if (body.approve && body.id) {
          if (!idOk(body.id)) return json({ ok: false, error: '不合法的确认项 id' })
          safety.approveConfirm(String(body.id)); return json({ ok: true })
        }
        if (body.reject && body.id) {
          if (!idOk(body.id)) return json({ ok: false, error: '不合法的确认项 id' })
          safety.rejectConfirm(String(body.id)); return json({ ok: true })
        }
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
          if (body.del) { // 删除自定义指引（总纲 main 不可删，只能还原内置版）
            const k = String(body.key || '')
            if (k === 'main') return json({ ok: false, error: '主流程总纲不可删除，只能还原成内置版' })
            return json({ ok: guides.remove(k) })
          }
          const g = guides.upsert(String(body.key || ''), { name: body.name, text: body.text })
          return json({ ok: true, guide: { key: g.key, name: g.name, source: 'custom' } })
        } catch (e) { return json({ ok: false, error: e.message }) }
      }
      if (req.method === 'DELETE') {
        const key = new URL(req.url, 'http://x').searchParams.get('key')
        if (key === 'main') return json({ ok: false, error: '主流程总纲不可删除，只能还原成内置版' })
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
        // 拿原始 `devices -l` 输出自己解析（devices() 已加工成纯 serial 数组，拿不到 model/state 列）
        const out = await adb.adb(['devices', '-l'])
        const devices = out.split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => {
          const cols = l.split(/\s+/)
          const model = (l.match(/model:(\S+)/) || [])[1] || ''
          const state = cols[1] || ''
          return { serial: cols[0], model, state }
        })
        return json({ ok: true, devices })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })
    // 常见应用名对照表：adb 的 pm 读不到应用名（label 得逐个拉 APK 解析，太重），
    // 常见应用直接给中文名；认不出的靠面板「启动看看」试一眼
    const APP_NAMES = {
      'com.tencent.mm': '微信',
      'com.eg.android.AlipayGphone': '支付宝',
      'com.tencent.mobileqq': 'QQ',
      'com.ss.android.ugc.aweme': '抖音',
      'com.ss.android.ugc.aweme.lite': '抖音极速版',
      'com.ss.android.ugc.aweme.lite.plugin': '抖音火山版',
      'tv.danmaku.bili': '哔哩哔哩',
      'tv.danmaku.bili_lite': '哔哩哔哩极速版',
      'com.max.xiaoheihe': '小黑盒',
      'com.xingin.xhs': '小红书',
      'com.smile.gifmaker': '快手',
      'com.kuaishou.nebula': '快手极速版',
      'com.weico.international': '微博国际版',
      'com.sina.weibo': '微博',
      'com.zhihu.android': '知乎',
      'com.netease.cloudmusic': '网易云音乐',
      'com.kugou.android': '酷狗音乐',
      'com.tencent.androidqqmusic': 'QQ音乐',
      'com.miui.player': '小米音乐',
      'com.UCMobile': 'UC浏览器',
      'com.tencent.mtt': 'QQ浏览器',
      'com.android.chrome': 'Chrome',
      'org.mozilla.firefox': 'Firefox',
      'com.taobao.taobao': '淘宝',
      'com.tmall.wireless': '天猫',
      'com.jingdong.app.mall': '京东',
      'com.xunmeng.pinduoduo': '拼多多',
      'com.dianping.v1': '大众点评',
      'com.sankuai.meituan': '美团',
      'com.alibaba.android.rimet': '钉钉',
      'com.tencent.wework': '企业微信',
      'com.ss.android.lark': '飞书',
      'com.tencent.weishi': '微视',
      'com.baidu.BaiduMap': '百度地图',
      'com.autonavi.minimap': '高德地图',
      'com.tencent.map': '腾讯地图',
      'com.meituan.retail.v.android': '美团买菜',
      'com.yek.android.unify.job': 'BOSS直聘',
      'com.wuba': '58同城',
      'com.anjuke.android.app': '安居客',
      'com.lianjia.beike': '贝壳找房',
      'com.happyelements.AndroidAnimal': '开心消消乐',
      'com.tencent.tmgp.sgame': '王者荣耀',
      'com.netease.dwrg': '第五人格',
      'com.miHoYo.Yuanshen': '原神',
      'com.miHoYo.hkrpg': '崩坏：星穹铁道',
      'com.HoYoverse.hkrpgoversea': '崩坏：星穹铁道（国际）',
      'com.miHoYo.bh3.mihuoyou': '崩坏3',
      'com.netease.sky': '光·遇',
      'com.supercell.clashofclans': '部落冲突',
      'tv.pps.mobile': 'PP视频',
      'com.le123.ysdq': '影视大全',
      'com.hunantv.imgo.activity': '芒果TV',
      'com.qiyi.video': '爱奇艺',
      'com.youku.phone': '优酷',
      'com.tencent.qqlive': '腾讯视频',
      'cmccwm.mobilemusic': '咪咕音乐',
      'com.chinamworld.main': '中国银行',
      'com.android.bankabc': '工商银行',
      'com.chinamworld.bocmbci': '建设银行',
      'com.icbc': '工商银行',
      'cmb.pb': '招商银行',
      'com.unionpay': '云闪付',
      'com.jd.jrapp': '京东金融',
      'com.alipay.android.phone.openplatform': '支付宝（旧）',
      'cn.wps.moffice_eng': 'WPS Office',
      'com.tencent.qqmail': 'QQ邮箱',
      'com.netease.mail': '网易邮箱大师',
      'com.microsoft.office.outlook': 'Outlook',
      'com.evernote': '印象笔记',
      'com.shanbay.words': '扇贝单词',
      'cn.jimex.dict': '金山词霸',
      'com.eusoft.eudic': '欧路词典',
      'com.android.vending': 'Google Play',
      'com.baidu.searchbox': '百度',
      'com.baidu.netdisk': '百度网盘',
      'com.alicloud.databox': '阿里云盘',
      'com.quark.browser': '夸克',
      'com.cubic.autohome': '汽车之家',
      'com.cubic.che168': '二手车之家',
      'com.songheng.eastnews': '东方新闻',
      'com.marvel.stone': '番茄小说',
      'com.dragon.read': '番茄免费小说',
      'com.phoenix.read': '红果短剧',
      'com.kmxs.reader': '七猫小说',
      'com.qidian.QDReader': '起点读书',
      'com.zhangyue.read.iReader': '掌阅',
    }

    api.route('/adb/packages', async (req) => {
      try {
        const serial = new URL(req.url, 'http://x').searchParams.get('serial') || ''
        const env = await ensureReady()
        if (!env.adbPath) throw new Error('没有可用的 adb：请先在面板选择或自动安装')
        const adb = createAdb({ adbPath: env.adbPath, serial, timeoutMs: 15000 })
        const out = await adb.adb(['shell', 'pm', 'list', 'packages', '-3'])
        const packages = out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort()
        const names = {}
        for (const p of packages) if (APP_NAMES[p]) names[p] = APP_NAMES[p]
        return json({ ok: true, packages, names })
      } catch (e) { return json({ ok: false, error: e.message }) }
    })
    // 面板「启动看看」：把某个应用拉到前台，主人对照着认它是谁（只 launch，不点任何东西）
    api.route('/adb/launch', async (req) => {
      if (req.method !== 'POST') return json({ ok: false, error: '只支持 POST' })
      // 一审 #19-9：总开关关着时连「启动看看」也不许真启动应用
      if (!getSettings().enabled) return json({ ok: false, error: '总开关没开，请先在面板打开' })
      try {
        const body = await api.core.http.body(req).catch(() => ({}))
        const pkg = String(body.pkg || '').trim()
        if (!/^[\w.]+$/.test(pkg)) return json({ ok: false, error: '包名不合法' })
        // 复审第 9 条：即使总开关开着，「启动看看」也要走白名单与试运行，不绕过安全门
        const cp = safety.checkPackage(pkg)
        if (!cp.ok) return json({ ok: false, error: cp.reason || '包名不在白名单' })
        if (getSettings().dryRun) return json({ ok: false, error: '试运行模式：不真启动应用' })
        const adb = await getAdb()
        await adb.launchApp(pkg)
        return json({ ok: true, message: '已在手机上打开：' + pkg })
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
        enabled: getSettings().enabled,
        auto: (() => { const a = autoStats(); return a.day === dayKey() ? { runs: a.runs, lastRun: a.lastRun } : { runs: 0, lastRun: 0 } })(),
        session: session.status(),
        adbSource: adbCache?.source || 'not-ready',
        confirms: safety.listConfirms().length,
        flows: flows.list().length,
        lastRun: lastPanelRun,
      })
    })

    // ================= 收尾 =================
    api.onDispose(() => session.dispose())

    // setup 返回导出对象（契约 B 节）
    return {
      status: () => ({
        enabled: getSettings().enabled,
        adb: adbCache ? { source: adbCache.source, installed: adbCache.installed } : null,
        auto: (() => { const a = autoStats(); return a.day === dayKey() ? { runs: a.runs, lastRun: a.lastRun } : { runs: 0, lastRun: 0 } })(),
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
      /**
       * 跨模块调用面：别的模块 `api.use('phone').run({ goal })` 或 `run({ flowId })`。
       * 每次开一个独立子智能体会话（工作区可见、互不串上下文），跑完把
       * { ok, message, steps, summary } 经 Promise 返回给调用方；总开关没开直接拒绝。
       */
      run: ({ goal, flowId } = {}) => {
        if (!getSettings().enabled) return Promise.resolve(offMsg())
        // 一审 #19-3：跨模块调用默认走模块内循环（每一动都过安全门）；面板打开「委派给子智能体」才开独立子智能体会话
        // 跨模块调用落独立决策窗（task-*，不串上下文）；动作仍由模块执行、每一动过 safety.gate
        const mode = 'delegate'
        if (flowId) {
          const flow = flows.get(String(flowId))
          if (!flow) return Promise.resolve({ ok: false, message: `没有流程 ${flowId}` })
          return runFlow(flow, { mode })
        }
        const g = String(goal || '').trim()
        if (!g) return Promise.resolve({ ok: false, message: '缺 goal 或 flowId：run({ goal: "一句话任务" }) 或 run({ flowId: "流程id" })' })
        return runGoal(g, mode)
      },
    }
  },
}
