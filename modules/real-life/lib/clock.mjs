// 时区安全的墙上时钟工具：不依赖进程本地时区，重启或跨时区容器都不会算偏。

const DEFAULT_TZ = 'Asia/Shanghai'
const fmtCache = new Map()

function getFormatter(timeZone = DEFAULT_TZ) {
  const tz = String(timeZone || DEFAULT_TZ).trim() || DEFAULT_TZ
  if (fmtCache.has(tz)) return fmtCache.get(tz)
  let fmt
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }
  fmtCache.set(tz, fmt)
  return fmt
}

export function wallTime(nowMs = Date.now(), timeZone = DEFAULT_TZ) {
  const parts = getFormatter(timeZone).formatToParts(new Date(nowMs))
  const map = {}
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value
  }
  const year = Number(map.year)
  const month = Number(map.month)
  const day = Number(map.day)
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour)
  const minute = Number(map.minute)
  const second = Number(map.second)
  const ymd = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const hourFloat = hour + minute / 60 + second / 3600
  const dayIndex = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
  return { year, month, day, hour, minute, second, ymd, hhmm, hourFloat, dayIndex }
}

export function parseHm(text, fallback = 8) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 29 || min < 0 || min > 59) return fallback
  return h + min / 60
}

export function formatHm(hourFloat) {
  const norm = (((Number(hourFloat) || 0) % 24) + 24) % 24
  const totalMin = Math.round(norm * 60) % (24 * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function isValidYmd(ymd) {
  if (typeof ymd !== 'string') return false
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

export function daysBetweenYmd(startYmd, endYmd) {
  if (!isValidYmd(startYmd) || !isValidYmd(endYmd)) return 0
  const [y1, m1, d1] = startYmd.split('-').map(Number)
  const [y2, m2, d2] = endYmd.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

export function shiftYmd(ymd, deltaDays) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + Math.trunc(deltaDays)))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** 每日确定性微浮动（单位：小时），同一天同一个 key 结果固定，不随 tick 乱跳。 */
export function dailyJitterHours(ymd, salt, amplitudeMinutes = 20) {
  const str = `${ymd}:${salt}`
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const unit = ((hash >>> 0) % 2001) / 1000 - 1
  return (unit * amplitudeMinutes) / 60
}

/** 判断当前小时是否在 [startH, endH) 区间内（支持跨午夜，比如 23.5 → 7.5）。 */
export function inHourWindow(curH, startH, endH) {
  const c = ((curH % 24) + 24) % 24
  const s = ((startH % 24) + 24) % 24
  const e = ((endH % 24) + 24) % 24
  if (Math.abs(s - e) < 1e-6) return false
  return s < e ? c >= s && c < e : c >= s || c < e
}
