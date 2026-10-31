// flows.mjs —— 流程库 CRUD（契约 A 节签名仲裁）
// 作用：读写 dataDir/flows.json，提供流程列表 / 查询 / 更新 / 删除 / 触发词匹配。
// 契约：export function createFlows(dataDir)
//   → { list(), get(id), upsert(id, patch), remove(id), findTrigger(text) }

import fs from 'node:fs'
import path from 'node:path'

/** 读取 flows.json（不存在时返回空对象） */
function readFlows(dataDir) {
  const file = path.join(dataDir, 'flows.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 整体写回 flows.json（原子：先写临时文件再改名） */
function writeFlows(dataDir, flows) {
  const file = path.join(dataDir, 'flows.json')
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(flows, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function createFlows(dataDir) {
  /** 列出全部流程（按 id 排序，便于面板与命令输出稳定） */
  const list = () => Object.entries(readFlows(dataDir))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, flow]) => ({ id, ...flow }))

  /** 按 id 取单个流程；不存在返回 null */
  const get = (id) => {
    const flow = readFlows(dataDir)[id]
    return flow ? { id, ...flow } : null
  }

  /** 新建或合并更新一个流程；patch 里缺的旧字段保留 */
  const upsert = (id, patch) => {
    if (!id || typeof id !== 'string') throw new Error('流程 id 不能为空')
    const flows = readFlows(dataDir)
    const prev = flows[id] || {}
    const next = { ...prev, ...patch }
    delete next.id // id 只留在键上，不重复塞进对象里
    if (!next.createdAt) next.createdAt = new Date().toISOString()
    flows[id] = next
    writeFlows(dataDir, flows)
    return { id, ...flows[id] }
  }

  /** 删除流程；返回是否真的删了 */
  const remove = (id) => {
    const flows = readFlows(dataDir)
    if (!(id in flows)) return false
    delete flows[id]
    writeFlows(dataDir, flows)
    return true
  }

  /** 按触发词（triggers 数组）子串匹配消息文本，命中返回流程，否则 null */
  const findTrigger = (text) => {
    if (!text || typeof text !== 'string') return null
    for (const flow of list()) {
      if (flow.enabled === false) continue
      for (const trigger of Array.isArray(flow.triggers) ? flow.triggers : []) {
        if (trigger && text.includes(trigger)) return flow
      }
    }
    return null
  }

  return { list, get, upsert, remove, findTrigger }
}
