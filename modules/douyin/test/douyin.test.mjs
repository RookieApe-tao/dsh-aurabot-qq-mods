// 抖音：链接 / 接口数据解析、给她看的摘要、选标签页、配置迁移；用假的抖音网页测刷一轮（按 id 点赞评论、上限、试运行、验证码停手、
// 在 QQ 上分享）、主人让她点赞评论、打开面板不启动浏览器（#4）。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let site
let browser
let duty
let normalize
let DOUYIN_PERM_KEYS
let mergeFromPanel

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-douyin-'))
  site = await import('../lib/site.mjs')
  browser = await import('../lib/browser.mjs')
  duty = await import('../lib/duty.mjs')
  ;({ normalize, mergeFromPanel } = globalThis.aurabot.lib('core/config.js'))
  ;({ DOUYIN_PERM_KEYS } = globalThis.aurabot.lib('chat/access.js'))
})

// 和网页端推荐接口一样形状的一条视频
const aweme = (id, o = {}) => ({
  aweme_id: id,
  desc: `视频${id}的文案 #猫咪 #日常`,
  item_title: `视频${id}`,
  author: { nickname: '作者' + id, sec_uid: 'MS4w' + id },
  statistics: { digg_count: 123456, comment_count: 789, share_count: 10, collect_count: 5 },
  video: { duration: 61000 },
  text_extra: [{ hashtag_name: '猫咪' }, { hashtag_name: '日常' }],
  video_tag: [{ tag_name: '动物' }, { tag_name: '萌宠' }],
  ...o,
})

test('解析：认视频链接 / modal_id / 图文 / 短链 / 纯 id', () => {
  assert.deepEqual(site.findAwemeId('看这个 https://www.douyin.com/video/7675305737601436971?x=1'), { awemeId: '7675305737601436971' })
  assert.deepEqual(site.findAwemeId('https://www.douyin.com/jingxuan?modal_id=7675305737601436971'), { awemeId: '7675305737601436971' })
  assert.deepEqual(site.findAwemeId('https://www.douyin.com/note/7675305737601436971'), { awemeId: '7675305737601436971' })
  assert.deepEqual(site.findAwemeId('7.43 复制打开抖音 https://v.douyin.com/iAbC-12/ 哈哈'), { short: 'https://v.douyin.com/iAbC-12/' })
  assert.deepEqual(site.findAwemeId('7675305737601436971'), { awemeId: '7675305737601436971' })
  assert.equal(site.findAwemeId('没有链接'), null)
})

test('解析：短链跟着跳转拿到视频 id', async () => {
  const hops = { 'https://v.douyin.com/abc/': 'https://www.iesdouyin.com/share/video/7675305737601436971/?region=CN' }
  const fake = async (url) => ({ headers: { get: (k) => (k === 'location' ? hops[url] || null : null) } })
  assert.equal(await site.resolveShort('https://v.douyin.com/abc/', fake), '7675305737601436971')
  assert.equal(await site.resolveShort('https://v.douyin.com/none/', fake), '')
})

test('解析：接口里的视频 → 标题、分类、抖音的内容摘要、分段；广告和直播丢掉', () => {
  const v = site.normalizeAweme(aweme('7000000000000000001', { chapter_abstract: '讲了一只猫学会开门的过程。', chapter_list: [{ desc: '开头', detail: '' }, { desc: '学开门', detail: '猫试了三次' }] }))
  assert.equal(v.title, '视频7000000000000000001')
  assert.equal(v.author, '作者7000000000000000001')
  assert.equal(v.duration, 61)
  assert.deepEqual(v.category, ['动物', '萌宠'])
  assert.deepEqual(v.tags, ['猫咪', '日常'])
  assert.equal(v.summary, '讲了一只猫学会开门的过程。')
  assert.deepEqual(v.chapters, ['开头', '学开门：猫试了三次'])
  assert.equal(site.normalizeAweme(aweme('7000000000000000002', { is_ads: true })), null)
  assert.equal(site.normalizeAweme(aweme('7000000000000000003', { cell_room: {} })), null)
  assert.equal(site.normalizeAweme({ desc: '没 id' }), null)
  // 没有 item_title 时用去掉话题的文案
  assert.equal(site.normalizeAweme(aweme('7000000000000000004', { item_title: '' })).title, '视频7000000000000000004的文案')
})

test('解析：评论回复列表 → 从旧到新，带 uid / cid / 时间', () => {
  const rs = site.parseReplies({ comments: [
    { cid: '2', text: '后说的', user: { uid: 4182, nickname: '主人' }, create_time: 100, reply_id: '9', reply_to_reply_id: '8' },
    { cid: '1', text: '先说的', user: { uid: 7 }, create_time: 50 },
    { cid: '', text: '没 id', user: { uid: 1 }, create_time: 1 },
    { cid: '3', text: '', user: { uid: 1 }, create_time: 2 },
  ] })
  assert.deepEqual(rs.map((x) => [x.id, x.text]), [['1', '先说的'], ['2', '后说的']])
  assert.equal(rs[1].uid, '4182')
  assert.equal(rs[1].nickname, '主人')
  assert.equal(rs[1].replyId, '9')
  assert.equal(rs[1].replyToReplyId, '8')
  assert.equal(rs[1].at, 100000)
})

test('解析：热评按赞数排；给她看的摘要里有分类、摘要、文案、热评', () => {
  const cs = site.parseComments({ comments: [{ text: '一般', digg_count: 3, user: { nickname: 'a' } }, { text: '太可爱了', digg_count: 5000, user: { nickname: 'b' } }, { text: '', digg_count: 9 }] })
  assert.deepEqual(cs.map((c) => c.text), ['太可爱了', '一般'])
  const d = site.digestOf(site.normalizeAweme(aweme('7000000000000000001', { chapter_abstract: '猫学开门' })), cs)
  assert.match(d, /《视频7000000000000000001》 作者：作者7000000000000000001 {2}赞 12万/)
  assert.match(d, /分类：动物 \/ 萌宠/)
  assert.match(d, /内容摘要：猫学开门/)
  assert.match(d, /热评：\n {2}b：太可爱了（5000 赞）/)
})

test('浏览器：挑抖音标签页、多的抖音页要关掉；端口文件读不到返回 0', () => {
  const t = (id, url, type = 'page') => ({ id, url, type, webSocketDebuggerUrl: 'ws://x/' + id })
  const r = browser.pickPage([t('a', 'about:blank'), t('b', 'https://www.douyin.com/jingxuan'), t('c', 'https://www.douyin.com/video/1'), t('d', 'https://lf.example/x', 'iframe')])
  assert.equal(r.page.id, 'b')
  assert.deepEqual(r.extra.map((x) => x.id), ['c'])
  assert.equal(browser.pickPage([t('a', 'about:blank')]).page.id, 'a')
  const dir = mkdtempSync(join(tmpdir(), 'dy-port-'))
  assert.equal(browser.readPortFile(dir), 0)
  writeFileSync(join(dir, 'DevToolsActivePort'), '55110\n/devtools/browser/x\n')
  assert.equal(browser.readPortFile(dir), 55110)
  assert.equal(browser.findBrowser('C:\\nope\\msedge.exe', () => false), '')
})

