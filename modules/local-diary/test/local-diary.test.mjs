// 私人日记（local-diary）测试。
// 覆盖三块：日记落盘与同日编号、index/state 读写、面板路由与目录配置。
// 全部用最小的假 api 驱动 setup()，不连 QQ、不打网络，只写系统临时目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const DAY = dayKey()
const BODY = '今天在公园看锦鲤，红的一片挤过来。'

/** 建一个临时根目录，用例结束自动删。 */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-diary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 够 setup() 跑起来的假宿主；跑的其实就是真实代码路径。 */
function fakeApi(root, { think, preset } = {}) {
  const routes = {}
  const cfg = { ...mod.defaults, ...(preset || {}) }
  const api = {
    routes,
    cfg,
    posted: {},
    query: {},
    toolSelector: null,
    dataDir: () => join(root, 'data'),
    settings: () => cfg,
    log: { info() {}, warn() {}, error() {} },
    every: () => {},
    command: () => {},
    context: () => {},
    rule: () => {},
    tool: (fn) => { api.toolSelector = fn },
    defineTool: (tool) => tool,
    lazy: (name) => {
      if (name === 'memory') return { add() {}, timeline: () => [] }
      if (name === 'mood') return { label: () => '心情不错', contextLine: () => '（你现在心情不错…）' }
      return null
    },
    think: think || (async () => BODY),
    route: (path, handler) => { routes[path] = handler },
    core: {
      hub: {
        chatLogOf: () => [
          { t: Date.parse('2026-11-15T09:12:00'), chatId: 'private:1', who: 'user', text: '早' },
          { t: Date.parse('2026-11-15T09:13:00'), chatId: 'private:1', who: 'bot', text: '早呀' },
          { t: Date.parse('2026-11-15T12:00:00'), chatId: 'group:888', who: 'user', text: '在吗' },
        ],
      },
      http: {
        body: async () => api.posted,
        query: () => api.query,
      },
    },
  }
  return api
}

/** 起一份实例，返回 api 与模块自报的句柄。 */
function boot(root, opts) {
  const api = fakeApi(root, opts)
  const inst = mod.setup(api)
  return { api, inst }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

test('第一次写落一份 md，同一天再写往后编号，旧的不覆盖', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root)
  const dir = inst.folder()

  const first = await api.routes['/run']()
  assert.equal(first.ok, true, first.message)
  const day1 = join(dir, `${DAY}.md`)
  assert.equal(first.file, day1)
  assert.equal(existsSync(day1), true)

  const text = readFileSync(day1, 'utf8')
  assert.match(text, new RegExp(`^---\ndate: ${DAY}\n`))
  assert.match(text, /mood: "心情不错"/)
  assert.match(text, /chats: 3/)
  assert.ok(text.includes(BODY), '正文应该原样落进文件')

  const second = await api.routes['/run']()
  assert.equal(second.ok, true, second.message)
  assert.equal(second.file, join(dir, `${DAY}-2.md`))
  assert.equal(existsSync(day1), true, '第一篇不能被覆盖')

  const third = await api.routes['/run']()
  assert.equal(third.file, join(dir, `${DAY}-3.md`))
})

test('她一个字都没写时不落文件，也不动索引', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root, { think: async () => '   ' })

  const res = await api.routes['/run']()
  assert.equal(res.ok, false)
  assert.match(res.message, /什么都没写/)
  assert.equal(existsSync(join(inst.folder(), `${DAY}.md`)), false)
  assert.equal(inst.list().length, 0)
})

test('索引逐篇记下，state 只存 last，不把运行标志写进磁盘', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const base = join(root, 'data')

  await api.routes['/run']()
  await api.routes['/run']()

  const index = readJson(join(base, 'index.json'))
  assert.equal(index.length, 2)
  for (const item of index) {
    assert.equal(item.day, DAY)
    assert.ok(item.file.endsWith('.md'))
    assert.equal(item.chars, BODY.length)
    assert.equal(item.mood, '心情不错')
    assert.ok(item.summary.length > 0)
  }

  const state = readJson(join(base, 'state.json'))
  assert.deepEqual(state, { last: DAY }, 'state 只该存 last')
  assert.equal('running' in state, false, 'running 只能是内存里的，写盘会卡死定时')
})

