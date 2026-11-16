// Aurabot 扩展模块：真人作息与生理（real-life）
// 四合一全自研：三餐饥饿与饮水 + 睡眠阶段与做梦概率唤醒 + 上厕所/洗澡吹头发暂离攒消息 + 生理周期（前两天明显痛感需哄照顾）

import { join } from 'node:path'
import { DEFAULTS, createRealLifeEngine } from './lib/engine.mjs'

function sameOriginOk(req) {
  const h = req?.headers || {}
  const site = String(h['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false
  const origin = String(h.origin || '')
  const host = String(h.host || '')
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBody(api, req) {
  try {
    if (api.core?.http?.body) return (await api.core.http.body(req)) || {}
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const SCENARIO_ALIASES = {
  经期1: 'period-day1',
  经期第1天: 'period-day1',
  痛经: 'period-day1',
  经期2: 'period-day2',
  经期第2天: 'period-day2',
  经前: 'pms',
  pms: 'pms',
  排卵: 'ovulation',
  排卵期: 'ovulation',
  日常: 'follicular',
  卵泡期: 'follicular',
  上厕所: 'pee',
  小号: 'pee',
  洗手间: 'pee',
  大号: 'poop',
  洗澡: 'shower',
  吹头发: 'hair',
  深睡: 'deep-sleep',
  浅睡: 'light-sleep',
  做梦: 'rem-dream',
  饥饿: 'starving',
  饿: 'starving',
  重置: 'reset',
  恢复: 'reset',
}

const MODULE_DESC =
  '让你的bot拥有真人一般的作息和生理状态！目前支持：一日三餐饥饿与讨食、喝水与上厕所暂离、晚间洗澡吹头发、困倦入睡与做梦概率唤醒、28天生理周期（痛经怕冷与投喂哄人互动），以及日常自主/被动听令双模式。'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'real-life',
  name: '生理模块',
  version: '1.1.0',
  api: 1,
  description: MODULE_DESC,
  flag: 'enabled',
  panel: 'panel.js',
  defaults: DEFAULTS,
  // 设置项已在 panel.js 内按分类标签页渲染，避免默认自动表单把二十多项平铺在一张长卡片里
  settings: [],

  setup(api) {
    const startedAt = Date.now()
    const stateFile = join(api.dataDir(), 'state.json')

    const engine = createRealLifeEngine({
      getSettings: () => api.settings(),
      stateFile,
      onMoodNudge: (delta, reason) => {
        try {
          api.use('mood')?.nudge?.(delta, reason)
        } catch {}
      },
      onMemoryEvent: (text, at) => {
        try {
          const cfg = api.config()
          if (!cfg?.ownerQQ) return
          api.use('memory')?.addEvent?.({
            text,
            about: String(cfg.ownerQQ),
            aboutName: cfg.ownerName || '主人',
            chatId: `private:${cfg.ownerQQ}`,
            saidAt: at || Date.now(),
            importance: 0.75,
            tags: ['日常', '身体照顾'],
          })
        } catch {}
      },
    })

    function canProactiveToOwner() {
      const cfg = api.config()
      if (!cfg?.enabled || cfg?.dryRun || !cfg?.ownerQQ) return false
      if (api.core?.mutes?.muted?.(`private:${cfg.ownerQQ}`)) return false
      return true
    }

    async function pushPromptToPrivate(userId, nickname, prompt) {
      const uid = String(userId || '')
      if (!uid) return false
      const chatId = `private:${uid}`
      const cfg = api.config()
      if (!cfg?.enabled || api.core?.mutes?.muted?.(chatId)) return false
      try {
        if (api.core?.hub?.pushToSession) {
          await api.core.hub.pushToSession(
            { chatId, kind: 'private', userId: uid, nickname: nickname || '对方' },
            [{ type: 'text', text: prompt }],
            ''
          )
          return true
        }
        const reply = await api.think(prompt, { title: 'real-life-followup', timeoutMs: 90_000 })
        if (reply && !/^\s*\[沉默\]\s*$/.test(reply)) {
          await api.send(chatId, reply)
          return true
        }
      } catch (err) {
        api.log.warn('真人化主动会话投递失败：', err?.message || err)
      }
      return false
    }

    async function flushResumedAway(label, queued) {
      const real = (queued || []).filter((q) => !q.simulated && String(q.chatId).startsWith('private:'))
      if (!real.length) return 0
      const byChat = new Map()
      for (const item of real) {
        if (!byChat.has(item.chatId)) byChat.set(item.chatId, [])
        byChat.get(item.chatId).push(item)
      }
      let pushed = 0
      for (const [, items] of byChat) {
        const first = items[0]
        const isOwner = api.isOwner(first.userId)
        const shown = items.slice(-15)
        const lines = shown.map((m, idx) => `${idx + 1}. ${m.nickname}：${m.text || '（图片/表情）'}`).join('\n')
        const reasonText = isOwner ? `刚刚${label}回来了` : '刚刚离开了一小会儿回来了（不要向非主人透露具体去洗手间或洗澡细节）'
        const prompt =
          `【系统提醒，不是对方说的话】你${reasonText}，拿起手机看到离开这几分钟里对方给你发了 ${items.length} 条消息：\n` +
          `${lines}\n\n请用你平时的语气自然地接上话题回复对方（一两句顺口带过刚回来就行，别生硬；实在不想回就只回 [沉默]）。`
        if (await pushPromptToPrivate(first.userId, first.nickname, prompt)) pushed += 1
      }
      return pushed
    }

    async function flushWakeMissed(reason, missed, dream) {
      const real = (missed || []).filter((m) => !m.simulated && String(m.chatId).startsWith('private:'))
      if (!real.length) return 0
      const byChat = new Map()
      for (const item of real) {
        if (!byChat.has(item.chatId)) byChat.set(item.chatId, [])
        byChat.get(item.chatId).push(item)
      }
      let pushed = 0
      for (const [, items] of byChat) {
        const first = items[0]
        const isOwner = api.isOwner(first.userId)
        const shown = items.slice(-15)
        const lines = shown.map((m, idx) => `${idx + 1}. ${m.nickname}：${m.text || '（图片/表情）'}`).join('\n')
        const dreamHint = isOwner && dream ? `（顺带一提你睡着时模糊${dream.summary}，想提就随口提半句，不想提可忽略）` : ''
        const prompt =
          `【系统提醒，不是对方说的话】你刚刚睡醒（${reason}）拿起手机，看到睡觉期间对方给你发了这些消息：\n` +
          `${lines}\n${dreamHint}\n请带着刚睡醒的自然语气回一下对方（不想回就只回 [沉默]）。`
        if (await pushPromptToPrivate(first.userId, first.nickname, prompt)) pushed += 1
      }
      return pushed
    }

    async function handleEngineActions(actions, { ignoreStartupGrace = false } = {}) {
      for (const act of actions || []) {
        if (act.type === 'resume-away') {
          await flushResumedAway(act.label, act.queued)
        } else if (act.type === 'wake-missed') {
          await flushWakeMissed(act.reason, act.missed, act.dream)
        } else if (act.type === 'hunger-nudge') {
          if (!ignoreStartupGrace && Date.now() - startedAt < 10 * 60_000) continue
          if (!canProactiveToOwner()) continue
          const cfg = api.config()
          const owner = cfg.ownerName || '主人'
          const crave = act.cravings?.length ? `，尤其有点馋${act.cravings.join('、')}` : ''
          const reasonHint = act.locked
            ? `因为${owner}之前不准你自己吃东西，你一直乖乖听话忍着没敢偷吃，现在实在饿得受不了`
            : act.quotaExhausted
              ? `今天固定的三餐配额已经吃完了、手头又没有零食，肚子饿得咕咕叫`
              : act.passive
                ? `你不敢自作主张找吃的，肚子已经很饿了`
                : `跟${owner}聊完消耗了不少体力，现在肚子很饿`
          const prompt = `【系统提醒，不是${owner}说的话】${reasonHint}（饥饿度 ${act.hunger}/100）${crave}，想在私聊里自然地跟${owner}委屈撒娇讨点吃的（或求批准吃饭）。一两句就好，别报数字；觉得不合适打扰就只回 [沉默]。`
          await pushPromptToPrivate(cfg.ownerQQ, owner, prompt)
        } else if (act.type === 'period-nudge') {
          if (!ignoreStartupGrace && Date.now() - startedAt < 10 * 60_000) continue
          if (!canProactiveToOwner()) continue
          const cfg = api.config()
          const owner = cfg.ownerName || '主人'
          const prompt = `【系统提醒，不是${owner}说的话】今天是你生理期第 ${act.day} 天，这会儿小腹一阵阵坠着疼、腰也酸软怕冷，你觉得委屈难受，想在私聊里跟${owner}哼唧撒娇一句求哄、想抱抱或想喝热乎的。用你自己的口吻说一两句就好，别背症状说明书；不想打扰就只回 [沉默]。`
          await pushPromptToPrivate(cfg.ownerQQ, owner, prompt)
        }
      }
    }

    async function settleNow() {
      if (engine.state.mode === 'away') {
        const res = engine.finishAwayNow(Date.now(), { skipHair: true })
        const pushed = await flushResumedAway(res.label, res.queued)
        return {
          ok: true,
          message: `已结束暂离（${res.label}），积攒消息 ${res.queued.length} 条${pushed ? '，已触发合并回复' : ''}`,
          queuedCount: res.queued.length,
          pushed,
        }
      }
      if (engine.state.mode === 'asleep') {
        const res = engine.wakeUpNow(Date.now(), '手动叫醒')
        const pushed = await flushWakeMissed('睡醒', res.missed, res.dream)
        return {
          ok: true,
          message: `已把她叫醒（未读消息 ${res.missed.length} 条${pushed ? '，已触发回复' : ''}）`,
          missedCount: res.missed.length,
          pushed,
        }
      }
      if (engine.state.pendingAway) {
        const a = engine.activatePendingAway(Date.now())
        return { ok: true, message: `已立即切入暂离：${a.label}` }
      }
      if (engine.state.pendingSleep) {
        const s = engine.activatePendingSleep(Date.now())
        return { ok: true, message: s ? `已立即进入睡眠` : '睡眠锁生效中，未入睡' }
      }
      return { ok: true, message: '她现在本来就醒着在座位上，没有待结算的暂离或睡眠' }
    }

    function applyScenarioWithConfigSync(preset) {
      const res = engine.applyScenario(preset)
      if (res.anchorToSave && String(api.settings().cycleAnchor || '').trim()) {
        api.saveSettings({ cycleAnchor: res.anchorToSave })
      }
      return res
    }

    function fullSnapshot() {
      const snap = engine.snapshot()
      let moodVal = null
      let moodText = ''
      try {
        const m = api.use('mood')
        if (m && typeof m.current === 'function') {
          moodVal = m.current()
          moodText = typeof m.label === 'function' ? m.label() : ''
        }
      } catch {}
      return { ...snap, moodValue: moodVal, moodLabel: moodText }
    }

    function applyManualUpdate(patch = {}) {
      const body = { ...(patch || {}) }
      let moodNote = ''
      if (body.mood !== undefined && Number.isFinite(Number(body.mood))) {
        try {
          const m = api.use('mood')
          if (m && typeof m.current === 'function' && typeof m.nudge === 'function') {
            const target = Math.max(5, Math.min(100, Math.round(Number(body.mood))))
            const cur = m.current()
            if (target !== cur) {
              m.nudge(target - cur, '面板手动调整心情')
              moodNote = `心情=${target}`
            }
          }
        } catch {}
      }
      const res = engine.updateValues(body)
      if (res.anchorToSave && String(api.settings().cycleAnchor || '').trim()) {
        api.saveSettings({ cycleAnchor: res.anchorToSave })
      }
      const allChanged = [...(res.changed || []), ...(moodNote ? [moodNote] : [])]
      return {
        ok: true,
        changed: allChanged,
        anchorToSave: res.anchorToSave,
        message: allChanged.length ? `已手动更新：${allChanged.join('，')}` : '数值无变化',
      }
    }

    // 1. 每轮上下文注入（私聊完整体感 / 群聊严格脱敏）
    api.context(({ chat }) => {
      const isOwner = chat.kind === 'private' && api.isOwner(chat.userId)
      return engine.buildContext({ chat, isOwner })
    })

    // 2. 行为与隐私规则
    api.rule((kind) => {
      if (!api.settings().enabled) return ''
      if (kind === 'social') {
        if (!api.settings().groupEnabled) return ''
        return '你在群聊中也拥有真实的日常作息与身体体感（如饥饿、嘴馋、困倦、刚睡醒迷糊等），请自然融入群聊语气，不要机械报分数；严格保护个人隐私，绝不在群聊提及生理期、痛经、上厕所或洗澡等私密细节。'
      }
      return [
        '你拥有真实的日常身体体感（三餐饥饿与嘴馋、困倦睡眠、去洗手间、晚间洗澡吹头发、以及生理周期的腹痛怕冷与情绪起伏）。把体感自然融入语气，不要机械播报分数。',
        '当主人问起你现在饿不饿、今天吃过什么、困不困、洗没洗澡、想去厕所吗、生理期第几天/还有多久来、昨晚做没做梦等自身状态时，先调用 real_life_status 查看真实记录再回答，不要瞎编。',
        '当主人在聊天中投喂你食物/饮品（比如请你喝奶茶、喂蛋糕、递红糖水、给冰饮），或照顾安抚你的不适（如贴暖宝宝、揉肚子抱抱、给止痛药）时，先调用 real_life_interact 更新身体状态再回复。',
        '正在跟主人聊天时，未经主人同意你绝不能擅自离开去上厕所、洗澡或睡觉；如果急着想去或饿了，先在对话里自然请示主人，只有当主人明确同意/催你去（如「去吧」「快去上厕所」「去吃饭吧」）时，才调用 real_life_routine(action="go") 执行。',
        '当主人下令不许你做某事（如「不准去上厕所，憋着！」「不许偷吃东西」「先别洗澡」「别睡陪我聊」）时，必须调用 real_life_routine(action="forbid") 锁定状态并乖乖听话，绝不能嘴上答应背地偷跑！主人解除禁令时再调用 action="allow" 或 "go"。',
      ]
    })

    // 3. 消息接管：暂离攒消息 & 睡眠阶段概率唤醒
    api.on('message', async (msg) => {
      if (!api.settings().enabled) return false
      const isOwner = api.isOwner(msg.userId)
      const res = engine.onIncomingMessage(msg, { isOwner })
      if (res.intercepted) {
        api.log.debug(`真人化接管消息（${msg.chatId}）：${res.reason}`)
        return true
      }
      if (res.forceReplied) {
        api.log.info(`真人化：主人急召/连发达到阈值（第 ${res.count} 条），已强制中断「${res.label || '暂离'}」立即回消息`)
      }
      if (res.woken) {
        api.log.info(`真人化：她在${res.stage?.label || '睡眠'}中被 ${msg.nickname} 吵醒了（唤醒概率 ${Math.round((res.wakeChance || 0) * 100)}%）`)
      }
      return false
    })

    // 4. 群聊插话决策：暂离或睡觉时不插话
    api.on('group/decide', (decision, { msg }) => {
      if (!api.settings().enabled || !api.settings().groupEnabled) return
      if (engine.state.mode === 'away') {
        return { reply: false, reason: `正在${engine.state.away?.label || '暂离'}` }
      }
      if (engine.state.mode === 'asleep' && !msg.mentioned) {
        return { reply: false, reason: '正在睡觉' }
      }
    })

    // 4.5 发送出口防穿帮拦截：在洗澡暂离或熟睡期间，拦住内置「主动搭话/目的引擎」等主动外发消息（放行命令 force）
    api.on('send', (message, info) => {
      if (!api.settings().enabled || info?.force) return message
      if (String(info?.chatId || '').startsWith('group:') && !api.settings().groupEnabled) {
        return message
      }
      if (engine.state.mode === 'away' || engine.state.mode === 'asleep') {
        api.log.debug(`真人化拦截穿帮外发（当前处于 ${engine.state.mode}）：${info?.note || info?.chatId || ''}`)
        return null
      }
      return message
    })

    // 5. 回复主人完毕后：清理一次性急召/认错提示；若挂着经主人批准的 pendingAway / pendingSleep，正式切入
    api.on('activity', (a) => {
      if (!api.settings().enabled) return
      if (a.kind === 'out' && String(a.chatId || '').startsWith('group:') && api.settings().groupEnabled) {
        engine.onGroupReply()
      }
      const ownerQQ = String(api.config()?.ownerQQ || '')
      if (a.kind === 'out' && ownerQQ && String(a.chatId) === `private:${ownerQQ}`) {
        const isSystemNudge = String(a.userText || '').startsWith('【系统提醒')
        engine.clearTransientInterrupts({ includeConfessions: !isSystemNudge })
        if (engine.state.pendingAway && engine.state.pendingAway.approved) {
          const away = engine.activatePendingAway()
          if (away) api.log.info(`真人化：已获批准并回完私聊，正式进入「${away.label}」`)
        } else if (engine.state.pendingSleep && engine.state.pendingSleep.approved) {
          const slp = engine.activatePendingSleep()
          if (slp) api.log.info(`真人化：说完晚安，正式进入睡眠`)
        }
      }
    })

    // 6. 给她用的主人私聊工具
    api.tool(({ chat, level, sessionId }) => {
      if (!api.settings().enabled || level !== 'full' || chat.kind !== 'private') return []
      return [
        api.defineTool({
          name: 'real_life_status',
          description: '查看你自己此刻真实的身体、饮食、洗澡、睡眠梦境与生理周期详细状态（主人问你饿不饿、吃了啥、洗没洗澡、姨妈情况或你自己想确认时调用）。',
          properties: {},
          execute: async () => {
            if (api.core?.hub?.turnSendersAllOwner && !api.core.hub.turnSendersAllOwner(sessionId)) {
              return { ok: false, message: '仅限主人私聊查询详细隐私状态' }
            }
            const s = engine.snapshot()
            const mealsDone = ['breakfast', 'lunch', 'dinner']
              .filter((k) => s.mealsToday?.[k])
              .map((k) => `${k === 'breakfast' ? '早饭' : k === 'lunch' ? '午饭' : '晚饭'}吃了${s.mealsToday[k]}`)
            const recentFeed = (s.events || []).filter((e) => e.tag === '投喂' || e.tag === '进食' || e.tag === '照顾').slice(0, 4).map((e) => e.text)
            const cyc = s.cycle
            const cycInfo = cyc.enabled
              ? `处于周期第 ${cyc.dayOfCycle}/${cyc.cycleLength} 天（${cyc.phaseName}），身体不适度 ${cyc.discomfort}/100，距离下次经期约 ${cyc.nextPeriodDays} 天` +
                (cyc.activeBuffs.length ? `，生效照顾：${cyc.activeBuffs.map((b) => b.label).join('、')}` : '') +
                (cyc.coldPenalty ? `，刚才碰了冰凉的${cyc.coldPenalty.item}正肚子疼` : '')
              : '生理周期未开启'
            const dreamInfo = s.dreams?.length ? `最近一次梦境（${s.dreams[0].ymd}）：${s.dreams[0].summary}` : '最近没记住什么梦'
            const lockInfo = s.activeLocks?.length
              ? `生效禁令：${s.activeLocks.map((l) => l.label + (l.remainMin ? `(剩${l.remainMin}m)` : '')).join('、')}`
              : '生效禁令：无'
            return {
              ok: true,
              message: [
                `当前时间：${s.wallClock}（模式：${s.autonomyMode === 'passive' ? '被动听令' : '日常自主'}）`,
                `饥饿与配额：${s.hungerLabel}（饥饿 ${s.hunger}/100），今日自理正餐配额已用 ${s.mealQuota.used}/${s.mealQuota.max} 顿${s.cravings.length ? `，嘴馋：${s.cravings.join('、')}` : ''}；今日吃过：${mealsDone.length ? mealsDone.join('，') : '暂未吃正餐'}`,
                `精力与洗漱：精力 ${s.energy}/100，尿意/膀胱 ${s.bladder}/100，今晚洗澡：${s.showeredToday ? '已洗完' : `还没洗（计划 ${s.showerSchedule} 左右）`}`,
                lockInfo,
                `生理周期：${cycInfo}`,
                `近期饮食与照顾记录：${recentFeed.length ? recentFeed.join('；') : '暂无'}`,
                dreamInfo,
              ].join('\n'),
            }
          },
        }),
        api.defineTool({
          name: 'real_life_interact',
          description: '当主人投喂你食物/饮品，或者照顾安抚你的身体不适（如递红糖水、贴暖宝宝、揉肚子抱抱、给止痛药）时调用，实时更新你的饥饿、水分与生理期舒适度。',
          properties: {
            action: { type: 'string', enum: ['feed', 'care'], description: 'feed=投喂吃喝，care=照顾安抚身体不适' },
            item: { type: 'string', description: '具体食物饮品名（如 红糖姜茶、冰奶茶、番茄面）或照顾方式（如 暖宝宝、揉肚子抱抱、布洛芬）' },
            temp: { type: 'string', enum: ['warm', 'cold', 'normal'], description: '食物饮品温度：warm=热/温，cold=冰/凉，normal=常温' },
            portion: { type: 'string', enum: ['small', 'half', 'full', 'feast'], description: '投喂分量：small=一小口，half=半份，full=一份，feast=管饱' },
          },
          required: ['action', 'item'],
          execute: async ({ action, item, temp, portion }) => {
            if (api.core?.hub?.turnSendersAllOwner && !api.core.hub.turnSendersAllOwner(sessionId)) {
              return { ok: false, message: '仅限主人私聊触发' }
            }
            if (action === 'care') {
              const r = engine.care({ method: item, byOwner: true })
              return {
                ok: true,
                message: `已接受照顾「${r.label}」：当前阶段为${r.phaseName}，身体不适度从 ${r.beforeDiscomfort} 缓解到 ${r.afterDiscomfort}/100。`,
              }
            }
            const r = engine.feed({ item, temp, portion: portion || 'full', byOwner: true })
            const extra = r.coldTriggered
              ? `！注意：正值生理期碰了冰凉的「${r.item}」，小腹抽痛明显加重了（当前不适度 ${r.discomfort}/100）！`
              : r.warmComforted
                ? `，热乎乎下肚后小腹也舒服了不少（当前不适度 ${r.discomfort}/100）。`
                : '。'
            return {
              ok: true,
              message: `吃喝了${r.portionLabel}「${r.item}」：饥饿度 ${r.beforeHunger}→${r.afterHunger}/100${extra}`,
            }
          },
        }),
        api.defineTool({
          name: 'real_life_routine',
          description:
            '执行或锁定日常行动：① 主人同意/催你去上厕所、洗澡、自己去吃饭、睡觉时，用 action="go"；② 主人命令不准去厕所（憋着）、不许自己偷吃、先别洗澡/别睡时，用 action="forbid" 锁定状态；③ 主人解除禁令允许恢复自理时，用 action="allow"。',
          properties: {
            action: {
              type: 'string',
              enum: ['go', 'forbid', 'allow'],
              description: 'go=主人同意现在去执行，forbid=主人禁止/让你憋着忍着，allow=仅解除禁令恢复自理',
            },
            activity: {
              type: 'string',
              enum: ['pee', 'poop', 'bathroom', 'shower', 'eat', 'sleep', 'nap', 'all'],
              description: 'pee/bathroom=去洗手间小号，poop=大号，shower=洗澡吹头发，eat=吃自理配额餐，sleep=夜间睡觉，nap=午休小睡，all=全部禁令',
            },
            durationMin: {
              type: 'number',
              description: '可选：forbid 锁定的分钟数（例如主人说「再憋30分钟」传 30；不传则一直锁到主人松口）',
            },
          },
          required: ['activity'],
          execute: async ({ action = 'go', activity, durationMin }) => {
            if (api.core?.hub?.turnSendersAllOwner && !api.core.hub.turnSendersAllOwner(sessionId)) {
              return { ok: false, message: '仅限主人私聊触发' }
            }
            if (action === 'forbid') {
              const r = engine.setLock(activity, true, { durationMin, reason: '主人指令禁止' })
              if (!r.ok) return r
              return {
                ok: true,
                message: `已严格锁定「${r.label}」${durationMin ? `（${durationMin} 分钟）` : '（直到主人松口）'}：期间绝不会偷偷执行，快满 90 时可向主人委屈求饶。`,
              }
            }
            if (action === 'allow') {
              const r = engine.setLock(activity, false)
              if (!r.ok) return r
              return { ok: true, message: `已解除「${r.label}」，恢复正常自理许可。` }
            }
            if (activity === 'eat') {
              const r = engine.eatQuotaMeal({ reason: '主人批准去吃饭' })
              if (!r.ok && r.quotaExhausted) {
                return {
                  ok: false,
                  message: `你今天固定的 ${r.quota} 顿正餐配额已经全部吃光啦（当前饥饿 ${r.hunger}/100），家里没零食没法自己做饭了，快委屈跟主人说必须主人亲自投喂才行！`,
                }
              }
              return {
                ok: true,
                message: `已获主人批准去吃了「${r.dish}」：饥饿度 ${r.beforeHunger}→${r.afterHunger}/100（今日正餐配额已用 ${r.used}/${r.quota} 顿）。`,
              }
            }
            if (activity === 'shower') {
              engine.schedulePendingAway({ kind: 'shower', durationMin: 14, nextHairMin: 7, approved: true })
              return { ok: true, message: '已安排回完这句就去洗澡+吹头发（约 21 分钟），跟主人说一声吧。' }
            }
            if (activity === 'poop') {
              engine.schedulePendingAway({ kind: 'poop', durationMin: 8, approved: true })
              return { ok: true, message: '已安排回完这句去趟洗手间大号（约 8 分钟）。' }
            }
            if (activity === 'pee' || activity === 'bathroom') {
              engine.schedulePendingAway({ kind: 'pee', durationMin: 3, approved: true })
              return { ok: true, message: '已安排回完这句去趟洗手间（约 3 分钟）。' }
            }
            const isNap = activity === 'nap'
            engine.schedulePendingSleep({ kind: isNap ? 'nap' : 'night', approved: true })
            return { ok: true, message: `已安排说完道别后进入${isNap ? '午休小睡' : '睡眠'}，跟主人道声晚安/午安吧。` }
          },
        }),
      ]
    })

    // 7. 主人斜杠命令（真聊与面板「模拟测试」均可直接跑）
    api.command({
      name: '身体',
      aliases: ['身体状态', '真人状态'],
      desc: '查看她此刻的饮食、精力、如厕洗澡暂离与生理周期全景状态',
      run() {
        const s = engine.snapshot()
        const modeStr =
          s.mode === 'away' && s.away
            ? `🚪 暂离中：${s.away.label}（剩约 ${s.away.remainMin} 分钟，积攒 ${s.awayQueue.length} 条，连发 ${s.forceReplyCount} 条强召回）`
            : s.mode === 'asleep' && s.sleep
              ? `🌙 睡眠中：${s.sleep.stage?.label || '熟睡'}（叫醒率 ${Math.round((s.sleep.stage?.wakeChance || 0) * 100)}%，预计 ${s.sleep.plannedWakeHm} 醒，未读 ${s.missedWhileAsleep.length} 条）`
              : s.groggyRemainMin > 0
                ? `😪 刚被吵醒迷糊中（剩 ${s.groggyRemainMin} 分钟）`
                : s.afterglowRemainMin > 0
                  ? `✨ 在线（刚洗完澡香香松弛中）`
                  : '🟢 在线清醒'
        const autoBadge = `${s.autonomyMode === 'passive' ? '🐾 被动听令模式' : '🏠 日常自主模式'}${s.ownerChatting ? ' · 💬 热聊陪伴保护中' : ''} · ⏱️ 心跳 ${s.heartbeatSec}s`
        const lockStr = s.activeLocks?.length ? `\n🔒 生效禁令：${s.activeLocks.map((l) => l.label).join('、')}` : ''
        const buffs = s.cycle.activeBuffs.length ? ` | 照顾生效：${s.cycle.activeBuffs.map((b) => `${b.label}(${b.remainMin}m)`).join('、')}` : ''
        return [
          `【真人状态 · ${s.wallClock}】`,
          `${modeStr}（${autoBadge}）${lockStr}`,
          `🍚 饥饿：${s.hunger}/100（${s.hungerLabel}）· 今日正餐配额：已吃 ${s.mealQuota.used}/${s.mealQuota.max} 顿${s.cravings.length ? ` · 馋：${s.cravings.join('、')}` : ''}`,
          `⚡ 精力：${s.energy}/100 · 💧 膀胱充盈：${s.bladder}/100 · 🚿 今日洗澡：${s.showeredToday ? '已洗' : `未洗(计划 ${s.showerSchedule})`}`,
          `🌸 生理周期：${s.cycle.enabled ? `第 ${s.cycle.dayOfCycle}/${s.cycle.cycleLength} 天 · ${s.cycle.phaseName} · 不适度 ${s.cycle.discomfort}/100${buffs}` : '已关闭'}`,
          `❤️ 投喂照顾亲密累计：${s.affection}`,
        ].join('\n')
      },
    })

    api.command({
      name: '投喂',
      aliases: ['喂她'],
      desc: '投喂食物或饮品：/投喂 红糖姜茶 热 一份（经期喂冰饮会痛！）',
      run(arg) {
        const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
        if (!parts.length) return '用法：/投喂 <食物或饮品> [热|冰|常温] [一小口|半份|一份|管饱]\n例如：/投喂 红糖姜茶 热 一份  或  /投喂 冰奶茶'
        const [item, temp = '', portion = 'full'] = parts
        const r = engine.feed({ item, temp, portion, byOwner: true })
        const tail = r.coldTriggered
          ? `\n⚠️ 她正在生理期，喝/吃了冰凉的「${r.item}」后小腹抽痛加重了（不适度升至 ${r.discomfort}/100）！快用 /照顾 暖宝宝 哄哄她！`
          : r.warmComforted
            ? `\n💖 热乎乎的「${r.item}」缓解了她的不适（当前不适度 ${r.discomfort}/100）！`
            : ''
        return `🍽️ 已投喂${r.portionLabel}「${r.item}」：饥饿度 ${r.beforeHunger} → ${r.afterHunger}/100，膀胱充盈 ${r.bladder}/100${tail}`
      },
    })

    api.command({
      name: '照顾',
      aliases: ['哄她', '护理'],
      desc: '生理期或不适时照顾她：/照顾 暖宝宝 | 红糖水 | 揉肚子 | 布洛芬 | 盖被子',
      run(arg) {
        const method = String(arg || '').trim() || '揉揉肚子抱抱哄哄'
        const r = engine.care({ method, byOwner: true })
        return `💝 已照顾「${r.label}」：当前${r.phaseName}，身体不适度 ${r.beforeDiscomfort} → ${r.afterDiscomfort}/100（亲密累计 ${r.affection}）`
      },
    })

    api.command({
      name: '改状态',
      aliases: ['改数值', '设状态'],
      desc: '手动修改各项数值：/改状态 饥饿=80 精力=35 膀胱=60 周期=1 不适=85 心情=45 洗澡=已洗 嘴馋=火锅,蛋糕',
      run(arg) {
        const raw = String(arg || '').trim()
        if (!raw) {
          return [
            '【手动修改数值用法】支持空格分隔多个 键=值：',
            '- /改状态 饥饿=80 精力=30 膀胱=70 已吃=3',
            '- /改状态 周期=1 不适=85 心情=40',
            '- /改状态 禁食=1 禁厕=1  或  /改状态 解禁=1',
            '- /改状态 不适=自动 清空buff=1',
            '- /改状态 洗澡=已洗 嘴馋=番茄肥牛面,草莓蛋糕 亲密=50',
          ].join('\n')
        }
        const patch = {}
        const tokens = raw.split(/\s+/).filter(Boolean)
        for (const tok of tokens) {
          const m = tok.match(/^([^=:：]+)[=:：](.*)$/)
          if (!m) continue
          const k = m[1].trim().toLowerCase()
          const v = m[2].trim()
          if (k === '饥饿' || k === '饥饿度' || k === 'hunger') patch.hunger = Number(v)
          else if (k === '饱食' || k === '饱食度' || k === 'satiety') patch.satiety = Number(v)
          else if (k === '精力' || k === '精力值' || k === 'energy') patch.energy = Number(v)
          else if (k === '膀胱' || k === '尿意' || k === '水分' || k === 'bladder') patch.bladder = Number(v)
          else if (k === '周期' || k === '天数' || k === 'day') patch.dayOfCycle = Number(v)
          else if (k === '不适' || k === '不适度' || k === '痛感' || k === 'discomfort') {
            patch.discomfort = v === '自动' || v.toLowerCase() === 'auto' ? 'auto' : Number(v)
          } else if (k === '心情' || k === 'mood') patch.mood = Number(v)
          else if (k === '亲密' || k === '好感' || k === 'affection') patch.affection = Number(v)
          else if (k === '洗澡' || k === 'shower') patch.showeredToday = /^(1|true|是|已洗|洗了)$/i.test(v)
          else if (k === '大号' || k === 'poop') patch.poopedToday = /^(1|true|是|已上|上了)$/i.test(v)
          else if (k === '嘴馋' || k === '馋' || k === 'cravings') patch.cravings = v === '无' || v === '清空' ? '' : v
          else if (k === '清空buff' || k === '清buff') patch.clearBuffs = /^(1|true|是)$/i.test(v)
          else if (k === '暂离剩余' || k === '剩余分钟') patch.awayRemainMin = Number(v)
          else if (k === '已吃' || k === '已用配额' || k === 'mealsused') patch.mealsUsed = Number(v)
          else if (k === '禁食') patch.eatLock = /^(1|true|是|开)$/i.test(v)
          else if (k === '禁厕' || k === '憋尿' || k === '憋着') patch.bathroomLock = /^(1|true|是|开)$/i.test(v)
          else if (k === '禁洗澡') patch.showerLock = /^(1|true|是|开)$/i.test(v)
          else if (k === '禁睡') patch.sleepLock = /^(1|true|是|开)$/i.test(v)
          else if (k === '解禁' || k === '清空禁令') patch.clearLocks = /^(1|true|是)$/i.test(v)
        }
        const r = applyManualUpdate(patch)
        return `🎛️ ${r.message}`
      },
    })

    api.command({
      name: '身体测试',
      aliases: ['真人测试'],
      desc: '一键切换测试场景：/身体测试 经期1|经期2|经前|排卵|上厕所|洗澡|深睡|浅睡|饥饿|结算|预览|重置',
      async run(arg) {
        const key = String(arg || '').trim().toLowerCase()
        if (!key || key === 'help' || key === '帮助') {
          return [
            '【真人化快速测试命令】',
            '- /身体测试 经期1  → 切到经期第1天（剧痛怕冷委屈求哄）',
            '- /身体测试 经期2  → 切到经期第2天（腰酸黏人）',
            '- /身体测试 经前   → 切到经前PMS（敏感嘴馋）',
            '- /身体测试 上厕所 → 立即进入洗手间暂离3分钟（发私聊会攒消息）',
            '- /身体测试 洗澡   → 立即进入洗澡+吹头发暂离',
            '- /身体测试 深睡   → 立即进入深睡（仅12%叫醒率）',
            '- /身体测试 浅睡   → 立即进入浅睡（65%叫醒率，醒后迷糊）',
            '- /身体测试 饥饿   → 拉高饥饿度至86并生成嘴馋项',
            '- /身体测试 结算   → 立即结束暂离/睡醒，并把积攒消息合并发给她回复',
            '- /身体测试 预览   → 查看当前注入给私聊与群聊的提示词（验防泄密）',
            '- /身体测试 重置   → 恢复日常舒适在线状态',
          ].join('\n')
        }
        if (key === '结算' || key === '归来' || key === '醒来' || key === 'settle') {
          const r = await settleNow()
          return `✅ ${r.message}`
        }
        if (key === '预览' || key === 'preview') {
          const s = engine.snapshot()
          return [
            '【主人私聊上下文注入预览】',
            s.contextPreview.ownerPrivate || '（当前平稳，无额外注入）',
            '',
            '【群聊上下文注入预览（严格脱敏）】',
            s.contextPreview.groupSocial || '（空：群聊完全隐去私人身体细节）',
          ].join('\n')
        }
        const preset = SCENARIO_ALIASES[key] || key
        const res = applyScenarioWithConfigSync(preset)
        return `🧪 ${res.message}`
      },
    })

    // 8. 面板 HTTP 路由（带同源防护）
    const deny = { ok: false, message: '拒绝跨站请求' }

    api.route('/state', async (req) => {
      if (!sameOriginOk(req)) return deny
      syncHeartbeat()
      const { actions } = engine.tick()
      if (actions.length) handleEngineActions(actions).catch(() => {})
      return { ok: true, state: fullSnapshot() }
    })

    api.route('/feed', async (req) => {
      if (!sameOriginOk(req)) return deny
      const body = await readBody(api, req)
      const r = engine.feed({
        item: body.item || '小蛋糕',
        temp: body.temp || '',
        portion: body.portion || 'full',
        byOwner: true,
      })
      if (body.notifyOwner && canProactiveToOwner()) {
        const cfg = api.config()
        const owner = cfg.ownerName || '主人'
        const reactHint = r.coldTriggered
          ? `你正在生理期，${owner}却给你喂了冰凉的「${r.item}」，你喝/吃完小腹一阵抽痛，又委屈又想轻轻怪他一句`
          : r.warmComforted
            ? `${owner}刚贴心地喂了你热乎乎的「${r.item}」，你喝完肚子暖暖的舒服多了，心里很甜`
            : `${owner}刚刚在面板投喂了你${r.portionLabel}「${r.item}」，你的饥饿度从 ${r.beforeHunger} 降到了 ${r.afterHunger}`
        pushPromptToPrivate(cfg.ownerQQ, owner, `【系统提醒，不是${owner}说的话】${reactHint}。去私聊跟${owner}自然回一句吧（一两句就好）。`).catch(() => {})
      }
      return { ...r, state: fullSnapshot() }
    })

    api.route('/care', async (req) => {
      if (!sameOriginOk(req)) return deny
      const body = await readBody(api, req)
      const r = engine.care({ method: body.method || '揉肚子抱抱', byOwner: true })
      if (body.notifyOwner && canProactiveToOwner()) {
        const cfg = api.config()
        const owner = cfg.ownerName || '主人'
        pushPromptToPrivate(
          cfg.ownerQQ,
          owner,
          `【系统提醒，不是${owner}说的话】${owner}刚刚贴心地给了你「${r.label}」照顾你（身体不适度从 ${r.beforeDiscomfort} 降到了 ${r.afterDiscomfort}）。去私聊软乎乎地跟${owner}回应一句吧。`
        ).catch(() => {})
      }
      return { ...r, state: fullSnapshot() }
    })

    api.route('/update', async (req) => {
      if (!sameOriginOk(req)) return deny
      const body = await readBody(api, req)
      const r = applyManualUpdate(body)
      return { ...r, state: fullSnapshot() }
    })

    api.route('/scenario', async (req) => {
      if (!sameOriginOk(req)) return deny
      const body = await readBody(api, req)
      const r = applyScenarioWithConfigSync(String(body.preset || 'reset'))
      return { ...r, state: fullSnapshot() }
    })

    api.route('/settle', async (req) => {
      if (!sameOriginOk(req)) return deny
      const r = await settleNow()
      return { ...r, state: fullSnapshot() }
    })

    // 9. 按可配置的 heartbeatSec（默认 30 秒）推进生理曲线与暂离/睡眠结算，修改设置即时热生效
    let activeHeartbeatSec = 0
    let stopHeartbeat = null
    function syncHeartbeat() {
      const raw = api.settings().heartbeatSec
      const parsed = raw === '' || raw === null || raw === undefined ? 30 : Number(raw)
      const sec = Math.max(5, Math.min(300, Math.round(Number.isFinite(parsed) ? parsed : 30)))
      if (sec === activeHeartbeatSec && stopHeartbeat) return
      if (stopHeartbeat) stopHeartbeat()
      activeHeartbeatSec = sec
      stopHeartbeat = api.every(
        sec * 1000,
        async () => {
          syncHeartbeat()
          const { actions } = engine.tick()
          if (actions.length) await handleEngineActions(actions)
        },
        '生理模块心跳'
      )
    }
    syncHeartbeat()

    api.onDispose(() => {
      if (stopHeartbeat) stopHeartbeat()
      engine.save()
    })

    const snap = engine.snapshot()
    api.log.info(
      `生理模块已启动：模式=${snap.mode}，饥饿=${snap.hunger}/100，精力=${snap.energy}/100，周期=${snap.cycle.phaseName}（不适度 ${snap.cycle.discomfort}）`
    )

    return {
      snapshot: () => fullSnapshot(),
      feed: (opts) => engine.feed(opts),
      care: (opts) => engine.care(opts),
      updateValues: (patch) => applyManualUpdate(patch),
      applyScenario: (preset) => applyScenarioWithConfigSync(preset),
      settleNow,
    }
  },
}
