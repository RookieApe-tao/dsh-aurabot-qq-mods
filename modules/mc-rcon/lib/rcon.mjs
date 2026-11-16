// RCON 协议客户端（Minecraft Java 版）。
// 协议：每个包 = [长度 int32][请求 id int32][类型 int32][正文 utf8][两个 0 字节]
//   类型 3 = 登录，类型 2 = 执行命令，类型 0 = 服务器回包。
// 一个连接同一时间只能有一个请求在等回复，所以这里用一条队列串行执行，
// 长回复（服务器分多包发）用「静默 60 毫秒就算收完」的方式拼接。
//
// 这个文件只依赖 node:net，不碰插件内部 API，方便单独测试。

import net from 'node:net'

const TYPE_AUTH = 3
const TYPE_COMMAND = 2
const TYPE_AUTH_RESPONSE = 2 // 认证回包
const TYPE_RESPONSE = 0 // 命令回包

export function createRcon (opts = {}) {
  const host = String(opts.host || '127.0.0.1')
  const port = Number(opts.port) || 25575
  const password = String(opts.password ?? '')
  const timeoutMs = Math.max(1500, Number(opts.timeoutMs) || 8000)
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  let socket = null
  let buffer = Buffer.alloc(0)
  let authed = false
  let lastError = ''
  let connecting = null
  let nextId = 1
  let authWaiter = null
  let collector = null
  let queue = Promise.resolve()
  let retryAfter = 0

  const status = () => ({
    host,
    port,
    connected: Boolean(socket && !socket.destroyed && authed),
    authed,
    lastError,
  })

  function reset (reason) {
    if (reason) lastError = String(reason).slice(0, 300)
    buffer = Buffer.alloc(0)
    authed = false
    if (authWaiter) {
      clearTimeout(authWaiter.timer)
      authWaiter.reject(new Error(lastError || '连接断开'))
      authWaiter = null
    }
    if (collector) {
      clearTimeout(collector.timer)
      collector.reject(new Error(lastError || '连接断开'))
      collector = null
    }
    const s = socket
    socket = null
    if (s) { try { s.destroy() } catch (error) {} }
  }

  function writePacket (id, type, body) {
    if (!socket || socket.destroyed) throw new Error('RCON 还没连上')
    const payload = Buffer.from(String(body ?? ''), 'utf8')
    const len = 4 + 4 + payload.length + 2
    const buf = Buffer.alloc(4 + len) // 末尾两个 0 已经由 alloc 保证
    buf.writeInt32LE(len, 0)
    buf.writeInt32LE(id, 4)
    buf.writeInt32LE(type, 8)
    payload.copy(buf, 12)
    socket.write(buf)
  }

  function auth () {
    return new Promise((resolve, reject) => {
      const id = nextId++
      authWaiter = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!authWaiter) return
          authWaiter = null
          reject(new Error('RCON 认证超时'))
        }, timeoutMs),
      }
      writePacket(id, TYPE_AUTH, password)
    })
  }

  function finishCollector () {
    const c = collector
    if (!c) return
    collector = null
    clearTimeout(c.timer)
    c.resolve(c.parts.join('\n').trim())
  }

  function onPacket (packet) {
    const { id, type, body } = packet
    if (authWaiter && id === authWaiter.id && type === TYPE_AUTH_RESPONSE) {
      const w = authWaiter
      authWaiter = null
      clearTimeout(w.timer)
      if (id === -1) {
        authed = false
        lastError = 'RCON 密码错误'
        w.reject(new Error(lastError))
      } else {
        authed = true
        lastError = ''
        w.resolve()
      }
      return
    }
    if (collector && id === collector.id && type === TYPE_RESPONSE) {
      collector.parts.push(body)
      clearTimeout(collector.timer)
      // 服务器可能把长回复拆成多个包；安静一小会儿再算收完
      collector.timer = setTimeout(finishCollector, 60)
    }
  }

  function onData (chunk) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const len = buffer.readInt32LE(0)
      if (len < 10 || len > 8 * 1024 * 1024) {
        // 流错位了，断开重来，别越读越乱
        reset('RCON 回包格式不对，连接已重置')
        return
      }
      if (buffer.length < 4 + len) return
      const id = buffer.readInt32LE(4)
      const type = buffer.readInt32LE(8)
      const body = buffer.subarray(12, 4 + len - 2).toString('utf8')
      buffer = buffer.subarray(4 + len)
      onPacket({ id, type, body })
    }
  }

  function connect () {
    if (socket && !socket.destroyed && authed) return Promise.resolve()
    if (connecting) return connecting
    if (Date.now() < retryAfter) return Promise.reject(new Error(lastError || '刚连失败，稍后再试'))
    connecting = new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port })
      socket = s
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reset(`连接 ${host}:${port} 超时`)
        retryAfter = Date.now() + 30000
        reject(new Error(lastError))
      }, timeoutMs)

      s.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        s.on('error', (error) => {
          log('RCON 连接出错：' + error.message)
          reset(error.message)
          retryAfter = Date.now() + 30000
        })
        s.on('close', () => {
          if (socket === s) {
            reset('RCON 连接被关闭')
            retryAfter = Date.now() + 30000
          }
        })
        s.on('data', onData)
        auth().then(resolve, (error) => {
          reset(error.message)
          retryAfter = Date.now() + 30000
          reject(error)
        })
      })
      s.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reset(error.message)
        retryAfter = Date.now() + 30000
        reject(error)
      })
    }).finally(() => { connecting = null })
    return connecting
  }

  function sendCommand (command) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      const c = { id, parts: [], resolve, reject, timer: null }
      collector = c
      c.timer = setTimeout(() => {
        if (collector === c) {
          collector = null
          reject(new Error(`RCON 执行超时：${String(command).slice(0, 40)}`))
        }
      }, timeoutMs)
      try {
        writePacket(id, TYPE_COMMAND, command)
      } catch (error) {
        collector = null
        clearTimeout(c.timer)
        reject(error)
      }
    })
  }

  /** 执行一条命令，自动重连一次；返回服务器的文字回执。 */
  function exec (command) {
    const run = async () => {
      await connect()
      return sendCommand(String(command))
    }
    const p = queue.then(run, run)
    queue = p.then(() => {}, () => {})
    return p
  }

  function close () {
    reset('')
  }

  return { exec, close, status }
}
