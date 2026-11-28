// 查群成员：给她一个「这个人是谁」的能力。
// 这里只放模块定义和接线，查询/格式化在 lib/ 里。
import { queryMember, toId } from './lib/query.mjs'
import { formatMember } from './lib/format.mjs'

export default {
  id: 'member-info',
  name: '查群成员',
  version: '1.0.0',
  api: 1,
  description: '查某个群里某位成员的身份：群角色、群名片、头衔、加群时间、Q 龄、最后发言。只读本机 OneBot，不访问外部网址。',

  defaults: {
    showLastSend: true,
    showQAge: true,
  },
  settings: [
    { key: 'showLastSend', label: '显示最后发言时间', type: 'switch', hint: '关掉后只报身份和加群时间，少一行' },
    { key: 'showQAge', label: '显示 Q 龄和 QQ 等级', type: 'switch', hint: '有些人不喜欢被扒 Q 龄，可以关掉' },
  ],

  setup(api) {
    const settings = () => api.settings() || {}

    /** 查一次并格式化；返回 { ok, text } 给工具和命令共用。 */
    const look = async (groupId, userId) => {
      const r = await queryMember(api.onebot, groupId, userId)
      if (!r.ok) return { ok: false, text: r.message }
      const s = settings()
      const text = formatMember(r.info, {
        group: r.group,
        showLastSend: s.showLastSend !== false,
        showQAge: s.showQAge !== false,
      })
      return { ok: true, text: text || '这位成员没有任何可以展示的资料' }
    }

    // ---- 工具：她自己判断什么时候用 ----
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'member_info',
        description:
          '查群里某个人的身份：群角色（群主/管理员/普通成员）、群名片、专属头衔、加群时间、Q 龄、最后发言时间。' +
          '有人问「这个人是谁」「他是管理吗」「什么时候进群的」时用。' +
          'groupId 可以省略，默认当前群；userId 必填（QQ 号，数字）。',
        properties: {
          userId: { type: 'string', description: '要查的人的 QQ 号（纯数字）' },
          groupId: { type: 'string', description: '群号，可选；不填就是当前这个群' },
        },
        required: ['userId'],
        execute: async ({ userId, groupId }) => {
          const gid = toId(groupId) || toId(chat.groupId)
          if (!gid) return { ok: false, message: '不知道是哪个群：这功能在群里用，或者把群号一起给我' }
          const r = await look(gid, userId)
          return r.ok ? { ok: true, message: r.text } : { ok: false, message: r.text }
        },
      })
    })

    // ---- 命令：主人手动查（/查人 12345678）----
    api.command({
      name: '查人',
      aliases: ['查成员', '成员'],
      desc: '查群成员身份：/查人 QQ号（可再加群号）',
      run: async (arg, msg) => {
        const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
        const uid = parts[0]
        const gid = parts[1] || msg?.groupId || ''
        if (!uid) return '用法：/查人 QQ号 [群号]'
        if (!toId(gid)) return '这功能在群里用，或者把群号一起写：/查人 QQ号 群号'
        const r = await look(gid, uid)
        return r.text
      },
    })

    // ---- 规则：让她知道有这个本事 ----
    api.rule(() => '你会查群成员：有人问「这个人是谁 / 是不是管理 / 什么时候进的群」时，用 member_info（默认查当前群，也可以指定群号）。查到就照实说，查不到就说没查到，别猜。')
  },
}
