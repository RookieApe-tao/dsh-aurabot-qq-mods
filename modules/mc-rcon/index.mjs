// 扩展模块「我的世界服务器分身」—— 放在 Aurabot 数据目录 modules/mc-rcon/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「已安装」页看原因。
//
// 它做这些事：
//   1. 通过 RCON 连上 Minecraft 服务器，能执行命令；
//   2. 跟随服务器的 logs/latest.log，读出游戏里的玩家聊天；
//   3. 像群聊一样参与：被叫到（面板里配的唤醒词）必回；其他聊天默认每条都看，由她自己判断接不接，
//      不想接就输出 [沉默]；回复前读 Aurabot 当前人格卡；
//   3.5 服务器事件：有人死了，她看一眼死亡消息，主动调侃/关心一句；
//   3.6 换端：自动扫描 serverRoot 下的服务器，读运行中那套的 server.properties 和 logs/latest.log，
//       自动切 RCON 端口/密码和日志路径；
//   4. 权限分级：
//      · 游戏内管理员（面板里填）：可以让她执行较广的服务器命令（受禁止名单限制）；
//      · 普通玩家：可以申请安全操作 —— 切旁观/生存、tp 到坐标、back 回上一个位置、回出生点、查在线、查时间；
//      · Aurabot 主人（以及面板里加的 QQ 管理员）：可以在 QQ 里用 /mc 直接控制服务器。
//
// 说明：纯 RCON 收不到别人的聊天（协议只能一问一答），所以聊天监听走服务器日志；
// 如果服务器在别的机器上，可以用 POST /aurabot/api/ext/mc-rcon/ingame 把聊天送过来（见 README.md）。

import { createRcon } from './lib/rcon.mjs'
import { createLogWatch, parseChatLine, parseEventLine } from './lib/logwatch.mjs'
import { scanServers, testRcon, logAgeMs } from './lib/discover.mjs'
import { buildSystemPrompt, buildFollowupSystem, buildEventSystem, parseModelReply, toChatLines, cleanForMc, lineList } from './lib/prompt.mjs'
import { checkCommand } from './lib/commands.mjs'
import { parseDimension, dimensionLabel } from './lib/dimension.mjs'

// ---------------------------------------------------------------------------
// 默认值：第一次加载会写进 config.json 的 ext['mc-rcon']，之后以面板里的为准。
// 提交版不预填任何服务器信息，安装后在面板里填 RCON 和日志路径。
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: true, // 总开关
  listen: true, // 游戏内聊天监听
  host: '127.0.0.1',
  port: 25575,
  password: '',
  logPath: '',
  serverName: '我的世界服务器',
  chatMode: 'all', // all 每条都看（默认）/ smart 智能接话 / wake 只回应召唤
  wakeWords: '',
  nicknames: '',
  topics: '游戏\n我的世界\nminecraft\n服务器\n建家\n挖矿\n打怪',
  interjectChance: 12, // 普通闲聊里随机插话的概率（%）
  admins: '',
  allowed: '', // 留空 = 所有玩家都能聊；填了就只理名单里的人
  qqAdmins: '', // 额外允许用 /mc 的 QQ 号（主人永远可以）
  guestCommands: 'gamemode\ntp\nback\nspawn\nlist\ntime query', // 普通玩家可申请的安全操作
  guestCommandCooldownSec: 10, // 同一个普通玩家两次操作的最小间隔
  confirmCrossDimension: true, // 跨维度 tp 前先问确认
  dimensionAliases: '主世界=minecraft:overworld\n地表=minecraft:overworld\noverworld=minecraft:overworld\n下界=minecraft:the_nether\n地狱=minecraft:the_nether\nnether=minecraft:the_nether\n末地=minecraft:the_end\n末影之地=minecraft:the_end\nend=minecraft:the_end',
  blockedCommands: 'stop\nban\nban-ip\npardon\nop\ndeop\nwhitelist\nkick\nsave-off\nsave-on\nkill @a',
  replyMode: 'broadcast', // broadcast 所有人看到 / direct 只回给说话的人
  replyPrefix: '[MC] ',
  maxReplyChars: 180,
  maxCommands: 3,
  maxHistory: 10,
  cooldownSec: 5,
  maxPerMinute: 10,
  mergeMs: 1200,
  eventsEnabled: true, // 有人死了，她主动说一句
  deathChance: 100, // 死亡播报概率（%）
  deathCooldownSec: 60, // 同一个玩家两次死亡播报的最小间隔
  autoDetect: true, // 自动找正在运行的服务器并切过去
  serverRoot: '', // 服务器根目录（一行一个）
  detectIntervalSec: 60, // 自动检测间隔
  useThink: false,
  ingestToken: '',
  personaId: '',
}

