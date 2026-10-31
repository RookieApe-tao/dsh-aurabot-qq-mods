// memory.test.mjs —— 记忆层与 cron 解析测试
// 纯函数/临时目录，不真调 adb、不碰网络。注入 ask 桩验证总结合并逻辑。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMemory } from '../lib/memory.mjs'
import { cronMatch } from '../lib/workspace.mjs'

/** 造一个独立临时数据目录 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phone-mem-'))
}

test('save 用 ask 桩输出作总结并落盘，load 能读回', async () => {
  const dir = tmpDir()
  const mem = createMemory({ dataDir: dir, ask: async () => '先点签到按钮再回首页，弹窗直接关闭。' })
  const saved = await mem.save('bili-daily', { runLog: { steps: 12, ok: true, summary: '签到完成' }, goal: 'B站签到' })
  assert.equal(saved.summary, '先点签到按钮再回首页，弹窗直接关闭。')
  assert.equal(saved.goal, 'B站签到')
  assert.equal(saved.runs, 1)
  assert.equal(saved.lastRun.steps, 12)
  assert.equal(saved.lastRun.ok, true)
  const loaded = mem.load('bili-daily')
  assert.equal(loaded.summary, saved.summary)
  // 文件落在 memory/ 单文件单段
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'bili-daily.json')))
})

test('runs 递增，ask 收到旧经验与本次结果', async () => {
  const dir = tmpDir()
  const prompts = []
  let n = 0
  const mem = createMemory({ dataDir: dir, ask: async (p) => { prompts.push(p); return `经验第${++n}版` } })
  await mem.save('daily', { runLog: { steps: 5, ok: true, summary: '第一次' }, goal: '签到' })
  const second = await mem.save('daily', { runLog: { steps: 7, ok: false, summary: '第二次卡在弹窗' }, goal: '签到' })
  assert.equal(second.runs, 2)
  assert.equal(second.summary, '经验第2版')
  assert.ok(prompts[1].includes('经验第1版'), 'ask 应拿到旧经验')
  assert.ok(prompts[1].includes('第二次卡在弹窗'), 'ask 应拿到本次经过')
  assert.equal(mem.load('daily').lastRun.ok, false)
})

test('总结超 300 字截断', async () => {
  const dir = tmpDir()
  const long = '经'.repeat(500)
  const mem = createMemory({ dataDir: dir, ask: async () => long })
  const saved = await mem.save('t', { runLog: { steps: 1, ok: true, summary: 'x' }, goal: 'g' })
  assert.equal(saved.summary.length, 300)
})

test('ask 抛错时退化保存（旧经验 + 本次一句话），不丢 runs', async () => {
  const dir = tmpDir()
  const mem = createMemory({ dataDir: dir, ask: async () => { throw new Error('模型罢工') } })
  const first = await mem.save('t', { runLog: { steps: 2, ok: true, summary: '成功' }, goal: 'g' })
  assert.ok(first.summary.includes('成功'))
  assert.equal(first.runs, 1)
})

test('clear 生效：删后 load 返回 null，clear 幂等', async () => {
  const dir = tmpDir()
  const mem = createMemory({ dataDir: dir, ask: async () => 's' })
  await mem.save('gone', { runLog: { steps: 1, ok: true, summary: 'x' }, goal: 'g' })
  assert.ok(mem.load('gone'))
  assert.equal(mem.clear('gone'), true)
  assert.equal(mem.load('gone'), null)
  assert.equal(mem.clear('gone'), false) // 再删一次返回 false（幂等）
})

test('adhoc 流程 runs>=10 附 promoteHint，正式流程不附', async () => {
  const dir = tmpDir()
  const mem = createMemory({ dataDir: dir, ask: async () => 's' })
  for (let i = 0; i < 9; i++) await mem.save('adhoc-test1234', { runLog: { steps: 1, ok: true, summary: 'x' }, goal: 'g' })
  const tenth = await mem.save('adhoc-test1234', { runLog: { steps: 1, ok: true, summary: 'x' }, goal: 'g' })
  assert.equal(tenth.runs, 10)
  assert.ok(tenth.promoteHint.includes('10'), '第 10 次应提示固化')
  const formal = await mem.save('bili-daily', { runLog: { steps: 1, ok: true, summary: 'x' }, goal: 'g' })
  assert.equal(formal.promoteHint, undefined)
})

test('无 ask 时也能保存（默认桩返回空总结）', async () => {
  const dir = tmpDir()
  const mem = createMemory({ dataDir: dir })
  const saved = await mem.save('t', { runLog: { steps: 1, ok: false, summary: '失败' }, goal: 'g' })
  assert.equal(saved.summary, '')
  assert.equal(saved.runs, 1)
})

test('cronMatch：* / 数字 / */5 / 指定小时 / 周几 / 逗号', () => {
  const d = (week, hour, min) => {
    // 2026-11-01 是周日；用 addDay 构造指定周几的日期
    const base = new Date(2026, 10, 1, hour, min, 0) // 月份从 0 起：10 = 11 月
    base.setDate(base.getDate() + week)
    return base
  }
  assert.equal(cronMatch('* * * * *', d(0, 9, 30)), true) // 全通配
  assert.equal(cronMatch('*/5 * * * *', d(0, 9, 30)), true) // 30 是 5 的倍数
  assert.equal(cronMatch('*/5 * * * *', d(0, 9, 31)), false)
  assert.equal(cronMatch('*/5 * * * *', d(0, 9, 0)), true) // 0 是下限
  assert.equal(cronMatch('0 9 * * *', d(0, 9, 0)), true) // 指定小时
  assert.equal(cronMatch('0 9 * * *', d(0, 8, 59)), false)
  assert.equal(cronMatch('0 9 * * 1', d(0, 9, 0)), false) // 周日 ≠ 周1
  assert.equal(cronMatch('0 9 * * 1', d(1, 9, 0)), true) // 周一
  assert.equal(cronMatch('30 9 1 11 *', new Date(2026, 10, 1, 9, 30)), true) // 指定日/月
  assert.equal(cronMatch('30 9 1 11 *', new Date(2026, 10, 2, 9, 30)), false)
  assert.equal(cronMatch('0 9,18 * * *', new Date(2026, 10, 1, 18, 0)), true) // 逗号列表
  assert.equal(cronMatch('0 9,18 * * *', new Date(2026, 10, 1, 12, 0)), false)
  assert.equal(cronMatch('坏格式', new Date()), false) // 字段数不对
  assert.equal(cronMatch('', new Date()), false)
})
