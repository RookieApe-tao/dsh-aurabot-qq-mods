// memory.mjs —— 单段流程记忆（契约 A 节签名仲裁）
// 作用：每个流程（含临时 adhoc 流程）在 dataDir/memory/<key>.json 存一段「可复用操作经验」；
//       每次工作区收尾用 ctx.ask 把旧 summary 与本次 runLog 合并成 ≤300 字新经验，整体覆盖。
// 契约：export function createMemory({ dataDir, ask })
//   → { load(key), save(key, { runLog:{steps,ok,summary}, goal }), clear(key) }
//   save 返回写入后的记忆对象；adhoc 流程 runs>=10 时附 promoteHint。

import fs from 'node:fs'
import path from 'node:path'

const SUMMARY_LIMIT = 300 // 经验字数上限

/** 经验截断到上限（超长从尾部裁，保留前段主经验） */
function clamp(text) {
  const s = String(text || '').trim()
  return s.length <= SUMMARY_LIMIT ? s : s.slice(0, SUMMARY_LIMIT)
}

// 隐私过滤：「禁止存密码/Cookie」不能只是 README 里的一句话（复审第 10 条）——写盘前先把
// 密码/验证码/Cookie/Token/口令 之类连着的值遮掉，避免模型把敏感串写进经验。
const SECRET = /(密码|验证码|cookie|token|口令|账号)[^\s，。；,;、]{0,30}/gi
function scrub(text) {
  return String(text || '').replace(SECRET, '$1（已隐藏）')
}

export function createMemory({ dataDir, ask = async () => '' }) {
  const fileOf = (key) => path.join(dataDir, 'memory', `${key}.json`)

  /** 读取一段记忆；不存在/损坏返回 null */
  const load = (key) => {
    try {
      return JSON.parse(fs.readFileSync(fileOf(key), 'utf8'))
    } catch {
      return null
    }
  }

  /** 删除一段记忆；返回是否真的删了 */
  const clear = (key) => {
    try {
      fs.unlinkSync(fileOf(key))
      return true
    } catch {
      return false
    }
  }

  /** 收尾写入：ask 合并总结 → 整体覆盖，runs 递增 */
  const save = async (key, { runLog = {}, goal = '' } = {}) => {
    const prev = load(key) || {}
    const runs = (Number(prev.runs) || 0) + 1
    // 让模型把旧经验与本次运行结果合并成新的 ≤300 字经验
    let summary = ''
    try {
      const prompt = [
        `这是一个手机自动化流程的历史经验更新任务。`,
        `目标：${goal || prev.goal || key}`,
        `旧经验：${prev.summary || '（无，这是第一次运行）'}`,
        `本次运行：共 ${runLog.steps ?? 0} 步，${runLog.ok ? '成功' : '未完成'}。`,
        `本次经过：${runLog.summary || '（无描述）'}`,
        `请把旧经验与本次运行合并成一段不超过300字的可复用操作经验：`,
        `保留仍然有效的点击路径、界面坑位、重试办法；删掉过时内容；不要寒暄，直接给经验正文。`,
      ].join('\n')
      summary = scrub(clamp(await ask(prompt)))
    } catch (e) {
      // 总结失败不丢数据：退化为旧经验 + 本次一句话
      summary = scrub(clamp(`${prev.summary || ''}（本次：${runLog.summary || '运行' + (runLog.ok ? '成功' : '失败')}）`))
    }
    const mem = {
      key,
      goal: goal || prev.goal || key,
      updated: new Date().toISOString(),
      runs,
      summary,
      lastRun: { at: new Date().toISOString(), steps: runLog.steps ?? 0, ok: !!runLog.ok },
    }
    // 临时流程跑得多了，提示固化为正式流程
    if (key.startsWith('adhoc') && runs >= 10) {
      mem.promoteHint = `该临时流程已运行 ${runs} 次，建议用 phone flow add 固化为正式流程`
    }
    fs.mkdirSync(path.dirname(fileOf(key)), { recursive: true })
    const tmp = fileOf(key) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8')
    fs.renameSync(tmp, fileOf(key))
    return mem
  }

  return { load, save, clear }
}
