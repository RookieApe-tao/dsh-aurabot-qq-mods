// guides.mjs —— 指引提示词库（工作区的「操作手册」层）
// 作用：按目标应用给工作区里的操作决策器注入 App 专属的操作指引（怎么刷视频/搜索/私信/点赞评论），
//       内容只描述 ADB + uiautomator 节点操作，与任何网页无关。
// 契约：
//   BUILTIN_GUIDES：内置指引（key → { name, packages, keywords, text }）
//   createGuides(dataDir) → { list(), get(key), upsert(key, {name,text,packages,keywords}), remove(key), resolve({ packages, goal }) }
// 自定义指引存 dataDir/guides/<key>.md，可覆盖同名内置项；layout 仿人格分节（总则/操作/坑）。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 内置指引（分节布局：总则 → 操作套路 → 坑） ----------

const DOUYIN_GUIDE = `【抖音 · 操作手册】
◆ 总则
- 刷视频 = 在推荐页反复 scroll down：每滑一屏就是下一个视频，节点清单里没有视频内容文字（画面是渲染层），决策靠当前前台包 + 常驻按钮节点。
- 推荐页右侧一列从上到下常见：头像、点赞（心形，文本多为「喜欢」或数字）、评论、收藏、转发；底部 Tab：首页/朋友/消息/我。
◆ 操作套路
- 看推荐：反复 scroll down，每 3~5 个视频挑一个点赞（tap 右侧心形节点）。连赞会被风控，间隔着来。
- 搜索：tap 底部「首页」旁的放大镜或顶部搜索框 → 节点出现可输入框 → input 关键词 → 找软键盘上的「搜索」按钮 tap（没有就 pressKey enter）→ 结果页 tap 第一个匹配项。
- 私信：底部 Tab「消息」→ 右上角发起新聊天图标 → tap 搜索框 input 对方昵称/抖音号 → 结果列表 tap 对应的人 → 进入会话 tap 底部输入框 → input 文字 → tap「发送」。私信是写操作，会走主人确认。
- 点赞/评论：评论区从视频右侧「评论」节点进入；tap 评论输入框 input 内容后找「发送」。
◆ 坑
- 冷启动常弹「青少年模式」「升级弹窗」，右上角「×」或「我知道了」节点优先关掉。
- 滑动无反应多半是弹层挡住：先 back 一次再看节点。
- input 只能输 ASCII（空格转 %s）；中文/emoji 输入不可用，遇到要输中文改用 finish 说明「需要中文输入，本步无法完成」。
- 出现验证码/登录墙：立即 finish(ok=false)，不要尝试绕过。`

const BILI_GUIDE = `【B站 · 操作手册】
◆ 总则
- 首页是双列卡片流，每张卡片是可点击节点（文本即标题）；底部 Tab：首页/动态/+/会员购/我的。
◆ 操作套路
- 签到：底部「我的」→ 页面里找「签到」节点（活动入口位置常变，找不到就在整个 brief 里搜「签到」两个字）。
- 刷视频：首页 tap 卡片标题进入播放页 → 看完 back 回首页 → tap 下一个。点赞在播放页右侧竖列（点赞/投币/收藏/分享）。
- 搜索：顶部放大镜 → input 关键词 → 软键盘「搜索」→ 结果列表 tap 标题匹配项。
- 三连：播放页右侧依次 tap 点赞 → 投币 → 收藏；投币有确认弹窗，tap「确认」。
◆ 坑
- 大会员/活动横幅常占屏，找右上角关闭节点。
- 播放页节点多（弹幕/进度条/推荐列表混在一起），优先匹配 text 精确的按钮节点。
- input 只能输 ASCII；中文搜索不可用时 finish 说明。`

const XHS_GUIDE = `【小红书 · 操作手册】
◆ 总则
- 首页双列瀑布流，卡片节点带标题文字；底部 Tab：首页/购物/+/消息/我。
◆ 操作套路
- 刷新：下拉用 scroll up（回到顶部出新内容），往下逛用 scroll down。
- 搜索：顶部搜索框 → input 关键词 →「搜索」→ 结果页可再 tap「筛选」按最新排序。
- 发笔记/评论/私信均为写操作，走主人确认；评论区 tap 输入框 input 后点「发送」。
◆ 坑
- 开屏广告优先找「跳过」节点。
- 笔记详情页是半屏卡片，back 一次回列表。
- input 只能输 ASCII；验证码/登录墙立即 finish(ok=false)。`