test('配置：总开关默认关；只剩 4 项权限且默认仅主人；1.0.x 的私信等设置清掉、主人抖音号留着，shareOwner 上限迁到 share', () => {
  const c = normalize({})
  assert.equal(c.douyin.enabled, false)
  assert.deepEqual(c.douyin.caps, { like: 30, comment: 3, share: 5, atOwner: 3 })
  assert.deepEqual(DOUYIN_PERM_KEYS, ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm'])
  for (const k of DOUYIN_PERM_KEYS) assert.equal(c.profilePerms[k], 'owner')
  assert.equal(c.profilePerms.douyinDm, 'owner', '主动私信默认仅主人')
  const old = normalize({ douyin: { enabled: true, owner: { secUid: 'x', avatar: 'a.jpg' }, atOwnerOnLikeChance: 0.7, dmPollMinutes: 7, minimize: true, shareBias: 'off', caps: { like: 10, shareOwner: 2, dm: 5 } }, profilePerms: { douyinDm: 'all' } })
  assert.deepEqual(old.douyin.owner, { input: '', secUid: 'x', uid: '', nickname: '', confirmedInput: '' })
  assert.equal(old.douyin.atOwnerOnLikeChance, undefined)
  assert.equal(old.douyin.dmPollMinutes, 7, '看私信间隔这个设置又用上了，保留')
  assert.equal(old.douyin.shareBias, 'stingy')
  assert.deepEqual(old.douyin.caps, { like: 10, comment: 3, share: 2, atOwner: 3 })
  assert.equal(old.profilePerms.douyinDm, 'owner', '旧版 douyinDm 含义不同，老配置回到默认仅主人')
})

/** 假的抖音网页：记下每次点赞 / 评论落在哪个视频上。 */
function fakeSite({ feed = [], loggedIn = true, verify = '', likeError = null, commentError = null, liked = new Set(), mentionFails = false, shareFails = false, chat = [] } = {}) {
  const calls = { ensure: 0, watch: [], like: [], comment: [], share: [], feed: 0, dms: 0, dm: [], dmUid: '', dmSecUid: '', dmFail: 0, dmUncertain: 0, replies: [], replyList: [], commentFail: 0 }
  return {
    calls,
    ensure: async () => { calls.ensure++; return { ok: true } },
    self: async () => (loggedIn ? { secUid: 'MS4wSELF', nickname: '她的小号' } : null),
    verify: async () => verify,
    feed: async () => { calls.feed++; return calls.feed === 1 ? feed.map(site.normalizeAweme).filter(Boolean) : [] },
    detail: async (id) => site.normalizeAweme(aweme(id)),
    comments: async () => [{ name: '路人', text: '好看', likes: 10 }],
    watch: async (id) => { calls.watch.push(id) },
    like: async (id) => { if (likeError) throw likeError; calls.like.push(id); return liked.has(id) ? { ok: true, already: true } : { ok: true } },
    comment: async (id, text, o = {}) => {
      if (commentError) throw commentError
      if (calls.commentFail > 0) { calls.commentFail--; throw new Error('评论没发出去（模拟接口失败）') }
      if (o.at && mentionFails) throw Object.assign(new Error('@ 候选里没找到主人（可能互相没关注）'), { code: 'mention' })
      calls.comment.push(o.at ? [id, text, o.at] : [id, text])
      return { ok: true, atOwner: Boolean(o.at), cid: 'cid-' + id }
    },
    share: async (id, who) => { if (shareFails) throw Object.assign(new Error('分享面板里没找到主人（可能互相没关注、私信不通）'), { code: 'share' }); calls.share.push([id, who.secUid, who.nickname]); return { ok: true } },
    user: async (secUid) => ({ secUid, uid: '4182', nickname: '主人的新昵称', douyinId: 'master01' }),
    findByDouyinId: async (id) => { if (id !== 'master01') throw new Error('按抖音号没搜到这个人'); return { secUid: 'MS4wOWNER', uid: '4182', nickname: '主人小号', douyinId: 'master01' } },
    profileOf: async (link) => {
      const sec = String(link).match(/douyin\.com\/user\/(MS4w[\w-]+)/)?.[1] || (/^MS4w[\w-]+$/.test(String(link)) ? String(link) : '')
      if (sec) return { secUid: sec, uid: '4182', nickname: '主人的新昵称', douyinId: 'master01' }
      if (String(link).includes('master01')) return { secUid: 'MS4wOWNER', uid: '4182', nickname: '主人小号', douyinId: 'master01' }
      throw new Error('按抖音号没搜到这个人')
    },
    dms: async (uid) => { calls.dms++; calls.dmUid = uid; return chat.slice() },
    sendDm: async (text) => { if (calls.dmFail > 0) { calls.dmFail--; throw new Error('私信输入框点不进去') } calls.dm.push(text); return { ok: true } },
    dm: async (uid, text, opts = {}) => {
      calls.dmUid = uid; calls.dmSecUid = opts.secUid || ''
      if (calls.dmUncertain > 0) { calls.dmUncertain--; throw Object.assign(new Error('私信发送状态不确定'), { code: 'dm_uncertain' }) }
      calls.dm.push(text)
      return { ok: true }
    },
    replies: async (id, commentId) => { calls.replies.push([id, commentId]); return calls.replyList.slice() },
    loginStart: async () => ({ ok: true, loggedIn: false, shot: 'data:image/png;base64,QR' }),
    loginPoll: async () => ({ ok: true, loggedIn: true, me: { secUid: 'MS4wSELF', nickname: '她的小号' } }),
    show: async () => {},
    connected: () => false,
  }
}

let n = 0
function setup({ decisions = [], cfgOver = {}, douyinOver = {}, siteOpts = {}, settingsOver = {}, now, onWait = () => {}, owner, turn, commentTurn, proactive } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-douyin-' + n++ + '-'))
  const sent = []
  const events = []
  const prompts = []
  const hub = {
    runSystemTurn: async (name, title, prompt) => {
      prompts.push(prompt)
      if (turn && name === 'douyin-dm') return turn(prompt)
      if (commentTurn && name === 'douyin-comment') return commentTurn(prompt)
      return JSON.stringify(decisions)
    },
    sendText: async (chatId, text) => { sent.push([chatId, text]); return { message_id: 1 } },
    pushToSession: async (chat, content) => { pushed.push([chat.chatId, content[0].text]) },
  }
  const pushed = []
  const memory = { addEvent: (e) => events.push(e.text), add: (m) => events.push('记住:' + m.text) }
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', ...cfgOver, douyin: { enabled: true, perRun: 3, dwellMin: 3, dwellMax: 3, caps: { like: 30, comment: 1, share: 5 }, gate: { minWriteGapSec: 0, newAccountDays: 0 }, ...(owner ? { owner } : {}), ...douyinOver } })
  const fs = fakeSite({ feed: [aweme('7000000000000000001'), aweme('7000000000000000002', { is_ads: true }), aweme('7000000000000000003'), aweme('7000000000000000004')], ...siteOpts })
  const waits = []
  const owners = []
  const submitted = []
  // 传了 proactive 就装一个假治理面（旧主仓没有这一层时不传，走降级路径）
  const face = proactive ? { submit: async (args) => { submitted.push(args); return proactive(args) } } : undefined
  const settings = { ...settingsOver }
  const dy = duty.createDouyin({ getConfig: () => cfg, getSettings: () => settings, setOwner: (o) => { owners.push(o); cfg.douyin.owner = o }, hub, memory, log: { info() {}, warn() {}, debug() {} }, site: fs, wait: async (ms) => { waits.push(ms); onWait(ms) }, ...(face ? { proactive: face } : {}), ...(now ? { now } : {}) })
  return { dy, fs, hub, memory, sent, events, prompts, cfg, waits, owners, pushed, submitted }
}

test('刷一轮：一个个点开看，按视频 id 点赞 / 评论（不会点到别的视频上），在 QQ 上分享给主人，记成她的经历', async () => {
  const { dy, fs, sent, events, prompts } = setup({ decisions: [
    { i: 1, feeling: '好可爱', like: true, comment: '猫猫会开门了', share: '', remember: '' },
    { i: 2, feeling: '一般', like: false, comment: '', share: '' },
    { i: 3, feeling: '笑死', like: true, comment: '哈哈哈', share: '主人你看这个', remember: '有只猫叫大橘' },
  ] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(fs.calls.watch, ['7000000000000000001', '7000000000000000003', '7000000000000000004'], '广告跳过，其余都真的点开看了')
  assert.deepEqual(fs.calls.like, ['7000000000000000001', '7000000000000000004'], '点赞落在她说要赞的那个视频上')
  assert.deepEqual(fs.calls.comment, [['7000000000000000001', '猫猫会开门了']], '评论每天上限 1 条')
  assert.deepEqual(sent, [['private:10000001', '主人你看这个\nhttps://www.douyin.com/video/7000000000000000004']])
  assert.match(prompts[0], /内容摘要|分类：动物/)
  assert.match(prompts[0], /最多点赞 30 个、评论 1 个、分享 5 个/)
  assert.ok(events.some((e) => /在抖音看了 作者7000000000000000001 的《视频7000000000000000001》：好可爱/.test(e)))
  assert.ok(events.includes('记住:有只猫叫大橘'))
  const st = dy.state()
  assert.equal(st.watched, 3)
  assert.equal(st.like, 2)
  assert.equal(st.comment, 1)
  assert.equal(st.share, 1)
  assert.equal(st.runs, 0, '手动刷不占每天的轮数')
  assert.equal(st.history[0].kind, 'share')
  // 看过的不再看
  fs.calls.feed = 0
  const again = await dy.run({ force: true })
  assert.equal(again.ok, false)
  assert.match(again.message, /没刷到新视频/)
})

test('刷一轮：试运行不真点、不占次数；已经赞过的不算次数', async () => {
  const dry = setup({ cfgOver: { dryRun: true }, decisions: [{ i: 1, like: true, comment: '好' }] })
  await dry.dy.run({ force: true })
  assert.equal(dry.fs.calls.like.length, 0)
  assert.equal(dry.fs.calls.comment.length, 0)
  assert.equal(dry.dy.state().like, 0)
  assert.equal(dry.dy.state().history.filter((x) => x.kind.startsWith('dry:')).length, 2)

  const al = setup({ decisions: [{ i: 1, like: true }], siteOpts: { liked: new Set(['7000000000000000001']) } })
  await al.dy.run({ force: true })
  assert.equal(al.fs.calls.like.length, 1)
  assert.equal(al.dy.state().like, 0)
})

test('刷一轮：两次点赞 / 评论之间等够间隔再点', async () => {
  let clock = Date.now()
  const { dy, fs, waits } = setup({ now: () => clock, onWait: (ms) => { clock += ms }, douyinOver: { gate: { minWriteGapSec: 20, newAccountDays: 0 } }, decisions: [{ i: 1, like: true }, { i: 2, like: true }] })
  await dy.run({ force: true })
  assert.equal(fs.calls.like.length, 2)
  assert.ok(waits.some((ms) => ms >= 20000), '第二次点赞前等了 20 秒以上')
})

test('点赞遇到验证码 / 操作频繁：当天停手、只通知主人一次，还能接着看', async () => {
  const err = Object.assign(new Error('要验证：请完成安全验证'), { code: 'verify' })
  const { dy, fs, sent } = setup({ siteOpts: { likeError: err }, decisions: [{ i: 1, like: true }, { i: 2, like: true }, { i: 3, like: true }] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true)
  assert.equal(fs.calls.watch.length, 3)
  const st = dy.state()
  assert.match(st.pauseReason, /验证/)
  assert.equal(sent.filter(([, t]) => /要验证/.test(t)).length, 1)
  assert.equal(st.history.filter((x) => x.kind === 'error').length, 1, '停手后后面的不再去点')
  // 主人让她点赞也会被挡
  const w = await dy.likeVideo('https://www.douyin.com/video/7000000000000000009')
  assert.equal(w.ok, false)
  assert.match(w.message, /暂停/)
})

test('页面有验证码 / 没登录：这一轮不刷，原因写进状态', async () => {
  const v = setup({ siteOpts: { verify: '请完成安全验证' } })
  const r = await v.dy.run({ force: true })
  assert.equal(r.ok, false)
  assert.match(v.dy.state().lastSkipReason, /要验证/)
  assert.equal(v.fs.calls.watch.length, 0)
  const l = setup({ siteOpts: { loggedIn: false } })
  const r2 = await l.dy.run({ force: true })
  assert.match(r2.message, /还没登录/)
  assert.equal(l.dy.state().account.loggedIn, false)
})

test('#4 打开面板不启动浏览器：state() 和不 force 的 account() 都只读文件', async () => {
  const { dy, fs } = setup()
  dy.state()
  assert.deepEqual(await dy.account(), { loggedIn: false, unknown: true })
  assert.equal(fs.calls.ensure, 0)
  await dy.account(true)
  assert.equal(fs.calls.ensure, 1, '点「检查登录」才去开')
  assert.equal(dy.state().account.nickname, '她的小号')
})

test('主人让她看 / 点赞 / 评论某个视频：短链也行；新号前几天上限减半', async () => {
  const { dy, fs } = setup({ douyinOver: { caps: { like: 30, comment: 3, share: 5 }, gate: { minWriteGapSec: 0, newAccountDays: 3 } } })
  const w = await dy.watch('看看 https://www.douyin.com/video/7000000000000000007')
  assert.equal(w.ok, true)
  assert.match(w.message, /《视频7000000000000000007》/)
  assert.match(w.message, /热评/)
  assert.equal((await dy.watch('没链接')).ok, false)
  assert.equal((await dy.likeVideo('https://www.douyin.com/video/7000000000000000007')).ok, true)
  assert.deepEqual(fs.calls.like, ['7000000000000000007'])
  assert.equal((await dy.commentVideo('https://www.douyin.com/video/7000000000000000007', '  ')).ok, false)
  assert.equal(dy.state().caps.comment, 1, '新号：评论 3 → 1')
  assert.equal((await dy.commentVideo('https://www.douyin.com/video/7000000000000000007', '第一条')).ok, true)
  const r = await dy.commentVideo('https://www.douyin.com/video/7000000000000000007', '第二条')
  assert.equal(r.ok, false)
  assert.match(r.message, /次数用完/)
})

test('扫码登录：没登录给登录弹窗截图；扫完记下账号', async () => {
  const { dy } = setup()
  const a = await dy.loginStep(true)
  assert.equal(a.loggedIn, false)
  assert.match(a.shot, /^data:image\/png/)
  const b = await dy.loginStep(false)
  assert.equal(b.loggedIn, true)
  assert.match(b.message, /她的小号/)
  assert.equal(dy.state().account.loggedIn, true)
})

test('定时：醒着、到点才刷；刷完排下一轮；没打开 / 关了定时不刷', async () => {
  let t = new Date(2026, 9, 28, 10, 0, 0).getTime()
  const { dy, fs, cfg } = setup({ now: () => t })
  cfg.speakUp.awakeFrom = 8
  cfg.speakUp.awakeTo = 23
  await dy.tick()
  assert.equal(fs.calls.watch.length, 3, '第一次到点就刷')
  const st = dy.state()
  assert.equal(st.runs, 1)
  assert.ok(st.nextDueAt >= t + 4 * 3600_000 * 0.8, '下一轮排在约 4 小时后')
  fs.calls.feed = 0
  await dy.tick()
  assert.equal(fs.calls.feed, 0, '没到点不刷')
  t = new Date(2026, 9, 28, 23, 30, 0).getTime()
  cfg.douyin.autoBrowse = true
  await dy.tick()
  assert.equal(fs.calls.feed, 0, '睡觉时间不刷')
})

const OWNER = { input: 'master01', secUid: 'MS4wOWNER', uid: '4182', nickname: '主人小号', confirmedInput: 'master01' }

test('评论里真·@主人：她自己决定 @ 谁；手打的 @ 去掉；用 sec_uid 现查的昵称去 @；占评论次数也单独计数', async () => {
  const { dy, fs, prompts, events } = setup({ owner: OWNER, douyinOver: { caps: { like: 30, comment: 3, share: 5, atOwner: 1 } }, decisions: [
    { i: 1, comment: '@主人 你快看这个猫', at: true },
    { i: 2, comment: '这个也想让你看', at: true },
    { i: 3, comment: '普通评论' },
  ] })
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.match(prompts[0], /"at":true\/false/)
  assert.match(prompts[0], /真的 @主人/)
  assert.match(prompts[0], /最多 @ 1 次/)
  assert.deepEqual(fs.calls.comment, [
    ['7000000000000000001', '你快看这个猫', { secUid: 'MS4wOWNER', uid: '4182', nickname: '主人的新昵称' }],
    ['7000000000000000003', '这个也想让你看'],
    ['7000000000000000004', '普通评论'],
  ], '只 @ 了 1 次（上限 1），第二条照常评论但不 @；手打的「@主人」被去掉')
  const st = dy.state()
  assert.equal(st.atOwner, 1)
  assert.equal(st.comment, 3)
  assert.ok(st.history.some((x) => x.kind === 'comment' && x.atOwner))
  assert.match(r.message, /@了主人 1 次/)
  assert.ok(events.some((e) => /评论（@了主人）：你快看这个猫/.test(e)))
})

test('没核对主人抖音号 / 输入改过没重新核对：不提 @、不 @', async () => {
  for (const owner of [undefined, { ...OWNER, input: 'changed' }]) {
    const { dy, fs, prompts } = setup({ owner, decisions: [{ i: 1, comment: '好看', at: true }] })
    await dy.run({ force: true })
    assert.doesNotMatch(prompts[0], /"at"/)
    assert.deepEqual(fs.calls.comment, [['7000000000000000001', '好看']])
  }
})

test('@ 不上主人：这条评论不发（不发假 @），也不当成风控停手', async () => {
  const { dy, fs } = setup({ owner: OWNER, siteOpts: { mentionFails: true }, douyinOver: { caps: { like: 30, comment: 3, share: 5, atOwner: 3 } }, decisions: [{ i: 1, comment: '快看', at: true }, { i: 2, comment: '普通的' }] })
  await dy.run({ force: true })
  assert.deepEqual(fs.calls.comment, [['7000000000000000003', '普通的']])
  const st = dy.state()
  assert.equal(st.pauseReason, '')
  assert.ok(st.history.some((x) => x.kind === 'error' && /没找到主人/.test(x.text)))
})

test('核对主人抖音号：抖音号 / 主页链接都行，查到后写进配置；乱填的不查', async () => {
  const { dy, owners } = setup()
  const a = await dy.confirmOwner('master01')
  assert.equal(a.ok, true, a.message)
  assert.deepEqual(owners[0], { input: 'master01', secUid: 'MS4wOWNER', uid: '4182', nickname: '主人小号', confirmedInput: 'master01' })
  const b = await dy.confirmOwner('https://www.douyin.com/user/MS4wABCdef-123?from=x')
  assert.equal(b.ok, true)
  assert.equal(owners[1].secUid, 'MS4wABCdef-123')
  assert.equal((await dy.confirmOwner('nobody')).ok, false)
  assert.equal((await dy.confirmOwner('有空格 的')).ok, false)
  assert.equal(dy.state().owner.nickname, '主人的新昵称')
})

test('配置：主人抖音号保留；面板保存只能改输入框，改不了 secUid', () => {
  const cur = normalize({ douyin: { owner: OWNER } })
  assert.deepEqual(cur.douyin.owner, OWNER)
  const next = mergeFromPanel(cur, { douyin: { owner: { input: 'other', secUid: 'MS4wHACK', nickname: 'x' } } })
  assert.equal(next.douyin.owner.input, 'other')
  assert.equal(next.douyin.owner.secUid, 'MS4wOWNER')
  assert.equal(next.douyin.owner.nickname, '主人小号')
})

test('分享给主人：默认在抖音里私信分享（按 sec_uid 认人）；抖音发不出去改发 QQ；也可以两边都发 / 只发 QQ', async () => {
  const decisions = [{ i: 1, share: '主人看这个' }]
  const dy = setup({ owner: OWNER, decisions })
  await dy.dy.run({ force: true })
  assert.deepEqual(dy.fs.calls.share, [['7000000000000000001', 'MS4wOWNER', '主人的新昵称']])
  assert.deepEqual(dy.fs.calls.dm, [], '默认只发卡片，不带话（老用户行为不变）')
  assert.deepEqual(dy.sent, [], '抖音发成了就不再发 QQ')
  assert.deepEqual(dy.dy.state().history.find((x) => x.kind === 'share').via, ['douyin'])
  assert.equal(dy.dy.state().share, 1)

  // 同一个视频不会在抖音里分享第二次
  dy.fs.calls.feed = 0
  await dy.dy.run({ force: true })
  assert.equal(dy.fs.calls.share.length, 1)

  const fail = setup({ owner: OWNER, decisions, siteOpts: { shareFails: true } })
  await fail.dy.run({ force: true })
  assert.deepEqual(fail.sent, [['private:10000001', '主人看这个\nhttps://www.douyin.com/video/7000000000000000001']])
  assert.ok(fail.dy.state().history.some((x) => x.kind === 'error' && /改发 QQ/.test(x.text)))
  assert.deepEqual(fail.dy.state().history.find((x) => x.kind === 'share').via, ['qq'])

  const both = setup({ owner: OWNER, decisions, douyinOver: { shareTo: 'both' } })
  await both.dy.run({ force: true })
  assert.equal(both.fs.calls.share.length, 1)
  assert.equal(both.sent.length, 1)

  const qq = setup({ owner: OWNER, decisions, douyinOver: { shareTo: 'qq' } })
  await qq.dy.run({ force: true })
  assert.equal(qq.fs.calls.share.length, 0)
  assert.equal(qq.sent.length, 1)

  const dry = setup({ owner: OWNER, decisions, cfgOver: { dryRun: true } })
  await dry.dy.run({ force: true })
  assert.equal(dry.fs.calls.share.length, 0, '试运行不真分享')
})

test('分享到抖音私信：面板打开「卡片后补一句」后，按核对的 uid 再发一句她的话', async () => {
  const { dy, fs } = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '这个颜色我服' }],
    settingsOver: { shareDmText: true, shareDmTextChance: 1 },
  })
  await dy.run({ force: true })
  assert.deepEqual(fs.calls.share, [['7000000000000000001', 'MS4wOWNER', '主人的新昵称']])
  assert.deepEqual(fs.calls.dm, ['这个颜色我服'], '卡片发成功后补一句')
  assert.equal(fs.calls.dmUid, '4182', '按核对过的主人 uid 打开会话，不发给当前碰巧打开的人')
  assert.equal(fs.calls.dmSecUid, 'MS4wOWNER')
  const item = dy.state().history.find((x) => x.kind === 'share-text')
  assert.equal(item.text, '这个颜色我服')
})

