// routing.test.mjs —— 触发路由测试：定时器/面板 → 共享决策窗（mode self）；
// 跨模块 → 独立决策窗（mode delegate，task-*），动作仍由模块执行、每一动过 safety.gate。
// 方案 A（复审后定）：不再 spawn 子智能体，所以这里断言「即使宿主提供 runSubagentTurn 也不调用」。
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
function fakeApi({ hub = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-route-'))
  const rec = {
    dir,
    thinkCalls: [], // { key, title, prompt }
    subagentCalls: [], // 方案 A 下应始终为空
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
    sessionTimeoutMs: 60000,
    writeEventMemory: true,
    decisionModel: '',
    autoBrowse: false,
    intervalHours: 4,
    maxRunsPerDay: 3,
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
    // 工作区决策（self / delegate 都落到这里）；一步 finish
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

test('跨模块 run()：落独立决策窗（task-*），不 spawn 子智能体，动作仍由模块执行', async () => {
  const { api, rec } = fakeApi({
    // 即使宿主提供委派能力，方案 A 也不该用它
    hub: { runSubagentTurn: async () => { rec.subagentCalls.push({}); return '子智能体结果' } },
  })
  const mod = phone.setup(api)
  const r = await mod.run({ goal: '打开抖音刷会儿' })
  assert.equal(rec.subagentCalls.length, 0, '方案 A：不再 spawn 子智能体')
  assert.ok(rec.thinkCalls.length >= 1, '决策走模块内循环（api.think）')
  assert.ok(/^task-/.test(rec.thinkCalls[0].key), `跨模块调用应落独立任务窗（实际 key=${rec.thinkCalls[0].key}）`)
  assert.equal(r.ok, true)
  assert.equal(mod.session.status().owner, null, '跑完应释放会话锁')
  rmSync(rec.dir, { recursive: true, force: true })
})

test('面板 /run（对话测试）→ 共享决策窗（key=decision），不走独立任务窗', async () => {
  const { api, rec } = fakeApi()
  phone.setup(api)
  const res = await rec.routes.get('/run')({ method: 'POST', url: 'http://x/run', __body: { goal: '帮我签到' } })
  assert.equal(res.ok, true, '面板下发应立即受理')
  assert.ok(await waitFor(() => rec.thinkCalls.length >= 1), '面板触发的决策应走工作区（api.think）')
  assert.equal(rec.subagentCalls.length, 0)
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

test('定时器 sweep（cron 流程）→ 共享决策窗（key=decision），不走独立任务窗', async () => {
  const { api, rec } = fakeApi()
  const mod = phone.setup(api)
  mod.flows.upsert('cronflow', { name: '定时流程', prompt: '定时任务', cron: '* * * * *', enabled: true })
  rec.sweep() // 手动触发一次 30s 清扫回调
  assert.ok(await waitFor(() => rec.thinkCalls.length >= 1), 'cron 触发的决策应走工作区（api.think）')
  assert.equal(rec.subagentCalls.length, 0)
  assert.equal(rec.thinkCalls[0].key, 'decision', `定时决策应落共享会话窗（实际 key=${rec.thinkCalls[0].key}）`)
  assert.ok(await waitFor(() => mod.session.status().owner === null), '跑完应释放会话锁')
  rmSync(rec.dir, { recursive: true, force: true })
})
