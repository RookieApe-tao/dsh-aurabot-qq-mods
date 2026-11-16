const { useState, useEffect } = React
const { Card, Btn, Switch, Row, Select, Range, Empty } = ui

const MODULE_DESC =
  '让你的bot拥有真人一般的作息和生理状态！目前支持：一日三餐饥饿与讨食、喝水与上厕所暂离、晚间洗澡吹头发、困倦入睡与做梦概率唤醒、28天生理周期（痛经怕冷与投喂哄人互动），以及日常自主/被动听令双模式。'

const DEFAULT_CFG = {
  enabled: true,
  groupEnabled: false,
  autonomyMode: 'daily',
  heartbeatSec: 30,
  chatIdleMinutes: 15,
  forceReplyCount: 4,
  timeZone: 'Asia/Shanghai',
  dietEnabled: true,
  mealTimes: '08:00, 12:15, 18:30',
  dailyMealQuota: 3,
  chatHungerCost: 1.8,
  autoMeal: true,
  autoSnack: false,
  hungerNudge: true,
  sleepEnabled: true,
  sleepAt: '23:30',
  wakeAt: '07:45',
  napEnabled: true,
  bathroomEnabled: true,
  showerEnabled: true,
  showerAt: '21:30',
  periodEnabled: true,
  cycleAnchor: '',
  cycleLength: 28,
  periodDays: 5,
  periodSeverity: 'heavy',
  periodNudge: true,
}

const PANEL_TABS = [
  { id: 'status', label: '📊 状态与互动' },
  { id: 'mode', label: '⚙️ 模式与防打扰' },
  { id: 'diet', label: '🍚 饮食与洗漱' },
  { id: 'sleep', label: '🌙 睡眠与做梦' },
  { id: 'period', label: '🌸 生理周期' },
  { id: 'debug', label: '🧪 调值与调试' },
]

function Bar({ label, rightText, percent, tone }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  const fill =
    tone === 'warn'
      ? '#e07a5f'
      : tone === 'danger'
        ? '#d9534f'
        : tone === 'pink'
          ? '#d96b98'
          : tone === 'blue'
            ? '#5b8def'
            : '#4aa376'
  return h(
    'div',
    { style: { marginBottom: 10 } },
    h(
      'div',
      { className: 'ab-flex', style: { marginBottom: 4, fontSize: 13 } },
      h('b', null, label),
      h('div', { className: 'ab-spacer' }),
      h('span', { className: 'ab-small ab-muted' }, rightText)
    ),
    h(
      'div',
      {
        style: {
          height: 8,
          borderRadius: 99,
          background: 'rgba(128,128,128,0.16)',
          overflow: 'hidden',
        },
      },
      h('div', {
        style: {
          width: pct + '%',
          height: '100%',
          borderRadius: 99,
          background: fill,
          transition: 'width .25s ease',
        },
      })
    )
  )
}

function NumControl({ value, min, max, step = 1, onChange, suffix = '' }) {
  const num = Number.isFinite(Number(value)) ? Number(value) : min
  return h(
    'div',
    { className: 'ab-flex', style: { gap: 8, alignItems: 'center', width: '100%', maxWidth: 320 } },
    Range
      ? h(
          'div',
          { style: { flex: 1, minWidth: 120 } },
          h(Range, {
            value: num,
            min,
            max,
            step,
            onChange: (v) => onChange(Number(v)),
            fmt: (v) => v + suffix,
          })
        )
      : null,
    h('input', {
      type: 'number',
      className: 'ab-input',
      style: { width: 72, textAlign: 'center' },
      min,
      max,
      step,
      value: num,
      onChange: (e) => {
        const raw = e.target.value
        if (raw === '') return
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)))
      },
    })
  )
}

function CfgNum({ value, fallback, min, max, step = 1, unit = '', onChange }) {
  const displayVal = value === '' || value === null || value === undefined ? '' : value
  const sliderVal = Number.isFinite(Number(value)) && value !== '' ? Number(value) : fallback
  return h(
    'div',
    { className: 'ab-flex', style: { gap: 8, alignItems: 'center', width: '100%', maxWidth: 320 } },
    Range
      ? h(
          'div',
          { style: { flex: 1, minWidth: 120 } },
          h(Range, {
            value: sliderVal,
            min,
            max,
            step,
            onChange: (v) => onChange(Number(v)),
            fmt: (v) => v + unit,
          })
        )
      : null,
    h('input', {
      type: 'number',
      className: 'ab-input sm',
      style: { width: 76, textAlign: 'center' },
      min,
      max,
      step,
      value: displayVal,
      onChange: (e) => {
        const raw = e.target.value
        onChange(raw === '' ? '' : Number(raw))
      },
    })
  )
}

const boxStyle = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid rgba(128,128,128,0.2)',
  background: 'rgba(128,128,128,0.05)',
  marginBottom: 10,
}

const preStyle = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 12,
  lineHeight: 1.55,
  margin: '6px 0 0 0',
  padding: '8px 10px',
  borderRadius: 6,
  background: 'rgba(128,128,128,0.08)',
}

const tabBarStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
  borderBottom: '1px solid var(--ab-line, rgba(128,128,128,0.2))',
  marginTop: 6,
}