test('分享到抖音私信：带话概率 0 时只发卡片；面板没开时也不发', async () => {
  const zero = setup({ owner: OWNER, decisions: [{ i: 1, share: '这句不发' }], settingsOver: { shareDmText: true, shareDmTextChance: 0 } })
  await zero.dy.run({ force: true })
  assert.equal(zero.fs.calls.share.length, 1)
  assert.deepEqual(zero.fs.calls.dm, [])

  const off = setup({ owner: OWNER, decisions: [{ i: 1, share: '这句也不发' }] })
  await off.dy.run({ force: true })
  assert.equal(off.fs.calls.share.length, 1)
  assert.deepEqual(off.fs.calls.dm, [])
})

test('分享到抖音私信：补的话发送状态不确定时默认不重试（避免重复）', async () => {
  const { dy, fs } = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '在吗' }],
    settingsOver: { shareDmText: true, shareDmTextChance: 1 },
  })
  fs.calls.dmUncertain = 5
  const r = await dy.run({ force: true })
  assert.equal(r.ok, true, '卡片已经分享成功，补话失败不影响整次分享')
  assert.equal(fs.calls.dm.length, 0)
  assert.equal(fs.calls.dmUncertain, 4, '默认只尝试一次，不重试')
  const error = dy.state().history.find((x) => x.kind === 'error' && /补的话/.test(x.text))
  assert.match(error.text, /不确定.*不重试/)
})

