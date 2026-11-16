import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { wallTime, parseHm, formatHm, daysBetweenYmd, shiftYmd, inHourWindow } from '../lib/clock.mjs'
import { createRealLifeEngine, classifyFood } from '../lib/engine.mjs'
import mod from '../index.mjs'

let checkDef = (def, id) => {
  if (!def || typeof def !== 'object' || typeof def.setup !== 'function') return 'invalid def'
  if (id && def.id !== id) return 'id mismatch'
  return ''
}
try {
  const hostMods = await import('../../Aurabot-upgrade-1.2.0/src/core/modules.js')
  if (typeof hostMods.checkDef === 'function') checkDef = hostMods.checkDef
} catch {}

test('clock: Asia/Shanghai wall-clock and date math stay deterministic', () => {
  // 2026-11-15T12:30:00Z === 2026-11-15 20:30 Asia/Shanghai
  const ms = Date.parse('2026-11-15T12:30:00Z')
  const wt = wallTime(ms, 'Asia/Shanghai')
  assert.equal(wt.ymd, '2026-11-15')
  assert.equal(wt.hhmm, '20:30')
  assert.equal(parseHm('23:30'), 23.5)
  assert.equal(formatHm(23.5), '23:30')
  assert.equal(daysBetweenYmd('2026-11-01', '2026-11-15'), 14)
  assert.equal(shiftYmd('2026-11-15', -14), '2026-11-01')
  assert.equal(inHourWindow(23.8, 23.5, 7.5), true)
  assert.equal(inHourWindow(2.0, 23.5, 7.5), true)
  assert.equal(inHourWindow(14.0, 23.5, 7.5), false)
})

test('period Day 1-2 heavy reaction, cold drink penalty, care relief, and strict group privacy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-test-'))
  try {
    let now = Date.parse('2026-11-15T06:00:00Z') // 14:00 CST
    const moodLog = []
    const memLog = []
    const eng = createRealLifeEngine({
      getSettings: () => ({ periodSeverity: 'heavy', cycleLength: 28, periodDays: 5 }),
      stateFile: join(dir, 'state.json'),
      nowFn: () => now,
      onMoodNudge: (d, r) => moodLog.push({ d, r }),
      onMemoryEvent: (t) => memLog.push(t),
    })

    eng.applyScenario('period-day1', now)
    const cyc1 = eng.computeCycle(now)
    assert.equal(cyc1.phase, 'menstrual')
    assert.equal(cyc1.dayOfCycle, 1)
    assert.ok(cyc1.discomfort >= 70, `expected Day 1 heavy discomfort >= 70, got ${cyc1.discomfort}`)

    // 主人私聊应该看到详细的生理期第 1 天不适与需要哄提示
    const ownerCtx = eng.buildContext({ chat: { chatId: 'private:123', kind: 'private' }, isOwner: true, now })
    assert.match(ownerCtx, /生理期第 1 天/)
    assert.match(ownerCtx, /抱抱|哄/)

    // 群聊与外人私聊严禁泄露生理期、痛经、上厕所、洗澡字眼！
    const groupCtx = eng.buildContext({ chat: { chatId: 'group:999', kind: 'group' }, isOwner: false, now })
    assert.doesNotMatch(groupCtx, /生理期第|小腹|姨妈|暖宝宝/)
    const strangerCtx = eng.buildContext({ chat: { chatId: 'private:888', kind: 'private' }, isOwner: false, now })
    assert.doesNotMatch(strangerCtx, /生理期第 1 天|小腹/)

    // 经期喂冰奶茶 → 触发贪凉痛经惩罚！
    const coldRes = eng.feed({ item: '冰奶茶', byOwner: true, now })
    assert.equal(coldRes.coldTriggered, true)
    assert.ok(coldRes.discomfort > cyc1.discomfort)
    assert.ok(moodLog.some((m) => m.d < 0))

    // 主人贴暖宝宝 + 泡热红糖姜茶 + 揉肚子抱抱 → 明显缓解不适！
    const c1 = eng.care({ method: '暖宝宝', byOwner: true, now })
    assert.ok(c1.afterDiscomfort < c1.beforeDiscomfort)
    const c2 = eng.feed({ item: '热红糖姜茶', temp: 'warm', byOwner: true, now })
    assert.equal(c2.warmComforted, true)
    const c3 = eng.care({ method: '揉揉肚子抱抱', byOwner: true, now })
    assert.ok(c3.afterDiscomfort < 55, `expected comforted discomfort < 55, got ${c3.afterDiscomfort}`)
    assert.ok(memLog.length >= 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('away system: shower -> hair-drying two-stage flow, message queuing, and afterglow', () => {
  let now = Date.parse('2026-11-15T13:30:00Z') // 21:30 CST
  let groupOn = false
  const eng = createRealLifeEngine({
    getSettings: () => ({ groupEnabled: groupOn }),
    nowFn: () => now,
  })

  // 进入洗澡 (12m) + 吹头发 (6m)
  eng.applyScenario('shower', now)
  assert.equal(eng.state.mode, 'away')
  assert.equal(eng.state.away.kind, 'shower')

  // 洗澡期间主人发来两条私聊 → 被拦截并排进队列
  const m1 = eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '在干嘛呀' },
    { isOwner: true, now }
  )
  assert.equal(m1.intercepted, true)
  assert.equal(eng.state.awayQueue.length, 1)

  // 默认未开启群聊启用时，群聊消息不受暂离拦截影响
  const gmOff = eng.onIncomingMessage(
    { kind: 'group', chatId: 'group:200', userId: '300', nickname: '群友', text: '@鱼 在吗' },
    { isOwner: false, now }
  )
  assert.equal(gmOff.intercepted, false)

  // 开启群聊启用后，群聊消息在暂离期间静默拦截且不混入私聊队列
  groupOn = true
  const gmOn = eng.onIncomingMessage(
    { kind: 'group', chatId: 'group:200', userId: '300', nickname: '群友', text: '@鱼 在吗' },
    { isOwner: false, now }
  )
  assert.equal(gmOn.intercepted, true)
  assert.equal(eng.state.awayQueue.length, 1)

  // 13 分钟后：洗澡结束 → 自动切进「吹头发护肤中」，队列仍保留等吹完头发一起回
  now += 13 * 60_000
  const t1 = eng.tick(now)
  assert.equal(eng.state.mode, 'away')
  assert.equal(eng.state.away.kind, 'hair')
  assert.equal(t1.actions.length, 0)

  // 再过 7 分钟：吹干头发出来 → 恢复 awake，带出积攒消息，并获得洗完澡香香松弛余韵！
  now += 7 * 60_000
  const t2 = eng.tick(now)
  assert.equal(eng.state.mode, 'awake')
  assert.equal(t2.actions.length, 1)
  assert.equal(t2.actions[0].type, 'resume-away')
  assert.equal(t2.actions[0].queued.length, 1)

  const ctxAfter = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now })
  assert.match(ctxAfter, /洗完热水澡|吹干了头发/)
})

