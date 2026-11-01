// pet-behavior-client.test.js —— 桌宠客户端行为层纯逻辑单测（node:test）
// 被测对象：fork/src/modules/pet/pet-client/behavior.js（CommonJS，与 physics.js 同款求值方式加载，
// 因为 fork/package.json 是 type:module，直接 require 会按 ESM 解析）。
// 覆盖：未知动作 refused、第三批占位 refused、勾引判定（构造光标样本序列）、摸摸判定（时间序列）、
//       鼠标闲置判定、反应冷却窗口、wander 目标纯函数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_DIR = join(ROOT, 'pet-client')

function loadBehavior() {
  const code = readFileSync(join(MODULE_DIR, 'behavior.js'), 'utf8')
  const m = { exports: {} }
  new Function('module', 'exports', code)(m, m.exports) // 以 CommonJS 形态求值
  return m.exports
}

const B = loadBehavior()
const T = B.THRESHOLDS

// 身体盒（测试用）：屏幕坐标 500,500 尺寸 240×240
const BOX = { x: 500, y: 500, width: 240, height: 240 }

// ---------- 动作注册表：查表执行，未知动作 refused ----------

test('execute()：未知动作 refused（铁律 1：不在清单里的一律拒执行）', async () => {
  for (const a of ['fly_to_moon', '', null, 'Chase_Cursor' /* 大小写敏感 */, 'close_win']) {
    const r = await B.execute(a, {}, fakeCtx())
    assert.equal(r.status, 'refused', `动作 ${JSON.stringify(a)} 应 refused`)
    assert.match(r.reason, /unknown-action/)
  }
})

test('execute()：第三批窗口动作都是真实现；桥缺失时一律 refused（绝不猜着关窗口）', async () => {
  for (const a of ['close_window', 'nudge_window']) {
    assert.ok(B.ACTIONS[a], `注册表里有 ${a}`)
    assert.ok(typeof B.ACTIONS[a].run === 'function' && String(B.ACTIONS[a].desc).length > 4, `${a} 必须是真实现且带 desc`)
    const r = await B.execute(a, {}, fakeCtx()) // fakeCtx 没注入 listWindows
    assert.equal(r.status, 'refused')
    assert.equal(r.reason, 'no-window-bridge')
  }
  assert.ok(!B.ACTIONS.peek_window, '2026-10-30 用户要求删除「探头」')
  for (const a of ['drag_icon', 'hide_icon']) {
    assert.ok(B.ACTIONS[a] && typeof B.ACTIONS[a].run === 'function', `第二批动作 ${a} 必须是真实现`)
  }
})

// ---------- 第三批：窗口动作（§6.1） ----------

const WINS = [
  { hwnd: 1, pid: 100, proc: 'notepad', title: '草稿.txt - 记事本', cls: 'Notepad', x: 100, y: 100, width: 800, height: 600 },
  { hwnd: 2, pid: 200, proc: 'Code', title: 'aurabot - Visual Studio Code', cls: 'Chrome_WidgetWin_1', fg: true, x: 0, y: 0, width: 1200, height: 800 },
  { hwnd: 3, pid: 300, proc: 'explorer', title: '我的电脑', cls: 'CabinetWClass', x: 0, y: 0, width: 900, height: 600 },
  { hwnd: 4, pid: 400, proc: 'chrome', title: '全屏视频 - Chrome', cls: 'Chrome_WidgetWin_1', zoomed: true, x: 0, y: 0, width: 1920, height: 1080 },
  { hwnd: 5, pid: 500, proc: 'msedge', title: '', cls: 'Chrome_WidgetWin_1', x: 0, y: 0, width: 100, height: 100 },
  { hwnd: 6, pid: 600, proc: 'electron', title: 'DeepSeek Harness', cls: 'Chrome_WidgetWin_1', x: 0, y: 0, width: 1200, height: 900 },
  { hwnd: 7, pid: 700, proc: 'LockApp', title: 'Windows 默认锁屏界面', cls: 'Windows.UI.Core.CoreWindow', x: 0, y: 0, width: 1920, height: 1080 },
]

test('pickWindowTarget：排除系统/自己/全屏/无标题，前台优先', () => {
  const got = B.pickWindowTarget(WINS, { selfPids: [600] })
  assert.ok(got.window, '有可碰的窗口')
  assert.equal(got.window.hwnd, 2, '前台窗口优先（explorer/全屏/无标题/自己都被排除）')
  // 排除名单核对：每一个「不好的」都不能是结果
  const bad = [3, 4, 5, 6, 7]
  for (const h of bad) assert.notEqual(got.window.hwnd, h, `hwnd ${h} 必须被排除`)
})

test('pickWindowTarget：最小化（坐标 -32000）与厂商壳层窗口（输入法 statusbar）也排除', () => {
  const tricky = [
    // 真机实测样本：微信输入法状态栏，IsWindowVisible=true、有标题、坐标正常
    { hwnd: 11, pid: 3968, proc: 'wetype_update', title: 'StatusBarWnd', cls: 'wetype.statusbar.window', x: 1726, y: 656, width: 168, height: 40 },
    // 最小化窗口：Windows 挪到 -32000，仍 visible
    { hwnd: 12, pid: 3176, proc: 'QQ', title: '[dsh-aurabot…等3个会话', cls: 'Chrome_WidgetWin_1', x: -32000, y: -32000, width: 160, height: 28 },
    // 正常可碰的窗口
    { hwnd: 13, pid: 3210, proc: 'Weixin', title: '微信', cls: 'Qt51514QWindowIcon', x: 872, y: 90, width: 840, height: 783 },
  ]
  const got = B.pickWindowTarget(tricky, {})
  assert.equal(got.window.hwnd, 13, '只留真正能碰的那个')
})

test('pickWindowTarget：白名单只放行命中的；指名找不到就 refused（绝不退而求其次）', () => {
  assert.deepEqual(B.parseWhitelist('code, vs code,记事本'), ['code', 'vs', 'code', '记事本'], '逗号/空白都能分隔')
  const w = B.pickWindowTarget(WINS, { whitelist: '记事本', selfPids: [600] })
  assert.equal(w.window.hwnd, 1, '白名单命中记事本')
  const none = B.pickWindowTarget(WINS, { whitelist: 'photoshop', selfPids: [600] })
  assert.equal(none.reason, 'window-not-whitelisted')
  const miss = B.pickWindowTarget(WINS, { wanted: '不存在的标题', selfPids: [600] })
  assert.equal(miss.reason, 'window-not-found')
  const byTitle = B.pickWindowTarget(WINS, { wanted: '记事本', selfPids: [600] })
  assert.equal(byTitle.window.hwnd, 1)
  assert.equal(B.pickWindowTarget([], {}).reason, 'no-window', '空清单 → no-window')
})

test('windowPushPlan：朝更近的竖边推、人物站窗内侧、推出去只剩 keep 宽（2026-10-30 用户改法）', () => {
  const body = { x: 0, y: 0, width: 240, height: 240 }
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const gap = B.THRESHOLDS.WINDOW_STAND_GAP_PX
  const keep = B.THRESHOLDS.WINDOW_PUSH_KEEP_PX
  const mid = { x: 500, y: 300, width: 600, height: 400 } // 窗口中线 800 < 960 → 往左推
  const plan = B.windowPushPlan(mid, body, area)
  assert.equal(plan.toLeft, true, '靠左半边 → 往左推')
  // 推完窗口左沿 = 屏幕左沿 + keep - 窗宽 → 只留 keep 宽在屏内
  assert.equal(mid.x + plan.deltaX, 0 + keep - mid.width, '推完只剩 keep 宽')
  assert.equal(plan.stand.x, 500 + 600 + gap, '人物站窗内侧（往左推就站窗口右边），gap = 24')
  assert.equal(plan.stand.y, 300 + 400 / 2, '纵向对齐窗口中线')
  assert.ok(plan.pushMs > 0, '要有推的时长（人物与窗口同速）')
  // 靠右半边 → 往右推，人物站窗口左边
  const right = B.windowPushPlan({ x: 1200, y: 200, width: 600, height: 400 }, body, area)
  assert.equal(right.toLeft, false, '靠右半边 → 往右推')
  assert.equal(1200 + right.deltaX, 1920 - keep, '推完右沿只剩 keep')
  assert.equal(right.stand.x, 1200 - gap, '人物站窗口左边')
  // 已经贴在边上（推不出戏剧效果）→ null，别白跑一趟
  assert.equal(B.windowPushPlan({ x: -520, y: 300, width: 600, height: 400 }, body, area), null)
  assert.equal(B.windowPushPlan({ x: 0, y: 0, width: 0, height: 400 }, body, area), null, '窗口宽度 0 → null')
  assert.equal(B.windowPushPlan(mid, body, null), null, '没有工作区 → null')
})

