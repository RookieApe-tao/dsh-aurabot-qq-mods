// 纯格式化函数：把 OneBot 的成员资料翻译成人话。
// 这里不碰网络、不读文件，全部是纯函数，方便单测（见 test/format.test.mjs）。

/** 群角色 → 中文。未知角色原样返回，不硬编成「成员」骗人。 */
export function roleText(role) {
  const r = String(role || '').trim()
  if (r === 'owner') return '群主'
  if (r === 'admin') return '管理员'
  if (r === 'member') return '普通成员'
  return r || '身份未知'
}

/** 秒级时间戳 → 「2026-11-01 08:00」。0/非法返回空串（让调用方整行省略）。 */
export function fmtTime(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 距今多久 → 「3 天前」「2 小时前」「刚刚」。 */
export function fmtAgo(ts, now = Date.now()) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const diff = Math.max(0, now - n * 1000)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/** Q 龄（年）→ 「7 年」。没给或为 0 时返回空串。 */
export function fmtYears(years) {
  const n = Number(years)
  if (!Number.isFinite(n) || n <= 0) return ''
  return `${Math.floor(n)} 年`
}

/**
 * 把成员资料拼成一段给她看/发出去的文字。
 * @param {object} info OneBot get_group_member_info 的 data
 * @param {object} [opts]
 * @param {object} [opts.group] get_group_info 的 data（可选，用来写群名）
 * @param {boolean} [opts.showLastSend=true] 是否显示最后发言时间
 * @param {boolean} [opts.showQAge=true] 是否显示 Q 龄
 * @param {number} [opts.now] 当前时间（测试用）
 */
export function formatMember(info, opts = {}) {
  if (!info || !info.user_id) return ''
  const showLastSend = opts.showLastSend !== false
  const showQAge = opts.showQAge !== false
  const now = opts.now ?? Date.now()

  const name = String(info.card || info.nickname || '').trim() || String(info.user_id)
  const head = `【${name}】${String(info.user_id)}`
  const lines = [head]

  const role = roleText(info.role)
  const title = String(info.title || '').trim()
  lines.push(title ? `身份：${role}（头衔「${title}」）` : `身份：${role}`)

  // 群名片和昵称不同时，两个都交代清楚，免得对不上号
  const nick = String(info.nickname || '').trim()
  const card = String(info.card || '').trim()
  if (nick && card && nick !== card) lines.push(`昵称：${nick}`)

  const groupName = String(opts.group?.group_name || opts.group?.name || '').trim()
  if (groupName) lines.push(`群：${groupName}`)

  const joined = fmtTime(info.join_time)
  if (joined) {
    const ago = fmtAgo(info.join_time, now)
    lines.push(`加群：${joined}${ago ? `（${ago}）` : ''}`)
  }

  if (showQAge) {
    const years = fmtYears(info.qage)
    const lv = String(info.qq_level || '').trim()
    const parts = [years ? `Q 龄 ${years}` : '', lv ? `QQ 等级 ${lv}` : ''].filter(Boolean)
    if (parts.length) lines.push(parts.join(' · '))
  }

  const groupLevel = String(info.level || '').trim()
  if (groupLevel) lines.push(`群等级：${groupLevel}`)

  if (showLastSend) {
    const last = fmtTime(info.last_sent_time)
    if (last) {
      const ago = fmtAgo(info.last_sent_time, now)
      lines.push(`最后发言：${last}${ago ? `（${ago}）` : ''}`)
    }
  }

  if (Number(info.shut_up_timestamp) > 0) {
    const until = fmtTime(info.shut_up_timestamp)
    if (until) lines.push(`当前状态：禁言中（到 ${until}）`)
  }

  return lines.join('\n')
}
