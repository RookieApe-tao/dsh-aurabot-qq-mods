// room3d 自测：node --test test/room3d.test.mjs
//
// 不联网：下载用假的 fetchZip 替身（__roomTestHooks.fetchZip），素材包用测试里现造的最小 zip
// （存储法 + UTF-8 名字， CRC32 真算）。退出码由 node --test 判定。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const MOD = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import('./../index.js')
const meta = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))

// ---------- 最小 zip 造法（单个存储法条目） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
/**
 * entries: [{ name, data:Buffer, mode?:number }] → zip Buffer（全存储法，条目带 UTF-8 名字标志）
 * mode 写进目录项的 externalAttr 高 16 位（Unix st_mode），用来造符号链接条目（0o120000）。
 */
function buildZip(entries) {
  const parts = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(String(e.name), 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || Buffer.alloc(0))
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6) // UTF-8 名字标志
    lfh.writeUInt16LE(0, 8) // 存储法
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(name.length, 26)
    parts.push(lfh, name, data)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(20, 4)
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(0x0800, 8)
    cdh.writeUInt16LE(0, 10)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(data.length, 20)
    cdh.writeUInt32LE(data.length, 24)
    cdh.writeUInt16LE(name.length, 28)
    // externalAttr（偏移 38）高 16 位 = Unix st_mode：普通文件 0o100644 / 符号链接 0o120000
    const mode = Number.isInteger(e.mode) ? e.mode : 0o100644
    cdh.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38)
    cdh.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([cdh, name]))
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, eocd])
}

// ---------- 假 api ----------
function makeApi({ settings = {}, hooks } = {}) {
  const events = {}
  const routes = {}
  const logs = []
  const toolFactories = []
  const dataDir = mkdtempSync(join(tmpdir(), 'room3d-test-'))
  const api = {
    id: 'room3d',
    dir: MOD,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    settings: () => settings,
    log: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m), error: () => {} },
    on: (e, f) => { (events[e] ||= []).push(f); return () => {} },
    rule: () => () => {},
    tool: (f) => { toolFactories.push(f); return () => {} },
    defineTool: (t) => t,
    route: (p, h) => { routes[p] = h; return () => {} },
    every: () => () => {},
    onDispose: () => () => {},
    use: () => null,
    has: () => false,
    core: { http: { body: async () => ({}), send: () => {} }, hub: {} },
    __roomTestHooks: hooks,
  }
  /** 取注册出来的工具清单（模拟插件按会话现算的那一步） */
  const toolsOf = (ctx = { chat: { kind: 'group' }, sessionId: 's1' }) => toolFactories.flatMap((f) => f(ctx) || [])
  return { api, events, routes, logs, dataDir, toolsOf }
}

test('元数据一致：id/version/api 与 module.json 相同', () => {
  assert.equal(mod.default.id, meta.id)
  assert.equal(mod.default.version, meta.version)
  assert.equal(mod.default.api, meta.api)
})

test('setup 注册关键路由与设置项', () => {
  const { api, routes } = makeApi({ hooks: { skipAutoAssets: true } })
  mod.default.setup(api)
  for (const p of ['/page', '/health', '/situation', '/perception', '/api/room/state', '/api/room/anims', '/api/room/fetch-assets', '/api/room/furniture']) {
    assert.ok(routes[p], `缺路由 ${p}`)
  }
  const keys = mod.default.settings.map((s) => s.key)
  for (const k of ['perception', 'roomAssetUrl']) assert.ok(keys.includes(k), `缺设置 ${k}`)
  // adminPin 已移除：前端密码只挡按钮、服务端 /api/room/* 无校验，属无实际保护的机制
  assert.ok(!keys.includes('adminPin'), 'adminPin 设置项应已移除')
})

test('health：没素材时 ready=false', async () => {
  const { api, routes } = makeApi({ hooks: { skipAutoAssets: true } })
  mod.default.setup(api)
  const h = await routes['/health']()
  assert.equal(h.ok, true)
  assert.equal(h.assets.ready, false)
})

test('下载落位：假 fetchZip → assets 目录有视频，anims 列表可见', async () => {
  const zip = buildZip([
    { name: 'room3d-assets/写代码.webm', data: Buffer.from('fake-webm') },
    { name: 'room3d-assets/走路.webm', data: Buffer.from('fake-walk') },
  ])
  const { api, routes, dataDir } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => ({ ok: true, headers: { get: () => String(zip.length) }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) }) },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.ok(existsSync(join(dataDir, 'assets', '写代码.webm')))
  const a = await routes['/api/room/anims']()
  assert.equal(a.ok, true)
  assert.deepEqual(a.anims, ['写代码']) // 走路 被过滤，.webm 后缀剥掉
  const h = await routes['/health']()
  assert.equal(h.assets.ready, true)
  assert.equal(h.assets.count, 2)
})