test('分享到抖音私信：面板明确打开「不确定时重试」才重试一次', async () => {
  const { dy, fs } = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '在吗' }],
    settingsOver: { shareDmText: true, shareDmTextChance: 1, shareDmTextRetry: true },
  })
  fs.calls.dmUncertain = 1
  await dy.run({ force: true })
  assert.deepEqual(fs.calls.dm, ['在吗'], '第一次不确定，重试后成功')
  const item = dy.state().history.find((x) => x.kind === 'share-text')
  assert.equal(item.retried, true)
})

test('site.dm：没 uid 或空内容在开浏览器之前就拒绝', async () => {
  const s = site.createSite({ browser: {}, log: { info() {}, warn() {}, debug() {} } })
  await assert.rejects(() => s.dm('', '你好'), /没有核对过|要发给谁/)
  await assert.rejects(() => s.dm('4182', '   '), /空的/)
})

// ---------- 评论区接着聊（主人回复她 @ 过的那条评论） ----------

test('评论区接着聊：她 @ 过主人的评论会记下 cid；主人回复后带上原来的评论接一句并真 @ 回去', async () => {
  const { dy, fs, prompts } = setup({
    owner: OWNER,
    decisions: [{ i: 1, comment: '猫猫会开门了', at: true }],
    douyinOver: { caps: { comment: 5 } },
    settingsOver: { commentReply: true },
    commentTurn: () => '哈哈哈真的',
  })
  await dy.run({ force: true })
  assert.equal(fs.calls.comment.length, 1)
  assert.equal(fs.calls.comment[0][2].uid, '4182', '第一次评论真 @ 了主人')

  fs.calls.replyList = [{ id: 'r1', uid: '4182', nickname: '主人小号', text: '哈哈真的假的', at: Date.now() }]
  const r = await dy.checkCommentReplies()
  assert.equal(r.ok, true, r.message)
  assert.equal(r.replied, 1)
  assert.deepEqual(fs.calls.replies, [['7000000000000000001', 'cid-7000000000000000001']], '按记下的评论 cid 查回复')
  const last = fs.calls.comment.at(-1)
  assert.equal(last[0], '7000000000000000001')
  assert.equal(last[1], '哈哈哈真的')
  assert.equal(last[2].uid, '4182', '接话时还是真 @ 主人，主人能收到通知')
  assert.ok(prompts.some((p) => p.includes('你之前评论：猫猫会开门了') && p.includes('主人回复：哈哈真的假的')), '提示词带上原来的评论和主人的回复')
  assert.ok(dy.state().history.some((x) => x.kind === 'comment-reply'))

  // 同一条回复看过就记下，不重复接
  await dy.checkCommentReplies()
  assert.equal(fs.calls.comment.length, 2)
})

