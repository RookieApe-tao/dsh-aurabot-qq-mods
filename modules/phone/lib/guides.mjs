// guides.mjs —— 指引提示词库（工作区的「操作手册」层）
// 作用：按目标应用给工作区里的操作决策器注入 App 专属的操作指引（怎么刷视频/搜索/私信/点赞评论），
//       内容只描述 ADB + uiautomator 节点操作，与任何网页无关。
// 契约：
//   BUILTIN_GUIDES：内置指引（key → { name, packages, keywords, text }）
//   createGuides(dataDir) → { list(), get(key), upsert(key, {name,text,packages,keywords}), remove(key), resolve({ packages, goal }) }
// 自定义指引存 dataDir/guides/<key>.md，可覆盖同名内置项；layout 仿人格分节（总则/操作/坑）。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 内置指引（分节布局：总纲（主流程）→ 单应用手册（总则 → 操作套路 → 坑）） ----------

// 主流程总纲：不挂任何 packages/keywords（resolve 永远不会自动挑它），只在「主动逛一轮」
// 或主人显式指定时注入，描述这一轮整体逛什么、怎么排、以什么为主；面板指引列表里置顶可编辑。
const MAIN_GUIDE = `【总纲 · 主流程】
◆ 这份总纲是什么
- 它是「主动逛一轮」的章程：定时主动逛、或主人私聊说「去逛逛手机」时都会注入这份总纲；
  单应用手册（下方各 App 的操作手册）是按当前前台应用按需追加的，两边一起喂给决策器，总纲优先。
- 本总纲不挂包名/关键词，永远不会被自动挑中；只在这类「逛一轮」场合注入。
◆ 总则（逛什么、逛多久）
- 一轮 = 从已安装且在常用列表里的内容应用挑 1~3 个（优先顺序：抖音 → B站 → 小黑盒 → 其他白名单应用），逐个打开各逛一小段。
- 单个应用预算 5~10 分钟（约 10~20 步动作）；一轮总步数预算约 30~60 步，超预算就收尾，宁可少逛不要硬撑。
- 每步先看当前前台包名：不在想逛的应用里就先 home 再 launch 它的目标包名；连续两次 launch 后前台包仍不对，视为该应用打不开，跳过并记录。
- 优先挑这轮还没逛过的应用；同一应用连续出现两次「打不开/卡死」就永久跳过本轮，别反复重试。
◆ 互动尺度（安全红线）
- 主动逛只做「只读 + 轻互动」：浏览、滚动、签到、偶尔点赞（每 3~5 个内容至多赞 1 个）。
- 发帖、评论、私信、关注、投币、打赏等一切写操作默认不做；主人任务里明确要求了才做，且会过安全门确认。
- 遇到验证码、支付、实名、登录墙：立即 finish(ok=false)，在 summary 里说明卡在哪，绝不尝试绕过。
- 深夜时段（主人设置里有的话）或流量/电量告警弹窗出现，说明设备状态异常，直接 finish(ok=false) 收尾。
◆ 操作套路（怎么排一轮）
- 每个应用内部照它自己的操作手册走；没有专属手册的应用按通用手册的基本套路来。
- 同一页面连续两次动作后界面无变化（节点清单几乎没动）：先 back 一次再看，还不动就换应用，别为凑步数反复滑动同一页。
- 页面加载/转场慢时用 wait 等 1~2 秒再看节点，别用空动作硬刷；频道条/引导页要横翻时用 scroll 的 left/right 方向。
- 一个应用逛完（或跳过）就 home 切下一个；别在两个应用之间来回横跳。
◆ 收尾（finish 怎么写）
- 逛完必须用 finish 收尾，summary 里写清：逛了哪几个应用、每个各做了什么（刷了几屏/赞了几个/是否签到成功）、有没有值得告诉主人的事。
- 中途被弹窗/验证码/白名单拦住的，也要在 summary 里如实说原因，别只写「完成」。`