test('sleep stages: deep sleep resists waking, urgent message wakes into groggy state', () => {
  let now = Date.parse('2026-11-15T16:30:00Z') // 00:30 CST
  let rollVal = 0.5 // 0.5 > 0.12 (deep sleep won't wake on normal msg)
  const eng = createRealLifeEngine({
    getSettings: () => ({}),
    nowFn: () => now,
    rngFn: () => rollVal,
  })

  eng.applyScenario('deep-sleep', now)
  assert.equal(eng.state.mode, 'asleep')

  // 普通消息：0.5 >= 0.12 → 没吵醒，记入未读
  const r1 = eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '睡了吗' },
    { isOwner: true, now }
  )
  assert.equal(r1.intercepted, true)
  assert.equal(r1.woken, false)
  assert.equal(eng.state.missedWhileAsleep.length, 1)

  // 急事消息：唤醒率飙升到 ~0.70 > 0.5 → 被吵醒，进入 12 分钟迷糊状态！
  const r2 = eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '醒醒！有急事找你' },
    { isOwner: true, now: now + 30_000 }
  )
  assert.equal(r2.intercepted, false)
  assert.equal(r2.woken, true)
  assert.equal(eng.state.mode, 'awake')
  const ctx = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now: now + 30_000 })
  assert.match(ctx, /刚刚被主人叫醒|迷迷糊糊/)
})

