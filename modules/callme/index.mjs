// 语音通话：让她用自己的 QQ 账号拨 QQ 语音通话（私聊通话 / 群语音），也能挂断。
//
// 做法：Windows 上 QQ NT 的按钮都能被 UI 自动化点到，assets/ 里两个 PowerShell 脚本负责
// 「打开会话 → 点语音通话 →（群通话）搜索并勾选要拉进来的人 → 点确定」和「点退出通话」。
// 模块只管判断该不该拨、防连拨、把参数传下去；判断逻辑本身在 lib/call.mjs，测试不用起脚本。
//
// 只在 Windows + QQ NT 桌面版 + 已登录且屏幕解锁时可用；Mac / 手机 QQ / 网页版都不行。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HANGUP_RE, canHangup, createCallController, hangupReply, wantsCall, wantsGroupCall } from './lib/call.mjs'

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export default {
  id: 'callme',
  name: '语音通话',
  version: '1.0.1',
  api: 1,
  description: 'Windows 上用自己的 QQ 拨语音通话：私聊通话、群语音（自动把 @ 她的人拉进来）、随时挂断',
  defaults: { contact: '', cooldownSec: 60, enabled: false, groupCall: true },
  settings: [
    { key: 'contact', label: '默认联系人（QQ 里的备注/群名片）', type: 'text', placeholder: '留空就用当前聊天对象' },
    { key: 'cooldownSec', label: '两次拨号最短间隔（秒）', type: 'number' },
    { key: 'enabled', label: '关键词自动拨号（关掉＝只由她判断）', type: 'switch' },
    { key: 'groupCall', label: '群里被 @ 说「打群电话」时开群语音', type: 'switch' },
  ],

  setup(api) {
    const log = api.log
    const script = (name) => join(api.dir, 'assets', name)
    const callOut = script('call-out.ps1')
    const hangup = script('hangup.ps1')
    const ready = existsSync(callOut) && existsSync(hangup)
    if (!ready) log.warn('[callme] assets 里少了 call-out.ps1 / hangup.ps1，语音通话用不了')

    const runPs = (file, args) =>
      new Promise((resolve) => {
        if (!existsSync(file)) return resolve(-1)
        const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        child.stdout.on('data', (d) => { out += d.toString() })
        child.stderr.on('data', (d) => { out += d.toString() })
        child.on('error', (error) => {
          log.warn(`[callme] 脚本起不来：${error.message}`)
          resolve(-1)
        })
        child.on('close', (code) => {
          const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')
          log.info(`[callme] ${file.split(/[\\/]/).pop()} 结束 code=${code} ${tail}`)
          resolve(code)
        })
      })

    const call = createCallController({ run: runPs, log })

    api.rule(() =>
      '你手上有个 voice_call 工具，能在电脑上直接拨 QQ 语音通话（需要主人的电脑开着 QQ 并解锁）。' +
      '只有当你判断对方是真的想和你通电话——直说想听你声音陪着、情绪很低需要陪、准备长时间聊——才用。' +
      '光是句子里出现「语音通话」「打电话」几个字，或者群里有人转述、开玩笑、聊功能本身，都不算，别拨。',
    )

    api.tool(({ chat, level }) => {
      if (chat.kind === 'system') return []
      if (chat.kind === 'group' && level !== 'full') return []
      return api.defineTool({
        name: 'voice_call',
        description: '拨一个 QQ 语音通话给对方（在主人的电脑上用 QQ 拨）。只在对方真的想通电话时调用。',
        properties: {
          contact: { type: 'string', description: 'QQ 里的联系人名称，不填就用当前聊天对象' },
        },
        required: [],
        execute: async ({ contact } = {}) => {
          const st = api.settings() || {}
          if (!ready) return { ok: false, message: '这台机器上没有通话脚本（不是 Windows？）' }
          const who = String(contact || st.contact || '').trim()
          return call.request({ contact: who, cooldownSec: st.cooldownSec, callOut })
        },
      })
    })

    // 关键词自动拨号（默认关）
    api.on('message', async (msg) => {
      try {
        const st = api.settings() || {}
        if (!st.enabled || !ready) return false
        const text = String(msg.text || '')
        const isGroup = msg.kind === 'group'

        if (isGroup) {
          if (!wantsGroupCall(text, { mentioned: !!msg.mentioned, groupCall: st.groupCall !== false })) return false
        } else if (!wantsCall(text)) return false

        if (!call.canAutoDial(st.cooldownSec)) return false
        const requester = { userId: msg.userId, chatId: msg.chatId }

        if (isGroup) {
          const name = String(await api.core.hub.groupName(msg.groupId)).trim()
          if (!name) return false
          await api.reply(msg, '好，我在群里开个语音，大家接一下～')
          await call.request({
            contact: name,
            invite: String(msg.nickname || ''),
            inviteQQ: String(msg.userId || ''),
            cooldownSec: st.cooldownSec,
            markRequester: requester,
            callOut,
            awaitResult: true,
          })
        } else {
          const who = String(st.contact || msg.nickname || '').trim()
          if (!who) return false
          await call.request({ contact: who, cooldownSec: st.cooldownSec, markRequester: requester, callOut, awaitResult: true })
        }
        return true
      } catch (error) {
        log.warn('[callme] 出错：' + (error && error.message))
        return false
      }
    })

    // 挂断：主人随时能挂；刚要求发起通话的人也能挂（别人不行）
    api.on('message', async (msg) => {
      const text = String(msg.text || '')
      if (!HANGUP_RE.test(text) || !ready) return false
      const ok = canHangup(
        { userId: msg.userId, kind: msg.kind, role: msg.role, isOwner: api.isOwner },
        call.state().lastRequester,
      )
      if (!ok) return false
      const code = await call.hangup({ hangupScript: hangup })
      await api.sendText(msg.chatId, hangupReply(code))
      return true
    })
  },
}
