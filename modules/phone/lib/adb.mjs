/**
 * adb.mjs —— phone 模块 ADB 命令封装
 * 作用：对 adb 做一层 execFile 包装：serial 前置、超时、统一错误码。
 * 契约（.pm-handoff/phone-contract.md §A，逐字对齐）：
 *   export function createAdb({ adbPath, serial = '', timeoutMs = 10000 })
 *   → { adb(args), devices(), screenshot(), dumpNodes(), tap(x,y),
 *       swipe(x1,y1,x2,y2,ms=300), inputText(text), pressKey(key),
 *       currentPackage(), launchApp(pkgOrComponent) }
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
      // 先让设备端生成 XML（覆盖写），可能偶发失败，上层工作区循环负责重试
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
      await run(['shell', 'input', 'text', s.replace(/ /g, '%s')])
    },

    /** 按键：back / home / enter 等。 */
    pressKey(key) {
      return run(['shell', 'input', 'keyevent', String(key)]).then(() => undefined)
    },

    /** 当前前台包名：dumpsys window 解析 mCurrentFocus。 */
    async currentPackage() {
      const out = await run(['shell', 'dumpsys', 'window'])
      const m = /mCurrentFocus=(?:Window\{[^\n]*\s)?([\w.]+)\//.exec(out)
      return m ? m[1] : ''
    },

    /** 启动应用：给包名则 monkey 启动主 Activity；给 component（pkg/act）则直接 am start。 */
    launchApp(pkgOrComponent) {
      const s = String(pkgOrComponent)
      if (s.includes('/')) return run(['shell', 'am', 'start', '-n', s]).then(() => undefined)
      return run(['shell', 'monkey', '-p', s, '-c', 'android.intent.category.LAUNCHER', '1']).then(() => undefined)
    },
  }
}