const settings = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout (promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等太久了')), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

const MODE_LABEL = { smart: '智能接话', wake: '只回应召唤', all: '每条都看' }

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'mc-rcon', // 要和文件夹名一样
  name: '我的世界服务器分身',
  version: '1.5.4',
  api: 1, // 按哪一版扩展接口写的，别改
  description: '通过 RCON 控制我的世界服务器；在游戏聊天里像群聊一样接话，有人死了会主动调侃一句；换端时自动读取运行中服务器的 RCON 与日志路径。',

  defaults: DEFAULTS,
  settings,
  panel: 'panel.js',

  setup (api) {
    // settings 数组是空的（面板自己渲染字段），插件不会自动登记密码字段；
    // 手动登记，让面板不回显密码、日志自动脱敏。
    try {
      const configLib = api.lib('core/config.js')
      if (configLib && typeof configLib.registerSecretField === 'function') {
        configLib.registerSecretField(['ext', 'mc-rcon', 'password'])
        configLib.registerSecretField(['ext', 'mc-rcon', 'ingestToken'])
      }
    } catch (error) {
      api.log.warn('登记密码字段失败（密码仍可用，只是面板/日志不会打码）：' + error.message)
    }
    const S = () => api.settings()
    const list = (value) => lineList(value)
    const num = (key, fallback) => {
      const n = Number(S()[key])
      return Number.isFinite(n) ? n : fallback
    }

    const state = {
      recent: [], // 最近 60 条进出聊天，面板和 /mc recent 用
      context: [], // 最近 24 条给模型看的聊天（含她自己说的）
      pending: new Map(), // 同一玩家短时间连发的消息缓冲（合并成一次处理）
      lastPos: new Map(), // 玩家上次 tp 前的坐标（给 back 用）
      pendingTp: new Map(), // 跨维度 tp 等玩家确认
      deathAt: new Map(), // 玩家上次死亡播报时间
      onlineLoading: false,
      lastDetectAt: 0, // 上次自动检测时间
      lastSwitch: null, // 上次自动/手动切换的记录
      rconWarnAt: 0, // 上一次连不上的告警时间（30 秒内只记一条，别刷屏）
      onlineNextTry: 0, // 在线列表下次重试时间（失败后等 30 秒）
      cooldown: new Map(),
      hits: [],
      guestCmdAt: new Map(),
      online: { at: 0, names: [] },
      lastError: '',
      lastIn: null,
      startedAt: Date.now(),
      processing: new Set(),
      watcher: null,
      watchKey: '',
      client: null,
      clientKey: '',
      thinkQueue: Promise.resolve(),
    }

    // ---------------- 人格卡 ----------------
    function persona () {
      try {
        const want = String(S().personaId || '').trim()
        const currentId = want || String(api.config().persona?.current || '')
        const read = api.core.personas?.read
        const p = read ? read(currentId) : null
        if (p) return { id: p.id, name: p.name, body: p.body }
        const body = api.core.personas?.current?.() || ''
        if (body) return { id: currentId || 'current', name: '角色', body }
      } catch (error) {
        api.log.warn('读人格卡失败：' + error.message)
      }
      return { id: 'current', name: '角色', body: '你是一个真实存在的人，说话短、口语化，不要承认自己是程序。' }
    }

    // ---------------- RCON ----------------
    function rconClient () {
      const s = S()
      const key = [s.host, s.port, s.password].join('\u0000')
      if (state.client && state.clientKey === key) return state.client
      if (state.client) state.client.close()
      state.clientKey = key
      state.client = createRcon({
        host: s.host,
        port: s.port,
        password: s.password,
        log: (message) => api.log.debug(String(message)),
      })
      return state.client
    }

    async function safeExec (command) {
      const cmd = String(command || '').trim().replace(/^\/+/, '')
      if (!cmd) return { ok: false, cmd: '', message: '命令是空的' }
      if (cmd.length > 300) return { ok: false, cmd, message: '命令太长了' }
      try {
        const out = await rconClient().exec(cmd)
        // 之前断线留下的旧错误，连上并成功执行后就别再挂在面板上了
        if (String(state.lastError || '').startsWith('RCON：')) state.lastError = ''
        return { ok: true, cmd, out: String(out || '').replace(/\u00a7./g, '').trim() }
      } catch (error) {
        state.lastError = 'RCON：' + error.message
        // 服务器没开的时候别每秒刷屏：同一个错误 30 秒只记一条
        if (Date.now() - state.rconWarnAt > 30_000) {
          state.rconWarnAt = Date.now()
          api.log.warn('RCON 执行失败：' + error.message)
        } else {
          api.log.debug('RCON 执行失败：' + error.message)
        }
        return { ok: false, cmd, message: error.message }
      }
    }

    function parseList (text) {
      const m = String(text || '').match(/online:\s*(.*)$/i)
      if (!m) return []
      return m[1].split(',').map((s) => s.trim()).filter(Boolean)
    }

    async function fetchOnline (force = false) {
      if (!force && Date.now() - state.online.at < 10_000) return state.online.names
      // 连不上时 30 秒内不再重试；面板/命令主动刷新（force）不受限
      if (!force && Date.now() < state.onlineNextTry) return state.online.names
      const r = await safeExec('list')
      if (r.ok) {
        const names = parseList(r.out)
        state.online = { at: Date.now(), names }
        state.onlineNextTry = 0
        return names
      }
      state.onlineNextTry = Date.now() + 30_000
      return state.online.names
    }

    /** 记住玩家执行 tp 前的位置；玩家说「回去」时 tp 回这里（不依赖服务器的 /back）。 */
    async function rememberPos (player) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(String(player || ''))) return false
      const r = await safeExec(`data get entity ${player} Pos`)
      if (!r.ok) return false
      const m = String(r.out).match(/\[\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*,\s*(-?[\d.]+)d?\s*\]/)
      if (!m) return false
      state.lastPos.set(player, { x: m[1], y: m[2], z: m[3], at: Date.now() })
      return true
    }

    /** 玩家当前在哪个维度（data get entity 读 Dimension）。 */
    async function currentDimension (player) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(String(player || ''))) return ''
      const r = await safeExec(`data get entity ${player} Dimension`)
      if (!r.ok) return ''
      const m = String(r.out).match(/"([^"]+)"/)
      return m ? m[1] : ''
    }

    /** 玩家回复「是」之后，执行确认过的跨维度 tp。 */
    async function execPending (player, pending) {
      const r = await safeExec(pending.command)
      addRecent({ at: Date.now(), player: 'RCON', text: `/${pending.command}`, dir: 'out', admin: isAdmin(player) })
      api.log.info(`[MC] RCON /${pending.command}（跨维度确认）→ ${r.ok ? r.out.slice(0, 120) : '失败：' + r.message}`)
      const lines = r.ok ? [`好了 传到${pending.label}了`] : [`没传过去：${r.message}`]
      await sendLines(player, lines)
      rememberChat('你', lines.join(' '), 'out')
    }

    const COORD_LIKE = /^(?:~[+-]?\d*|-?\d+(?:\.\d+)?)$/

    /** RCON 没有执行者：管理员命令漏了目标时补上请求者，免得报「要指定实体」。 */
    function extractCoords (text) {
      const m = String(text || '').match(/([~-]?\d+(?:\.\d+)?)[ \t]+([~-]?\d+(?:\.\d+)?)[ \t]+([~-]?\d+(?:\.\d+)?)/)
      return m ? `${m[1]} ${m[2]} ${m[3]}` : ''
    }

    function looksLikeTpRequest (text) {
      if (!extractCoords(text)) return false
      return /(tp|传送|传我|传一下|带我|送我|去|到)/i.test(String(text || ''))
    }

    /** 最近 60 秒内有没有等确认的跨维度 tp（可能有别人在等）。 */
    function latestPending () {
      let best = null
      for (const [p, item] of state.pendingTp) {
        if (Date.now() - item.at > 60_000) continue
        if (!best || item.at > best.at) best = { ...item, player: p }
      }
      return best
    }

    function fillTarget (command, player, text = '') {
      const parts = String(command || '').trim().split(/\s+/).filter(Boolean)
      const base = String(parts[0] || '').toLowerCase()
      if ((base === 'tp' || base === 'teleport') && parts.length === 4 && parts.slice(1).every((v) => COORD_LIKE.test(v))) {
        // 正好有人在等跨维度确认：优先把目标补成那个请求者
        const pending = latestPending()
        if (pending && pending.player !== player) {
          return `${base} ${pending.player} ${parts.slice(1).join(' ')}`
        }
        // 玩家在说「帮他传 / 送她回去」这种：不要瞎补成当前说话的人，让它报错也比传错人强
        if (/帮|他|她|给|送他|送她/.test(String(text))) return String(command)
        return `${base} ${player} ${parts.slice(1).join(' ')}`
      }
      if (base === 'gamemode' && parts.length === 2) return `gamemode ${parts[1]} ${player}`
      if (base === 'spawn' && parts.length === 1) return `spawn ${player}`
      return String(command)
    }

    // ---------------- 自动发现运行中的服务器 ----------------
    function sameServer (c) {
      return String(c.logPath || '') === String(S().logPath || '') &&
        Number(c.port) === Number(S().port) &&
        String(c.password || '') === String(S().password || '')
    }

    async function detectActive (withTest = true) {
      // 根目录里可能有中文逗号（比如文件夹名），这里只按换行分，不能走 list()
      const roots = String(S().serverRoot || '').split(/\r?\n/).map((r) => r.trim().replace(/^"|"$/g, '')).filter(Boolean)
      const seen = new Set()
      const candidates = []
      for (const root of roots) {
        for (const c of scanServers(root)) {
          if (seen.has(c.dir)) continue
          seen.add(c.dir)
          candidates.push(c)
        }
      }
      // 日志最新的排前面；多个服共用同一个 RCON 端口时靠这个区分到底谁在跑
      candidates.sort((a, b) => a.logAgeMs - b.logAgeMs)
      const pool = candidates.slice(0, 4)
      if (withTest) await Promise.all(pool.map(async (c) => { c.rcon = await testRcon(c) }))
      const usable = pool.filter((c) => c.rcon && c.rcon.ok)
      return { candidates, active: usable.length ? usable[0] : null }
    }

    async function applyServer (c) {
      api.saveSettings({
        host: c.host || '127.0.0.1',
        port: c.port,
        password: c.password || '',
        logPath: c.logPath || '',
        serverName: c.name,
      })
      state.clientKey = ''
      state.watchKey = ''
      state.lastPos.clear()
      state.deathAt.clear()
      state.online = { at: 0, names: [] }
      state.lastError = ''
      state.lastSwitch = { at: Date.now(), name: c.name, dir: c.dir }
      api.log.info(`[MC] 已切换到「${c.name}」（RCON ${c.port}，日志 ${c.logPath}）`)
    }

    async function autoDetectTick () {
      if (!S().autoDetect) return
      const now = Date.now()
      const gap = Math.max(15, num('detectIntervalSec', 60)) * 1000
      if (now - state.lastDetectAt < gap) return
      state.lastDetectAt = now
      // 当前服 RCON 还连着、日志也新鲜：说明没换端，不扫
      if (rconClient().status().connected && logAgeMs(S().logPath) < 2 * 60_000) return
      try {
        const { active } = await detectActive(true)
        if (!active) {
          api.log.debug('[MC] 自动检测：没找到能连上的服务器')
          return
        }
        if (sameServer(active)) return
        await applyServer(active)
      } catch (error) {
        api.log.debug('[MC] 自动检测失败：' + error.message)
      }
    }

    function mcJson (text) {
      const raw = String(S().replyPrefix || '') + String(text || '')
      // 游戏命令里 JSON 参数尽量别带空格和引号，省得被 Brigadier 拆开
      const safe = raw.replace(/\\/g, '＼').replace(/"/g, '＂')
      return JSON.stringify({ text: safe }).replace(/ /g, '\\u0020')
    }

    function replyTarget (player) {
      if (String(S().replyMode || 'broadcast') === 'direct' && /^[A-Za-z0-9_]{1,32}$/.test(String(player || ''))) return player
      return '@a'
    }

    async function sayInGame (target, line) {
      const to = /^[A-Za-z0-9_]{1,32}$/.test(String(target || '')) || String(target || '').startsWith('@') ? target : '@a'
      return safeExec(`tellraw ${to} ${mcJson(line)}`)
    }

    async function sendLines (player, lines) {
      let sent = 0
      for (const line of lines) {
        const r = await sayInGame(replyTarget(player), line)
        if (!r.ok) {
          state.lastError = '发送失败：' + r.message
          break
        }
        sent += 1
        addRecent({ at: Date.now(), player: persona().name, text: line, dir: 'out' })
        await sleep(400)
      }
      return sent
    }

    // ---------------- 记录 ----------------
    function addRecent (item) {
      state.recent.unshift({ ...item, admin: Boolean(item.admin) })
      if (state.recent.length > 60) state.recent.length = 60
    }

    function rememberChat (who, text, dir) {
      const body = cleanForMc(String(text || ''))
      if (!body) return
      state.context.push({ who: dir === 'out' ? '你' : who, text: body, dir })
      if (state.context.length > 24) state.context.splice(0, state.context.length - 24)
    }

    function contextText () {
      const count = Math.max(0, num('maxHistory', 10))
      if (!count) return ''
      return state.context.slice(-count).map((x) => `${x.who}：${x.text}`).join('\n')
    }

    // ---------------- 权限 ----------------
    const isAdmin = (player) => list(S().admins).some((name) => name.toLowerCase() === String(player || '').toLowerCase())
    const isAllowed = (player) => {
      const allow = list(S().allowed)
      return !allow.length || allow.some((name) => name.toLowerCase() === String(player || '').toLowerCase())
    }
    const isQqAdmin = (userId) => api.isOwner(userId) || list(S().qqAdmins).includes(String(userId || ''))

    // ---------------- 接不接话 ----------------
    function findWake (text) {
      const words = list(S().wakeWords).sort((a, b) => b.length - a.length)
      const lower = String(text || '').toLowerCase()
      for (const word of words) {
        const at = lower.indexOf(word.toLowerCase())
        if (at >= 0) return { word, at }
      }
      return null
    }

    function mentionsHer (text) {
      const lower = String(text || '').toLowerCase()
      return list(S().nicknames).some((name) => name && lower.includes(name.toLowerCase()))
    }

    function looksLikeRequest (text) {
      const t = String(text || '')
      if (/[?？]/.test(t)) return true
      return /(吗|呢|什么|怎么|为什么|哪|谁|多少|帮我|帮忙|能不能|可不可以|请问|告诉我|求你了|how|what|why|can you|could you)/i.test(t)
    }

    /**
     * 这条聊天要不要交给模型。
     * must = true：被叫到名字，必须回；否则模型可以输出 [沉默]。
     */
    function decideChat ({ text }) {
      const wake = findWake(text)
      if (wake) return { go: true, must: true, reason: 'wake', wake }
      const mode = String(S().chatMode || 'smart')
      if (mode === 'wake') return { go: false, must: false, reason: 'mode-wake' }
      if (mode === 'all') return { go: true, must: false, reason: 'all' }
      if (mentionsHer(text)) return { go: true, must: false, reason: 'nickname' }
      if (looksLikeRequest(text)) return { go: true, must: false, reason: 'request' }
      const topics = list(S().topics)
      const lower = String(text || '').toLowerCase()
      if (topics.some((t) => t && lower.includes(t.toLowerCase()))) return { go: true, must: false, reason: 'topic' }
      const chance = Math.max(0, Math.min(100, num('interjectChance', 12)))
      if (Math.random() * 100 < chance) return { go: true, must: false, reason: 'random' }
      return { go: false, must: false, reason: 'quiet' }
    }

    // ---------------- 模型 ----------------
    function thinkSerial (prompt) {
      const run = () => api.think(prompt, { title: 'MC 服务器', timeoutMs: 90_000 })
      const p = state.thinkQueue.then(run, run)
      state.thinkQueue = p.then(() => {}, () => {})
      return p
    }

    async function askModel ({ system, prompt, maxTokens }) {
      if (S().useThink) {
        const raw = await withTimeout(thinkSerial(`${system}\n\n${prompt}`), 120_000)
        return String(raw || '')
      }
      const raw = await withTimeout(api.ask({ system, text: prompt, maxTokens: maxTokens || 700 }), 90_000)
      return String(raw || '')
    }

    async function followUp (p, player, summary, admin) {
      try {
        const raw = await askModel({
          system: buildFollowupSystem({ personaBody: p.body, requester: player, admin }),
          prompt: `【命令执行结果】\n${summary}`,
          maxTokens: 260,
        })
        const { text } = parseModelReply(raw)
        const lines = toChatLines(text, { maxChars: num('maxReplyChars', 180), maxLines: 2 })
        if (lines.length) return lines
      } catch (error) {
        api.log.warn('命令结果的第二轮回话失败：' + error.message)
      }
      return []
    }

    // ---------------- 回应 ----------------
    async function respond ({ player, text, decision }) {
      const admin = isAdmin(player)
      const online = await fetchOnline()
      const p = persona()
      const system = buildSystemPrompt({
        personaBody: p.body,
        personaName: p.name,
        serverName: String(S().serverName || 'Minecraft 服务器'),
        wakeWords: list(S().wakeWords),
        admins: list(S().admins),
        online,
        blocked: list(S().blockedCommands),
        guestCommands: list(S().guestCommands),
        requester: { player, admin },
        maxChars: num('maxReplyChars', 180),
        maxCommands: num('maxCommands', 3),
        context: contextText(),
        must: Boolean(decision.must),
        reason: decision.reason,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
      })
      const prompt = `【Minecraft 服务器聊天】${player}${admin ? '（管理员）' : ''}：${text}`
      const raw = await askModel({ system, prompt })
      api.log.info(`[MC] ${player}${admin ? '（管理员）' : ''}：${text.slice(0, 80)} → ${raw.slice(0, 120).replace(/\n/g, ' ')}`)
      if (!raw.trim()) return

      const { text: body, commands } = parseModelReply(raw)
      const replyLines = toChatLines(body, { maxChars: num('maxReplyChars', 180), maxLines: 2 })
      if (replyLines.length) {
        await sendLines(player, replyLines)
        rememberChat('你', replyLines.join(' '), 'out')
      }

      if (!commands.length) {
        // 模型有时会自己用文字问「回是我就传」而不写命令；这里兜底把跨维度请求接过来
        const aliases = list(S().dimensionAliases)
        const wanted = parseDimension(text, aliases)
        const cur = wanted ? await currentDimension(player) : ''
        if (wanted && cur && wanted !== cur && looksLikeTpRequest(text)) {
          const coords = extractCoords(text)
          if (coords) {
            const label = dimensionLabel(wanted, aliases)
            state.pendingTp.set(player, {
              command: `execute in ${wanted} run tp ${player} ${coords}`,
              label,
              at: Date.now(),
            })
            if (!/回\s*[「"']?是|确认|我就传/.test(replyLines.join(' '))) {
              const ask = `去${label}的 ${coords}？回「是」我就传`
              await sendLines(player, [ask])
              rememberChat('你', ask, 'out')
            }
            return
          }
        }
        return
      }

      // ---- 权限门：模型说了不算，这里才是真的放行 ----
      const maxCmds = Math.max(1, num('maxCommands', 3))
      const guestCommands = list(S().guestCommands)
      const blocked = list(S().blockedCommands)
      const results = []
      const denied = []
      for (const rawCmd of commands.slice(0, maxCmds)) {
        // 有还没确认的跨维度传送：先别执行命令，让玩家回「是/不」
        if (state.pendingTp.has(player)) {
          denied.push('先回「是」或「不」确认一下刚才那个传送')
          break
        }
        const check = checkCommand(rawCmd, { player, admin, guestCommands, blocked })
        if (!check.ok) {
          denied.push(check.reason || '这个命令不能执行')
          api.log.warn(`[MC] ${player} 请求的命令被拦：${rawCmd}（${check.reason}）`)
          continue
        }
        if (check.level === 'guest') {
          const gap = Math.max(0, num('guestCommandCooldownSec', 10)) * 1000
          const last = state.guestCmdAt.get(player) || 0
          if (Date.now() - last < gap) {
            denied.push('你刚让我做过事，等一下再弄')
            continue
          }
          state.guestCmdAt.set(player, Date.now())
        }
        // 「回去」：用模块记住的上次 tp 前坐标（服务器的 /back 在 RCON 里需要玩家执行，没法直接用）
        if (check.kind === 'back') {
          const pos = state.lastPos.get(player)
          if (!pos || Date.now() - pos.at > 30 * 60_000) {
            denied.push('我不知道你刚才在哪，先让我 tp 你一次吧')
            continue
          }
          const target = `tp ${player} ${pos.x} ${pos.y} ${pos.z}`
          const r = await safeExec(target)
          results.push(r)
          addRecent({ at: Date.now(), player: 'RCON', text: `/${target}`, dir: 'out', admin })
          api.log.info(`[MC] RCON /${target}（back）→ ${r.ok ? r.out.slice(0, 120) : '失败：' + r.message}`)
          continue
        }
        // 跨维度 tp：玩家说了另一个维度就先确认，确认后用 execute in 过去
        if (/^tp\s/i.test(check.command)) {
          const aliases = list(S().dimensionAliases)
          const wanted = parseDimension(text, aliases)
          const cur = wanted ? await currentDimension(player) : ''
          if (wanted && cur && wanted !== cur) {
            const finalTp = fillTarget(check.command, player, text)
            const coords = finalTp.split(/\s+/).slice(2, 5).join(' ')
            if (S().confirmCrossDimension !== false) {
              const label = dimensionLabel(wanted, aliases)
              state.pendingTp.set(player, {
                command: `execute in ${wanted} run ${finalTp}`,
                label,
                at: Date.now(),
              })
              const ask = `去${label}的 ${coords}？回「是」我就传`
              await sendLines(player, [ask])
              rememberChat('你', ask, 'out')
              continue
            }
            const r = await safeExec(`execute in ${wanted} run ${finalTp}`)
            results.push(r)
            addRecent({ at: Date.now(), player: 'RCON', text: `/${r.cmd}`, dir: 'out', admin })
            api.log.info(`[MC] RCON /${r.cmd}（跨维度）→ ${r.ok ? r.out.slice(0, 120) : '失败：' + r.message}`)
            continue
          }
        }
        // 普通玩家的 tp 之前记一下当前位置，之后说「回去」才能回得来
        if (/^tp\s/i.test(check.command)) await rememberPos(player)
        const finalCmd = fillTarget(check.command, player, text)
        const r = await safeExec(finalCmd)
        results.push(r)
        addRecent({ at: Date.now(), player: 'RCON', text: `/${finalCmd}`, dir: 'out', admin })
        api.log.info(`[MC] RCON /${finalCmd}（${check.level}）→ ${r.ok ? r.out.slice(0, 120) : '失败：' + r.message}`)
      }

      if (denied.length) {
        const reason = [...new Set(denied)].join('；')
        await sendLines(player, [reason])
        rememberChat('你', reason, 'out')
      }
      if (!results.length) return

      const summary = results.map((r) => `/${r.cmd} → ${r.ok ? r.out || '（没有回执）' : '失败：' + r.message}`).join('\n')
      const follow = await followUp(p, player, summary, admin)
      if (follow.length) {
        await sendLines(player, follow)
        rememberChat('你', follow.join(' '), 'out')
      }
    }

    /** 同一玩家短时间连发几条时先攒一下，合并成一次交给模型（像 QQ 的合并转发）。 */
    function queueChat (player, text) {
      const windowMs = Math.max(0, num('mergeMs', 1200))
      const cur = state.pending.get(player) || { texts: [], timer: null }
      if (cur.texts.length >= 6) cur.texts.shift()
      cur.texts.push(text)
      if (cur.timer) clearTimeout(cur.timer)
      cur.timer = setTimeout(() => {
        state.pending.delete(player)
        void flushChat(player, cur.texts)
      }, windowMs)
      state.pending.set(player, cur)
    }

    async function flushChat (player, texts) {
      const merged = texts.join('\n')
      const decision = decideChat({ text: merged })
      if (!decision.go) return
      if (!isAllowed(player)) {
        api.log.debug(`[MC] ${player} 不在允许互动名单里，忽略`)
        return
      }
      const now = Date.now()
      // 被叫到的时候不受「同一个人冷却」限制，只受全局每分钟上限
      if (!decision.must) {
        const cooldownMs = Math.max(0, num('cooldownSec', 5)) * 1000
        if (now - (state.cooldown.get(player) || 0) < cooldownMs) {
          api.log.debug(`[MC] ${player} 冷却中，忽略（${decision.reason}）`)
          return
        }
      }
      state.hits = state.hits.filter((t) => now - t < 60_000)
      if (state.hits.length >= Math.max(1, num('maxPerMinute', 10))) {
        api.log.debug('[MC] 每分钟上限到了，忽略')
        return
      }
      if (state.processing.has(player)) return
      state.cooldown.set(player, now)
      state.hits.push(now)
      state.processing.add(player)
      try {
        await respond({ player, text: merged, decision })
      } catch (error) {
        state.lastError = '回应失败：' + error.message
        api.log.warn(`[MC] 回应 ${player} 失败：` + error.message)
      } finally {
        state.processing.delete(player)
      }
    }

    async function handleChat ({ player, text, source = 'log' }) {
      if (!S().enabled || !S().listen) return
      const now = Date.now()
      if (state.lastIn && state.lastIn.player === player && state.lastIn.text === text && now - state.lastIn.at < 2000) return
      state.lastIn = { player, text, at: now }
      addRecent({ at: now, player, text, dir: 'in', admin: isAdmin(player) })
      rememberChat(player, text, 'in')

      // 跨维度 tp 的确认：玩家回「是」就传，回「不/算了」就取消
      const pendingTp = state.pendingTp.get(player)
      if (pendingTp) {
        const t = String(text).trim()
        if (Date.now() - pendingTp.at > 60_000) {
          state.pendingTp.delete(player)
        } else if (/^(是|是的|对|对的|确认|好|好嘞|嗯|嗯嗯|可以|行|去吧|传吧|1|shi|shide|yes|yep|ok|y)[。!！~～]?$/i.test(t)) {
          state.pendingTp.delete(player)
          void execPending(player, pendingTp)
          return
        } else if (/^(不|不是|不用|算了|取消|别|0|bushi|no|nope|n)[。!！~～]?$/i.test(t)) {
          state.pendingTp.delete(player)
          await sendLines(player, ['好 那先不去了'])
          rememberChat('你', '好 那先不去了', 'out')
          return
        }
      }

      queueChat(player, text)
    }

    /** 服务器事件：有人死了，她主动调侃/关心一句。 */
    async function handleEvent (event) {
      if (!S().eventsEnabled) return
      if (event.kind !== 'death') return
      if (!isAllowed(event.player)) return
      const now = Date.now()
      const gap = Math.max(0, num('deathCooldownSec', 60)) * 1000
      if (now - (state.deathAt.get(event.player) || 0) < gap) return
      const chance = Math.max(0, Math.min(100, num('deathChance', 100)))
      if (Math.random() * 100 >= chance) return
      state.deathAt.set(event.player, now)

      const detail = String(event.text || '').slice(event.player.length).trim() || '死了'
      addRecent({ at: now, player: event.player, text: event.text, dir: 'event', admin: isAdmin(event.player) })
      rememberChat('系统', event.text, 'in')
      api.log.info(`[MC] 死亡事件：${event.player} ${detail}`)
      try {
        const p = persona()
        const raw = await askModel({
          system: buildEventSystem({ personaBody: p.body }),
          prompt: `【服务器事件】${event.player} 刚刚${detail}`,
          maxTokens: 200,
        })
        const { text } = parseModelReply(raw)
        const lines = toChatLines(text, { maxChars: 120, maxLines: 2 })
        if (!lines.length) return
        await sendLines(event.player, lines)
        rememberChat('你', lines.join(' '), 'out')
      } catch (error) {
        state.lastError = '死亡播报失败：' + error.message
        api.log.warn('[MC] 死亡播报失败：' + error.message)
      }
    }

    // ---------------- 日志跟随 ----------------
    function tickWatch () {
      if (!S().enabled) return
      const path = String(S().logPath || '').trim()
      const on = S().listen === true
      const key = on ? path : ''
      if (key !== state.watchKey) {
        try { state.watcher?.close() } catch (error) {}
        state.watcher = null
        state.watchKey = key
        if (on && path) state.watcher = createLogWatch({ path })
      }
      if (!state.watcher) return
      // 死亡事件要靠在线玩家名辨认是谁死了；列表还没拉过就拉一次（失败会等 30 秒再试）
      if (!state.online.names.length && !state.onlineLoading) {
        state.onlineLoading = true
        void fetchOnline(false).catch(() => {}).finally(() => { state.onlineLoading = false })
      }
      state.watcher.tick((line) => {
        if (Date.now() - state.startedAt < 1500) return
        const chat = parseChatLine(line)
        if (chat) {
          void handleChat({ player: chat.player, text: chat.text, source: 'log' })
          return
        }
        const event = parseEventLine(line, state.online.names)
        if (event) void handleEvent(event)
      })
    }

    // ---------------- QQ 侧命令 ----------------
    function helpText () {
      return [
        '/mc status 看连接、在线、监听状态',
        '/mc list 看在线玩家',
        '/mc say 文本 在服务器里广播',
        '/mc cmd 命令 直接执行服务器命令',
        '/mc recent 看最近的聊天/回应',
        '/mc on / off 开/关游戏内监听',
        '/mc wake 看唤醒词',
        '/mc test 测一次 RCON 连接',
      ].join('\n')
    }

    async function statusText () {
      const st = rconClient().status()
      const w = state.watcher?.status() || null
      const online = await fetchOnline(true)
      return [
        `我的世界分身：总开关${S().enabled ? '开' : '关'} / 游戏内监听${S().listen ? '开' : '关'}`,
        `RCON：${st.connected ? '已连接' : '未连接'} ${st.host}:${st.port}${st.lastError ? '（' + st.lastError + '）' : ''}`,
        `日志：${w ? (w.exists ? `在跟（已读 ${w.lines} 行）` : '文件不存在：' + w.path) : '没在跟'}`,
        `在线：${online.length ? online.join('、') : '查不到'}`,
        `接话：${MODE_LABEL[S().chatMode] || S().chatMode || '智能接话'}（随机插话 ${num('interjectChance', 12)}%）`,
        `必回唤醒词：${list(S().wakeWords).join('、') || '没设置'}`,
        `游戏内管理员：${list(S().admins).join('、') || '没设置'}`,
        `普通玩家可用：${list(S().guestCommands).join('、') || '无'}`,
        `人格卡：${persona().name}（${S().personaId || '当前人格'}）`,
        state.lastError ? `最近错误：${state.lastError}` : '',
      ].filter(Boolean).join('\n')
    }

    async function listText () {
      const online = await fetchOnline(true)
      return online.length ? `在线（${online.length}）：${online.join('、')}` : '现在没人在线，或者 RCON 连不上'
    }

    async function recentText () {
      const items = state.recent.slice(0, 12).reverse()
      if (!items.length) return '还没有记录'
      return items.map((x) => `[${new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${x.dir === 'in' ? x.player : '→ ' + x.player}：${x.text}`).join('\n')
    }

    async function broadcastText (text) {
      const lines = toChatLines(text || '', { maxChars: 200, maxLines: 3 })
      if (!lines.length) return '用法：/mc say 要说的话'
      const rs = []
      for (const line of lines) rs.push(await sayInGame('@a', line))
      const bad = rs.find((r) => !r.ok)
      return bad ? '没发出去：' + bad.message : '发出去了'
    }

    async function setListen (on) {
      api.saveSettings({ listen: on })
      state.watchKey = '' // 让下一次 tick 重建监听
      return on ? '游戏内监听打开了' : '游戏内监听关掉了'
    }

    async function handleQqCommand (arg) {
      const raw = String(arg || '').trim()
      if (!raw) return helpText()
      const m = raw.match(/^(\S+)\s*([\s\S]*)$/)
      const sub = String(m ? m[1] : '').toLowerCase()
      const rest = String(m ? m[2] : '').trim()
      switch (sub) {
        case 'help': case '帮助': case '?': return helpText()
        case 'status': case '状态': return await statusText()
        case 'list': case '在线': return await listText()
        case 'recent': case '最近': return await recentText()
        case 'wake': case '唤醒词': return '必回唤醒词：' + (list(S().wakeWords).join('、') || '没设置')
        case 'on': case '开': return await setListen(true)
        case 'off': case '关': return await setListen(false)
        case 'test': case '测试': {
          const ns = await fetchOnline(true)
          const st = rconClient().status()
          return st.connected ? 'RCON 连上了，在线：' + (ns.join('、') || '没人') : '连不上：' + (st.lastError || '未知原因')
        }
        case 'say': case '说': case '广播': return await broadcastText(rest)
        case 'cmd': case '命令': case '执行': case 'rcon': {
          if (!rest) return '用法：/mc cmd <服务器命令>'
          const r = await safeExec(rest)
          return r.ok ? `执行 /${r.cmd}\n${r.out || '（没有回执）'}` : `执行 /${r.cmd} 失败：${r.message}`
        }
        default:
          return `不认识的子命令「${sub}」\n` + helpText()
      }
    }

    api.command({
      name: 'mc',
      desc: '我的世界服务器：/mc status | list | say 文本 | cmd 命令 | recent | on | off',
      run: async (arg, msg) => {
        if (!isQqAdmin(msg.userId)) return '这个命令只有主人或管理员能用'
        return await handleQqCommand(arg)
      },
    })

    // 非主人的 Aurabot 管理员：主人的命令轮不到 message 事件，这里补上 qqAdmins 的入口
    api.on('message', async (msg) => {
      if (!isQqAdmin(msg.userId)) return false
      if (!/^\/mc(?:\s|$)/i.test(String(msg.text || '').trim())) return false
      const arg = String(msg.text).trim().replace(/^\/mc\s*/i, '')
      const out = await handleQqCommand(arg)
      if (out) await api.reply(msg, out)
      return true
    })

    // ---------------- 给她用的工具（QQ 里自己决定用） ----------------
    api.tool((where) => {
      if (where.chat.kind === 'system') return []
      const tool = (name, description, properties, execute) => api.defineTool({ name, description, properties, execute })
      return [
        tool('mc_rcon_status', '看看我的世界服务器连没连上、谁在线、你刚才在游戏里说过什么。', {}, async () => ({ ok: true, message: await statusText() })),
        tool('mc_rcon_say', '在 Minecraft 服务器里以你的身份说一句话，所有人都能看到。', { text: { type: 'string', description: '要说的话，短一点' } }, async ({ text }) => {
          const lines = toChatLines(text, { maxChars: 200, maxLines: 3 })
          if (!lines.length) return { ok: false, message: '没有内容' }
          const sent = await sendLines('@a', lines)
          return sent ? { ok: true, message: `在服务器里说了 ${sent} 条` } : { ok: false, message: state.lastError || '没发出去' }
        }),
        tool('mc_rcon_exec', '在我的世界服务器执行一条命令（只有主人能让你用）。', { command: { type: 'string', description: '服务器命令，不要写开头的斜杠' } }, async ({ command }) => {
          if (!api.core.hub.turnSendersAllOwner(where.sessionId)) return { ok: false, message: '只有主人能让我在服务器执行命令' }
          const r = await safeExec(command)
          return r.ok ? { ok: true, message: `/${r.cmd} → ${r.out || '（没有回执）'}` } : { ok: false, message: r.message }
        }),
      ]
    })

    // 让她在 QQ 里也知道自己有这个分身（规则每轮现读，改设置即时生效）
    api.rule((kind) => {
      if (!S().enabled) return ''
      const words = list(S().wakeWords)
      if (!words.length) return ''
      const admins = list(S().admins)
      const guest = list(S().guestCommands)
      if (kind === 'social') {
        return `- 除了 QQ，你还在我的世界服务器「${S().serverName}」里：平时能看大家聊天，被叫「${words.join('、')}」时会回应，也会接感兴趣的话题；普通玩家可以申请切旁观/生存、传送到坐标、回出生点这类安全操作，其他一律拒绝。`
      }
      return `- 你在「我的世界」服务器「${S().serverName}」里有个分身：平时看大家聊天、被叫到会接话；管理员（${admins.join('、') || '未设置'}）能让你执行命令，普通玩家可以申请 ${guest.join('、') || '（无）'} 这些安全操作；主人可以直接用 /mc 命令控制服务器。`
    })

    // ---------------- 面板接口 ----------------
    async function panelStatus () {
      const st = rconClient().status()
      const w = state.watcher?.status() || null
      const online = await fetchOnline(true)
      return {
        ok: true,
        settings: {
          enabled: S().enabled === true,
          listen: S().listen === true,
          host: st.host,
          port: st.port,
          logPath: String(S().logPath || ''),
          chatMode: S().chatMode || 'smart',
          eventsEnabled: S().eventsEnabled === true,
          serverName: S().serverName || '',
          autoDetect: S().autoDetect !== false,
          lastSwitch: state.lastSwitch,
          wakeWords: list(S().wakeWords),
          nicknames: list(S().nicknames),
          admins: list(S().admins),
          guestCommands: list(S().guestCommands),
          replyMode: S().replyMode || 'broadcast',
        },
        rcon: st,
        watch: w,
        online,
        persona: persona(),
        recent: state.recent.slice(0, 30),
        lastError: state.lastError,
      }
    }

    api.route('/status', async () => panelStatus())

    api.route('/detect', async () => {
      const { candidates, active } = await detectActive(true)
      return {
        ok: true,
        current: { host: S().host, port: S().port, logPath: S().logPath, serverName: S().serverName },
        active: active ? { dir: active.dir, name: active.name } : null,
        candidates: candidates.slice(0, 12).map((c) => ({
          dir: c.dir,
          name: c.name,
          port: c.port,
          rconEnabled: c.rconEnabled,
          tested: Boolean(c.rcon),
          reachable: Boolean(c.rcon && c.rcon.ok),
          logAgeMs: Number.isFinite(c.logAgeMs) ? c.logAgeMs : null,
          current: sameServer(c),
        })),
      }
    })

    api.route('/switch', async (req) => {
      const body = await api.core.http.body(req)
      const dir = String(body.dir || '').trim()
      if (!dir) return { ok: false, message: '缺 dir' }
      const { candidates } = await detectActive(false)
      const target = candidates.find((c) => c.dir === dir)
      if (!target) return { ok: false, message: '这个目录不在候选里' }
      if (!target.rconEnabled) return { ok: false, message: '这个服没有开启 RCON，切过去也没法控制' }
      await applyServer(target)
      return { ok: true, message: `已切换到「${target.name}」` }
    })

    api.route('/exec', async (req) => {
      const body = await api.core.http.body(req)
      const cmd = String(body.command || body.cmd || '').trim()
      if (!cmd) return { ok: false, message: '命令是空的' }
      const r = await safeExec(cmd)
      return r.ok ? { ok: true, message: r.out || '（没有回执）' } : { ok: false, message: r.message }
    })

    api.route('/say', async (req) => {
      const body = await api.core.http.body(req)
      const text = String(body.text || '').trim()
      if (!text) return { ok: false, message: '要说什么是空的' }
      const lines = toChatLines(text, { maxChars: 200, maxLines: 3 })
      if (!lines.length) return { ok: false, message: '没有内容' }
      const sent = await sendLines('@a', lines)
      return sent ? { ok: true, message: `发出去了 ${sent} 条` } : { ok: false, message: state.lastError || '没发出去' }
    })

    api.route('/recent', async () => ({ ok: true, items: state.recent.slice(0, 40) }))

    api.route('/ingame', async (req) => {
      const query = api.core.http.query(req)
      let body = {}
      try { body = await api.core.http.body(req) } catch (error) {}
      const token = String(body.token || query.token || req.headers?.['x-mc-token'] || '')
      const want = String(S().ingestToken || '')
      if (!want) return { ok: false, message: '没开外部转入口（面板里填一个 token 才启用）' }
      if (token !== want) return { ok: false, message: 'token 不对' }
      const player = String(body.player || query.player || '').slice(0, 32)
      const text = String(body.text || query.text || '').slice(0, 500)
      if (!player || !text) return { ok: false, message: '缺 player 或 text' }
      if (!/^[A-Za-z0-9_]{1,32}$/.test(player)) return { ok: false, message: 'player 只能字母、数字、下划线' }
      void handleChat({ player, text, source: 'http' })
      return { ok: true }
    })

    // ---------------- 定时任务 ----------------
    api.every(1000, tickWatch, '跟随服务器日志')

    api.every(30_000, autoDetectTick, '自动检测服务器')
    api.later(3000, autoDetectTick)

    api.every(30_000, async () => {
      if (!S().enabled) return
      // 已连上就别每 30 秒打一条 list（服务器的 RCON 日志会被刷屏）；断线了才尝试重连
      if (rconClient().status().connected) return
      await fetchOnline(true).catch(() => {})
    }, 'RCON 保活')

    api.every(10 * 60_000, () => {
      // 清理久未活动的冷却记录，别让 Map 越长越大
      const cutoff = Date.now() - 6 * 60 * 60_000
      for (const [player, at] of state.cooldown) if (at < cutoff) state.cooldown.delete(player)
      for (const [player, at] of state.guestCmdAt) if (at < cutoff) state.guestCmdAt.delete(player)
      for (const [player, pos] of state.lastPos) if (Date.now() - pos.at > 30 * 60_000) state.lastPos.delete(player)
      for (const [player, at] of state.deathAt) if (at < cutoff) state.deathAt.delete(player)
      for (const [player, p] of state.pendingTp) if (Date.now() - p.at > 60_000) state.pendingTp.delete(player)
      if (state.context.length > 24) state.context.splice(0, state.context.length - 24)
      if (state.recent.length > 60) state.recent.length = 60
    }, '清理缓存')

    api.later(800, tickWatch)

    api.onDispose(() => {
      for (const item of state.pending.values()) if (item.timer) clearTimeout(item.timer)
      state.pending.clear()
      try { state.watcher?.close() } catch (error) {}
      try { state.client?.close() } catch (error) {}
    })

    return {
      exec: safeExec,
      status: panelStatus,
      say: (text) => sendLines('@a', toChatLines(text, { maxChars: 200, maxLines: 3 })),
      recent: () => state.recent.slice(0, 40),
      persona: () => persona(),
    }
  },
}