test('close_window：跑到窗口**右上角**再关，只发一次 WM_CLOSE，回执带窗口标题', async () => {
  const calls = []
  const targets = []
  const ctx = fakeCtx({
    listWindows: async () => WINS,
    selfPids: () => [600],
    windowClose: async (hwnd) => { calls.push(hwnd); return true },
    moveWindowTo: async (getTarget, o) => { targets.push({ t: getTarget(), o }); return true },
  })
  const r = await B.execute('close_window', {}, ctx)
  assert.equal(r.status, 'played')
  assert.deepEqual(calls, [2], '只关前台那个窗口，且只关一次')
  assert.equal(r.detail, 'aurabot - Visual Studio Code')
  // 右上角：身体中心落在「窗口右沿 + gap」「窗口上沿 + gap」处（以**人物**到达为准）
  const box = BOX
  const gap = B.THRESHOLDS.WINDOW_STAND_GAP_PX
  assert.equal(targets[0].t.x, 1200 + gap, '人物中心贴窗口右上角外侧')
  // 竖直方向被「半个身位」夹住：身体上沿正好压在窗口上沿（不会整个人沉到窗口里）
  assert.equal(targets[0].t.y, Math.max(0 + gap, box.height / 2), '身体上沿贴窗口上沿')
  assert.equal(targets[0].o.align, 'body', '以人物到达为准')

  const bad = await B.execute('close_window', {}, fakeCtx({ listWindows: async () => WINS, selfPids: () => [600], windowClose: async () => false }))
  assert.equal(bad.status, 'failed')
  assert.equal(bad.reason, 'close-failed')
})

test('nudge_window：人物跑到窗内侧、和窗口一起匀速挪出去，按住 5 秒再同步拉回（不是闪现）', async () => {
  const slides = []
  const called = { sleep: [], place: [], moves: [] }
  const ctx = fakeCtx({
    listWindows: async () => WINS,
    selfPids: () => [600],
    windowSlide: async (hwnd, dx, dy, ms) => { slides.push({ hwnd, dx, dy, ms }); return true },
    windowPlace: async (hwnd, x, y) => { called.place.push({ hwnd, x, y }); return true },
    sleep: async (ms) => { called.sleep.push(ms) },
    moveWindowTo: async (getTarget, o) => { called.moves.push({ t: getTarget(), o }); return true },
  })
  const ok = await B.execute('nudge_window', {}, ctx)
  assert.equal(ok.status, 'played')
  assert.equal(ok.detail, 'aurabot - Visual Studio Code')
  const plan = B.windowPushPlan(WINS[1], BOX, ctx.workArea())
  assert.equal(slides.length, 2, '推出去一次 + 拉回来一次')
  assert.equal(slides[0].hwnd, 2)
  assert.equal(slides[0].dx, plan.deltaX, '第一次：按计划位移推出去')
  assert.equal(slides[1].dx, -plan.deltaX, '第二次：同一条位移反向拉回')
  assert.equal(slides[0].ms, plan.pushMs, '窗口匀速滑过，时长 = 位移 / 速度')
  assert.deepEqual(called.sleep, [B.THRESHOLDS.WINDOW_PUSH_HOLD_MS], '按住 5 秒')
  assert.deepEqual(called.place, [{ hwnd: 2, x: 0, y: 0 }], '兜底把窗口摆回原始坐标')
  // 三次走位都以「人物到达」为准（先跑到窗内侧，再跟着窗口同进同退）
  assert.equal(called.moves.length, 3, '站位 1 次 + 推出去 1 次 + 拉回来 1 次')
  for (const m of called.moves) assert.equal(m.o.align, 'body', '窗口动作全部以人物到达为准')
  assert.ok(called.moves[0].o.speed === B.THRESHOLDS.RUN_SPEED_PX_S, '跑动速度 150px/s')

  // 推失败（桥返回 false）→ failed:push-failed，但窗口仍被摆回原位（不留残局）
  const failPlace = []
  const fail = await B.execute('nudge_window', {}, fakeCtx({
    listWindows: async () => WINS, selfPids: () => [600],
    windowSlide: async () => false,
    windowPlace: async (hwnd, x, y) => { failPlace.push({ hwnd, x, y }); return true },
  }))
  assert.equal(fail.status, 'failed')
  assert.equal(fail.reason, 'push-failed')
  assert.deepEqual(failPlace, [{ hwnd: 2, x: 0, y: 0 }], '失败也要还原窗口')
  // 没有 windowSlide 桥：refused，绝不只动窗口不动人
  const noBridge = await B.execute('nudge_window', {}, fakeCtx({ listWindows: async () => WINS, selfPids: () => [600] }))
  assert.equal(noBridge.reason, 'no-window-bridge')
})

test('windowCornerTarget：人物中心贴窗口右上角，出屏就夹回工作区（以人物到达为准）', () => {
  const body = { x: 0, y: 0, width: 240, height: 240 }
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const gap = B.THRESHOLDS.WINDOW_STAND_GAP_PX
  const w = { x: 400, y: 100, width: 800, height: 600 }
  const t = B.windowCornerTarget(w, body, { workArea: () => area })
  // 2026-10-30 用户实测修正：以前返回「角 + 半身宽」，人物落到了角的外侧下方
  assert.equal(t.x, 400 + 800 + gap, '人物中心就在窗口右沿外 gap 处')
  assert.equal(t.y, 100 + gap, '人物中心就在窗口上沿外 gap 处')
  const right = B.windowCornerTarget({ x: 1700, y: 0, width: 220, height: 600 }, body, { workArea: () => area })
  assert.equal(right.x, 1920 - 120, '出屏贴屏幕右沿内侧（四边留半个身位）')
  assert.equal(right.y, 120, '竖直也被夹住半个身位')
  assert.equal(B.windowCornerTarget({ x: 0, y: 0, width: 0, height: 0 }, body, {}), null)
})

test('窗口动作：读不到窗口清单 → refused:windows-unavailable（不猜）', async () => {
  for (const a of ['close_window', 'nudge_window']) {
    const r = await B.execute(a, {}, fakeCtx({ listWindows: async () => null }))
    assert.equal(r.status, 'refused')
    assert.equal(r.reason, 'windows-unavailable')
  }
})

// ---------- 第二批：drag_icon / hide_icon（§6.2） ----------

const PROTECTED = [
  { name: '回收站', x: 100, y: 900, isDir: false }, // 系统图标：不碰
  { name: '新建文件夹', x: 200, y: 900, isDir: true }, // 文件夹：不碰
  { name: '.secret', x: 300, y: 900, hidden: true }, // 隐藏：不碰
  { name: 'desktop.ini', x: 350, y: 900 }, // 系统文件：不碰
  { name: '{645FF040-5081-101B-9F08-00AA002F954E}.lnk', x: 360, y: 900 }, // CLSID 系统图标：不碰
]
const ICONS = [...PROTECTED, { name: 'a.txt', x: 400, y: 900 }, { name: '游戏.lnk', x: 500, y: 900 }]