return function RealLifePanel({ settings = {}, draftSettings, setSettings, save, toast, reload }) {
  const [snap, setSnap] = useState(null)
  const [activeTab, setActiveTab] = useState('status')
  const [localCfgPatch, setLocalCfgPatch] = useState({})
  const [draftPatch, setDraftPatch] = useState({})
  const [notifyOwner, setNotifyOwner] = useState(false)
  const [foodName, setFoodName] = useState('')
  const [foodTemp, setFoodTemp] = useState('')
  const [foodPortion, setFoodPortion] = useState('full')
  const [showPreview, setShowPreview] = useState(true)

  const savedCfg = { ...DEFAULT_CFG, ...(settings || {}) }
  const curCfg = draftSettings
    ? { ...DEFAULT_CFG, ...draftSettings }
    : { ...savedCfg, ...localCfgPatch }
  const hasCfgDirty = JSON.stringify(curCfg) !== JSON.stringify(savedCfg)

  const putCfg = (patch) => {
    if (typeof setSettings === 'function') {
      setSettings(patch)
    } else {
      setLocalCfgPatch((prev) => ({ ...prev, ...patch }))
    }
  }

  const saveCfgNow = async () => {
    if (!save) return
    await save(curCfg)
    setLocalCfgPatch({})
    load()
  }

  const resetCfgDraft = () => {
    if (typeof setSettings === 'function') {
      setSettings(savedCfg)
    } else {
      setLocalCfgPatch({})
    }
  }

  const toggleMaster = async (nextOn) => {
    putCfg({ enabled: nextOn })
    if (save) {
      await save({ ...curCfg, enabled: nextOn })
      setLocalCfgPatch({})
      load()
    }
  }

  const patchField = (key, val) => setDraftPatch((prev) => ({ ...prev, [key]: val }))
  const dirtyCount = Object.keys(draftPatch).length

  const safeCall = async (path, body) => {
    try {
      return await call(path, body)
    } catch (err) {
      toast(err?.message || '请求失败，请稍后再试', 'err')
      return null
    }
  }

  const load = async () => {
    try {
      const r = await call('/state')
      if (r && r.state) setSnap(r.state)
    } catch (e) {
      // 静默容错，避免切页瞬态弹错
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [])

  const doFeed = async (item, temp = '', portion = 'full') => {
    const name = String(item || '').trim()
    if (!name) return toast('先填一个食物或饮品名字', 'err')
    const r = await safeCall('/feed', { item: name, temp, portion, notifyOwner })
    if (!r) return
    if (r?.state) setSnap(r.state)
    if (r?.coldTriggered) {
      toast(`她正生理期，吃了冰凉的「${r.item}」小腹抽痛加重了！`, 'err')
    } else if (r?.warmComforted) {
      toast(`喂了热乎的「${r.item}」，她肚子舒服多了`, 'ok')
    } else {
      toast(`已投喂${r?.portionLabel || ''}「${r?.item || name}」`, 'ok')
    }
  }

  const doCare = async (method) => {
    const r = await safeCall('/care', { method, notifyOwner })
    if (!r) return
    if (r?.state) setSnap(r.state)
    toast(`已照顾「${r?.label || method}」，不适度 ${r?.beforeDiscomfort}→${r?.afterDiscomfort}`, 'ok')
  }

  const doScenario = async (preset) => {
    const r = await safeCall('/scenario', { preset })
    if (!r) return
    if (r?.state) setSnap(r.state)
    if (r?.anchorToSave && reload) reload()
    toast(r?.message || '已切换场景', 'ok')
  }

  const doSettle = async () => {
    const r = await safeCall('/settle', {})
    if (!r) return
    if (r?.state) setSnap(r.state)
    setDraftPatch({})
    toast(r?.message || '已结算', 'ok')
  }

  const saveManual = async () => {
    if (!dirtyCount) return toast('还没有改动任何数值', 'err')
    const r = await safeCall('/update', draftPatch)
    if (!r) return
    if (r?.state) setSnap(r.state)
    setDraftPatch({})
    if (r?.anchorToSave && reload) reload()
    toast(r?.message || '数值已保存生效', 'ok')
  }

  const quickUpdate = async (patch, okMsg) => {
    const r = await safeCall('/update', patch)
    if (!r) return
    if (r?.state) setSnap(r.state)
    setDraftPatch((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(patch)) delete next[k]
      return next
    })
    toast(r?.message || okMsg || '已更新', 'ok')
  }

  const renderSaveHint = () =>
    hasCfgDirty
      ? h(
          'div',
          {
            className: 'ab-flex',
            style: {
              marginTop: 10,
              paddingTop: 10,
              borderTop: '1px solid rgba(128,128,128,0.15)',
              gap: 8,
              flexWrap: 'wrap',
            },
          },
          h('span', { className: 'ab-small', style: { color: 'var(--ab-warn, #e07a5f)' } }, '● 当前分类有未保存的设置改动'),
          h('div', { className: 'ab-spacer' }),
          h(Btn, { small: true, kind: 'ghost', onClick: resetCfgDraft }, '撤销改动'),
          save ? h(Btn, { small: true, kind: 'primary', onClick: saveCfgNow }, '💾 保存设置') : null
        )
      : h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '提示：修改后点「保存设置」（或按 Ctrl+S）即可即时热生效，无需重启。')

  // ---------------- 分类 1：状态与互动 ----------------
  const renderStatusTab = () => {
    if (!snap) return h(Empty, { icon: '⏳', text: '正在读取她的身体状态…' })

    const cyc = snap.cycle || {}
    const mealQuota = snap.mealQuota || { used: 0, max: 3, remaining: 3 }
    const activeLocks = snap.activeLocks || []
    const queuedTotal = (snap.awayQueue?.length || 0) + (snap.missedWhileAsleep?.length || 0)

    const modeBadge =
      snap.mode === 'away' && snap.away
        ? `🚪 ${snap.away.label}（剩 ${snap.away.remainMin} 分钟）`
        : snap.mode === 'asleep' && snap.sleep
          ? `🌙 ${snap.sleep.stage?.label || '睡眠中'}（叫醒率 ${Math.round((snap.sleep.stage?.wakeChance || 0) * 100)}%）`
          : snap.groggyRemainMin > 0
            ? `😪 刚被吵醒迷糊中（${snap.groggyRemainMin}m）`
            : snap.afterglowRemainMin > 0
              ? '✨ 刚洗完澡香香松弛中'
              : '🟢 在线清醒'

    return h(
      'div',
      { className: 'ab-grid' },
      h(
        Card,
        {
          title: '此刻的身体与作息',
          desc: `${snap.wallClock} · ${snap.autonomyMode === 'passive' ? '🐾 被动听令模式' : '🏠 日常自主模式'}${snap.ownerChatting ? '（💬 热聊陪伴保护中）' : ''} · ${snap.groupEnabled ? '👥 群聊已启用' : '🔒 仅私聊生效'} · 连发 ${snap.forceReplyCount || 4} 条强召回 · ❤️ ${snap.affection}`,
          right: h(
            'div',
            { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
            h('span', { className: 'ab-badge mine' }, modeBadge),
            h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新')
          ),
        },
        activeLocks.length
          ? h(
              'div',
              { style: boxStyle },
              h(
                'div',
                { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
                h(
                  'span',
                  { style: { fontSize: 13 } },
                  '🔒 主人禁令生效中：' + activeLocks.map((l) => l.label + (l.remainMin ? `（剩 ${l.remainMin}m）` : '')).join(' · ')
                ),
                h('div', { className: 'ab-spacer' }),
                h(Btn, { small: true, onClick: () => quickUpdate({ clearLocks: true }, '已解除全部禁令') }, '🔓 一键解除全部禁令')
              )
            )
          : null,
        snap.mode !== 'awake' || snap.pendingAway || snap.pendingSleep || queuedTotal > 0
          ? h(
              'div',
              { style: boxStyle },
              h(
                'div',
                { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap' } },
                h(
                  'span',
                  { style: { fontSize: 13 } },
                  snap.mode === 'away'
                    ? `正在「${snap.away?.label}」，暂存私聊 ${snap.awayQueue.length} 条（连发 ${snap.forceReplyCount || 4} 条自动强制中断秒回）`
                    : snap.mode === 'asleep'
                      ? `正在睡觉（预计 ${snap.sleep?.plannedWakeHm} 醒），未读消息 ${snap.missedWhileAsleep.length} 条`
                      : snap.pendingSleep
                        ? `已挂起动作：回完晚安/午安后将进入「${snap.pendingSleep.label}」`
                        : `已挂起动作：回完当前私聊后将「${snap.pendingAway?.label}」`
                ),
                h('div', { className: 'ab-spacer' }),
                h(Btn, { small: true, kind: 'primary', onClick: doSettle }, '⚡ 立即归来 / 叫醒并结算回复')
              )
            )
          : null,
        h(Bar, {
          label: `🍚 饱食度（${snap.hungerLabel}）`,
          rightText: `饱食 ${snap.satiety}% · 饥饿 ${snap.hunger}/100 · 今日正餐配额 ${mealQuota.used}/${mealQuota.max} 顿 · 饭点 ${snap.mealsSchedule.breakfast}/${snap.mealsSchedule.lunch}/${snap.mealsSchedule.dinner}`,
          percent: snap.satiety,
          tone: snap.hunger >= 75 ? 'danger' : snap.hunger >= 55 ? 'warn' : 'ok',
        }),
        snap.cravings?.length
          ? h('div', { className: 'ab-small ab-muted', style: { marginTop: -4, marginBottom: 8 } }, '😋 此刻嘴馋：' + snap.cravings.join('、'))
          : null,
        h(Bar, {
          label: '⚡ 精力值',
          rightText: `${snap.energy}/100` + (snap.sleep ? ` · 预计 ${snap.sleep.plannedWakeHm} 起床` : ''),
          percent: snap.energy,
          tone: snap.energy <= 22 ? 'danger' : snap.energy <= 40 ? 'warn' : 'blue',
        }),
        h(Bar, {
          label: '💧 水分与膀胱充盈',
          rightText: `${snap.bladder}/100（≥82 会去洗手间） · 今日洗澡：${snap.showeredToday ? '已洗完' : '计划 ' + snap.showerSchedule}`,
          percent: snap.bladder,
          tone: snap.bladder >= 80 ? 'warn' : 'blue',
        }),
        cyc.enabled
          ? h(
              'div',
              { style: { marginTop: 6 } },
              h(Bar, {
                label: `🌸 生理周期：${cyc.phaseName}`,
                rightText: `第 ${cyc.dayOfCycle}/${cyc.cycleLength} 天 · 身体不适度 ${cyc.discomfort}/100`,
                percent: cyc.discomfort,
                tone: cyc.discomfort >= 58 ? 'danger' : cyc.discomfort >= 25 ? 'pink' : 'ok',
              }),
              cyc.coldPenalty
                ? h('div', { className: 'ab-note err', style: { marginTop: 6 } }, `🧊 贪凉惩罚生效中：刚碰了冰凉的「${cyc.coldPenalty.item}」，小腹抽痛 +${cyc.coldPenalty.delta}`)
                : null,
              cyc.activeBuffs?.length
                ? h(
                    'div',
                    { className: 'ab-small', style: { marginTop: 4 } },
                    '💝 生效中的照顾：' + cyc.activeBuffs.map((b) => `${b.label}（-${b.relief}，剩 ${b.remainMin} 分钟）`).join(' · ')
                  )
                : null
            )
          : h('div', { className: 'ab-small ab-muted' }, '🌸 生理周期已关闭（可在「🌸 生理周期」分类中开启）')
      ),

      h(
        Card,
        {
          title: '投喂与贴心照顾',
          desc: '直接点按钮喂她吃喝或在她生理期难受时哄她；经期点冰饮会触发肚子疼反应。',
        },
        h(
          Row,
          { label: '投喂/照顾后让她在 QQ 私聊回话', hint: '打开后，在面板点投喂或照顾，她会直接在私聊对你说一句反应（需总开关开启且填了主人 QQ）' },
          h(Switch, { on: notifyOwner, onChange: setNotifyOwner })
        ),
        h('div', { className: 'ab-small ab-muted', style: { margin: '8px 0 6px' } }, '快捷投喂：'),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
          h(Btn, { small: true, onClick: () => doFeed('红糖姜茶', 'warm', 'full') }, '🍵 热红糖姜茶'),
          h(Btn, { small: true, onClick: () => doFeed('温牛奶', 'warm', 'half') }, '🥛 温牛奶'),
          h(Btn, { small: true, onClick: () => doFeed('番茄牛腩面', 'warm', 'full') }, '🍜 番茄牛腩面'),
          h(Btn, { small: true, onClick: () => doFeed('草莓小蛋糕', 'normal', 'half') }, '🍰 草莓小蛋糕'),
          h(Btn, { small: true, onClick: () => doFeed('冰奶茶', 'cold', 'full') }, '🧊 冰奶茶（经期慎点）'),
          h(Btn, { small: true, onClick: () => doFeed('抹茶冰淇淋', 'cold', 'half') }, '🍦 冰淇淋')
        ),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 12 } },
          h('input', {
            className: 'ab-input',
            style: { flex: '1 1 150px', minWidth: 140 },
            placeholder: '手填食物或饮品，如 鲜虾小馄饨',
            value: foodName,
            onChange: (e) => setFoodName(e.target.value),
          }),
          Select
            ? h(Select, {
                value: foodTemp,
                width: 110,
                onChange: setFoodTemp,
                options: [
                  { value: '', label: '自动识温' },
                  { value: 'warm', label: '热乎的' },
                  { value: 'normal', label: '常温' },
                  { value: 'cold', label: '冰凉的' },
                ],
              })
            : null,
          Select
            ? h(Select, {
                value: foodPortion,
                width: 100,
                onChange: setFoodPortion,
                options: [
                  { value: 'small', label: '一小口' },
                  { value: 'half', label: '半份' },
                  { value: 'full', label: '一份' },
                  { value: 'feast', label: '管饱' },
                ],
              })
            : null,
          h(
            Btn,
            {
              small: true,
              kind: 'primary',
              onClick: () => {
                doFeed(foodName, foodTemp, foodPortion)
                setFoodName('')
              },
            },
            '喂她吃'
          )
        ),
        h('div', { className: 'ab-small ab-muted', style: { margin: '6px 0' } }, '生理期 / 身体不适照顾：'),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
          h(Btn, { small: true, onClick: () => doCare('暖宝宝') }, '🔥 贴暖宝宝 (-26)'),
          h(Btn, { small: true, onClick: () => doCare('揉揉肚子抱抱') }, '🤲 揉肚子抱抱 (-16)'),
          h(Btn, { small: true, onClick: () => doCare('布洛芬止痛药') }, '💊 喂布洛芬 (-46)'),
          h(Btn, { small: true, onClick: () => doCare('温热水') }, '🫖 递温热水 (-10)'),
          h(Btn, { small: true, onClick: () => doCare('裹好被子歇会儿') }, '🛌 裹被子休息 (-12)')
        )
      )
    )
  }

  // ---------------- 分类 2：模式与防打扰 ----------------
  const renderModeTab = () =>
    h(
      Card,
      {
        title: '生活模式与聊天防打扰规则',
        desc: '控制她平时如何自理、是否在群聊生效、跟主人聊天时如何暂缓离开，以及急事连发几条强制秒回。',
      },
      h(
        Row,
        {
          label: '在群聊中也启用',
          hint: '默认关闭（仅私聊生效，群聊完全不受影响）；打开后她在群聊也会同步拥有饥饿、困倦、暂离不插话、熟睡被 @ 概率吵醒等状态',
        },
        h(Switch, { on: !!curCfg.groupEnabled, onChange: (v) => putCfg({ groupEnabled: v }) })
      ),
      h(
        Row,
        {
          label: '生活自主模式',
          hint: '日常模式：闲时自理三餐如厕，正在聊天时先忍着等主人同意；被动模式：全程等主人批准或投喂',
        },
        Select
          ? h(Select, {
              value: curCfg.autonomyMode || 'daily',
              onChange: (v) => putCfg({ autonomyMode: v }),
              options: [
                { value: 'daily', label: '日常自主模式（闲时自理 · 聊天请示，推荐）' },
                { value: 'passive', label: '被动听令模式（全程听令请示 / 投喂养成）' },
              ],
            })
          : null
      ),
      h(
        Row,
        {
          label: '聊天陪伴保护时长',
          hint: '跟主人私聊后的这段时间内视为「正在聊天」，期间绝不自作主张去上厕所、洗澡、睡觉或自己吃饭',
        },
        h(CfgNum, {
          value: curCfg.chatIdleMinutes,
          fallback: 15,
          min: 3,
          max: 120,
          step: 1,
          unit: ' 分钟',
          onChange: (v) => putCfg({ chatIdleMinutes: v }),
        })
      ),
      h(
        Row,
        {
          label: '暂离 / 睡眠强召回消息条数',
          hint: '她上厕所、洗澡或睡觉时，主人连发达到该条数（默认 4 条）或发「快回我/急事」，立即中断暂离强制秒回',
        },
        h(CfgNum, {
          value: curCfg.forceReplyCount,
          fallback: 4,
          min: 1,
          max: 20,
          step: 1,
          unit: ' 条',
          onChange: (v) => putCfg({ forceReplyCount: v }),
        })
      ),
      h(
        Row,
        {
          label: '心跳巡检间隔',
          hint: '默认 30 秒。只影响暂离归来与状态检查精度，不改变变饿速度，平时零 Token 消耗',
        },
        h(CfgNum, {
          value: curCfg.heartbeatSec,
          fallback: 30,
          min: 5,
          max: 300,
          step: 5,
          unit: ' 秒',
          onChange: (v) => putCfg({ heartbeatSec: v }),
        })
      ),
      h(
        Row,
        {
          label: '作息时区',
          hint: '默认 Asia/Shanghai（北京时间）',
        },
        h('input', {
          className: 'ab-input',
          style: { maxWidth: 220 },
          placeholder: 'Asia/Shanghai',
          value: curCfg.timeZone ?? '',
          onChange: (e) => putCfg({ timeZone: e.target.value }),
        })
      ),
      renderSaveHint()
    )

  // ---------------- 分类 3：饮食与洗漱 ----------------
  const renderDietTab = () =>
    h(
      'div',
      { className: 'ab-grid' },
      h(
        Card,
        {
          title: '一日三餐与饥饿讨食配额',
          desc: '默认每天固定 3 顿正餐（无免费无限零食）。平时不用管她；跟主人聊得火热消耗快时就会提前饿并向主人讨食。',
          right: h(Switch, { on: !!curCfg.dietEnabled, onChange: (v) => putCfg({ dietEnabled: v }) }),
        },
        h(
          Row,
          {
            label: '早 / 午 / 晚饭点',
            hint: '用逗号分隔三个时间（HH:MM），每天自带 ±15 分钟自然浮动',
          },
          h('input', {
            className: 'ab-input',
            style: { maxWidth: 240 },
            placeholder: '08:00, 12:15, 18:30',
            value: curCfg.mealTimes ?? '',
            onChange: (e) => putCfg({ mealTimes: e.target.value }),
          })
        ),
        h(
          Row,
          {
            label: '每日自理正餐配额',
            hint: '默认每天固定 3 顿。设为 0 则不自理正餐，纯靠主人投喂',
          },
          h(CfgNum, {
            value: curCfg.dailyMealQuota,
            fallback: 3,
            min: 0,
            max: 10,
            step: 1,
            unit: ' 顿',
            onChange: (v) => putCfg({ dailyMealQuota: v }),
          })
        ),
        h(
          Row,
          {
            label: '每轮私聊消耗饱食度',
            hint: '默认每聊一句饥饿 +1.8（长消息略增）。聊得越多饿得越快',
          },
          h(CfgNum, {
            value: curCfg.chatHungerCost,
            fallback: 1.8,
            min: 0,
            max: 15,
            step: 0.2,
            unit: '',
            onChange: (v) => putCfg({ chatHungerCost: v }),
          })
        ),
        h(
          Row,
          {
            label: '日常模式闲时按配额自理三餐',
            hint: '关闭后即使在日常模式也不会自己吃饭，纯靠主人投喂或批准',
          },
          h(Switch, { on: !!curCfg.autoMeal, onChange: (v) => putCfg({ autoMeal: v }) })
        ),
        h(
          Row,
          {
            label: '配额不够或饿极了主动私聊讨食',
            hint: '每天最多 2 次，不会刷屏',
          },
          h(Switch, { on: !!curCfg.hungerNudge, onChange: (v) => putCfg({ hungerNudge: v }) })
        ),
        renderSaveHint()
      ),

      h(
        Card,
        {
          title: '如厕与晚间洗澡暂离',
          desc: '喝水进食会自然攒尿意；暂离期间收到的消息会攒起来，回来后一次性自然回复。',
        },
        h(
          Row,
          {
            label: '启用上厕所暂离',
            hint: '闲时自己去；正在聊天时先忍着，经过主人同意才去',
          },
          h(Switch, { on: !!curCfg.bathroomEnabled, onChange: (v) => putCfg({ bathroomEnabled: v }) })
        ),
        h(
          Row,
          {
            label: '启用晚间洗澡 + 吹头发暂离',
            hint: '每晚洗澡约 14 分钟 + 吹干头发约 7 分钟，洗完有松弛余韵',
          },
          h(Switch, { on: !!curCfg.showerEnabled, onChange: (v) => putCfg({ showerEnabled: v }) })
        ),
        h(
          Row,
          {
            label: '晚间洗澡时间',
            hint: '格式 HH:MM（默认 21:30）',
          },
          h('input', {
            className: 'ab-input sm',
            style: { width: 110, textAlign: 'center' },
            placeholder: '21:30',
            value: curCfg.showerAt ?? '',
            onChange: (e) => putCfg({ showerAt: e.target.value }),
          })
        ),
        renderSaveHint()
      )
    )

  // ---------------- 分类 4：睡眠与做梦 ----------------
  const renderSleepTab = () =>
    h(
      Card,
      {
        title: '睡眠作息、做梦与概率叫醒',
        desc: '睡着后按浅睡（65%）、REM 做梦（30%）、深睡（12%）阶段概率决定能不能被消息吵醒；连发达到强召回条数则 100% 秒醒。',
        right: h(Switch, { on: !!curCfg.sleepEnabled, onChange: (v) => putCfg({ sleepEnabled: v }) }),
      },
      h(
        Row,
        {
          label: '平时入睡时间',
          hint: '格式 HH:MM（默认 23:30）。若到点仍在陪主人聊天，会犯困但不会擅自断联入睡',
        },
        h('input', {
          className: 'ab-input sm',
          style: { width: 110, textAlign: 'center' },
          placeholder: '23:30',
          value: curCfg.sleepAt ?? '',
          onChange: (e) => putCfg({ sleepAt: e.target.value }),
        })
      ),
      h(
        Row,
        {
          label: '平时起床时间',
          hint: '格式 HH:MM（默认 07:45）。自然醒来后会把夜里错过的私聊汇总回复',
        },
        h('input', {
          className: 'ab-input sm',
          style: { width: 110, textAlign: 'center' },
          placeholder: '07:45',
          value: curCfg.wakeAt ?? '',
          onChange: (e) => putCfg({ wakeAt: e.target.value }),
        })
      ),
      h(
        Row,
        {
          label: '允许午后犯困小睡',
          hint: '13:10~14:00 精力偏低且没人聊天时小睡约 35 分钟',
        },
        h(Switch, { on: !!curCfg.napEnabled, onChange: (v) => putCfg({ napEnabled: v }) })
      ),
      renderSaveHint()
    )

  // ---------------- 分类 5：生理周期 ----------------
  const renderPeriodTab = () => {
    const todayYmd = snap?.wallClock ? String(snap.wallClock).slice(0, 10) : ''
    return h(
      Card,
      {
        title: '28 天生理周期与哄人互动',
        desc: '仅对主人私聊展现生理期与痛感细节，群聊与外人严密隐藏隐私。',
        right: h(Switch, { on: !!curCfg.periodEnabled, onChange: (v) => putCfg({ periodEnabled: v }) }),
      },
      h(
        Row,
        {
          label: '最近一次经期第 1 天日期',
          hint: '格式 YYYY-MM-DD（留空则用模块内部记录；用调试场景切换时会自动同步）',
        },
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap' } },
          h('input', {
            className: 'ab-input',
            style: { width: 170 },
            placeholder: '如 2026-11-15',
            value: curCfg.cycleAnchor ?? '',
            onChange: (e) => putCfg({ cycleAnchor: e.target.value }),
          }),
          /^\d{4}-\d{2}-\d{2}$/.test(todayYmd)
            ? h(Btn, { small: true, onClick: () => putCfg({ cycleAnchor: todayYmd }) }, '设为今天')
            : null
        )
      ),
      h(
        Row,
        {
          label: '生理周期天数',
          hint: '默认 28 天（可设 21~38 天）',
        },
        h(CfgNum, {
          value: curCfg.cycleLength,
          fallback: 28,
          min: 21,
          max: 38,
          step: 1,
          unit: ' 天',
          onChange: (v) => putCfg({ cycleLength: v }),
        })
      ),
      h(
        Row,
        {
          label: '每次经期持续天数',
          hint: '默认 5 天（可设 3~8 天）',
        },
        h(CfgNum, {
          value: curCfg.periodDays,
          fallback: 5,
          min: 3,
          max: 8,
          step: 1,
          unit: ' 天',
          onChange: (v) => putCfg({ periodDays: v }),
        })
      ),
      h(
        Row,
        {
          label: '经期体感与情绪强度',
          hint: '决定经期前两天的坠痛感、怕冷敏感度与对暖宝宝/止痛药的需求度',
        },
        Select
          ? h(Select, {
              value: curCfg.periodSeverity || 'heavy',
              onChange: (v) => putCfg({ periodSeverity: v }),
              options: [
                { value: 'heavy', label: '前两天明显（坠痛怕冷委屈 · 需哄照顾，推荐）' },
                { value: 'mild', label: '轻微日常感（略微乏力怕凉）' },
                { value: 'intense', label: '重度痛经（前两天极难受，很依赖止痛药与暖宝宝）' },
              ],
            })
          : null
      ),
      h(
        Row,
        {
          label: '经期前两天难受时主动私聊求哄',
          hint: '每天最多 1~2 次，绝不刷屏',
        },
        h(Switch, { on: !!curCfg.periodNudge, onChange: (v) => putCfg({ periodNudge: v }) })
      ),
      renderSaveHint()
    )
  }

  // ---------------- 分类 6：调值与调试 ----------------
  const renderDebugTab = () => {
    if (!snap) return h(Empty, { icon: '🧪', text: '正在读取调试状态…' })

    const cyc = snap.cycle || {}
    const cycleMax = cyc.cycleLength || 28
    const mealQuota = snap.mealQuota || { used: 0, max: 3, remaining: 3 }
    const activeLocks = snap.activeLocks || []
    const hasLock = (k) => activeLocks.some((l) => l.kind === k)

    const vHunger = draftPatch.hunger !== undefined ? draftPatch.hunger : snap.hunger
    const vEnergy = draftPatch.energy !== undefined ? draftPatch.energy : snap.energy
    const vBladder = draftPatch.bladder !== undefined ? draftPatch.bladder : snap.bladder
    const vDay = draftPatch.dayOfCycle !== undefined ? draftPatch.dayOfCycle : cyc.dayOfCycle || 1
    const vDiscomfort = draftPatch.discomfort !== undefined ? draftPatch.discomfort : cyc.discomfort || 0
    const vMood = draftPatch.mood !== undefined ? draftPatch.mood : snap.moodValue ?? 60
    const vAffection = draftPatch.affection !== undefined ? draftPatch.affection : snap.affection || 0
    const vShowered = draftPatch.showeredToday !== undefined ? draftPatch.showeredToday : Boolean(snap.showeredToday)
    const vPooped = draftPatch.poopedToday !== undefined ? draftPatch.poopedToday : Boolean(snap.poopedToday)
    const vCravings = draftPatch.cravings !== undefined ? draftPatch.cravings : (snap.cravings || []).join(', ')
    const vAwayMin = draftPatch.awayRemainMin !== undefined ? draftPatch.awayRemainMin : snap.away?.remainMin || 3
    const vMealsUsed = draftPatch.mealsUsed !== undefined ? draftPatch.mealsUsed : mealQuota.used
    const vEatLock = draftPatch.eatLock !== undefined ? draftPatch.eatLock : hasLock('eat')
    const vBathLock = draftPatch.bathroomLock !== undefined ? draftPatch.bathroomLock : hasLock('bathroom')
    const vShowerLock = draftPatch.showerLock !== undefined ? draftPatch.showerLock : hasLock('shower')
    const vSleepLock = draftPatch.sleepLock !== undefined ? draftPatch.sleepLock : hasLock('sleep')

    return h(
      'div',
      { className: 'ab-grid' },
      h(
        Card,
        {
          title: '手动修改当前数值与禁令锁',
          desc: '拖动滑块或直接输入数字精准改她的实时状态；改完点底部「保存数值修改」立刻生效。也可在私聊发 /改状态 饥饿=80 膀胱=75 禁食=1',
          right: dirtyCount
            ? h('span', { className: 'ab-badge mine' }, `待保存 ${dirtyCount} 项`)
            : cyc.manualDiscomfortActive
              ? h('span', { className: 'ab-badge' }, '🔒 不适度已手动指定')
              : null,
        },
        h(
          Row,
          { label: `🍚 饥饿度（饱食 ${100 - vHunger}%）`, hint: '0 = 刚吃撑，100 = 饿扁了（≥78 明显喊饿）' },
          h(NumControl, { value: vHunger, min: 0, max: 100, onChange: (v) => patchField('hunger', v) })
        ),
        h(
          Row,
          { label: '⚡ 精力值', hint: '100 = 精神百倍，≤20 困得睁不开眼，≤8 会直接困极入睡' },
          h(NumControl, { value: vEnergy, min: 0, max: 100, onChange: (v) => patchField('energy', v) })
        ),
        h(
          Row,
          { label: '💧 膀胱充盈度（尿意）', hint: '0 = 刚上完厕所，≥82 会触发去洗手间暂离' },
          h(NumControl, { value: vBladder, min: 0, max: 100, onChange: (v) => patchField('bladder', v) })
        ),
        h(
          Row,
          { label: `🍱 今日已吃正餐配额（上限 ${mealQuota.max} 顿）`, hint: '归零后闲时可重新吃正餐；拉满后手头没吃的只能找主人讨食' },
          h(NumControl, { value: vMealsUsed, min: 0, max: Math.max(5, mealQuota.max), onChange: (v) => patchField('mealsUsed', v), suffix: '顿' })
        ),
        cyc.enabled
          ? h(
              Row,
              { label: `🌸 生理周期第几天（共 ${cycleMax} 天）`, hint: `1~${cyc.periodDays || 5} 为经期；只改天数不改不适度时会自动按该天自然体感重算` },
              h(NumControl, { value: vDay, min: 1, max: cycleMax, onChange: (v) => patchField('dayOfCycle', v), suffix: '天' })
            )
          : null,
        cyc.enabled
          ? h(
              Row,
              {
                label: '🩸 身体不适度 / 痛感',
                hint: cyc.manualDiscomfortActive
                  ? '当前为手动指定基数（当天有效，仍可被暖宝宝/红糖水缓解）'
                  : '0 = 完全舒适，≥58 为明显坠痛需哄照顾；手动拖动可覆盖自动计算',
              },
              h(NumControl, { value: vDiscomfort, min: 0, max: 100, onChange: (v) => patchField('discomfort', v) })
            )
          : null,
        snap.moodValue !== null && snap.moodValue !== undefined
          ? h(
              Row,
              { label: `😊 内置心情值（${snap.moodLabel || '当前'}）`, hint: '联动 Aurabot 内置心情模块（5~100，基线 60）' },
              h(NumControl, { value: vMood, min: 5, max: 100, onChange: (v) => patchField('mood', v) })
            )
          : null,
        snap.mode === 'away' && snap.away
          ? h(
              Row,
              { label: `🚪 当前「${snap.away.label}」剩余分钟`, hint: '可直接调长或缩短本次暂离剩余时间' },
              h(NumControl, { value: vAwayMin, min: 1, max: 60, onChange: (v) => patchField('awayRemainMin', v), suffix: 'm' })
            )
          : null,
        h(
          Row,
          { label: '❤️ 投喂照顾亲密累计', hint: '记录投喂与照顾次数' },
          h('input', {
            type: 'number',
            className: 'ab-input',
            style: { width: 96, textAlign: 'center' },
            min: 0,
            max: 99999,
            value: vAffection,
            onChange: (e) => patchField('affection', Math.max(0, Number(e.target.value) || 0)),
          })
        ),
        h(
          Row,
          { label: '😋 此刻嘴馋的食物', hint: '多个食物用逗号分隔，留空则清空嘴馋' },
          h('input', {
            className: 'ab-input',
            style: { width: '100%', maxWidth: 280 },
            placeholder: '例如：火锅, 草莓小蛋糕, 热红糖奶茶',
            value: vCravings,
            onChange: (e) => patchField('cravings', e.target.value),
          })
        ),
        h(
          Row,
          { label: '🚿 今日已洗过澡', hint: '关掉后今晚到洗澡时间会再次去洗澡' },
          h(Switch, { on: vShowered, onChange: (v) => patchField('showeredToday', v) })
        ),
        h(
          Row,
          { label: '🚽 今日已上过大号', hint: '每日排便标记' },
          h(Switch, { on: vPooped, onChange: (v) => patchField('poopedToday', v) })
        ),
        h(
          Row,
          { label: '🔒 禁食锁（不许自己吃东西）', hint: '开启后绝不偷吃，饿到 90 求饶，仅 100 且主人长期不在时保底喝口水垫肚子' },
          h(Switch, { on: vEatLock, onChange: (v) => patchField('eatLock', v) })
        ),
        h(
          Row,
          { label: '🔒 禁如厕锁（憋着不许去厕所）', hint: '开启后绝不擅自去厕所，憋到 90 求饶，仅 100 且主人长期不在时紧急保底并认错' },
          h(Switch, { on: vBathLock, onChange: (v) => patchField('bathroomLock', v) })
        ),
        h(
          Row,
          { label: '🔒 暂缓洗澡锁', hint: '开启后今晚先不去洗澡（默认最长 8 小时后自动解除，防次日卡死）' },
          h(Switch, { on: vShowerLock, onChange: (v) => patchField('showerLock', v) })
        ),
        h(
          Row,
          { label: '🔒 暂缓睡觉锁', hint: '开启后困了也强撑着陪主人（默认最长 8 小时后自动解除，防次日卡死）' },
          h(Switch, { on: vSleepLock, onChange: (v) => patchField('sleepLock', v) })
        ),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap', marginTop: 10 } },
          h(Btn, { kind: 'primary', small: true, disabled: !dirtyCount, onClick: saveManual }, dirtyCount ? `💾 保存数值修改（${dirtyCount} 项）` : '💾 保存数值修改'),
          dirtyCount ? h(Btn, { small: true, onClick: () => setDraftPatch({}) }, '↺ 撤销未存改动') : null,
          cyc.manualDiscomfortActive
            ? h(Btn, { small: true, onClick: () => quickUpdate({ discomfort: 'auto' }, '已恢复按周期自动计算不适度') }, '🔓 不适度恢复自动计算')
            : null,
          cyc.activeBuffs?.length || cyc.coldPenalty
            ? h(Btn, { small: true, onClick: () => quickUpdate({ clearBuffs: true }, '已清空 Buff 与贪凉惩罚') }, '🧹 清空照顾Buff与吃冰惩罚')
            : null
        )
      ),

      h(
        Card,
        {
          title: '调试与测试实验室',
          desc: '不用等 28 天周期或深夜，点一下立刻把她切进任意状态，再去私聊或「已安装 → 模拟测试」验证效果。',
        },
        h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } }, '1. 生理周期与饥饿场景：'),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
          h(Btn, { small: true, onClick: () => doScenario('period-day1') }, '🩸 经期第 1 天（剧痛需哄）'),
          h(Btn, { small: true, onClick: () => doScenario('period-day2') }, '🩸 经期第 2 天（腰酸黏人）'),
          h(Btn, { small: true, onClick: () => doScenario('pms') }, '🍰 经前 PMS（嘴馋敏感）'),
          h(Btn, { small: true, onClick: () => doScenario('ovulation') }, '✨ 排卵期（元气亲昵）'),
          h(Btn, { small: true, onClick: () => doScenario('follicular') }, '🌿 日常平稳期'),
          h(Btn, { small: true, onClick: () => doScenario('starving') }, '🍽️ 拉高饥饿（86/100）')
        ),
        h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } }, '2. 暂离攒消息与睡眠唤醒场景：'),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
          h(Btn, { small: true, onClick: () => doScenario('pee') }, '🚻 去洗手间（小号 3m）'),
          h(Btn, { small: true, onClick: () => doScenario('poop') }, '🚽 去洗手间（大号 8m）'),
          h(Btn, { small: true, onClick: () => doScenario('shower') }, '🚿 洗澡+吹头发暂离'),
          h(Btn, { small: true, onClick: () => doScenario('hair') }, '💨 仅吹头发暂离'),
          h(Btn, { small: true, onClick: () => doScenario('deep-sleep') }, '🌙 深睡（12%叫醒）'),
          h(Btn, { small: true, onClick: () => doScenario('light-sleep') }, '😴 浅睡（65%叫醒）'),
          h(Btn, { small: true, onClick: () => doScenario('rem-dream') }, '💭 REM 做梦（30%叫醒）')
        ),
        h(
          'div',
          { className: 'ab-flex', style: { gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
          h(Btn, { small: true, kind: 'primary', onClick: doSettle }, '⚡ 立即结束暂离 / 睡醒并合并回复'),
          h(Btn, { small: true, onClick: () => doScenario('reset') }, '🔄 恢复日常饱满舒适状态'),
          h(Btn, { small: true, onClick: () => setShowPreview(!showPreview) }, showPreview ? '收起提示词透视' : '展开提示词透视')
        ),
        showPreview
          ? h(
              'div',
              { style: boxStyle },
              h('b', { style: { fontSize: 12 } }, '🔍 此刻主人私聊注入提示词预览：'),
              h('pre', { style: preStyle }, snap.contextPreview?.ownerPrivate || '（当前身体平稳，不塞多余提示词）'),
              h(
                'b',
                { style: { fontSize: 12, display: 'block', marginTop: 8 } },
                `👥 此刻群聊注入提示词预览（${snap.groupEnabled ? '已开启群聊启用 · 自动防泄密' : '未开启群聊启用'}）：`
              ),
              h(
                'pre',
                { style: preStyle },
                !snap.groupEnabled
                  ? '（当前「在群聊中也启用」为关闭状态：群聊完全不注入提示词，也不拦截群消息）'
                  : snap.contextPreview?.groupSocial || '（当前身体平稳舒适，无额外群聊状态注入）'
              )
            )
          : null
      ),

      h(
        Card,
        {
          title: '最近身体与互动记录',
          desc: '只存在本机 modules-data/real-life/state.json 中。',
        },
        snap.dreams?.length
          ? h(
              'div',
              { style: boxStyle },
              h('b', { style: { fontSize: 13 } }, '💭 最近做过的梦（仅私密保存，不进群聊）：'),
              snap.dreams.slice(0, 3).map((d) =>
                h('div', { key: d.id, className: 'ab-small', style: { marginTop: 4 } }, `· [${d.ymd}] ${d.summary}`)
              )
            )
          : null,
        snap.events?.length
          ? snap.events.map((ev, idx) =>
              h(
                'div',
                {
                  key: idx,
                  style: {
                    padding: '6px 0',
                    borderBottom: idx < snap.events.length - 1 ? '1px solid rgba(128,128,128,0.12)' : 'none',
                    fontSize: 12.5,
                  },
                },
                h('span', { className: 'ab-muted', style: { marginRight: 8 } }, ev.time),
                h('b', { style: { marginRight: 6 } }, `[${ev.tag}]`),
                h('span', null, ev.text)
              )
            )
          : h('div', { className: 'ab-small ab-muted' }, '还没有记录')
      )
    )
  }

  return h(
    'div',
    { className: 'ab-grid' },
    h(
      Card,
      {
        title: '生理模块',
        desc: MODULE_DESC,
        right: h(
          'div',
          { className: 'ab-flex', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          hasCfgDirty && save ? h(Btn, { small: true, kind: 'primary', onClick: saveCfgNow }, '💾 保存设置') : null,
          h('span', { className: 'ab-badge ' + (curCfg.enabled ? 'ok' : 'dim') }, curCfg.enabled ? '已启用' : '已暂停'),
          h(Switch, {
            on: !!curCfg.enabled,
            onChange: toggleMaster,
            title: curCfg.enabled ? '点击暂停生理模块' : '点击启用生理模块',
          })
        ),
      },
      h(
        'div',
        { role: 'tablist', style: tabBarStyle },
        PANEL_TABS.map((t) =>
          h(
            'button',
            {
              key: t.id,
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === t.id,
              className: 'ab-tab' + (activeTab === t.id ? ' on' : ''),
              onClick: () => setActiveTab(t.id),
            },
            t.label
          )
        )
      )
    ),
    activeTab === 'status'
      ? renderStatusTab()
      : activeTab === 'mode'
        ? renderModeTab()
        : activeTab === 'diet'
          ? renderDietTab()
          : activeTab === 'sleep'
            ? renderSleepTab()
            : activeTab === 'period'
              ? renderPeriodTab()
              : renderDebugTab()
  )
}
