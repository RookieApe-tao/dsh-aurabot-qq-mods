/**
 * nodes.test.mjs —— parseNodes / nodeCenter 纯函数测试
 * 覆盖五种样例 XML：可点击按钮、可输入框、不可点击节点、越界 bounds、坏 XML。
 * 纯函数测试：只喂字符串，不碰 adb / 网络。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNodes, nodeCenter } from '../lib/nodes.mjs'

/** 造一个 node 标签的辅助函数。 */
function node(o) {
  const parts = [
    `index="0"`, `text="${o.text || ''}"`, `resource-id=""`, `class="${o.cls || 'android.widget.TextView'}"`,
    `package="com.x"`, `content-desc="${o.desc || ''}"`,
    `checkable="false" checked="false" clickable="${o.clickable ? 'true' : 'false'}" enabled="true"`,
    `focusable="false" focused="false" scrollable="${o.scrollable ? 'true' : 'false'}"`,
    `long-clickable="false" password="false" selected="false" bounds="${o.bounds}"`,
  ]
  if (o.editable) parts.splice(1, 0, `editable="true"`)
  return `<node ${parts.join(' ')}/>`
}

/** 一份完整 uiautomator XML。 */
function xml(inner) {
  return `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node index="0" class="android.widget.FrameLayout" package="com.x" bounds="[0,0][1080,2340]">${inner}</node></hierarchy>`
}

test('保留可点击按钮并给出九宫格位置', () => {
  const r = parseNodes(xml(node({ text: '发布', clickable: true, cls: 'android.widget.Button', bounds: '[440,2100][640,2260]' })))
  assert.equal(r.error, undefined)
  assert.equal(r.list.length, 1)
  const nd = r.list[0]
  assert.equal(nd.n, 0)
  assert.equal(nd.text, '发布')
  assert.equal(nd.cls, 'android.widget.Button')
  assert.deepEqual(nd.center, [540, 2180]) // bounds 中心
  assert.equal(nd.editable, false)
  assert.ok(r.brief.includes('[0]按钮"发布"'))
  assert.ok(r.brief.includes('底部中央')) // y=2180 > 2340*2/3
})

test('保留可输入框（EditText 类）并标注可输入', () => {
  const r = parseNodes(xml(node({ text: '说点什么...', cls: 'android.widget.EditText', bounds: '[100,200][900,300]' })))
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].editable, true)
  assert.ok(r.brief.includes('输入框"说点什么..."'))
})

test('不可点击普通节点被过滤', () => {
  const r = parseNodes(
    xml(
      node({ text: '纯文本', bounds: '[0,100][500,200]' }) + // 不可点
        node({ text: '按钮', clickable: true, bounds: '[0,300][500,400]' })
    )
  )
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].text, '按钮')
})

test('越界/倒置 bounds 的节点被丢弃', () => {
  const r = parseNodes(
    xml(node({ text: '坏框', clickable: true, bounds: '[900,500][100,300]' })) // x2<x1 倒置
  )
  assert.deepEqual(r.list, [])
  assert.equal(r.error, 'DUMP_EMPTY')
})

test('空字符串与坏 XML 返回 DUMP_EMPTY', () => {
  assert.deepEqual(parseNodes(''), { list: [], brief: '', error: 'DUMP_EMPTY' })
  const bad = parseNodes('<hierarchy><node unclosed...')
  assert.equal(bad.error, 'DUMP_EMPTY')
  assert.deepEqual(bad.list, [])
})

test('nodeCenter 返回中心坐标，未知序号返回 null', () => {
  const r = parseNodes(
    xml(node({ text: 'A', clickable: true, bounds: '[0,0][100,100]' }) + node({ text: 'B', clickable: true, bounds: '[200,200][400,400]' }))
  )
  assert.deepEqual(nodeCenter(r.list, 1), [300, 300])
  assert.equal(nodeCenter(r.list, 9), null)
  assert.equal(nodeCenter([], 0), null)
})

test('maxNodes 截断与 XML 实体反转义', () => {
  const r = parseNodes(xml(node({ text: '赞&amp;踩', clickable: true, bounds: '[0,0][100,100]' })), { maxNodes: 1 })
  assert.equal(r.list[0].text, '赞&踩')
  // 多节点但限 1 条
  const two = parseNodes(
    xml(node({ text: 'A', clickable: true, bounds: '[0,0][100,100]' }) + node({ text: 'B', clickable: true, bounds: '[0,200][100,300]' })),
    { maxNodes: 1 }
  )
  assert.equal(two.list.length, 1)
})

test('scrollable 节点保留且 brief 标注可滚动', () => {
  const r = parseNodes(xml(node({ scrollable: true, cls: 'androidx.recyclerview.widget.RecyclerView', bounds: '[0,300][1080,2000]' })))
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].scrollable, true)
  assert.ok(r.brief.includes('可滚动'))
})
