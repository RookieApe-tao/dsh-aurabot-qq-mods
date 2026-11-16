// 语音通话的判断逻辑与防连拨状态机，跟 api 和 PowerShell 都解耦，方便离线测试。
//
// 分工：
//   - 这里的正则只判断「用户是不是在表达想打电话」；
//   - 真正拨不拨，私聊时由她自己判断（voice_call 工具），关键词自动拨号默认关闭；
//   - 起 powershell 的动作由外部传进来的 run(file, args) 做，测试里注入假的。

export const CALL_RE = /(打(个|一个)?电话|打电话|打给我|拨(个|一下)?(电话|号)?|语音通话|来个?电话|来电话|呼叫|连个?线|call\s*me)/i
export const NO_RE = /(别打|不要打|不用打|不想打|甭打|先不打|打不了|别来电|禁用)/
export const GROUP_CALL_RE = /(打(个|一个)?群(电话|语音|通话)|群(里)?(打个|开个|来|整个|搞个|开一个)(电话|语音|通话)|开(个)?群(语音|通话)|来个?群(语音|通话)|全员(语音|通话)|打个群电话)/
export const HANGUP_RE = /(挂了|挂断|挂掉|挂了吧|结束通话|别打了|先挂了|把电话挂了|挂电话)/

/** 文本里是不是在说「想打个电话」（否定句不算）。 */
export function wantsCall(text) {
  const t = String(text || '').trim()
  if (!t || NO_RE.test(t)) return false
  return CALL_RE.test(t)
}

/** 群里要「打群电话」：必须被 @，且开了 groupCall 开关。 */
export function wantsGroupCall(text, { mentioned = false, groupCall = true } = {}) {
  const t = String(text || '').trim()
  if (!groupCall || !mentioned || !t) return false
  if (NO_RE.test(t)) return false
  return GROUP_CALL_RE.test(t)
}

/** 挂断这句话该不该执行：主人随时能挂；刚要求发起通话的人 2 小时内也能挂。 */
export function canHangup({ userId, kind, role, isOwner } = {}, lastRequester, now = Date.now()) {
  const owner = (typeof isOwner === 'function' && isOwner(userId)) || (kind === 'private' && role === 'owner')
  if (owner) return true
  if (!lastRequester) return false
  const fresh = now - lastRequester.at < 2 * 3600_000
  return fresh && String(lastRequester.userId) === String(userId)
}

/** 挂断脚本的退出码 → 回话。0 才算真挂上，其它（没脚本、脚本失败）都说没在通话中。 */
export function hangupReply(code) {
  return Number(code) === 0 ? '挂啦～' : '我这儿好像没在通话中'
}

/**
 * 生成 call-out.ps1 的参数数组（纯函数，测试友好）。
 * 每个值始终是独立参数交给 spawn，不在外面拼命令字符串——联系人里带空格、引号、$ 都不会被拆开或展开。
 */
export function buildCallArgs({ contact = '', invite = '', inviteQQ = '' } = {}) {
  const args = ['-Contact', String(contact)]
  if (invite) args.push('-Invite', String(invite))
  if (inviteQQ) args.push('-InviteQQ', String(inviteQQ))
  return args
}

/**
 * 拨号状态机。
 * @param {object} o
 * @param {(file: string, args: string[]) => Promise<number>} o.run 起脚本，返回退出码
 * @param {{info: Function, warn: Function}} o.log
 * @param {() => number} [o.now] 时间源（测试可注）
 */
export function createCallController({ run, log, now = () => Date.now() }) {
  let lastDialAt = 0
  let dialing = false
  let lastRequester = null

  const cooldownLeft = (cooldownSec) => {
    const ms = Math.max(10, Number(cooldownSec) || 60) * 1000
    return Math.max(0, lastDialAt + ms - now())
  }

  /** 主动拨号（工具路径）：返回 {ok, message}。 */
  async function request({ contact = '', invite = '', inviteQQ = '', cooldownSec = 60, callOut, markRequester = null, awaitResult = false } = {}) {
    if (dialing) return { ok: false, message: '上一个电话还没挂呢' }
    const left = cooldownLeft(cooldownSec)
    if (left > 0) return { ok: false, message: `刚打过，${Math.ceil(left / 1000)} 秒后再打` }
    const who = String(contact || '').trim()
    if (!who) return { ok: false, message: '不知道该打给谁，先在设置里填默认联系人' }
    lastDialAt = now()
    if (markRequester) lastRequester = { ...markRequester, at: now() }
    const task = dial({ contact: who, invite, inviteQQ, callOut })
    if (awaitResult) await task
    return { ok: true, message: `拨号已经发出去了（${who}）` }
  }

  async function dial({ contact, invite = '', inviteQQ = '', callOut }) {
    const args = buildCallArgs({ contact, invite, inviteQQ })
    log.info(`[callme] 发起语音通话 -> ${contact}${invite ? `（拉 ${invite} 进来）` : ''}`)
    dialing = true
    try {
      return await run(callOut, args)
    } finally {
      dialing = false
    }
  }

  /** 关键词自动拨号前的闸门：正在拨 / 冷却中就别拨。 */
  function canAutoDial(cooldownSec) {
    if (dialing) return false
    return cooldownLeft(cooldownSec) <= 0
  }

  /** 记下这次是「谁」要求的，之后他也算能挂断。 */
  function touch(requester) {
    lastRequester = requester ? { ...requester, at: now() } : null
  }

  async function hangup({ hangupScript }) {
    const code = await run(hangupScript, [])
    if (code === 0) lastRequester = null
    return code
  }

  const state = () => ({ lastDialAt, dialing, lastRequester })
  return { request, canAutoDial, touch, hangup, cooldownLeft, state }
}
