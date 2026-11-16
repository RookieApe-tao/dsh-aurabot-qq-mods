// 语音通话模块的离线测试：不连 QQ、不起 PowerShell、不写任何文件。
// 跑法：node --test modules/callme/test/callme.test.mjs
// CI 里和其他模块一起跑：AURABOT_PLUGIN_DIR=<插件源码> node --import ./scripts/plugin-env.mjs --test "modules/*/test/*.test.mjs"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'
import { buildCallArgs, canHangup, createCallController, hangupReply, HANGUP_RE, wantsCall, wantsGroupCall } from '../lib/call.mjs'

const MANIFEST = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'))

/** 假的脚本执行器：记录每次要跑什么，返回给定退出码。 */
function fakeRunner(code = 0) {
  const runs = []
  const run = async (file, args) => {
    runs.push({ file, args })
    return code
  }
  return { runs, run }
}

const quietLog = () => {
  const info = []
  const warn = []
  return { info: (m) => info.push(String(m)), warn: (m) => warn.push(String(m)), infoLines: info, warnLines: warn }
}

test('module.json 和模块本身对得上', () => {
  assert.equal(plugin.id, 'callme')
  assert.equal(MANIFEST.id, 'callme')
  assert.equal(plugin.version, MANIFEST.version, 'module.json 的版本要和 index.mjs 一致')
  assert.equal(plugin.api, MANIFEST.api)
  assert.ok(!plugin.defaults.enabled, '关键词自动拨号默认必须是关的')
  assert.ok(plugin.settings.some((s) => s.key === 'cooldownSec'))
})

