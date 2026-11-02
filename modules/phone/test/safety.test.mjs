/**
 * safety.test.mjs —— safety 闸门 + session 会话锁测试
 * safety：临时目录（fs.mkdtemp）—— 白名单拒绝、限速等待后放行、写操作 NEED_CONFIRM→
 *         approveConfirm 后放行、dryRun→DRY_RUN、日志落盘。
 * session：锁互斥（后来者排队）与超时强断（注入短 sweepMs/timeoutMs + onSweep 回调，秒级完成）。
 * 绝不真调 adb / 真下载 / 真网络。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSafety } from '../lib/safety.mjs'
import { createSession } from '../lib/session.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建临时数据目录，测试结束删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-safety-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('白名单：空 = 不限制；不在名单 → REJECT', async (t) => {
  const dir = tempDir(t)
  let settings = { whitelist: ['tv.danmaku.bili'], rateLimit: 0, confirmWrites: false, dryRun: false }
  const s = createSafety({ dataDir: dir, getSettings: () => settings })
  assert.deepEqual(s.checkPackage('tv.danmaku.bili'), { ok: true })
  assert.equal(s.checkPackage('com.other').ok, false)
  // gate 路径：不在白名单 → REJECT
  assert.equal(await s.gate({ pkg: 'com.other', nodeText: '随便点' }), 'REJECT')
  // 白名单清空 → 不限制
  settings = { ...settings, whitelist: [] }
  assert.deepEqual(s.checkPackage('com.anything'), { ok: true })
})

test('限速：rateLimit=2，第三次触发等待后放行（DELAY）', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 2, confirmWrites: false, dryRun: false }),
    windowMs: 150, // 窗口调短，测试秒级完成
  })
  assert.equal(await s.checkRate(), 'ALLOW')
  assert.equal(await s.checkRate(), 'ALLOW')
  const r = await s.checkRate() // 第三次：等窗口腾出再放行
  assert.equal(r, 'DELAY')
})

test('写操作：NEED_CONFIRM 落盘 → approveConfirm 后 gate 放行', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 0, confirmWrites: true, dryRun: false }),
  })
  assert.equal(s.isWriteAction('点赞这个视频'), true)
  assert.equal(s.isWriteAction('刷新页面'), false)
  // 写操作首次 → NEED_CONFIRM，confirm/ 目录多一个 json
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '发布' }), 'NEED_CONFIRM')
  const items = s.listConfirms()
  assert.equal(items.length, 1)
  assert.equal(items[0].pkg, 'com.a')
  assert.equal(items[0].nodeText, '发布')
  assert.ok(items[0].id)
  // 批准后：文件删除，再次 gate 同动作 → ALLOW
  assert.equal(s.approveConfirm(items[0].id), true)
  assert.deepEqual(s.listConfirms(), [])
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '发布' }), 'ALLOW')
  // 拒绝路径：rejectConfirm 只删文件，动作仍是 NEED_CONFIRM
  assert.equal(await s.gate({ pkg: 'com.b', nodeText: '删除' }), 'NEED_CONFIRM')
  const it2 = s.listConfirms()[0]
  assert.equal(s.rejectConfirm(it2.id), true)
  assert.equal(await s.gate({ pkg: 'com.b', nodeText: '删除' }), 'NEED_CONFIRM')
})

test('dryRun：只出计划，返回 DRY_RUN 不落确认', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 0, confirmWrites: true, dryRun: true }),
  })
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '发送消息' }), 'DRY_RUN')
  assert.deepEqual(s.listConfirms(), []) // dryRun 不堆积确认项
})

test('盲点+填了无害文字：照样 NEED_CONFIRM（复审残留 P0-2，不许靠 act.text 绕确认）', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 0, confirmWrites: true, dryRun: false }),
  })
  // 坐标点击（blind=true）即使模型给动作填了「刷新」这种浏览类文字，也必须弹确认
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '刷新', blind: true }), 'NEED_CONFIRM')
  assert.equal(s.listConfirms().length, 1)
  // 盲点不带文字同样弹确认（原行为保持）
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '', blind: true }), 'NEED_CONFIRM')
  // 非盲点浏览类仍放行
  assert.equal(await s.gate({ pkg: 'com.a', nodeText: '刷新' }), 'ALLOW')
})

test('确认项 id 越界：approve/reject 直接拒绝，不删任何文件（复审残留 P0-1）', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 0, confirmWrites: true, dryRun: false }),
  })
  await s.gate({ pkg: 'com.a', nodeText: '发布' })
  const before = s.listConfirms().length
  // `../../x` 越界 id：不能删 confirm 目录外的任何 .json
  assert.equal(s.rejectConfirm('../../victim'), false)
  assert.equal(s.approveConfirm('../../victim'), false)
  assert.equal(s.rejectConfirm('..\\victim'), false)
  assert.equal(s.rejectConfirm('a'.repeat(41)), false, '超长 id 也拒')
  assert.equal(s.listConfirms().length, before, '合法确认项不受影响')
  // 越界时也不能在目录外留下批准记录
  assert.equal(existsSync(join(dir, 'victim.json')), false)
})

test('rate.json 不出现在待确认列表（P1-3 回归）', async (t) => {
  const dir = tempDir(t)
  const s = createSafety({
    dataDir: dir,
    getSettings: () => ({ whitelist: [], rateLimit: 5, confirmWrites: true, dryRun: false }),
  })
  await s.checkRate() // 会在 dataDir 根写 rate.json
  await s.gate({ pkg: 'com.a', nodeText: '发布' })
  const items = s.listConfirms()
  assert.equal(items.length, 1, '只应有那一条写确认')
  assert.ok(!items.some((x) => String(x.id || '').startsWith('_')), '不混入元数据文件')
  assert.ok(existsSync(join(dir, 'rate.json')), 'rate.json 在 dataDir 根')
  assert.equal(existsSync(join(dir, 'confirm', 'rate.json')), false)
})

test('操作日志按天落盘 ops-YYYY-MM-DD.log', async (t) => {  const dir = tempDir(t)
  const s = createSafety({ dataDir: dir, getSettings: () => ({}) })
  s.log('tap', '节点[0] 按钮"发布"')
  s.log('gate', 'REJECT com.other')
  const p = join(dir, 'logs')
  const files = readdirSync(p)
  assert.equal(files.length, 1)
  assert.match(files[0], /^ops-\d{4}-\d{2}-\d{2}\.log$/)
  const content = readFileSync(join(p, files[0]), 'utf8')
  assert.ok(content.includes('tap'))
  assert.ok(content.includes('发布'))
})

test('session：互斥——占用期间后来者排队，释放后授予', async (t) => {
  const s = createSession({ timeoutMs: 900000 })
  const first = await s.acquire('flow-a')
  assert.deepEqual(first, { ok: true, queued: false })
  assert.deepEqual(s.status(), { owner: 'flow-a', queued: 0, since: first.since ?? s.status().since })
  // 后来者：await 排队，不立即授予
  let granted = null
  const p = s.acquire('flow-b').then((r) => (granted = r))
  await sleep(30)
  assert.equal(granted, null)
  assert.equal(s.status().queued, 1)
  // release 校验 owner：错名字不放
  assert.equal(s.release('wrong'), false)
  assert.equal(s.release('flow-a'), true)
  const second = await p
  assert.deepEqual(second, { ok: true, queued: true })
  assert.equal(s.status().owner, 'flow-b')
  // heartbeat 刷新活跃时间；再释放归零
  s.heartbeat('flow-b')
  s.release('flow-b')
  assert.deepEqual(s.status(), { owner: null, queued: 0, since: 0 })
})

test('session：超时强断——空闲超过 timeoutMs 后台清扫强制释放', async (t) => {
  const swept = []
  const s = createSession({
    timeoutMs: 120,
    sweepMs: 40,
    onSweep: (info) => swept.push(info),
  })
  await s.acquire('flow-zombie')
  assert.equal(s.status().owner, 'flow-zombie')
  // 期间 heartbeat 保活一次，然后彻底沉默 → 等待强断（总耗时 < 1s）
  await sleep(60)
  s.heartbeat('flow-zombie')
  await sleep(300)
  assert.equal(s.status().owner, null) // 已被强制释放
  assert.equal(swept.length, 1)
  assert.equal(swept[0].owner, 'flow-zombie')
  assert.equal(swept[0].action, 'force-release')
  s.dispose() // 停定时器
})

test('session：dispose 停清扫并结清排队者', async (t) => {
  const s = createSession({ timeoutMs: 900000 })
  await s.acquire('a')
  let granted = null
  const p = s.acquire('b').then((r) => (granted = r))
  s.dispose()
  const r = await p
  assert.deepEqual(r, { ok: false }) // 排队者按未授予结清，不悬挂
  assert.equal(granted.ok, false)
})

// CI 回归：限速等待曾把 setTimeout unref 掉。调用方在 await 那个 promise，unref 后事件循环可能先空掉，
// Linux 上 node --test 直接判 cancelledByParent（Promise resolution is still pending but the event loop
// has already resolved），还会把同文件后续测试一起取消。这条钉死源码不再出现 unref。
test('限速等待的计时器不能 unref（CI cancelledByParent 回归）', () => {
  const src = readFileSync(new URL('../lib/safety.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\.unref/, 'safety.mjs 里不要出现 .unref 调用：等待窗口的 timer 必须留在事件循环里')
})