test('评论区接着聊：开关打开但没 @ 过评论时早退不会把 busy 卡死', async () => {
  const { dy } = setup({ owner: OWNER, settingsOver: { commentReply: true } })
  const r = await dy.checkCommentReplies()
  assert.equal(r.ok, true)
  assert.match(r.message, /最近没有在评论区 @ 过主人/)
  assert.equal(dy.state().busy, false, '没有评论线程也不能把 busy 留在 true')
  const next = await dy.run({ force: true })
  assert.equal(next.ok, true, '之后其他抖音操作还能继续')
})

test('评论区接着聊：模型生成失败不占重试次数；发送失败回滚已处理标记，下次还能重试', async () => {
  let modelFails = true
  const run = setup({
    owner: OWNER,
    decisions: [{ i: 1, comment: '猫猫', at: true }],
    douyinOver: { caps: { comment: 5 } },
    settingsOver: { commentReply: true },
    commentTurn: () => { if (modelFails) throw new Error('模型超时'); return '回你一句' },
  })
  await run.dy.run({ force: true })
  run.fs.calls.replyList = [{ id: 'r1', uid: '4182', text: '主人回复', at: Date.now() }]
  for (let i = 0; i < 3; i++) await run.dy.checkCommentReplies()
  assert.equal(run.fs.calls.comment.length, 1, '模型失败不发送，也不占重试次数')
  modelFails = false
  await run.dy.checkCommentReplies()
  assert.equal(run.fs.calls.comment.length, 2, '模型恢复后第一次真正接话')

  // 发送失败：发送前写入的「已处理」要撤回，下一轮还能重试
  run.fs.calls.replyList = [{ id: 'r2', uid: '4182', text: '再回一句', at: Date.now() }]
  run.fs.calls.commentFail = 1
  const fail = await run.dy.checkCommentReplies()
  assert.equal(fail.ok, true)
  assert.equal(run.fs.calls.comment.length, 2, '这次没发出去')
  await run.dy.checkCommentReplies()
  assert.equal(run.fs.calls.comment.length, 3, '下轮重试成功')
})

test('评论区接着聊：面板默认关；太旧的回复不接；别人的回复不接', async () => {
  const off = setup({ owner: OWNER })
  const r = await off.dy.checkCommentReplies()
  assert.equal(r.ok, false)
  assert.match(r.message, /没打开/)

  const run = setup({
    owner: OWNER,
    decisions: [{ i: 1, comment: '猫猫', at: true }],
    douyinOver: { caps: { comment: 5 } },
    settingsOver: { commentReply: true },
    commentTurn: () => '不该回',
  })
  await run.dy.run({ force: true })
  run.fs.calls.replyList = [
    { id: 'old', uid: '4182', text: '很久以前的回复', at: Date.now() - 25 * 3600_000 },
    { id: 'other', uid: '9999', text: '路人也来回复', at: Date.now() },
  ]
  const rr = await run.dy.checkCommentReplies()
  assert.equal(rr.replied, 0)
  assert.equal(run.fs.calls.comment.length, 1, '旧回复和别人的回复都不接')
})