test('磁盘上残留 running=true 也不会把定时器卡住', async (t) => {
  const root = tempRoot(t)
  const base = join(root, 'data')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'state.json'), JSON.stringify({ last: '', running: true }), 'utf8')

  const { api } = boot(root)
  const status = await api.routes['/status']()
  assert.equal(status.running, false)

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, '不该回「上一篇还在写」')
})

test('索引丢了会从文件夹重扫回来，心情和字数都对得上', async (t) => {
  const root = tempRoot(t)
  const base = join(root, 'data')
  const first = boot(root)
  await first.api.routes['/run']()

  rmSync(join(base, 'index.json'))
  const again = boot(root)
  const list = again.inst.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].day, DAY)
  assert.equal(list[0].mood, '心情不错')
  assert.equal(list[0].chars, BODY.length)
})

test('面板按 POST 里的 file 读正文，读不到就说没有这篇', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const saved = await api.routes['/run']()

  api.posted = { file: saved.file }
  const read = await api.routes['/read']({})
  assert.equal(read.ok, true)
  assert.equal(read.day, DAY)
  assert.equal(read.body, BODY, '正文要剥掉 frontmatter')
  assert.equal(read.meta.chats, '3')

  // 网址参数那条路也要通
  api.posted = {}
  api.query = { file: saved.file }
  assert.equal((await api.routes['/read']({})).ok, true)

  // 不在索引里的路径一律不放行
  api.query = {}
  for (const file of ['', join(root, 'data', 'diary', 'nope.md'), '/etc/passwd', '../../secret.md']) {
    api.posted = { file }
    const miss = await api.routes['/read']({})
    assert.equal(miss.ok, false, `不该读到 ${file}`)
    assert.match(miss.message, /没有这篇/)
  }
})

test('日记文件夹按设置走，开镜像时同步一份进备份区', async (t) => {
  const root = tempRoot(t)
  const outside = join(root, '外面')
  const { api, inst } = boot(root, { preset: { dir: outside, mirror: true } })

  const res = await api.routes['/run']()
  assert.equal(res.ok, true, res.message)
  assert.equal(inst.folder(), outside)
  const file = join(outside, `${DAY}.md`)
  assert.equal(existsSync(file), true)
  assert.equal(existsSync(join(root, 'data', 'archive', `${DAY}.md`)), true, '外部文件夹要镜像进备份区')

  // 关掉镜像就不再复制
  api.cfg.mirror = false
  await api.routes['/run']()
  assert.equal(existsSync(join(root, 'data', 'archive', `${DAY}-2.md`)), false)
})

test('没放字体文件时明说，面板不至于 500', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  const res = await api.routes['/hand.ttf']({}, {})
  // 仓库里不带字体（授权问题），所以这里走的是缺失分支
  assert.equal(res.ok, false)
  assert.match(res.message, /assets\/hand\.ttf/)
})

test('diary_read 只给主人私聊，别人和系统会话都拿不到', async (t) => {
  const root = tempRoot(t)
  const { api } = boot(root)
  await api.routes['/run']()

  // 宿主两种接法都认：给单个工具，或者给空数组
  const pick = (args) => {
    const got = api.toolSelector(args)
    if (Array.isArray(got)) return got
    return got ? [got] : []
  }

  assert.deepEqual(pick({ level: 'social', chat: { kind: 'group' } }), [])
  assert.deepEqual(pick({ level: 'full', chat: { kind: 'system' } }), [])

  const tools = pick({ level: 'full', chat: { kind: 'private' } })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'diary_read')

  const hit = await tools[0].execute({})
  assert.equal(hit.ok, true)
  assert.ok(hit.message.includes(BODY))

  const byDay = await tools[0].execute({ day: DAY })
  assert.ok(byDay.message.includes(BODY))

  const miss = await tools[0].execute({ query: '完全不存在的东西' })
  assert.match(miss.message, /没找到对应的日记/)
})

test('/status 报的路径、篇数与翻了页的顺序对得上', async (t) => {
  const root = tempRoot(t)
  const { api, inst } = boot(root)
  await api.routes['/run']()
  await api.routes['/run']()

  const status = await api.routes['/status']()
  assert.equal(status.ok, true)
  assert.equal(status.folder, inst.folder())
  assert.equal(status.count, 2)
  assert.equal(status.items.length, 2)
  assert.ok(status.items[0].file.endsWith(`${DAY}-2.md`), '最新的排最前面')
  assert.equal(typeof status.next, 'string')
  assert.ok(status.next.length > 0)
})
