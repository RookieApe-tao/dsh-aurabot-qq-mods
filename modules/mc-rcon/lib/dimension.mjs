// 维度识别：把玩家说「去下界 / 主世界 / 末地 / 某模组维度」翻译成维度 id，
// 用来判断 tp 是不是跨维度、以及跨维度前先问确认。
//
// 别名在面板「维度别名」里配（一行一个「别名=维度id」），也可以直接说完整 id，
// 比如 twilightforest:twilight_forest。

/** 从一句话里认出目标维度；认不出返回空串。 */
export function parseDimension (text, aliases = []) {
  const t = String(text || '').toLowerCase()
  if (!t) return ''

  // 1) xaero 路点分享里带 Internal-<维度>-waypoints，比坐标里的 false:0 可靠
  const internal = t.match(/internal-([a-z_]+)-waypoints/i)
  if (internal) {
    const name = internal[1].toLowerCase()
    if (['overworld', 'the_nether', 'the_end'].includes(name)) return `minecraft:${name}`
  }

  // 2) 完整 id：minecraft:the_nether、twilightforest:twilight_forest
  // 命名空间和值都必须以字母开头，避免把坐标 / 数据字段（15792:69、false:0）当成维度
  const idm = t.match(/\b([a-z][a-z0-9_]*:[a-z][a-z0-9_]*)\b/)
  if (idm) return idm[1]

  // 2) 别名；维度词必须离坐标不太远，避免「下界合金怎么做」这种被当成维度
  const coord = t.match(/-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?/)
  const coordAt = coord ? coord.index : -1
  for (const line of aliases) {
    const [aliasRaw, dimRaw] = String(line).split('=')
    const alias = String(aliasRaw || '').trim().toLowerCase()
    const dim = String(dimRaw || '').trim().toLowerCase()
    if (!alias || !dim) continue
    const at = t.indexOf(alias)
    if (at < 0) continue
    if (coordAt >= 0 && Math.abs(at - coordAt) > 24) continue
    return dim
  }
  return ''
}

/** 维度 id 反过来显示成人话（优先用别名表里的第一个别名）。 */
export function dimensionLabel (dim, aliases = []) {
  const d = String(dim || '').toLowerCase()
  for (const line of aliases) {
    const [aliasRaw, dimRaw] = String(line).split('=')
    if (String(dimRaw || '').trim().toLowerCase() === d) return String(aliasRaw || '').trim()
  }
  return d
    .replace(/^minecraft:/, '')
    .replace(/^the_nether$/, '下界')
    .replace(/^nether$/, '下界')
    .replace(/^overworld$/, '主世界')
    .replace(/^the_end$/, '末地')
    .replace(/^end$/, '末地')
}