test('图标清单过滤：排除文件夹/隐藏/系统图标/系统文件/空名，只留普通文件', () => {
  const kept = B.filterNormalIcons(ICONS)
  assert.deepEqual(kept.map((i) => i.name), ['a.txt', '游戏.lnk'])
  assert.equal(B.filterNormalIcons(null).length, 0)
  assert.equal(B.filterNormalIcons([]).length, 0)
  assert.equal(B.filterNormalIcons([{ name: '   ', x: 1, y: 1 }]).length, 0, '空名不要')
  assert.equal(B.filterNormalIcons([{ name: 'desktop.ini', x: 1, y: 1 }]).length, 0, 'desktop.ini 不要')
  assert.equal(B.filterNormalIcons([{ name: '{645FF040-5081-101B-9F08-00AA002F954E}.lnk', x: 1, y: 1 }]).length, 0, 'CLSID 系统图标不要')
})

test('目标挑选随机性存在：rng 注入可确定性选中，rng 均匀时能覆盖不同成员', () => {
  const list = [{ name: 'x1', x: 0, y: 0 }, { name: 'x2', x: 1, y: 1 }, { name: 'x3', x: 2, y: 2 }]
  assert.equal(B.pickNormalIcon(list, () => 0).name, 'x1', 'rng=0 取第一个')
  assert.equal(B.pickNormalIcon(list, () => 0.99).name, 'x3', 'rng≈1 取最后一个')
  assert.equal(B.pickNormalIcon(PROTECTED, () => 0), null, '全是受保护图标 → null')
  const seen = new Set()
  let seed = 7
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
  for (let i = 0; i < 60; i++) seen.add(B.pickNormalIcon(list, rng).name)
  assert.ok(seen.size >= 2, '随机源应能选到不同目标')
})

test('指名匹配容错：ListView 显示名不带 .lnk，服务端简报可能带——两种都能对上', () => {
  const icons = [{ name: 'Trae CN', x: 22, y: 674 }, { name: '游戏.lnk', x: 500, y: 900 }, { name: '新建文件夹', x: 1, y: 1, isDir: true }]
  assert.equal(B.resolveIconTarget(icons, 'Trae CN').icon.name, 'Trae CN', '显示名精确匹配')
  assert.equal(B.resolveIconTarget(icons, 'Trae CN.lnk').icon.name, 'Trae CN', '带 .lnk 也能对上（去扩展名比较）')
  assert.equal(B.resolveIconTarget(icons, 'trae cn').icon.name, 'Trae CN', '不区分大小写')
  assert.equal(B.resolveIconTarget(icons, '  游戏.lnk  ').icon.name, '游戏.lnk', '两侧空白忽略')
  assert.equal(B.resolveIconTarget(icons, '游戏').icon.name, '游戏.lnk', '服务端给不带扩展名的也能对上')
  assert.equal(B.resolveIconTarget(icons, '不存在的.txt').reason, 'icon-not-found')
  assert.equal(B.resolveIconTarget(icons, '新建文件夹').reason, 'icon-protected', '文件夹仍不碰')
  assert.equal(B.resolveIconTarget(icons, '').reason, 'no-icon')
})

test('走位/折线纯函数：站图标左 60px；左边放不下就绕到右边；拖动折线首尾闭环、点数固定', () => {
  const body = { width: 240, height: 240 }
  const t = B.iconApproachTarget({ x: 500, y: 900 }, body)
  // 身体中心：右缘距图标 60px → 中心再往左半个身宽
  assert.equal(t.x, 500 - 60 - 120, '身体右缘距图标 60px（返回身体中心）')
  assert.equal(t.y, 900 + B.THRESHOLDS.ICON_CENTER_OFFSET_Y, '纵向对齐图标单元格中心（不是单元格左上角）')
  assert.equal(B.iconApproachTarget(null, body), null)
  // 桌面图标默认在最左列（x=30）：左边算出来是 -150，人物会被夹到屏幕边上**压住图标**。
  // 有工作区就绕到右侧站（2026-10-30 用户实测「收图标定位不对」的修法）。
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const nearLeft = B.iconApproachTarget({ x: 30, y: 200 }, body, undefined, area)
  assert.equal(nearLeft.x, 30 + 60 + 120, '左边放不下 → 站到图标右边（身体左缘距图标 60px）')
  const middle = B.iconApproachTarget({ x: 800, y: 200 }, body, undefined, area)
  assert.equal(middle.x, 800 - 60 - 120, '两边界都放得下时仍旧站左边（行为不变）')
  // 随机落点（2026-10-30 用户指定：每次都放到不固定的位置）
  const area2 = { x: 0, y: 0, width: 1920, height: 1040 }
  const rnd = B.pickDropPoint({ x: 100, y: 100 }, body, area2, { rng: () => 0.5 })
  assert.ok(rnd && rnd.source === 'random', '没给坐标 → 随机落点')
  assert.ok(rnd.x >= 120 && rnd.x <= 1800, '随机点也在工作区内（留半个身位）')
  const ai = B.pickDropPoint({ x: 100, y: 100 }, body, area2, { x: 5000, y: -100 })
  assert.equal(ai.source, 'ai', 'AI 给了坐标就用它的')
  assert.equal(ai.x, 1800, '越界的坐标夹回工作区')
  assert.equal(ai.y, 120)
  assert.equal(B.pickDropPoint({ x: 0, y: 0 }, body, null, {}), null, '没有工作区 → null')
})

test('hide_icon 全链：走位→叼起→act ok→得逞→played；act 体含 playbackId/force/mode', async () => {
  const calls = { move: 0, anims: [], act: [] }
  const ctx = fakeCtx({
    readDesktopIcons: async () => ICONS.map((i) => ({ ...i })),
    bodyRect: () => ({ ...BOX, width: 240, height: 240 }),
    moveWindowTo: async (getTarget, o) => { calls.move++; void getTarget; void o; return true },
    playAnimByName: async (cands) => { calls.anims.push(cands); return true },
    iconAct: async (body) => { calls.act.push(body); return { ok: true, id: 'q1', name: 'a.txt', originalPath: 'C:/x/a.txt' } },
  })
  const r = await B.execute('hide_icon', { icon: 'a.txt', playbackId: 'pb-1' }, ctx)
  assert.equal(r.status, 'played')
  assert.deepEqual(calls.act, [{ mode: 'hide', icon: 'a.txt', playbackId: 'pb-1', force: true }])
  assert.ok(calls.anims[0].some((c) => /叼|咬|叼起/.test(c)), '先播叼起')
  assert.ok(calls.anims[1].some((c) => /得逞|得意|开心/.test(c)), '成功播得逞')
  assert.ok(calls.move >= 1, '要先走到图标旁')
})

test('hide_icon：被安全闸拒绝 → 播疑惑/叹气 + refused 回执带服务端中文 reason', async () => {
  const anims = []
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconAct: async () => ({ ok: false, reason: '主人把图标动作开关关掉了' }),
    playAnimByName: async (c) => { anims.push(c); return false },
  })
  const r = await B.execute('hide_icon', { icon: 'a.txt' }, ctx)
  assert.equal(r.status, 'refused')
  assert.equal(r.reason, '主人把图标动作开关关掉了')
  assert.ok(anims.some((c) => c.some((x) => /疑惑|叹气|歪头/.test(x))), '拒绝要播疑惑/叹气')
  // act 抛异常 → refused（兜底 reason）
  const r2 = await B.execute('hide_icon', { icon: 'a.txt' }, fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconAct: async () => { throw new Error('net down') },
  }))
  assert.equal(r2.status, 'refused')
})