const GENERIC_GUIDE = `【通用 · 操作手册】
◆ 总则
- 一切决策只依据节点清单（brief）里的 text/desc/cls 与可交互标记；找不到目标节点就先 scroll 或 back 换一屏再看。
◆ 操作套路
- 进应用优先 launch 包名；先看清当前前台包再动作，不在目标应用就先回 home 再 launch。
- 输入：tap 输入框 → input（仅 ASCII，空格自动转 %s）→ 软键盘确认键或找「搜索/发送」按钮。
- 返回层级用 back，回桌面用 home；连续两步 back 没变化说明已在顶层。
◆ 坑
- 弹窗/广告/升级提示优先关闭（找「×」「跳过」「我知道了」「以后再说」）。
- 出现验证码、支付、登录墙：立即 finish(ok=false) 汇报，绝不尝试绕过。
- 节点号是每步重新编号的，动作前必须确认用当步清单里的 n。`

export const BUILTIN_GUIDES = {
  douyin: { name: '抖音', packages: ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite'], keywords: ['抖音', '刷视频', '短视频'], text: DOUYIN_GUIDE },
  bili: { name: 'B站', packages: ['tv.danmaku.bili', 'tv.danmaku.bili_lite'], keywords: ['B站', 'bilibili', '签到', '三连'], text: BILI_GUIDE },
  xhs: { name: '小红书', packages: ['com.xingin.xhs'], keywords: ['小红书', '种草'], text: XHS_GUIDE },
  generic: { name: '通用', packages: [], keywords: [], text: GENERIC_GUIDE },
}

/** 读自定义覆盖层：dataDir/guides/<key>.md 存在则 text 用它，首行 `<!-- name: xxx -->` 可改名 */
function readCustom(dataDir, key) {
  const p = join(dataDir, 'guides', `${key}.md`)
  if (!existsSync(p)) return null
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return null }
  let name = ''
  text = text.replace(/^<!--\s*name:\s*(.+?)\s*-->\s*\n/, (_, n) => { name = n.trim(); return '' })
  return { name, text }
}

function writeCustom(dataDir, key, { name, text }) {
  const dir = join(dataDir, 'guides')
  mkdirSync(dir, { recursive: true })
  const head = name ? `<!-- name: ${name} -->\n` : ''
  writeFileSync(join(dir, `${key}.md`), head + String(text || ''), 'utf8')
}

export function createGuides(dataDir) {
  return {
    /** 全部指引（内置 + 自定义覆盖后的形态），source 标明来源 */
    list() {
      const customKeys = existsSync(join(dataDir, 'guides'))
        ? readdirSync(join(dataDir, 'guides')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
        : []
      const keys = [...new Set([...Object.keys(BUILTIN_GUIDES), ...customKeys])]
      return keys.map((key) => {
        const b = BUILTIN_GUIDES[key]
        const c = readCustom(dataDir, key)
        if (!b && c) return { key, name: c.name || key, source: 'custom', packages: [], keywords: [], text: c.text }
        return { key, name: c?.name || b.name, source: c ? 'custom' : 'builtin', packages: b?.packages || [], keywords: b?.keywords || [], text: c?.text || b.text }
      })
    },
    /** 取一条指引的正文（自定义优先）；generic 永远有 */
    get(key) {
      if (!key || key === 'generic') return BUILTIN_GUIDES.generic.text
      const c = readCustom(dataDir, key)
      if (c?.text) return c.text
      return BUILTIN_GUIDES[key]?.text || null
    },
    /** 新建/覆盖自定义指引（自定义层整体覆盖，删除即回到内置版） */
    upsert(key, { name, text, packages, keywords }) {
      if (!key || !/^[a-z0-9-]{2,40}$/.test(key)) throw new Error('指引 key 只能是小写字母/数字/短横线（2~40 字）')
      writeCustom(dataDir, key, { name, text })
      return { key, name: name || key, source: 'custom', packages: packages || [], keywords: keywords || [], text: String(text || '') }
    },
    /** 删自定义层（回到内置；内置 generic 删不掉） */
    remove(key) {
      const p = join(dataDir, 'guides', `${key}.md`)
      if (!existsSync(p)) return false
      unlinkSync(p)
      return true
    },
    /** 按流程的包名 / 目标关键词挑最合适的指引 key：flow.guide 显式指定 > 包名匹配 > 关键词匹配 > generic */
    resolve({ packages = [], goal = '', flowGuide = '' } = {}) {
      if (flowGuide) return flowGuide
      const pkgList = packages.map(String)
      for (const [key, g] of Object.entries(BUILTIN_GUIDES)) {
        if (key !== 'generic' && g.packages.some((p) => pkgList.includes(p))) return key
      }
      const goalText = String(goal)
      for (const [key, g] of Object.entries(BUILTIN_GUIDES)) {
        if (key !== 'generic' && g.keywords.some((k) => goalText.includes(k))) return key
      }
      return 'generic'
    },
  }
}