test('Windows 风格 zip（反斜杠路径）也能正确落位到 assets/，页面按名字能取到', async () => {
  const zip = buildZip([
    { name: 'room3d-assets\\待机呼吸休闲.webm', data: Buffer.from('fake-idle') },
    { name: 'room3d-assets\\螃蟹走路.webm', data: Buffer.from('fake-walk') },
  ])
  const { api, routes, dataDir } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => zipRes(zip) },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  // 关键：文件名里不能残留反斜杠，否则页面请求 /assets/待机呼吸休闲.webm 会 404，只剩影子
  assert.ok(existsSync(join(dataDir, 'assets', '待机呼吸休闲.webm')))
  assert.ok(existsSync(join(dataDir, 'assets', '螃蟹走路.webm')))
  assert.ok(!readdirSync(join(dataDir, 'assets')).some((n) => n.includes('\\')), '不能留下带反斜杠的文件名')
  assert.ok(routes['/assets/待机呼吸休闲.webm'], '页面请求的素材路由已按正常文件名注册')
  const h = await routes['/health']()
  assert.equal(h.assets.ready, true)
})

test('旧版错误落位的反斜杠素材名在启动时自动修正，不用重新下载', async () => {
  const { api, routes, dataDir } = makeApi({ hooks: { skipAutoAssets: true } })
  mkdirSync(join(dataDir, 'assets'), { recursive: true })
  writeFileSync(join(dataDir, 'assets', 'room3d-assets\\待机呼吸休闲.webm'), 'old-idle')
  mod.default.setup(api)
  assert.ok(existsSync(join(dataDir, 'assets', '待机呼吸休闲.webm')), '启动时应把旧文件名改正')
  assert.ok(!readdirSync(join(dataDir, 'assets')).some((n) => n.includes('\\')))
  assert.ok(routes['/assets/待机呼吸休闲.webm'], '修正后素材路由要跟着注册')
})

test('下载失败时 /health 暴露 lastError 和镜像/重试提示', async () => {
  const { api, routes } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => { throw new Error('模拟网络失败') } },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, false)
  assert.match(String(r.message), /素材包下载失败.*模拟网络失败/)
  const h = await routes['/health']()
  assert.equal(h.assets.ready, false)
  assert.match(String(h.assets.lastError), /模拟网络失败/)
  assert.match(String(h.assets.hint), /镜像|重新下载/)
})

test('面板提供素材状态与重新下载按钮，页面有素材加载失败提示', () => {
  const panel = readFileSync(join(MOD, 'panel.js'), 'utf8')
  assert.match(panel, /health/)
  assert.match(panel, /fetch-assets/)
  assert.match(panel, /重新下载素材/)
  const page = readFileSync(join(MOD, 'lib', 'index3d.html'), 'utf8')
  assert.match(page, /assetWarn/)
  assert.match(page, /addEventListener\('error'/)
  assert.match(page, /动作素材加载失败/)
})

test('明文 http 下载地址被拒绝', async () => {
  const { api, routes, logs } = makeApi({
    settings: { roomAssetUrl: 'http://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, false)
  assert.ok(String(r.message).includes('明文 http'))
})

test('prompt 注入：把位置事实加在用户消息最前，问到房间时附完整画面', async () => {
  const { api, events } = makeApi({ hooks: { skipAutoAssets: true } })
  mod.default.setup(api)
  const handler = events.prompt[0]
  const out = await handler([{ type: 'text', text: '早' }], { chat: {}, queryText: '你在哪？窗外什么样？' })
  assert.equal(out[0].type, 'text')
  assert.ok(out[0].text.startsWith('【你在自己家里，一个 3D 小房间】'))
  assert.ok(out[0].text.includes('光线'), '问到房间词要附完整画面')
  assert.equal(out[1].text, '早')
  const out2 = await handler([{ type: 'text', text: '早' }], { chat: {}, queryText: '吃饭了吗' })
  assert.ok(!out2[0].text.includes('光线'), '没问到就只给位置事实')
})

test('page：原样返回页面，不再注入任何密码占位符', async () => {
  // 从前这里会校验「设置里的 adminPin 被填进页面」。那套前端密码已移除：
  // 它只挡按钮，服务端 /api/room/* 的写接口没有任何校验，留着只会误导人。
  const { api, routes } = makeApi({ settings: {}, hooks: { skipAutoAssets: true } })
  mod.default.setup(api)
  let sent = null
  const res = {}
  api.core.http.send = (_res, code, body) => { sent = { code, body: String(body) } }
  await routes['/page']({}, res)
  assert.equal(sent.code, 200)
  assert.ok(!sent.body.includes('__ROOM_ADMIN_PIN__'), '不应再有占位符')
  // 注释里会提到 ADMIN_PIN 作为历史说明，所以只查代码特征，不查裸字符串
  assert.ok(!/const\s+ADMIN_PIN\s*=/.test(sent.body), '页面里不应再有 ADMIN_PIN 常量声明')
  assert.ok(!sent.body.includes('pin-input'), '页面里不应再有密码输入框')
  assert.ok(!/function\s+adminModal/.test(sent.body), '页面里不应再有密码弹窗')
  assert.ok(!/sessionStorage\.setItem\(\s*'room_admin'/.test(sent.body), '页面里不应再写解锁状态')
})

// ---------- 素材包解压的安全契约（zip-slip / 符号链接 / 明文 http） ----------
const zipRes = (zip) => ({ ok: true, headers: { get: () => String(zip.length) }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) })

test('解压安全：zip-slip 路径被拒绝，且不落盘到 dataDir 之外', async () => {
  const zip = buildZip([
    { name: 'room3d-assets/正常.webm', data: Buffer.from('ok') },
    { name: '../escape.webm', data: Buffer.from('evil') },
  ])
  const { api, routes, dataDir } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => zipRes(zip) },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, false)
  assert.ok(String(r.message).includes('可疑路径'), `应报可疑路径，实际：${r.message}`)
  assert.ok(!existsSync(join(dataDir, '..', 'escape.webm')), '不能写到暂存目录之外')
  assert.ok(!existsSync(join(dataDir, 'assets', '正常.webm')), '解压失败不落位')
})

test('解压安全：符号链接条目被跳过（按 externalAttr 的 Unix 类型位判断）', async () => {
  const zip = buildZip([
    { name: 'room3d-assets/写代码.webm', data: Buffer.from('fake-webm') },
    { name: 'room3d-assets/链接.webm', data: Buffer.from('/etc/passwd'), mode: 0o120777 },
  ])
  const { api, routes, dataDir } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => zipRes(zip) },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1, '只落位真文件，符号链接条目不算')
  assert.ok(existsSync(join(dataDir, 'assets', '写代码.webm')))
  assert.ok(!existsSync(join(dataDir, 'assets', '链接.webm')))
})

