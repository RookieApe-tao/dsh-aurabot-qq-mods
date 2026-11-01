// guides.test.mjs —— 指引提示词库：内置条目、自定义覆盖、resolve 优先级
// 运行：mods-fork 仓库根 `node --test modules/phone/test/guides.test.mjs`；纯临时目录，不碰网络。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuides, BUILTIN_GUIDES } from '../lib/guides.mjs'

test('内置指引：五个 key 都有正文，generic 永远可取；总纲 main 不挂包名/关键词（resolve 不会自动挑它）', () => {
  assert.deepEqual(Object.keys(BUILTIN_GUIDES).sort(), ['bili', 'douyin', 'generic', 'heybox', 'main'])
  assert.deepEqual(BUILTIN_GUIDES.main.packages, [])
  assert.deepEqual(BUILTIN_GUIDES.main.keywords, [])
  for (const [key, g] of Object.entries(BUILTIN_GUIDES)) {
    assert.ok(g.text.length > 100, `${key} 指引正文太短`)
    assert.ok(g.text.includes('finish'), `${key} 指引应交代 finish 约定`)
  }
})

test('list/get：自定义层覆盖同名内置，删除后回到内置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-guides-'))
  try {
    const guides = createGuides(dir)
    const before = guides.list().find((g) => g.key === 'douyin')
    assert.equal(before.source, 'builtin')
    guides.upsert('douyin', { name: '我的抖音', text: '自定义抖音手册内容' })
    const after = guides.list().find((g) => g.key === 'douyin')
    assert.equal(after.source, 'custom')
    assert.equal(after.name, '我的抖音')
    assert.equal(guides.get('douyin'), '自定义抖音手册内容')
    assert.ok(guides.remove('douyin'))
    assert.equal(guides.list().find((g) => g.key === 'douyin').source, 'builtin')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolve：显式指定 > 包名 > 关键词 > generic', () => {
  const guides = createGuides(mkdtempSync(join(tmpdir(), 'phone-guides2-')))
  assert.equal(guides.resolve({ flowGuide: 'myguide', packages: ['tv.danmaku.bili'], goal: '刷抖音' }), 'myguide')
  assert.equal(guides.resolve({ packages: ['com.ss.android.ugc.aweme'] }), 'douyin')
  assert.equal(guides.resolve({ goal: '去B站签到' }), 'bili')
  assert.equal(guides.resolve({ goal: '打开计算器按两下' }), 'generic')
})

test('upsert 校验：非法 key 抛错', () => {
  const guides = createGuides(mkdtempSync(join(tmpdir(), 'phone-guides3-')))
  assert.throws(() => guides.upsert('坏 key', { text: 'x' }))
  assert.throws(() => guides.upsert('', { text: 'x' }))
})
