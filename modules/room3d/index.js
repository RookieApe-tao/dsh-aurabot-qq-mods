// 3D 房间（Aurabot 原生）：服务 room3d 的 3D 页面、资产和状态，不再经过 AstrBot。
// 页面/代码随模块分发；动作素材（.webm，50MB+）**不进模块包**，运行时从素材仓
// （roomAssetUrl 设置，默认 github.com/RookieApe-tao/room3d-assets）自动下载落位到
// dataDir/assets/（pet 素材包同款模式）；缺包不炸，每 10 分钟兜底重试，面板可手动重下。
// 旧版把素材放模块目录 assets/ 的，启动时直接搬进 dataDir，不用重新下载。
// 状态读写在本模块的 dataDir 下（模块目录禁写，会被 3 秒扫描触发重载）。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, renameSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { join, dirname, sep, basename } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const ASSET_CHECK_MS = 10 * 60 * 1000 // 素材缺失时的兜底轮询间隔
const ASSET_MAX_BYTES = 256 * 1024 * 1024 // 素材包大小上限（现在约 52MB，留足余量）
// 明文 http 只放行本机回环（自测/本地镜像用），公网一律 https
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0']

const MIME = {
  '.webm': 'video/webm',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
}

export default {
  id: 'room3d',
  name: '房间',
  version: '1.0.4',
  api: 1,
  description: '给她一个自己的 3D 房间：屋里空着，只有她一个人（大肥鱼），家具自己摆；她看得见自己在哪。',
  panel: 'panel.js',
  defaults: {
      perception: true,
    roomAssetUrl: 'https://github.com/RookieApe-tao/room3d-assets/releases/download/v1/room3d-assets.zip',
  },
  settings: [
    { key: 'perception', label: '每轮让她知道自己在房间哪儿（关掉省 token）', type: 'switch' },
    { key: 'roomAssetUrl', label: '动作素材包下载地址', type: 'text', hint: '动作视频（.webm）zip 直链，模块启动发现缺素材时自动下载落位（国内网络可换 Gitee 等镜像直链）。zip 里素材要放在文件夹里（archive 自带的单层仓库目录会自动剥）' },
  ],
  setup(api) {
    const dir = api.dir
    // 状态不能再放在模块目录里：Aurabot 每 3 秒扫一次模块目录，任何文件变动都会
    // 触发「模块文件改了，重新加载」。3D 页面又在不停写世界/相机状态，
    // 于是变成 写一次 → 重载一次 → 页面重连再写 → 一直刷新。
    // 搬到 modules-data/room3d/，模块目录就永远是静的。
    const stateDir = api.dataDir()
    const legacyStateDir = join(dir, 'state')
    if (existsSync(legacyStateDir)) {
      try {
        const migrated = readdirSync(stateDir)
        if (!migrated.length) {
          for (const name of readdirSync(legacyStateDir)) {
            const from = join(legacyStateDir, name)
            try {
              if (statSync(from).isFile()) copyFileSync(from, join(stateDir, name))
            } catch {
              // 单个文件搬不动就跳过
            }
          }
        }
      } catch {
        // 搬不了就用空状态重来
      }
    }
    const http = api.core.http
    const roomHooks = api.__roomTestHooks || {} // 测试注入 fake fetchZip，不打真网络

    // ---------- 动作素材：不进模块包，运行时下载落位（pet 素材包同款模式） ----------
    // 模块包里只带代码 + vendor（three.js 等小文件）；106 个动作视频（50MB+）按仓库惯例
    // 放独立素材仓，插件启动发现缺素材自动下载到 dataDir/assets/。失败不炸（页面只是
    // 没有动作可放），走 every 兜底轮询重试；地址可在面板换镜像。
    // zip 内容约定：素材放**文件夹**里（archive 自带的 <仓库名>-<分支>/ 顶层目录会自动剥）。
    const assetsDir = api.dataDir('assets')
    const legacyAssetsDir = join(dir, 'assets')
    const webmOf = (base) => {
      try {
        if (!existsSync(base)) return []
        return readdirSync(base).filter((n) => n.toLowerCase().endsWith('.webm'))
      } catch { return [] }
    }
    // 素材齐不齐：dataDir 里至少有一个正常文件名的 .webm（带反斜杠的旧版错误落位不算）。
    const assetsReady = () => webmOf(assetsDir).some((n) => !n.includes('\\'))
    // 旧版解压 Windows 生成的 zip 时没把反斜杠归一成目录分隔符，素材会落成
    // 「assets/room3d-assets\待机呼吸休闲.webm」这种字面文件名；页面按正常名字取不到，
    // 角色就只剩阴影和名字标签。启动时把这类存量文件改名修正，不用重新下载。
    const assetFileName = (name) => basename(String(name || '').replace(/\\/g, '/'))
    function repairFlatAssetNames() {
      let fixed = 0
      try {
        for (const name of webmOf(assetsDir)) {
          const clean = assetFileName(name)
          if (!clean || clean === name) continue
          try { renameSync(join(assetsDir, name), join(assetsDir, clean)); fixed++ } catch {}
        }
      } catch {}
      if (fixed) api.log.info(`房间：修正了 ${fixed} 个旧版错误命名的动作素材`)
      return fixed
    }
    // 旧版把素材放模块目录的：直接搬进 dataDir（同盘复制几十 MB 也要几秒，但比重新下载强）
    const migrateLegacyAssets = () => {
      const old = webmOf(legacyAssetsDir)
      if (!old.length || assetsReady()) return 0
      try { mkdirSync(assetsDir, { recursive: true }) } catch { return 0 }
      let moved = 0
      for (const name of old) {
        try { copyFileSync(join(legacyAssetsDir, name), join(assetsDir, name)); moved++ } catch {}
      }
      if (moved) api.log.info(`房间：旧版模块目录里的 ${moved} 个动作素材已搬进数据目录 assets/`)
      return moved
    }
    // ---- 纯 JS zip 解压（存储/deflate 两种压缩法；zip-slip 防护；符号链接条目跳过）----
    function unzipTo(zip, destDir) {
      const u32 = (o) => zip.readUInt32LE(o)
      const u16 = (o) => zip.readUInt16LE(o)
      // 从尾部往前找 EOCD（0x06054b50），兼容最长 64KB 的 zip 注释区
      let eocd = -1
      for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (u32(i) === 0x06054b50) { eocd = i; break }
      }
      if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾标记）')
      const count = u16(eocd + 10)
      let ptr = u32(eocd + 16)
      for (let n = 0; n < count; n++) {
        if (u32(ptr) !== 0x02014b50) throw new Error(`zip 目录损坏（条目 ${n}）`)
        const method = u16(ptr + 10)
        const csize = u32(ptr + 20)
        const nameLen = u16(ptr + 28)
        const extraLen = u16(ptr + 30)
        const commentLen = u16(ptr + 32)
        const externAttr = u32(ptr + 38)
        const localOff = u32(ptr + 42)
        // Windows 资源管理器/部分打包工具生成的 zip 用反斜杠当目录分隔符；统一归一成 /，
        // 否则在 Linux/macOS 上会被当成文件名的一部分，素材落位后页面永远 404（#18 影子）。
        const name = zip.toString('utf8', ptr + 46, ptr + 46 + nameLen).replace(/\\/g, '/')
        ptr += 46 + nameLen + extraLen + commentLen
        if (name.endsWith('/')) { mkdirSync(join(destDir, name), { recursive: true }); continue }
        // 符号链接条目直接跳过。判据看 externalAttr 高 16 位（Unix st_mode）的类型位：
        // S_IFLNK=0o120000；别用 externAttr>>>31——普通文件 0o100644 最高位同样是 1。
        if (((externAttr >>> 16) & 0o170000) === 0o120000) continue
        const target = join(destDir, name)
        if (target !== destDir && !target.startsWith(destDir + sep)) throw new Error(`zip 里的可疑路径：${name}`) // 防 zip-slip
        if (u32(localOff) !== 0x04034b50) throw new Error(`zip 局部头损坏：${name}`)
        const dataOff = localOff + 30 + u16(localOff + 26) + u16(localOff + 28)
        const data = method === 0 ? Buffer.from(zip.subarray(dataOff, dataOff + csize)) : inflateRawSync(zip.subarray(dataOff, dataOff + csize))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, data)
      }
    }
    function assertDownloadUrl(url) {
      let u
      try { u = new URL(String(url)) } catch { throw new Error(`下载地址不是合法 URL：${String(url).slice(0, 120)}`) }
      if (u.protocol === 'https:') return u
      const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
      if (u.protocol === 'http:' && (LOOPBACK_HOSTS.includes(host) || host === '::1')) return u
      throw new Error(`拒绝从明文 http 下载（${u.protocol}//${u.hostname}）：请把镜像地址改成 https，或改用本机镜像`)
    }
    async function fetchZipTo(url, file) {
      assertDownloadUrl(url)
      const fetchZip = roomHooks.fetchZip || ((u) => fetch(u, { signal: AbortSignal.timeout(60_000) }))
      const res = await fetchZip(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}（${url}）`)
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase()
      if (contentType.startsWith('text/html')) throw new Error(`下载地址返回的是网页而不是 zip（${url}）；请检查地址是否失效或被登录页拦截`)
      const declared = Number(res.headers?.get?.('content-length') || 0)
      if (declared > ASSET_MAX_BYTES) throw new Error(`响应过大（${declared} 字节 > 上限 ${ASSET_MAX_BYTES}）`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > ASSET_MAX_BYTES) throw new Error(`下载内容过大（${buf.length} 字节 > 上限 ${ASSET_MAX_BYTES}）`)
      writeFileSync(file, buf)
      return buf
    }
    /** 在解压暂存目录里找素材根（含 .webm 的那一层），最多往下三层。找不到返回 null。 */
    function findAssetRoot(stage) {
      const hasWebm = (d) => webmOf(d).length > 0
      const subDirs = (d) => {
        try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d, e.name)) } catch { return [] }
      }
      if (hasWebm(stage)) return stage
      for (const d1 of subDirs(stage)) {
        if (hasWebm(d1)) return d1
        for (const d2 of subDirs(d1)) if (hasWebm(d2)) return d2
        for (const d2 of subDirs(d1)) for (const d3 of subDirs(d2)) if (hasWebm(d3)) return d3
      }
      return null
    }
    let assetDownloading = false // 并发闸：自动轮询 + 手动重下同时触发时不重复下
    // 诊断信息：面板/健康检查能看到「为什么没有影子之外的东西」。
    const assetStatus = { lastError: '', lastErrorAt: 0, lastSuccessAt: 0, lastUrl: '', lastCount: 0 }
    const assetHint = () => assetsReady()
      ? ''
      : '素材包还没就绪：请确认网络能访问素材地址；GitHub 直连失败时可在模块设置里把「动作素材包下载地址」换成 https 镜像直链，再点「重新下载素材」。'
    /**
     * 下载并落位动作素材包。
     * @param {boolean} force true = 已有素材也重新下载（面板手动重下）；false = 只在缺素材时下载
     * @returns {Promise<{ok:boolean, skipped?:boolean, count?:number, message:string}>}
     */
    async function ensureAssets(force = false) {
      if (assetDownloading) return { ok: false, message: '素材包正在下载中，别急' }
      if (!force && assetsReady()) return { ok: true, skipped: true, message: '动作素材已就位，不用下载' }
      const url = String((api.settings() || {}).roomAssetUrl || '').trim()
      if (!url) return { ok: false, message: '没有配置素材包下载地址（面板「房间」设置里填）', hint: assetHint() }
      assetStatus.lastUrl = url
      assetDownloading = true
      const stage = api.dataDir('assets-staging') // 解压暂存：校验通过才落位，失败不污染 assets/
      try {
        const zip = await fetchZipTo(url, api.dataDir('assets-download.zip'))
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        mkdirSync(stage, { recursive: true })
        unzipTo(zip, stage)
        const root = findAssetRoot(stage)
        if (!root) throw new Error('zip 里找不到 .webm 素材（内容结构不对：素材要放在文件夹里，如 room3d-assets/）')
        mkdirSync(assetsDir, { recursive: true })
        let copied = 0
        for (const f of webmOf(root)) {
          try { copyFileSync(join(root, f), join(assetsDir, f)); copied++ } catch {}
        }
        if (copied === 0) throw new Error('素材文件夹里没有 .webm 文件')
        api.log.info(`房间：动作素材包已下载落位（${copied} 个视频 → assets/）`)
        assetStatus.lastError = ''
        assetStatus.lastSuccessAt = Date.now()
        assetStatus.lastCount = copied
        registerAssetRoutes()
        return { ok: true, count: copied, message: `素材包下载完成（${copied} 个动作视频）` }
      } catch (error) {
        const msg = `素材包下载失败：${String(error?.message || error).slice(0, 200)}`
        assetStatus.lastError = msg
        assetStatus.lastErrorAt = Date.now()
        api.log.warn(msg)
        return { ok: false, message: msg, hint: assetHint() }
      } finally {
        assetDownloading = false
        try { rmSync(stage, { recursive: true, force: true }) } catch {}
        try { unlinkSync(api.dataDir('assets-download.zip')) } catch {}
      }
    }
    // 启动：先搬旧版模块目录里的存量素材（免下载），还缺才在 5 秒后下载 + 每 10 分钟兜底查。
    // 测试环境（注入了 __roomTestHooks）一律跳过——测试不打真网络，靠手动调 ensureAssets + fake fetchZip。
    repairFlatAssetNames()
    if (!roomHooks.skipAutoAssets) {
      migrateLegacyAssets()
      if (!assetsReady()) {
        const kick = setTimeout(() => { ensureAssets().catch(() => {}) }, 5_000)
        kick.unref?.()
        api.every(ASSET_CHECK_MS, () => { if (!assetsReady()) ensureAssets().catch(() => {}) }, '素材包自动落位')
      }
    }

    const send = (res, code, body, type) => http.send(res, code, body, type)
    const sendFile = (res, file, type) => {
      try {
        if (!existsSync(file)) return send(res, 404, 'not found', 'text/plain; charset=utf-8')
        send(res, 200, readFileSync(file), type || MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream')
      } catch (error) {
        send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    }
    const readJson = (name, fallback) => {
      try {
        const file = join(stateDir, name)
        if (!existsSync(file)) return fallback
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return fallback
      }
    }
    const writeJson = (name, value) => {
      const file = join(stateDir, name)
      writeFileSync(file, JSON.stringify(value, null, 0), 'utf8')
    }
    const bodyOf = async (req) => {
      try { return (await http.body(req)) || {} } catch { return {} }
    }
    // ---- 把房间翻译成人话，让她「看得见」 ----
    const ACTOR_NAME = { xiaoyu: '你' }
    const DISPLAY_NAME = { xiaoyu: '大肥鱼' }
    const SPOT_NAME = {
      sofa: '客厅沙发', bed: '主卧床边', kitchen: '厨房', desk: '书房', balcony: '阳台', door: '玄关',
    }
    const FURN_NAME = {
      sofa3: '三人沙发', sofa2: '双人沙发', chair1: '单人沙发', table_round: '圆茶几', table_sq: '方茶几',
      tv_cab: '电视柜', tv75: '75 寸电视', rug: '地毯', floorlamp: '落地灯', shelf: '书架',
      bed_double: '双人床', bed_single: '单人床', nightstand: '床头柜', wardrobe: '衣柜', desk: '书桌',
      officechair: '电脑椅', tablelamp: '台灯', counter: '橱柜台面', stove: '灶台', sink: '水槽',
      fridge: '冰箱', diningtable: '餐桌', diningchair: '餐椅', plant: '盆栽', mirror: '落地镜',
      aquarium: '鱼缸', shoecab: '鞋柜', washer: '洗衣机', cat_tower: '猫爬架', curtain: '窗帘',
      pendant: '吊灯', wall_clock: '挂钟', toybox: '玩具箱', cushion_pile: '抱枕堆',
    }
    const spotName = (id) => SPOT_NAME[id] || String(id || '').trim() || '屋里'
    const actorName = (id) => ACTOR_NAME[id] || String(id || '')
    /** 按当前钟点给「光线 + 窗外」，跟 AstrBot 那版一致。 */
    const skyOf = (hourRaw) => {
      const hour = Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : new Date().getHours()
      if (hour >= 5 && hour < 11) return { when: '早上', lamp: '屋里的灯还亮着，暖黄色的', sky: '天刚亮，太阳还低' }
      if (hour >= 11 && hour < 16) return { when: hour < 13 ? '中午' : '下午', lamp: '屋里的灯还亮着，暖黄色的', sky: '白天，阳光很亮' }
      if (hour >= 16 && hour < 18) return { when: '下午偏晚', lamp: '屋里的灯还亮着，暖黄色的', sky: '太阳开始往下沉，海面泛金' }
      if (hour >= 18 && hour < 20) return { when: '傍晚', lamp: '屋里的灯还亮着，暖黄色的', sky: '天边压着晚霞，海是暗金色' }
      return { when: '夜里', lamp: '灯已经关了，屋里有点暗', sky: '深蓝一片，只有月光' }
    }
    /** 家具清单 → 「三人沙发、圆茶几、地毯 等 12 件」这种。 */
    const furnitureText = (items) => {
      const list = Array.isArray(items) ? items : []
      if (!list.length) return '屋里还没摆什么家具'
      const seen = []
      for (const it of list) {
        const raw = String(it?.type || it?.id || '').replace(/_\d+$/, '')
        const name = FURN_NAME[raw] || FURN_NAME[String(it?.kind || '')] || ''
        if (name && !seen.includes(name)) seen.push(name)
      }
      if (!seen.length) return `摆着 ${list.length} 件家具`
      return `${seen.slice(0, 6).join('、')}${seen.length > 6 || list.length > 6 ? ' 等' : ''} ${list.length} 件家具`
    }
    const snapshotOf = () => {
      const s = readJson('room-state.json', {})
      const f = readJson('furniture.json', { items: [], walls: [], cats: [] })
      const cats = readJson('cats-live.json', { cats: [] }).cats || f.cats || []
      return { s, f, cats }
    }
    /** 她在哪 —— 一句话，位置事实。 */
    const peopleText = ({ s }) => {
      const me = s?.xiaoyu
      if (!me?.spot) return '你现在在屋里，没说具体在哪'
      const mins = Math.max(0, Math.round((Date.now() / 1000 - Number(me.since || 0)) / 60))
      const reason = String(me.reason || '').trim()
      return `你现在在${spotName(me.spot)}（${mins} 分钟${reason ? `，${reason}` : ''}）`
    }
    const catsText = ({ cats }) => (cats.length ? `屋里有 ${cats.length} 只猫` : '屋里没有猫')
    /** 完整画面：她「抬头看一眼」会看到的东西。 */
    const roomView = () => {
      const snap = snapshotOf()
      const light = skyOf()
      return [
        '（你抬头环视了一圈家里，看到的是这样的画面）',
        `光线：现在是${light.when}，${light.lamp}。`,
        `屋里：${furnitureText(snap.f.items)}，隔断 ${(snap.f.walls || []).length} 面。`,
        `窗外：${light.sky}。`,
        `你：${peopleText(snap)}。`,
        catsText(snap) + '。',
      ].join('\n')
    }
    /** 每轮都带在身上的那几行：位置事实为主，别太啰嗦。 */
    const situationText = () => {
      const snap = snapshotOf()
      const light = skyOf()
      return [
        '【你在自己家里，一个 3D 小房间】',
        `现在是${light.when}，${light.lamp}；窗外是${light.sky}。`,
        `${peopleText(snap)}。`,
        '位置随时会变（你自己走或者被安排），问到就按上面说，别说「瞬移」「怎么一下就」；',
        '跟你上一句说的不一样，就当自己刚走过去，一句带过。屋里/窗外具体什么样，用 look_at_room 看，别用 shell、curl 读源码去猜。',
      ].join('\n')
    }
    const ROOM_KEYWORDS = ['窗外', '房间', '在家', '在干嘛', '在干什么', '你在哪', '看看家', '看家', '屋里', '房间里', '你在做', '躺着', '床上', '窗边', '书桌', '地毯', '客厅', '厨房', '阳台', '家']

    api.tool(({ chat, sessionId }) => {
      if (chat.kind === 'system') return []
      return [
        api.defineTool({
          name: 'look_at_room',
          description: '抬头看一眼自己现在的房间和窗外：光线、家具、猫、你在哪。回答时用「我看见……」，不要说数据/系统/接口。',
          properties: {},
          execute: async () => ({ ok: true, message: roomView() }),
        }),
        api.defineTool({
          name: 'go_room_spot',
          description: '让自己在房间里走到某个位置，比如 sofa、desk、kitchen、balcony、bed、door。',
          properties: { spot: { type: 'string', description: '目标位置 id' } },
          required: ['spot'],
          execute: async ({ spot }) => {
            if (!api.core.hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让她换位置' }
            const id = String(spot || '').trim().slice(0, 24)
            if (!id) return { ok: false, message: 'spot 是空的' }
            const s = readJson('room-state.json', { ok: true, xiaoyu: {}, log: [] })
            s.xiaoyu = { ...(s.xiaoyu || {}), spot: id, since: Math.floor(Date.now() / 1000) }
            writeJson('room-state.json', s)
            return { ok: true, message: `走到 ${id}（${spotName(id)}）了` }
          },
        }),
      ]
    })
    api.rule('你会看房间：有人问「你在哪 / 屋里什么样 / 窗外」时用 look_at_room；主人让你换位置时用 go_room_spot。位置以【你在自己家里】那段为准。')

    // 每轮把房间带进她的视野里（只加在用户消息侧，不动系统提示，保住前缀缓存）
    const perceptionOn = () => {
      try {
        const s = api.settings() || {}
        if (s.perception === false) return false
      } catch {
        // 没有设置项就按文件走
      }
      return readJson('perception.json', { enabled: true }).enabled !== false
    }
    api.on('prompt', async (content, info) => {
      try {
        const chat = info?.chat
        if (!chat || chat.kind === 'system' || !Array.isArray(content)) return content
        if (!perceptionOn()) return content
        let block = situationText()
        // 问到房间/窗外，就顺手把完整画面也给她，省得非得调工具
        const asked = ROOM_KEYWORDS.some((k) => String(info?.queryText || '').includes(k))
        if (asked) block += '\n' + roomView()
        return [{ type: 'text', text: block }, ...content]
      } catch {
        return content
      }
    })

    // 静态页面与资产
    api.route('/page', async (req, res) => {
      try {
        const html = readFileSync(join(dir, 'lib', 'index3d.html'), 'utf8')
        send(res, 200, html, 'text/html; charset=utf-8')
      } catch (error) {
        send(res, 500, String(error.message || error), 'text/plain; charset=utf-8')
      }
    })

    // 静态路由：vendor（three.js 等）永远在模块目录；动作素材在 dataDir/assets/，
    // 没就绪时暂用旧版模块目录 assets/ 兜底。落位/重下后调 registerAssetRoutes() 重挂一遍。
    const assetsSourceDir = () => (assetsReady() ? assetsDir : legacyAssetsDir)
    function registerAssetRoutes() {
      for (const [sub, base] of [['vendor', join(dir, 'lib', 'vendor')], ['assets', assetsSourceDir()]]) {
        if (!existsSync(base)) continue
        for (const name of readdirSync(base)) {
          const file = join(base, name)
          try { if (!statSync(file).isFile()) continue } catch { continue }
          const type = MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream'
          const handler = async (req, res) => sendFile(res, file, type)
          api.route('/' + sub + '/' + name, handler)
          const encoded = encodeURIComponent(name)
          if (encoded !== name) api.route('/' + sub + '/' + encoded, handler)
        }
      }
    }
    registerAssetRoutes()

    // 手动重下素材包（POST，body 留空 {} 即可；面板/调试用）
    api.route('/api/room/fetch-assets', async (req) => {
      if (req.method !== 'POST') return { ok: false, err: 'POST only' }
      return ensureAssets(true)
    })

    // 读接口
    api.route('/api/room/state', async () => {
      const s = readJson('room-state.json', { ok: true, xiaoyu: { spot: 'sofa', action: 'idle' }, log: [] })
      if (!Array.isArray(s.log)) s.log = []
      return s
    })
    api.route('/api/room/anims', async () => {
      try {
        const names = readdirSync(assetsSourceDir())
          .filter((n) => n.toLowerCase().endsWith('.webm'))
          .map((n) => n.slice(0, -5))
          .filter((n) => !n.includes('走路') && !n.includes('待机'))
        return { ok: true, anims: names }
      } catch (error) {
        return { ok: false, err: String(error.message || error) }
      }
    })
    api.route('/api/room/actors', async () => readJson('actors.json', { ok: true, absent: [] }))

    api.route('/api/room/cats-live', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        const cats = Array.isArray(b.cats) ? b.cats.slice(0, 60) : []
        writeJson('cats-live.json', { ok: true, cats, at: Date.now() / 1000 })
        return { ok: true }
      }
      return readJson('cats-live.json', { ok: true, cats: [] })
    })
    api.route('/api/room/floor', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        writeJson('floor.json', { ok: true, id: String(b.id || '').slice(0, 40) })
        return { ok: true }
      }
      return readJson('floor.json', { ok: true, id: 'pastel_check' })
    })
    api.route('/api/room/furniture', async (req, res) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        if (!Array.isArray(b.items)) return { ok: false, err: 'items must be a list' }
        const cur = join(stateDir, 'furniture.json')
        try {
          if (existsSync(cur)) {
            const prev = readJson('furniture.json', null)
            if (prev && (prev.items?.length || prev.walls?.length || prev.cats?.length)) copyFileSync(cur, join(stateDir, 'furniture.prev.json'))
          }
        } catch {}
        writeJson('furniture.json', {
          ok: true,
          items: b.items.slice(0, 600),
          walls: (Array.isArray(b.walls) ? b.walls : []).slice(0, 400),
          cats: (Array.isArray(b.cats) ? b.cats : []).slice(0, 60),
          wallOpacity: Number(b.wallOpacity) || 26,
        })
        return { ok: true, count: b.items.length }
      }
      const q = new URL(req.url, 'http://x').searchParams
      return readJson(q.get('prev') ? 'furniture.prev.json' : 'furniture.json', { ok: true, items: [] })
    })
    api.route('/api/room/camera', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        if (Array.isArray(b.pos) && b.pos.length === 3 && Array.isArray(b.target) && b.target.length === 3) {
          const pos = b.pos.map(Number)
          const target = b.target.map(Number)
          writeJson('camera.json', { ok: true, pos, target })
          return { ok: true }
        }
        return { ok: false, err: 'bad payload' }
      }
      return readJson('camera.json', { ok: false })
    })
    api.route('/api/room/layout', async () => {
      const s = readJson('room-state.json', {})
      return { ok: true, layout: s.layout || {} }
    })
    api.route('/api/room/shot', async (req, res) => {
      for (const name of ['room-shot.jpg', 'room-shot.png']) {
        const file = join(stateDir, name)
        if (existsSync(file)) return sendFile(res, file, name.endsWith('.png') ? 'image/png' : 'image/jpeg')
      }
      send(res, 404, 'no shot', 'text/plain; charset=utf-8')
    })
    api.route('/health', async () => {
      const s = readJson('room-state.json', {})
      return {
        ok: true,
        source: 'aurabot-room3d',
        spot: s.xiaoyu?.spot || '',
        assets: {
          ready: assetsReady(),
          count: assetsReady() ? webmOf(assetsDir).length : 0,
          downloading: assetDownloading,
          url: String((api.settings() || {}).roomAssetUrl || ''),
          lastError: assetStatus.lastError,
          lastErrorAt: assetStatus.lastErrorAt,
          lastSuccessAt: assetStatus.lastSuccessAt,
          hint: assetHint(),
        },
      }
    })

    // 调试用：看看她现在「眼里」是什么样（跟注入到提示词里的那几行一致）
    api.route('/situation', async () => ({
      ok: true,
      enabled: perceptionOn(),
      text: situationText(),
      view: roomView(),
    }))

    // 觉得太费 token 就关掉：POST { enabled: false }
    api.route('/perception', async (req) => {
      if (req.method === 'POST') {
        const b = await bodyOf(req)
        writeJson('perception.json', { enabled: b.enabled !== false })
      }
      return { ok: true, enabled: perceptionOn() }
    })

    // 写接口：移动、日志、事件
    api.route('/api/room/move', async (req) => {
      const b = await bodyOf(req)
      const who = 'xiaoyu'
      const spot = String(b.spot || 'sofa').slice(0, 24)
      const s = readJson('room-state.json', { ok: true, xiaoyu: {}, log: [] })
      s[who] = { ...(s[who] || {}), spot }
      writeJson('room-state.json', s)
      return { ok: true, spot }
    })
    api.route('/api/room/log', async (req) => {
      const b = await bodyOf(req)
      const who = 'xiaoyu'
      const text = String(b.text || '').slice(0, 60)
      if (text) {
        const s = readJson('room-state.json', { ok: true, xiaoyu: {}, log: [] })
        if (!Array.isArray(s.log)) s.log = []
        s.log.push({ who, text, t: Math.floor(Date.now() / 1000) })
        s.log = s.log.slice(-50)
        writeJson('room-state.json', s)
      }
      return { ok: true }
    })
    api.route('/api/room/event', async (req) => {
      const b = await bodyOf(req)
      const what = String(b.what || '').slice(0, 80)
      if (!what) return { ok: false, err: 'empty' }
      const ev = { who: String(b.who || '大肥鱼').slice(0, 12), what, where: String(b.where || '').slice(0, 24), t: Math.floor(Date.now() / 1000) }
      const items = readJson('room-events.json', [])
      if (!Array.isArray(items)) return { ok: true, mem: false }
      items.push(ev)
      writeJson('room-events.json', items.slice(-200))
      return { ok: true, mem: false }
    })
    api.route('/api/room/wish', async () => ({ ok: true, changed: 0, layout: {} }))
    api.route('/api/room/auto', async (req) => {
      const b = await bodyOf(req)
      const s = readJson('room-state.json', { ok: true, xiaoyu: {}, log: [] })
      s.auto = Boolean(b.on ?? true)
      writeJson('room-state.json', s)
      return { ok: true, autoWalk: s.auto }
    })
    api.route('/api/room/frame', async (req) => {
      const b = await bodyOf(req)
      const img = String(b.image || '')
      if (!img.startsWith('data:image')) return { ok: false, err: 'no image' }
      const [head, b64] = img.split(',')
      const ext = head.includes('png') ? 'png' : 'jpg'
      const data = Buffer.from(b64 || '', 'base64')
      if (data.length >= 500 && data.length <= 12 * 1024 * 1024) writeFileSync(join(stateDir, `room-shot.${ext}`), data)
      return { ok: true }
    })
  },
}