test('PowerShell 脚本是 UTF-8 with BOM，Windows PowerShell 5.1 才能正确解析中文', () => {
  for (const name of ['call-out.ps1', 'hangup.ps1']) {
    const buf = readFileSync(new URL('../assets/' + name, import.meta.url))
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 缺 UTF-8 BOM`)
    const text = buf.subarray(3).toString('utf8')
    assert.ok(!text.includes('\u0000'), `${name} 有 NUL 字节`)
    assert.match(text, /param\s*\(/, `${name} 缺 param 块`)
    // 中文引号只允许出现在注释里，代码/字符串用 ASCII 引号
    const code = text.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n')
    assert.ok(!/[“”‘’]/.test(code), `${name} 代码区混进了中文引号`)
  }
})

test('拨号参数：每个值都是独立参数，空格 / 引号 / $ 原样保留', () => {
  assert.deepEqual(buildCallArgs({ contact: '花辞树' }), ['-Contact', '花辞树'])
  assert.deepEqual(buildCallArgs({ contact: 'A "B" $HOME', invite: '小 明', inviteQQ: '20002' }), [
    '-Contact', 'A "B" $HOME', '-Invite', '小 明', '-InviteQQ', '20002',
  ])
  assert.deepEqual(buildCallArgs({}), ['-Contact', ''])
})

test('意图识别：说想打才算，否定句不算', () => {
  assert.equal(wantsCall('给我打个电话'), true)
  assert.equal(wantsCall('过来个电话吧'), true)
  assert.equal(wantsCall('call me'), true)
  assert.equal(wantsCall('别打了'), false)
  assert.equal(wantsCall('先不打了，聊会儿就行'), false)
  assert.equal(wantsCall(''), false)
  assert.equal(wantsCall('今天天气不错'), false)
})

test('群电话要 @ 她、说「群」、而且开关开着', () => {
  assert.equal(wantsGroupCall('群里打个电话吧', { mentioned: true }), true)
  assert.equal(wantsGroupCall('开个群语音', { mentioned: true }), true)
  assert.equal(wantsGroupCall('群里打个电话吧', { mentioned: false }), false)
  assert.equal(wantsGroupCall('群里打个电话吧', { mentioned: true, groupCall: false }), false)
  assert.equal(wantsGroupCall('群里别打群电话了', { mentioned: true }), false)
  assert.equal(wantsGroupCall('给我打个电话', { mentioned: true }), false)
})

test('挂断权限：主人随时能挂，要求发起的人两小时内能挂，别人不行', () => {
  const now = 1_700_000_000_000
  const requester = { userId: '20002', chatId: 'private:20002', at: now - 60_000 }
  assert.equal(canHangup({ userId: '10001', kind: 'private', role: 'member', isOwner: (q) => q === '10001' }, requester, now), true)
  assert.equal(canHangup({ userId: '20002', kind: 'private', role: 'member' }, requester, now), true)
  assert.equal(canHangup({ userId: '30003', kind: 'private', role: 'member' }, requester, now), false)
  assert.equal(canHangup({ userId: '20002', kind: 'private', role: 'member' }, { ...requester, at: now - 3 * 3600_000 }, now), false)
  assert.equal(canHangup({ userId: '30003', kind: 'private', role: 'member' }, null, now), false)
  assert.match('那挂了吧', HANGUP_RE)
})

test('控制器：没填联系人就不拨', async () => {
  const { runs, run } = fakeRunner()
  const call = createCallController({ run, log: quietLog() })
  const r = await call.request({ contact: '  ', callOut: 'call-out.ps1' })
  assert.equal(r.ok, false)
  assert.match(r.message, /不知道.*打给谁/)
  assert.equal(runs.length, 0)
})

test('控制器：拨一次会带着联系人和邀请参数去跑脚本', async () => {
  const { runs, run } = fakeRunner()
  const log = quietLog()
  const call = createCallController({ run, log })
  const r = await call.request({ contact: '花辞树', callOut: 'call-out.ps1', awaitResult: true })
  assert.equal(r.ok, true)
  assert.match(r.message, /花辞树/)
  assert.deepEqual(runs.at(-1), { file: 'call-out.ps1', args: ['-Contact', '花辞树'] })
  assert.match(log.infoLines.join('\n'), /发起语音通话 -> 花辞树/)

  const g = await createCallController({ run, log }).request({
    contact: '测试群',
    invite: '小明',
    inviteQQ: '20002',
    callOut: 'call-out.ps1',
    awaitResult: true,
  })
  assert.equal(g.ok, true)
  assert.deepEqual(runs.at(-1).args, ['-Contact', '测试群', '-Invite', '小明', '-InviteQQ', '20002'])
})

test('控制器：冷却期内第二次被挡，冷却过了才能再拨', async () => {
  let t = 1_700_000_000_000
  const { runs, run } = fakeRunner()
  const call = createCallController({ run, log: quietLog(), now: () => t })
  const opts = { contact: '花辞树', cooldownSec: 60, callOut: 'call-out.ps1', awaitResult: true }

  assert.equal((await call.request(opts)).ok, true)
  const second = await call.request(opts)
  assert.equal(second.ok, false)
  assert.match(second.message, /刚打过，\d+ 秒后再打/)
  assert.equal(runs.length, 1, '冷却期内不能真的再拨')

  t += 61_000
  assert.equal((await call.request(opts)).ok, true)
  assert.equal(runs.length, 2)
})

test('控制器：记下要求者，挂断后清空', async () => {
  const { run } = fakeRunner()
  const call = createCallController({ run, log: quietLog() })
  await call.request({ contact: '花辞树', callOut: 'call-out.ps1', markRequester: { userId: '20002', chatId: 'private:20002' }, awaitResult: true })
  assert.equal(call.state().lastRequester.userId, '20002')

  assert.equal(await call.hangup({ hangupScript: 'hangup.ps1' }), 0)
  assert.equal(call.state().lastRequester, null)
})

test('控制器：脚本失败时挂断也返回非 0，要求者保留', async () => {
  const { run } = fakeRunner(5)
  const call = createCallController({ run, log: quietLog() })
  await call.request({ contact: '花辞树', callOut: 'call-out.ps1', markRequester: { userId: '20002', chatId: 'private:20002' }, awaitResult: true })
  assert.equal(await call.hangup({ hangupScript: 'hangup.ps1' }), 5)
  assert.equal(call.state().lastRequester.userId, '20002')
})

/** 搭一套假 api 并加载模块。assets 里放两个空脚本，让 ready 成立。 */
function boot(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'callme-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'call-out.ps1'), '')
  writeFileSync(join(root, 'assets', 'hangup.ps1'), '')

  const calls = { info: [], warn: [], rule: [], tools: [], sent: [], replies: [], run: [] }
  let settings = { enabled: false, contact: '花辞树', cooldownSec: 60, groupCall: true, ...overrides }
  const handlers = { message: [] }

  const api = {
    dir: root,
    log: {
      info: (m) => calls.info.push(String(m)),
      warn: (m) => calls.warn.push(String(m)),
      debug: () => {},
    },
    settings: () => ({ ...settings }),
    saveSettings: (patch) => { settings = { ...settings, ...patch } },
    rule: (fn) => calls.rule.push(fn),
    defineTool: (tool) => { calls.tools.push(tool); return tool },
    tool: (factory) => { factory({ chat: { kind: 'private' }, level: 'full' }); return true },
    on: (name, fn) => { (handlers[name] ||= []).push(fn) },
    reply: async (msg, text) => { calls.replies.push({ chatId: msg.chatId, text }) },
    sendText: async (chatId, text) => { calls.sent.push({ chatId, text }) },
    isOwner: (qq) => String(qq) === '10001',
    core: { hub: { groupName: async () => '测试群' } },
  }

  plugin.setup(api)
  return {
    calls,
    setSettings: (patch) => { settings = { ...settings, ...patch } },
    message: async (msg) => {
      let handled = false
      for (const fn of handlers.message) {
        const r = await fn({ kind: 'private', role: 'member', userId: '10001', text: '', ...msg })
        if (r) handled = true
      }
      return handled
    },
  }
}

test('注册了 voice_call 工具和系统提示', (t) => {
  const box = boot(t)
  const tool = box.calls.tools.find((x) => x.name === 'voice_call')
  assert.ok(tool, '要有 voice_call 工具')
  assert.deepEqual(tool.required, [])
  assert.match(box.calls.rule[0](), /voice_call/)
})

test('voice_call：能在主人私聊里拨，正在拨或刚拨过都不会再拨', async (t) => {
  const box = boot(t)
  const tool = box.calls.tools.find((x) => x.name === 'voice_call')
  const first = await tool.execute({})
  assert.equal(first.ok, true)
  assert.match(first.message, /花辞树/)
  const second = await tool.execute({})
  assert.equal(second.ok, false)
  assert.match(second.message, /上一个电话还没挂|刚打过/)
})

test('voice_call：没设置默认联系人时让他先填', async (t) => {
  const box = boot(t, { contact: '' })
  const tool = box.calls.tools.find((x) => x.name === 'voice_call')
  const r = await tool.execute({})
  assert.equal(r.ok, false)
  assert.match(r.message, /不知道.*打给谁/)
})

test('默认关掉关键词自动拨号：私聊说「打个电话」也不拨', async (t) => {
  const box = boot(t)
  await box.message({ text: '给我打个电话' })
  assert.equal(box.calls.info.filter((m) => /发起语音通话/.test(m)).length, 0)
})

test('打开关键词自动拨号后，私聊说「打个电话」会拨', async (t) => {
  const box = boot(t, { enabled: true })
  const handled = await box.message({ text: '给我打个电话' })
  assert.equal(handled, true)
  assert.equal(box.calls.info.filter((m) => /发起语音通话 -> 花辞树/.test(m)).length, 1)
})

test('打开后冷却期内不再重复拨', async (t) => {
  const box = boot(t, { enabled: true })
  await box.message({ text: '打个电话' })
  await box.message({ text: '打个电话' })
  assert.equal(box.calls.info.filter((m) => /发起语音通话/.test(m)).length, 1)
})

test('群里没被 @ 不开群语音；被 @ 且说「群电话」才开', async (t) => {
  const box = boot(t, { enabled: true })
  await box.message({ kind: 'group', groupId: 42, chatId: 'group:42', mentioned: false, text: '群里打个电话' })
  assert.equal(box.calls.info.filter((m) => /发起语音通话/.test(m)).length, 0)

  await box.message({ kind: 'group', groupId: 42, chatId: 'group:42', mentioned: true, userId: '20002', nickname: '小明', text: '群里打个群电话吧' })
  assert.equal(box.calls.info.filter((m) => /发起语音通话 -> 测试群/.test(m)).length, 1)
  assert.match(box.calls.replies.at(-1).text, /群里开个语音/)
})

test('挂断回话只看脚本退出码：0 才算真挂上', () => {
  assert.equal(hangupReply(0), '挂啦～')
  assert.match(hangupReply(0), /挂/)
  assert.equal(hangupReply(5), '我这儿好像没在通话中')
  assert.equal(hangupReply(-1), '我这儿好像没在通话中')
})

test('挂断：别人挂不了，主人挂了会回一句', async (t) => {
  const box = boot(t)
  assert.equal(await box.message({ text: '挂了吧', userId: '20002' }), false)
  assert.equal(box.calls.sent.length, 0)

  assert.equal(await box.message({ text: '挂了吧', userId: '10001' }), true)
  assert.equal(box.calls.sent.length, 1)
  // 回话内容取决于本机脚本能不能跑起来（CI 上没有 PowerShell），所以只断言「回了，而且回的是这两种之一」
  assert.match(box.calls.sent[0].text, /挂啦～|我这儿好像没在通话中/)
})

test('没装脚本时（缺 assets）什么都不做', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'callme-empty-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = { info: [], warn: [], tools: [], sent: [] }
  const handlers = []
  plugin.setup({
    dir: root,
    log: { info: (m) => calls.info.push(String(m)), warn: (m) => calls.warn.push(String(m)), debug: () => {} },
    settings: () => ({ enabled: true, contact: '花辞树', cooldownSec: 60, groupCall: true }),
    rule: () => {},
    defineTool: (x) => { calls.tools.push(x); return x },
    tool: (f) => f({ chat: { kind: 'private' }, level: 'full' }),
    on: (name, fn) => { if (name === 'message') handlers.push(fn) },
    reply: async () => {},
    sendText: async (chatId, text) => calls.sent.push({ chatId, text }),
    isOwner: () => true,
    core: { hub: { groupName: async () => '测试群' } },
  })
  assert.match(calls.warn.join('\n'), /少了 call-out\.ps1/)
  const tool = calls.tools.find((x) => x.name === 'voice_call')
  const r = await tool.execute({})
  assert.equal(r.ok, false)
  for (const fn of handlers) assert.equal(await fn({ kind: 'private', role: 'member', userId: '10001', text: '打个电话' }), false)
  assert.equal(calls.sent.length, 0)
})
