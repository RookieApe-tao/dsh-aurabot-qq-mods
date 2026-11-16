// livin 过日子 · 冒烟测试（mock api，零联网；直接调模块导出的 hooks）
import assert from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import mod, { decay } from '../index.mjs'

const HOUR = 3600 * 1000
const MIN = 60 * 1000
let passed = 0
const ok = (name, cond, extra = '') => { if (!cond) throw new Error(`✗ ${name} ${extra}`); passed++; console.log(`✓ ${name}`) }

const dir = mkdtempSync(join(tmpdir(), 'livin-test-'))
const routes = {}
const jobs = []
const rules = []
let tools = null
const sentLog = []
let thinkQueue = []
let hubOwnerAt = 0
let sendFails = false
let savedSettings = null
let mgInstalled = true
let novelModeVar = 'short'

const api = {
  dataDir: () => dir,
  dir,
  config: () => ({ ownerName: '老大', ownerQQ: '123' }),
  settings: () => ({ enabled: true, wakeChance: 40, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8, novelMode: novelModeVar }),
  saveSettings: (patch) => { savedSettings = { ...(savedSettings || {}), ...patch } },
  log: { info() {}, warn() {}, error() {} },
  dsh: { webServer: { port: 59999 } },
  core: {
    hub: { get lastOwnerChatAt() { return hubOwnerAt }, turnSendersAllOwner: () => true },
    http: { body: async (req) => req.__body },
  },
  think: async (prompt, opts) => thinkQueue.shift() ?? '',
  send: async (chatId, text) => { sentLog.push({ chatId, text }); if (sendFails) throw new Error('网关炸了') },
  use: (name) => (name === 'minigame' ? (mgInstalled ? { play: async () => ({ title: '2048', win: true, score: 1234 }) } : null) : (name === 'bili' ? { run: async () => ({ message: '逛了逛热门' }) } : null)),
  tool: (fn) => { tools = fn() },
  defineTool: (p) => p,
  rule: (f) => rules.push(f),
  every: (ms, fn, name) => jobs.push({ ms, fn, name }),
  route: (p, f) => { routes[p] = f },
}

const hooks = mod.setup(api)
const stateOf = () => hooks.st().state
const lastHist = () => hooks.st().history[hooks.st().history.length - 1]
const findHist = (pred) => [...hooks.st().history].reverse().find(pred)
const tickOnce = async () => { await jobs[0].fn() }
const wakeOnce = async () => { await hooks.wake() }

// 1) 注册面
ok('定时任务注册了', jobs.length === 1 && jobs[0].ms === 15 * MIN)
ok('工具注册了', Array.isArray(tools) && tools.length === 2)
ok('规则注册了', rules.length === 1)

// 2) decay 曲线
ok('衰减 <1h=0.5', decay(30 * MIN) === 0.5)
ok('衰减 1-3h=0.7', decay(2 * HOUR) === 0.7)
ok('衰减 3-6h=0.85', decay(5 * HOUR) === 0.85)
ok('衰减 >6h=1.0', decay(7 * HOUR) === 1)
ok('衰减 非法值=1.0', decay(undefined) === 1)

// 3) 闸门：安静时段（0-24 全天）
api.settings = () => ({ enabled: true, wakeChance: 40, quietStart: 0, quietEnd: 24, idleMinutes: 20, dailyMax: 8 })
await tickOnce()
ok('安静时段挡住', lastHist().gate === '睡觉时段')

// 4) 主人刚聊过（只认主人私聊时间戳）
api.settings = () => ({ enabled: true, wakeChance: 40, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8 })
hubOwnerAt = Date.now() - 5 * MIN
await tickOnce()
ok('主人刚聊过挡住', lastHist().gate === '主人刚聊过')

// 5) 她自己定的还没到
hubOwnerAt = Date.now() - 2 * HOUR
hooks.set({ nextWakeAt: Date.now() + 30 * MIN, nextWakeBy: '她自己定的' })
await tickOnce()
ok('自排程没到挡住', lastHist().gate === '她自己定的还没到')