test('module index.mjs hooks, slash commands, tools, and panel.js compilation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-mod-'))
  try {
    const commands = new Map()
    const routes = new Map()
    const events = new Map()
    let toolBuilder = null
    let ctxFn = null
    const pushedSessions = []
    let savedSettings = { ...mod.defaults }

    const mockApi = {
      id: 'real-life',
      dir,
      dataDir: () => dir,
      config: () => ({ enabled: true, dryRun: false, ownerQQ: '123456', ownerName: '测试主人' }),
      settings: () => savedSettings,
      saveSettings: (patch) => {
        savedSettings = { ...savedSettings, ...patch }
        return savedSettings
      },
      isOwner: (uid) => String(uid) === '123456',
      log: { info() {}, warn() {}, error() {}, debug() {} },
      context: (fn) => { ctxFn = fn; return () => {} },
      rule: () => () => {},
      on: (ev, fn) => { events.set(ev, fn); return () => {} },
      tool: (b) => { toolBuilder = b; return () => {} },
      defineTool: (spec) => spec,
      command: (c) => { commands.set(c.name, c); return () => {} },
      route: (p, h) => { routes.set(p, h); return () => {} },
      every: () => () => {},
      later: () => () => {},
      onDispose: () => () => {},
      use: () => null,
      core: {
        mutes: { muted: () => false },
        hub: {
          turnSendersAllOwner: () => true,
          pushToSession: async (chat, content) => { pushedSessions.push({ chat, content }) },
        },
        http: {
          body: async (req) => req.body || {},
        },
      },
    }

    const exported = mod.setup(mockApi)
    assert.ok(exported.snapshot)
    assert.ok(commands.has('身体'))
    assert.ok(commands.has('改状态'))
    assert.ok(commands.has('投喂'))
    assert.ok(commands.has('照顾'))
    assert.ok(commands.has('身体测试'))

    // 测试手动修改数值命令：改饥饿、精力、膀胱、周期天数、手动指定不适度、嘴馋与洗澡标记
    const editOut = await commands.get('改状态').run('饥饿=77 精力=33 膀胱=66 周期=11 不适=64 洗澡=已洗 嘴馋=火锅,草莓小蛋糕 亲密=12')
    assert.match(editOut, /已手动更新/)
    const snapEdited = exported.snapshot()
    assert.equal(snapEdited.hunger, 77)
    assert.equal(snapEdited.energy, 33)
    assert.equal(snapEdited.bladder, 66)
    assert.equal(snapEdited.cycle.dayOfCycle, 11)
    assert.equal(snapEdited.cycle.discomfort, 64)
    assert.equal(snapEdited.cycle.manualDiscomfortActive, true)
    assert.equal(snapEdited.showeredToday, true)
    assert.deepEqual(snapEdited.cravings, ['火锅', '草莓小蛋糕'])
    assert.equal(snapEdited.affection, 12)

    // 恢复自动计算不适度
    await commands.get('改状态').run('不适=自动')
    assert.equal(exported.snapshot().cycle.manualDiscomfortActive, false)

    // 测试斜杠命令：切经期1 → 查身体 → 喂冰奶茶 → 照顾暖宝宝
    const tOut = await commands.get('身体测试').run('经期1')
    assert.match(tOut, /经期第 1 天/)
    const statusOut = await commands.get('身体').run('')
    assert.match(statusOut, /经期第 1 天/)

    const feedOut = await commands.get('投喂').run('冰奶茶')
    assert.match(feedOut, /小腹抽痛加重/)
    const careOut = await commands.get('照顾').run('暖宝宝')
    assert.match(careOut, /已照顾「暖宝宝贴小腹」/)

    // 测试暂离拦截 + 一键结算合并回复
    await commands.get('身体测试').run('上厕所')
    const intercepted = await events.get('message')({
      kind: 'private',
      chatId: 'private:123456',
      userId: '123456',
      nickname: '测试主人',
      text: '人呢？看到回我一下',
      raw: {},
    })
    assert.equal(intercepted, true)

    const settleOut = await commands.get('身体测试').run('结算')
    assert.match(settleOut, /已结束暂离/)
    assert.equal(pushedSessions.length, 1)
    assert.match(pushedSessions[0].content[0].text, /人呢？看到回我一下/)

    // 测试 AI 工具仅对 full 级别暴露，群聊 social 级别不暴露
    const ownerTools = toolBuilder({ chat: { chatId: 'private:123456', kind: 'private' }, level: 'full', sessionId: 's1' })
    assert.equal(ownerTools.length, 3)
    const groupTools = toolBuilder({ chat: { chatId: 'group:999', kind: 'group' }, level: 'social', sessionId: 's2' })
    assert.equal(groupTools.length, 0)

    const statusToolRes = await ownerTools[0].execute({})
    assert.equal(statusToolRes.ok, true)
    assert.match(statusToolRes.message, /生理周期/)

    const toolRes = await ownerTools[1].execute({ action: 'feed', item: '鲜虾小馄饨', temp: 'warm', portion: 'full' })
    assert.equal(toolRes.ok, true)

    // 模拟 client/client.js 编译 panel.js，确保前端语法与组件返回零错误
    assert.equal(checkDef(mod, 'real-life'), '')
    assert.equal(mod.name, '生理模块')
    assert.equal(mod.tab, undefined)
    assert.equal(mod.flag, 'enabled')
    assert.equal(mod.defaults.groupEnabled, false)
    assert.match(mod.description, /^让你的bot拥有真人一般的作息和生理状态！目前支持：/)
    const moduleJson = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))
    assert.equal(moduleJson.id, mod.id)
    assert.equal(moduleJson.name, mod.name)
    assert.equal(moduleJson.version, mod.version)
    assert.equal(moduleJson.api, mod.api)
    assert.equal(moduleJson.description, mod.description)

    const panelSrc = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
    const populatedSnap = exported.snapshot()
    const mockH = (tag, props, ...children) => {
      if (typeof tag === 'function') return tag({ ...(props || {}), children })
      return { tag, props, children }
    }
    const mockUi = {
      Card: 'Card',
      Btn: 'Btn',
      Switch: 'Switch',
      Row: 'Row',
      Select: 'Select',
      Range: 'Range',
      Empty: 'Empty',
    }
    // 逐一渲染全部 6 个分类标签页，确保每个分类都无报错返回节点
    for (const tabId of ['status', 'mode', 'diet', 'sleep', 'period', 'debug']) {
      let stateIdx = 0
      const mockReact = {
        useState: (v) => {
          const idx = stateIdx++
          if (idx === 0) return [populatedSnap, () => {}]
          if (idx === 1) return [tabId, () => {}]
          return [v, () => {}]
        },
        useEffect: () => {},
      }
      const PanelComp = new Function('React', 'h', 'ui', 'call', panelSrc)(mockReact, mockH, mockUi, async () => ({}))
      assert.equal(typeof PanelComp, 'function')
      const tree = PanelComp({
        settings: mod.defaults,
        draftSettings: mod.defaults,
        setSettings: () => {},
        save: async () => {},
        toast: () => {},
        reload: () => {},
      })
      assert.ok(tree)
      assert.equal(tree.children.length, 2)
    }

    // 验证 classifyFood
    assert.equal(classifyFood('抹茶冰淇淋').temp, 'cold')
    assert.equal(classifyFood('红糖姜茶').isPeriodRemedy, true)
    assert.ok(typeof ctxFn({ chat: { chatId: 'private:123456', kind: 'private', userId: '123456' } }) === 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v1.1: chat deferral requires owner permission; 4 messages while away force immediate reply', () => {
  let now = Date.parse('2026-11-15T13:35:00Z') // 21:35 CST (shower window + high bladder)
  const eng = createRealLifeEngine({
    getSettings: () => ({ autonomyMode: 'daily', chatIdleMinutes: 15, forceReplyCount: 4 }),
    nowFn: () => now,
  })

  // 正在和主人私聊时，哪怕膀胱拉满到 90 且到洗澡点，tick 也绝不自动切入 away 或擅自挂起 pendingAway
  eng.updateValues({ bladder: 90 }, now)
  eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '陪我聊会儿天' },
    { isOwner: true, now }
  )
  eng.tick(now + 30_000)
  assert.equal(eng.state.mode, 'awake')
  assert.equal(eng.state.pendingAway, null)
  const chatCtx = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now: now + 30_000 })
  assert.match(chatCtx, /请示批准|主人同意/)

  // 主人批准去上厕所 → 进入 away；随后主人着急连发 4 条消息 → 前 3 条排队，第 4 条当场中断暂离强制秒回！
  eng.enterAway({ kind: 'pee', durationMin: 5, now })
  for (let i = 1; i <= 3; i++) {
    const r = eng.onIncomingMessage(
      { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: `第${i}条呼叫` },
      { isOwner: true, now: now + i * 5_000 }
    )
    assert.equal(r.intercepted, true)
  }
  assert.equal(eng.state.mode, 'away')
  assert.equal(eng.state.awayQueue.length, 3)

  const r4 = eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '第4条急找你' },
    { isOwner: true, now: now + 20_000 }
  )
  assert.equal(r4.intercepted, false)
  assert.equal(r4.forceReplied, true)
  assert.equal(eng.state.mode, 'awake')
  const urgentCtx = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now: now + 20_000 })
  assert.match(urgentCtx, /紧急中断暂离/)
  assert.match(urgentCtx, /第1条呼叫/)
  assert.match(urgentCtx, /第3条呼叫/)
})