test('drag_icon：图标真的被搬到**新位置**放下（不还原），绝不调 act 接口', async () => {
  const targets = []
  const iconMoves = []
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: '游戏.lnk', x: 500, y: 900 }],
    bodyRect: () => ({ ...BOX, width: 240, height: 240 }),
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    moveWindowTo: async (getTarget) => { targets.push(getTarget()); return true },
    playAnimByName: async () => true,
    moveDesktopIcon: async (name, x, y) => { iconMoves.push({ name, x, y }); return true },
    iconAct: async () => { throw new Error('drag_icon 不许调 act！') }, // 调了就炸出 failed，正好当断言
  })
  const r = await B.execute('drag_icon', { icon: '游戏.lnk', x: 1400, y: 300 }, ctx)
  assert.equal(r.status, 'played')
  assert.ok(targets.length >= 2, '走位 1 次 + 搬到落点 1 次')
  const lastTarget = targets[targets.length - 1]
  assert.deepEqual({ x: lastTarget.x, y: lastTarget.y }, { x: 1400, y: 300 }, '最后一次移动的终点 = 落点（AI 坐标）')
  assert.equal(lastTarget.source, 'ai', 'AI 给了坐标就标 ai（回执里要区分「按指令」/「随机」）')
  // 图标真的被搬走了：最后一步落在新位置，**不是**原位
  const last = iconMoves[iconMoves.length - 1]
  assert.equal(last.name, '游戏.lnk')
  assert.notEqual(last.x, 500, '图标不能被放回原位（用户要的是挪窝）')
  assert.notEqual(last.y, 900)
  assert.ok(Math.abs(last.x - 1400) <= 240 && Math.abs(last.y - 300) <= 240, '图标落点贴着落点附近，实际 ' + last.x + ',' + last.y)
  assert.match(r.detail, /1400,300/, '回执里带落点，面板能对账')
  // 没有 moveDesktopIcon 桥：如实 refused（不假装挪成功了）
  const r2 = await B.execute('drag_icon', { icon: '游戏.lnk' }, fakeCtx({
    readDesktopIcons: async () => [{ name: '游戏.lnk', x: 500, y: 900 }],
    playAnimByName: async () => true,
  }))
  assert.equal(r2.status, 'refused')
  assert.equal(r2.reason, 'no-icon-bridge')
  // 搬运失败（moveDesktopIcon 返回 false）：也如实 refused
  const r3 = await B.execute('drag_icon', { icon: '游戏.lnk' }, fakeCtx({
    readDesktopIcons: async () => [{ name: '游戏.lnk', x: 500, y: 900 }],
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    moveDesktopIcon: async () => false,
    playAnimByName: async () => true,
  }))
  assert.equal(r3.status, 'refused')
  assert.equal(r3.reason, 'icon-move-unavailable')
})

test('drag_icon 半路被打断（没走到落点）：图标必须放回原位，不留半路残局', async () => {
  const iconMoves = []
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: '游戏.lnk', x: 500, y: 900 }],
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    moveDesktopIcon: async (name, x, y) => { iconMoves.push({ name, x, y }); return true },
    playAnimByName: async () => true,
    // 第一段（走到图标）成功、第二段（搬到落点）失败
    moveWindowTo: (() => { let n = 0; return async () => { n++; return n === 1 } })(),
  })
  const r = await B.execute('drag_icon', { icon: '游戏.lnk' }, ctx)
  assert.equal(r.status, 'failed')
  const last = iconMoves[iconMoves.length - 1]
  assert.deepEqual({ x: last.x, y: last.y }, { x: 500, y: 900 }, '失败时图标回到原位')
})

test('hide_icon：发给服务端的是**磁盘名**（ListView 显示名不带 .lnk，服务端按磁盘名 stat）', async () => {
  const act = []
  const ctx = fakeCtx({
    // 真实形态：name = 显示名「Trae CN」，file = 磁盘真名「Trae CN.lnk」
    readDesktopIcons: async () => [{ name: 'Trae CN', file: 'Trae CN.lnk', x: 22, y: 674 }],
    iconAct: async (body) => { act.push(body); return { ok: true } },
  })
  const r = await B.execute('hide_icon', { icon: 'Trae CN.lnk' }, ctx) // 服务端简报给的是磁盘名
  assert.equal(r.status, 'played')
  assert.equal(act[0].icon, 'Trae CN.lnk', '发磁盘名，不能发显示名')
  // 没有 file 字段时回落 name（不引入新失败路径）
  const act2 = []
  await B.execute('hide_icon', { icon: 'a.txt' }, fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 1, y: 2 }],
    iconAct: async (b) => { act2.push(b); return { ok: true } },
  }))
  assert.equal(act2[0].icon, 'a.txt')
})

test('拒绝原因中文化：服务端 code → 中文；未知 code 原样带出（不吞信息）', () => {
  assert.match(B.iconReasonText('icon-mischief-disabled'), /开关/)
  assert.match(B.iconReasonText('not-file'), /普通文件/)
  assert.match(B.iconReasonText('system-icon'), /系统图标/)
  assert.match(B.iconReasonText('hide-failed'), /失败/)
  assert.equal(B.iconReasonText('some-new-code'), 'some-new-code')
  assert.equal(B.iconReasonText(''), '')
  assert.equal(B.iconReasonText(undefined), '')
  // 链路里：code 会被翻成中文进回执
  return B.execute('hide_icon', { icon: 'a.txt' }, fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 1, y: 2 }],
    iconAct: async () => ({ ok: false, reason: 'icon-mischief-disabled' }),
    playAnimByName: async () => true,
  })).then((r) => {
    assert.equal(r.status, 'refused')
    assert.match(r.reason, /开关/)
  })
})

test('读不到桌面图标 → 设计稿 §6.2 降级：走到屏幕下沿空叼一口，演完照实 refused（不假装得手）', async () => {
  const targets = []
  const anims = []
  let acted = 0
  const ctx = fakeCtx({
    readDesktopIcons: async () => null, // 一级二级都读不到
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    moveWindowTo: async (getTarget) => { targets.push(getTarget()); return true },
    playAnimByName: async (c) => { anims.push(c[0]); return true },
    iconAct: async () => { acted++; return { ok: true } },
  })
  const r = await B.execute('hide_icon', {}, ctx)
  assert.equal(r.status, 'refused')
  assert.equal(r.reason, 'desktop-icons-unavailable')
  assert.equal(acted, 0, '读不到图标时绝不调 act（没有目标就没有动作）')
  assert.equal(targets.length, 1, '降级只走一步：到下沿')
  assert.equal(targets[0].y, 1040 - BOX.height, '落在屏幕下沿')
  assert.ok(targets[0].x >= 0 && targets[0].x <= 1920 - BOX.width, 'x 在可用宽度内')
  assert.deepEqual(anims, ['叼', '疑惑'], '叼起 → 疑惑（不是得逞）')
})

test('降级表演也不能拖垮回执：ctx 没 workArea/bodyRect 时静默跳过，仍 refused', async () => {
  let moved = 0
  const r = await B.execute('hide_icon', {}, fakeCtx({
    readDesktopIcons: async () => null,
    workArea: () => null,
    moveWindowTo: async () => { moved++; return true },
  }))
  assert.equal(r.status, 'refused')
  assert.equal(r.reason, 'desktop-icons-unavailable')
  assert.equal(moved, 0, '没有工作区信息就不动窗口')
})