// 6) 概率没中
hooks.set({ nextWakeAt: 0 })
api.settings = () => ({ enabled: true, wakeChance: 0, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8 })
await tickOnce()
ok('概率挡住', lastHist().gate === '这一轮没醒')

// 7) 额度用完（wakeChance=100 才能走到这道闸）
api.settings = () => ({ enabled: true, wakeChance: 100, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8 })
hooks.set({ doneCount: 8 })
await tickOnce()
ok('额度挡住', lastHist().gate === '今天额度用完')

// 8) 完整醒来流程：喝水（挑水 → 回味+自排程 45 分钟 → 不分享）
hooks.set({ doneCount: 0, nextWakeAt: 0, perJoy: {}, lastShareAt: 0 })
thinkQueue = ['没什么想法，就想起来活动一下\n选择：喝口水歇歇眼', '水有点凉，不过挺舒服\n下次：45分钟']
api.settings = () => ({ enabled: true, wakeChance: 100, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8, shareChance: 0, shareGapMin: 90 })
await wakeOnce()
let s = stateOf()
ok('醒来记 done', findHist((h) => h.event === 'done')?.joy === '喝口水歇歇眼')
ok('计数+1', s.doneCount === 1)
ok('自排程生效(45分钟)', s.nextWakeBy === '她自己定的' && Math.abs(s.nextWakeAt - (s.lastWokeAt + 45 * MIN)) < 5000, JSON.stringify({ nextWakeAt: s.nextWakeAt, lastWokeAt: s.lastWokeAt }))
ok('shareChance=0 不发（偷着乐）', findHist((h) => h.event === 'share')?.state === 'kept')
ok('权重时间戳更新', s.perJoy.water?.lastAt > 0)

// 9) 自排程钳制
hooks.set({ perJoy: {} })
thinkQueue = ['选择：就发会儿呆', '发了会儿呆\n下次：10分钟']
await wakeOnce()
s = stateOf()
ok('下次钳到30分钟', Math.abs(s.nextWakeAt - (s.lastWokeAt + 30 * MIN)) < 5000)

thinkQueue = ['选择：就发会儿呆', '躺平了\n下次：500分钟']
await wakeOnce()
s = stateOf()
ok('下次钳到180分钟', Math.abs(s.nextWakeAt - (s.lastWokeAt + 180 * MIN)) < 5000)

thinkQueue = ['选择：就发会儿呆', '没想好，随缘']
await wakeOnce()
s = stateOf()
ok('没写就随机兜底', s.nextWakeBy === '随机兜底' && s.nextWakeAt - s.lastWokeAt >= 60 * MIN - 2000 && s.nextWakeAt - s.lastWokeAt <= 180 * MIN + 2000)

// 10) 她不想动
hooks.set({ perJoy: {} })
thinkQueue = ['今天真的懒得动，就想瘫着']
await wakeOnce()
ok('不想动记 skipped', lastHist().event === 'skipped' && lastHist().gate === '她自己不想动')

// 11) 小游戏执行器 + 分享 sent
hooks.set({ perJoy: {}, lastShareAt: 0 })
thinkQueue = ['手痒了\n选择：玩一局小游戏', '赢了！2048上了1200\n下次：90分钟']
api.settings = () => ({ enabled: true, wakeChance: 100, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8, shareChance: 100, shareGapMin: 30 })
await wakeOnce()
ok('小游戏 done 且成绩进历史', findHist((h) => h.event === 'done')?.detail?.includes('2048'))
const shareEvt = findHist((h) => h.event === 'share')
ok('分享 sent', shareEvt?.state === 'sent' && sentLog.length === 1 && sentLog[0].chatId === 'private:123')

// 12) 静默期：刚分享过 → kept
hooks.set({ perJoy: {}, lastShareAt: Date.now() })
thinkQueue = ['选择：玩一局小游戏', '又赢一把\n下次：90分钟']
await wakeOnce()
ok('分享静默期挡住', findHist((h) => h.event === 'share')?.state === 'kept')

