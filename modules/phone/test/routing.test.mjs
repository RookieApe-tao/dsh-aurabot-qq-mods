// routing.test.mjs —— 触发路由测试：定时器/面板 → 工作区会话窗（mode self）；跨模块 → 子智能体委派（delegate，需显式开启）
// 运行：mods-fork 仓库根 `node --test modules/phone/test/routing.test.mjs`
// 全程 fake api + fake adb（api.__phoneTestHooks 注入，照 pet 模块钩子模式），不打真进程、不碰真手机。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import phone from '../index.mjs'

// 让决策器一步就 finish 的最小 uiautomator XML：一个可点「签到」按钮 + 一个不可点的文本
const DUMP_XML =
  '<hierarchy><node class="android.widget.Button" text="签到" clickable="true" bounds="[10,10][200,90]"/>' +
  '<node class="android.widget.TextView" text="hello" bounds="[0,100][1080,2340]"/></hierarchy>'

/** 组一个 fake api：每次全新（session/捕获互相隔离），返回 { api, 记录 } */
function fakeApi({ hub = {}, settings: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-route-'))
  const rec = {
    dir,
    thinkCalls: [], // { key, title, prompt }
    subagentCalls: [], // { name, title, mission, opts }
    sendTexts: [],
    routes: new Map(), // path → handler
    sweep: null, // api.every 捕获的定时回调
  }
  const settings = {
    enabled: true,
    adbPath: 'C:/fake/adb.exe',
    deviceSerial: 'TESTSERIAL',
    whitelist: 'com.a\ncom.b',
    maxSteps: 5,
    rateLimit: 30,
    confirmWrites: true,
    dryRun: false,
    closeAppsAfter: false, // 测试里不真的关应用
    delegateEnabled: false, // 一审 #19-3：委派默认关
    sessionTimeoutMs: 60000,
    writeEventMemory: true,
    decisionModel: '',
    autoBrowse: false,
    intervalHours: 4,
    maxRunsPerDay: 3,
    ...extra,
  }
  const fakeAdb = {
    currentPackage: async () => 'com.a',
    dumpNodes: async () => DUMP_XML,
    screenshot: async () => Buffer.from('png'),
    pressKey: async () => {},
    tap: async () => {},
    inputText: async () => {},
    clearText: async () => {},
    swipe: async () => {},
    key: async () => {},
    longPress: async () => {},
    launchApp: async () => {},
    forceStop: async () => {},
    devices: async () => ['TESTSERIAL'],
    adb: async () => '',
  }
  const api = {
    __phoneTestHooks: {
      ensureAdb: async () => ({ adbPath: 'C:/fake/adb.exe', installed: false, source: 'config' }),
      createAdb: () => fakeAdb,
    },
    dataDir: () => dir,
    settings: () => settings,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ask: async () => '合并后的经验正文',
    // 工作区决策（mode self / 降级 delegate 都落到这里）；一步 finish
    think: async (prompt, opts = {}) => {
      rec.thinkCalls.push({ key: opts.key, title: opts.title, prompt })
      return '{"action":"finish","ok":true,"summary":"做完了"}'
    },
    config: () => ({ ownerQQ: '' }),
    sendText: async (to, text) => rec.sendTexts.push({ to, text }),
    reply: async () => {},
    use: () => null,
    later: () => () => {}, // busyRace 的忙等计时：只捕获不真起
    every: (_ms, fn) => { rec.sweep = fn; return () => {} },
    on: () => () => {},
    onDispose: () => {},
    tool: () => {},
    defineTool: (t) => t,
    command: () => {},
    route: (path, handler) => { rec.routes.set(path, handler) },
    core: {
      getConfig: () => ({ ext: { phone: {} } }),
      setConfig: () => {},
      listModels: async () => [],
      http: { body: async (req) => req.__body || {} },
      hub,
    },
  }
  return { api, rec }
}

/** 轮询等待条件成立（默认 3 秒超时），避免测试挂死 */
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

test('跨模块 run()：显式打开 delegateEnabled 才委派子智能体；任务书只给受控动作器', async () => {
  const { api, rec } = fakeApi({
    settings: { delegateEnabled: true },
    hub: { runSubagentTurn: async (name, title, mission, opts) => {
      rec.subagentCalls.push({ name, title, mission, opts })
      return '完成（3 步）：都弄好了'
    } },
  })
  const mod = phone.setup(api)
  const r = await mod.run({ goal: '打开抖音刷会儿' })
  assert.equal(rec.subagentCalls.length, 1, '打开开关后应恰好调用一次子智能体委派')
  assert.equal(rec.subagentCalls[0].name, 'phone')
  assert.ok(rec.subagentCalls[0].mission.includes('打开抖音刷会儿'), '任务书应包含主人的任务')
  // 一审 #19-3：任务书不再给 adb 路径，只给受控动作器（白名单/限速/写确认在脚本里强制）
  assert.ok(rec.subagentCalls[0].mission.includes('phone-ctl.mjs'), '任务书应指向受控动作器')
  assert.ok(!rec.subagentCalls[0].mission.includes('C:/fake/adb.exe'), '不再把 adb 路径交给子级')
  assert.equal(rec.subagentCalls[0].opts.timeoutMs, 60000, '超时应来自面板设置')
  assert.equal(rec.subagentCalls[0].opts.moduleId, 'phone', '要带模块 id（主仓 #177 能力声明校验）')
  // ownerQQ 为空：没有主人来源，按后台任务处理（要 config.subagentBackground 才放行）
  assert.deepEqual(rec.subagentCalls[0].opts.source, { kind: 'system', reason: 'call' })
  assert.equal(rec.thinkCalls.length, 0, '委派模式不该占用工作区会话窗（api.think 不该被调）')
  assert.equal(r.ok, true)
  assert.ok(r.message.includes('子智能体'), '结果应标注来自子智能体')
  assert.ok(r.message.includes('3 步'))
  assert.equal(mod.session.status().owner, null, '跑完应释放会话锁')
  rmSync(rec.dir, { recursive: true, force: true })
})

test('委派默认关：跨模块 run() 走模块内循环（每一动过 safety 门），不碰子智能体', async () => {
  const { api, rec } = fakeApi({
    hub: { runSubagentTurn: async () => { rec.subagentCalls.push({}); return '完成（1 步）：x' } },
  })
  const mod = phone.setup(api)
  const r = await mod.run({ goal: '帮我签到' })
  assert.equal(rec.subagentCalls.length, 0, '默认不许委派')
  assert.ok(rec.thinkCalls.length >= 1, '默认走模块内循环（api.think 决策）')
  assert.equal(r.ok, true)
  rmSync(rec.dir, { recursive: true, force: true })
})

test('跨模块 run()：宿主没有委派服务（SUBAGENT_UNAVAILABLE）时降级回模块内循环', async () => {
  const { api, rec } = fakeApi({
    settings: { delegateEnabled: true },
    hub: { runSubagentTurn: async () => { const e = new Error('宿主没有 subagents 服务'); e.code = 'SUBAGENT_UNAVAILABLE'; throw e } },
  })
  const mod = phone.setup(api)
  const r = await mod.run({ goal: '帮我签到' })
  assert.ok(!r.message.includes('子智能体'), '降级后不应标注子智能体')
  assert.ok(rec.thinkCalls.length >= 1, '降级应走模块内循环（api.think 决策）')
  assert.ok(/^task-/.test(rec.thinkCalls[0].key), `降级决策应落独立任务窗（实际 key=${rec.thinkCalls[0].key}）`)
  assert.equal(r.ok, true)
  rmSync(rec.dir, { recursive: true, force: true })
})

test('权限拒绝（OWNER_REQUIRED）如实失败，不能偷偷降级成本地循环', async () => {
  const { api, rec } = fakeApi({
    settings: { delegateEnabled: true },
    hub: { runSubagentTurn: async () => { const e = new Error('子智能体委派要主人开口'); e.code = 'OWNER_REQUIRED'; throw e } },
  })
  const mod = phone.setup(api)
  await assert.rejects(mod.run({ goal: '帮我签到' }), /要主人开口/)
  assert.equal(rec.thinkCalls.length, 0, '被拒后不许再走本地循环')
  rmSync(rec.dir, { recursive: true, force: true })
})

test('面板 /run（对话测试）→ 工作区会话窗（key=decision），不走子智能体', async () => {
  const { api, rec } = fakeApi({
    hub: { runSubagentTurn: async () => { rec.subagentCalls.push({}); return '完成（1 步）：x' } },
  })
  phone.setup(api)
  const res = await rec.routes.get('/run')({ method: 'POST', url: 'http://x/run', __body: { goal: '帮我签到' } })
  assert.equal(res.ok, true, '面板下发应立即受理')
  // 等任务真的跑完（决策走 api.think，一步 finish）
  assert.ok(await waitFor(() => rec.thinkCalls.length >= 1), '面板触发的决策应走工作区（api.think）')
  assert.equal(rec.subagentCalls.length, 0, '面板触发不该走子智能体')
  assert.equal(rec.thinkCalls[0].key, 'decision', `面板决策应落共享会话窗（实际 key=${rec.thinkCalls[0].key}）`)
  assert.ok(rec.thinkCalls[0].title.includes('手机逛逛'))
  // /status 的 lastPanelRun 应回显结果
  assert.ok(await waitFor(async () => {
    const st = await rec.routes.get('/status')({ url: 'http://x/status' })
    return st.lastRun && st.lastRun.running === false
  }), '/status 应轮询到任务跑完')
  const st = await rec.routes.get('/status')({ url: 'http://x/status' })
  assert.equal(st.lastRun.ok, true)
  rmSync(rec.dir, { recursive: true, force: true })
})

test('定时器 sweep（cron 流程）→ 工作区会话窗（key=decision），不走子智能体', async () => {
  const { api, rec } = fakeApi({
    hub: { runSubagentTurn: async () => { rec.subagentCalls.push({}); return '完成（1 步）：x' } },
  })
  const mod = phone.setup(api)
  mod.flows.upsert('cronflow', { name: '定时流程', prompt: '定时任务', cron: '* * * * *', enabled: true })
  rec.sweep() // 手动触发一次 30s 清扫回调
  assert.ok(await waitFor(() => rec.thinkCalls.length >= 1), 'cron 触发的决策应走工作区（api.think）')
  assert.equal(rec.subagentCalls.length, 0, '定时器触发不该走子智能体')
  assert.equal(rec.thinkCalls[0].key, 'decision', `定时决策应落共享会话窗（实际 key=${rec.thinkCalls[0].key}）`)
  assert.ok(await waitFor(() => mod.session.status().owner === null), '跑完应释放会话锁')
  rmSync(rec.dir, { recursive: true, force: true })
})
