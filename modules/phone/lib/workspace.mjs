// workspace.mjs —— 工作区回合驱动 + 简单 cron 解析（契约 A 节签名仲裁）
// 作用：占锁 → 逐「观察→决策→守门→执行」循环遥控手机完成一句话任务 → 收尾存记忆、放锁。
// 观察层：节点优先（uiautomator brief），当轮取不到节点就立刻截图兜底（视觉模型按像素坐标决策，
//         tap 支持 xy 形态）；模型看不了图才退回 back+重试（连续三次坏步中止）。
// 契约：export async function runWorkspace({ flowKey, prompt, packages = [], maxSteps = 40, guide = '', guideFor = null, ctx })
//   guide：常驻「主流程总纲」（传了 guideFor 时）；只传 guide 不传 guideFor = 整场一份应用手册（旧用法）
//   guideFor(pkg) → 手册文本或 ''：按当前前台应用按需加载单应用手册（省 token），每包只解析一次
//   ctx = { adb, session, safety, memory, ask, report?(chatId, text) }
//   → { ok, summary, steps }
// 另 export cronMatch(expr, date)：五字段简单 cron（分 时 日 月 周），支持 * / 数字 / */n / 逗号列表。

import { parseNodes, nodeCenter } from './nodes.mjs'

/** 五字段 cron 匹配：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6，0=周日) */
export function cronMatch(expr, date) {
  if (!expr || typeof expr !== 'string') return false
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(), // JS 周日=0，与 cron 惯例一致
  ]
  const bases = [0, 0, 1, 1, 0] // 各字段取值下限（*/n 从下限起算）
  return parts.every((field, i) => field.split(',').some((item) => {
    const f = item.trim()
    if (f === '*') return true
    const step = f.match(/^\*\/(\d+)$/) // */n：从下限起每 n 取一次
    if (step) {
      const n = Number(step[1])
      return n > 0 && (values[i] - bases[i]) % n === 0
    }
    const num = Number(f)
    return Number.isInteger(num) && num === values[i]
  }))
}

/** 稳健解析模型回复里的 JSON 动作：剥 ```json 围栏、取首个 {...}、容错单引号 */
function parseAction(text) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch { /* 继续容错 */ }
  try {
    // 容错单引号键名/字符串：先把 "键 : " 补成双引号键，再把残余单引号换成双引号
    const fixed = s.replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ': "$1"')
    return JSON.parse(fixed)
  } catch {
    return null
  }
}

/** 等一小段毫秒（双击两次 tap 之间留间隙用）。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析 tap / double_tap / long_press 共用的目标坐标：节点号 n（节点模式）> 像素坐标 xy（截图兜底） */
function resolveTarget(act, nodeList) {
  let center = null
  if (act.n != null && act.n !== '') center = nodeCenter(nodeList, Number(act.n))
  if (!center && Array.isArray(act.xy) && act.xy.length === 2 && act.xy.every((v) => Number.isFinite(v) && v > 0)) {
    center = [Math.round(act.xy[0]), Math.round(act.xy[1])]
  }
  if (!center) return { note: act.xy !== undefined ? '坐标 xy 不合法' : `节点 ${act.n} 不存在` }
  return { center }
}

/** scroll 持续时长：模型给的 ms 夹在 100~2000，缺省 300。 */
function scrollMs(act) {
  const n = Number(act.ms)
  return Number.isFinite(n) ? Math.min(2000, Math.max(100, Math.round(n))) : 300
}

