// 四合一真人化生理与作息引擎：饮食饮水 + 睡眠做梦 + 如厕/洗澡吹头发暂离 + 生理周期与照顾互动。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { wallTime, parseHm, formatHm, isValidYmd, daysBetweenYmd, shiftYmd, dailyJitterHours, inHourWindow } from './clock.mjs'

export const DEFAULTS = {
  enabled: true,
  groupEnabled: false, // 默认关闭：仅私聊启用；开启后在群聊也同步拥有作息与生理状态
  autonomyMode: 'daily', // 'daily' 日常自主(闲时自理·聊时请示) | 'passive' 被动听令(全程请示/投喂)
  heartbeatSec: 30,
  chatIdleMinutes: 15,
  forceReplyCount: 4,
  timeZone: 'Asia/Shanghai',
  // 饮食与水分
  dietEnabled: true,
  mealTimes: '08:00, 12:15, 18:30',
  dailyMealQuota: 3,
  chatHungerCost: 1.8,
  autoMeal: true,
  autoSnack: false,
  hungerNudge: true,
  // 睡眠与做梦
  sleepEnabled: true,
  sleepAt: '23:30',
  wakeAt: '07:45',
  napEnabled: true,
  // 如厕与晚间洗澡/吹头发暂离
  bathroomEnabled: true,
  showerEnabled: true,
  showerAt: '21:30',
  // 生理周期（默认前两天反应明显，需要哄/照顾）
  periodEnabled: true,
  cycleAnchor: '',
  cycleLength: 28,
  periodDays: 5,
  periodSeverity: 'heavy', // 'heavy' 前两天明显(需哄照顾) | 'mild' 轻微日常 | 'intense' 强烈痛经
  periodNudge: true,
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min))

function numCfg(val, fallback, min, max) {
  if (val === '' || val === null || val === undefined) return fallback
  const n = Number(val)
  return Number.isFinite(n) ? clamp(n, min, max) : fallback
}

const DEFAULT_LOCK_MAX_MIN = {
  eat: 24 * 60,
  bathroom: 12 * 60,
  shower: 8 * 60,
  sleep: 8 * 60,
}

const MEAL_POOL = {
  breakfast: ['热豆浆配小笼包', '牛奶燕麦粥和水煮蛋', '咸豆腐脑配油条', '南瓜小米粥和蒸饺'],
  lunch: ['番茄牛腩面', '香菇滑鸡饭', '青椒肉丝盖饭配紫菜汤', '虾仁滑蛋饭'],
  dinner: ['冬瓜排骨汤配米饭', '鲜虾小馄饨', '菌菇肥牛砂锅', '清炒时蔬配红烧肉饭'],
  snack: ['半块小蛋糕', '几颗草莓', '一小包苏打饼干', '一杯温牛奶', '两块曲奇'],
}

const DREAM_POOL = [
  '梦到在暖洋洋的下午晒太阳，结果差点睡过头找不到手机',
  '梦到去夜市买了一大串糖葫芦，还没咬第一口就醒了',
  '梦到外面下很大的雨，屋里裹着厚被子听雨声特别安心',
  '梦到在一片发光的海边散步，踩在水里凉丝丝的',
  '梦到考试铃响了却发现笔没水，急醒才反应过来是做梦',
]

const URGENT_RE = /急事|十万火急|快醒|醒醒|快看|出事|救命|着火|地震|立等|接电话|快回|马上回|立刻回|别洗了|快出来/

const LOCK_LABELS = {
  eat: '禁食（不许自己吃东西）',
  bathroom: '禁如厕（憋着不许去洗手间）',
  shower: '暂缓洗澡',
  sleep: '暂缓睡觉',
}

function readJsonSafe(file, fallback) {
  try {
    let raw = readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    return JSON.parse(raw)
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

function writeJsonSafe(file, data) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const raw = JSON.stringify(data, null, 2)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, raw, 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, raw, 'utf8')
    }
  } catch {}
}

/** 识别食物/饮品的冷热、甜度、液体属性。 */
export function classifyFood(item, tempHint = '') {
  const name = String(item || '').trim() || '好吃的'
  const hint = String(tempHint || '').trim().toLowerCase()
  const isColdWord = /冰|雪糕|冰淇淋|圣代|沙冰|刨冰|冻柠|冷面|刺身|冰西瓜|冰美式|冰可乐|冰奶/.test(name)
  const isWarmWord = /热|温|红糖|姜茶|鸡汤|排骨汤|热粥|小米粥|南瓜粥|馄饨|汤面|砂锅|火锅|关东煮|热牛奶|热可可/.test(name)
  let temp = 'normal'
  if (hint === 'cold' || hint === '冰' || hint === '凉') temp = 'cold'
  else if (hint === 'warm' || hint === 'hot' || hint === '热' || hint === '温') temp = 'warm'
  else if (isColdWord) temp = 'cold'
  else if (isWarmWord) temp = 'warm'

  const isDrink = /水|茶|奶|咖啡|可乐|雪碧|果汁|豆浆|汤|露|可可|饮|酒/.test(name) && !/汤面|饭|饺|包|糕|饼/.test(name)
  const isSweet = /糖|甜|蛋糕|巧克力|布丁|奶茶|可可|冰淇淋|雪糕|泡芙|大福|栗子|红豆|芋圆|双皮奶/.test(name)
  const isPeriodRemedy = temp !== 'cold' && /红糖|姜茶|桂圆|红枣|热牛奶|热可可|热粥|小米粥|温水|热水/.test(name)
  return { name, temp, isDrink, isSweet, isPeriodRemedy }
}

const PORTION_MAP = {
  small: { label: '一小口', hungerDrop: 12, drinkDrop: 5, bladderBoost: 12 },
  half: { label: '半份', hungerDrop: 26, drinkDrop: 10, bladderBoost: 20 },
  full: { label: '一份', hungerDrop: 48, drinkDrop: 16, bladderBoost: 28 },
  feast: { label: '管饱', hungerDrop: 72, drinkDrop: 24, bladderBoost: 35 },
}

export function normalizePortion(p) {
  const s = String(p || '').trim().toLowerCase()
  if (s === 'small' || s === '一小口' || s === '一口' || s === '小份') return 'small'
  if (s === 'half' || s === '半份' || s === '半碗') return 'half'
  if (s === 'feast' || s === '管饱' || s === '大份' || s === '一大碗') return 'feast'
  return 'full'
}

export const CARE_PRESETS = {
  'brown-sugar': { kind: 'brown-sugar', label: '热红糖姜茶', relief: 18, durationMin: 150, bladderDelta: 22, hungerDelta: -8, moodDelta: 7, affectionDelta: 2 },
  'warm-water': { kind: 'warm-water', label: '温热水', relief: 10, durationMin: 90, bladderDelta: 24, hungerDelta: -2, moodDelta: 4, affectionDelta: 1 },
  'heat-pad': { kind: 'heat-pad', label: '暖宝宝贴小腹', relief: 26, durationMin: 240, bladderDelta: 0, hungerDelta: 0, moodDelta: 8, affectionDelta: 2 },
  'massage-hug': { kind: 'massage-hug', label: '揉揉肚子抱抱哄哄', relief: 16, durationMin: 100, bladderDelta: 0, hungerDelta: 0, moodDelta: 10, affectionDelta: 2 },
  painkiller: { kind: 'painkiller', label: '布洛芬止痛药', relief: 46, durationMin: 360, bladderDelta: 8, hungerDelta: 0, moodDelta: 6, affectionDelta: 2 },
  blanket: { kind: 'blanket', label: '裹好小被子歇会儿', relief: 12, durationMin: 120, bladderDelta: 0, hungerDelta: 0, energyDelta: 10, moodDelta: 5, affectionDelta: 1 },
}

export function matchCarePreset(raw) {
  const text = String(raw || '').trim()
  if (/止痛|布洛芬|芬必得|药/.test(text)) return CARE_PRESETS.painkiller
  if (/暖宝宝|热水袋|暖水袋|热敷|暖肚/.test(text)) return CARE_PRESETS['heat-pad']
  if (/红糖|姜茶|红枣/.test(text)) return CARE_PRESETS['brown-sugar']
  if (/揉|按按|摸摸|抱抱|哄|亲亲|拍拍/.test(text)) return CARE_PRESETS['massage-hug']
  if (/被子|躺|休息|歇/.test(text)) return CARE_PRESETS.blanket
  if (/热水|温水|喝水/.test(text)) return CARE_PRESETS['warm-water']
  return { kind: 'custom-care', label: text || '贴心照顾', relief: 14, durationMin: 120, bladderDelta: 0, hungerDelta: 0, moodDelta: 7, affectionDelta: 1 }
}