test('图标动作选标边界：指名图标不存在/受保护 → refused；无指名但全是受保护 → refused；无桥/读不到桌面 → refused', async () => {
  const icons = async () => ICONS
  const mk = (extra) => fakeCtx({ readDesktopIcons: icons, iconAct: async () => ({ ok: true }), ...extra })
  assert.match((await B.execute('hide_icon', { icon: '不存在的.txt' }, mk())).reason, /icon-not-found/)
  assert.match((await B.execute('hide_icon', { icon: '新建文件夹' }, mk())).reason, /icon-protected/)
  assert.match((await B.execute('hide_icon', { icon: '回收站' }, mk())).reason, /icon-protected/)
  const onlyProtected = fakeCtx({ readDesktopIcons: async () => PROTECTED.map((i) => ({ ...i })), iconAct: async () => ({ ok: true }) })
  assert.match((await B.execute('hide_icon', {}, onlyProtected)).reason, /no-normal-icon/, '指名之外全是受保护图标')
  assert.match((await B.execute('hide_icon', {}, fakeCtx())).reason, /no-desktop-bridge/, 'ctx 没注入桌面桥')
  assert.match((await B.execute('hide_icon', {}, mk({ readDesktopIcons: async () => null }))).reason, /desktop-icons-unavailable/)
  assert.match((await B.execute('hide_icon', {}, mk({ readDesktopIcons: async () => { throw new Error('boom') } }))).reason, /desktop-icons-unavailable/, '读桌面抛异常也不许炸主进程')
  assert.match((await B.execute('hide_icon', { icon: 'a.txt' }, mk({ bodyRect: () => null }))).reason, /no-body/)
})

test('params 无 icon 时自己挑：只从普通文件里挑，绝不落到受保护图标上', async () => {
  const hit = []
  const ctx = fakeCtx({
    readDesktopIcons: async () => ICONS.map((i) => ({ ...i })),
    iconAct: async (body) => { hit.push(body.icon); return { ok: true } },
  })
  const r = await B.execute('hide_icon', {}, ctx) // 连跑几次，随机也要落在普通文件上
  assert.equal(r.status, 'played')
  assert.ok(['a.txt', '游戏.lnk'].includes(hit[0]), `挑到受保护图标了：${hit[0]}`)
  assert.equal(hit[0] === 'desktop.ini', false, 'desktop.ini 绝不能碰')
})

test('hide_icon：act 回 ok:false 但没给 reason → 回执 refused:icon-act-rejected（不让 undefined 漏出去）', async () => {
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconAct: async () => ({ ok: false }),
    playAnimByName: async () => true,
  })
  const r = await B.execute('hide_icon', { icon: 'a.txt' }, ctx)
  assert.equal(r.status, 'refused')
  assert.equal(r.reason, 'icon-act-rejected')
})

test('超时兜底会真收手：预算内的走位 maxMs 收缩，且超时后不再搬窗口', async () => {
  let moves = 0
  const budgets = []
  const BUDGET_MS = 120 // 与 remainMs 的下限一致：每段走位 100ms → 第二段走到一半就到点，必须收手
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconTimeoutMs: BUDGET_MS,
    moveDesktopIcon: async () => true,
    moveWindowTo: async (_getTarget, opts) => {
      moves++
      budgets.push(opts && opts.maxMs)
      await new Promise((r) => setTimeout(r, 100))
      return true
    },
    playAnimByName: async () => true,
    iconAct: async () => ({ ok: true }),
  })
  const r = await B.execute('drag_icon', { icon: 'a.txt' }, ctx)
  assert.equal(r.status, 'failed')
  assert.equal(r.reason, 'timeout')
  assert.ok(budgets.every((m) => m <= BUDGET_MS), `走位不能拿到超出预算的 maxMs：${budgets.join(',')}`)
  const atTimeout = moves
  await new Promise((r2) => setTimeout(r2, 250))
  assert.equal(moves, atTimeout, '超时之后不许再搬窗口（否则窗口会在后台继续乱跑）')
})

test('图标动作超时兜底：卡死的动画点播 → 整链 failed:timeout（ctx.iconTimeoutMs 注入小窗口）', async () => {
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconTimeoutMs: 50,
    playAnimByName: () => new Promise(() => {}), // 永不 resolve
  })
  const r = await B.execute('hide_icon', { icon: 'a.txt' }, ctx)
  assert.equal(r.status, 'failed')
  assert.equal(r.reason, 'timeout')
})

test('超时后链路再抛异常也不留未处理 rejection（主进程 unhandledRejection 防护）', async () => {
  const ctx = fakeCtx({
    readDesktopIcons: async () => [{ name: 'a.txt', x: 400, y: 900 }],
    iconTimeoutMs: 40,
    playAnimByName: async () => { await new Promise((r) => setTimeout(r, 80)); throw new Error('素材炸了') },
  })
  let unhandled = null
  const onUnhandled = (e) => { unhandled = e }
  process.once('unhandledRejection', onUnhandled)
  const r = await B.execute('hide_icon', { icon: 'a.txt' }, ctx)
  await new Promise((r2) => setTimeout(r2, 120)) // 等后台那条链自己抛完
  process.removeListener('unhandledRejection', onUnhandled)
  assert.equal(r.status, 'failed')
  assert.equal(unhandled, null, '不许出现未处理 rejection')
})


test('execute()：第一批 5 个动作全部注册且带说明（2026-10-30 删 approach_cursor/sleep/stretch/poke_cursor）', () => {
  for (const a of ['chase_cursor', 'wander', 'idle_anim', 'steal_cursor', 'say']) {
    assert.ok(B.ACTIONS[a] && typeof B.ACTIONS[a].run === 'function', `缺动作 ${a}`)
    assert.ok(String(B.ACTIONS[a].desc).length > 4, `${a} 要有 desc`)
  }
  for (const gone of ['approach_cursor', 'sleep', 'stretch', 'poke_cursor']) {
    assert.ok(!B.ACTIONS[gone], `已删除的动作不该还在注册表里：${gone}`)
  }
})

test('execute()：run 抛异常 → failed（绝不向上抛，主进程不崩）；ctx 缺失 → refused', async () => {
  // 临时注册一个会炸的动作，测完删掉（execute 闭包读的是模块内注册表）
  B.ACTIONS.__boom = { desc: '测试用：抛异常', run: () => { throw new Error('炸了') } }
  try {
    const r = await B.execute('__boom', {}, fakeCtx())
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /炸了/)
  } finally { delete B.ACTIONS.__boom }
  const r2 = await B.execute('say', { text: 'hi' }, null)
  assert.equal(r2.status, 'refused')
})

test('execute()：say 走气泡；空文本 refused', async () => {
  const calls = []
  const ctx = fakeCtx({ say: (t) => calls.push(t) })
  const r1 = await B.execute('say', { text: '哼～' }, ctx)
  assert.equal(r1.status, 'played')
  assert.deepEqual(calls, ['哼～'])
  const r2 = await B.execute('say', { text: '   ' }, ctx)
  assert.equal(r2.status, 'refused')
})

test('execute()：chase_cursor 追到后按住鼠标 5 秒再松开；没 pinCursor 桥就只追不按', async () => {
  // fake ctx：moveWindowTo 模拟「追到」（getTarget 每帧返回光标位置）
  const cur = { x: 900, y: 600 }
  let pinned = null
  const ctx = fakeCtx({
    cursor: () => ({ ...cur }),
    pinCursor: async (x, y, ms) => { pinned = { x, y, ms }; return true },
    moveWindowTo: async (getTarget, o) => {
      const t = getTarget()
      return Boolean(t) && o.maxMs === T.CHASE_MAX_MS
    },
  })
  const ok = await B.execute('chase_cursor', {}, ctx)
  assert.equal(ok.status, 'played')
  assert.equal(pinned.ms, T.CHASE_HOLD_MS, '要按住 CHASE_HOLD_MS（5 秒）')
  assert.equal(pinned.x, 900, '按在追到的位置上')
  // 目标为空（窗口没了）→ 中断 → failed
  const ctx2 = fakeCtx({ moveWindowTo: async () => false })
  const fail = await B.execute('wander', {}, ctx2)
  assert.equal(fail.status, 'failed')
  // 没有 pinCursor 桥（老模板）：照样 played，只是不按住
  pinned = undefined
  const oldCtx = fakeCtx({ cursor: () => ({ ...cur }) })
  const r2 = await B.execute('chase_cursor', {}, oldCtx)
  assert.equal(r2.status, 'played')
  assert.equal(pinned, undefined, '没有桥就不该尝试按住')
})