/** 把一次模型决策过安全门并执行；返回 { done, note } */
async function applyAction(adb, safety, pkg, act, nodeList) {
  const kind = String(act.action || '').toLowerCase()
  if (kind === 'finish') return { done: true, note: String(act.summary || '任务完成') }

  // 判定本步涉及的界面文本（供写操作关键词判定）：节点 text **和 content-desc** 都算
  // （一审 #19-4：只有 content-desc 的图标按钮，之前只看 text 会漏判写操作）。
  let nodeText = ''
  let blind = false // 盲点：坐标动作（没有节点文字）时无法判断是不是写操作
  if (act.n != null && act.n !== '') {
    const node = nodeList[Number(act.n)]
    if (!node || !nodeCenter(nodeList, Number(act.n))) return { done: false, note: `节点 ${act.n} 不存在` }
    nodeText = [node.text, node.desc].filter(Boolean).join(' ')
  }
  // 复审第 4 条：坐标动作（tap/double_tap/long_press）一律按「盲点」算——不能靠模型自己填 text 绕过；
  // 只有节点模式命中 text/desc 才算有依据。
  if (!nodeText && ['tap', 'double_tap', 'long_press'].includes(kind)) blind = true
  // 回车发送：key enter 也会提交内容，写操作确认开着时按写操作处理。
  if (kind === 'key' && String(act.name || '').toLowerCase() === 'enter' && !nodeText) nodeText = '回车发送'
  if (!nodeText) nodeText = String(act.text || '')

  const verdict = await safety.gate({ pkg, nodeText, blind })
  if (verdict === 'NEED_CONFIRM') return { done: true, confirm: true, note: '等待主人批准写操作，回合暂停（phone confirm 查看）' }
  if (verdict === 'REJECT') return { done: false, note: `该动作被安全策略拒绝（${nodeText || kind}）` }
  if (verdict === 'DRY_RUN') return { done: false, note: `试运行：计划 ${kind}${nodeText ? '「' + nodeText + '」' : ''}，未执行` }

  // ALLOW：真执行
  try {
    switch (kind) {
      case 'tap': {
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        await adb.tap(t.center[0], t.center[1])
        break
      }
      case 'double_tap': {
        // 双击：两次 tap 留 80ms 间隙，慢于系统双击阈值（约 300ms）会被当成两次单击
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        await adb.tap(t.center[0], t.center[1])
        await sleep(80)
        await adb.tap(t.center[0], t.center[1])
        break
      }
      case 'long_press': {
        // 长按：默认 800ms，可用 ms 参数（600~2000）调时长；弹出菜单/多选/拖拽入口用
        const t = resolveTarget(act, nodeList)
        if (!t.center) return { done: false, note: t.note }
        await adb.longPress(t.center[0], t.center[1], Number(act.ms) || 800)
        break
      }
      case 'input':
        await adb.inputText(String(act.text || ''))
        break
      case 'clear': {
        // 清空已输入内容：给了目标（n/xy）就先点一下聚焦，再清空当前输入框
        if (act.n != null && act.n !== '' || Array.isArray(act.xy)) {
          const t = resolveTarget(act, nodeList)
          if (!t.center) return { done: false, note: t.note }
          await adb.tap(t.center[0], t.center[1])
        }
        await adb.clearText()
        break
      }
      case 'drag': {
        // 精确拖拽：起点（n/xy，同 tap）拖到终点 to:[x,y]（或 to_n 节点），ms 可选（100~5000，默认 600）
        const from = resolveTarget(act, nodeList)
        if (!from.center) return { done: false, note: from.note }
        let to = null
        if (act.to_n != null && act.to_n !== '') to = nodeCenter(nodeList, Number(act.to_n))
        if (!to && Array.isArray(act.to) && act.to.length === 2 && act.to.every((v) => Number.isFinite(v) && v > 0)) {
          to = [Math.round(act.to[0]), Math.round(act.to[1])]
        }
        if (!to) return { done: false, note: '终点 to/to_n 不合法' }
        const ms = Math.min(5000, Math.max(100, Number.isFinite(Number(act.ms)) ? Math.round(Number(act.ms)) : 600))
        await adb.swipe(from.center[0], from.center[1], to[0], to[1], ms)
        break
      }
      case 'key':
        // 白名单按键：enter/tab/volume_up/volume_down/power/notifications；软键盘没「搜索」键时用 enter 顶
        await adb.key(act.name)
        break
      case 'wait': {
        // 等待加载/转场：不碰设备纯空转，夹 500~10000ms，缺省 1000
        const n = Number(act.ms)
        const ms = Number.isFinite(n) ? Math.min(10000, Math.max(500, Math.round(n))) : 1000
        await sleep(ms)
        break
      }
      case 'scroll': {
        // 从屏幕中部向指定方向滑一屏（默认 1080x2340 量级坐标，够用即可）
        // up=内容上移看下方；left=向左滑看右侧；right=向右滑看左侧（横滑也支持 ms 调速）
        const ms = scrollMs(act)
        switch (act.dir) {
          case 'up': await adb.swipe(540, 700, 540, 1800, ms); break
          case 'left': await adb.swipe(900, 1170, 180, 1170, ms); break
          case 'right': await adb.swipe(180, 1170, 900, 1170, ms); break
          default: await adb.swipe(540, 1800, 540, 700, ms)
        }
        break
      }
      case 'back': await adb.pressKey('back'); break
      case 'home': await adb.pressKey('home'); break
      case 'launch': await adb.launchApp(String(act.pkg || act.text || '')); break
      default:
        return { done: false, note: `未知动作 ${kind}` }
    }
    return { done: false, note: `已执行 ${kind}${nodeText ? '「' + nodeText + '」' : ''}` }
  } catch (e) {
    return { done: false, note: `动作执行失败：${e.message}` }
  }
}