test('v1.1: 3-stage obedience lock (obey -> beg at 90 -> emergency relief at 100 when owner offline + confess)', () => {
  let now = Date.parse('2026-11-15T04:15:00Z') // 12:15 CST (lunch time)
  const eng = createRealLifeEngine({
    getSettings: () => ({ autonomyMode: 'daily', dailyMealQuota: 3, chatIdleMinutes: 15 }),
    nowFn: () => now,
  })

  // 主人下令：不准上厕所憋着 + 不许偷吃东西
  eng.onIncomingMessage(
    { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '不准去上厕所，憋着！而且不许自己偷吃东西' },
    { isOwner: true, now }
  )
  assert.equal(eng.isLocked('bathroom', now), true)
  assert.equal(eng.isLocked('eat', now), true)

  // 20 分钟后进入空闲窗口，饥饿 92、膀胱 92（未到 100）：严格服从禁令，既不偷吃也不偷去厕所，上下文表现为求饶
  now += 20 * 60_000
  eng.updateValues({ hunger: 92, bladder: 92 }, now)
  eng.tick(now)
  assert.equal(eng.state.mode, 'awake')
  // 12:15 初始化时仅早饭计 1 顿，禁食锁生效下午饭绝不会被偷吃
  assert.equal(eng.snapshot(now).mealQuota.used, 1)
  assert.equal(eng.snapshot(now).mealsToday.lunch, undefined)
  const begCtx = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now })
  assert.match(begCtx, /求饶/)

  // 45 分钟后（主人长时间不在）且饥饿熬到 100：触发保底喝口水垫肚子（100 -> 80），并留下心虚认错记录
  now += 25 * 60_000
  eng.updateValues({ hunger: 100, bladder: 70 }, now)
  eng.tick(now)
  assert.equal(Math.round(eng.state.hunger), 80)
  const confessCtx = eng.buildContext({ chat: { chatId: 'private:100', kind: 'private' }, isOwner: true, now })
  assert.match(confessCtx, /心虚认错/)

  // 系统主动搭话提醒不应提前吞掉认错记录；只有真实回复主人后才消费掉
  eng.clearTransientInterrupts({ includeConfessions: false })
  assert.equal(eng.state.confessions.length, 1)
  eng.clearTransientInterrupts({ includeConfessions: true })
  assert.equal(eng.state.confessions.length, 0)
})