const DOUYIN_GUIDE = `【抖音 · 操作手册】
◆ 总则（界面怎么长）
- 抖音全屏是视频流，画面内容是渲染层，节点清单里基本看不到视频文字；决策只能靠当前前台包 + 常驻按钮节点 + 坐标。
- 推荐页右侧一列自上而下常见节点：头像、点赞（text 多为「喜欢」或纯数字）、评论（text「评论」或数字）、收藏、转发、更多；左下角是作者昵称与文案；底部 Tab：首页 / 朋友 / 消息(+) / 我。
- 节点 brief 形如 [n]按钮"喜欢" 右侧：动作前必须确认用的是当步清单里的 n，节点号每步重新编号。
◆ 操作套路（常用任务拆解）
- 刷推荐：反复 scroll down，一滑一屏即下一个视频；每 3~5 个视频挑一个点赞——tap 右侧「喜欢」节点，点赞成功后数字 +1 或节点变红（下一步 brief 可验证）。连赞会被风控，务必间隔着来。
- 双击点赞：视频是渲染层没有双击手势节点，用 double_tap 点画面中部（n 或截图模式 xy；动作内部自带两次快速点击，间隔 80ms）；效果等同双击点赞，比右侧节点更贴近真人操作，但别连发（会被风控）。双击也可能触发暂停/播放，做完看下一步 brief 验证。
- 搜索：tap 底部 Tab「首页」后再 tap 顶部放大镜/搜索框（或「我」页右上角放大镜）→ brief 出现可输入框节点 → tap 它 → input 关键词（仅 ASCII，空格自动转 %s）→ 软键盘上找「搜索」按钮 tap；软键盘没有搜索键就 key enter（回车等价搜索）。结果页 tap 标题/头像匹配的项进入。
- 私信：底部 Tab「消息」→ tap 右上角发起新聊天图标 → tap 搜索框 → input 对方昵称/抖音号 → 结果列表 tap 对应的人 → 进会话 tap 底部输入框 → input 内容 → tap「发送」按钮。私信是写操作，会走主人确认门，被拦就如实 finish 说明。
- 关注：进对方主页 → tap「关注」按钮节点；关注是写操作，默认不做。
- 评论：tap 视频右侧「评论」节点 → 底部弹出评论列表 → tap 评论输入框 → input 内容（仅 ASCII）→ tap「发送」。评论是写操作，走确认。
- 退出/切换：看完一个视频想换人，back 会退到上级页；直接换视频用 scroll down，别用 back。
◆ 坑（高频翻车点）
- 冷启动常弹：青少年模式引导、版本升级、活动横幅——优先找「我知道了」「×」「以后再说」「跳过」节点关掉；找不到关闭节点就 back 一次再看 brief。
- 滑动无反应多半是弹层挡住：先 back 再 scroll；连续两次无变化就换应用。
- input 只能输 ASCII，中文/emoji 输入不可用：要输中文搜索词时，改用拼音无空格形式（如 "xiaoheshou"）或 finish 说明「需要中文输入，本步无法完成」。
- 直播间/购物页不是目标时直接 back 退出；误入直播别停留刷礼物。长按视频画面（long_press）会弹「不感兴趣/一起看」菜单，误触就 tap 空白处或 back 关掉，别乱选。
- 出现验证码、人脸、登录墙：立即 finish(ok=false)，绝不尝试绕过（验证码滑块也绝不能用 drag 去拖）。`

