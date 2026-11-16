// 私人日记：每天让她自己写一篇 md，写给她自己看。
// 定位是「换身体之后还能翻回来」的记忆锚点：正文不限长度不限格式，
// 写成功会回写记忆库，聊天时也会带上最近几篇的线索，她还能主动用 diary_read 翻旧账。
/** @type {import('../aurabot').AurabotModule} */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
// 手写字体是可选的：放 assets/hand.ttf（老版本放模块根目录也认），没有就退回系统楷体
const FONT_FILE = [join(HERE, 'assets', 'hand.ttf'), join(HERE, 'hand.ttf')].find((p) => existsSync(p)) || ''

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const shiftDay = (day, n) => {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const quiet = (fn) => { try { return fn() } catch { return undefined } }

export default {
  id: 'local-diary',
  name: '私人日记',
  version: '1.0.1',
  api: 1,
  description: '每天写一篇 md 私人日记到本地文件夹，写给她自己看；随插件备份一起搬家',
  defaults: {
    on: true,
    at: '23:30',
    catchUp: true,
    dir: '',
    mirror: true,
    inject: true,
    maxRows: 200,
  },
  settings: [
    { key: 'on', label: '每天自动写', type: 'switch', hint: '关掉以后还能在 QQ 里发 /日记 手动写' },
    { key: 'at', label: '每天几点写', type: 'text', placeholder: '23:30', hint: '24 小时制；过了这个点当天还没写就补上' },
    { key: 'catchUp', label: '第二天早上补写昨天', type: 'switch', hint: '昨晚错过了，早上 7 点到 9 点之间补一篇' },
    { key: 'dir', label: '日记文件夹', type: 'text', placeholder: '留空 = 插件数据目录里的 diary/', hint: '填绝对路径可以放外面，比如 C:\\Users\\joe00\\Documents\\大肥鱼日记' },
    { key: 'mirror', label: '外部文件夹也镜像进备份区', type: 'switch', hint: '日记放在插件数据目录外面时，镜像一份进 modules-data，换电脑能带走' },
    { key: 'inject', label: '聊天时带上最近几篇的线索', type: 'switch', hint: '每轮多一段「你写过这些日记」，不塞整篇正文' },
    { key: 'maxRows', label: '最多读多少条当天聊天', type: 'number', min: 20, max: 2000, step: 10, hint: '太多会拖慢也容易跑偏，默认 200 条' },
  ],
  panel: 'panel.js',

  setup(api) {
    const base = api.dataDir()
    const stateFile = join(base, 'state.json')
    const indexFile = join(base, 'index.json')
    const mirrorDir = join(base, 'archive')

    const readJson = (file, fallback) => {
      try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
    }
    let state = readJson(stateFile, { last: '' })
    if (typeof state.last !== 'string') state.last = ''
    // 运行标志只在内存里：写进磁盘的话，重载或重启后会一直卡在「正在写」，定时再也不触发
    state.running = false
    let index = readJson(indexFile, [])
    if (!Array.isArray(index)) index = []
    const saveState = () => { try { writeFileSync(stateFile, JSON.stringify({ last: state.last }), 'utf8') } catch (e) { api.log.warn?.('私人日记：状态写不进去 ' + e.message) } }
    const saveIndex = () => { try { writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8') } catch (e) { api.log.warn?.('私人日记：索引写不进去 ' + e.message) } }

    /** 日记文件夹：留空就用数据目录里的 diary/，这样天然在备份里。 */
    const folder = () => {
      const dir = String(api.settings().dir || '').trim()
      return dir ? resolve(dir) : join(base, 'diary')
    }

    function parseMd(text) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
      const meta = {}
      if (m) {
        for (const line of m[1].split(/\r?\n/)) {
          const i = line.indexOf(':')
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
        }
      }
      return { meta, body: (m ? text.slice(m[0].length) : text).trim() }
    }

    /** 索引丢了（比如手动挪过文件夹）就从目录重扫一遍。 */
    function rescan() {
      const dir = folder()
      if (!existsSync(dir)) return
      const found = []
      for (const name of readdirSync(dir)) {
        if (!/\.md$/i.test(name)) continue
        const file = join(dir, name)
        const text = quiet(() => readFileSync(file, 'utf8'))
        if (text == null) continue
        const { meta, body } = parseMd(text)
        const day = meta.date && /^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? meta.date : name.replace(/\.md$/i, '').slice(0, 10)
        found.push({
          day,
          file,
          chars: body.length,
          mood: meta.mood || '',
          at: quiet(() => statSync(file).mtimeMs) || Date.now(),
          summary: clip(body, 90),
        })
      }
      index = found.sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.file).localeCompare(String(b.file)))
      saveIndex()
    }
    if (!index.length) rescan()

    const hasDiary = (day) => index.some((x) => x.day === day)

    /** 拼素材：当天聊天流水 + 心情 + 今天看过的东西。 */
    function collect(day) {
      const s = api.settings()
      const rows = api.core.hub.chatLogOf(day) || []
      const limit = Math.max(20, Number(s.maxRows) || 200)
      const picked = rows.slice(-limit)
      const lines = []
      let last = ''
      for (const r of picked) {
        const text = clip(r.text, 220)
        if (!text) continue
        const chat = String(r.chatId || '')
        if (chat !== last) {
          last = chat
          const id = chat.split(':')[1] || ''
          lines.push(`【${chat.startsWith('group:') ? '群聊 ' : chat.startsWith('private:') ? '私聊 ' : ''}${id}】`)
        }
        const t = new Date(Number(r.t) || Date.now())
        lines.push(`${pad(t.getHours())}:${pad(t.getMinutes())} ${r.who === 'bot' ? '我' : '对方'}：${text}`)
      }

      const mood = api.lazy('mood')
      const moodTag = clip(quiet(() => mood?.label?.()) || '', 20)
      const moodLine = clip(quiet(() => mood?.contextLine?.()) || moodTag, 400)

      const memory = api.lazy('memory')
      let seen = []
      const raw = quiet(() => memory?.timeline?.({ kind: 'seen' }))
      if (Array.isArray(raw)) {
        seen = raw.filter((x) => {
          const at = Number(x?.at || x?.saidAt || x?.t || 0)
          return !at || dayKey(new Date(at)) === day
        })
      }

      return { rows, lines: lines.slice(-1200), moodLine, moodTag, seen }
    }

    function buildPrompt(day, { rows, lines, moodLine, seen }) {
      const parts = []
      parts.push(`今天（${day}）快过完了。下面是今天你身边的聊天，还有你今天碰到的一些事。用不用随你，不用全塞进去。`)
      if (lines.length) parts.push(`--- 今天的聊天（${rows.length} 条，抽了一部分）---\n${lines.join('\n')}`)
      else parts.push('--- 今天几乎没人跟你说话，挺安静的。---')
      if (seen.length) {
        const list = seen.slice(0, 12).map((x) => `- ${clip(x.title || x.text, 120)}${x.meta?.url ? `（${clip(x.meta.platform || '', 20) || '链接'}）` : ''}`)
        parts.push(`--- 今天你看过这些 ---\n${list.join('\n')}`)
      }
      if (moodLine) parts.push(`--- 你现在的心情 ---\n${moodLine}`)
      parts.push([
        '现在写今天的日记。这本子只有你自己看，不会发给任何人，主人也不会自动读到。',
        '想写多长就写多长，想怎么排版就怎么排版，只写一句「今天没什么好说的」也行；不用写成总结报告，也不用说漂亮话。',
        '这里只有你，捡你真正在意的写：谁说了什么让你记着了、你当时怎么想的、有什么没说出的话、今天吃到或看到的东西。',
        '明天你可能就记不清这些细节了，所以写给明天那个记性不好的自己看。',
      ].join('\n'))
      return parts.join('\n\n')
    }

    async function run({ day = dayKey(), auto = false } = {}) {
      if (state.running) return { ok: false, message: '上一篇还在写，等一下' }
      const s = api.settings()
      state.running = true
      try {
        const dir = folder()
        mkdirSync(dir, { recursive: true })
        const material = collect(day)
        const text = String(await api.think(buildPrompt(day, material), { title: '写私人日记', timeoutMs: 300000 }) || '').trim()
        if (!text) return { ok: false, message: '这次她什么都没写' }

        // 同一天写多篇就往后编号，不覆盖旧的
        let file = join(dir, `${day}.md`)
        let n = 2
        while (existsSync(file)) file = join(dir, `${day}-${n++}.md`)

        const when = new Date()
        const md = [
          '---',
          `date: ${day}`,
          `mood: ${JSON.stringify(material.moodTag || '')}`,
          `chats: ${material.rows.length}`,
          `written: ${dayKey(when)} ${pad(when.getHours())}:${pad(when.getMinutes())}`,
          '---',
          '',
          text,
          '',
        ].join('\n')
        writeFileSync(file, md, 'utf8')

        // 日记放在数据目录外面时，镜像一份到备份区，换电脑可以带走
        if (s.mirror && !resolve(dir).startsWith(resolve(base))) {
          try {
            mkdirSync(mirrorDir, { recursive: true })
            writeFileSync(join(mirrorDir, basename(file)), md, 'utf8')
          } catch (e) { api.log.warn?.('私人日记：镜像失败 ' + e.message) }
        }

        const item = {
          day,
          file,
          chars: text.length,
          mood: clip(material.moodTag, 20),
          at: Date.now(),
          summary: clip(text, 120),
        }
        index = index.filter((x) => x.file !== file).concat([item]).sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.at) - String(b.at))
        saveIndex()

        // 回流记忆库：换身体（换会话 / 迁移）之后还能想起写过什么
        const memory = api.lazy('memory')
        quiet(() => memory?.add?.({
          text: `我在私人日记里写过（${day}）：${clip(text, 240)}`,
          importance: 0.55,
          tags: ['私人日记'],
          source: 'diary',
        }))

        state.last = day
        saveState()
        api.log.info?.(`私人日记：${auto ? '定时' : '手动'}写了 ${file}（${text.length} 字）`)
        return { ok: true, message: `日记写好了：${file}（${text.length} 字）`, file, chars: text.length }
      } catch (error) {
        api.log.error?.('私人日记：写失败 ' + (error?.message || error))
        return { ok: false, message: '写失败了：' + (error?.message || error) }
      } finally {
        state.running = false
      }
    }

    function nextText() {
      const s = api.settings()
      if (!s.on) return '自动写关着'
      const now = new Date()
      const [h, m] = String(s.at || '23:30').split(':').map((v) => Number(v) || 0)
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (nowMin >= h * 60 + m && state.last !== dayKey(now)) return '马上（今天还没写）'
      const target = new Date(now)
      target.setHours(h, m, 0, 0)
      if (target <= now) target.setDate(target.getDate() + 1)
      return `${dayKey(target)} ${pad(target.getHours())}:${pad(target.getMinutes())}`
    }

    // 每分钟看一眼：到点没写就写；早上顺手补昨天
    api.every(60_000, async () => {
      if (state.running) return
      const s = api.settings()
      if (!s.on) return
      const now = new Date()
      const today = dayKey(now)
      const [h, m] = String(s.at || '23:30').split(':').map((v) => Number(v) || 0)
      if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return
      if (state.last === today) return
      await run({ day: today, auto: true })
      if (s.catchUp) {
        const yesterday = shiftDay(today, -1)
        if (now.getHours() >= 7 && now.getHours() < 9 && !hasDiary(yesterday) && state.last !== yesterday) {
          await run({ day: yesterday, auto: true })
        }
      }
    }, '每天写私人日记')

    // QQ 里发 /日记 手动写一篇
    api.command({
      name: '日记',
      desc: '现在写一篇私人日记（只存在本地）',
      run: async () => (await run({ day: dayKey() })).message,
    })

    // 让她自己能翻旧日记：换身体之后靠这个把以前捡回来
    api.tool(({ chat, level }) => (level === 'full' && chat.kind !== 'system' ? api.defineTool({
      name: 'diary_read',
      description: '翻你自己的私人日记。不传参数看最近几篇；传 day 看某一天；传 query 按关键词找。想回忆以前的事时用。',
      properties: {
        day: { type: 'string', description: '哪一天，YYYY-MM-DD' },
        query: { type: 'string', description: '关键词，比如「蛋糕」「主人」' },
        limit: { type: 'number', description: '最多几篇，默认 3' },
      },
      execute: async ({ day, query, limit }) => {
        let list = index.slice()
        if (day) list = list.filter((x) => x.day === String(day).trim())
        if (query) {
          const q = String(query).trim()
          list = list.filter((x) => x.summary.includes(q) || quiet(() => readFileSync(x.file, 'utf8'))?.includes(q))
        }
        list = list.slice(-Math.max(1, Math.min(10, Number(limit) || 3))).reverse()
        if (!list.length) return { ok: true, message: day || query ? '没找到对应的日记。' : '还没写过日记。' }
        const out = list.map((x) => {
          const text = quiet(() => readFileSync(x.file, 'utf8')) || ''
          const { body } = parseMd(text)
          return `【${x.day}${x.mood ? ` · ${x.mood}` : ''}】\n${body.slice(0, 2000)}`
        })
        return { ok: true, message: out.join('\n\n---\n\n') }
      },
    }) : []))

    // 聊天时带上最近几篇的线索（只要开头，不塞整篇）
    api.context(() => {
      const s = api.settings()
      if (!s.inject || !index.length) return ''
      const recent = index.slice(-3).reverse()
      const list = recent.map((x) => `- ${x.day}${x.mood ? `（${x.mood}）` : ''}：${x.summary}`).join('\n')
      return `你写过这些私人日记（原文用 diary_read 能翻到）：\n${list}`
    })

    api.rule((kind) => (kind === 'private'
      ? '你有私人日记，写给你自己看的。想回忆以前的事、或者主人问起你哪天的事，可以用 diary_read 按日期或关键词翻；日记是私人的，主人要看再给他看。'
      : ''))

    // 面板接口
    api.route('/status', async () => ({
      ok: true,
      folder: folder(),
      mirrorDir,
      last: state.last,
      running: !!state.running,
      next: nextText(),
      count: index.length,
      items: index.slice(-20).reverse(),
    }))
    api.route('/run', async () => run({ day: dayKey() }))
    // 手写字体：面板用它画日记本上的字。字体是可选的，没有就退回系统楷体，面板照常能用。
    api.route('/hand.ttf', async (req, res) => {
      const buf = FONT_FILE ? quiet(() => readFileSync(FONT_FILE)) : null
      if (!buf) return { ok: false, message: '没有放字体文件（可选：assets/hand.ttf）' }
      try {
        res.statusCode = 200
        res.setHeader('content-type', 'font/ttf')
        res.setHeader('cache-control', 'public, max-age=604800')
        res.end(buf)
      } catch (error) {}
      return undefined
    })
    api.route('/read', async (req) => {
      // 面板里的 call('/read', { file }) 是 POST 带 JSON 体的，只读网址参数会永远拿不到 file
      let posted = {}
      try {
        const got = await api.core.http.body(req)
        if (got && typeof got === 'object') posted = got
      } catch (error) {}
      const file = String(api.core.http.query(req).file || posted.file || '')
      const hit = index.find((x) => x.file === file)
      if (!hit) return { ok: false, message: '没有这篇' }
      const text = quiet(() => readFileSync(hit.file, 'utf8'))
      if (text == null) return { ok: false, message: '文件读不到' }
      return { ok: true, ...hit, ...parseMd(text) }
    })
    api.route('/open', async () => {
      const dir = folder()
      try { mkdirSync(dir, { recursive: true }) } catch {}
      if (process.platform === 'win32') execFile('explorer.exe', [dir], () => {})
      else if (process.platform === 'darwin') execFile('open', [dir], () => {})
      else execFile('xdg-open', [dir], () => {})
      return { ok: true, message: dir }
    })
    api.route('/rescan', async () => { rescan(); return { ok: true, count: index.length } })

    return { run, folder, list: () => index.slice() }
  },
}
