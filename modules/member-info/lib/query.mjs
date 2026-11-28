// 查询层：把「群号 + QQ 号」变成 OneBot 的数据。
// 只调本机 OneBot 网关（api.onebot → SnowLuma），不访问任何外部网址。

/** 群号和 QQ 号都必须是正整数；顺手把 "1106441882" 这种字符串转成数字。 */
export function toId(value) {
  const n = Number(String(value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * 拉一位群成员的资料。
 * @param {(action:string, params:object)=>Promise<any>} call api.onebot
 * @param {number} groupId
 * @param {number} userId
 * @returns {Promise<{ok:true, info:object}|{ok:false, message:string}>}
 */
export async function fetchMember(call, groupId, userId) {
  try {
    const info = await call('get_group_member_info', {
      group_id: groupId,
      user_id: userId,
      no_cache: false,
    })
    if (!info || !info.user_id) {
      return { ok: false, message: `没查到 ${userId} 的资料（可能不在这个群里）` }
    }
    return { ok: true, info }
  } catch (error) {
    return { ok: false, message: `查不到这位成员：${describeError(error)}` }
  }
}

/**
 * 拉群资料（群名等）。失败不算错 —— 只是少一行「群：xxx」。
 * @returns {Promise<object|null>}
 */
export async function fetchGroup(call, groupId) {
  try {
    const info = await call('get_group_info', { group_id: groupId, no_cache: true })
    return info && (info.group_name || info.name) ? info : null
  } catch {
    return null
  }
}

/** 把 OneBot/网络错误翻成人话。 */
export function describeError(error) {
  // 先取 message；空串时不要 fallback 到 Error 对象本身（String(new Error('')) === 'Error'）
  const msg = String(error?.message ?? '').trim() || String(error ?? '').trim()
  if (!msg || msg === 'Error') return '未知错误'
  if (/not\s*found|不存在|no such/i.test(msg)) return '这个群里没有这个人'
  if (/permission|权限|forbidden|403/i.test(msg)) return '协议端没权限查这个群（机器人得在群里）'
  if (/timeout|timed?\s*out|超时/i.test(msg)) return '协议端没响应，等会儿再试'
  return msg.slice(0, 120)
}

/**
 * 一次查完：成员资料 + 群名，交给调用方格式化。
 * @returns {Promise<{ok:true, info:object, group:object|null}|{ok:false, message:string}>}
 */
export async function queryMember(call, groupId, userId) {
  const gid = toId(groupId)
  const uid = toId(userId)
  if (!gid) return { ok: false, message: '群号不对：需要一个正整数' }
  if (!uid) return { ok: false, message: 'QQ 号不对：需要一个正整数' }

  const member = await fetchMember(call, gid, uid)
  if (!member.ok) return { ok: false, message: member.message }
  const group = await fetchGroup(call, gid)
  return { ok: true, info: member.info, group }
}
