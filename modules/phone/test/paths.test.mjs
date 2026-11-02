// paths.test.mjs —— 复审 #19 P0-1/P0-2 的回归：路径穿越封死 + 写操作关键词补全。
// 运行：mods-fork 仓库根 `node --test modules/phone/test/paths.test.mjs`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../lib/memory.mjs'
import { createGuides } from '../lib/guides.mjs'
import { createFlows } from '../lib/flows.mjs'
import { createSafety } from '../lib/safety.mjs'

test('路径穿越封死：memory/guides/flows 的 key 只认白名单字符（P0-1）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-paths-'))
  try {
    const memory = createMemory({ dataDir: dir, ask: async () => '' })
    // `../../xxx` 之类越目录的 key：写/删都不许碰到目录外
    await assert.rejects(() => memory.save('../../config', { runLog: { steps: 1, ok: true, summary: '' }, goal: 'x' }), /不合法/)
    assert.equal(memory.clear('../../config'), false)
    assert.equal(memory.load('../../config'), null)

    const guides = createGuides(dir)
    assert.equal(guides.remove('../../evil'), false, '越目录的指引 key 删不动任何文件')
    assert.throws(() => guides.upsert('../../evil', { name: 'x', text: 'y' }), /指引 key/)
    // 正常 key 照常工作
    guides.upsert('my-guide', { name: '我的指引', text: '正文' })
    assert.ok(guides.get('my-guide').includes('正文'))
    assert.equal(guides.remove('my-guide'), true)

    const flows = createFlows(dir)
    assert.throws(() => flows.upsert('../../evil', {}), /流程 id/)
    flows.upsert('cronflow', { name: 'x' })
    assert.ok(flows.get('cronflow'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写操作关键词：确定/英文/支付/卸载类都拦（P0-2），浏览类不拦', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-kw-'))
  try {
    const safety = createSafety({
      dataDir: dir,
      getSettings: () => ({ whitelist: [], rateLimit: 0, confirmWrites: true, dryRun: false }),
    })
    for (const t of ['确定', '确认订单', 'Confirm', 'PAY NOW', 'Payment', 'Uninstall app', '提交订单', 'login', '一键登录', 'Authorize this device']) {
      assert.equal(safety.isWriteAction(t), true, t)
    }
    for (const t of ['刷新首页', '看一眼消息列表', 'scroll down']) {
      assert.equal(safety.isWriteAction(t), false, t)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