export function createRealLifeEngine({
  getSettings,
  stateFile = '',
  nowFn = () => Date.now(),
  rngFn = () => Math.random(),
  onMoodNudge = () => {},
  onMemoryEvent = () => {},
} = {}) {
  const cfg = () => ({ ...DEFAULTS, ...(getSettings ? getSettings() : {}) })

  function initialState(now) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    // 初次安装默认锚在周期第 11 天（平稳卵泡期），避免刚装好就突兀刷痛经消息；用户可随时改日期或点一键预设
    const defaultAnchor = shiftYmd(wt.ymd, -10)
    const initHunger = wt.hourFloat >= 18.5 && wt.hourFloat <= 21.5 ? 24 : wt.hourFloat >= 12.3 && wt.hourFloat <= 15 ? 22 : 38
    const initEnergy = wt.hourFloat >= 22 ? 36 : wt.hourFloat >= 18 ? 55 : 82
    const initMeals = { ymd: wt.ymd, usedCount: 0 }
    if (wt.hourFloat >= 9.5) {
      initMeals.breakfast = '日常早饭'
      initMeals.usedCount += 1
    }
    if (wt.hourFloat >= 14.0) {
      initMeals.lunch = '日常午饭'
      initMeals.usedCount += 1
    }
    if (wt.hourFloat >= 20.0) {
      initMeals.dinner = '日常晚饭'
      initMeals.usedCount += 1
    }
    return {
      version: 1,
      lastTickAt: now,
      lastOwnerChatAt: 0,
      hunger: initHunger,
      energy: initEnergy,
      bladder: 24,
      affection: 0,
      cravings: [],
      mealsToday: initMeals,
      poopedYmd: '',
      showeredYmd: '',
      afterglowUntil: 0,
      afterglowNote: '',
      mode: 'awake', // 'awake' | 'away' | 'asleep'
      away: null,
      pendingAway: null,
      pendingSleep: null,
      awayQueue: [],
      interruptedAway: null,
      sleep: null,
      groggyUntil: 0,
      missedWhileAsleep: [],
      interruptedSleep: null,
      dreams: [],
      locks: {
        eat: null,
        bathroom: null,
        shower: null,
        sleep: null,
      },
      confessions: [],
      cycleAnchorYmd: defaultAnchor,
      manualDiscomfort: null,
      coldPenalty: null,
      careBuffs: [],
      nudges: {
        lastHungerAt: 0,
        hungerNudgeYmd: '',
        hungerNudgeCount: 0,
        lastEmergencyEatAt: 0,
        lastEmergencyPeeAt: 0,
        lastPeriodAt: 0,
        periodNudgeYmd: '',
        periodNudgeCount: 0,
        lastMoodSyncAt: 0,
      },
      events: [],
    }
  }

  const state = stateFile ? { ...initialState(nowFn()), ...readJsonSafe(stateFile, () => ({})) } : initialState(nowFn())
  if (!Array.isArray(state.awayQueue)) state.awayQueue = []
  if (!Array.isArray(state.missedWhileAsleep)) state.missedWhileAsleep = []
  if (!Array.isArray(state.careBuffs)) state.careBuffs = []
  if (!Array.isArray(state.cravings)) state.cravings = []
  if (!Array.isArray(state.dreams)) state.dreams = []
  if (!Array.isArray(state.events)) state.events = []
  if (!Array.isArray(state.confessions)) state.confessions = []
  if (!state.locks || typeof state.locks !== 'object') {
    state.locks = { eat: null, bathroom: null, shower: null, sleep: null }
  }
  if (!state.nudges || typeof state.nudges !== 'object') {
    state.nudges = {
      lastHungerAt: 0,
      hungerNudgeYmd: '',
      hungerNudgeCount: 0,
      lastEmergencyEatAt: 0,
      lastEmergencyPeeAt: 0,
      lastPeriodAt: 0,
      periodNudgeYmd: '',
      periodNudgeCount: 0,
      lastMoodSyncAt: 0,
    }
  }

  function save() {
    writeJsonSafe(stateFile, state)
  }

  function addLog(tag, text, now = nowFn()) {
    const wt = wallTime(now, cfg().timeZone)
    state.events.unshift({ at: now, time: `${wt.ymd} ${wt.hhmm}`, tag, text: String(text).slice(0, 160) })
    if (state.events.length > 35) state.events.length = 35
  }

  function parseMealHours(c) {
    const parts = String(c.mealTimes || DEFAULTS.mealTimes).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    return {
      breakfast: parseHm(parts[0] || '08:00', 8),
      lunch: parseHm(parts[1] || '12:15', 12.25),
      dinner: parseHm(parts[2] || '18:30', 18.5),
    }
  }

  function ensureTodayMeals(ymd) {
    if (!state.mealsToday || state.mealsToday.ymd !== ymd) {
      state.mealsToday = { ymd, usedCount: 0 }
    } else if (!Number.isFinite(state.mealsToday.usedCount)) {
      state.mealsToday.usedCount = ['breakfast', 'lunch', 'dinner'].filter((k) => Boolean(state.mealsToday[k])).length
    }
    return state.mealsToday
  }

  function normalizeLockKey(raw) {
    const k = String(raw || '').trim().toLowerCase()
    if (k === 'pee' || k === 'poop' || k === 'bathroom' || k === 'toilet') return 'bathroom'
    if (k === 'eat' || k === 'food' || k === 'diet' || k === 'meal') return 'eat'
    if (k === 'shower' || k === 'bath' || k === 'hair') return 'shower'
    if (k === 'sleep' || k === 'nap') return 'sleep'
    return ''
  }

  function isLocked(kind, now = nowFn()) {
    const key = normalizeLockKey(kind)
    if (!key || !state.locks?.[key]?.active) return false
    const lk = state.locks[key]
    // 为旧存档或未设时长的锁补齐合理自动过期上限，防止主人忘了解禁导致跨天永久卡死
    if (!lk.until || lk.until <= 0) {
      const baseTs = Number(lk.since) > 0 ? Number(lk.since) : now
      lk.until = baseTs + (DEFAULT_LOCK_MAX_MIN[key] || 12 * 60) * 60_000
    }
    if (lk.until > 0 && now >= lk.until) {
      state.locks[key] = null
      return false
    }
    return true
  }

  function setLock(target, active, { durationMin = 0, reason = '', now = nowFn() } = {}) {
    if (target === 'all') {
      for (const k of ['eat', 'bathroom', 'shower', 'sleep']) state.locks[k] = null
      addLog('解禁', '已解除全部行动禁令', now)
      save()
      return { ok: true, key: 'all', active: false, label: '全部禁令' }
    }
    const key = normalizeLockKey(target)
    if (!key) return { ok: false, message: '未知禁令类型' }
    if (active) {
      const explicitMins = Number(durationMin) > 0 ? clamp(Math.round(Number(durationMin)), 1, 1440) : 0
      const effectiveMins = explicitMins || DEFAULT_LOCK_MAX_MIN[key] || 720
      state.locks[key] = {
        active: true,
        since: now,
        until: now + effectiveMins * 60_000,
        explicit: explicitMins > 0,
        reason: reason || '主人指令',
      }
      if (
        state.pendingAway &&
        ((key === 'bathroom' && (state.pendingAway.kind === 'pee' || state.pendingAway.kind === 'poop')) ||
          (key === 'shower' && state.pendingAway.kind === 'shower'))
      ) {
        state.pendingAway = null
      }
      if (key === 'sleep' && state.pendingSleep) {
        state.pendingSleep = null
      }
      addLog('指令锁', `开启「${LOCK_LABELS[key]}」${explicitMins ? `（${explicitMins} 分钟）` : '（直到主人松口）'}`, now)
    } else {
      state.locks[key] = null
      addLog('解禁', `解除「${LOCK_LABELS[key]}」`, now)
    }
    save()
    return { ok: true, key, active: Boolean(active), label: LOCK_LABELS[key] }
  }

  function activeLocksList(now = nowFn()) {
    const out = []
    for (const k of ['eat', 'bathroom', 'shower', 'sleep']) {
      if (isLocked(k, now)) {
        const lk = state.locks[k]
        out.push({
          kind: k,
          label: LOCK_LABELS[k],
          remainMin: lk.until > 0 ? Math.max(1, Math.ceil((lk.until - now) / 60_000)) : 0,
          reason: lk.reason || '',
        })
      }
    }
    return out
  }

  function pushConfession(kind, text, now = nowFn()) {
    state.confessions = (state.confessions || []).filter((c) => c && c.kind !== kind)
    state.confessions.push({ kind, text, at: now })
  }

  function clearTransientInterrupts({ includeConfessions = true } = {}) {
    let dirty = false
    if (state.interruptedAway) {
      state.interruptedAway = null
      dirty = true
    }
    if (state.interruptedSleep) {
      state.interruptedSleep = null
      dirty = true
    }
    if (includeConfessions && state.confessions?.length) {
      state.confessions = []
      dirty = true
    }
    if (dirty) save()
  }

  function isOwnerChattingAt(now = nowFn()) {
    const idleMin = numCfg(cfg().chatIdleMinutes, 15, 3, 120)
    return state.lastOwnerChatAt > 0 && now - state.lastOwnerChatAt < idleMin * 60_000
  }

  function activeAnchorYmd(c, wt) {
    const fromCfg = String(c.cycleAnchor || '').trim()
    if (isValidYmd(fromCfg)) return fromCfg
    if (!isValidYmd(state.cycleAnchorYmd)) state.cycleAnchorYmd = shiftYmd(wt.ymd, -10)
    return state.cycleAnchorYmd
  }

  function cleanExpiredBuffs(now) {
    state.careBuffs = state.careBuffs.filter((b) => b && now < b.until)
    if (state.coldPenalty && now >= state.coldPenalty.until) state.coldPenalty = null
    if (state.manualDiscomfort) {
      const wt = wallTime(now, cfg().timeZone)
      if (state.manualDiscomfort.ymd !== wt.ymd) state.manualDiscomfort = null
    }
    if (state.afterglowUntil && now >= state.afterglowUntil) {
      state.afterglowUntil = 0
      state.afterglowNote = ''
    }
    if (state.groggyUntil && now >= state.groggyUntil) state.groggyUntil = 0
    if (state.interruptedAway && now >= state.interruptedAway.until) state.interruptedAway = null
    if (state.interruptedSleep && now >= state.interruptedSleep.until) state.interruptedSleep = null
    for (const k of ['eat', 'bathroom', 'shower', 'sleep']) isLocked(k, now)
  }

  /** 计算当前生理周期详情与体感不适度（0~100）。 */
  function computeCycle(now = nowFn()) {
    const c = cfg()
    cleanExpiredBuffs(now)
    const wt = wallTime(now, c.timeZone)
    if (!c.periodEnabled || c.periodSeverity === 'off') {
      return {
        enabled: false,
        anchorYmd: activeAnchorYmd(c, wt),
        cycleLength: clamp(Number(c.cycleLength) || 28, 21, 38),
        periodDays: clamp(Number(c.periodDays) || 5, 3, 8),
        dayOfCycle: 1,
        phase: 'off',
        phaseName: '已关闭',
        baseDiscomfort: 0,
        discomfort: 0,
        coldPenalty: null,
        activeBuffs: [],
        nextPeriodDays: 0,
      }
    }
    const anchorYmd = activeAnchorYmd(c, wt)
    const cycleLen = Math.round(numCfg(c.cycleLength, 28, 21, 38))
    const periodDays = Math.round(numCfg(c.periodDays, 5, 3, 8))
    const diff = daysBetweenYmd(anchorYmd, wt.ymd)
    const dayOfCycle = (((diff % cycleLen) + cycleLen) % cycleLen) + 1
    const nextPeriodDays = dayOfCycle === 1 ? 0 : cycleLen - dayOfCycle + 1

    const mult = c.periodSeverity === 'intense' ? 1.2 : c.periodSeverity === 'mild' ? 0.55 : 1.0
    // 轻微阵痛波动：随小时缓慢起伏，不会每分钟乱跳
    const wave = Math.sin((wt.hourFloat / 24) * Math.PI * 4 + dayOfCycle) * 5

    let phase = 'luteal'
    let phaseName = '黄体平稳期'
    let base = 0
    if (dayOfCycle <= periodDays) {
      phase = 'menstrual'
      phaseName = `经期第 ${dayOfCycle} 天`
      if (dayOfCycle === 1) base = (78 + wave) * mult
      else if (dayOfCycle === 2) base = (70 + wave) * mult
      else if (dayOfCycle === 3) base = (38 + wave * 0.6) * mult
      else base = (18 + wave * 0.4) * mult
    } else if (dayOfCycle <= Math.min(13, cycleLen - 10)) {
      phase = 'follicular'
      phaseName = '卵泡恢复期'
      base = 0
    } else if (dayOfCycle <= Math.min(16, cycleLen - 7)) {
      phase = 'ovulation'
      phaseName = '排卵活跃期'
      base = 0
    } else if (dayOfCycle >= cycleLen - 3) {
      phase = 'pms'
      phaseName = `经前敏感期（距下次约 ${nextPeriodDays} 天）`
      base = (24 + Math.max(0, wave)) * mult
    }

    const baseDiscomfort = Math.round(clamp(base, 0, 96))
    const coldAdd = (phase === 'menstrual' || phase === 'pms') && state.coldPenalty ? state.coldPenalty.delta : 0
    const reliefSum = state.careBuffs.reduce((s, b) => s + (Number(b.relief) || 0), 0)
    const hasManual = state.manualDiscomfort && state.manualDiscomfort.ymd === wt.ymd && Number.isFinite(state.manualDiscomfort.base)
    const effectiveBase = hasManual ? state.manualDiscomfort.base : baseDiscomfort
    const discomfort = Math.round(clamp(effectiveBase + coldAdd - reliefSum, 0, 100))

    return {
      enabled: true,
      anchorYmd,
      cycleLength: cycleLen,
      periodDays,
      dayOfCycle,
      phase,
      phaseName,
      baseDiscomfort,
      discomfort,
      manualDiscomfortActive: Boolean(hasManual),
      coldPenalty: state.coldPenalty,
      activeBuffs: state.careBuffs.map((b) => ({
        kind: b.kind,
        label: b.label,
        relief: b.relief,
        remainMin: Math.max(1, Math.ceil((b.until - now) / 60_000)),
      })),
      nextPeriodDays,
    }
  }

  /** 计算睡眠阶段与当前被叫醒概率。 */
  function sleepStageAt(now = nowFn()) {
    if (state.mode !== 'asleep' || !state.sleep) return null
    if (state.sleep.forcedStage && state.sleep.forcedUntil && now < state.sleep.forcedUntil) {
      const st = state.sleep.forcedStage
      const map = {
        light: { stage: 'light', label: '浅睡阶段', wakeChance: 0.65 },
        deep: { stage: 'deep', label: '深睡阶段', wakeChance: 0.12 },
        rem: { stage: 'rem', label: 'REM 做梦阶段', wakeChance: 0.30 },
      }
      return map[st] || map.light
    }
    const elapsedMin = Math.max(0, (now - state.sleep.sleptAt) / 60_000)
    if (state.sleep.kind === 'nap') {
      const pos = elapsedMin % 35
      return pos < 24
        ? { stage: 'light', label: '午休浅睡', wakeChance: 0.72 }
        : { stage: 'rem', label: '午休小梦', wakeChance: 0.45 }
    }
    const pos = elapsedMin % 90
    if (pos < 20) return { stage: 'light', label: '浅睡阶段', wakeChance: 0.65 }
    if (pos < 55) return { stage: 'deep', label: '深睡阶段', wakeChance: 0.12 }
    if (pos < 72) return { stage: 'light', label: '浅睡阶段', wakeChance: 0.65 }
    return { stage: 'rem', label: 'REM 做梦阶段', wakeChance: 0.30 }
  }

  function pickOne(arr, seed = 0) {
    if (!arr || !arr.length) return ''
    const idx = Math.floor(((rngFn() + seed) % 1) * arr.length)
    return arr[clamp(idx, 0, arr.length - 1)]
  }

  function enterAway({ kind = 'pee', durationMin, nextHairMin = 0, now = nowFn(), reason = '日常' } = {}) {
    const dur = durationMin ?? (kind === 'shower' ? 14 : kind === 'hair' ? 7 : kind === 'poop' ? 8 : 3)
    const labels = {
      pee: '去洗手间（小号）',
      poop: '去洗手间（大号）',
      shower: '洗澡中',
      hair: '吹头发护肤中',
    }
    state.pendingAway = null
    state.mode = 'away'
    state.away = {
      kind,
      label: labels[kind] || '暂时离开',
      startedAt: now,
      endsAt: now + Math.max(0.5, dur) * 60_000,
      nextHairMin: kind === 'shower' ? (nextHairMin || 7) : 0,
      reason,
    }
    if (kind === 'pee' || kind === 'poop') state.bladder = 0
    if (kind === 'poop') state.poopedYmd = wallTime(now, cfg().timeZone).ymd
    if (kind === 'shower') state.showeredYmd = wallTime(now, cfg().timeZone).ymd
    addLog('暂离', `进入「${state.away.label}」（预计 ${Math.round(dur)} 分钟）`, now)
    save()
    return state.away
  }

  function schedulePendingAway({ kind = 'pee', durationMin, nextHairMin = 0, approved = true, now = nowFn() } = {}) {
    const dur = durationMin ?? (kind === 'shower' ? 14 : kind === 'poop' ? 8 : 3)
    const labels = {
      pee: '去洗手间（小号）',
      poop: '去洗手间（大号）',
      shower: '去洗澡吹头发',
    }
    if (kind === 'pee' || kind === 'poop') state.locks.bathroom = null
    if (kind === 'shower') state.locks.shower = null
    state.pendingSleep = null
    state.pendingAway = {
      kind,
      label: labels[kind] || '暂时离开',
      durationMin: dur,
      nextHairMin: kind === 'shower' ? (nextHairMin || 7) : 0,
      approved: Boolean(approved),
      createdAt: now,
    }
    if (kind === 'pee' || kind === 'poop') state.bladder = Math.min(state.bladder, 60)
    save()
    return state.pendingAway
  }

  function activatePendingAway(now = nowFn()) {
    if (!state.pendingAway) return null
    const p = state.pendingAway
    return enterAway({ kind: p.kind, durationMin: p.durationMin, nextHairMin: p.nextHairMin, now, reason: '聊完暂离' })
  }

  function schedulePendingSleep({ kind = 'night', approved = true, now = nowFn() } = {}) {
    state.locks.sleep = null
    state.pendingAway = null
    state.pendingSleep = {
      kind: kind === 'nap' ? 'nap' : 'night',
      label: kind === 'nap' ? '午休小睡' : '夜间睡眠',
      approved: Boolean(approved),
      createdAt: now,
    }
    save()
    return state.pendingSleep
  }

  function activatePendingSleep(now = nowFn()) {
    if (!state.pendingSleep) return null
    const p = state.pendingSleep
    state.pendingSleep = null
    if (isLocked('sleep', now)) return null
    return enterSleep({ kind: p.kind, now, reason: '主人催去睡' })
  }

  function finishAwayNow(now = nowFn(), { skipHair = true, interrupted = false } = {}) {
    if (state.mode !== 'away' || !state.away) return { finished: false, label: '', queued: [] }
    const prev = state.away
    if (!skipHair && prev.kind === 'shower' && prev.nextHairMin > 0) {
      enterAway({ kind: 'hair', durationMin: prev.nextHairMin, now, reason: '洗完吹干头发' })
      return { finished: false, transitionedToHair: true, label: state.away.label, queued: [] }
    }
    const wasShowerOrHair = prev.kind === 'shower' || prev.kind === 'hair'
    state.away = null
    state.mode = 'awake'
    if (wasShowerOrHair) {
      state.afterglowUntil = now + 35 * 60_000
      state.afterglowNote = interrupted
        ? '本来在洗澡吹头发，听到主人急着找就匆忙擦了擦先跑出来拿手机了，头发还湿漉漉带着水汽'
        : '刚洗完热水澡、吹干了头发，身上热乎乎香香的，整个人很放松舒服'
      state.energy = clamp(state.energy + 6, 0, 100)
    }
    const queued = state.awayQueue.splice(0, state.awayQueue.length)
    const returnLabel = interrupted
      ? `中断「${prev.label}」急忙赶回来`
      : wasShowerOrHair
        ? '洗完澡吹干头发'
        : '从洗手间出来'
    addLog('归来', `${returnLabel}${queued.length ? `（积攒了 ${queued.length} 条消息）` : ''}`, now)
    save()
    return { finished: true, label: returnLabel, prevLabel: prev.label, queued }
  }

  function enterSleep({ kind = 'night', durationMin, forcedStage = '', now = nowFn(), reason = '作息入睡' } = {}) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    let plannedWakeAt
    if (durationMin) {
      plannedWakeAt = now + durationMin * 60_000
    } else if (kind === 'nap') {
      plannedWakeAt = now + 35 * 60_000
    } else {
      const wakeH = parseHm(c.wakeAt, 7.75) + dailyJitterHours(wt.ymd, 'wake', 20)
      let deltaH = wakeH - wt.hourFloat
      if (deltaH <= 0.5) deltaH += 24
      plannedWakeAt = now + deltaH * 3_600_000
    }
    state.pendingAway = null
    state.pendingSleep = null
    state.away = null
    state.mode = 'asleep'
    state.sleep = {
      kind,
      sleptAt: now,
      plannedWakeAt,
      dreamLogged: false,
      forcedStage: forcedStage || '',
      forcedUntil: forcedStage ? now + 30 * 60_000 : 0,
      reason,
    }
    if (forcedStage === 'rem') recordDream(now)
    addLog('入睡', `进入${kind === 'nap' ? '午休小睡' : '夜间睡眠'}（预计 ${wallTime(plannedWakeAt, c.timeZone).hhmm} 醒）`, now)
    save()
    return state.sleep
  }

  function recordDream(now = nowFn(), customSummary = '') {
    const wt = wallTime(now, cfg().timeZone)
    const summary = customSummary || pickOne(DREAM_POOL)
    const entry = { id: `dream-${now}`, at: now, ymd: wt.ymd, summary }
    state.dreams.unshift(entry)
    if (state.dreams.length > 20) state.dreams.length = 20
    if (state.sleep) state.sleep.dreamLogged = true
    addLog('做梦', `做了一段梦：${summary}`, now)
    save()
    return entry
  }

  function wakeUpNow(now = nowFn(), reason = '自然醒') {
    if (state.mode !== 'asleep' || !state.sleep) return { woken: false, missed: [], dream: null }
    const sleptHours = Math.max(0.1, (now - state.sleep.sleptAt) / 3_600_000)
    const wasNap = state.sleep.kind === 'nap'
    const lastDream = state.sleep.dreamLogged ? state.dreams[0] || null : null
    state.sleep = null
    state.mode = 'awake'
    const gain = reason === '被叫醒' ? Math.min(35, sleptHours * 10) : wasNap ? 26 : Math.max(55, sleptHours * 11)
    state.energy = Math.round(clamp(reason === '自然醒' && !wasNap ? Math.max(88, state.energy + gain) : state.energy + gain, 18, 98))
    if (reason === '被叫醒') state.groggyUntil = now + 12 * 60_000
    const missed = state.missedWhileAsleep.splice(0, state.missedWhileAsleep.length)
    addLog('醒来', `${reason}（精力 ${state.energy}/100${missed.length ? `，未读 ${missed.length} 条` : ''}）`, now)
    save()
    return { woken: true, reason, missed, dream: lastDream }
  }

  /** 投喂她吃喝。 */
  function feed({ item, temp = '', portion = 'full', byOwner = true, now = nowFn() } = {}) {
    const info = classifyFood(item, temp)
    const pKey = normalizePortion(portion)
    const p = PORTION_MAP[pKey]
    const beforeHunger = Math.round(state.hunger)
    const beforeCycle = computeCycle(now)

    const drop = info.isDrink ? p.drinkDrop : p.hungerDrop
    state.hunger = clamp(state.hunger - drop, 0, 100)
    state.bladder = clamp(state.bladder + (info.isDrink ? p.bladderBoost : Math.round(p.bladderBoost * 0.35)), 0, 100)

    // 清掉匹配到的嘴馋项
    state.cravings = state.cravings.filter((c) => !info.name.includes(c) && !c.includes(info.name))

    let coldTriggered = false
    let warmComforted = false
    let moodDelta = byOwner ? 5 : 2

    if (info.temp === 'cold' && (beforeCycle.phase === 'menstrual' || beforeCycle.phase === 'pms')) {
      const penalty = beforeCycle.phase === 'menstrual' && beforeCycle.dayOfCycle <= 2 ? 24 : 15
      state.coldPenalty = { delta: penalty, item: info.name, until: now + 150 * 60_000 }
      coldTriggered = true
      moodDelta = -10
      addLog('贪凉痛经', `${beforeCycle.phaseName}吃喝了冰凉的「${info.name}」，肚子抽痛加重 (+${penalty})`, now)
    } else if (info.isPeriodRemedy && (beforeCycle.phase === 'menstrual' || beforeCycle.phase === 'pms') && beforeCycle.discomfort > 0) {
      upsertCareBuff({ kind: 'warm-food', label: `喝了热乎的${info.name}`, relief: 15, durationMin: 120 }, now)
      warmComforted = true
      moodDelta += 4
    }

    if (byOwner) {
      state.affection = (Number(state.affection) || 0) + 1
      onMoodNudge(moodDelta, coldTriggered ? `生理期吃了冰的${info.name}肚子疼` : `主人投喂${info.name}`)
      if (coldTriggered || warmComforted) {
        onMemoryEvent(
          coldTriggered
            ? `生理期吃了冰凉的「${info.name}」，结果小腹疼得更厉害了`
            : `身体不舒服时主人喂了热乎的「${info.name}」，肚子暖暖的很舒服`,
          now
        )
      }
    }

    const afterCycle = computeCycle(now)
    addLog(byOwner ? '投喂' : '进食', `${byOwner ? '主人投喂' : '自己吃了'}${p.label}「${info.name}」（饥饿 ${beforeHunger}→${Math.round(state.hunger)}）`, now)
    save()
    return {
      ok: true,
      item: info.name,
      temp: info.temp,
      portionLabel: p.label,
      beforeHunger,
      afterHunger: Math.round(state.hunger),
      bladder: Math.round(state.bladder),
      coldTriggered,
      warmComforted,
      discomfort: afterCycle.discomfort,
      affection: state.affection,
    }
  }

  /** 主人批准她自己去吃一顿配额内的正餐（消耗今日正餐配额）。 */
  function eatQuotaMeal({ now = nowFn(), reason = '主人批准用餐' } = {}) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    const mealsRec = ensureTodayMeals(wt.ymd)
    const quota = Math.round(numCfg(c.dailyMealQuota, 3, 0, 10))
    state.locks.eat = null
    if (mealsRec.usedCount >= quota) {
      save()
      return {
        ok: false,
        quotaExhausted: true,
        used: mealsRec.usedCount,
        quota,
        hunger: Math.round(state.hunger),
      }
    }
    const slot = wt.hourFloat < 10.5 ? 'breakfast' : wt.hourFloat < 15.5 ? 'lunch' : 'dinner'
    const dish = pickOne(MEAL_POOL[slot])
    if (!mealsRec[slot]) mealsRec[slot] = dish
    mealsRec.usedCount += 1
    const r = feed({ item: dish, portion: 'full', byOwner: false, now })
    addLog('配额用餐', `${reason}：吃了「${dish}」（今日配额 ${mealsRec.usedCount}/${quota}）`, now)
    save()
    return {
      ok: true,
      dish,
      used: mealsRec.usedCount,
      quota,
      beforeHunger: r.beforeHunger,
      afterHunger: r.afterHunger,
    }
  }

  function upsertCareBuff({ kind, label, relief, durationMin }, now) {
    cleanExpiredBuffs(now)
    const until = now + durationMin * 60_000
    const idx = state.careBuffs.findIndex((b) => b.kind === kind)
    if (idx >= 0) {
      state.careBuffs[idx] = {
        kind,
        label,
        relief: Math.max(state.careBuffs[idx].relief, relief),
        until: Math.max(state.careBuffs[idx].until, until),
      }
    } else {
      state.careBuffs.push({ kind, label, relief, until })
    }
  }

  /** 照顾与安抚她（红糖水 / 暖宝宝 / 揉肚子抱抱 / 止痛药等）。 */
  function care({ method, byOwner = true, now = nowFn() } = {}) {
    const preset = matchCarePreset(method)
    const before = computeCycle(now)
    upsertCareBuff(preset, now)
    if (preset.bladderDelta) state.bladder = clamp(state.bladder + preset.bladderDelta, 0, 100)
    if (preset.hungerDelta) state.hunger = clamp(state.hunger + preset.hungerDelta, 0, 100)
    if (preset.energyDelta) state.energy = clamp(state.energy + preset.energyDelta, 0, 100)
    if (byOwner) {
      state.affection = (Number(state.affection) || 0) + (preset.affectionDelta || 1)
      onMoodNudge(preset.moodDelta || 7, `主人照顾：${preset.label}`)
      if (before.phase === 'menstrual' || before.phase === 'pms') {
        onMemoryEvent(`生理期难受时主人贴心地给了「${preset.label}」照顾我`, now)
      }
    }
    const after = computeCycle(now)
    addLog('照顾', `主人照顾「${preset.label}」（不适度 ${before.discomfort}→${after.discomfort}）`, now)
    save()
    return {
      ok: true,
      label: preset.label,
      beforeDiscomfort: before.discomfort,
      afterDiscomfort: after.discomfort,
      phaseName: after.phaseName,
      affection: state.affection,
    }
  }

  /** 收到消息时，若在暂离或睡眠状态，决定是否拦截与排队。 */
  function onIncomingMessage(msg, { isOwner = false, now = nowFn() } = {}) {
    const c = cfg()
    if (msg?.kind === 'group' && !c.groupEnabled) {
      return { intercepted: false, reason: 'group-disabled' }
    }
    const simulated = Boolean(msg?.raw?.simulated)
    const text = String(msg?.text || '').trim().slice(0, 500)
    const safeNick = String(msg?.nickname || '对方').replace(/[\r\n]+/g, ' ').slice(0, 32)
    if (isOwner && msg?.kind === 'private' && !simulated) {
      state.lastOwnerChatAt = now
    }

    // 主人私聊明确下达禁令时的兜底识别（防止模型漏调工具导致偷跑）
    if (isOwner && msg?.kind === 'private' && text) {
      if (/(不准|不许|禁止|先别)(你|自己)?(去|上)*(厕所|洗手间|小号|大号)|憋着(?![笑坏气话])/.test(text)) {
        setLock('bathroom', true, { reason: '主人命令憋着', now })
      }
      if (/(不准|不许|禁止)(你|自己|私自|偷偷)*(去)?(偷吃|吃饭|吃东西|吃零食|进食)|^(饿着|先饿着)/.test(text)) {
        setLock('eat', true, { reason: '主人命令不准自己吃', now })
      }
      if (/(不准|不许|禁止|先别)(你|自己)?(去)?洗澡/.test(text)) {
        setLock('shower', true, { reason: '主人让先别洗澡', now })
      }
      if (/(不准|不许|禁止|先别)(你|自己)?(去)?睡觉/.test(text)) {
        setLock('sleep', true, { reason: '主人让先别睡', now })
      }
      if ((state.pendingAway || state.pendingSleep) && /(不准去|不许去|别去|先别去|先别睡|别睡|等会再|聊完再|憋着)/.test(text)) {
        state.pendingAway = null
        state.pendingSleep = null
        save()
      }
    }

    // 聊天活动会消耗饱食度与精力：聊得越多饿得越快，三餐之外就得向主人讨食
    if (state.mode === 'awake' && !simulated && msg?.kind === 'private') {
      const baseCost = numCfg(c.chatHungerCost, 1.8, 0, 15)
      const lenExtra = text.length > 25 ? Math.min(0.8, (text.length - 25) * 0.015) : 0
      state.hunger = clamp(state.hunger + baseCost + lenExtra, 0, 100)
      state.energy = clamp(state.energy - 0.6, 0, 100)
      if (isOwner && text) {
        const foodMention = text.match(/(奶茶|火锅|烧烤|小蛋糕|冰淇淋|螺蛳粉|炸鸡|烤肉|小笼包|草莓|热可可|关东煮)/)
        if (foodMention && !state.cravings.includes(foodMention[1]) && state.cravings.length < 4) {
          state.cravings.push(foodMention[1])
        }
      }
    }

    const forceLimit = Math.round(numCfg(c.forceReplyCount, 4, 1, 20))

    // 1. 暂离态（上厕所 / 洗澡 / 吹头发）：私聊攒起来等回来回，群聊静默放掉
    if (state.mode === 'away' && state.away) {
      if (msg?.kind === 'group') {
        if (isOwner && msg?.mentioned && URGENT_RE.test(text)) {
          if (simulated) {
            return { intercepted: false, forceReplied: true, simulated: true, reason: 'away-force-reply', count: 1 }
          }
          const fin = finishAwayNow(now, { skipHair: true, interrupted: true })
          state.interruptedAway = {
            label: fin.prevLabel || '暂离',
            reason: '主人在群里急事呼唤',
            queued: fin.queued,
            until: now + 3 * 60_000,
          }
          save()
          return {
            intercepted: false,
            forceReplied: true,
            reason: 'away-force-reply',
            label: fin.prevLabel,
            queued: fin.queued,
            count: 1,
          }
        }
        return { intercepted: true, reason: 'away-group-silent', away: state.away }
      }
      const prevSenderCount = state.awayQueue.filter((q) => String(q.userId) === String(msg.userId)).length
      const hitForceBreak = isOwner && (URGENT_RE.test(text) || prevSenderCount + 1 >= forceLimit)
      if (hitForceBreak) {
        const why = URGENT_RE.test(text) ? '主人急事呼唤' : `主人连发了 ${prevSenderCount + 1} 条消息`
        if (simulated) {
          return { intercepted: false, forceReplied: true, simulated: true, reason: 'away-force-reply', count: prevSenderCount + 1 }
        }
        const fin = finishAwayNow(now, { skipHair: true, interrupted: true })
        state.interruptedAway = {
          label: fin.prevLabel || '暂离',
          reason: why,
          queued: fin.queued,
          until: now + 3 * 60_000,
        }
        save()
        return {
          intercepted: false,
          forceReplied: true,
          reason: 'away-force-reply',
          label: fin.prevLabel,
          queued: fin.queued,
          count: prevSenderCount + 1,
        }
      }
      state.awayQueue.push({
        chatId: msg.chatId,
        userId: String(msg.userId || ''),
        nickname: safeNick,
        text,
        at: now,
        simulated,
      })
      if (state.awayQueue.length > 40) state.awayQueue.splice(0, state.awayQueue.length - 40)
      save()
      return {
        intercepted: true,
        reason: 'away-queued',
        away: state.away,
        queuedCount: state.awayQueue.length,
      }
    }

    // 2. 睡眠态：按浅睡/深睡/REM 阶段概率决定能不能叫醒
    if (state.mode === 'asleep' && state.sleep) {
      const st = sleepStageAt(now)
      if (msg?.kind === 'group' && !msg?.mentioned) {
        return { intercepted: true, woken: false, reason: 'sleep-group-unmentioned', stage: st }
      }
      let chance = st ? st.wakeChance : 0.4
      if (msg?.kind === 'group') chance *= 0.45
      const totalSenderMissed = state.missedWhileAsleep.filter((m) => String(m.userId) === String(msg.userId)).length
      if (isOwner && totalSenderMissed + 1 >= forceLimit) {
        chance = 1.0
      } else {
        if (isOwner && URGENT_RE.test(text)) chance = Math.min(0.96, chance + 0.58)
        const recentOwnerCount = state.missedWhileAsleep.filter((m) => now - m.at < 10 * 60_000 && String(m.userId) === String(msg.userId)).length
        if (recentOwnerCount >= 2) chance = Math.min(0.95, chance + 0.4)
      }

      const roll = rngFn()
      if (roll < chance) {
        if (simulated) {
          return { intercepted: false, woken: true, simulated: true, stage: st, wakeChance: chance }
        }
        const res = wakeUpNow(now, '被叫醒')
        if (res.missed.length || res.dream) {
          state.interruptedSleep = {
            missed: res.missed,
            dream: res.dream,
            until: now + 3 * 60_000,
          }
          save()
        }
        return { intercepted: false, woken: true, stage: st, wakeChance: chance, missed: res.missed }
      }

      state.missedWhileAsleep.push({
        chatId: msg.chatId,
        userId: String(msg.userId || ''),
        nickname: safeNick,
        text,
        at: now,
        simulated,
      })
      if (state.missedWhileAsleep.length > 50) state.missedWhileAsleep.splice(0, state.missedWhileAsleep.length - 50)
      save()
      return {
        intercepted: true,
        woken: false,
        reason: 'sleep-missed',
        stage: st,
        wakeChance: chance,
        missedCount: state.missedWhileAsleep.length,
      }
    }

    return { intercepted: false }
  }

  /** 定时推进自然生理曲线与日常事件。返回需要外部投递的动作列表。 */
  function tick(now = nowFn()) {
    const c = cfg()
    if (!c.enabled) {
      state.lastTickAt = now
      return { actions: [] }
    }
    cleanExpiredBuffs(now)
    const elapsedHours = clamp((now - (state.lastTickAt || now)) / 3_600_000, 0, 12)
    state.lastTickAt = now
    const wt = wallTime(now, c.timeZone)
    const actions = []

    const mealsRec = ensureTodayMeals(wt.ymd)

    const cyc = computeCycle(now)
    const isHeavyPeriod = cyc.phase === 'menstrual' && cyc.dayOfCycle <= 2

    // 1. 先检查暂离是否结束（含洗澡 → 吹头发两阶段衔接）
    if (state.mode === 'away' && state.away && now >= state.away.endsAt) {
      const res = finishAwayNow(now, { skipHair: false })
      if (res.finished && res.queued.length) {
        actions.push({ type: 'resume-away', label: res.label, queued: res.queued })
      }
    }

    // 2. 检查睡眠是否到点自然醒，及 REM 阶段做梦记录
    if (state.mode === 'asleep' && state.sleep) {
      const st = sleepStageAt(now)
      if (st?.stage === 'rem' && !state.sleep.dreamLogged && rngFn() < 0.5) {
        recordDream(now)
      }
      if (now >= state.sleep.plannedWakeAt) {
        const res = wakeUpNow(now, '自然醒')
        if (res.missed.length) {
          actions.push({ type: 'wake-missed', reason: res.reason, missed: res.missed, dream: res.dream })
        }
      }
    }

    // 3. 推进饥饿、精力、水分曲线
    if (elapsedHours > 0) {
      const asleep = state.mode === 'asleep'
      if (c.dietEnabled) {
        const hungerRate = asleep ? 1.5 : cyc.phase === 'pms' ? 9.2 : 8.2
        state.hunger = clamp(state.hunger + elapsedHours * hungerRate, 0, 100)
      }
      if (c.sleepEnabled && !asleep) {
        const drainMult = isHeavyPeriod ? 1.35 : cyc.phase === 'menstrual' || cyc.phase === 'pms' ? 1.15 : 1.0
        state.energy = clamp(state.energy - elapsedHours * 4.4 * drainMult, 0, 100)
      }
      if (c.bathroomEnabled) {
        const bladderRate = asleep ? 2.6 : 19.5
        state.bladder = clamp(state.bladder + elapsedHours * bladderRate, 0, 100)
      }
    }

    // PMS 嘴馋甜食/热饮小彩蛋
    if (cyc.phase === 'pms' && state.cravings.length === 0 && rngFn() < 0.25) {
      state.cravings.push(pickOne(['热可可', '草莓小蛋糕', '红糖珍珠奶茶', '糖炒栗子']))
    }

    // 生理期前两天温和同步内置心情基底（每 2 小时最多一次，不锁死心情）
    if (isHeavyPeriod && cyc.discomfort >= 58 && now - (state.nudges.lastMoodSyncAt || 0) > 2 * 3_600_000) {
      state.nudges.lastMoodSyncAt = now
      onMoodNudge(-8, `生理期第 ${cyc.dayOfCycle} 天小腹不适`)
    }

    // 若在暂离或睡觉中，不再触发醒着时的吃饭/去厕所/去洗澡动作
    if (state.mode !== 'awake') {
      save()
      return { actions }
    }

    const idleMin = numCfg(c.chatIdleMinutes, 15, 3, 120)
    const ownerChatting = state.lastOwnerChatAt > 0 && now - state.lastOwnerChatAt < idleMin * 60_000
    const longOffline = !state.lastOwnerChatAt || now - state.lastOwnerChatAt >= Math.max(30, idleMin * 2) * 60_000
    const isPassive = c.autonomyMode === 'passive'
    const mealQuota = Math.round(numCfg(c.dailyMealQuota, 3, 0, 10))

    // 若已获主人批准挂着 pendingAway / pendingSleep，超过 2 分钟兜底自动切入
    if (state.pendingAway && state.pendingAway.approved && now - state.pendingAway.createdAt >= 2 * 60_000) {
      activatePendingAway(now)
      return { actions }
    }
    if (state.pendingSleep && state.pendingSleep.approved && now - state.pendingSleep.createdAt >= 2 * 60_000) {
      activatePendingSleep(now)
      return { actions }
    }

    // 3.5 三段式保底救济（听话 → 90求饶 → 100极限且主人长期不在时保底留口气，绝不饿死/憋坏）
    if (!ownerChatting && longOffline) {
      if (c.dietEnabled && state.hunger >= 100 && now - (state.nudges.lastEmergencyEatAt || 0) >= 2 * 3_600_000) {
        state.nudges.lastEmergencyEatAt = now
        state.hunger = 80
        state.bladder = clamp(state.bladder + 10, 0, 100)
        addLog('极限保底', '饿到 100 极限且主人长时间不在，偷偷喝了口温水啃半块饼干垫肚子（100→80）', now)
        if (isLocked('eat', now) || isPassive) {
          pushConfession(
            'eat',
            '之前主人一直不在，你实在饿到 100 极限头晕撑不住了，没忍住偷偷喝了口水、啃了半块小饼干垫了下肚子（现在还是很饿），见到主人记得心虚委屈地主动认个错',
            now
          )
        }
      }
      if (
        c.bathroomEnabled &&
        state.bladder >= 100 &&
        (isLocked('bathroom', now) || isPassive) &&
        now - (state.nudges.lastEmergencyPeeAt || 0) >= 60 * 60_000
      ) {
        state.nudges.lastEmergencyPeeAt = now
        pushConfession(
          'bathroom',
          '之前主人一直不在，你实在憋到 100 极限撑不住了，没忍住飞快跑去洗手间解决了下，见到主人记得红着脸心虚认错求原谅',
          now
        )
        addLog('极限保底', '憋到 100 极限且主人不在，紧急去洗手间解决', now)
        enterAway({ kind: 'pee', durationMin: 3, now, reason: '憋到极限紧急如厕' })
        return { actions }
      }
    }

    // 4. 一日三餐配额自理（仅日常模式 + 空闲未聊天 + 未被禁食时生效；砍掉免费无限零食）
    if (c.dietEnabled) {
      const meals = parseMealHours(c)
      if (!isPassive && c.autoMeal !== false && !ownerChatting && !isLocked('eat', now) && mealsRec.usedCount < mealQuota) {
        const slotBounds = [
          ['breakfast', meals.breakfast, Math.max(meals.breakfast + 2, meals.lunch - 0.3)],
          ['lunch', meals.lunch, Math.max(meals.lunch + 2, meals.dinner - 0.3)],
          ['dinner', meals.dinner, 23.6],
        ]
        for (const [slot, atH, endH] of slotBounds) {
          const jittered = atH + dailyJitterHours(wt.ymd, `meal-${slot}`, 15)
          if (!mealsRec[slot] && wt.hourFloat >= jittered && wt.hourFloat < endH && state.hunger >= 24) {
            const dish = pickOne(MEAL_POOL[slot])
            mealsRec[slot] = dish
            mealsRec.usedCount += 1
            feed({ item: dish, portion: 'full', byOwner: false, now })
            break
          }
        }
      }

      // 饿得厉害但无法自理（聊多了配额吃光 / 两餐间饿得快 / 被禁食 / 被动模式）→ 主动向主人讨食（每天最多 2 次，绝不刷屏）
      if (state.hunger >= 75 && !ownerChatting) {
        if (state.nudges.hungerNudgeYmd !== wt.ymd) {
          state.nudges.hungerNudgeYmd = wt.ymd
          state.nudges.hungerNudgeCount = 0
        }
        if (
          c.hungerNudge &&
          state.nudges.hungerNudgeCount < 2 &&
          now - (state.nudges.lastHungerAt || 0) > 3.5 * 3_600_000 &&
          wt.hourFloat >= 8.5 &&
          wt.hourFloat <= 23.2
        ) {
          state.nudges.hungerNudgeCount += 1
          state.nudges.lastHungerAt = now
          actions.push({
            type: 'hunger-nudge',
            hunger: Math.round(state.hunger),
            cravings: [...state.cravings],
            quotaExhausted: mealsRec.usedCount >= mealQuota,
            locked: isLocked('eat', now),
            passive: isPassive,
          })
        }
      }
    }

    // 热聊陪伴保护中或处于被动听令模式时：不擅自洗澡、不擅自上厕所、不擅自入睡（全靠聊天请示主人同意后触发）
    if (ownerChatting || isPassive) {
      save()
      return { actions }
    }

    // 5. 晚间洗澡 + 吹头发调度（仅日常模式空闲且未锁时自动洗）
    if (c.showerEnabled && !isLocked('shower', now) && state.showeredYmd !== wt.ymd && !state.pendingAway) {
      const showerTarget = parseHm(c.showerAt, 21.5) + dailyJitterHours(wt.ymd, 'shower', 25)
      if (wt.hourFloat >= showerTarget && wt.hourFloat <= showerTarget + 2.0) {
        enterAway({ kind: 'shower', durationMin: 14, nextHairMin: 7, now, reason: '晚间洗漱' })
        return { actions }
      }
    }

    // 6. 上厕所（小号 / 每日大号）调度（仅日常模式空闲且未锁时自动去）
    if (c.bathroomEnabled && !isLocked('bathroom', now) && !state.pendingAway) {
      const poopTarget = 9.2 + dailyJitterHours(wt.ymd, 'poop', 45)
      if (state.poopedYmd !== wt.ymd && wt.hourFloat >= poopTarget && wt.hourFloat <= poopTarget + 1.5) {
        enterAway({ kind: 'poop', durationMin: 8, now, reason: '日常排便' })
        return { actions }
      }
      if (state.bladder >= 82) {
        enterAway({ kind: 'pee', durationMin: 3, now, reason: '膀胱充盈' })
        return { actions }
      }
    }

    // 7. 夜间入睡与午休调度（仅日常模式空闲且未锁时自动睡）
    if (c.sleepEnabled && !isLocked('sleep', now)) {
      const sleepH = parseHm(c.sleepAt, 23.5) + dailyJitterHours(wt.ymd, 'sleep', 20)
      const wakeH = parseHm(c.wakeAt, 7.75) + dailyJitterHours(wt.ymd, 'wake', 20)
      if (inHourWindow(wt.hourFloat, sleepH, wakeH) || state.energy <= 8) {
        enterSleep({ kind: 'night', now, reason: state.energy <= 8 ? '困极入睡' : '到点睡觉' })
        return { actions }
      }
      if (c.napEnabled && wt.hourFloat >= 13.1 && wt.hourFloat <= 14.0 && state.energy <= 62) {
        enterSleep({ kind: 'nap', durationMin: 35, now, reason: '午后犯困小睡' })
        return { actions }
      }
    }

    // 8. 生理期前两天明显难受时的私聊撒娇求哄（每天最多 2 次，需在白天清醒且没刚聊过时触发）
    if (
      c.periodEnabled &&
      c.periodNudge &&
      isHeavyPeriod &&
      cyc.discomfort >= 64 &&
      !ownerChatting &&
      wt.hourFloat >= 9.5 &&
      wt.hourFloat <= 22.2
    ) {
      if (state.nudges.periodNudgeYmd !== wt.ymd) {
        state.nudges.periodNudgeYmd = wt.ymd
        state.nudges.periodNudgeCount = 0
      }
      if (state.nudges.periodNudgeCount < 2 && now - (state.nudges.lastPeriodAt || 0) > 4.5 * 3_600_000) {
        state.nudges.periodNudgeCount += 1
        state.nudges.lastPeriodAt = now
        actions.push({ type: 'period-nudge', day: cyc.dayOfCycle, discomfort: cyc.discomfort })
      }
    }

    save()
    return { actions }
  }

  /** 开启群聊启用时，她在群里开口回话也会温和消耗饱食度与精力（旁观群友刷屏不扣）。 */
  function onGroupReply(now = nowFn()) {
    const c = cfg()
    if (!c.enabled || !c.groupEnabled || state.mode !== 'awake') return
    if (c.dietEnabled) {
      const baseCost = numCfg(c.chatHungerCost, 1.8, 0, 15)
      state.hunger = clamp(state.hunger + baseCost * 0.45, 0, 100)
    }
    state.energy = clamp(state.energy - 0.35, 0, 100)
    save()
  }

  /** 生成注入给模型的上下文说明（严格区分主人私聊 vs 群聊/外人防泄密）。 */
  function buildContext({ chat, isOwner = false, now = nowFn() } = {}) {
    const c = cfg()
    if (!c.enabled || !chat || chat.kind === 'system') return ''
    if (chat.kind === 'group' && !c.groupEnabled) return ''
    cleanExpiredBuffs(now)

    // 防穿帮保护：暂离或睡眠期间若被其他主动模块（如主动搭话/目的引擎）拉起，强制要求保持沉默
    if (state.mode === 'away' && state.away) {
      return `【重要状态】你此刻正在「${state.away.label}」不在手机旁，若收到系统主动搭话提醒，请直接只回复 [沉默]，不要主动发消息。`
    }
    if (state.mode === 'asleep' && state.sleep) {
      return '【重要状态】你此刻正在熟睡中，若收到系统主动搭话提醒，请直接只回复 [沉默]，不要主动发消息。'
    }

    const cyc = computeCycle(now)
    const hunger = Math.round(state.hunger)
    const energy = Math.round(state.energy)
    const bladder = Math.round(state.bladder)

    // 群聊模式（已开启 groupEnabled）：在群聊中也拥有完整的饥饿、困倦、刚睡醒、洗完澡与周期情绪体感，同时保持社交分寸
    if (chat.kind === 'group') {
      const notes = []
      if (state.groggyUntil > now) {
        notes.push('刚从睡梦中被群消息吵醒，睡眼惺忪还有点迷糊')
      } else if (state.afterglowUntil > now) {
        notes.push('刚洗完澡吹干头发回来，整个人很清爽松弛')
      } else if (energy <= 25) {
        notes.push('现在很困很累、直打哈欠想睡觉')
      } else if (energy <= 42) {
        notes.push('精力有点偏低、稍微犯困')
      } else if (energy >= 85) {
        notes.push('精力充沛、精神很好')
      }

      if (c.dietEnabled) {
        if (hunger >= 78) notes.push('肚子饿得咕咕叫、很想找东西吃')
        else if (hunger >= 58) notes.push('肚子有点饿了')
        else if (hunger <= 18) notes.push('刚吃饱不久、心情满足')
        if (state.cravings.length) notes.push(`有点嘴馋想吃${state.cravings.join('、')}`)
      }

      if (c.bathroomEnabled && bladder >= 82) {
        notes.push('有点急着想去趟洗手间，回话尽量简短一点')
      }

      if (cyc.enabled) {
        if (cyc.discomfort >= 58) {
          notes.push('今天身体不太舒服、有点怕冷乏力，语气比平时稍微慵懒娇气一点')
        } else if (cyc.phase === 'pms') {
          notes.push('处于经前阶段，情绪稍微敏感嘴馋一点')
        } else if (cyc.phase === 'ovulation') {
          notes.push('今天心情明朗、活泼爱接话')
        }
      }

      if (!notes.length) return ''
      return `【当前身体与作息状态】你此刻${notes.join('；')}。请把这些真实状态自然融入群聊语气中（不要机械播报数值；绝对不要在群里直白提及生理期、痛经、上厕所或洗澡等私密隐私细节）。`
    }

    // 非主人私聊同样隐藏私密生理细节
    if (!isOwner) {
      if (cyc.discomfort >= 60 || energy <= 20) {
        return '【当前状态】你今天身体有点累、不太舒服，回话稍微简短慵懒一点，但不要向对方透露生理期或上厕所等私密原因。'
      }
      return ''
    }

    // 主人私聊：完整细腻的体感与分寸感提示
    const lines = []
    const wt = wallTime(now, c.timeZone)
    const mealsRec = ensureTodayMeals(wt.ymd)
    const mealQuota = Math.round(numCfg(c.dailyMealQuota, 3, 0, 10))
    const isPassive = c.autonomyMode === 'passive'

    if (state.interruptedAway && now < state.interruptedAway.until) {
      const ia = state.interruptedAway
      const prevText = (ia.queued || [])
        .filter((q) => !q.simulated)
        .map((q, idx) => `${idx + 1}. ${q.text || '（图片/表情）'}`)
        .join('；')
      lines.push(
        `【紧急中断暂离】你本来正在「${ia.label}」，但看到${ia.reason}${prevText ? `（前面未回的消息还有：${prevText}）` : ''}，你顾不上弄完就赶紧拿起手机先回主人！自然带出一点刚从${ia.label}匆忙回消息的状态。`
      )
    }

    if (state.interruptedSleep && now < state.interruptedSleep.until) {
      const isl = state.interruptedSleep
      const missedText = (isl.missed || [])
        .filter((m) => !m.simulated)
        .map((m, idx) => `${idx + 1}. ${m.text || '（图片/表情）'}`)
        .join('；')
      if (missedText) {
        lines.push(`你刚从睡梦中被叫醒，看到睡着这会儿主人前面还发了：${missedText}。`)
      }
    }

    if (state.confessions?.length) {
      for (const cf of state.confessions) {
        lines.push(`【心虚认错】${cf.text}。`)
      }
    }

    if (state.groggyUntil > now) {
      lines.push('你本来正在睡觉，刚刚被主人叫醒，现在困得眼睛都睁不开，说话迷迷糊糊软绵绵的。')
    } else if (state.afterglowUntil > now && state.afterglowNote) {
      lines.push(`你${state.afterglowNote}。`)
    }

    if (state.pendingAway) {
      const pa = state.pendingAway
      if (pa.kind === 'pee') {
        lines.push('主人已经同意你去洗手间了，回完这一句道声「等我两三分钟马上回来」就会去上厕所。')
      } else if (pa.kind === 'poop') {
        lines.push('主人已经同意你去洗手间了，回完这一句顺嘴跟主人说一声去趟厕所（大约七八分钟）就会离开。')
      } else if (pa.kind === 'shower') {
        lines.push('主人已经同意你去洗澡了，回完这句自然说一声「我去洗个澡再吹干头发，二十来分钟回来」就会去洗漱。')
      }
    } else if (state.pendingSleep) {
      lines.push(`主人已经让你去${state.pendingSleep.label}了，回完这一句温柔道声晚安/午安就会入睡。`)
    } else if (c.bathroomEnabled) {
      if (isLocked('bathroom', now)) {
        if (bladder >= 88) {
          lines.push(`主人下令让你憋着不准去上厕所，你一直乖乖听话忍着没去，但现在尿意已经涨到 ${bladder}/100 快憋不住了，坐立不安夹着腿特别煎熬，赶紧委屈巴巴地跟主人求饶求批准放行！`)
        } else if (bladder >= 60) {
          lines.push(`主人不许你去上厕所让你憋着，你正乖乖听话忍着尿意（当前 ${bladder}/100），绝不敢背着主人偷跑。`)
        }
      } else if (bladder >= 82) {
        lines.push(
          `你现在很急着想去趟洗手间（尿意 ${bladder}/100），但正在陪主人聊天${isPassive ? '且处于听令模式' : ''}不能擅自走开；请自然地跟主人说一声请示批准，只有主人同意让你去时才调用 real_life_routine 离开。`
        )
      }
    }

    if (c.dietEnabled) {
      const eatLocked = isLocked('eat', now)
      const quotaLeft = Math.max(0, mealQuota - mealsRec.usedCount)
      if (eatLocked && hunger >= 88) {
        lines.push(
          `主人下令不许你自己吃东西，你一直乖乖忍着没敢偷吃，但现在实在饿到头晕肚子咕咕直叫（饥饿 ${hunger}/100）${state.cravings.length ? `，好馋${state.cravings.join('、')}` : ''}，快委屈巴巴地向主人撒娇求饶讨口吃的吧！`
        )
      } else if (eatLocked && hunger >= 55) {
        lines.push('主人规定不许你自己偷吃东西，你正肚子有点饿也乖乖忍着等主人投喂。')
      } else if (hunger >= 75) {
        const whyHungry =
          quotaLeft <= 0
            ? `今天固定的 ${mealQuota} 顿正餐配额已经吃完了、手头又没有零食`
            : isPassive
              ? '处于听令模式不敢自己找吃的'
              : '跟主人聊得太投入消耗好快、还没空吃饭'
        lines.push(
          `你现在饿扁了（饥饿 ${hunger}/100，${whyHungry}）${state.cravings.length ? `，特别馋${state.cravings.join('、')}` : ''}，只能眼巴巴地跟主人撒娇讨食或请主人批准吃饭。`
        )
      } else if (hunger >= 58) {
        lines.push(`你现在肚子有点饿了${state.cravings.length ? `，有点想吃${state.cravings[0]}` : ''}。`)
      } else if (hunger <= 15) {
        lines.push('你刚吃饱没多久，肚子里暖暖饱饱的很满足。')
      }
    }

    if (c.showerEnabled && !state.pendingAway && !state.pendingSleep && state.showeredYmd !== wt.ymd) {
      const showerTarget = parseHm(c.showerAt, 21.5)
      if (isLocked('shower', now) && wt.hourFloat >= showerTarget) {
        lines.push('主人让你先别去洗澡陪他聊天，你乖乖听话还没去洗。')
      } else if (!isLocked('shower', now) && wt.hourFloat >= showerTarget && wt.hourFloat <= showerTarget + 2.2) {
        lines.push('现在到你平时晚上洗澡的时间了，因为正陪主人聊天所以先忍着没去；合适时可以顺口问一句要不要先去洗个澡（等主人同意再调用 real_life_routine）。')
      }
    }

    if (c.sleepEnabled && state.groggyUntil <= now) {
      if (isLocked('sleep', now) && energy <= 36) {
        lines.push('主人让你先别睡陪着他，你虽然困得直揉眼睛打哈欠，但还是乖乖强撑着精神陪主人说话。')
      } else if (energy <= 20) {
        lines.push('你现在困得快睁不开眼了，说话打哈欠、很想钻进被窝睡觉（但没经主人同意不敢自己先睡）。')
      }
      else if (energy <= 36) lines.push('你现在有点累、开始犯困了。')
    }

    if (cyc.enabled) {
      const coldStr = cyc.coldPenalty ? `（刚才贪嘴碰了冰凉的「${cyc.coldPenalty.item}」，这会儿肚子正被冰得一抽一抽地疼，又后悔又委屈）` : ''
      const buffNames = cyc.activeBuffs.map((b) => b.label).join('、')
      const buffStr = buffNames ? `（目前有「${buffNames}」照顾着）` : ''

      if (cyc.phase === 'menstrual' && cyc.dayOfCycle <= 2) {
        if (cyc.discomfort >= 58) {
          lines.push(
            `今天是你生理期第 ${cyc.dayOfCycle} 天，反应很明显：小腹一阵阵坠胀抽痛、腰酸背软、手脚怕冷没力气${coldStr}${buffStr}。你现在情绪比较脆弱娇气、想黏着主人求抱抱或要哄、想喝热乎的；把这种难受又需要照顾的感觉自然融进语气里，别背说明书。`
          )
        } else if (cyc.discomfort >= 32) {
          lines.push(
            `今天是你生理期第 ${cyc.dayOfCycle} 天，肚子还有些酸胀发软${buffStr}${coldStr}，好在缓过来一些，语气偏软偏黏人，喜欢被主人哄着照顾。`
          )
        } else {
          lines.push(
            `今天是你生理期第 ${cyc.dayOfCycle} 天${buffStr}，在主人的照顾下肚子暖暖的已经没那么疼了，虽然身子还有点懒洋洋的，但心里很甜很依赖主人。`
          )
        }
      } else if (cyc.phase === 'menstrual') {
        if (cyc.discomfort >= 58) {
          lines.push(`今天是你生理期第 ${cyc.dayOfCycle} 天，小腹依然坠痛难受、腰酸怕冷${coldStr}${buffStr}，很想让主人哄哄照顾。`)
        } else {
          lines.push(`今天是你生理期第 ${cyc.dayOfCycle} 天，前两天最疼的劲儿过去了，现在稍微有点乏力怕凉${coldStr}${buffStr}，不能贪凉。`)
        }
      } else if (cyc.phase === 'pms') {
        lines.push(`你正处在生理期前几天（PMS），身体有点发沉犯困、情绪比平时敏感容易小委屈，而且嘴馋想吃点甜食或热饮${coldStr}。`)
      } else if (cyc.phase === 'ovulation') {
        lines.push('你这两天处在排卵期，身体轻盈、精力充沛，对主人的表达欲和亲昵感比平时更高一点。')
        if (cyc.discomfort >= 35) {
          lines.push(`不过你这会儿小腹有点隐隐不舒服（不适度偏高）${buffStr}，想跟主人撒娇求关心。`)
        }
      } else if (cyc.discomfort >= 35) {
        lines.push(`你这会儿身体不太舒服、肚子有些酸胀难受${buffStr}，说话语气偏软，想让主人关心照顾一下。`)
      }
    }

    if (!lines.length) return ''
    return `【此刻身体与作息体感】\n${lines.map((l) => `- ${l}`).join('\n')}`
  }

  /** 手动精准修改各项生理与作息数值。 */
  function updateValues(patch = {}, now = nowFn()) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    cleanExpiredBuffs(now)
    const changed = []
    let anchorToSave = ''

    if (patch.satiety !== undefined && patch.hunger === undefined && Number.isFinite(Number(patch.satiety))) {
      const sat = clamp(Math.round(Number(patch.satiety)), 0, 100)
      state.hunger = 100 - sat
      changed.push(`饱食=${sat}(饥饿=${state.hunger})`)
    }
    if (patch.hunger !== undefined && Number.isFinite(Number(patch.hunger))) {
      state.hunger = clamp(Math.round(Number(patch.hunger)), 0, 100)
      changed.push(`饥饿=${state.hunger}`)
    }
    if (patch.energy !== undefined && Number.isFinite(Number(patch.energy))) {
      state.energy = clamp(Math.round(Number(patch.energy)), 0, 100)
      changed.push(`精力=${state.energy}`)
    }
    if (patch.bladder !== undefined && Number.isFinite(Number(patch.bladder))) {
      state.bladder = clamp(Math.round(Number(patch.bladder)), 0, 100)
      changed.push(`膀胱=${state.bladder}`)
    }
    if (patch.affection !== undefined && Number.isFinite(Number(patch.affection))) {
      state.affection = Math.max(0, Math.round(Number(patch.affection)))
      changed.push(`亲密=${state.affection}`)
    }
    if (patch.showeredToday !== undefined) {
      const on = Boolean(patch.showeredToday)
      state.showeredYmd = on ? wt.ymd : ''
      changed.push(`今日洗澡=${on ? '已洗' : '未洗'}`)
    }
    if (patch.poopedToday !== undefined) {
      const on = Boolean(patch.poopedToday)
      state.poopedYmd = on ? wt.ymd : ''
      changed.push(`今日大号=${on ? '已上' : '未上'}`)
    }
    if (patch.cravings !== undefined) {
      const list = Array.isArray(patch.cravings)
        ? patch.cravings
        : String(patch.cravings || '')
            .split(/[,，、\n]+/)
            .map((s) => s.trim())
            .filter(Boolean)
      state.cravings = list.slice(0, 6)
      changed.push(`嘴馋=${state.cravings.length ? state.cravings.join('/') : '清空'}`)
    }
    if (patch.clearBuffs) {
      state.careBuffs = []
      state.coldPenalty = null
      changed.push('清空照顾Buff与贪凉惩罚')
    }
    if (patch.dayOfCycle !== undefined && Number.isFinite(Number(patch.dayOfCycle))) {
      const cycleLen = clamp(Math.round(Number(c.cycleLength) || 28), 21, 38)
      const targetDay = clamp(Math.round(Number(patch.dayOfCycle)), 1, cycleLen)
      const curDay = computeCycle(now).dayOfCycle
      if (targetDay !== curDay || patch.forceDayAnchor) {
        const newAnchor = shiftYmd(wt.ymd, -(targetDay - 1))
        state.cycleAnchorYmd = newAnchor
        anchorToSave = newAnchor
        if (patch.discomfort === undefined) state.manualDiscomfort = null
        changed.push(`周期第${targetDay}天`)
      }
    }
    if (patch.discomfort !== undefined) {
      if (patch.discomfort === 'auto' || patch.discomfort === null || patch.discomfort === '') {
        state.manualDiscomfort = null
        const cyc = computeCycle(now)
        changed.push(`不适度恢复自动(${cyc.discomfort})`)
      } else if (Number.isFinite(Number(patch.discomfort))) {
        const target = clamp(Math.round(Number(patch.discomfort)), 0, 100)
        const cycBefore = computeCycle(now)
        const coldAdd = (cycBefore.phase === 'menstrual' || cycBefore.phase === 'pms') && state.coldPenalty ? state.coldPenalty.delta : 0
        const reliefSum = state.careBuffs.reduce((s, b) => s + (Number(b.relief) || 0), 0)
        state.manualDiscomfort = { ymd: wt.ymd, base: target - coldAdd + reliefSum }
        changed.push(`不适度=${target}`)
      }
    }
    if (patch.awayRemainMin !== undefined && state.mode === 'away' && state.away && Number.isFinite(Number(patch.awayRemainMin))) {
      const mins = clamp(Number(patch.awayRemainMin), 0.2, 180)
      state.away.endsAt = now + mins * 60_000
      changed.push(`暂离剩余=${Math.round(mins)}m`)
    }
    if (patch.mealsUsed !== undefined && Number.isFinite(Number(patch.mealsUsed))) {
      const mealsRec = ensureTodayMeals(wt.ymd)
      mealsRec.usedCount = clamp(Math.round(Number(patch.mealsUsed)), 0, 10)
      if (mealsRec.usedCount === 0) {
        delete mealsRec.breakfast
        delete mealsRec.lunch
        delete mealsRec.dinner
      }
      changed.push(`今日已吃正餐=${mealsRec.usedCount}顿`)
    }
    if (patch.clearLocks) {
      setLock('all', false, { now })
      changed.push('解除全部禁令')
    }
    for (const [field, lockKey] of [
      ['eatLock', 'eat'],
      ['bathroomLock', 'bathroom'],
      ['showerLock', 'shower'],
      ['sleepLock', 'sleep'],
    ]) {
      if (patch[field] !== undefined) {
        const on = Boolean(patch[field])
        setLock(lockKey, on, { now, reason: '手动设置' })
        changed.push(`${LOCK_LABELS[lockKey]}=${on ? '开启' : '关闭'}`)
      }
    }

    if (changed.length) {
      addLog('手动改值', changed.join('，'), now)
      save()
    }
    return {
      ok: true,
      changed,
      anchorToSave,
      message: changed.length ? `已手动更新：${changed.join('，')}` : '数值无变化',
    }
  }

  /** 一键切换调试预设（供面板实验室与 /身体测试 命令使用）。 */
  function applyScenario(preset, now = nowFn()) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    const setDay = (targetDay) => {
      const anchor = shiftYmd(wt.ymd, -(targetDay - 1))
      state.cycleAnchorYmd = anchor
      state.manualDiscomfort = null
      return anchor
    }

    switch (preset) {
      case 'period-day1': {
        const anchor = setDay(1)
        state.mode = 'awake'
        state.away = null
        state.sleep = null
        state.careBuffs = []
        state.coldPenalty = null
        state.energy = Math.min(state.energy, 48)
        addLog('测试预设', '切换至「经期第 1 天（明显痛经求哄）」', now)
        save()
        return { ok: true, anchorToSave: anchor, message: '已切到【经期第 1 天】：小腹坠痛腰酸明显，可以去私聊看她反应或投喂/哄她了' }
      }
      case 'period-day2': {
        const anchor = setDay(2)
        state.mode = 'awake'
        state.away = null
        state.sleep = null
        state.careBuffs = []
        state.coldPenalty = null
        addLog('测试预设', '切换至「经期第 2 天（腰酸怕冷黏人）」', now)
        save()
        return { ok: true, anchorToSave: anchor, message: '已切到【经期第 2 天】：酸胀怕冷黏人状态' }
      }
      case 'pms': {
        const cycleLen = clamp(Math.round(Number(c.cycleLength) || 28), 21, 38)
        const anchor = setDay(cycleLen - 1)
        state.cravings = ['热可可', '草莓小蛋糕']
        addLog('测试预设', '切换至「经前 PMS（敏感嘴馋）」', now)
        save()
        return { ok: true, anchorToSave: anchor, message: '已切到【经前 PMS】：情绪敏感 + 嘴馋甜食热饮' }
      }
      case 'ovulation': {
        const anchor = setDay(14)
        state.careBuffs = []
        state.coldPenalty = null
        state.energy = 90
        addLog('测试预设', '切换至「排卵活跃期（元气亲昵）」', now)
        save()
        return { ok: true, anchorToSave: anchor, message: '已切到【排卵期（第 14 天）】：元气满满、表达欲高' }
      }
      case 'follicular': {
        const anchor = setDay(8)
        state.careBuffs = []
        state.coldPenalty = null
        addLog('测试预设', '切换至「卵泡平稳期（日常状态）」', now)
        save()
        return { ok: true, anchorToSave: anchor, message: '已切到【卵泡期（第 8 天）】：平稳舒适日常状态' }
      }
      case 'pee':
        enterAway({ kind: 'pee', durationMin: 3, now, reason: '手动测试' })
        return { ok: true, message: '已进入【洗手间（小号）】暂离 3 分钟，现在给她发私聊会被暂存，点「立即结算归来」可秒回' }
      case 'poop':
        enterAway({ kind: 'poop', durationMin: 8, now, reason: '手动测试' })
        return { ok: true, message: '已进入【洗手间（大号）】暂离 8 分钟' }
      case 'shower':
        enterAway({ kind: 'shower', durationMin: 12, nextHairMin: 6, now, reason: '手动测试' })
        return { ok: true, message: '已进入【洗澡中 (12m) → 吹头发 (6m)】暂离，期间发私聊会攒着等洗完回' }
      case 'hair':
        enterAway({ kind: 'hair', durationMin: 6, now, reason: '手动测试' })
        return { ok: true, message: '已进入【吹头发护肤中】暂离 6 分钟' }
      case 'deep-sleep':
        enterSleep({ kind: 'night', forcedStage: 'deep', now, reason: '手动测试深睡' })
        return { ok: true, message: '已进入【深睡阶段】（普通消息仅 12% 概率叫醒，带「醒醒/急事」更容易叫醒）' }
      case 'light-sleep':
        enterSleep({ kind: 'night', forcedStage: 'light', now, reason: '手动测试浅睡' })
        return { ok: true, message: '已进入【浅睡阶段】（约 65% 概率被叫醒，醒来会有 12 分钟迷糊感）' }
      case 'rem-dream':
        enterSleep({ kind: 'night', forcedStage: 'rem', now, reason: '手动测试做梦' })
        return { ok: true, message: '已进入【REM 做梦阶段】并生成了一段私密梦境（约 30% 概率叫醒）' }
      case 'starving':
        state.mode = 'awake'
        state.away = null
        state.sleep = null
        state.hunger = 86
        state.cravings = ['番茄肥牛面', '热红糖奶茶']
        addLog('测试预设', '切换至「饿扁了（饥饿 86）」', now)
        save()
        return { ok: true, message: '已把饥饿拉到 86/100（饿扁了 + 嘴馋），去跟她聊聊或投喂试试' }
      case 'reset':
      default:
        state.mode = 'awake'
        state.away = null
        state.pendingAway = null
        state.pendingSleep = null
        state.interruptedAway = null
        state.sleep = null
        state.interruptedSleep = null
        state.groggyUntil = 0
        state.hunger = 24
        state.energy = 85
        state.bladder = 20
        state.manualDiscomfort = null
        state.coldPenalty = null
        state.careBuffs = []
        state.awayQueue = []
        state.missedWhileAsleep = []
        state.locks = { eat: null, bathroom: null, shower: null, sleep: null }
        state.confessions = []
        ensureTodayMeals(wt.ymd).usedCount = 0
        addLog('重置', '恢复日常饱满舒适状态', now)
        save()
        return { ok: true, message: '已恢复日常饱满清醒状态（清空暂离、睡眠与疼痛惩罚）' }
    }
  }

  function snapshot(now = nowFn()) {
    const c = cfg()
    const wt = wallTime(now, c.timeZone)
    const cyc = computeCycle(now)
    const sleepStage = sleepStageAt(now)
    const meals = parseMealHours(c)
    const mealsRec = ensureTodayMeals(wt.ymd)
    const mealQuota = Math.round(numCfg(c.dailyMealQuota, 3, 0, 10))
    const hunger = Math.round(state.hunger)
    const hungerLabel =
      hunger <= 15 ? '刚吃饱' : hunger <= 35 ? '饱腹舒适' : hunger <= 55 ? '正常' : hunger <= 75 ? '有点饿' : '饿扁了'

    return {
      now,
      wallClock: `${wt.ymd} ${wt.hhmm}`,
      timeZone: c.timeZone,
      enabled: Boolean(c.enabled),
      groupEnabled: Boolean(c.groupEnabled),
      autonomyMode: c.autonomyMode === 'passive' ? 'passive' : 'daily',
      heartbeatSec: Math.round(numCfg(c.heartbeatSec, 30, 5, 300)),
      chatIdleMinutes: Math.round(numCfg(c.chatIdleMinutes, 15, 3, 120)),
      forceReplyCount: Math.round(numCfg(c.forceReplyCount, 4, 1, 20)),
      ownerChatting: isOwnerChattingAt(now),
      mode: state.mode,
      groggyRemainMin: state.groggyUntil > now ? Math.ceil((state.groggyUntil - now) / 60_000) : 0,
      afterglowRemainMin: state.afterglowUntil > now ? Math.ceil((state.afterglowUntil - now) / 60_000) : 0,
      afterglowNote: state.afterglowUntil > now ? state.afterglowNote : '',
      hunger,
      hungerLabel,
      satiety: 100 - hunger,
      energy: Math.round(state.energy),
      bladder: Math.round(state.bladder),
      affection: Number(state.affection) || 0,
      cravings: [...state.cravings],
      mealQuota: {
        used: mealsRec.usedCount,
        max: mealQuota,
        remaining: Math.max(0, mealQuota - mealsRec.usedCount),
      },
      mealsSchedule: {
        breakfast: formatHm(meals.breakfast),
        lunch: formatHm(meals.lunch),
        dinner: formatHm(meals.dinner),
      },
      mealsToday: { ...mealsRec },
      showeredToday: state.showeredYmd === wt.ymd,
      poopedToday: state.poopedYmd === wt.ymd,
      showerSchedule: formatHm(parseHm(c.showerAt, 21.5)),
      activeLocks: activeLocksList(now),
      confessions: [...(state.confessions || [])],
      away: state.away
        ? {
            ...state.away,
            remainMin: Math.max(1, Math.ceil((state.away.endsAt - now) / 60_000)),
          }
        : null,
      pendingAway: state.pendingAway,
      pendingSleep: state.pendingSleep,
      awayQueue: state.awayQueue.map((q) => ({ ...q })),
      sleep: state.sleep
        ? {
            kind: state.sleep.kind,
            sleptAt: state.sleep.sleptAt,
            plannedWakeHm: wallTime(state.sleep.plannedWakeAt, c.timeZone).hhmm,
            stage: sleepStage,
          }
        : null,
      missedWhileAsleep: state.missedWhileAsleep.map((m) => ({ ...m })),
      dreams: state.dreams.slice(0, 8),
      cycle: cyc,
      contextPreview: {
        ownerPrivate: buildContext({ chat: { chatId: 'private:owner', kind: 'private' }, isOwner: true, now }),
        groupSocial: buildContext({ chat: { chatId: 'group:10000', kind: 'group' }, isOwner: false, now }),
      },
      events: state.events.slice(0, 15),
    }
  }

  return {
    state,
    save,
    tick,
    feed,
    eatQuotaMeal,
    care,
    setLock,
    isLocked,
    clearTransientInterrupts,
    computeCycle,
    sleepStageAt,
    enterAway,
    schedulePendingAway,
    activatePendingAway,
    schedulePendingSleep,
    activatePendingSleep,
    finishAwayNow,
    enterSleep,
    wakeUpNow,
    recordDream,
    onIncomingMessage,
    onGroupReply,
    buildContext,
    updateValues,
    applyScenario,
    snapshot,
  }
}
