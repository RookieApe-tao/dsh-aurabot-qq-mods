/**
 * adb.mjs —— phone 模块 ADB 命令封装
 * 作用：对 adb 做一层 execFile 包装：serial 前置、超时、统一错误码。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function createAdb({ adbPath, serial = '', timeoutMs = 10000 })
 *   → { adb(args), devices(), screenshot(), dumpNodes(), tap(x,y),
 *       swipe(x1,y1,x2,y2,ms=300), longPress(x,y,ms=800), inputText(text), pressKey(key),
 *       key(name), clearText(), currentPackage(), launchApp(pkgOrComponent) }
 *   失败 throw 的 Error 带 .code='ADB_ERROR' .cmd .stderr
 */
import { execFile } from 'node:child_process'

/**
 * 创建 adb 操作对象。
 * @param {{adbPath: string, serial?: string, timeoutMs?: number}} o
 */
export function createAdb({ adbPath, serial = '', timeoutMs = 10000 } = {}) {
  // 内部通用执行：拼 serial 前缀 → execFile → 失败统一 ADB_ERROR
  function run(args, opts = {}) {
    const full = serial ? ['-s', serial, ...args] : [...args]
    return new Promise((resolve, reject) => {
      execFile(
        adbPath,
        full,
        {
          timeout: opts.timeoutMs ?? timeoutMs,
          windowsHide: true,
          encoding: opts.encoding || 'utf8', // screenshot 用 buffer
          maxBuffer: 64 * 1024 * 1024, // 截屏/视图转储体积不小，放宽上限
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = new Error(`adb 命令失败: ${err.message}`)
            e.code = 'ADB_ERROR'
            e.cmd = `adb ${full.join(' ')}`
            e.stderr = String(stderr || '') || err.message
            reject(e)
            return
          }
          resolve(stdout)
        }
      )
    })
  }

  return {
    /** 通用 adb 命令，返回 stdout 字符串。 */
    adb(args) {
      return run(Array.isArray(args) ? args : [args])
    },

    /** 已连接设备序列号列表（解析 devices 输出，去掉表头和 offline 行）。 */
    async devices() {
      const out = await run(['devices'])
      return out
        .split(/\r?\n/)
        .slice(1) // 去掉 "List of devices attached" 表头
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('*') && !/\toffline\b/.test(l))
        .map((l) => l.split(/\s+/)[0])
    },

    /** 截屏：exec-out screencap -p，返回 Buffer。 */
    async screenshot() {
      const buf = await run(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    },

    /** 视图转储：uiautomator dump 到 /sdcard/uidump.xml 再 cat 回来，返回 XML 字符串。 */
    async dumpNodes() {
      // 先删旧转储：uiautomator dump 在卡顿设备上偶发静默失败（退出码 0 但没写文件），
      // 不删的话 cat 会读回上一屏的陈旧 XML，模型照过期界面操作会点错地方
      await run(['shell', 'rm', '-f', '/sdcard/uidump.xml'])
      // 让设备端生成 XML（覆盖写），失败抛错，上层工作区循环负责重试/截图兜底
      await run(['shell', 'uiautomator', 'dump', '/sdcard/uidump.xml'])
      const xml = await run(['shell', 'cat', '/sdcard/uidump.xml'])
      return String(xml)
    },

    /** 点击坐标。 */
    tap(x, y) {
      return run(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]).then(() => undefined)
    },

    /** 滑动（默认 300ms）。 */
    swipe(x1, y1, x2, y2, ms = 300) {
      return run([
        'shell', 'input', 'swipe',
        String(Math.round(x1)), String(Math.round(y1)),
        String(Math.round(x2)), String(Math.round(y2)),
        String(Math.round(ms)),
      ]).then(() => undefined)
    },

    /**
     * 长按：input swipe 同起点终点 + 长时长即等价按住不放；
     * ms 建议 ≥600，低于系统长按阈值（一般 500ms）会被当成普通点击。
     */
    longPress(x, y, ms = 800) {
      const d = Math.max(600, Math.round(ms || 800))
      return this.swipe(x, y, x, y, d)
    },

    /**
     * 输入文本：input text 不认空格（转 %s）；非 ASCII（如中文）原生 input 无法输入，
     * 需要 ADB Keyboard 输入法——按约定抛带提示的错误，由工作区标注「本步跳过」。
     */
    async inputText(text) {
      const s = String(text)
      // 非 ASCII 字符：中文/emoji 等 input text 无法直接输入
      if (/[^\x00-\x7F]/.test(s)) {
        const e = new Error(`输入文本含非 ASCII 字符（需 ADB Keyboard，本步跳过）: ${s.slice(0, 40)}`)
        e.code = 'ADB_ERROR'
        e.cmd = 'adb shell input text'
        e.stderr = 'non-ascii input requires ADB Keyboard IME'
        throw e
      }
      // 一审 #19-1：adb 会把参数拼成远端 shell 命令，元字符必须转义（空格走 input text 的 %s 约定），
      // 否则 `;`、`|`、`$()` 之类会被远端 shell 当命令执行。
      const escaped = s.replace(/[\\;|&$`'"<>()*?!#~{}[\]\s]/g, (c) => (c === ' ' ? '%s' : '\\' + c))
      await run(['shell', 'input', 'text', escaped])
    },

    /** 按键：back / home / enter 等。 */
    pressKey(key) {
      return run(['shell', 'input', 'keyevent', String(key)]).then(() => undefined)
    },

    /** 决策器可用的按键白名单：名字 → Android keycode。 */
    KEYCODES: {
      enter: 66, tab: 61, volume_up: 24, volume_down: 25, power: 26, notifications: 83,
    },

    /** 白名单按键：enter/tab/音量/电源/通知栏；不在白名单的抛错（防止模型乱按系统键）。 */
    async key(name) {
      const code = this.KEYCODES[String(name || '').toLowerCase()]
      if (!code) throw new Error(`未知按键 ${name}（可用：${Object.keys(this.KEYCODES).join('/')}）`)
      return this.pressKey(code)
    },

    /**
     * 清空当前聚焦输入框：先 keyevent 123（移光标到末尾），再一条命令连按 50 次删除键。
     * 单命令多 keycode 省掉逐条 adb 往返；超过 50 字的输入框需再执行一次。
     */
    async clearText() {
      await this.pressKey(123) // KEYCODE_MOVE_END
      const dels = Array(50).fill(67) // KEYCODE_DEL
      return this.pressKey(dels.join(' '))
    },

    /** 当前前台包名：dumpsys window 解析 mCurrentFocus。 */
    async currentPackage() {
      const out = await run(['shell', 'dumpsys', 'window'])
      const m = /mCurrentFocus=(?:Window\{[^\n]*\s)?([\w.]+)\//.exec(out)
      return m ? m[1] : ''
    },

    /** 启动应用：给包名则 monkey 启动主 Activity；给 component（pkg/act）则直接 am start。 */
    launchApp(pkgOrComponent) {
      const s = String(pkgOrComponent).trim()
      const PKG = /^[A-Za-z0-9._]+$/
      // 一审 #19-1：包名/组件也会进 shell，先按格式校验，别把模型幻觉出的字符串塞进去。
      if (s.includes('/')) {
        const [pkg, act] = s.split('/', 2)
        if (!PKG.test(pkg) || !/^[A-Za-z0-9._$]+$/.test(act || '')) return Promise.reject(new Error(`组件不合法：${s || '(空)'}`))
        // 只把校验过的两段拼回去，别把原始 s（可能带 `/;id` 之类尾巴）交给 shell（复审第 1 条）
        return run(['shell', 'am', 'start', '-n', `${pkg}/${act}`]).then(() => undefined)
      }
      if (!PKG.test(s)) return Promise.reject(new Error(`包名不合法：${s || '(空)'}`))
      // monkey 在部分模拟器/精简 ROM 上被裁掉（inaccessible or not found）：
      // 失败就退回「解析 launcher activity → am start」两步走
      return run(['shell', 'monkey', '-p', s, '-c', 'android.intent.category.LAUNCHER', '1'])
        .catch(() => run(['shell', 'cmd', 'package', 'resolve-activity', '--brief', s]).then((out) => {
          const act = String(out).split(/\r?\n/).map((x) => x.trim()).find((x) => x && x.includes('/'))
          if (!act) throw new Error(`找不到 ${s} 的启动入口（resolve-activity 为空）`)
          if (!/^[A-Za-z0-9._]+$/ .test(act.split('/')[1] || '')) throw new Error(`解析出的组件不合法：${act}`)
          return run(['shell', 'am', 'start', '-n', act])
        }))
        .then(() => undefined)
    },

    /**
     * 强停应用（am force-stop）：逛完释放手机内存用。
     * 包名做一层格式校验（字母数字点下划线），防止把模型幻觉出的奇怪字符串塞进 shell。
     */
    forceStop(pkg) {
      const s = String(pkg || '').trim()
      if (!/^[\w.]+$/.test(s)) return Promise.reject(new Error(`包名不合法：${s || '(空)'}`))
      return run(['shell', 'am', 'force-stop', s]).then(() => undefined)
    },
  }
}
