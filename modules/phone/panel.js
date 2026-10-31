// panel.js —— 手机逛逛的自定义面板
// 拿到 React、h（React.createElement）、ui（面板自带组件）、call（调模块路由）
// 与原生设置表单共存：adb 路径 / 设备序列号不进原生表单（由这里的控件管理，save 即存即生效），
// 包名白名单仍在原生表单，这里的助手往里追加。
const { useState, useEffect } = React

return function Panel({ settings, save, toast }) {
  const [busy, setBusy] = useState('') // 当前在跑的操作名（按钮转圈/禁用用）
  const [cands, setCands] = useState(null) // 本机扫描到的 adb 候选路径
  const [devices, setDevices] = useState(null) // 连接的设备列表 [{serial, model, state}]
  const [pkgs, setPkgs] = useState(null) // 已装应用（第三方）列表
  const [kw, setKw] = useState('') // 包名过滤关键字

  const lock = (name, fn) => async () => {
    if (busy) return
    setBusy(name)
    try { await fn() } catch (e) { toast('出错了：' + (e.message || e)) }
    setBusy('')
  }

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
    await save({ adbPath: r.adbPath })
    toast('安装完成：' + r.adbPath)
  })
  const pickAdb = (p) => lock('pick', async () => {
    await save({ adbPath: p })
    setCands(null)
    toast('已选用：' + p)
  })
  // 弹系统文件选择框挑 adb.exe（服务端 PowerShell 弹原生对话框，返回绝对路径）
  const browseAdb = lock('browse', async () => {
    const r = await call('/adb/pickfile')
    if (!r.ok) return toast(r.error || '打开选择框失败')
    await save({ adbPath: r.path })
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
    await save({ deviceSerial: serial })
    toast(serial ? '已选设备：' + serial : '已改为自动选第一台设备')
  })

  // ---- 包名白名单助手 ----
  const loadPkgs = lock('pkgs', async () => {
    const serial = settings.deviceSerial || (devices && devices[0] && devices[0].serial) || ''
    const r = await call('/adb/packages?serial=' + encodeURIComponent(serial))
    if (!r.ok) return toast(r.error || '获取失败')
    setPkgs(r.packages)
    if (!r.packages.length) toast('没列出第三方应用（这台手机可能没装）')
  })
  const addWhitelist = (pkg) => lock('add:' + pkg, async () => {
    const cur = String(settings.whitelist || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    if (cur.includes(pkg)) return toast(pkg + ' 已在白名单里')
    await save({ whitelist: cur.concat(pkg).join('\n') })
    toast('已加入白名单：' + pkg)
  })

  // ---- 决策模型：参考系统菜单模型页的「按聊天选模型」，存 'provider::model'，空 = 跟随全局 ----
  const [models, setModels] = useState(null)
  useEffect(() => { call('/models').then((r) => setModels(r.list || [])).catch(() => setModels([])) }, [])
  const mkey = (m) => m.provider + '::' + m.model
  const curModel = String(settings.decisionModel || '')
  const modelOpts = [{ value: '', label: '跟随全局模型（聊天用的模型）' }]
    .concat((models || []).map((m) => ({ value: mkey(m), label: m.name })))
    .concat(curModel && !(models || []).some((m) => mkey(m) === curModel)
      ? [{ value: curModel, label: curModel.split('::').slice(1).join('::') + '（DSH 里没找到）' }] : [])
  const pickModel = (v) => save({ decisionModel: v }).then(() => toast(v ? '决策模型已换：' + v : '已改回跟随全局模型', 'ok'))

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
  const [dirty, setDirty] = useState(false)
  const [creating, setCreating] = useState(false) // 「＋ 新增指引」的建卡页
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  const pickGuide = (g) => { setGuideKey(g.key); setSecs(splitGuide(g.text || '')); setDirty(false) }
  const loadGuides = async () => {
    const r = await call('/guides')
    const list = r.guides || []
    setGuides(list)
    setCreating(false)
    // 已选的还在就保留（保存后刷新列表用这条），不在了才回落到第一条
    if (!list.some((g) => g.key === guideKey) && list.length) pickGuide(list[0])
  }
  // 打开面板即加载指引库（不需要再点按钮）
  useEffect(() => { loadGuides().catch((e) => toast('指引库加载失败：' + (e.message || e))) }, [])
  const viewGuide = (key) => {
    if (dirty && !confirm('这条指引还没保存，切走就丢了。确定切换？')) return
    const g = (guides || []).find((x) => x.key === key)
    if (g) pickGuide(g)
  }
  const startCreate = () => {
    if (dirty && !confirm('当前指引还没保存，先放一放？')) return
    setNewKey(''); setNewName(''); setCreating(true)
  }
  const beginNew = () => {
    const key = newKey.trim()
    if (!/^[a-z0-9-]{2,40}$/.test(key)) { toast('key 只能是小写字母/数字/短横线（2~40 字）', 'err'); return }
    if ((guides || []).some((g) => g.key === key)) { toast('已有同名 key：' + key + '，保存会覆盖它；想另建就换个 key', 'err'); return }
    const name = newName.trim() || key
    setCreating(false)
    setGuideKey(key)
    setSecs(splitGuide('【' + name + ' · 操作手册】\n◆ 总则\n- \n\n◆ 操作套路\n- \n\n◆ 坑\n- '))
    setDirty(true)
  }
  const updSec = (k, p) => { setSecs(secs.map((s) => (s.k === k ? { ...s, ...p } : s))); setDirty(true) }
  const moveSec = (i, d) => { const arr = secs.slice(); const [x] = arr.splice(i, 1); arr.splice(i + d, 0, x); setSecs(arr); setDirty(true) }
  const delSec = (s) => { if (s.text.trim() && !confirm('删掉「' + (s.title || '未命名') + '」这一节？')) return; setSecs(secs.filter((x) => x.k !== s.k)); setDirty(true) }
  const addSec = (title) => { setSecs(secs.concat([gsec(title, 'dot', '')])); setDirty(true) }
  const body = joinGuide(secs)
  const saveGuide = lock('saveguide', async () => {
    const r = await call('/guides', { key: guideKey, text: body })
    if (!r.ok) return toast(r.error || '保存失败')
    toast('已保存自定义指引：' + guideKey)
    setDirty(false)
    await loadGuides()
  })
  const resetGuide = lock('delguide', async () => {
    const r = await call('/guides', { key: guideKey, reset: true })
    if (!r.ok) return toast(r.error || '还原失败')
    toast('已还原成内置版：' + guideKey)
    const g = await call('/guides')
    const list = g.guides || []
    setGuides(list); setDirty(false)
    const cur = list.find((x) => x.key === guideKey)
    if (cur) pickGuide(cur)
  })

  const btn = (label, onClick, key) => h(ui.Btn, { key, onClick, disabled: !!busy }, busy === key ? '…' : label)
  const filtered = (pkgs || []).filter((p) => !kw || p.toLowerCase().includes(kw.toLowerCase()))

  return h('div', null,
    h(ui.Card, { title: 'adb 环境', desc: 'adb 是电脑操控手机的工具。留空会自动探测；没有就点「自动安装」（腾讯/Google 中国镜像下载），或点「扫描本机」「选择本地 adb」用已装好的。' },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('input', { className: 'ab-input', style: { flex: '1 1 260px' }, readOnly: true, value: settings.adbPath || '（自动探测 / 未安装）', title: settings.adbPath || '' }),
        btn('选择本地 adb…', browseAdb, 'browse'),
        btn('扫描本机', scanAdb, 'scan'),
        btn('自动安装并选中', installAdb, 'install')),
      cands && cands.length ? h('div', { className: 'ab-note', style: { marginTop: 8 } },
        h('div', { className: 'ab-small ab-muted' }, '扫到这些 adb，点一个选用：'),
        cands.map((p) => h('div', { key: p, style: { marginTop: 4 } }, btn(p, pickAdb, 'pick:' + p)))) : null),

    h(ui.Card, { title: '设备', desc: '手机开 USB 调试连电脑，点「检测设备」后从下拉里选一台；留空 = 自动用第一台。' },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h(ui.Select, {
          value: settings.deviceSerial || '',
          options: [{ value: '', label: '（自动：第一台设备）' }].concat((devices || []).map((d) => ({ value: d.serial, label: d.model ? d.serial + '（' + d.model + '）' : d.serial }))),
          onChange: pickDevice,
        }),
        btn('检测设备', detectDevices, 'detect')),
      devices && devices.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '共 ' + devices.length + ' 台：' + devices.map((d) => d.serial + (d.state === 'device' ? '' : '（' + d.state + '）')).join('、')) : null),

    h(ui.Card, { title: '决策模型', desc: '操作决策器（看界面挑动作的模型）默认用哪个。顺序：这里选的 > 全局模型；选的在 DSH 里找不到时自动退回。保存即生效，下一个动作起就按新的来。' },
      models === null
        ? h('span', { className: 'ab-muted ab-small' }, '模型列表加载中…')
        : h(ui.Select, { value: curModel, width: 320, options: modelOpts, onChange: pickModel }),
      models && !models.length ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '没拿到 DSH 的模型列表，只能跟随全局模型。') : null),

    h(ui.Card, { title: '包名白名单助手', desc: '白名单管住她只能动哪些应用。这里从手机里列出第三方应用，点「加入」追加到白名单（白名单本体在下面的设置表单里，也可以手填）。' },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        btn('获取已装应用', loadPkgs, 'pkgs'),
        h('input', { className: 'ab-input', style: { flex: '1 1 180px' }, placeholder: '过滤关键字…', value: kw, onChange: (e) => setKw(e.target.value) })),
      pkgs ? h('div', { style: { marginTop: 8, maxHeight: 260, overflowY: 'auto' } },
        filtered.length
          ? filtered.map((p) => h('div', { key: p, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' } },
            h('span', { style: { flex: 1, fontFamily: 'monospace', fontSize: 12 } }, p),
            btn('加入', addWhitelist, 'add:' + p)))
          : h('div', { className: 'ab-small ab-muted' }, '没有匹配的应用')) : null),

    h(ui.Card, { title: '指引提示词', desc: '教操作决策器怎么逛某个 App（怎么刷视频/搜索/私信）。左边选平台，右边像人格页那样一节一个框地改（也能切「整段」）。流程按包名和任务关键词自动挑指引；这里改的是自定义版（只覆盖同名指引）。' },
      h('div', { className: 'ab-persona' },
        // 左列：所有平台（内置 + 自定义）＋ 新增入口，仿人格页的列表
        h('div', { className: 'ab-plist' },
          guides === null ? h('div', { className: 'ab-muted ab-small' }, '加载中…') : null,
          (guides || []).map((g) => h('button', {
            key: g.key, type: 'button',
            className: 'ab-pitem' + (!creating && guideKey === g.key ? ' on' : ''),
            onClick: () => viewGuide(g.key),
          },
          h('div', { className: 'nm' }, g.name, g.source === 'custom' ? h('span', { className: 'ab-badge' }, '自定义') : null),
          h('div', { className: 'tg' }, g.key + ' · ' + (g.text || '').length + ' 字'))),
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
                ? h('textarea', { className: 'ab-input', style: { width: '100%', minHeight: 340, marginTop: 10, fontFamily: 'monospace', fontSize: 12 }, value: body, onChange: (e) => { setSecs(splitGuide(e.target.value)); setDirty(true) } })
                : h('div', { className: 'ab-psecs', style: { marginTop: 0 } },
                  secs.map((s, i) => h(GuideSection, {
                    key: s.k, sec: s, i, n: secs.length,
                    onChange: (p) => updSec(s.k, p), onMove: (d) => moveSec(i, d), onDelete: () => delSec(s),
                  })),
                  h('div', { className: 'ab-psec-add' },
                    h('span', { className: 'ab-muted ab-small' }, '加一节：'),
                    GSEC_SUGGEST.filter((t) => !secs.some((s) => s.title === t)).map((t) => h('button', { key: t, type: 'button', className: 'ab-chip', onClick: () => addSec(t) }, t)),
                    h('button', { type: 'button', className: 'ab-chip solid', onClick: () => addSec('') }, '＋ 自己起名'))),
              h('div', { className: 'ab-flex', style: { marginTop: 12 } },
                dirty ? h('span', { className: 'ab-muted ab-small' }, '有改动还没保存') : null,
                h('div', { className: 'ab-spacer' }),
                btn('保存为自定义', saveGuide, 'saveguide'),
                btn('还原内置版', resetGuide, 'delguide')))
            : h(ui.Card, null, h(ui.Empty, { icon: '📄', text: '选一条指引，或点左边「＋ 新增指引」' })))),
  )
}