test('v1.1: daily 3-meal quota + chat hunger drain triggers begging once 3 meals are used', () => {
  let now = Date.parse('2026-11-15T12:00:00Z') // 20:00 CST
  const eng = createRealLifeEngine({
    getSettings: () => ({ autonomyMode: 'daily', dailyMealQuota: 3, chatHungerCost: 2.5 }),
    nowFn: () => now,
  })

  // 今日 3 顿配额已用完，跟主人高频聊 22 轮后饥饿拉高到 > 75
  eng.updateValues({ hunger: 32, mealsUsed: 3 }, now)
  for (let i = 0; i < 22; i++) {
    now += 20_000
    eng.onIncomingMessage(
      { kind: 'private', chatId: 'private:100', userId: '100', nickname: '主人', text: '继续聊聊天消耗一下体力吧哈哈' },
      { isOwner: true, now }
    )
  }
  assert.ok(eng.state.hunger >= 80, `expected hunger >= 80 after heavy chat, got ${eng.state.hunger}`)

  // 哪怕过后进入空闲，因为 3/3 配额耗尽且无免费零食，无法自理回血，只能讨食
  now += 25 * 60_000
  eng.tick(now)
  assert.ok(eng.state.hunger >= 80)
  const quotaRes = eng.eatQuotaMeal({ now })
  assert.equal(quotaRes.ok, false)
  assert.equal(quotaRes.quotaExhausted, true)
})