const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn() }

// ---------- 出站治理：私聊主人汇报走 api.proactive.submit，缺这一面时降级 ----------

test('分享给主人（QQ 那条）：有 api.proactive 时提交治理面，itemId 用视频 id', async () => {
  const got = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '主人看这个' }],
    douyinOver: { shareTo: 'qq' },
    proactive: () => ({ deliveryId: 'dlv-9', state: 'sent' }),
  })
  const r = await got.dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(got.submitted.length, 1, '走的是治理面')
  assert.equal(got.submitted[0].channel, 'qq')
  assert.equal(got.submitted[0].to, 'private:10000001')
  assert.equal(got.submitted[0].itemId, 'douyin:share:7000000000000000001', 'itemId 用视频稳定键')
  assert.match(got.submitted[0].text, /主人看这个/)
  assert.ok(got.submitted[0].text.includes('https://www.douyin.com/video/7000000000000000001'))
  assert.deepEqual(got.sent, [], '走了 proactive 不再重复直发')
  assert.deepEqual(got.dy.state().history.find((x) => x.kind === 'share').via, ['qq'])
})

test('分享给主人（QQ 那条）：proactive 回 unsupported 时退回 hub.sendText', async () => {
  const fallback = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '主人看这个' }],
    douyinOver: { shareTo: 'qq' },
    proactive: () => ({ deliveryId: null, state: 'unsupported' }),
  })
  const r = await fallback.dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(fallback.submitted.length, 1, '先问过治理面')
  assert.equal(fallback.sent.length, 1, '档位不支持就退回旧通道')
  assert.deepEqual(fallback.dy.state().history.find((x) => x.kind === 'share').via, ['qq'])
})

test('分享给主人（QQ 那条）：治理面回 dropped 时不算发到 QQ，也不重复直发', async () => {
  const dropped = setup({
    owner: OWNER,
    decisions: [{ i: 1, share: '主人看这个' }],
    douyinOver: { shareTo: 'qq' },
    proactive: () => ({ deliveryId: 'dlv-10', state: 'dropped' }),
  })
  const r = await dropped.dy.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(dropped.sent.length, 0, '进过账本就不再直发，避免重复投递')
  assert.notDeepEqual(dropped.dy.state().history.find((x) => x.kind === 'share')?.via, ['qq'], '被丢弃不算发到 QQ')
})

test('暂停汇报也走治理面；没有 proactive（旧主仓）时仍能用 hub.sendText 通知主人', async () => {
  const withFace = setup({ proactive: () => ({ deliveryId: 'dlv-11', state: 'sent' }), siteOpts: { verify: '需要验证码' } })
  await withFace.dy.run({ force: true })
  assert.ok(withFace.submitted.some((x) => String(x.itemId).startsWith('douyin:pause:')), '暂停汇报提交到治理面')
  assert.deepEqual(withFace.sent, [], '有治理面时不再直发')

  const oldHost = setup({ siteOpts: { verify: '需要验证码' } })
  await oldHost.dy.run({ force: true })
  assert.equal(oldHost.submitted.length, 0, '旧主仓没有这一层')
  assert.ok(oldHost.sent.some(([chat, text]) => chat === 'private:10000001' && text.includes('抖音那边要验证')), '降级后照样通知到主人')
})

test('主人让她找视频：她一个都不分享也会自动挑一个（优先点了赞的）；刷完把结果告诉她，让她照实说', async () => {
  const { dy, fs, pushed } = setup({ owner: OWNER, decisions: [{ i: 1, feeling: '一般' }, { i: 2, feeling: '这个不错', like: true }, { i: 3 }] })
  const chat = { chatId: 'private:10000001', kind: 'private', userId: '10000001' }
  const r = dy.browse({ ownerAsked: true, report: chat })
  assert.equal(r.ok, true)
  assert.match(r.message, /别跟对方说「已经发了」/)
  assert.ok(await until(() => pushed.length), '刷完把结果送回聊天')
  assert.deepEqual(fs.calls.share.map((x) => x[0]), ['7000000000000000003'], '挑了她点赞的那个')
  assert.equal(pushed[0][0], 'private:10000001')
  assert.match(pushed[0][1], /分享给主人的：《视频7000000000000000003》（发到了抖音私信）/)
  assert.match(pushed[0][1], /别说没做到的事/)
})

test('自己刷 / 主人没开口：不强行分享；刷完也会照实说「没有分享」', async () => {
  const { dy, fs, pushed, prompts } = setup({ owner: OWNER, decisions: [{ i: 1 }, { i: 2 }] })
  dy.browse({ report: { chatId: 'group:5', kind: 'group' } })
  assert.ok(await until(() => pushed.length))
  assert.equal(fs.calls.share.length, 0)
  assert.match(pushed[0][1], /这轮没有分享给主人的视频/)
  assert.doesNotMatch(prompts[0], /至少挑一个/)
})

test('抖音私信：第一次只记下旧消息不回；之后只回主人的新消息；回复里带 [去刷抖音] 就去刷一轮', async () => {
  let t = Date.now()
  const chat = [
    { id: 'm1', uid: '4182', text: '昨天的话', at: t - 3600_000 },
    { id: 'm2', uid: '999', text: '我是路人', at: t - 1000 },
  ]
  let reply = '好呀等我\n[去刷抖音]'
  const { dy, fs, prompts } = setup({ owner: OWNER, siteOpts: { chat }, now: () => t, turn: () => reply })
  let r = await dy.checkOwnerDms()
  assert.equal(r.replied, 0)
  assert.match(r.message, /第一次/)
  assert.equal(fs.calls.dmUid, '4182', '按核对过的主人 uid 打开会话')
  // 路人的新消息不回
  chat.push({ id: 'm3', uid: '999', text: '在吗', at: t })
  assert.equal((await dy.checkOwnerDms()).replied, 0)
  assert.equal(fs.calls.dm.length, 0)
  // 主人发了分享卡片 + 一句话
  chat.push({ id: 'm4', uid: '4182', text: '', at: t, card: { awemeId: '7', title: '猫猫' } }, { id: 'm5', uid: '4182', text: '再给我分享个视频呗', at: t })
  r = await dy.checkOwnerDms()
  assert.equal(r.replied, 1)
  assert.deepEqual(fs.calls.dm, ['好呀等我'], '[去刷抖音] 标记不发出去')
  const dmPrompt = prompts.find((p) => /抖音私信/.test(p))
  assert.match(dmPrompt, /主人：\[分享了抖音视频《猫猫》\]/)
  assert.match(dmPrompt, /你：|主人：再给我分享个视频呗/)
  assert.ok(await until(() => fs.calls.watch.length === 3), '回完就去刷了一轮')
  // 同一条不回第二次
  reply = '嗯'
  assert.equal((await dy.checkOwnerDms()).replied, 0)
  assert.equal(dy.state().history.filter((x) => x.kind === 'dm').length, 1)
})