/**
 * 截图兜底：uiautomator 取不到节点（渲染层视频流 / 游戏 / 部分 WebView 常见）时，
 * 当轮立刻截整屏交给视觉模型按像素坐标决策，不走 back+重试计数。
 * 返回 { act }（拿到动作）或 { reason, visionBroken? }（失败原因；visionBroken=这个模型看不了图，本次回合内不再试）。
 * system 由调用方按「总纲 + 当前应用手册 + 历史经验」拼好传入（和节点路径同一套注入）。
 */
async function decideByShot({ adb, ask, pkg, prompt, steps, maxSteps, system, visionBroken }) {
  if (visionBroken) return { reason: '' } // 已知看不了图：直接走老的 back+重试
  let shot
  try { shot = await adb.screenshot() } catch (e) { return { reason: `截屏失败：${e.message}` } }
  const user = [
    `目标：${prompt}`,
    pkg ? `当前前台应用：${pkg}` : '',
    steps > 0 ? `（已执行 ${steps} 步，剩余 ${maxSteps - steps} 步）` : '',
    '只回 JSON 动作。',
  ].filter(Boolean).join('\n')
  try {
    const act = parseAction(await ask({
      system, text: user,
      images: [{ data: shot.toString('base64'), mediaType: 'image/png' }],
    }))
    if (act && act.action) return { act }
    return { reason: '截图兜底：视觉决策没返回有效动作' }
  } catch (e) {
    // 模型不支持看图 / 附件服务不在 / 请求被拒：本次回合内标记，后续轮次不再重复试
    return { reason: `截图兜底失败：${e.message || e}`, visionBroken: true }
  }
}

