/**
 * safety.mjs —— phone 模块安全闸门
 * 作用：包名白名单 + 滑动窗口限速 + 写操作确认队列 + 操作日志。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function createSafety({ dataDir, getSettings })
 *   getSettings(): { whitelist: string[], rateLimit, confirmWrites, dryRun }（每次动作现读）
 *   → { checkPackage(pkg): {ok, reason?}, checkRate(): Promise<'ALLOW'|'DELAY'>,
 *       isWriteAction(text): boolean,
 *       gate({ pkg, nodeText }): Promise<'ALLOW'|'NEED_CONFIRM'|'DRY_RUN'|'REJECT'>,
 *       listConfirms(), approveConfirm(id), rejectConfirm(id), log(action, detail) }
 * 写操作关键词：发布/发送/评论/回复/点赞/关注/删除/确认/发帖/转发/私信
 * NEED_CONFIRM 时把 { id, pkg, nodeText, at } 写入 dataDir/confirm/ 一个 json 一项；
 * 操作日志按天追加 dataDir/logs/ops-YYYY-MM-DD.log。
 * 判定顺序：REJECT（白名单）→ DRY_RUN → NEED_CONFIRM（写 && confirmWrites 且未批准）→ ALLOW。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 写操作关键词（契约逐字）。 */
const WRITE_KEYWORDS = ['发布', '发送', '评论', '回复', '点赞', '关注', '删除', '确认', '发帖', '转发', '私信']

/** 本地日期（按本机时区）YYYY-MM-DD，用于日志按天分文件。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 生成确认项 id：时间戳+随机，保证唯一。 */
function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 创建安全闸门。
 * @param {{dataDir: string, getSettings: Function, windowMs?: number}} o
 *   windowMs 限速滑动窗口宽（默认 60000，测试可调短）。
 */
export function createSafety({ dataDir, getSettings, windowMs = 60000 } = {}) {
  const confirmDir = join(dataDir, 'confirm')
  const logDir = join(dataDir, 'logs')
  const approvedFile = join(confirmDir, '_approved.json')
  const stamps = [] // 限速滑动窗口：最近动作时间戳（内存态，重启即清零）

  /** 确认目录就绪。 */
  function ensureDirs() {
    mkdirSync(confirmDir, { recursive: true })
    mkdirSync(logDir, { recursive: true })
  }

  /** 读已批准集合：[{pkg, nodeText}]（持久化，跨实例生效）。 */
  function readApproved() {
    try {
      return JSON.parse(readFileSync(approvedFile, 'utf8'))
    } catch {
      return []
    }
  }

  /** 写已批准集合。 */
  function writeApproved(list) {
    ensureDirs()
    writeFileSync(approvedFile, JSON.stringify(list, null, 2))
  }

  const safety = {
    /** 包名白名单校验：白名单空 = 不限制；不在名单 → 拒绝。 */
    checkPackage(pkg) {
      const s = getSettings() || {}
      const wl = (s.whitelist || []).map((x) => String(x).trim()).filter(Boolean)
      if (wl.length === 0) return { ok: true }
      if (!pkg || !wl.includes(pkg)) return { ok: false, reason: `包名不在白名单: ${pkg || '(未知)'}` }
      return { ok: true }
    },

    /**
     * 限速：滑动窗口计数。窗口内已达 rateLimit → 等（DELAY，自动等待到窗口腾出后放行）；
     * 否则记录并放行（ALLOW）。等待用真实计时器，时长受 windowMs 参数控制（测试可秒级）。
     */
    checkRate() {
      const s = getSettings() || {}
      const limit = Number(s.rateLimit) || 0
      const now = Date.now()
      // 清掉窗口外的旧时间戳
      while (stamps.length > 0 && now - stamps[0] >= windowMs) stamps.shift()
      if (limit > 0 && stamps.length >= limit) {
        // 需要等：等最早一条时间戳滑出窗口
        const waitMs = Math.max(0, windowMs - (now - stamps[0]) + 1)
        return new Promise((resolve) => {
          // 不要 unref：调用方正 await 这个计时器。unref 后事件循环可能先空掉，promise 永远不 resolve
          // （CI Linux 上 node --test 会直接判 cancelledByParent：「Promise resolution is still pending
          // but the event loop has already resolved」；生产里同样会悬挂）。
          setTimeout(() => {
            const t = Date.now()
            while (stamps.length > 0 && t - stamps[0] >= windowMs) stamps.shift()
            stamps.push(t)
            resolve('DELAY')
          }, waitMs)
        })
      }
      stamps.push(now)
      return Promise.resolve('ALLOW')
    },

    /** 按关键词判定是否写操作。 */
    isWriteAction(text) {
      const s = String(text || '')
      return WRITE_KEYWORDS.some((k) => s.includes(k))
    },

    /**
     * 综合闸门。返回 'ALLOW' | 'NEED_CONFIRM' | 'DRY_RUN' | 'REJECT'。
     * 顺序：白名单拒绝 → 试运行 → 写操作需确认（且尚未批准过）→ 放行。
     */
    async gate({ pkg, nodeText } = {}) {
      // 1) 白名单
      const cp = safety.checkPackage(pkg)
      if (!cp.ok) return 'REJECT'
      // 2) 试运行：只出计划不真点击（先于确认，避免 dryRun 期间堆积确认项）
      const s = getSettings() || {}
      if (s.dryRun) return 'DRY_RUN'
      // 3) 写操作需主人确认；已批准过的 同包名+同节点文本 直接放行
      if (s.confirmWrites && safety.isWriteAction(nodeText)) {
        const approved = readApproved().some((x) => x.pkg === pkg && x.nodeText === nodeText)
        if (!approved) {
          ensureDirs()
          const item = { id: newId(), pkg, nodeText, at: new Date().toISOString() }
          writeFileSync(join(confirmDir, `${item.id}.json`), JSON.stringify(item, null, 2))
          return 'NEED_CONFIRM'
        }
      }
      return 'ALLOW'
    },

    /** 列出待确认项（confirm/ 目录下一个 json 一项）。 */
    listConfirms() {
      if (!existsSync(confirmDir)) return []
      return readdirSync(confirmDir)
        .filter((f) => f.endsWith('.json') && f !== '_approved.json')
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(confirmDir, f), 'utf8'))
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .sort((a, b) => (a.at < b.at ? -1 : 1))
    },

    /** 批准某确认项：删确认文件 + 记入已批准集合，后续同动作 gate 直接放行。 */
    approveConfirm(id) {
      const file = join(confirmDir, `${id}.json`)
      if (!existsSync(file)) return false
      const item = JSON.parse(readFileSync(file, 'utf8'))
      const approved = readApproved().filter((x) => !(x.pkg === item.pkg && x.nodeText === item.nodeText))
      approved.push({ pkg: item.pkg, nodeText: item.nodeText, at: new Date().toISOString() })
      writeApproved(approved)
      unlinkSync(file)
      return true
    },

    /** 拒绝某确认项：只删文件，不记批准。 */
    rejectConfirm(id) {
      const file = join(confirmDir, `${id}.json`)
      if (!existsSync(file)) return false
      unlinkSync(file)
      return true
    },

    /** 操作日志：按天追加 logs/ops-YYYY-MM-DD.log。返回 Promise，供调用方 .catch 兜底。 */
    async log(action, detail = '') {
      ensureDirs()
      const line = `${new Date().toISOString()}\t${action}\t${String(detail).replace(/\r?\n/g, ' ')}\n`
      appendFileSync(join(logDir, `ops-${localDate()}.log`), line)
    },
  }
  return safety
}