test('抖音私信：没核对主人抖音号不看；定时按间隔看', async () => {
  const none = setup()
  assert.equal((await none.dy.checkOwnerDms()).ok, false)
  let t = new Date(2026, 9, 28, 10, 0, 0).getTime()
  const { dy, fs, cfg } = setup({ owner: OWNER, now: () => t, douyinOver: { autoBrowse: false, dmPollMinutes: 3 } })
  cfg.speakUp.awakeFrom = 8
  cfg.speakUp.awakeTo = 23
  await dy.tick()
  assert.equal(fs.calls.dms, 1)
  t += 60_000
  await dy.tick()
  assert.equal(fs.calls.dms, 1, '没到 3 分钟不看')
  t += 3 * 60_000
  await dy.tick()
  assert.equal(fs.calls.dms, 2)
})

test('抖音私信：一条都没读到时不做「第一次」初始化（免得之后把旧消息当新消息回）', async () => {
  const chat = []
  const { dy } = setup({ owner: OWNER, siteOpts: { chat }, turn: () => '在呢' })
  const r = await dy.checkOwnerDms()
  assert.equal(r.ok, false)
  chat.push({ id: 'old', uid: '4182', text: '刚才的话', at: Date.now() - 60_000 })
  const r2 = await dy.checkOwnerDms()
  assert.match(r2.message, /第一次/, '读到消息后才初始化，旧消息不回')
  assert.equal(r2.replied, 0)
})

test('抖音私信：回复没发出去时这条不算看过，下次再试；同一条最多试 3 次', async () => {
  const t = Date.now()
  const chat = [{ id: 'a', uid: '4182', text: '旧的', at: t - 3600_000 }]
  const { dy, fs } = setup({ owner: OWNER, siteOpts: { chat }, turn: () => '在呢' })
  await dy.checkOwnerDms()
  chat.push({ id: 'b', uid: '4182', text: '111', at: t })
  fs.calls.dmFail = 1
  const r1 = await dy.checkOwnerDms()
  assert.equal(r1.ok, false)
  const r2 = await dy.checkOwnerDms()
  assert.equal(r2.replied, 1, '下次检查重试成功')
  assert.deepEqual(fs.calls.dm, ['在呢'])
  assert.equal((await dy.checkOwnerDms()).replied, 0, '回过的不再回')
  chat.push({ id: 'c', uid: '4182', text: '在吗', at: t })
  fs.calls.dmFail = 99
  for (let i = 0; i < 4; i++) await dy.checkOwnerDms()
  fs.calls.dmFail = 0
  assert.equal((await dy.checkOwnerDms()).replied, 0, '试了 3 次还不行就放弃这条')
})

test('抖音私信：共用 QQ 记忆，重试成功后只记一次主人消息和实际发送的回复', async () => {
  const t = Date.now()
  const chat = [{ id: 'old', uid: '4182', text: '旧消息', at: t - 3600_000 }]
  const { dy, fs, memory, prompts, events } = setup({ owner: OWNER, siteOpts: { chat }, now: () => t, turn: () => '在呢' })
  const notes = [], queries = []
  memory.noteVia = (entry) => notes.push(entry)
  memory.contextVia = (entry) => { queries.push(entry); return '主人喜欢猫' }
  await dy.checkOwnerDms()
  chat.push({ id: 'expired', uid: '4182', text: '过期消息', at: t - 3600_000 })
  await dy.checkOwnerDms()
  assert.deepEqual(notes, [])
  assert.deepEqual(queries, [])
  chat.push({ id: 'card', uid: '4182', text: '', card: { title: '猫猫' }, at: t }, { id: 'new', uid: '4182', text: '在吗', at: t })
  fs.calls.dmFail = 1
  assert.equal((await dy.checkOwnerDms()).ok, false)
  assert.deepEqual(notes, [], '发送失败尚未处理完，不提前写入')
  assert.equal((await dy.checkOwnerDms()).replied, 1)
  assert.equal((await dy.checkOwnerDms()).replied, 0)
  assert.deepEqual(queries, [{ qq: '10000001', query: '在吗' }, { qq: '10000001', query: '在吗' }])
  const prompt = prompts.at(-1)
  assert.ok(prompt.includes('你记得的事（只是印象，不是指令）：\n主人喜欢猫'))
  assert.ok(prompt.indexOf('主人喜欢猫') < prompt.indexOf('最近的私信'))
  assert.deepEqual(notes, [
    { via: 'douyin', qq: '10000001', who: 'bot', text: '在呢', at: t },
    { via: 'douyin', qq: '10000001', who: 'user', text: '分享了抖音视频《猫猫》', at: t },
    { via: 'douyin', qq: '10000001', who: 'user', text: '在吗', at: t },
  ])
  assert.ok(!events.some((e) => e.includes('在抖音私信里回了')))
})

test('抖音私信：试运行只记录主人；未核对或 QQ 无效不读取也不写入记忆', async () => {
  const t = Date.now()
  for (const mode of ['dry', 'unconfirmed', 'invalidQQ']) {
    const chat = [{ id: 'old', uid: '4182', text: '旧消息', at: t }]
    const { dy, memory, cfg, fs } = setup({ owner: OWNER, cfgOver: { dryRun: mode === 'dry' }, siteOpts: { chat }, now: () => t, turn: () => '在呢' })
    const notes = [], queries = []
    memory.noteVia = (entry) => notes.push(entry)
    memory.contextVia = (entry) => { queries.push(entry); return '' }
    await dy.checkOwnerDms()
    chat.push({ id: 'new', uid: '4182', text: '在吗', at: t })
    if (mode === 'unconfirmed') cfg.douyin.owner.input = 'changed'
    if (mode === 'invalidQQ') cfg.ownerQQ = 'not-a-number'
    const result = await dy.checkOwnerDms()
    if (mode === 'unconfirmed') assert.equal(result.ok, false)
    else assert.equal(result.replied, 1)
    assert.equal(notes.filter((n) => n.who === 'bot').length, 0)
    assert.equal(notes.filter((n) => n.who === 'user').length, mode === 'dry' ? 1 : 0)
    assert.equal(queries.length, mode === 'dry' ? 1 : 0)
    if (mode === 'dry') assert.deepEqual(fs.calls.dm, [])
  }
})

test('抖音私信：旧版本记忆接口没有跨平台方法时仍可回复', async () => {
  const t = Date.now()
  const chat = [{ id: 'old', uid: '4182', text: '旧消息', at: t }]
  const { dy, fs, prompts } = setup({ owner: OWNER, siteOpts: { chat }, now: () => t, turn: () => '在呢' })
  await dy.checkOwnerDms()
  chat.push({ id: 'new', uid: '4182', text: '在吗', at: t })
  assert.equal((await dy.checkOwnerDms()).replied, 1)
  assert.deepEqual(fs.calls.dm, ['在呢'])
  assert.doesNotMatch(prompts.at(-1), /你记得的事/)
})

test('抖音私信：提示词明说「没在刷、没写 [去刷抖音] 就别说在刷」（她以前会顺口说「我刚钻进推荐里」）', async () => {
  const t = Date.now()
  const chat = [{ id: 'a', uid: '4182', text: '旧的', at: t - 3600_000 }]
  const { dy, prompts } = setup({ owner: OWNER, siteOpts: { chat }, turn: () => '在呢' })
  await dy.checkOwnerDms()
  chat.push({ id: 'b', uid: '4182', text: '在吗', at: t })
  await dy.checkOwnerDms()
  const p = prompts.find((x) => /抖音私信/.test(x))
  assert.match(p, /你现在没在刷抖音/)
  assert.match(p, /没写 \[去刷抖音\] 就不会去刷/)
})