// 13) 同乐子日分享上限 2
hooks.set({ perJoy: { minigame: { lastAt: 0, sharedToday: 2 } }, lastShareAt: 0 })
thinkQueue = ['再来一局\n选择：玩一局小游戏', '三连胜\n下次：120分钟']
await wakeOnce()
ok('同乐子日分享≤2', findHist((h) => h.event === 'share')?.state === 'kept')

// 14) 发送失败 → failed（重试也失败）
sendFails = true
hooks.set({ perJoy: {}, lastShareAt: 0 })
thinkQueue = ['选择：玩一局小游戏', '赢了\n下次：60分钟']
await wakeOnce()
ok('发送失败记 failed', findHist((h) => h.event === 'share')?.state === 'failed')
sendFails = false

// 15) douyin 执行器：起个真 HTTP 服务器
const server = createServer((req, res) => { res.end(JSON.stringify({ ok: true })) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
api.dsh.webServer.port = server.address().port
hooks.set({ perJoy: {}, lastShareAt: 0 })
api.settings = () => ({ enabled: true, wakeChance: 100, quietStart: 1, quietEnd: 8, idleMinutes: 20, dailyMax: 8, shareChance: 0, novelMode: novelModeVar })
thinkQueue = ['去刷会儿\n选择：刷会儿抖音', '刷到一只猫\n下次：100分钟']
await wakeOnce()
ok('douyin 触发成功', findHist((h) => h.event === 'done')?.detail?.includes('已经开始刷了'))
server.close()

// 16) bili 执行器
thinkQueue = ['逛逛B站\n选择：去B站逛逛', '看了个科普\n下次：120分钟']
await wakeOnce()
ok('bili done', findHist((h) => h.event === 'done')?.detail === '逛了逛热门')

// 17) 写小说执行器
thinkQueue = ['写点东西\n选择：写小说', '《深海旅店》\n老陈推开旋转门的时候，风铃响了一声。他兜里只有半张船票。', '这一章写得顺\n下次：150分钟']
await wakeOnce()
s = stateOf()
ok('小说 done', findHist((h) => h.event === 'done')?.joy === '写小说')
const novelData = hooks.st().novel
ok('小说内容入档', novelData.parts.length === 1 && novelData.parts[0].text.includes('风铃'))

// 18) joy_do 工具（额度内直接做）
// v1.2.2 起两次 joy_do 之间至少歇 30 分钟（state.lastJoyAt，wake 成功也会记），
// 所以这里要显式把 lastJoyAt 清零，别被前面的 wake 案例挡住
hooks.set({ perJoy: {}, doneCount: 0, lastJoyAt: 0 })
const doTool = tools.find((t) => t.name === 'joy_do')
const r = await doTool.execute({ what: '喝口水歇歇眼' })
ok('joy_do 直接做', r.ok === true && r.message.includes('活动'))

// 18b) joy_do 间隔：刚玩过 30 分钟内被挡，且不扣额度
const rGap = await doTool.execute({})
ok('joy_do 间隔挡', rGap.ok === false && /歇\d+分钟/.test(rGap.message), rGap.message)
ok('joy_do 间隔挡不扣额度', stateOf().doneCount === 1)

// 19) joy_do 额度挡
hooks.set({ doneCount: 8 })
const r2 = await doTool.execute({})
ok('joy_do 额度挡', r2.ok === false && r2.message.includes('歇了'))

// 20) joy_list
const listTool = tools.find((t) => t.name === 'joy_list')
hooks.set({ doneCount: 0, perJoy: {} })
const r3 = await listTool.execute({})
ok('joy_list 报清单', r3.ok && r3.message.includes('刷会儿抖音'))

// 20b) 没装 minigame 时，清单里不出现小游戏，/state 标记 ok:false
mgInstalled = false
const rNoMg = await listTool.execute({})
ok('没装小游戏时清单过滤', rNoMg.ok && !rNoMg.message.includes('小游戏'), rNoMg.message.slice(0, 50))
const stNoMg = await routes['/state']()
const mgJoy = stNoMg.joys.find((j) => j.id === 'minigame')
ok('/state 标记没装', stNoMg.ok && mgJoy && mgJoy.ok === false)
mgInstalled = true

// 21) 面板接口
const st = await routes['/state']()
ok('GET /state', st.ok && st.today.max === 8 && Array.isArray(st.joys))
const hResp = await routes['/history']()
ok('GET /history', hResp.ok && Array.isArray(hResp.history) && hResp.history.length > 0)
const t1 = await routes['/pool/toggle']({ __body: { id: 'douyin' } })
ok('toggle 关', t1.ok === true && t1.on === false)
const t2 = await routes['/pool/toggle']({ __body: { id: 'douyin' } })
ok('toggle 开回', t2.ok === true && t2.on === true)

// 面板总开关 /enabled
const off = await routes['/enabled']({ __body: { on: false } })
ok('/enabled 关', off.ok === true && off.enabled === false && savedSettings.enabled === false)
const onResp = await routes['/enabled']({ __body: { on: true } })
ok('/enabled 开', onResp.ok === true && onResp.enabled === true && savedSettings.enabled === true)

// 小说模式：/novel/mode + 长篇写章存 Word + 短篇镜像 Word
const { readDocxText } = await import('../lib/docx.mjs')
const { readdirSync, rmSync } = await import('node:fs')
rmSync(join(dir, 'novel'), { recursive: true, force: true }) // 清掉前面短篇测试留下的书架，从空书架开始
const modeResp = await routes['/novel/mode']({ __body: { mode: 'long' } })
ok('/novel/mode 切长篇', modeResp.ok && modeResp.mode === 'long' && savedSettings.novelMode === 'long')
novelModeVar = 'long'

hooks.set({ doneCount: 0, perJoy: {}, lastJoyAt: 0 })
thinkQueue = ['深海旅店\n老陈推开旋转门的时候，风铃响了一声。他兜里只有半张船票，票根上还留着上个港口的印章。潮水的气味从门缝里涌进来，像谁在他耳边换了口气。']
const doNovel = await doTool.execute({ what: '写小说' })
const novelFiles = readdirSync(join(dir, 'novel')).filter((f) => f.endsWith('.docx'))
ok('长篇写章', doNovel.ok && doNovel.message.includes('第1章') && novelFiles.length === 1, doNovel.message)
const chapText = readDocxText(readFileSync(join(dir, 'novel', novelFiles[0])))
ok('长篇 Word 可读回', chapText.includes('船票') && chapText.includes('风铃'), chapText.slice(0, 40))

thinkQueue = ['潮声\n天亮之前，老陈把船票撕成了两半。']
hooks.set({ lastJoyAt: 0 })
const doNovel2 = await doTool.execute({ what: '写小说' })
const novelFiles2 = readdirSync(join(dir, 'novel')).filter((f) => f.endsWith('.docx'))
ok('长篇第二章', doNovel2.ok && novelFiles2.length === 2 && doNovel2.message.includes('第2章'), doNovel2.message)

const modeResp2 = await routes['/novel/mode']({ __body: { mode: 'short' } })
ok('/novel/mode 切短篇', modeResp2.ok && modeResp2.mode === 'short')
novelModeVar = 'short'
hooks.set({ doneCount: 0, perJoy: {}, lastJoyAt: 0 })
thinkQueue = ['他决定开个新篇，写一个关于灯塔守夜人的故事。']
const doShort = await doTool.execute({ what: '写小说' })
const shortFiles = readdirSync(join(dir, 'novel')).filter((f) => f.endsWith('.docx'))
ok('短篇镜像 Word', doShort.ok && shortFiles.length === 3 && shortFiles.includes('《深海旅店》.docx'), doShort.message + ' | ' + shortFiles.join(','))

console.log(`\n通过 ${passed} 项`)
