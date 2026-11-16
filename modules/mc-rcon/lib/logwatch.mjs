// 跟随服务器日志文件（logs/latest.log），把新增的整行交给回调。
// 为什么不用 RCON 读聊天：RCON 只能「发命令、收回执」，读不到别人聊天；
// 服务器会把聊天写进日志，所以监听日志是纯 RCON 环境下最稳的办法。
// 支持：文件不存在时等待、日志轮转 / 被截断时重开、只读新增内容（不从历史刷屏）。

import { openSync, closeSync, readSync, fstatSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export function createLogWatch (opts = {}) {
  const file = String(opts.path || '')
  const maxChunk = 1024 * 1024

  let fd = null
  let ino = 0
  let offset = 0
  let decoder = new StringDecoder('utf8')
  let partial = ''
  let lines = 0
  let lastReadAt = 0
  let lastError = ''
  let exists = false

  function closeFd () {
    if (fd != null) {
      try { closeSync(fd) } catch (error) {}
      fd = null
    }
    ino = 0
  }

  function openAt (start) {
    closeFd()
    try {
      fd = openSync(file, 'r')
      const st = fstatSync(fd)
      ino = Number(st.ino) || 0
      offset = Math.max(0, Number(start) || 0)
      decoder = new StringDecoder('utf8')
      partial = ''
      exists = true
      lastError = ''
      return true
    } catch (error) {
      lastError = '打不开日志文件：' + error.message
      return false
    }
  }

  /** 读一次；onLine 每收到一行调用一次。 */
  function tick (onLine) {
    if (!file) return
    let st
    try {
      st = statSync(file)
      exists = true
    } catch (error) {
      exists = false
      lastError = '日志文件不存在或读不到：' + file
      closeFd()
      return
    }
    if (fd == null) {
      // 第一次打开：从文件末尾开始，只看之后的新聊天
      openAt(st.size)
      return
    }
    // 日志轮转：文件被换成了另一个（或同一个文件被截断）
    let same = true
    try {
      const cur = fstatSync(fd)
      if (ino && cur.ino && Number(cur.ino) !== ino) same = false
    } catch (error) {
      same = false
    }
    if (!same) {
      openAt(0)
      if (fd == null) return
    }
    if (st.size < offset) {
      // 日志被轮转 / 截断：必须重新打开当前路径，
      // 否则句柄还指着被换掉的旧文件（Windows 上 ino 常常不可靠，只能靠 size 变化认出来）
      if (!openAt(0)) return
    }
    let remaining = st.size - offset
    while (remaining > 0) {
      const size = Math.min(remaining, maxChunk)
      const buf = Buffer.alloc(size)
      let n = 0
      try {
        n = readSync(fd, buf, 0, size, offset)
      } catch (error) {
        lastError = '读日志出错：' + error.message
        closeFd()
        return
      }
      if (n <= 0) break
      offset += n
      remaining -= n
      lastReadAt = Date.now()
      lastError = ''
      partial += decoder.write(buf.subarray(0, n))
      let idx
      while ((idx = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, idx).replace(/\r$/, '')
        partial = partial.slice(idx + 1)
        if (!line) continue
        lines += 1
        try { onLine(line) } catch (error) { lastError = String((error && error.message) || error) }
      }
    }
    // 万一某行特别长（没有换行），别让 partial 无限涨
    if (partial.length > 64 * 1024) {
      const line = partial
      partial = ''
      lines += 1
      try { onLine(line) } catch (error) {}
    }
  }

  function status () {
    return { path: file, exists, offset, lines, lastReadAt, lastError }
  }

  function close () {
    closeFd()
  }

  return { tick, status, close }
}

/**
 * 从一行服务器日志里认出玩家聊天。
 * 兼容：
 *   [00:11:07] [Server thread/INFO]: <Steve> 你好
 *   [13Nov2026 00:11:07.903] [Server thread/INFO] [net.minecraft.../]: <Steve> 你好
 *   [Not Secure] <name> ...
 *   Paper 的 [Async Chat Thread - #0/INFO]: <name> ...
 */
export function parseChatLine (line) {
  if (!line || line.length > 4096) return null
  if (/\[Rcon[\]:]/i.test(line)) return null // 我们自己发命令的回执，不是玩家聊天
  // 先越过时间戳 / 线程名 / 类名这些 [..] 段，再取 <玩家名> 后面的正文
  // 注意：JS 的 . 不匹配 \r，所以这里先去掉行尾 CR，正文用 [^\n]* 收尾
  const m = /\][:：]?[ \t]+(?:\[[^\]]*\][:：]?[ \t]+)*<([^<>\s]{1,32})>[ \t]?([^\n]*)$/.exec(String(line).replace(/\r$/, ''))
  if (!m) return null
  const player = m[1]
  const text = String(m[2] || '').replace(/\u00a7./g, '').trim()
  if (!text) return null
  if (!/^[A-Za-z0-9_]{1,32}$/.test(player)) return null
  return { player, text }
}

// 死亡消息（中英 + 常见模组）的关键词。日志里死亡消息不带 <玩家名>，靠「在线玩家名开头的系统消息」认。
const DEATH_RE = /(死了|被.{0,12}(?:烧死|炸死|射杀|刺死|砸死|砍死|咬死|杀死|打死|击毙|冻死|劈死)|烧死|摔死|淹死|窒息|饿死|冻死|凋零|岩浆|熔岩|从高处摔下|摔了下来|掉出了这个世界|感受到了动能|雷劈|闪电|爆炸|burned to death|fell from a high place|drowned|suffocated in a wall|starved to death|froze to death|withered away|was slain by|was shot by|was blown up by|was killed by|was impaled|was fireballed|was pummeled|was struck by lightning|hit the ground too hard|tried to swim in lava|went up in flames|died from|blew up)/i

/**
 * 从日志里认服务器事件（目前主要认死亡消息）。
 * 只认「在线玩家名开头」的系统消息，避免把「村民被僵尸杀死了」这类当成玩家事件。
 * @returns {{kind:'death', player:string, text:string}|null}
 */
export function parseEventLine (line, onlineNames = []) {
  if (!line || line.length > 4096) return null
  if (line.includes('<')) return null // 玩家聊天走 parseChatLine
  const cut = line.lastIndexOf(']: ')
  if (cut < 0) return null
  const text = line.slice(cut + 3).trim()
  if (!text) return null

  const names = (onlineNames || []).filter((n) => /^[A-Za-z0-9_]{1,32}$/.test(n))
  let player = ''
  let rest = ''
  for (const name of names) {
    if (!text.toLowerCase().startsWith(name.toLowerCase())) continue
    const next = text.charAt(name.length)
    if (next && /[A-Za-z0-9_]/.test(next)) continue
    player = name
    rest = text.slice(name.length).trim()
    break
  }
  if (!player || !rest) return null

  if (DEATH_RE.test(rest)) return { kind: 'death', player, text }
  return null
}