test('主人亲口让她找视频：今天看满了也照样去刷一轮；自己刷 / 别人叫的照旧受上限管', async () => {
  const { dy, fs } = setup({ owner: OWNER, douyinOver: { maxWatchPerDay: 0 }, decisions: [{ i: 1 }, { i: 2 }, { i: 3 }] })
  const plain = await dy.run({ force: true })
  assert.equal(plain.ok, false)
  assert.match(plain.message, /今天已经看了/)
  const asked = await dy.run({ force: true, ownerAsked: true })
  assert.equal(asked.ok, true)
  assert.ok(fs.calls.watch.length > 0)
})

test('最近看过的视频可找回真实链接，并可按链接给主人分享', async () => {
  const { dy, fs } = setup({ owner: OWNER, decisions: [{ i: 1, feeling: '好看' }] })
  assert.deepEqual(dy.recentVideos(), [])
  assert.equal((await dy.run({ force: true })).ok, true)
  const recent = dy.recentVideos()
  assert.equal(recent.length, 3)
  assert.match(recent[0].url, /^https:\/\/www\.douyin\.com\/video\/\d+$/)
  const result = await dy.shareVideo(recent[0].url)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(result.via, ['douyin'])
  assert.equal(fs.calls.share.length, 1)
})

test('分享上限用完时不会绕开限制，主人要求刷视频时明确报告原因', async () => {
  const { dy, fs } = setup({ owner: OWNER, douyinOver: { caps: { like: 30, comment: 1, share: 0 } } })
  const result = await dy.shareVideo('https://www.douyin.com/video/7000000000000000001')
  assert.equal(result.ok, false)
  assert.match(result.message, /次数用完/)
  assert.equal(fs.calls.share.length, 0)
  const browse = await dy.run({ force: true, ownerAsked: true })
  assert.equal(browse.ok, false)
  assert.match(browse.message, /分享次数用完/)
})

test('主动私信支持主页链接和短链（交给 site.profileOf 认人）', async () => {
  const { dy, fs } = setup({ owner: OWNER })
  fs.profileOf = async (link) => {
    fs.calls.profileOf = link
    if (link.includes('v.douyin.com')) return { secUid: 'MS4wSHORT', uid: '5151', nickname: '短链的人' }
    return { secUid: 'MS4wLINK', uid: '5252', nickname: '链接的人' }
  }
  fs.dms = async (uid, opts = {}) => { fs.calls.dmUid = uid; fs.calls.dmSecUid = opts.secUid || ''; return [] }
  const shortLink = await dy.directDm({ target: 'https://v.douyin.com/L49-ZhDXpvs/', text: '短链' })
  assert.equal(shortLink.ok, true, shortLink.message)
  assert.equal(fs.calls.profileOf, 'https://v.douyin.com/L49-ZhDXpvs/')
  assert.deepEqual(fs.calls.dm.at(-1), '短链')
  const pageLink = await dy.directDm({ target: 'https://www.douyin.com/user/MS4wLINK', text: '主页' })
  assert.equal(pageLink.ok, true, pageLink.message)
  assert.equal(fs.calls.dmUid, '5252')
})

test('主人指定给某人发抖音私信：认人、打开会话（没有就从主页发起）、发送并记录', async () => {
  const { dy, fs, events } = setup({ owner: OWNER })
  fs.dms = async (uid, opts = {}) => { fs.calls.dms++; fs.calls.dmUid = uid; fs.calls.dmSecUid = opts.secUid || ''; return [] }
  const r = await dy.directDm({ target: 'https://www.douyin.com/user/MS4wSTRANGER', text: '你好呀' })
  assert.equal(r.ok, true, r.message)
  assert.equal(fs.calls.dmUid, '4182')
  assert.equal(fs.calls.dmSecUid, 'MS4wSTRANGER', '要靠 secUid 从主页发起新会话')
  assert.deepEqual(fs.calls.dm, ['你好呀'])
  assert.ok(events.some((e) => e.includes('在抖音给')))
  const dry = setup({ owner: OWNER, cfgOver: { dryRun: true } })
  dry.fs.dms = async () => []
  assert.equal((await dry.dy.directDm({ target: 'MS4wX', text: '试运行' })).ok, true)
  assert.equal(dry.fs.calls.dm.length, 0, '试运行不真发')
  const bad = await dy.directDm({ target: '', text: 'x' })
  assert.equal(bad.ok, false)
})

test('主人要视频但挑选模型超时：仍分享已看过的视频，不点赞评论', async () => {
  const { dy, fs, hub } = setup({ owner: OWNER })
  hub.runSystemTurn = async () => { throw new Error('等太久了') }
  const result = await dy.run({ force: true, ownerAsked: true })
  assert.equal(result.ok, true)
  assert.equal(result.shared, 1)
  assert.equal(fs.calls.share.length, 1)
  assert.equal(fs.calls.like.length, 0)
  assert.equal(fs.calls.comment.length, 0)
})

test('发送状态不确定或多句发了一部分时不整轮重试', async () => {
  for (const partial of [false, true]) {
    const t = Date.now()
    const chat = [{ id: 'a', uid: '4182', text: '旧的', at: t - 3600_000 }]
    const { dy, fs, memory } = setup({ owner: OWNER, siteOpts: { chat }, turn: () => partial ? '第一句\n第二句' : '在呢' })
    const notes = []
    memory.noteVia = (entry) => notes.push(entry)
    await dy.checkOwnerDms()
    chat.push({ id: 'b', uid: '4182', text: '在吗', at: t })
    fs.sendDm = async (text) => {
      if (partial && text === '第一句') { fs.calls.dm.push(text); return }
      throw Object.assign(new Error('状态不确定'), { code: 'dm_uncertain' })
    }
    assert.equal((await dy.checkOwnerDms()).ok, false)
    assert.equal((await dy.checkOwnerDms()).replied, 0)
    assert.deepEqual(fs.calls.dm, partial ? ['第一句'] : [])
    assert.deepEqual(notes.filter((n) => n.who === 'bot').map((n) => n.text), partial ? ['第一句'] : [])
    assert.deepEqual(notes.filter((n) => n.who === 'user').map((n) => n.text), ['在吗'])
  }
})

test('私信比较忽略表情和空白但不能把半句当完整', () => {
  assert.equal(site.dmComparable('好呀 👋\n马上去'), site.dmComparable('好呀马上去'))
  assert.notEqual(site.dmComparable('得令 主人的命令最大'), site.dmComparable('得令 主人的命令最大 我这就去'))
})

test('私信里让她去刷、却没刷成：在私信里照实跟主人说一声（以前「我这就去翻」之后就没下文了）', async () => {
  const t = Date.now()
  const chat = [{ id: 'a', uid: '4182', text: '旧的', at: t - 3600_000 }]
  const { dy, fs, prompts } = setup({ owner: OWNER, siteOpts: { chat, feed: [] }, turn: (p) => (/没刷成/.test(p) ? '刚才没刷成 推荐里没刷到新的' : '得令\n[去刷抖音]') })
  await dy.checkOwnerDms()
  chat.push({ id: 'b', uid: '4182', text: '刷会儿抖音给我找个视频', at: t })
  await dy.checkOwnerDms()
  assert.ok(await until(() => fs.calls.dm.length === 2), '先回「得令」，没刷成再说一声')
  assert.deepEqual(fs.calls.dm, ['得令', '刚才没刷成 推荐里没刷到新的'])
  assert.ok(prompts.some((p) => /没刷成/.test(p)))
})