const BILI_GUIDE = `【B站 · 操作手册】
◆ 总则（界面怎么长）
- 首页是双列卡片流，每张卡片是可点击节点（文本即视频标题）；底部 Tab：首页 / 动态 / +（发布）/ 会员购 / 我的。
- 播放页：视频区在上，下方是标题/UP主/简介，右侧竖列依次是点赞 / 投币 / 收藏 / 分享；再往下是评论区和推荐列表；弹幕、进度条在视频区内，节点多而杂。
- 「我的」页有个人中心各入口：离线缓存 / 历史 / 我的收藏 / 大会员 / 创作中心等，签到类活动入口通常挂在「我的」页或其子页里。
◆ 操作套路（常用任务拆解）
- 签到：底部「我的」→ 在整段 brief 里搜「签到」两个字（活动入口位置随版本/活动变化，可能在「我的」页直接有，也可能在大会员/活动子页）；找到就 tap，进活动页完成签到动作；找不到「签到」节点就 scroll 一下「我的」页再搜，两轮还没有就 finish 说明「本次没找到签到入口」。
- 刷视频：首页 tap 卡片标题节点进入播放页 → 「看」一会儿（可空转 1~2 步或不动作）→ back 回首页 → tap 下一个；每 3~5 个赞一个（tap 播放页右侧点赞节点）。
- 三连：播放页右侧依次 tap 点赞 → 投币 → 收藏；投币会弹确认框（选币数），tap「确认」；三连是写操作，只有主人明确要求才做，走确认门。
- 搜索：顶部放大镜节点 → tap 输入框 → input 关键词（仅 ASCII）→ 软键盘「搜索」；软键盘没搜索键就 key enter → 结果列表 tap 标题匹配项；综合/视频 Tab 默认即可。改词用 clear 清空再 input。
- 动态页：底部「动态」→ 卡片流 tap 标题进详情；给 UP 主点动态点赞在详情页。
- 追番/影视：首页顶部频道条横向区域找分类节点 tap；频道条横向翻用 scroll left/right（不是上下滑），一屏没找到目标分类就再横滑一屏。
- 播放器内：长按画面（long_press，ms 给 1000~1500）是 2 倍速播放，看完记得松开动作自然结束；进度条微调用 drag 从当前位置小步拖（不熟练就别调，误触清屏反而费步）。
◆ 坑（高频翻车点）
- 大会员促销、活动横幅常占大半屏：优先找「×」或「关闭」节点；找不到就 back 一次再看。
- 播放页节点最多（弹幕开关/进度条/清晰度/推荐列表混在一起）：动作前务必精确匹配 text 的按钮节点，别拿推荐视频标题当按钮点。
- 投币确认弹窗出现「硬币不足」时 tap「取消」，别硬点确认。
- input 只能输 ASCII；中文搜索词改拼音或 finish 说明。
- 验证码、登录墙：立即 finish(ok=false)。`

const HEYBOX_GUIDE = `【小黑盒 · 操作手册】
◆ 总则（界面怎么长）
- 首页是信息流卡片（游戏资讯/攻略/帖子/视频），卡片节点带标题文字；底部 Tab：首页（盒子）/ 社区 / +（发布）/ 消息 / 我。
- 社区页顶部有频道切换（推荐/热帖/版块），找帖子优先在「社区」Tab 里翻；「我」页有任务/福利/等级等个人中心入口。
◆ 操作套路（常用任务拆解）
- 签到：底部「我」→ 在整段 brief 里搜「签到」（入口常在任务/福利区，位置随活动变化，可能叫「每日签到」「签到有礼」）；tap 进入福利/任务页后再找「签到」按钮 tap；两轮没搜到就 scroll「我」页再搜，还没有就 finish 说明。
- 刷帖子：首页或社区 tap 卡片标题进详情 → 看完 back 回列表 → tap 下一个；详情页底部有点赞/收藏/评论入口。
- 点赞：详情页底部「点赞」节点（心形图标，text 可能是数字）；连赞会被风控，间隔着来。
- 评论：详情页底部「评论」输入框 → tap → input 内容（仅 ASCII）→ 找「发送」；评论是写操作，走主人确认。
- 搜索：顶部放大镜 → tap 输入框 → input 关键词 → 软键盘「搜索」；软键盘没搜索键就 key enter → 结果列表 tap 标题匹配项；结果页有「综合/攻略/帖子」分类，默认综合即可，分类切换用 tap 分类节点。
- 频道横滑：社区页顶部频道条（推荐/热帖/版块）若一屏没显示全，用 scroll left/right 横向翻，别用上下滑。
- 领福利/做任务：福利页里按节点文本逐个 tap（如「领取」「去完成」）；涉及跳转第三方或支付的一律 back 退出不做。
◆ 坑（高频翻车点）
- 开屏活动弹窗优先找「×」「跳过」「以后再说」「我知道了」关掉；找不到就 back。
- 帖子内嵌图片/视频区域点不出节点：tap 标题或正文文字区域即可，别点图片。
- 游戏库/加速器页不是目标时直接 back；绝不去碰下载/加速按钮（写操作且可能大流量）。
- input 只能输 ASCII；中文输入不可用时 finish 说明。
- 验证码、登录墙、实名认证：立即 finish(ok=false)，绝不尝试绕过。`