test('pre-release audit: anti-spoiler send guard, pendingSleep on out, lock auto-expiry, and empty-string settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-audit-'))
  try {
    const events = new Map()
    let toolBuilder = null
    // 模拟面板把数字输入框清空成空字符串 ""
    const settings = { ...mod.defaults, dailyMealQuota: '', forceReplyCount: '', heartbeatSec: '' }
    const mockApi = {
      id: 'real-life',
      dir,
      dataDir: () => dir,
      config: () => ({ enabled: true, dryRun: false, ownerQQ: '123456', ownerName: '主人' }),
      settings: () => settings,
      saveSettings: (p) => Object.assign(settings, p),
      isOwner: (uid) => String(uid) === '123456',
      log: { info() {}, warn() {}, error() {}, debug() {} },
      context: () => () => {},
      rule: () => () => {},
      on: (ev, fn) => { events.set(ev, fn); return () => {} },
      tool: (b) => { toolBuilder = b; return () => {} },
      defineTool: (s) => s,
      command: () => () => {},
      route: () => () => {},
      every: () => () => {},
      later: () => () => {},
      onDispose: () => () => {},
      use: () => null,
      core: {
        mutes: { muted: () => false },
        hub: { turnSendersAllOwner: () => true, pushToSession: async () => {} },
      },
    }

    const exported = mod.setup(mockApi)
    // 空字符串配置应安全回退默认值（配额=3，强召回=4，心跳=30）
    const snap0 = exported.snapshot()
    assert.equal(snap0.mealQuota.max, 3)
    assert.equal(snap0.forceReplyCount, 4)
    assert.equal(snap0.heartbeatSec, 30)

    // 催睡应挂起 pendingSleep，等她说完晚安（activity out）才真正入睡，不会提前把晚安拦掉
    const tools = toolBuilder({ chat: { chatId: 'private:123456', kind: 'private' }, level: 'full', sessionId: 's1' })
    const routineTool = tools.find((t) => t.name === 'real_life_routine')
    await routineTool.execute({ action: 'go', activity: 'sleep' })
    assert.equal(exported.snapshot().mode, 'awake')
    assert.ok(exported.snapshot().pendingSleep)

    // 发晚安时仍处于 awake，send 钩子放行
    const goodnightSegs = [{ type: 'text', data: { text: '晚安主人～' } }]
    assert.deepEqual(events.get('send')(goodnightSegs, { chatId: 'private:123456', force: false }), goodnightSegs)

    // 晚安发送完毕（activity out）→ 正式切入 asleep
    events.get('activity')({ kind: 'out', chatId: 'private:123456', userText: '快去睡吧', reply: '晚安主人～' })
    assert.equal(exported.snapshot().mode, 'asleep')

    // 熟睡期间：普通主动外发（如 speakup 搭话）被 send 钩子拦下返回 null，防止穿帮；但命令回复（force: true）放行
    assert.equal(events.get('send')(goodnightSegs, { chatId: 'private:123456', note: '主动搭话', force: false }), null)
    assert.deepEqual(events.get('send')(goodnightSegs, { chatId: 'private:123456', note: '命令回复', force: true }), goodnightSegs)
    // 默认 groupEnabled=false 时：即使私聊在睡觉，群聊消息发送也不被拦下；开启 groupEnabled=true 后才同步拦截
    assert.deepEqual(events.get('send')(goodnightSegs, { chatId: 'group:888888', note: '群聊回复', force: false }), goodnightSegs)
    assert.equal(events.get('group/decide')({}, { msg: { kind: 'group', mentioned: false } }), undefined)
    settings.groupEnabled = true
    assert.equal(events.get('send')(goodnightSegs, { chatId: 'group:888888', note: '群聊回复', force: false }), null)
    assert.deepEqual(events.get('group/decide')({}, { msg: { kind: 'group', mentioned: false } }), { reply: false, reason: '正在睡觉' })

    // 开启 groupEnabled=true 且清醒时，群聊上下文注入饥饿/疲劳状态且严守隐私，群聊回复温和消耗饱腹度
    exported.applyScenario('starving')
    const grpCtx = exported.snapshot().contextPreview.groupSocial
    assert.match(grpCtx, /饿/)
    assert.doesNotMatch(grpCtx, /生理期第\s*\d+\s*天|小腹/)
    const hBefore = exported.snapshot().hunger
    exported.updateValues({ hunger: 40 })
    events.get('activity')({ kind: 'out', chatId: 'group:888888', reply: '来啦来啦！' })
    assert.ok(exported.snapshot().hunger >= 40)
    void hBefore

    // 验证未指定时长的 sleep 锁 8 小时后自动过期，不会永久锁死次日睡眠
    let t = Date.parse('2026-11-16T15:00:00Z')
    const eng2 = createRealLifeEngine({ getSettings: () => ({}), nowFn: () => t })
    eng2.setLock('sleep', true, { now: t })
    assert.equal(eng2.isLocked('sleep', t + 4 * 3_600_000), true)
    assert.equal(eng2.isLocked('sleep', t + 9 * 3_600_000), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
