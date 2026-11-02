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

/** 写操作关键词：中文逐字 + 常见英文（isWriteAction 大小写不敏感）。
 *  宁多勿漏：多弹一次确认无害，漏一个词就是真把帖子发出去了（复审 P0-2）。 */
const WRITE_KEYWORDS = [
  '发布', '发送', '评论', '回复', '点赞', '关注', '删除', '确认', '发帖', '转发', '私信',
  '确定', '同意', '提交', '支付', '付款', '购买', '下单', '充值', '打赏', '卸载', '安装',
  '登录', '登陆', '注册', '绑定', '授权', '开通', '续费', '投币', '收藏', '分享',
  'publish', 'post', 'comment', 'reply', 'like', 'follow', 'delete', 'remove', 'confirm',
  'submit', 'send', 'share', 'pay', 'payment', 'checkout', 'order', 'buy', 'purchase',
  'subscribe', 'renew', 'uninstall', 'install', 'login', 'signin', 'sign up', 'authorize',
]

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
  // 限速滑动窗口改为文件持久化（rate.json）：模块内循环与不同进程共享，重启也不清零（复审第 5 条）

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
      // rate.json 放 dataDir 根，别混进 confirm/——listConfirms 扫的就是那个目录（复审 P1-3）
      const file = join(dataDir, 'rate.json')
      const load = () => {
        try {
          const list = JSON.parse(readFileSync(file, 'utf8'))
          return Array.isArray(list) ? list.filter(Number.isFinite) : []
        } catch { return [] }
      }
      const save = (list) => {
        try { ensureDirs(); writeFileSync(file, JSON.stringify(list.slice(-1000))) } catch { /* 落盘失败就退化为内存态 */ }
      }
      const stamps = load()
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
            const cur = load()
            while (cur.length > 0 && t - cur[0] >= windowMs) cur.shift()
            cur.push(t)
            save(cur)
            resolve('DELAY')
          }, waitMs)
        })
      }
      stamps.push(now)
      save(stamps)
      return Promise.resolve('ALLOW')
    },

    /** 按关键词判定是否写操作（大小写不敏感；英文/支付类词也要拦，复审 P0-2）。 */
    isWriteAction(text) {
      const s = String(text || '').toLowerCase()
      return WRITE_KEYWORDS.some((k) => s.includes(k.toLowerCase()))
    },

    /**
     * 综合闸门。返回 'ALLOW' | 'NEED_CONFIRM' | 'DRY_RUN' | 'REJECT'。
     * 顺序：白名单拒绝 → 试运行 → 写操作需确认（且尚未批准过）→ 放行。
     * blind=true 表示「坐标点击、没有节点文字」：无法判断是不是写操作，按需确认处理（一审 #19-4）。
     */
    async gate({ pkg, nodeText, blind = false } = {}) {
      // 1) 白名单
      const cp = safety.checkPackage(pkg)
      if (!cp.ok) return 'REJECT'
      // 2) 试运行：只出计划不真点击（先于确认，避免 dryRun 期间堆积确认项）
      const s = getSettings() || {}
      if (s.dryRun) return 'DRY_RUN'
      // 3) 写操作需主人确认；已批准过的 同包名+同节点文本 直接放行（但只放行一次，见下）
      if (s.confirmWrites && (safety.isWriteAction(nodeText) || (blind && !nodeText))) {
        const list = readApproved()
        // 复审第 8 条：批准 10 分钟内有效且一次性（命中即消耗）；过期的不再放行
        const fresh = (x) => !x.at || Date.now() - Date.parse(x.at) <= 10 * 60_000
        const i = list.findIndex((x) => x.pkg === pkg && x.nodeText === nodeText && fresh(x))
        if (i >= 0) {
          list.splice(i, 1)
          writeApproved(list)
        } else {
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
