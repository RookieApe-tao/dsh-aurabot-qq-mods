// panel.js —— 手机逛逛的自定义面板
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调模块路由）
// 模块 settings 数组留空：所有设置由本面板接管（总开关挂在模块名同一行，参考 B 站页），
// 默认值在下面 DEFAULTS 里兜底（原生表单不再渲染，避免两套表单重复）。
// 布局：①手机逛逛（标题行=总开关；状态总览+运行安全设置+保存按钮）→ ②adb 环境与设备 → ③包名白名单（设置框+助手同卡）→ ④指引提示词。
const { useState, useEffect } = React

// 设置默认值（与 index.mjs getSettings() 的代码兜底一致，面板里也要显示出来而不是空白）
const DEFAULTS = {
  enabled: false, // 总开关：默认关
  whitelist: '',
  maxSteps: 40,
  rateLimit: 30,
  confirmWrites: true,
  dryRun: false,
  closeAppsAfter: true, // 逛完关闭应用进程释放内存：默认开
  sessionTimeoutMs: 900000,
  writeEventMemory: true,
  decisionModel: '',
  // 主动逛（照刷B站的节奏三件套）
  autoBrowse: false, // 定时自己去逛：默认关（开总开关后还要单独开它）
  intervalHours: 4, // 多久逛一轮
  maxRunsPerDay: 3, // 每天最多逛几轮
}

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('') // 当前在跑的操作名（按钮转圈/禁用用）
  const [cands, setCands] = useState(null) // 本机扫描到的 adb 候选路径
  const [devices, setDevices] = useState(null) // 连接的设备列表 [{serial, model, state}]
  const [pkgs, setPkgs] = useState(null) // 已装应用（第三方）列表
  const [kw, setKw] = useState('') // 包名过滤关键字
  const [st, setSt] = useState(null) // /status 的状态总览 {device, session, flows, confirms, enabled}

  // ---- 编辑草稿：改了先存本地，点「保存设置」一次落盘；null = 与已存值一致（不脏）----
  const [draft, setDraft] = useState(null)
  const d = draft || { ...DEFAULTS, ...settings }
  const upd = (patch) => setDraft({ ...d, ...patch })
  const dirty = draft !== null

  const lock = (name, fn) => async () => {
    if (busy) return
    setBusy(name)
    try { await fn() } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy('')
  }

  // ---- 状态总览：打开面板拉一次，操作完可手动刷新 ----
  const loadStatus = lock('status', async () => { setSt(await call('/status')) })
  useEffect(() => { loadStatus() }, [])

  // ---- 总开关：挂在卡片标题行，即切即存（同 B 站页的写法） ----
  const masterOn = d.enabled === true
  // lock() 返回的是可调用函数；之前写成 () => lock(...)，Switch 的 onChange 不会二次调用，
  // 于是「点了不保存」（一审 #19-7）。直接接 lock 的返回值。
  const toggleMaster = lock('master', async () => {
    upd({ enabled: !masterOn })
    await save({ enabled: !masterOn })
    setDraft((p) => (p ? { ...p, enabled: !masterOn } : p))
    toast(!masterOn ? '总开关已打开，她可以碰手机了' : '总开关已关，工具/触发词/定时全部停用', 'ok')
  })

  // ---- 保存设置：草稿里改过的全部字段一次落盘 ----
  const saveSettings = () => lock('savesettings', async () => {
    await save(d)
    setDraft(null)
    toast('设置已保存', 'ok')
  })

  // ---- adb 路径 ----
  const scanAdb = lock('scan', async () => {
    const r = await call('/adb/candidates')
    if (!r.ok) return toast(r.error || '扫描失败')
    setCands(r.candidates)
    if (!r.candidates.length) toast('没扫到 adb，试试「自动安装」')
  })
  const installAdb = lock('install', async () => {
    toast('正在下载 platform-tools（约 100MB，稍等）…')
    const r = await call('/adb/install', {})
    if (!r.ok) return toast(r.error || '安装失败')
    upd({ adbPath: r.adbPath }); await save({ adbPath: r.adbPath })
    toast('安装完成：' + r.adbPath)
  })
  const pickAdb = (p) => lock('pick', async () => {
    upd({ adbPath: p }); await save({ adbPath: p })
    setCands(null)
    toast('已选用：' + p)
  })
  // 弹系统文件选择框挑 adb.exe（服务端 PowerShell 弹原生对话框，返回绝对路径）
  const browseAdb = lock('browse', async () => {
    const r = await call('/adb/pickfile')
    if (!r.ok) return toast(r.error || '打开选择框失败')
    upd({ adbPath: r.path }); await save({ adbPath: r.path })
    toast('已选用：' + r.path)
  })

  // ---- 设备 ----
  const detectDevices = lock('detect', async () => {
    const r = await call('/adb/devices')
    if (!r.ok) return toast(r.error || '检测失败')
    setDevices(r.devices)
    if (!r.devices.length) toast('没检测到设备：手机要开 USB 调试并授权')
  })
  const pickDevice = (serial) => lock('pickdev', async () => {
    upd({ deviceSerial: serial }); await save({ deviceSerial: serial })
    toast(serial ? '已选设备：' + serial : '已改为自动选第一台设备')
  })

  // ---- 决策模型：参考系统菜单模型页的「按聊天选模型」，存 'provider::model'，空 = 跟随全局 ----
  const [models, setModels] = useState(null)
  useEffect(() => { call('/models').then((r) => setModels(r.list || [])).catch(() => setModels([])) }, [])
  const mkey = (m) => m.provider + '::' + m.model
  const curModel = String(d.decisionModel || '')
  const modelOpts = [{ value: '', label: '跟随全局模型（聊天用的模型）' }]
    .concat((models || []).map((m) => ({ value: mkey(m), label: m.name })))
    .concat(curModel && !(models || []).some((m) => mkey(m) === curModel)
      ? [{ value: curModel, label: curModel.split('::').slice(1).join('::') + '（DSH 里没找到）' }] : [])
  const pickModel = (v) => lock('model', async () => {
    upd({ decisionModel: v }); await save({ decisionModel: v })
    toast(v ? '决策模型已换：' + v : '已改回跟随全局模型', 'ok')
  })()

  // ---- 对话测试：面板文本框直接下一句话任务，跑完把结果回显在这张卡里 ----
  const [testGoal, setTestGoal] = useState('')
  const [lastRun, setLastRun] = useState(null)
  const [testBusy, setTestBusy] = useState(false)
  const sendTest = lock('sendtest', async () => {
    const goal = testGoal.trim()
    if (!goal) return toast('先写一句要她做什么')
    if (!masterOn) return toast('总开关没开：先到上面把总开关打开')
    const r = await call('/run', { goal })
    if (!r.ok) return toast(r.error || '下发失败')
    setTestBusy(true)
    toast(r.queued ? '手机正被别的任务占着，已在后台排队' : '已下发，她开始执行了…', 'ok')
  })
  // 执行中每 4 秒轮一次状态，拿到结果（running=false）就回显并停轮询
  useEffect(() => {
    if (!testBusy) return
    const t = setInterval(async () => {
      try {
        const s = await call('/status')
        const lr = s.lastRun
        if (lr && !lr.running) { setLastRun(lr); setTestBusy(false); setTestGoal('') }
      } catch { /* 轮询失败下次再试 */ }
    }, 4000)
    return () => clearInterval(t)
  }, [testBusy])

  // ---- 包名白名单：设置框 + 助手同卡；「加入」改草稿并立即落盘，手改后点「保存设置」 ----
  const [appNames, setAppNames] = useState({}) // 包名 → 应用名（内置常见应用对照；认不出的空着，靠「启动看看」）
  const loadPkgs = lock('pkgs', async () => {
    const serial = d.deviceSerial || (devices && devices[0] && devices[0].serial) || ''
    const r = await call('/adb/packages?serial=' + encodeURIComponent(serial))
    if (!r.ok) return toast(r.error || '获取失败')
    setPkgs(r.packages)
    setAppNames(r.names || {})
    if (!r.packages.length) toast('没列出第三方应用（这台手机可能没装）')
  })
  // 点「启动看看」：把应用拉到手机前台，对照着认它是谁（只打开不点任何东西）
  const probeApp = (pkg) => lock('probe:' + pkg, async () => {
    const r = await call('/adb/launch', { pkg })
    if (!r.ok) return toast(r.error || '启动失败')
    toast('已在手机上打开：' + (appNames[pkg] || pkg) + '，认出后点「加入」')
  })
  const addWhitelist = (pkg) => lock('add:' + pkg, async () => {
    const cur = String(d.whitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    if (cur.includes(pkg)) return toast(pkg + ' 已在白名单里')
    const val = cur.concat(pkg).join('\n')
    upd({ whitelist: val }); await save({ whitelist: val })
    toast('已加入白名单：' + pkg)
  })

  // ---- 指引提示词库：仿「人格」页的分节编辑（分节/整段来回切，保存仍是原来的一整段） ----
  // 节标记认两种写法：【标题】（文档首行）与「◆ 标题」（总则/操作套路/坑），拼回时保持原标记，旧指引不用改。
  const GSEC_HEAD = /^\s*(?:【([^【】\n]{1,40})】|◆\s*([^◆\n]{1,40}))\s*$/
  const GSEC_SUGGEST = ['总则', '操作套路', '坑']
  // 每节一个颜色（跟人格页同一套雾色系），相邻冷暖交替，深浅主题都不刺眼
  const GSEC_COLORS = ['#4f9a8c', '#8a7bc0', '#c08a4a', '#5f8fc7', '#c47a90', '#6f9f68', '#5c6fae', '#b9775a', '#8d9450', '#a173b5']
  let gsecSeq = 0
  const gsec = (title, marker, text) => ({ k: ++gsecSeq, title, marker, text })
  const splitGuide = (body) => {
    const out = [gsec(null, 'plain', '')] // 开头的无标题段（正文里没有任何节标记时兜底）
    let cur = out[0]
    let buf = []
    const flush = () => { cur.text = buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''); buf = [] }
    for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
      // 复制粘贴来的文本可能带零宽字符，认标题时不算它
      const m = GSEC_HEAD.exec(line.replace(/[​-‍﻿]/g, '').trim())
      if (m) { flush(); cur = gsec((m[1] != null ? m[1] : m[2] || '').trim(), m[1] != null ? 'bracket' : 'dot', ''); out.push(cur) }
      else buf.push(line)
    }
    flush()
    // 正文以【标题】/◆ 标题开头时，开头的无标题兜底节始终是空的——丢掉它，别渲染一个空框
    if (out.length > 1 && out[0].title === null && !out[0].text.trim()) out.shift()
    return out
  }
  const joinGuide = (list) => list
    .map((s) => {
      const t = s.text.replace(/\s+$/, '')
      if (s.title === null) return t.trim()
      const head = s.marker === 'bracket' ? '【' + (s.title.trim() || '未命名') + '】' : '◆ ' + (s.title.trim() || '未命名')
      return (head + '\n' + t).trim()
    })
    .filter(Boolean).join('\n\n')
  const gRows = (text) => Math.min(22, Math.max(3, String(text || '').split('\n').length + 1))

  /** 一节指引：标题、正文、上下移、删除（样式类复用人格页的 ab-psec） */
  function GuideSection({ sec, i, n, onChange, onMove, onDelete }) {
    const color = GSEC_COLORS[sec.k % GSEC_COLORS.length]
    return h('div', { className: 'ab-psec', style: { '--c': color } },
      h('div', { className: 'ab-psec-head' },
        h('input', { className: 'ab-psec-title', value: sec.title || '', placeholder: '这一节叫什么', maxLength: 40, onChange: (e) => onChange({ title: e.target.value.replace(/[【】◆\n]/g, '') }) }),
        h('span', { className: 'ab-psec-n' }, sec.text.length + ' 字'),
        h('div', { className: 'ab-psec-act' },
          h('button', { type: 'button', className: 'ab-ibtn', title: '往上移', disabled: i === 0, onClick: () => onMove(-1) }, '↑'),
          h('button', { type: 'button', className: 'ab-ibtn', title: '往下移', disabled: i === n - 1, onClick: () => onMove(1) }, '↓'),
          h('button', { type: 'button', className: 'ab-ibtn danger', title: '删掉这一节', onClick: onDelete }, '✕'))),
      h('textarea', { value: sec.text, rows: gRows(sec.text), placeholder: '- 一条一行，短句就好', onChange: (e) => onChange({ text: e.target.value }) }))
  }

  const [guides, setGuides] = useState(null) // null = 还没加载；打开面板就自动拉一次
  const [guideKey, setGuideKey] = useState('')
  const [secs, setSecs] = useState([]) // 当前指引拆成的节
  const [whole, setWhole] = useState(false) // false=分节编辑，true=整段
  const [gdirty, setGdirty] = useState(false)
  const [creating, setCreating] = useState(false) // 「＋ 新增指引」的建卡页
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  // ---- 主流程总纲（main）：独立卡编辑，不混进应用指引列表 ----
  const [mainSecs, setMainSecs] = useState(null) // null=未加载
  const [mainWhole, setMainWhole] = useState(false)
  const [mainDirty, setMainDirty] = useState(false)
  const mainGuide = (guides || []).find((g) => g.key === 'main') || null
  const appGuides = (guides || []).filter((g) => g.key !== 'main') // 应用指引列表不含总纲
  const pickGuide = (g) => { setGuideKey(g.key); setSecs(splitGuide(g.text || '')); setGdirty(false) }
  const loadGuides = async () => {
    const r = await call('/guides')
    const list = r.guides || []
    setGuides(list)
    setCreating(false)
    // 总纲跟着刷新（本地有未保存改动时不动它，免得被覆盖）
    const m = list.find((g) => g.key === 'main')
    if (m && !mainDirty) setMainSecs(splitGuide(m.text || ''))
    // 已选的还在就保留（保存后刷新列表用这条），不在了才回落到第一条
    if (!list.some((g) => g.key === guideKey) && list.length) pickGuide(list[0])
  }
  // 打开面板即加载指引库（不需要再点按钮）
  useEffect(() => { loadGuides().catch((e) => toast('指引库加载失败：' + (e.message || e))) }, [])
  const viewGuide = (key) => {
    if (gdirty && !confirm('这条指引还没保存，切走就丢了。确定切换？')) return
    const g = (guides || []).find((x) => x.key === key)
    if (g) pickGuide(g)
  }
  const startCreate = () => {
    if (gdirty && !confirm('当前指引还没保存，先放一放？')) return
    setNewKey(''); setNewName(''); setCreating(true)
  }
  const beginNew = () => {
    const key = newKey.trim()
    if (!/^[a-z0-9-]{2,40}$/.test(key)) { toast('key 只能是小写字母/数字/短横线（2~40 字）', 'err'); return }
    if (key === 'main') { toast('main 是主流程总纲的专用 key，请另起一个', 'err'); return }
    if ((guides || []).some((g) => g.key === key)) { toast('已有同名 key：' + key + '，保存会覆盖它；想另建就换个 key', 'err'); return }
    const name = newName.trim() || key
    setCreating(false)
    setGuideKey(key)
    setSecs(splitGuide('【' + name + ' · 操作手册】\n◆ 总则\n- \n\n◆ 操作套路\n- \n\n◆ 坑\n- '))
    setGdirty(true)
  }
  const updSec = (k, p) => { setSecs(secs.map((s) => (s.k === k ? { ...s, ...p } : s))); setGdirty(true) }
  const moveSec = (i, dd) => { const arr = secs.slice(); const [x] = arr.splice(i, 1); arr.splice(i + dd, 0, x); setSecs(arr); setGdirty(true) }
  const delSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setSecs(secs.filter((x) => x.k !== s.k)); setGdirty(true) }
  const addSec = (title) => { setSecs(secs.concat([gsec(title, 'dot', '')])); setGdirty(true) }
  const body = joinGuide(secs)
  const saveGuide = lock('saveguide', async () => {
    const r = await call('/guides', { key: guideKey, text: body })
    if (!r.ok) return toast(r.error || '保存失败')
    toast('已保存自定义指引：' + guideKey)
    setGdirty(false)
    await loadGuides()
  })
  const resetGuide = lock('delguide', async () => {
    const r = await call('/guides', { key: guideKey, reset: true })
    if (!r.ok) return toast(r.error || '还原失败')
    toast('已还原成内置版：' + guideKey)
    const g = await call('/guides')
    const list = g.guides || []
    setGuides(list); setGdirty(false)
    const cur = list.find((x) => x.key === guideKey)
    if (cur) pickGuide(cur)
  })

  // ---- 主流程总纲（main）：独立卡的编辑/保存/还原；删除入口不存在（内置条目删不掉） ----
  const mainBody = joinGuide(mainSecs || [])
  const updMainSec = (k, p) => { setMainSecs((mainSecs || []).map((s) => (s.k === k ? { ...s, ...p } : s))); setMainDirty(true) }
  const moveMainSec = (i, dd) => { const arr = (mainSecs || []).slice(); const [x] = arr.splice(i, 1); arr.splice(i + dd, 0, x); setMainSecs(arr); setMainDirty(true) }
  const delMainSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setMainSecs((mainSecs || []).filter((x) => x.k !== s.k)); setMainDirty(true) }
  const addMainSec = (title) => { setMainSecs((mainSecs || []).concat([gsec(title, 'dot', '')])); setMainDirty(true) }
  const saveMain = lock('savemain', async () => {
    const r = await call('/guides', { key: 'main', text: mainBody })
    if (!r.ok) return toast(r.error || '保存失败')
    toast('已保存主流程总纲', 'ok')
    setMainDirty(false)
    await loadGuides()
  })
  const resetMain = lock('resetmain', async () => {
    if (!confirm('把主流程总纲还原成内置版？自定义的改动会丢。')) return
    const r = await call('/guides', { key: 'main', reset: true })
    if (!r.ok) return toast(r.error || '还原失败')
    toast('已还原成内置总纲', 'ok')
    setMainDirty(false)
    await loadGuides()
  })

  // ---- 删除自定义指引：两道确认（先确认框，再手输 key）；内置指引没有这个按钮 ----
  const delGuide = (g) => lock('delguide:' + g.key, async () => {
    if (!confirm('删除自定义指引「' + (g.name || g.key) + '」（' + g.key + '）？删除后不可恢复。')) return
    if (prompt('最后确认：请输入它的 key「' + g.key + '」以删除') !== g.key) { toast('key 不对，已取消删除'); return }
    const r = await call('/guides', { key: g.key, del: true })
    if (!r.ok) return toast(r.error || '删除失败')
    toast('已删除自定义指引：' + g.key)
    if (guideKey === g.key) setGuideKey('')
    await loadGuides()
  })

  // 面板 Btn 调 onClick 时不传参：这里吞掉事件、靠闭包传行数据（包名/路径），不然 handler 收到 undefined
  // handler 两种形态都兼容：预锁定的（scanAdb 等，调用即跑、返回 Promise）；
  // 工厂式的（addWhitelist(pkg) 等返回执行器函数）——返回的是函数就再调一次，不然点了等于没点
  // 防连点：全局 busy 禁掉所有按钮 + 该行按钮显示「处理中…」，Btn 自身还有一层忙态
  const btn = (label, onClick, key, primary) => h(ui.Btn, {
    key, kind: primary ? 'primary' : undefined, disabled: !!busy,
    onClick: async () => { const r = onClick(); if (typeof r === 'function') await r() },
  }, busy === key ? '处理中…' : label)
  // 过滤：应用名（中文）和包名都认
  const filtered = (pkgs || []).filter((p) => {
    if (!kw) return true
    const k = kw.toLowerCase()
    return p.toLowerCase().includes(k) || String(appNames[p] || '').toLowerCase().includes(k)
  })

  // 状态总览里的一行「键：值」
  const stRow = (k, v) => h('div', { className: 'ab-small', style: { display: 'flex', gap: 8, marginTop: 2 } },
    h('span', { className: 'ab-muted', style: { flex: '0 0 96px' } }, k),
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, v))
  // 开关设置行（Row + Switch）
  const swRow = (label, key, hint) => h(ui.Row, { label, hint },
    h(ui.Switch, { on: d[key] === true, disabled: !!busy, title: label, onChange: () => upd({ [key]: d[key] !== true }) }))

  return h('div', null,

    // ===== ① 模块主卡：标题行 = 模块名 + 总开关（同 B 站页），下面是状态总览 + 运行安全设置 + 保存 =====
    h(ui.Card, {
      title: '手机逛逛',
      right: h('span', { className: 'ab-flex', style: { gap: 8, alignItems: 'center' } },
        h('span', { className: 'ab-small ab-muted' }, '总开关'),
        h(ui.Switch, { on: masterOn, disabled: !!busy, title: '总开关', onChange: toggleMaster }),
        h('span', { className: 'ab-badge mine' }, 'phone')),
      desc: '通过 ADB 逛 Android 手机：教好的流程自动签到/浏览/点赞，或自由推理完成一句话任务。'
        + (masterOn ? ' 总开关开着：AI 工具、触发词、定时流程都能操控手机。' : ' 总开关关着：她碰不了手机，工具/触发词/定时全部停用。'),
    },
    // 状态总览（只读，一键刷新）
    st === null
      ? h('div', { className: 'ab-small ab-muted', style: { marginBottom: 8 } }, '状态加载中…')
      : h('div', { style: { marginBottom: 12 } },
        stRow('设备', st.device || '未知'),
        stRow('会话', st.session && st.session.owner ? '被 ' + st.session.owner + ' 占用' : '空闲'),
        stRow('流程', (st.flows || 0) + ' 个'),
        stRow('待确认', (st.confirms || 0) + ' 条写操作'),
        stRow('主动逛', '今天 ' + ((st.auto && st.auto.runs) || 0) + ' 轮 / 上限 ' + d.maxRunsPerDay + ' 轮'),
        h('div', { className: 'ab-flex', style: { marginTop: 6 } }, btn('刷新状态', loadStatus, 'status'))),
    // 运行安全设置
    swRow('写操作需确认', 'confirmWrites', '发帖/评论/点赞等写操作先入队等主人批准（默认开）'),
    swRow('试运行', 'dryRun', '只出计划不真点击（默认关）'),
    swRow('逛完关闭应用', 'closeAppsAfter', '任务结束后强停这一轮到过的应用进程，释放手机内存（默认开；桌面不受影响）'),
    swRow('跑完写入她的记忆', 'writeEventMemory', '每次任务结束把结果写一条进记忆模块（默认开）'),
    // 定时主动逛（照刷B站的节奏三件套）
    swRow('定时主动逛', 'autoBrowse', '开着她会在醒着时间内按下面的间隔自己去逛一轮（AI 按总纲挑应用，跑完私聊汇报；默认关）'),
    h(ui.Row, { label: '多久逛一轮', hint: '距上次主动逛超过这个小时数才会再逛（默认 4 小时）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 0.1, step: 0.5, value: d.intervalHours, onChange: (e) => upd({ intervalHours: e.target.value }) }),
      h('span', { className: 'ab-muted', style: { marginLeft: 6 } }, '小时')),
    h(ui.Row, { label: '每天最多逛', hint: '每天主动逛轮数上限（默认 3 轮；只在「主动搭话」的醒着时间内逛）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 0, value: d.maxRunsPerDay, onChange: (e) => upd({ maxRunsPerDay: e.target.value }) }),
      h('span', { className: 'ab-muted', style: { marginLeft: 6 } }, '轮')),
    h(ui.Row, { label: '单次步数上限', hint: '单个工作区回合最大步数（默认 40）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 1, value: d.maxSteps, onChange: (e) => upd({ maxSteps: e.target.value }) })),
    h(ui.Row, { label: '每分钟动作上限', hint: '每分钟最多动作数（默认 30）' },
      h('input', { className: 'ab-input', style: { width: 100 }, type: 'number', min: 1, value: d.rateLimit, onChange: (e) => upd({ rateLimit: e.target.value }) })),
    h(ui.Row, { label: '会话超时（毫秒）', hint: '超时强断会话（默认 900000 = 15 分钟）' },
      h('input', { className: 'ab-input', style: { width: 140 }, type: 'number', min: 1000, value: d.sessionTimeoutMs, onChange: (e) => upd({ sessionTimeoutMs: e.target.value }) })),
    h(ui.Row, { label: '决策模型', hint: '操作决策器（看界面挑动作）用的模型；这里选的 > 全局模型，选的在 DSH 里找不到时自动退回。即选即生效。注意：选了决策模型后决策改走静默直连（工作区不再开「操作决策」会话窗）；留空才开会话窗实时可见。' },
      models === null
        ? h('span', { className: 'ab-muted ab-small' }, '模型列表加载中…')
        : h(ui.Select, { value: curModel, width: 320, options: modelOpts, onChange: pickModel })),
    // 保存行
    h('div', { className: 'ab-flex', style: { marginTop: 12 } },
      dirty ? h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '有改动还没保存') : null,
      h('div', { className: 'ab-spacer' }),
      btn('💾 保存设置', saveSettings, 'savesettings', true))),

    // ===== ①¼ 高权限风险提示（红色突出，紧跟手机逛逛主卡）=====
    h('div', { style: { margin: '0 0 12px', padding: '10px 12px', border: '1px solid #e5484d', borderRadius: 8, background: 'rgba(229,72,77,.08)', borderColor: '#e5484d' } },
      h('div', { style: { color: '#e5484d', fontWeight: 700, fontSize: 13 } }, '⚠️ 高权限风险提示'),
      h('div', { className: 'ab-small', style: { color: '#e5484d', marginTop: 4, lineHeight: 1.6 } },
        '本模块通过 ADB 接管手机的触屏、输入与应用启停，权限极高：总开关打开期间，AI 可代你在手机上点击、输入文字、打开/强停应用（写操作默认还需主人确认）。'
        + '请只在本人可信设备上开启；不用时建议把总开关关上，并留意「待确认」列表，防止误批准。')),

    // ===== ①½ 对话测试：一句话直接下任务，不用去 QQ 私聊她 =====
    h(ui.Card, { title: '对话测试', desc: '在这里用一句话给楼下她下任务（如「去B站签个到」「刷会抖音，看到游戏相关的点个赞」），走的和主人私聊「去逛逛手机」、AI 工具是同一套决策器与安全门，跑完结果回显在这张卡里；写操作照常入队等批准。' },
      h('textarea', {
        className: 'ab-textarea', rows: 2, style: { width: '100%' },
        placeholder: '例：打开抖音刷几屏，看到游戏相关的内容点个赞', value: testGoal, onChange: (e) => setTestGoal(e.target.value),
      }),
      h('div', { className: 'ab-flex', style: { marginTop: 8, gap: 8 } },
        btn('▶ 发给她执行', sendTest, 'sendtest', true),
        testBusy ? h('span', { className: 'ab-small ab-muted' }, '执行中（步数多的任务要几分钟），跑完自动回显…') : null),
      lastRun ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
        h('div', { className: 'ab-small ab-muted' }, '上次任务（' + new Date(lastRun.at).toLocaleTimeString() + (lastRun.steps != null ? '，' + lastRun.steps + ' 步' : '') + '）：' + (lastRun.goal || '')),
        h('div', null, (lastRun.ok ? '✅ ' : '❌ ') + (lastRun.message || ''))) : null),

    // ===== ② adb 环境与设备（合并一卡）=====
    h(ui.Card, { title: 'adb 环境与设备', desc: 'adb 是电脑操控手机的工具。留空自动探测；没有就「自动安装」（腾讯/Google 中国镜像），或「扫描本机」「选择本地 adb」。手机开 USB 调试连电脑后点「检测设备」选一台；留空 = 自动用第一台。adb 路径与设备即选即存。' },
      h(ui.Row, { label: 'adb 路径' },
        h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 8, width: '100%' } },
          h('input', { className: 'ab-input', style: { flex: '1 1 240px' }, readOnly: true, value: settings.adbPath || '（自动探测 / 未安装）', title: settings.adbPath || '' }),
          btn('选择本地 adb…', browseAdb, 'browse'),
          btn('扫描本机', scanAdb, 'scan'),
          btn('自动安装并选中', installAdb, 'install'))),
      cands && cands.length ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
        h('div', { className: 'ab-small ab-muted' }, '扫到这些 adb，点一个选用：'),
        cands.map((p) => h('div', { key: p, style: { marginTop: 4 } }, btn(p, () => pickAdb(p), 'pick:' + p)))) : null,
      h(ui.Row, { label: '设备', hint: '检测后从下拉选一台' },
        h('div', { className: 'ab-flex', style: { gap: 8, width: '100%' } },
          h(ui.Select, {
            value: settings.deviceSerial || '',
            options: [{ value: '', label: '（自动：第一台设备）' }].concat((devices || []).map((x) => ({ value: x.serial, label: x.model ? x.serial + '（' + x.model + '）' : x.serial }))),
            // pickDevice 是工厂式（返回执行器），Select 不理会返回值：这里替它把执行器跑起来
            onChange: (v) => { const r = pickDevice(v); if (typeof r === 'function') r() },
          }),
          btn('检测设备', detectDevices, 'detect'))),
      devices && devices.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '共 ' + devices.length + ' 台：' + devices.map((x) => x.serial + (x.state === 'device' ? '' : '（' + x.state + '）')).join('、')) : null),

    // ===== ②½ 手机开 ADB 调试与首次授权指引（第一次连手机的照着走）=====
    h(ui.Card, { title: '手机 ADB 调试与首次授权指引', desc: '第一次让模块碰手机？照下面的步骤把手机的 ADB 调试打开并完成首次授权（用模拟器的可以跳过 1~3 步，模拟器一般自带已开好的 adb）。' },
      h('ol', { className: 'ab-small', style: { margin: 0, paddingLeft: 20, lineHeight: 1.9 } },
        h('li', null, '打开「开发者选项」：设置 → 关于手机 → 连续点击「版本号」7 次，提示已进入开发者模式（各品牌入口名可能略有差异，可在设置里搜「版本号」）。'),
        h('li', null, '打开「USB 调试」：设置 → 系统 → 开发者选项 → 打开「USB 调试」（小米/华为等还需同页打开「USB 调试（安全设置）」才允许模拟点击）。'),
        h('li', null, h('b', null, '首次授权（最关键）'), '：数据线连上电脑后，手机会弹出「允许 USB 调试吗？」——勾选「一律允许使用这台计算机进行调试」再点「允许」。', h('span', { style: { color: '#e5484d', fontWeight: 600 } }, '不点允许模块就连不上手机'), '；没弹窗就把数据线换成能传数据线的（别用纯充电线），或拔插一次。'),
        h('li', null, '回到本面板点上面的「检测设备」，下拉里能看到你的手机型号即成功；选中它或留空用第一台。'),
        h('li', null, '无线连接（可选，Android 11+）：开发者选项 → 无线调试 → 用配对码配对；不熟悉的话用数据线最稳。'),
        h('li', null, '模拟器用户：雷电/MuMu 等模拟器自带 adb 且默认已开调试，通常「检测设备」直接就能看到，无需以上步骤。'))),

    // ===== ③ 包名白名单：设置框 + 从手机选应用的助手放在一起 =====
    h(ui.Card, { title: '包名白名单', desc: '管住她只能动哪些应用，每行一个包名，空 = 不限制。点「获取已装应用」从手机里挑，点「加入」直接追加落盘；也可以在文本框里手填，改完点上面的「保存设置」。认不出的包名点「启动看看」在手机上打开它认一认（只打开不点任何东西）。' },
      h('textarea', {
        className: 'ab-textarea', rows: 5, style: { width: '100%', fontFamily: 'monospace', fontSize: 12 },
        placeholder: 'com.tencent.mm\ntv.danmaku.bili', value: d.whitelist, onChange: (e) => upd({ whitelist: e.target.value }),
      }),
      h('div', { className: 'ab-flex', style: { marginTop: 10, flexWrap: 'wrap', gap: 8 } },
        btn('获取已装应用', loadPkgs, 'pkgs'),
        h('input', { className: 'ab-input', style: { flex: '1 1 180px' }, placeholder: '按应用名或包名过滤…', value: kw, onChange: (e) => setKw(e.target.value) })),
      pkgs ? h('div', { style: { marginTop: 8, maxHeight: 320, overflowY: 'auto' } },
        filtered.length
          ? filtered.map((p) => h('div', {
            key: p,
            style: {
              display: 'flex', gap: 8, alignItems: 'center', padding: '7px 4px',
              borderBottom: '1px solid var(--ab-line)',
            },
          },
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            appNames[p]
              ? h('span', null, h('b', null, appNames[p]), h('span', { className: 'ab-muted', style: { marginLeft: 8, fontFamily: 'monospace', fontSize: 12 } }, p))
              : h('span', { style: { fontFamily: 'monospace', fontSize: 12 } }, p)),
          btn('启动看看', () => probeApp(p), 'probe:' + p),
          btn('加入', () => addWhitelist(p), 'add:' + p)))
          : h('div', { className: 'ab-small ab-muted' }, '没有匹配的应用')) : null),

    // ===== ④ 主流程总纲（独立于应用指引；主动逛一轮的总章程，不可删除只能还原） =====
    h(ui.Card, { title: '主流程总纲', desc: '「定时主动逛」和主人私聊「去逛逛手机」时，她按这份总纲决定这一轮逛哪些应用、怎么排、以什么为主。它独立于下面的单应用手册，两边会一起喂给决策器；只能编辑和还原内置版，不能删除。' },
      mainSecs === null
        ? h('span', { className: 'ab-muted ab-small' }, '加载中…')
        : h('div', null,
          h('div', { className: 'ab-flex', style: { marginBottom: 2 } },
            h(ui.Seg, { value: mainWhole ? 'whole' : 'secs', onChange: (v) => setMainWhole(v === 'whole'), options: [{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }] }),
            h('div', { className: 'ab-spacer' }),
            h('span', { className: 'ab-muted ab-small' }, mainBody.length + ' 字')),
          mainWhole
            ? h('textarea', { className: 'ab-input', style: { width: '100%', minHeight: 260, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }, value: mainBody, onChange: (e) => { setMainSecs(splitGuide(e.target.value)); setMainDirty(true) } })
            : h('div', { className: 'ab-psecs', style: { marginTop: 8 } },
              (mainSecs || []).map((s, i) => h(GuideSection, {
                key: s.k, sec: s, i, n: mainSecs.length,
                onChange: (p) => updMainSec(s.k, p), onMove: (dd) => moveMainSec(i, dd), onDelete: () => delMainSec(s),
              })),
              h('div', { className: 'ab-psec-add' },
                h('span', { className: 'ab-muted ab-small' }, '加一节：'),
                GSEC_SUGGEST.filter((t) => !(mainSecs || []).some((s) => s.title === t)).map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addMainSec(t) }, t)),
                h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addMainSec('') }, '＋ 自己起名'))),
          h('div', { className: 'ab-flex', style: { marginTop: 12 } },
            mainDirty ? h('span', { className: 'ab-muted ab-small' }, '有改动还没保存') : null,
            h('div', { className: 'ab-spacer' }),
            btn('保存总纲', saveMain, 'savemain', true),
            btn('还原内置版', resetMain, 'resetmain')))),

    // ===== ⑤ 应用指引提示词 =====
    h(ui.Card, { title: '指引提示词', desc: '教操作决策器怎么逛某个 App（怎么刷视频/搜索/私信）。左边选平台，右边像人格页那样一节一个框地改（也能切「整段」）。流程按包名和任务关键词自动挑指引；自定义条目可删除（要过两道确认），内置条目只能还原。主流程总纲在上面单独一张卡。' },
      h('div', { className: 'ab-persona' },
        // 左列：所有平台（内置 + 自定义，不含总纲）＋ 新增入口，仿人格页的列表
        h('div', { className: 'ab-plist' },
          guides === null ? h('div', { className: 'ab-muted ab-small' }, '加载中…') : null,
          appGuides.map((g) => h('div', { key: g.key, style: { display: 'flex', gap: 4, alignItems: 'stretch' } },
            h('button', {
              type: 'button',
              className: 'ab-pitem' + (!creating && guideKey === g.key ? ' on' : ''),
              style: { flex: 1, minWidth: 0 },
              onClick: () => viewGuide(g.key),
            },
            h('div', { className: 'nm' }, g.name, g.source === 'custom' ? h('span', { className: 'ab-badge' }, '自定义') : null),
            h('div', { className: 'tg' }, g.key + ' · ' + (g.text || '').length + ' 字')),
          g.source === 'custom' ? h('button', { type: 'button', className: 'ab-ibtn danger', title: '删除这条自定义指引（两道确认）', disabled: !!busy, onClick: () => delGuide(g) }, '✕') : null)),
          h(ui.Btn, { kind: 'ghost', onClick: startCreate }, '＋ 新增指引')),
        // 右列：选中指引的分节/整段编辑，或新增指引的建卡页
        creating
          ? h(ui.Card, { title: '新增指引', desc: 'key 用于存盘，也留给你在流程里显式指定；名字显示在左边列表。' },
            h(ui.Row, { label: 'key', hint: '小写字母/数字/短横线，2~40 字' }, h('input', { className: 'ab-input', value: newKey, placeholder: 'my-app-guide', onChange: (e) => setNewKey(e.target.value) })),
            h(ui.Row, { label: '名字' }, h('input', { className: 'ab-input', value: newName, placeholder: '某App', onChange: (e) => setNewName(e.target.value) })),
            h('div', { className: 'ab-flex', style: { marginTop: 12 } },
              h(ui.Btn, { kind: 'primary', onClick: beginNew }, '创建并开始编辑'),
              h(ui.Btn, { onClick: () => setCreating(false) }, '取消')))
          : guideKey
            ? h('div', null,
              h('div', { className: 'ab-flex', style: { marginBottom: 2 } },
                h(ui.Seg, { value: whole ? 'whole' : 'secs', onChange: (v) => setWhole(v === 'whole'), options: [{ value: 'secs', label: '分节' }, { value: 'whole', label: '整段' }] }),
                h('div', { className: 'ab-spacer' }),
                h('span', { className: 'ab-muted ab-small' }, Math.max(0, secs.length - (secs[0] && secs[0].title === null ? 1 : 0)) + ' 节 · ' + body.length + ' 字')),
              whole
                ? h('textarea', { className: 'ab-input', style: { width: '100%', minHeight: 340, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }, value: body, onChange: (e) => { setSecs(splitGuide(e.target.value)); setGdirty(true) } })
                : h('div', { className: 'ab-psecs', style: { marginTop: 0 } },
                  secs.map((s, i) => h(GuideSection, {
                    key: s.k, sec: s, i, n: secs.length,
                    onChange: (p) => updSec(s.k, p), onMove: (dd) => moveSec(i, dd), onDelete: () => delSec(s),
                  })),
                  h('div', { className: 'ab-psec-add' },
                    h('span', { className: 'ab-muted ab-small' }, '加一节：'),
                    GSEC_SUGGEST.filter((t) => !secs.some((s) => s.title === t)).map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addSec(t) }, t)),
                    h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addSec('') }, '＋ 自己起名'))),
              h('div', { className: 'ab-flex', style: { marginTop: 12 } },
                gdirty ? h('span', { className: 'ab-muted ab-small' }, '有改动还没保存') : null,
                h('div', { className: 'ab-spacer' }),
                btn('保存为自定义', saveGuide, 'saveguide'),
                btn('还原内置版', resetGuide, 'delguide')))
            : h(ui.Card, null, h(ui.Empty, { icon: '📄', text: '选一条指引，或点左边「＋ 新增指引」' })))),
  )
}
