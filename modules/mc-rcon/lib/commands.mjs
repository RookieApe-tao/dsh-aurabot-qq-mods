// 命令权限校验：模型说「执行 xxx」之后，真正放不放行由这里决定。
//
// 两级：
//   admin  —— 面板 admins 名单里的玩家，能执行较广的命令，但受「禁止执行的命令」前缀限制；
//   guest  —— 普通玩家，只能执行「安全操作」白名单里的命令，并且参数会被校验、自动补上请求者自己：
//             · gamemode spectator / survival（只能切自己）
//             · tp <x> <y> <z>（只能传自己，坐标要合法）
//             · back（回到上次 tp 前的位置，由模块记住坐标）
//             · spawn（只能回自己的出生点）
//             · list / time query（只读）
//             · 面板 guestCommands 里写死的无参数命令（比如 home、back）
// 所有命令都会先过一遍 blockedCommands（管理员也不能执行 stop/ban/op 这些，QQ 主人用 /mc cmd 例外）。

const GUEST_GAMEMODES = ['spectator', 'survival']
const COORD_RE = /^(?:~[+-]?\d*|-?\d+(?:\.\d+)?)$/

const deny = (reason) => ({ ok: false, reason })

function cleanCommand (value) {
  return String(value || '').trim().replace(/^\/+/, '')
}

/** 命令是否命中 blockedCommands 里的某个前缀（按词边界，避免 ban 误伤 banner）。 */
export function matchesBlocked (command, blocked = []) {
  const base = cleanCommand(command).toLowerCase()
  if (!base) return true
  return blocked.some((prefix) => {
    const p = String(prefix || '').trim().toLowerCase()
    if (!p) return false
    return base === p || base.startsWith(p + ' ')
  })
}

function isSelf (name, player) {
  return String(name || '').toLowerCase() === String(player || '').toLowerCase()
}

function coordInRange (value, axis) {
  if (String(value).startsWith('~')) return true // 相对坐标，只影响自己
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  return axis === 'y' ? n >= -64 && n <= 320 : Math.abs(n) <= 30_000_000
}

function checkGuest (raw, player, allowed) {
  const parts = raw.replace(/\s+/g, ' ').split(' ').filter(Boolean)
  const base = String(parts[0] || '').toLowerCase()
  const rest = parts.slice(1)
  const has = (key) => allowed.includes(key)

  if (base === 'gamemode') {
    if (!has('gamemode')) return deny('普通玩家不能改游戏模式')
    const mode = String(rest[0] || '').toLowerCase()
    if (!GUEST_GAMEMODES.includes(mode)) return deny(`普通玩家只能切 ${GUEST_GAMEMODES.join(' / ')}`)
    if (rest[1] !== undefined && !isSelf(rest[1], player)) return deny('只能改自己的游戏模式')
    if (rest.length > 2) return deny('参数太多了')
    return { ok: true, command: `gamemode ${mode} ${player}`, level: 'guest' }
  }

  if (base === 'tp' || base === 'teleport') {
    if (!has('tp')) return deny('普通玩家不能传送')
    let coords = rest
    if (coords.length === 4) {
      if (!isSelf(coords[0], player)) return deny('只能把自己传送过去')
      coords = coords.slice(1)
    }
    if (coords.length !== 3) return deny('传送要写完整坐标，例如：tp 100 64 200')
    if (!coords.every((v) => COORD_RE.test(v))) return deny('坐标格式不对（只能是数字或 ~）')
    if (!coords.every((v, i) => coordInRange(v, i === 1 ? 'y' : 'xz'))) return deny('坐标超出范围')
    return { ok: true, command: `tp ${player} ${coords.join(' ')}`, level: 'guest' }
  }

  if (base === 'back') {
    if (!has('back')) return deny('普通玩家不能用 back')
    if (rest.length > 1) return deny('back 不带参数')
    if (rest[0] !== undefined && !isSelf(rest[0], player)) return deny('只能回到自己的位置')
    // 具体坐标由 index.mjs 用「上次 tp 前记住的位置」补，不依赖服务器的 /back（RCON 里它需要玩家执行）
    return { ok: true, command: 'back', level: 'guest', kind: 'back' }
  }

  if (base === 'spawn') {
    if (!has('spawn')) return deny('普通玩家不能回出生点')
    if (rest.length > 1) return deny('参数太多了')
    if (rest[0] !== undefined && !isSelf(rest[0], player)) return deny('只能把自己送回出生点')
    // /spawn 在 RCON 里没有执行者，补上玩家名（常见的传送模组都支持 /spawn <玩家>）
    return { ok: true, command: `spawn ${player}`, level: 'guest' }
  }

  if (base === 'list') {
    if (!has('list')) return deny('普通玩家不能查在线')
    if (rest.length) return deny('list 不带参数')
    return { ok: true, command: 'list', level: 'guest' }
  }

  if (base === 'time' && String(rest[0] || '').toLowerCase() === 'query') {
    if (!has('time query')) return deny('普通玩家不能查时间')
    const what = String(rest[1] || '').toLowerCase()
    if (!['daytime', 'gametime', 'day'].includes(what)) return deny('只能查 daytime / gametime')
    return { ok: true, command: `time query ${what}`, level: 'guest' }
  }

  // 面板里明确写死的无参数命令（home、back 之类）：整条命令完全一致才放行
  const full = raw.replace(/\s+/g, ' ').toLowerCase()
  if (allowed.includes(full)) return { ok: true, command: raw, level: 'guest' }
  return deny('这个命令不在普通玩家可用的名单里')
}

/**
 * @param {string} command 模型写出来的命令（不带 /）
 * @param {{player?:string, admin?:boolean, guestCommands?:string[], blocked?:string[]}} opts
 * @returns {{ok:boolean, command?:string, level?:'guest'|'admin', reason?:string}}
 */
export function checkCommand (command, opts = {}) {
  const raw = cleanCommand(command)
  if (!raw) return deny('命令是空的')
  if (raw.length > 300) return deny('命令太长')
  if (/[\r\n]/.test(raw)) return deny('命令里不能有换行')
  if (matchesBlocked(raw, opts.blocked || [])) return deny('这个命令被设为禁止执行')
  if (opts.admin === true) {
    // 管理员说「回去」也走同一套缓存坐标（RCON 里 /back 需要玩家执行）
    if (/^back$/i.test(raw)) return { ok: true, command: 'back', level: 'admin', kind: 'back' }
    return { ok: true, command: raw, level: 'admin' }
  }
  return checkGuest(raw, String(opts.player || ''), Array.isArray(opts.guestCommands) ? opts.guestCommands : [])
}

export { GUEST_GAMEMODES }