// ---------- 反应层判定 ----------

test('勾引判定：身体盒附近高速左右折返 ≥3 次 → tease', () => {
  const t0 = 1_000_000
  // 每 120ms 折返一次：x 在 420↔700 之间弹跳（都在盒附近 120px 内），速度远超 350px/s
  const samples = []
  for (let i = 0; i < 12; i++) {
    const x = i % 2 === 0 ? 420 : 700
    samples.push({ x, y: 620, t: t0 + i * 120 })
  }
  const now = t0 + 12 * 120
  assert.equal(B.isTeasing(samples, BOX, now), true, '高频折返应判定勾引')
  // 慢速移动：同路径但每 600ms 挪一步（速度 <350）→ 不算
  const slow = []
  for (let i = 0; i < 12; i++) {
    const x = i % 2 === 0 ? 420 : 700
    slow.push({ x, y: 620, t: t0 + i * 600 })
  }
  assert.equal(B.isTeasing(slow, BOX, t0 + 12 * 600), false, '慢速晃不算勾引')
  // 远处折返（>120px 外）→ 不算
  const far = samples.map((s) => ({ ...s, x: s.x + 500 }))
  assert.equal(B.isTeasing(far, BOX, now), false, '远处晃与桌宠无关')
  // 样本不足 → 不算
  assert.equal(B.isTeasing(samples.slice(0, 2), BOX, now), false)
})

test('摸摸判定：光标在身体盒内持续 >2s 且基本不动 → pat；中途出去不算', () => {
  const t0 = 2_000_000
  const still = (t) => ({ x: 600, y: 600, t })
  const samples = []
  for (let i = 0; i <= 6; i++) samples.push(still(t0 + i * 400)) // 覆盖 2.4s
  const now = t0 + 6 * 400
  assert.equal(B.isPatting(samples, BOX, now), true, '停留 2.4s 应判定摸摸')
  // 只停 1.2s：不够
  assert.equal(B.isPatting(samples.slice(0, 4), BOX, t0 + 3 * 400), false)
  // 中途光标跑出去再回来：不算「持续」
  const withEscape = samples.map((s, i) => (i === 3 ? { x: 100, y: 100, t: s.t } : s))
  assert.equal(B.isPatting(withEscape, BOX, now), false, '中途离开身体盒不算摸')
  // 在盒内大幅移动（拖拽经过）：抖动超阈值不算
  const sweep = []
  for (let i = 0; i <= 6; i++) sweep.push({ x: 510 + i * 30, y: 600, t: t0 + i * 400 })
  assert.equal(B.isPatting(sweep, BOX, now), false, '盒内大幅滑动不算摸')
})

test('鼠标闲置判定：≥ idleMinutes 分钟没动才触发；分钟数非法时永不触发', () => {
  const now = 10_000_000
  assert.equal(B.isCursorIdle(now - 8 * 60_000, now, 8), true, '整 8 分钟应触发')
  assert.equal(B.isCursorIdle(now - 8 * 60_000 + 1, now, 8), false, '差 1ms 不触发')
  assert.equal(B.isCursorIdle(now - 61_000, now, 1), true, '1 分钟下限')
  assert.equal(B.isCursorIdle(now - 999_999, now, 0), false, '0 分钟 = 关闭')
  assert.equal(B.isCursorIdle(now - 999_999, now, NaN), false)
  assert.equal(B.isCursorIdle(undefined, now, 8), false)
})

test('反应冷却：同类反应 30 秒内不重复触发；不同 kind 互不影响', () => {
  const now = 5_000_000
  assert.equal(B.canReact(undefined, now), true, '首次必触发')
  assert.equal(B.canReact(now, now + 29_999), false, '冷却内')
  assert.equal(B.canReact(now, now + 30_000), true, '冷却刚过')
  assert.equal(B.canReact(now, now + 1000, 500), true, '冷却窗口可自定义')
})

// ---------- wander 目标纯函数 ----------

test('pickWanderTarget：目标在 area 内且离起点足够远（≥ 半屏）', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1000 }
  const from = { x: 100, y: 900 }
  // 固定随机源：总是 0 → 目标 = area 左上角，离 (100,900) 足够远
  const t = B.pickWanderTarget(area, from, () => 0)
  assert.ok(t.x >= 0 && t.x <= 1920 && t.y >= 0 && t.y <= 1000, '目标必须夹在 area 内')
  assert.ok(Math.hypot(t.x - from.x, t.y - from.y) >= 960, '至少半个屏远')
  // 随机源总返回 0.99（右下角附近），起点在右下 → 24 次都太近 → 对角退化兜底也要在 area 内
  const t2 = B.pickWanderTarget(area, { x: 1800, y: 900 }, () => 0.99)
  assert.ok(t2 && t2.x >= 0 && t2.x <= 1920 && t2.y >= 0 && t2.y <= 1000)
  assert.equal(B.pickWanderTarget(null, from), null, '无 area → null')
})

// ---------- 显示名 ≠ 磁盘名（§6.2 死角：本机 `光辉玻璃服务器 16666.rdp` 显示成 `6666.rdp`） ----------

test('iconCandidatePaths：外部权威映射排第一，其余是「桌面目录 × 后缀」猜测', () => {
  const dirs = ['C:\\Users\\X\\Desktop', 'C:\\Users\\Public\\Desktop\\']
  const map = { '6666.rdp': 'C:\\Users\\X\\Desktop\\光辉玻璃服务器 16666.rdp' }
  const c = B.iconCandidatePaths('6666.rdp', map, dirs, ['', '.lnk'])
  assert.equal(c[0], 'C:\\Users\\X\\Desktop\\光辉玻璃服务器 16666.rdp', '映射命中必须优先（显示名被截断也能落到真文件）')
  assert.ok(c.includes('C:\\Users\\X\\Desktop\\6666.rdp'))
  assert.ok(c.includes('C:\\Users\\Public\\Desktop\\6666.rdp.lnk'), '目录末尾带反斜杠时不能拼出双斜杠')
  assert.equal(new Set(c).size, c.length, '候选路径不重复')
  assert.deepEqual(B.iconCandidatePaths('', map, dirs, ['']), [], '空名字 → 没有候选')
  assert.deepEqual(B.iconCandidatePaths('a.txt', null, ['D:\\d'], ['.lnk']), ['D:\\d\\a.txt.lnk'], '无映射时只靠猜测')
})

test('matchIconByName：显示名被截断时唯一子串反查能找回磁盘名（6666.rdp → 光辉玻璃服务器 16666.rdp）', () => {
  const files = ['光辉玻璃服务器 16666.rdp', 'Trae CN.lnk', 'desktop.ini', '我的笔记.txt']
  assert.equal(B.matchIconByName('6666.rdp', files), '光辉玻璃服务器 16666.rdp', '截断的显示名反查到唯一磁盘名')
  assert.equal(B.matchIconByName('6666', files), '光辉玻璃服务器 16666.rdp', '不带扩展名也能反查')
  assert.equal(B.matchIconByName('Trae CN', files), 'Trae CN.lnk', '正常名反查照样成立')
  assert.equal(B.matchIconByName('不存在的', files), '', '查不到就返回空，让上层 refused')
  // 歧义：两个磁盘名都含 "16666" → 不猜
  assert.equal(B.matchIconByName('16666', ['a 16666.rdp', 'b-16666.txt']), '', '多命中一律放弃（不误伤）')
  // 太短的主干不模糊
  assert.equal(B.matchIconByName('a', files), '', '主干短于 3 字符不模糊')
  // 系统壳层文件不参与
  assert.equal(B.matchIconByName('desktop.ini', files), '', 'desktop.ini 不作为候选')
})

