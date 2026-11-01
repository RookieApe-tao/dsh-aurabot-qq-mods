/**
 * DSH 人设与风格（dsh-persona）—— 把一张人格连同思考/回复风格注入 DSH 的所有会话。
 *
 * 来源/许可：MIT。作用/契约：
 *   - 不改变大肥鱼 QQ 聊天管线用的人格（{{aurabot_persona}} 原样不动）；
 *   - 经 api.dsh.systemPrompt 注册全局追加人格段（排在内置 persona 之后，dsh-cosplay 的段之后），
 *     变量每次组装提示词时实时求值：关掉开关或卸载模块即撤销注入，无残留；
 *   - 默认未启用（不注入任何内容）；面板改动先暂存，点「确认生效」才写进设置；
 *   - 思考风格文案来自 DeepSeek 训练位提示词（上游参考
 *     https://github.com/victorchen96/deepseek_v4_rolepaly_instruct），概率性触发属已知权衡。
 */

/** 思维链指令文案：neutral=思考保持分析只在回复扮演；role=思考也角色化。 */
const THINKING_DIRECTIVES = {
  neutral:
    '【思维模式要求】在你的思考过程（<think>标签内）中，请遵守以下规则：\n' +
    '1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可\n' +
    '2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代\n' +
    '3. 思考内容应聚焦于任务和回复内容规划，不要在思考中进行角色扮演式的内心戏表演',
  role:
    '【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：\n' +
    '1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)"\n' +
    '2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等\n' +
    '3. 思考内容应沉浸在角色中，通过内心独白分析情况和规划回复',
}

/** 精简人设要保留的节：标题命中这些关键词的节（怎么说话 / 语气 / 打字习惯这类）。 */
const REPLY_SECTION_RE = /说话|语气|口吻|打字|聊天|回复|风格/

/** 按【标题】行把人格正文拆成 开场(lead) + 一节一节的正文（和面板人格页的分节同一套约定）。 */
export function splitPersonaSections(body) {
  const lead = []
  const secs = []
  let cur = null
  for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^\s*【(.+?)】\s*$/)
    if (m) { cur = { title: m[1].trim(), lines: [] }; secs.push(cur); continue }
    ;(cur ? cur.lines : lead).push(line)
  }
  return {
    lead: lead.join('\n').trim(),
    secs: secs.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })).filter((s) => s.text),
  }
}

/**
 * 渲染要注入 DSH 的人格文本。
 *   replyStyle 'full' = 人格全文；'lite' = 开场 + 「怎么说话」类短节（抽出来太短说明这张卡没按
 *   【标题】分节写，退回全文，免得把人格砍没）。
 *   thinkingStyle 'neutral'|'role' = 在末尾追加对应的思维链指令；其他值跳过。
 */
export function dshPersonaText(body, { thinkingStyle = 'neutral', replyStyle = 'full' } = {}) {
  const text = String(body || '').trim()
  if (!text) return ''
  let persona = text
  if (replyStyle === 'lite') {
    const { lead, secs } = splitPersonaSections(text)
    const picked = secs.filter((s) => REPLY_SECTION_RE.test(s.title))
    const lite = [lead, ...picked.map((s) => `【${s.title}】\n${s.text}`)].filter(Boolean).join('\n\n')
    if (lite.length >= 20) persona = lite
  }
  const directive = THINKING_DIRECTIVES[thinkingStyle] || ''
  return directive ? `${persona}\n${directive}` : persona
}

/** 设置的合法值与默认值（module.json 的 defaults 与这里保持一致）。 */
export const DEFAULT_STYLE = { enabled: false, personaId: '', thinkingStyle: 'neutral', replyStyle: 'full' }

/** 把任意来源的设置规整成合法值（认不出的回落默认）。 */
export function normalizeStyle(s = {}) {
  const v = s && typeof s === 'object' ? s : {}
  return {
    enabled: v.enabled === true,
    personaId: typeof v.personaId === 'string' ? v.personaId : '',
    thinkingStyle: v.thinkingStyle === 'role' ? 'role' : 'neutral',
    replyStyle: v.replyStyle === 'lite' ? 'lite' : 'full',
  }
}

export default {
  id: 'dsh-persona',
  name: 'DSH 人设与风格',
  version: '1.0.0',
  api: 1,
  description: '把一张人格连同思考/回复风格注入 DSH 的所有会话（像 dsh-cosplay），不改变大肥鱼 QQ 聊天用的人格。默认不注入，关掉即撤销。',
  settings: [], // 面板走 panel.js 自绘（下拉框 + 风格按钮 + 确认生效），不用自动表单
  panel: 'panel.js',
  defaults: DEFAULT_STYLE,
  setup(api) {
    const readStyle = () => normalizeStyle(api.settings())
    /** 当前应注入的文本：未启用 = 空串（撤销注入）；personaId 空 = 跟随当前人格。 */
    const renderNow = () => {
      try {
        const s = readStyle()
        if (s.enabled !== true) return ''
        const personas = api.core?.personas
        if (!personas) return ''
        const body = s.personaId ? personas.read?.(s.personaId)?.body : personas.current?.()
        return dshPersonaText(body, { thinkingStyle: s.thinkingStyle, replyStyle: s.replyStyle })
      } catch (e) {
        api.log?.warn?.(`[dsh-persona] 人格渲染失败，本轮跳过注入：${e.message}`)
        return ''
      }
    }
    // 变量名/段名特意和内核版、dsh-cosplay 错开：同时装了也不互相覆盖（只是会叠加人设，别同时开）
    // variable()/section() 都返回注销函数：模块停用/重载时必须注销，否则重载时会报「already registered」
    const offVariable = api.dsh.systemPrompt.variable('aurabot_ext_dsh_persona', renderNow)
    const offSection = api.dsh.systemPrompt.section?.({
      name: 'aurabot-ext-dsh-persona',
      order: 10270, // 内置 persona 后缀段 10200、dsh-cosplay 追加段 10250 之后
      text: '{{aurabot_ext_dsh_persona}}',
    })
    api.onDispose(() => {
      try { offSection?.() } catch {}
      try { offVariable?.() } catch {}
    })

    // 面板数据：当前设置 + 可选人格列表 + 当前正在用的人格 id
    // 错误日志约定：与仓库其他模块一致，走插件宿主日志（api.log.*），不单独写错误日志文件
    api.route('/state', async () => {
      try {
        const personas = (api.core?.personas?.list?.() || []).map((p) => ({ id: p.id, name: p.name, tags: p.tags || [] }))
        return { ok: true, style: readStyle(), personas, current: api.config()?.persona?.current || '' }
      } catch (e) {
        api.log?.warn?.(`[dsh-persona] /state 读取失败：${e.message}`)
        return { ok: false, message: e.message }
      }
    })
  },
}
