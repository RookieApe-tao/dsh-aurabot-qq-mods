// panel.js —— 「我的世界服务器分身」面板。
// 由面板宿主动态执行：拿到 React、h（createElement）、ui（自带组件）、call（调模块路由），
// 最后 return 一个 React 组件。
//
// 布局：状态卡 + 服务器自动检测在最上面，设置按「连接 / 接话 / 权限 / 事件」分组放在下面。
// 设置项由这个面板自己渲染（index.mjs 的 settings 是空的），改动要点「保存设置」才生效。

const { useState, useEffect, useCallback } = React

const dot = (ok) => h('span', {
  style: {
    display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6,
    background: ok ? '#16a34a' : '#ef4444',
  },
})

const mono = (text) => h('span', { style: { fontFamily: 'Consolas, monospace', fontSize: 12 } }, text)

const MODE_LABEL = { smart: '智能接话', wake: '只回应召唤', all: '每条都看' }

const NUMBER_KEYS = [
  'port', 'interjectChance', 'maxReplyChars', 'maxCommands', 'maxHistory', 'cooldownSec',
  'maxPerMinute', 'mergeMs', 'deathChance', 'deathCooldownSec', 'guestCommandCooldownSec', 'detectIntervalSec',
]

return function Panel ({ settings, draftSettings, setSettings, save, toast }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [cmd, setCmd] = useState('')
  const [say, setSay] = useState('')
  const [form, setForm] = useState(() => ({ ...(settings || {}) }))
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (refresh) => {
    try {
      const r = await call('/status' + (refresh ? '?t=' + Date.now() : ''))
      if (r && r.ok) setSt(r)
    } catch (error) {
      // 面板不因为读状态失败而白屏
    }
  }, [])

  useEffect(() => {
    load(true)
    const timer = setInterval(() => load(false), 5000)
    return () => clearInterval(timer)
  }, [])

  // 保存后插件会刷新 settings，这里同步一次表单
  useEffect(() => { setForm({ ...(settings || {}) }) }, [JSON.stringify(settings || {})])

  const act = async (label, path, body) => {
    setBusy(label)
    try {
      const r = await call(path, body)
      toast((r && r.message) || (r && r.ok === false ? '没成功' : '好了'), r && r.ok === false ? 'err' : 'ok')
      load(true)
    } catch (error) {
      toast(String((error && error.message) || error), 'err')
    } finally {
      setBusy('')
    }
  }

  // ---- 服务器自动检测 ----
  const [scan, setScan] = useState(null)
  const [scanning, setScanning] = useState(false)
  const scanNow = async () => {
    setScanning(true)
    try {
      const r = await call('/detect')
      if (r && r.ok !== false) setScan(r)
      else toast((r && r.message) || '检测失败')
    } catch (error) {
      toast(String((error && error.message) || error))
    } finally {
      setScanning(false)
    }
  }
  const switchTo = async (dir) => {
    setBusy('switch')
    try {
      const r = await call('/switch', { dir })
      toast((r && r.message) || '已切换', r && r.ok === false ? 'err' : 'ok')
      load(true)
      scanNow()
    } catch (error) {
      toast(String((error && error.message) || error), 'err')
    } finally {
      setBusy('')
    }
  }
  useEffect(() => { scanNow() }, [])

  const rcon = (st && st.rcon) || {}
  const watch = st && st.watch
  const online = (st && st.online) || []
  const recent = (st && st.recent) || []
  const cfg = (st && st.settings) || {}

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const saveAll = async () => {
    setSaving(true)
    try {
      const patch = { ...form }
      for (const k of NUMBER_KEYS) {
        if (patch[k] === '' || patch[k] == null) delete patch[k]
        else patch[k] = Number(patch[k])
      }
      await save(patch)
    } catch (error) {
      toast(String((error && error.message) || error), 'err')
    } finally {
      setSaving(false)
    }
  }

  const row = (label, node) => h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' } },
    h('span', { className: 'ab-small ab-muted', style: { minWidth: 86 } }, label),
    node)

  // ---- 设置字段 ----
  const field = (label, node, hint) => h('div', { style: { marginBottom: 10 } },
    h('label', { className: 'ab-small ab-muted', style: { display: 'block', marginBottom: 2 } }, label),
    node,
    hint ? h('div', { className: 'ab-small ab-muted' }, hint) : null)

  const text = (key, label, hint, placeholder) => field(label,
    h('input', {
      className: 'ab-input', style: { width: '100%' }, value: form[key] ?? '', placeholder,
      onChange: (e) => set(key, e.target.value),
    }), hint)

  const secret = (key, label, hint) => field(label,
    h('input', {
      className: 'ab-input', style: { width: '100%' }, type: 'password', value: form[key] ?? '',
      placeholder: '已保存（不改就留空）',
      onChange: (e) => set(key, e.target.value),
    }), hint)

  const num = (key, label, hint, min, max, step) => field(label,
    h('input', {
      className: 'ab-input', type: 'number', min, max, step, style: { width: 140 }, value: form[key] ?? '',
      onChange: (e) => set(key, e.target.value === '' ? '' : Number(e.target.value)),
    }), hint)

  const area = (key, label, hint, rows = 3) => field(label,
    h('textarea', {
      className: 'ab-input', rows, style: { width: '100%' }, value: form[key] ?? '',
      onChange: (e) => set(key, e.target.value),
    }), hint)

  const sw = (key, label, hint) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
    h(ui.Switch, { on: form[key] === true, onChange: () => set(key, !(form[key] === true)) }),
    h('span', { className: 'ab-small' }, label),
    hint ? h('span', { className: 'ab-small ab-muted' }, hint) : null)

  const sel = (key, label, options, hint) => field(label,
    h('select', {
      className: 'ab-input', style: { width: 240 }, value: form[key] ?? '',
      onChange: (e) => set(key, e.target.value),
    }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))), hint)

  const grid = (children) => h('div', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0 24px' },
  }, children)

  const recentList = recent.length
    ? h('div', { style: { marginTop: 6, maxHeight: 260, overflow: 'auto' } },
        recent.map((item, i) => h('div', {
          key: i + '-' + item.at,
          className: 'ab-small',
          style: { padding: '3px 0', borderBottom: '1px solid rgba(0,0,0,0.05)', color: item.dir === 'in' ? '#334155' : '#2563eb' },
        },
          h('span', { className: 'ab-muted' }, new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' '),
          item.dir === 'in'
            ? h('span', null, (item.admin ? '👑 ' : '') + item.player + '：' + item.text)
            : item.dir === 'event'
              ? h('span', { style: { color: '#b45309' } }, '⚰ ' + item.text)
              : h('span', null, '→ ' + item.player + '：' + item.text))))
    : h('p', { className: 'ab-note' }, '还没有记录。游戏里有人说话、或者你在这里手动发一条，都会出现在这儿。')

  return h('div', { className: 'ab-grid' },
    // ================= 状态 =================
    h(ui.Card, {
      title: '🌊 我的世界分身',
      right: h(ui.Btn, { small: true, disabled: !!busy, onClick: () => act('test', '/status', {}) }, busy === 'test' ? '刷新中…' : '刷新状态'),
    },
      row('总开关', h('span', { className: 'ab-small' }, (cfg.enabled ? '开' : '关') + ' / 游戏内监听' + (cfg.listen ? '开' : '关'))),
      row('接话', h('span', { className: 'ab-small' }, (MODE_LABEL[cfg.chatMode] || cfg.chatMode || '每条都看') + '（被叫到必回，其余可以自己沉默）')),
      row('死亡播报', h('span', { className: 'ab-small' }, cfg.eventsEnabled ? '开（有人死了会说一句）' : '关')),
      row('RCON', h('span', { className: 'ab-small' }, dot(rcon.connected), rcon.connected ? '已连接 ' : '未连接 ', mono((rcon.host || '') + ':' + (rcon.port || '')))),
      row('日志', h('span', { className: 'ab-small' },
        dot(Boolean(watch && watch.exists)),
        watch ? (watch.exists ? '正在跟随，已读 ' + watch.lines + ' 行' : '文件不存在') : '没在跟随（监听关着或没填路径）')),
      watch && !watch.exists ? h('div', { className: 'ab-small ab-muted', style: { wordBreak: 'break-all' } }, watch.path) : null,
      row('在线', h('span', { className: 'ab-small' }, online.length ? online.join('、') : '查不到 / 没人')),
      row('人格卡', h('span', { className: 'ab-small' }, (st && st.persona && st.persona.name) || '读取中…')),
      row('必回唤醒词', h('span', { className: 'ab-small' }, (cfg.wakeWords || []).join('、') || '没设置')),
      row('管理员', h('span', { className: 'ab-small' }, (cfg.admins || []).join('、') || '没设置')),
      st && st.lastError ? h('p', { className: 'ab-note' }, '⚠ ' + st.lastError) : null),

    // ================= 服务器自动检测 =================
    h(ui.Card, {
      title: '服务器自动检测',
      right: h(ui.Btn, { small: true, disabled: scanning, onClick: scanNow }, scanning ? '检测中…' : '立即检测'),
    },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' } },
        h('span', { className: 'ab-small ab-muted' }, '自动检测'),
        h(ui.Switch, {
          on: form.autoDetect === true,
          onChange: () => set('autoDetect', !(form.autoDetect === true)),
        }),
        h('span', { className: 'ab-small ab-muted' }, '换端后自动切到正在跑的服（改完点下方「保存设置」生效）')),
      h('p', { className: 'ab-small ab-muted', style: { margin: '4px 0' } },
        '扫描服务器根目录，读每个服的 server.properties，用日志时间和 RCON 试连判断谁在跑；多个服共用 25575 时选日志最新的那个。'),
      scan && scan.current
        ? h('p', { className: 'ab-small' }, '当前：' + (scan.current.serverName || scan.current.logPath || '未设置') + '（' + scan.current.port + '）')
        : null,
      scan && scan.candidates && scan.candidates.length
        ? h('div', { style: { marginTop: 4 } },
            scan.candidates.map((c) => h('div', {
              key: c.dir,
              className: 'ab-small',
              style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(0,0,0,0.05)' },
            },
              h('span', { style: { flex: 1, fontWeight: c.current ? 600 : 400 } },
                (c.current ? '● ' : '') + c.name + '  ·  ' + c.port +
                (c.reachable ? ' · RCON 可连' : c.rconEnabled ? ' · 连不上' : ' · 未开 RCON')),
              h('span', { className: 'ab-muted' },
                c.logAgeMs == null ? '没有日志' : c.logAgeMs < 60_000 ? '日志刚刚更新' : '日志 ' + Math.round(c.logAgeMs / 60_000) + ' 分钟前'),
              h(ui.Btn, { small: true, disabled: !!busy || c.current, onClick: () => switchTo(c.dir) }, c.current ? '当前' : '切换'))))
        : h('p', { className: 'ab-note' }, scanning ? '正在扫描…' : '还没检测到带 server.properties 的服务器'),
      scan && scan.active ? h('p', { className: 'ab-small', style: { color: '#16a34a' } }, '检测到运行中：' + scan.active.name) : null),

    // ================= 保存按钮 =================
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '2px 0' } },
      h('div', null,
        h('div', { className: 'ab-small', style: { fontWeight: 600 } }, '设置'),
        h('div', { className: 'ab-small ab-muted' }, '按用途分了组，改完点右边保存')),
      h(ui.Btn, { kind: 'primary', disabled: saving, onClick: saveAll }, saving ? '保存中…' : '保存设置')),

    // ================= 连接与监听 =================
    h(ui.Card, { title: '连接与监听' },
      grid([
        sw('enabled', '总开关', '关掉后不再连服务器、不回应，但 /mc 命令仍可用'),
        sw('listen', '游戏内聊天监听', '打开后才会读日志、参与游戏聊天'),
        text('host', 'RCON 地址', 'server.properties 里的 rcon 设置', '127.0.0.1'),
        num('port', 'RCON 端口', 'server.properties 的 rcon.port', 1, 65535, 1),
        secret('password', 'RCON 密码', '已保存就不改；留空保留原密码'),
        text('logPath', '服务器日志路径', '服务器文件夹里的 logs/latest.log；纯 RCON 读不到聊天，只能靠它'),
        text('serverName', '服务器名字', '只用于提示词'),
        secret('ingestToken', '外部转发 token', '服务器端 POST /ingame 时用；留空关闭转入口'),
        text('personaId', '人格卡 id', '空 = 当前人格'),
      ])),

    // ================= 接话 =================
    h(ui.Card, { title: '接话' },
      grid([
        sel('chatMode', '接话方式', [
          { value: 'all', label: '每条都看（推荐）' },
          { value: 'smart', label: '智能接话' },
          { value: 'wake', label: '只回应召唤' },
        ], '每条都看：所有聊天都交给她判断，不想接就沉默'),
        sel('replyMode', '回应方式', [
          { value: 'broadcast', label: '所有人可见' },
          { value: 'direct', label: '只回给说话的人' },
        ]),
        text('replyPrefix', '游戏内前缀', '每条回复前面的标记，例如 [MC] ', '[MC] '),
        num('interjectChance', '随机插话概率（%）', '普通闲聊里没人叫她时，随机接一句的概率', 0, 100, 1),
        num('maxReplyChars', '每条最多字数', null, 20, 500, 10),
        num('maxCommands', '一次最多几条命令', null, 1, 8, 1),
        num('maxHistory', '给模型看最近几条聊天', null, 0, 30, 1),
        num('cooldownSec', '同一个人冷却秒数', '只限制普通接话；被叫到名字时不受限', 0, 600, 1),
        num('maxPerMinute', '每分钟最多回应次数', null, 1, 30, 1),
        num('mergeMs', '连续消息合并窗口（毫秒）', '同一人连发几条会合并成一次处理，0 = 不合并', 0, 5000, 100),
        sw('useThink', '用她完整的记忆和人格', '带 QQ 记忆，慢一点'),
        area('wakeWords', '必回唤醒词', '一行一个；出现就一定回应', 2),
        area('nicknames', '其他称呼', '一行一个；提到算在说她', 2),
        area('topics', '感兴趣的话题', '一行一个；出现更容易接话', 3),
      ])),

    // ================= 权限与操作 =================
    h(ui.Card, { title: '权限与操作' },
      grid([
        area('admins', '游戏内管理员', '一行一个 Minecraft 玩家名，可执行较广的命令', 2),
        area('allowed', '允许互动的玩家', '一行一个；留空 = 所有人都能聊', 2),
        area('qqAdmins', 'Aurabot 管理员 QQ', '一行一个 QQ 号，可以用 /mc 命令；主人永远可以', 2),
        area('guestCommands', '普通玩家可用操作', '一行一个；内置支持 gamemode、tp、back、spawn、list、time query', 3),
        num('guestCommandCooldownSec', '普通玩家操作间隔（秒）', null, 0, 600, 1),
        area('blockedCommands', '禁止执行的命令', '一行一个前缀；管理员也不能执行（QQ 主人 /mc cmd 除外）', 4),
        sw('confirmCrossDimension', '跨维度 tp 先确认', '玩家说去下界/末地等另一个维度时先问一句'),
        area('dimensionAliases', '维度别名', '一行一个「别名=维度id」，可加模组维度', 5),
      ])),

    // ================= 事件与自动检测 =================
    h(ui.Card, { title: '事件与自动检测' },
      grid([
        sw('eventsEnabled', '死亡时主动说话', '游戏里有人死了，她会调侃/关心一句'),
        num('deathChance', '死亡播报概率（%）', null, 0, 100, 5),
        num('deathCooldownSec', '同一玩家死亡播报间隔（秒）', null, 0, 3600, 10),
        sw('autoDetect', '自动检测正在运行的服务器', '换端后自动读新服的 RCON 和日志路径'),
        num('detectIntervalSec', '自动检测间隔（秒）', null, 15, 600, 5),
        area('serverRoot', '服务器根目录', '一行一个；下面每个带 server.properties 的文件夹都会作为候选', 3),
      ])),

    // ================= 手动操作 =================
    h(ui.Card, { title: '手动操作', desc: '直接走 RCON，不过模型、也不经过聊天判断。' },
      h('div', { style: { display: 'flex', gap: 8, margin: '6px 0', flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', style: { flex: 1, minWidth: 220 }, value: cmd,
          placeholder: '服务器命令，例如 list / gamemode spectator 玩家名',
          onChange: (e) => setCmd(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && cmd.trim()) act('exec', '/exec', { command: cmd }) },
        }),
        h(ui.Btn, { disabled: !!busy || !cmd.trim(), onClick: () => act('exec', '/exec', { command: cmd }) }, busy === 'exec' ? '执行中…' : '执行')),
      h('div', { style: { display: 'flex', gap: 8, margin: '6px 0', flexWrap: 'wrap' } },
        h('input', {
          className: 'ab-input', style: { flex: 1, minWidth: 220 }, value: say, placeholder: '让「她」在服务器里说一句话',
          onChange: (e) => setSay(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && say.trim()) act('say', '/say', { text: say }) },
        }),
        h(ui.Btn, { disabled: !!busy || !say.trim(), onClick: () => act('say', '/say', { text: say }) }, busy === 'say' ? '发送中…' : '发送')),
      h('p', { className: 'ab-small ab-muted' }, '这些操作会真的发到游戏里；命令不经过「禁止执行的命令」名单（面板操作等同于主人亲自执行）。')),

    // ================= 最近记录 =================
    h(ui.Card, { title: '最近在游戏里', right: h(ui.Btn, { small: true, onClick: () => load(true) }, '刷新') },
      recentList))
}