export async function runWorkspace({ flowKey = 'adhoc', prompt = '', packages = [], maxSteps = 40, guide = '', guideFor = null, ctx }) {
  const { adb, session, safety, memory, ask, report } = ctx
  let steps = 0
  let badSteps = 0 // 连续坏步计数
  let visionBroken = false // 截图兜底被模型拒绝/报错后置位：本回合内不再重复试截图
  let lastBadReason = '' // 最近一次取不到节点时的真实失败原因（中止时如实汇报）
  let ok = false
  let summary = ''
  const visited = new Set() // 本轮实际到过的前台包名（含启动过的），收尾关应用释放内存用
  // 取锁失败（已被别的任务占着）就直接拒绝，别硬跑（复审第 6 条：之前的 {ok:false} 没检查）
  const lock = await session.acquire(flowKey)
  if (!lock || lock.ok === false) return { ok: false, steps: 0, summary: '手机正被其他任务占用，稍后再试', visited: [] }
  try {
    const mem = memory.load(flowKey)
    // 提示词注入（省 token）：guide 是常驻的「总纲/主流程」（优先注入）；guideFor(pkg) 按需返回
    // 当前前台应用的单应用手册——决定刷某个应用后才加载，没对应手册就不注入。每包只解析一次并缓存。
    // 旧用法（只传 guide 不传 guideFor）保持原语义：整场一份应用手册。
    const appCache = new Map() // pkg → 手册文本（'' = 没有）
    const manualFor = (pkg) => {
      if (!guideFor) return guide
      if (!appCache.has(pkg)) appCache.set(pkg, pkg ? String(guideFor(pkg) || '') : '')
      return appCache.get(pkg) || ''
    }
    const buildSystem = (pkg, isShot) => {
      const manual = manualFor(pkg)
      return [
        isShot
          ? '你是 Android 手机操作决策器。当前界面拿不到控件节点清单，给你一张整屏截图，你只回一个 JSON 动作，不要其他文字。'
          : '你是 Android 手机操作决策器。每回合给你当前界面节点清单，你只回一个 JSON 动作，不要其他文字。',
        'JSON 格式：{"action":"tap|input|clear|drag|scroll|key|wait|back|home|launch|double_tap|long_press|finish","' + (isShot ? 'xy":[x,y]' : 'n":节点号') + ',"text":输入文本,"dir":"up|down|left|right","name":按键名,"to":[x,y],"ms":毫秒,"pkg":包名,"ok":布尔,"summary":"进度一句话"}',
        isShot
          ? 'tap/double_tap/long_press/clear/drag 起点的 xy 填目标在截图里的像素坐标（截图与屏幕同分辨率，原点左上）；看不清或不确定就不要猜坐标，用 finish 并在 summary 说明原因。'
          : 'tap/double_tap/long_press/clear/drag 起点用界面清单里的节点号 n（清单里没有的可交互元素也可以直接给像素坐标 xy:[x,y]，屏幕分辨率与清单同源）；input 时 text 填要输入的内容；clear 清空已聚焦输入框；drag 的 to 填终点坐标；scroll 用 dir 选 up/down/left/right；key 用 name 选 enter/tab/volume_up/volume_down/power/notifications；wait 的 ms 可选（500~10000，默认 1000）；任务做完或确认无法继续用 finish 并写 summary。',
        guide && !guideFor ? `【操作手册（本应用专属，优先照做）】\n${guide}` : (guide ? `【主流程总纲（优先照做）】\n${guide}` : ''),
        manual ? `【操作手册（当前应用，优先照做）】\n${manual}` : '',
        mem?.summary ? `历史经验（优先复用）：${mem.summary}` : '',
      ].filter(Boolean).join('\n')
    }

    for (; steps < maxSteps; steps++) {
      // 一审 #19-6：会话超时被强制释放 / 模块停用时，旧任务要真正停下来，不能和新任务同时操作手机
      if (ctx.signal?.aborted) { summary = '会话超时被强制释放，回合中止'; break }
      // ① 观察：当前前台包 + 界面节点
      let pkg = ''
      try { pkg = await adb.currentPackage() } catch { /* 读不到包名不致命 */ }
      if (pkg) visited.add(pkg)
      let parsed
      try {
        parsed = parseNodes(await adb.dumpNodes())
      } catch {
        parsed = { list: [], brief: '', error: 'DUMP_EMPTY' }
      }
      // 包名白名单（safety 现读设置）把关；白名单为空 = 不限
      const pkgCheck = safety.checkPackage(pkg)
      if (pkg && !pkgCheck.ok) { summary = `当前前台包 ${pkg} 不在白名单：${pkgCheck.reason || '被拒'}`; break }

      // ② 决策：节点优先；当轮取不到节点就立刻截图兜底（模型看不了图才退回 back+重试计数）
      let act = null
      if (parsed.error || !parsed.list.length) {
        const fb = await decideByShot({ adb, ask, pkg, prompt, steps, maxSteps, system: buildSystem(pkg, true), visionBroken })
        if (fb.act) {
          act = fb.act
        } else {
          if (fb.visionBroken) visionBroken = true
          badSteps++
          if (fb.reason) lastBadReason = fb.reason // 记住最后一次真实失败原因，中止时如实汇报
          if (badSteps >= 3) { summary = lastBadReason || '连续三次取不到界面节点，回合中止'; break }
          // 一审 #19-5：取不到节点时不再替主人按 back（可能误退当前应用/挂断电话），只等界面加载后重试
          await sleep(600)
          continue
        }
      } else {
        const user = [
          `目标：${prompt}`,
          pkg ? `当前前台应用：${pkg}` : '',
          `界面节点：\n${parsed.brief}`,
          steps > 0 ? `（已执行 ${steps} 步，剩余 ${maxSteps - steps} 步）` : '',
          '只回 JSON 动作。',
        ].filter(Boolean).join('\n')
        try {
          act = parseAction(await ask({ system: buildSystem(pkg, false), text: user }))
        } catch { act = null }
        if (!act || !act.action) {
          badSteps++
          if (badSteps >= 3) { summary = '连续三次无法解析模型动作，回合中止'; break }
          continue
        }
      }
      badSteps = 0 // 拿到合法动作，坏步清零

      // ③ 守门 + 执行 + 心跳 + 日志
      if (ctx.signal?.aborted) { summary = '会话超时被强制释放，回合中止'; break }
      await safety.checkRate() // 限速：模块内循环与动作器共用同一套滑动窗口（复审第 5 条）
      const result = await applyAction(adb, safety, pkg, act, parsed.list)
      await session.heartbeat(flowKey)
      await safety.log(act.action, result.note).catch((e) => ctx.log?.(`安全审计落盘失败：${e.message}`))
      if (result.done) {
        ok = result.confirm ? false : act.ok !== false
        summary = result.note
        break
      }
    }
    if (!summary) summary = steps >= maxSteps ? `步数耗尽（${maxSteps} 步），回合中止` : '未执行任何动作'
  } catch (e) {
    ok = false
    summary = `工作区异常：${e.message}`
  } finally {
    // ⑥ 收尾：存记忆 + 放锁 + 汇报
    await memory.save(flowKey, { runLog: { steps, ok, summary }, goal: prompt }).catch((e) => ctx.log?.(`回合记忆写入失败：${e.message}`))
    session.release(flowKey)
    if (report) { try { report(null, `手机任务「${prompt}」${ok ? '完成' : '未完成'}：${summary}`) } catch { /* 汇报失败不影响结果 */ } }
  }
  return { ok, summary, steps, visited: [...visited] }
}