test('明文 http 只放行本机回环（本地镜像可下）', async () => {
  const zip = buildZip([{ name: 'room3d-assets/写代码.webm', data: Buffer.from('fake-webm') }])
  const { api, routes } = makeApi({
    settings: { roomAssetUrl: 'http://127.0.0.1:8080/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => zipRes(zip) },
  })
  mod.default.setup(api)
  const r = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
})

test('素材已就位时手动重下仍会重下一次（force 语义），但落位结果去重不翻倍', async () => {
  const zip = buildZip([{ name: 'room3d-assets/写代码.webm', data: Buffer.from('fake-webm') }])
  let fetches = 0
  const { api, routes, dataDir } = makeApi({
    settings: { roomAssetUrl: 'https://example.com/room3d-assets.zip' },
    hooks: { skipAutoAssets: true, fetchZip: async () => { fetches++; return zipRes(zip) } },
  })
  mod.default.setup(api)
  await routes['/api/room/fetch-assets']({ method: 'POST' })
  const second = await routes['/api/room/fetch-assets']({ method: 'POST' })
  assert.equal(fetches, 2, '面板「重新下载」要真的重下')
  assert.equal(second.count, 1)
  assert.equal(readdirSync(join(dataDir, 'assets')).filter((n) => n.endsWith('.webm')).length, 1, '同名素材覆盖而非累加')
})

test('perception 关掉后 prompt 注入不出现，但两个工具照旧注册', async () => {
  const { api, events, toolsOf } = makeApi({ settings: { perception: false }, hooks: { skipAutoAssets: true } })
  mod.default.setup(api)
  const out = await events.prompt[0]([{ type: 'text', text: '早' }], { chat: {}, queryText: '你在哪' })
  assert.deepEqual(out, [{ type: 'text', text: '早' }], '关掉后原样返回，不加 token')
  const names = toolsOf().map((t) => t.name)
  assert.deepEqual(names, ['look_at_room', 'go_room_spot'], '关掉感知不影响工具')
})

test('工具：系统会话不给工具；go_room_spot 非主人调用被拒，主人调用真的换位置', async () => {
  const { api, toolsOf, dataDir } = makeApi({ hooks: { skipAutoAssets: true } })
  let owner = false
  api.core.hub.turnSendersAllOwner = () => owner
  mod.default.setup(api)
  assert.deepEqual(toolsOf({ chat: { kind: 'system' }, sessionId: 's1' }), [], '系统会话不给工具')
  const tools = Object.fromEntries(toolsOf().map((t) => [t.name, t]))
  assert.ok(tools.look_at_room && tools.go_room_spot)
  const denied = await tools.go_room_spot.execute({ spot: 'balcony' })
  assert.equal(denied.ok, false)
  assert.ok(String(denied.message).includes('只有主人'))
  owner = true
  const moved = await tools.go_room_spot.execute({ spot: 'balcony' })
  assert.equal(moved.ok, true)
  const state = JSON.parse(readFileSync(join(dataDir, 'room-state.json'), 'utf8'))
  assert.equal(state.xiaoyu.spot, 'balcony')
  const empty = await tools.go_room_spot.execute({ spot: '  ' })
  assert.equal(empty.ok, false, '空 spot 不写盘')
})

test('猫咪起名使用页面内输入框，不依赖 window.prompt', () => {
  const page = readFileSync(join(MOD, 'lib', 'index3d.html'), 'utf8')
  assert.match(page, /function askCatName/)
  assert.match(page, /cat-name-input/)
  assert.ok(!/\bprompt\s*\(/.test(page.replace(/^\s*\/\/.*$/gm, '')), '页面不能再调用 window.prompt')
})
