/**
 * session.mjs —— phone 模块全局会话锁
 * 作用：同一时刻最多一个工作区占用手机；后来者排队；后台定时清扫超时会话。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function createSession({ timeoutMs = 900000 })
 *   → { acquire(owner): Promise<{ ok, queued? }>, heartbeat(owner),
 *       release(owner), status(): { owner, queued, since }, dispose() }
 * 清扫：内部每 30s（可注入 sweepMs 供测试加速）检查 now - lastActive > timeoutMs
 *      → 强制释放队首并记日志；定时器 setInterval().unref()，dispose() 可停。
 * 时钟可注入（now 函数），保证测试秒级完成、不真等 30 分钟。
 */

/**
 * 创建会话锁。
 * @param {{timeoutMs?: number, sweepMs?: number, now?: () => number, onSweep?: (info: object) => void}} o
 *   timeoutMs 会话空闲超时（默认 15 分钟）；sweepMs 清扫周期（默认 30000，测试可调短）；
 *   now 时钟注入；onSweep 强断回调（测试/上层日志用）。
 */
export function createSession({ timeoutMs = 900000, sweepMs = 30000, now = Date.now, onSweep = null } = {}) {
  let owner = null // 当前占用者标识
  let since = 0 // 本次占用开始时间
  let lastActive = 0 // 最近一次 heartbeat 时间
  let disposed = false
  const queue = [] // 排队者：{ owner, resolve }

  /** 唤醒队首（若队列非空且锁空闲）。 */
  function wakeNext() {
    if (!owner && queue.length > 0) {
      const next = queue.shift()
      owner = next.owner
      since = now()
      lastActive = since
      next.resolve({ ok: true, queued: true })
    }
  }

  /** 后台清扫：超时的占用者强制释放 + 唤醒队首。 */
  function sweep() {
    if (disposed || !owner) return
    if (now() - lastActive > timeoutMs) {
      const info = { owner, action: 'force-release', idleMs: now() - lastActive }
      owner = null
      if (onSweep) {
        try {
          onSweep(info)
        } catch {
          /* 日志回调异常不影响清扫 */
        }
      }
      wakeNext()
    }
  }

  const timer = setInterval(sweep, sweepMs)
  timer.unref?.() // 不阻止进程退出

  return {
    /** 获取锁：空闲立即授予；被占则进队列并 await 到授予。 */
    acquire(name) {
      if (disposed) return Promise.resolve({ ok: false })
      if (!owner) {
        owner = name
        since = now()
        lastActive = since
        return Promise.resolve({ ok: true, queued: false })
      }
      return new Promise((resolve) => queue.push({ owner: name, resolve }))
    },

    /** 工作区每步调用，刷新最后活跃时间，避免被清扫强断。 */
    heartbeat(name) {
      if (owner === name) lastActive = now()
    },

    /** 释放锁：校验 owner 一致才释放，然后唤醒队首。 */
    release(name) {
      if (owner !== name) return false
      owner = null
      wakeNext()
      return true
    },

    /** 当前状态：占用者 / 队列长度 / 占用开始时间。 */
    status() {
      return { owner, queued: queue.length, since: owner ? since : 0 }
    },

    /** 停止清扫定时器并清空队列（挂到 api.onDispose）。 */
    dispose() {
      disposed = true
      clearInterval(timer)
      // 排队者按未授予结清，避免悬挂
      for (const q of queue.splice(0)) q.resolve({ ok: false })
    },
  }
}