const GENERIC_GUIDE = `【通用 · 操作手册（自定义指引请照此结构仿写）】
◆ 写给要自定义指引的人：仿写模板
- 新指引按本节的三段结构写：总则（界面怎么长）→ 操作套路（常用任务拆解）→ 坑（高频翻车点）；一段都别省。
- 只描述 ADB + 节点操作，与网页无关；不确定的界面细节写「位置可能变化，在 brief 里搜 XX 两个字」，别编造精确坐标。
- 每条套路尽量写成「入口 → 中间步骤 → 验证」三拍，验证写清下一步 brief 里该出现什么（如「点赞后数字 +1」）。
- 写操作（评论/私信/关注/发帖/支付）必须标注「走主人确认」，并写明被安全门拦住时如何如实 finish。
◆ 总则（决策器视角的界面观）
- 一切决策只依据节点清单 brief：形如 [n]按钮"发布" 底部中央，n 是当步节点号，每步重新编号；text/desc/位置与「可输入/可滚动」标记是全部线索。
- 当前一步共 13 种动作：tap（n 或截图模式 xy）、input（text，仅 ASCII）、clear（清空聚焦输入框）、drag（to:[x,y] 或 to_n 终点，ms 可选）、scroll（dir: up|down|left|right，ms 可选）、key（name: enter/tab/volume_up/volume_down/power/notifications）、wait（ms，500~10000）、back、home、launch（pkg 包名）、double_tap（n 或 xy）、long_press（n 或 xy，ms 可选默认 800）、finish（ok + summary）。
- 界面拿不到节点时会切换截图兜底模式：那时 tap 用像素坐标 xy（原点左上），看不清就 finish 别猜坐标。
◆ 操作套路（通用流程骨架）
- 进应用：home → launch 包名；下一步确认前台包名对不对，连续两次不对就放弃该应用。
- 找入口：先扫一遍 brief 找 text 精确匹配；没有就 scroll down 换屏再看；有层级就 back 一层再看。
- 输入：tap 输入框（brief 标「可输入」）→ input（仅 ASCII，空格自动转 %s）→ 软键盘上找「搜索/发送/完成」按钮 tap；软键盘没出现在 brief 里就再 tap 一次输入框，还没有就 key enter（回车常等价搜索/发送）。
- 改搜索词：直接 clear（或 tap 输入框聚焦后 clear）→ input 新词 → key enter，别长按选字再删。
- 等待：页面加载/转场/弹窗没出齐时先 wait（如 1500）再看下一步 brief，别盲 scroll 或乱 tap 浪费步数。
- 返回：back 退一级，home 回桌面；连续两步 back 界面无变化说明已在顶层。
- 验证：关键动作（点赞/签到）执行后，下一步 brief 里应有变化（数字 +1、按钮文案变「已签到」）；没变化视为失败，重试一次后如实 finish。
◆ 坑（通用安全与失败处理）
- 弹窗/广告/升级提示优先关闭：找「×」「跳过」「我知道了」「以后再说」；找不到就 back 一次再看 brief。
- 深链接/外跳浏览器或应用商店：一律 back 回来，不点「下载」「安装」「打开」。
- 出现验证码、支付、人脸、登录墙、实名：立即 finish(ok=false) 汇报，绝不尝试绕过（验证码滑块也绝不能用 drag 去拖，drag 只用于普通界面内的拖拽交互）。
- 同一动作连续两次无效（节点没变/界面没动）：停止重试，换路径或 finish 说明原因。
- 步数预算过半还没接近目标：在 summary 里写清进度再决定继续还是收尾，别等步数耗尽被硬中止。`

export const BUILTIN_GUIDES = {
  main: { name: '总纲·主流程', packages: [], keywords: [], text: MAIN_GUIDE },
  douyin: { name: '抖音', packages: ['com.ss.android.ugc.aweme', 'com.ss.android.ugc.aweme.lite'], keywords: ['抖音', '刷视频', '短视频'], text: DOUYIN_GUIDE },
  bili: { name: 'B站', packages: ['tv.danmaku.bili', 'tv.danmaku.bili_lite'], keywords: ['B站', 'bilibili', '签到', '三连'], text: BILI_GUIDE },
  heybox: { name: '小黑盒', packages: ['com.max.xiaoheihe'], keywords: ['小黑盒', 'heybox'], text: HEYBOX_GUIDE },
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
    /** 删自定义层（回到内置；内置 generic 删不掉）。
     *  key 白名单（复审 P0-1）：key 直接拼路径，`../../xxx` 能删任意 .md。 */
    remove(key) {
      const k = String(key || '')
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) return false
      const p = join(dataDir, 'guides', `${k}.md`)
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
