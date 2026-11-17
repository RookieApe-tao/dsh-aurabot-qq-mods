import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const PAGE_SIZE = 20
const STATS_FILE = 'preview-delivery.json'

function previewBridge(api) {
  const bridge = api.core?.personaMemoryBridge
  const caps = bridge?.capabilities
  return bridge?.api === 1 && bridge.state === 'preview' &&
    Array.isArray(caps) && caps.includes('native-memory-view') && caps.includes('confirmed-delivery') &&
    typeof bridge.readNativeMemory === 'function' && typeof bridge.onDelivery === 'function'
    ? bridge : null
}

function currentScope(config) {
  const owner = String(config.ownerQQ || '')
  const personaId = String(config.persona?.current || '')
  const dataOwner = String(config.persona?.dataOwner || '')
  if (config.safeMode || config.debug || !/^\d+$/.test(owner) ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(personaId) || !/^[a-zA-Z0-9_-]{1,40}$/.test(dataOwner)) return null
  const botQQ = String(config.botQQ || '')
  return { personaId, chatId: 'private:' + owner, botQQ, receive: !config.dryRun && /^\d+$/.test(botQQ) }
}

function readStats(file, scope) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved.scope === scope && Number.isSafeInteger(saved.count) && saved.count >= 1 &&
        Number.isSafeInteger(saved.at) && saved.at > 0 && Number.isFinite(new Date(saved.at).getTime())) {
      return { count: saved.count, at: saved.at }
    }
  } catch (error) {
    // A missing or invalid preview cache does not affect the native memory view.
  }
  return { count: 0, at: null }
}

function saveStats(file, scope, stats) {
  const pending = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(pending, JSON.stringify({ scope, ...stats }) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(pending, file)
  } finally {
    rmSync(pending, { force: true })
  }
}

function offsetFrom(req) {
  const value = new URL(req?.url || '/', 'http://localhost').searchParams.get('offset')
  const offset = Number(value)
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0
}

export default {
  id: 'persona-memory',
  name: '人设记忆预览',
  description: '查看当前人格与主人的私聊原生记忆及确认送达统计。需支持记忆预览的 Aurabot。问题反馈 QQ 1365641547。',
  version: '0.1.0',
  api: 1,
  panel: 'panel.js',
  setup(api) {
    let subscription = null

    function stopDelivery() {
      const previous = subscription
      subscription = null
      previous?.stop()
    }

    function startDelivery(bridge, scope) {
      if (!bridge || !scope?.receive) {
        stopDelivery()
        return
      }
      const key = createHash('sha256').update(JSON.stringify([scope.personaId, scope.chatId, scope.botQQ])).digest('hex')
      if (subscription?.bridge === bridge && subscription.key === key) return
      stopDelivery()
      try {
        const file = api.dataDir(STATS_FILE)
        const next = { key, bridge, stats: readStats(file, key) }
        next.stop = bridge.onDelivery(scope.chatId, receipt => {
          if (subscription !== next || receipt.status !== 'confirmed' || receipt.chatId !== scope.chatId) return
          if (!Number.isSafeInteger(receipt.at) || receipt.at <= 0 || !Number.isFinite(new Date(receipt.at).getTime())) return
          if (next.stats.count >= Number.MAX_SAFE_INTEGER) return
          next.stats = { count: next.stats.count + 1, at: receipt.at }
          try {
            saveStats(file, key, next.stats)
          } catch (error) {
            api.log.warn('人设记忆预览无法保存送达统计。')
          }
        })
        subscription = next
      } catch (error) {
        // The gateway or host can withdraw access. Reading remains independent.
      }
    }

    function sync() {
      const config = api.config()
      const bridge = previewBridge(api)
      const scope = currentScope(config)
      startDelivery(bridge, scope)
      return { bridge, scope, config }
    }

    function unavailable(message) {
      return { ok: true, available: false, message }
    }

    api.route('/state', req => {
      if (req?.method && req.method !== 'GET') return { ok: false, message: '此接口只可读取。' }
      const { bridge, scope, config } = sync()
      if (config.safeMode || config.debug) return unavailable('安全模式或调试模式下无法查看记忆。')
      if (!bridge) return unavailable('需要支持人设记忆预览的 Aurabot 版本。')
      if (!scope) return unavailable('请先设置主人 QQ、当前人格和原生资料归属。')
      const offset = offsetFrom(req)
      let page
      try {
        page = bridge.readNativeMemory(scope.chatId, { offset, limit: PAGE_SIZE })
      } catch (error) {
        return unavailable('当前人格的主人私聊暂不可预览。')
      }
      if (!page || !Array.isArray(page.items)) return unavailable('当前人格的原生记忆暂不可读取。')
      return {
        ok: true,
        available: true,
        personaId: scope.personaId,
        items: page.items.map(({ id, text, at }) => ({ id, text, at })),
        offset,
        nextOffset: page.nextOffset,
        pageSize: PAGE_SIZE,
        delivery: subscription ? { ...subscription.stats } : null,
      }
    }, { access: 'panel' })
    api.on('config', sync)
    api.onDispose(stopDelivery)
    sync()
  },
}
