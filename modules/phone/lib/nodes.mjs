/**
 * nodes.mjs —— phone 模块 uiautomator XML 解析与语义化
 * 作用：把 `uiautomator dump` 的 XML 转成「模型看得懂的自然语言节点清单」。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function parseNodes(xml, { maxNodes = 80 } = {})
 *   → { list:[{ n, text, desc, cls, center:[x,y], editable, scrollable }], brief, error? }
 *   失败 → { list:[], brief:'', error:'DUMP_EMPTY' }
 *   export function nodeCenter(list, n) // → [x,y] 或 null
 * 规则：只保留 clickable | editable | scrollable 的节点；位置按 bounds 九宫格描述；
 *      屏幕尺寸按现有最大 bounds 推算（推不出用 1080x2340 兜底）。
 */

/** 反转 XML 实体。 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从一个节点标签里取属性值（不存在返回 ''）。 */
function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : ''
}

/** bounds="[x1,y1][x2,y2]" → {x1,y1,x2,y2}；格式坏返回 null。 */
function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s || '')
  if (!m) return null
  const [x1, y1, x2, y2] = m.slice(1).map(Number)
  if (!(x2 > x1 && y2 > y1)) return null // 越界/倒置 bounds 丢弃
  return { x1, y1, x2, y2 }
}

/**
 * 按 bounds 中心点相对屏幕给九宫格位置描述（如「左上」「底部中央」）。
 * @param {{x1:number,y1:number,x2:number,y2:number}} b
 * @param {number} sw 屏幕宽
 * @param {number} sh 屏幕高
 */
function gridPos(b, sw, sh) {
  const cx = (b.x1 + b.x2) / 2
  const cy = (b.y1 + b.y2) / 2
  const col = cx < sw / 3 ? '左' : cx > (sw * 2) / 3 ? '右' : ''
  const row = cy < sh / 3 ? '顶部' : cy > (sh * 2) / 3 ? '底部' : '中部'
  if (col === '') return row === '中部' ? '屏幕中央' : `${row}中央` // 顶部中央 / 底部中央
  return `${col}${row}` // 左上 / 右下 / 底部中央 等
}

/**
 * 解析 uiautomator XML → 节点列表 + 自然语言 brief。
 * 只保留 clickable/scrollable=true 或可编辑（EditText 类或 editable 属性）的节点。
 */
export function parseNodes(xml, { maxNodes = 80 } = {}) {
  const s = String(xml || '')
  // 空 / 完全不像 uiautomator dump → DUMP_EMPTY
  if (!s.trim() || !/<hierarchy/i.test(s)) {
    return { list: [], brief: '', error: 'DUMP_EMPTY' }
  }
  // 先全量扫描一遍所有 node 的 bounds 推算屏幕尺寸（含被过滤节点，
  // 否则屏上只剩一两个小控件时会推错九宫格），推不出用 1080x2340 兜底
  let sw = 0
  let sh = 0
  const sizeRe = /<node\s+[^>]*bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/g
  let sm
  while ((sm = sizeRe.exec(s)) !== null) {
    const [, x1, y1, x2, y2] = sm.map(Number)
    if (x2 > x1 && y2 > y1) {
      sw = Math.max(sw, x2)
      sh = Math.max(sh, y2)
    }
  }
  sw = sw || 1080
  sh = sh || 2340
  // 逐个 <node .../> 标签扫描（uiautomator 的 node 标签都是自闭合）
  const tagRe = /<node\s+([^>]*)\/?>/g
  const list = []
  let m
  while ((m = tagRe.exec(s)) !== null) {
    const tag = `<node ${m[1]}>`
    const clickable = attr(tag, 'clickable') === 'true'
    const scrollable = attr(tag, 'scrollable') === 'true'
    const editable = attr(tag, 'editable') === 'true' || /EditText/.test(attr(tag, 'class'))
    // 不是可交互节点就跳过（普通 TextView 之类）
    if (!clickable && !scrollable && !editable) continue
    const b = parseBounds(attr(tag, 'bounds'))
    if (!b) continue // 越界/坏 bounds 的节点不要
    // 推算屏幕尺寸：取所有节点最大右/下边
    const n = list.length
    list.push({
      n,
      text: attr(tag, 'text'),
      desc: attr(tag, 'content-desc'),
      cls: attr(tag, 'class'),
      center: [Math.round((b.x1 + b.x2) / 2), Math.round((b.y1 + b.y2) / 2)],
      editable,
      scrollable,
    })
    if (list.length >= maxNodes) break // 超预算截断，防 brief 过长
  }
  // 标签像 XML 但一个可用节点也没有：也按空转储处理，让上层重试
  if (list.length === 0) {
    return { list: [], brief: '', error: 'DUMP_EMPTY' }
  }
  // 自然语言 brief：[0]按钮"发布" 底部中央 | [1]输入框"说点什么..." 可输入 | ...
  const parts = list.map((nd) => {
    const kind = nd.editable ? '输入框' : nd.scrollable ? '滚动区' : '按钮'
    const label = nd.text || nd.desc || nd.cls.split('.').pop()
    const pos = gridPos(
      {
        x1: nd.center[0] - 1,
        y1: nd.center[1] - 1,
        x2: nd.center[0] + 1,
        y2: nd.center[1] + 1,
      },
      sw,
      sh
    )
    const feats = [nd.editable && '可输入', nd.scrollable && '可滚动'].filter(Boolean).join('/')
    return `[${nd.n}]${kind}"${label}" ${pos}${feats ? ' ' + feats : ''}`
  })
  return { list, brief: parts.join(' | ') }
}

/**
 * 取第 n 个节点的中心坐标，供 tap 用。
 * @param {Array<{n:number, center:[number,number]}>} list
 * @param {number} n
 * @returns {[number, number]|null}
 */
export function nodeCenter(list, n) {
  const nd = (list || []).find((x) => x.n === n)
  return nd ? nd.center : null
}