test('resolveIconTarget：服务端给磁盘名、ListView 给显示名时仍能命中（不再 icon-not-found）', () => {
  const icons = [
    { name: '6666.rdp', file: '光辉玻璃服务器 16666.rdp', x: 10, y: 10 },
    { name: 'Trae CN', file: 'Trae CN.lnk', x: 20, y: 20 },
  ]
  assert.equal(B.resolveIconTarget(icons, '光辉玻璃服务器 16666.rdp').icon.name, '6666.rdp', '磁盘名 → 对回显示名那一项')
  assert.equal(B.resolveIconTarget(icons, '6666.rdp').icon.name, '6666.rdp', '显示名照样能命中')
  assert.equal(B.resolveIconTarget(icons, 'Trae CN.lnk').icon.name, 'Trae CN', '磁盘名带扩展名也能命中')
  assert.equal(B.resolveIconTarget(icons, '不存在.txt').reason, 'icon-not-found')
  // 受保护项即便名字能匹配也不碰
  assert.equal(B.resolveIconTarget([{ name: '新建文件夹', file: '新建文件夹', isDir: true }], '新建文件夹').reason, 'icon-protected')
})

// ---------- 辅助 ----------

/** 造一份最小可用的执行器 ctx（用不到的钩子给无害默认）。 */
function fakeCtx(extra) {
  return {
    moveWindowTo: async () => true,
    bodyRect: () => ({ ...BOX }),
    // 主显示器工作区（默认 1920×1040）：随机落点 / 降级表演 / 窗口计划都要它
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    cursor: () => ({ x: 620, y: 620 }),
    playAnimByName: async () => false,
    nativeMove: async () => true,
    say: () => {},
    sleep: async () => {},
    pickWanderTarget: (from) => B.pickWanderTarget({ x: 0, y: 0, width: 1920, height: 1040 }, from, () => 0.5),
    ...extra,
  }
}

// ---------- 移动不再「瞬移」+ idle 池交回 AI ----------

test('stepToward：匀速——横跨 1600px 一帧只走 speed*dt，不再「第一帧跳 1/4 屏」', () => {
  // 老实现是每帧走剩余距离的 25%：1600px 的第一帧就 400px，用户实测就是「直接瞬移」
  const a = B.stepToward({ x: 0, y: 0 }, { x: 1600, y: 0 }, 900, 16)
  assert.ok(Math.abs(a.x - 14.4) < 0.01, '16ms 应该只走 14.4px，实际 ' + a.x)
  assert.ok(a.x < 20, '一帧跳几百像素就是 bug')
  // 剩下不到一步：停在目标，不越界
  const b = B.stepToward({ x: 1595, y: 0 }, { x: 1600, y: 0 }, 900, 16)
  assert.equal(b.x, 1600)
  assert.equal(b.step, 5)
  // 斜向按直线距离走（不是先横后竖）
  const c = B.stepToward({ x: 0, y: 0 }, { x: 300, y: 400 }, 1000, 10) // dist 500，10ms → 10px
  assert.ok(Math.abs(Math.hypot(c.x, c.y) - 10) < 0.01, '斜向步长要按直线距离算')
  assert.ok(Math.abs(c.x / c.y - 300 / 400) < 1e-9, '方向不能歪')
  // 已经在目标上 / 速度为 0 / 时间 0：都不动
  assert.deepEqual(B.stepToward({ x: 5, y: 5 }, { x: 5, y: 5 }, 900, 16), { x: 5, y: 5, dist: 0, step: 0 })
  assert.equal(B.stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 16).step, 0)
  assert.equal(B.stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 900, 0).step, 0)
})

test('chase_cursor 用跑动速度（150px/s）而不是溜达速度', async () => {
  // 2026-10-30 三次调参的最终值：溜达 50 / 跑动 150 / 叼鼠标 400·250。
  // 追鼠标要跟得上会动光标，必须用跑动档而不是散步档。
  assert.ok(B.THRESHOLDS.CHASE_SPEED_PX_S >= B.THRESHOLDS.RUN_SPEED_PX_S, '追鼠标至少和跑动一样快')
  assert.ok(B.THRESHOLDS.CHASE_SPEED_PX_S > B.THRESHOLDS.WANDER_SPEED_PX_S, '不能拿散步速度追鼠标')
  let seen = null
  const ctx = fakeCtx({ moveWindowTo: async (_t, opts) => { seen = opts; return true } })
  const r = await B.execute('chase_cursor', {}, ctx)
  assert.equal(r.status, 'played')
  assert.equal(seen.speed, B.THRESHOLDS.CHASE_SPEED_PX_S)
})

test('idle_anim：接管原「自动轮播」——单播一段 idle 池动画，没有桥就 refused', async () => {
  assert.ok(B.ACTIONS.idle_anim, '自动轮播关掉后，idle 池必须还有出口')
  let called = 0
  const okCtx = fakeCtx({ playIdleAnim: async () => { called++; return true } })
  assert.equal((await B.execute('idle_anim', {}, okCtx)).status, 'played')
  assert.equal(called, 1, '只播一段，不接力')
  const noBridge = await B.execute('idle_anim', {}, fakeCtx())
  assert.equal(noBridge.status, 'refused')
  assert.equal(noBridge.reason, 'no-anim-bridge')
  const noAnim = await B.execute('idle_anim', {}, fakeCtx({ playIdleAnim: async () => false }))
  assert.equal(noAnim.status, 'failed')
  assert.equal(noAnim.reason, 'no-idle-anim')
})

// ---------- 叼鼠标：先冲到鼠标，再叼着鼠标同步拖（2026-10-30 重写：carry 由主进程逐帧锁住指针） ----------

test('steal_cursor：先 400px/s 冲到鼠标，再 250px/s 带着鼠标一起走（carry）', async () => {
  const moves = []
  const ctx = fakeCtx({ moveWindowTo: async (_t, opts) => { moves.push(opts); return true } })
  const r = await B.execute('steal_cursor', {}, ctx)
  assert.equal(r.status, 'played')
  assert.equal(moves.length, 2, '两段移动：冲刺 + 叼着拖')
  assert.equal(moves[0].speed, T.STEAL_SPEED_PX_S, '冲刺速度 400px/s')
  assert.equal(T.STEAL_SPEED_PX_S, 400)
  assert.equal(moves[1].speed, T.STEAL_CARRY_SPEED_PX_S, '叼着走 250px/s')
  assert.equal(T.STEAL_CARRY_SPEED_PX_S, 250)
  assert.equal(moves[1].carry, true, '阶段②必须带 carry（主进程逐帧把鼠标钉在嘴边并锁住裁剪区）')
  assert.ok(!moves[0].carry, '冲刺阶段还不能叼住鼠标')

  // 冲刺阶段被打断 → failed
  const bad = fakeCtx({ moveWindowTo: async () => false })
  const r2 = await B.execute('steal_cursor', {}, bad)
  assert.equal(r2.status, 'failed')
  assert.equal(r2.reason, 'move-interrupted')
})

test('主进程 carry 契约：ClipCursor 锁住指针 + 到位释放（防止「移出去又闪现回来」）', () => {
  const src = readFileSync(new URL('../pet-client/main.js', import.meta.url), 'utf8')
  assert.ok(src.includes('ClipCursor'), '必须用 ClipCursor 物理夹住指针（只靠 SetCursorPos 会被拖出去再闪回）')
  assert.ok(/function releaseCursorClip/.test(src), '缺统一释放入口')
  assert.ok(/o\.carry\) releaseCursorClip\(\)/.test(src), 'carry 结束必须释放裁剪区')
  assert.ok(src.includes("app.on('will-quit'"), '退出时必须释放裁剪区（绝不锁死用户鼠标）')
  assert.ok(/if \(o\.carry\) pinCursorAtDip/.test(src), 'carry 期间每帧要把指针钉在身体中心')
})

// ---------- 每个动作都要顶气泡（本地兜底台词） ----------

