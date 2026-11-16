// 自动找「正在运行的那套服务端」。
// 纯 RCON 没法问服务器「你是谁」，所以靠三样东西一起判断：
//   1. 读每个服务器目录的 server.properties（rcon 端口 / 密码 / 是否开 RCON）；
//   2. 看 logs/latest.log 的修改时间（真正在跑的服一直在写日志）；
//   3. 用读到的端口和密码试连一次 RCON、跑 list（能连通说明这个端口背后有服）。
// 多个服共用同一个 RCON 端口时（很常见，都抄的 25575），用日志时间最新的那个胜出。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createRcon } from './rcon.mjs'

/** 读 server.properties（Java properties 的简单子集：key=value，忽略 # 注释）。 */
export function readProperties (file) {
  const out = {}
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i < 0) continue
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
  } catch (error) {}
  return out
}

/** 日志文件多久没更新了（毫秒）；不存在返回 Infinity。 */
export function logAgeMs (file) {
  try {
    return Math.max(0, Date.now() - statSync(file).mtimeMs)
  } catch (error) {
    return Infinity
  }
}

/** 扫描一个根目录（根目录自己也算一个候选），返回所有带 server.properties 的服务器。 */
export function scanServers (root) {
  const out = []
  const seen = new Set()
  const add = (dir, name) => {
    if (!dir || seen.has(dir)) return
    const props = readProperties(join(dir, 'server.properties'))
    if (!Object.keys(props).length) return
    seen.add(dir)
    const logPath = join(dir, 'logs', 'latest.log')
    out.push({
      dir,
      name: name || basename(dir),
      serverPort: Number(props['server-port']) || 25565,
      host: '127.0.0.1',
      port: Number(props['rcon.port']) || 25575,
      password: props['rcon.password'] || '',
      rconEnabled: String(props['enable-rcon'] || '').toLowerCase() === 'true',
      logPath,
      logAgeMs: logAgeMs(logPath),
    })
  }
  add(root, basename(root))
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) add(join(root, e.name), e.name)
    }
  } catch (error) {}
  return out
}

/** 试连一次 RCON 并跑 list；2.5 秒内没结果就算不通。 */
export async function testRcon (candidate, timeoutMs = 2500) {
  if (!candidate || !candidate.rconEnabled) return { ok: false, reason: '没有开启 RCON' }
  const client = createRcon({
    host: candidate.host || '127.0.0.1',
    port: candidate.port,
    password: candidate.password || '',
    timeoutMs,
  })
  try {
    const out = await client.exec('list')
    return { ok: true, out: String(out || '') }
  } catch (error) {
    return { ok: false, reason: error.message }
  } finally {
    client.close()
  }
}