test('客户端动作表自带 say：拿不到服务端台词时也能顶气泡（点击/勾引/摸摸不经过服务端）', () => {
  const acts = Object.keys(B.ACTIONS)
  assert.equal(acts.length, 9)
  for (const a of acts) {
    assert.equal(typeof B.ACTIONS[a].say, 'string', `${a} 必须有 say 字段（缺了就是没气泡）`)
    if (a === 'say') {
      assert.equal(B.ACTIONS[a].say, '', `${a} 自己会说话，不挂默认台词（挂了会双气泡）`)
    } else {
      assert.ok(B.ACTIONS[a].say.length >= 4, `${a} 的默认台词太短/为空`)
      assert.ok(B.ACTIONS[a].say.startsWith('（') && B.ACTIONS[a].say.endsWith('）'), `${a} 台词用括号体（旁白口吻）`)
    }
  }
})

test('主进程接线契约：handleBehavior 有「事件 say > 动作默认台词」兜底，且自会说话的动作不预弹', () => {
  const src = readFileSync(new URL('../pet-client/main.js', import.meta.url), 'utf8')
  assert.ok(src.includes('SELF_SAY_ACTIONS'), '缺自会说话动作名单（say）')
  assert.ok(/showBubble\(sayText/.test(src), '缺气泡调用')
  assert.ok(src.includes('String(def.say ||'), '缺动作默认台词兜底')
  // 摸摸走反应层、不经服务端：也得有气泡
  assert.ok(/react\('pat'[\s\S]{0,120}showBubble/.test(src), '摸摸（反应层）也要顶气泡')
})

test('移动速度契约：溜达 50 / 其余跑动 150 / 叼鼠标 400·250，且亚像素累积 + 动画同源解析', () => {
  const src = readFileSync(new URL('../pet-client/main.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../pet-client/index.html', import.meta.url), 'utf8')
  // 2026-10-30（用户第三次指定）：除了「叼鼠标」，其余跑动统一 150px/s（50 太磨蹭）；
  // 溜达保持 50（散步感）；叼鼠标冲刺 400、叼着走 250。
  assert.equal(B.THRESHOLDS.RUN_SPEED_PX_S, 150, '跑动速度 150px/s')
  assert.equal(B.THRESHOLDS.WANDER_SPEED_PX_S, 50, '溜达保持 50px/s')
  assert.equal(B.THRESHOLDS.CHASE_SPEED_PX_S, 150, '追鼠标也走 150')
  assert.equal(B.THRESHOLDS.STEAL_SPEED_PX_S, 400, '叼鼠标冲刺 400')
  assert.equal(B.THRESHOLDS.STEAL_CARRY_SPEED_PX_S, 250, '叼着走 250')
  // 主进程默认速度 = 散步 50（只有 wander 不传 speed 时用得上）
  assert.ok(/const MOVE_SPEED_PX_S = 50\b/.test(src), '主进程默认速度必须是 50px/s')
  // 速度下限不能是 80：Math.max(80, ...) 会把 50 悄悄改回 80（曾经踩过）
  assert.ok(!/Math\.max\(80, Number\(o\.speed\)/.test(src), '速度下限不能高于 50')
  // 50px/s ≈ 每帧 0.8px：必须用浮点累积位置，否则 round() 永远回到原处、一步都走不动
  assert.ok(/let curX = null/.test(src) && /curX = stp\.x/.test(src), '缺亚像素累积（curX/curY）')
  // 跑动动画：名字→id 要走 resolveMenu（与右键「动作 → 待机」同一套解析），不能自己造映射
  assert.ok(src.includes("const MOVE_ANIM_LABEL = '原地漂浮踏步'"), '跑动动画名写死为「原地漂浮踏步」')
  assert.ok(src.includes('resolveMenu(cfg, manifest, pools)'), 'id 必须来自 resolveMenu（与右键菜单同源）')
  // 起点播 / 收尾停，两处都要接上
  assert.ok(/startMoveAnim\(\)/.test(src) && /stopMoveAnim\(\)/.test(src), '移动起停要接跑动动画')
  assert.ok(/function startThrow[\s\S]{0,400}stopMoveAnim\(\)/.test(src), '甩飞时要收跑动动画')
  // 渲染页：循环播 + 一停就回静态
  assert.ok(/window\.__startMoveAnim = \(id\)/.test(html), '渲染页缺 __startMoveAnim(id)')
  assert.ok(/moveTimer = setTimeout\(moveTick, 0\)/.test(html), '跑动动画要循环重播')
  assert.ok(/window\.__stopMoveAnim = \(\)/.test(html), '渲染页缺 __stopMoveAnim')
})

test('右键菜单不再有「行为」栏（行为只由 AI 决定，调试走面板「试一下」）', () => {
  const src = readFileSync(new URL('../pet-client/main.js', import.meta.url), 'utf8')
  const menuBlock = src.slice(src.indexOf("ipcMain.on('pet:menu'"))
  const template = menuBlock.slice(menuBlock.indexOf('Menu.buildFromTemplate'), menuBlock.indexOf('menu.popup'))
  assert.ok(!/label: '行为'/.test(template), '右键菜单模板里不能出现「行为」级联')
  assert.ok(!/BEHAVIOR_MENU/.test(template), '右键菜单模板里不能引用 BEHAVIOR_MENU')
  assert.ok(/label: '动作'/.test(src), '素材点播「动作」级联要保留')
})

test('静止形象契约：播完定格在待机末帧（鲸鱼娘），不是 emoji 圆圈兜底', () => {
  const html = readFileSync(new URL('../pet-client/index.html', import.meta.url), 'utf8')
  // afterAnim 是「动作播完去哪」的唯一出口：不能再直接 stopVideo（那会露出 #pet 的 🐳 蓝圆圈）
  const after = html.slice(html.indexOf('function afterAnim()'), html.indexOf('function playStill()'))
  assert.ok(after.length > 0, '缺 afterAnim')
  assert.ok(!/stopVideo\(\)/.test(after), 'afterAnim 不能直接 stopVideo：会把静态立绘变成 emoji 圆圈')
  assert.ok(/playStill\(\)/.test(after), 'afterAnim 要落到 playStill（定格待机末帧）')
  assert.ok(/function playStill\(\)/.test(html), '缺 playStill')
  assert.ok(/pools\.idle \|\| \[\]\)\.includes\(name\)/.test(html), 'isIdleFrame 要按待机池判断')
  // 首次拿到素材表就要摆立绘，不能等用户先点一下
  assert.ok(/else if \(!currentAnim\) playStill\(\)/.test(html), '拿到素材表时要立刻摆待机立绘')
  // emoji 只是兜底：初始隐藏 + 素材缺席 1.5s 后才出现
  assert.ok(/id="pet"[^>]*style="display:none"/.test(html), 'emoji 兜底应初始隐藏')
  assert.ok(/setTimeout\(\(\) => \{[\s\S]{0,80}pet\.style\.display = 'flex'/.test(html), '素材缺席要有 1.5s 兜底显示')
})

test('对话框契约（一审 #18）：show 后补报 open、POST 响应带 messageId 去重', () => {
  const src = readFileSync(new URL('../pet-client/main.js', import.meta.url), 'utf8')
  // 1) 窗口 show:false → ready-to-show 里 show() 之后必须补报 open:true（否则服务端一直以为没开、回复错发气泡）
  assert.match(src, /ready-to-show', \(\) => \{[^}]*reportChatState\(\)/, 'ready-to-show 后要补报 open')
  assert.match(src, /chatWin\.on\('show', \(\) => reportChatState\(\)\)/, 'show 事件兜底补报（show() 后 isVisible 未必已翻）')
  // 2) POST 响应路径要把 messageId 一起给渲染页，和 chat 事件两路同源去重
  assert.match(src, /__chatAppend', d\.text, d\.messageId\)/, 'POST 路径漏传 messageId，同一条回复会显示两次')
})
