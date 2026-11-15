import { REQUIRED_CAPABILITIES } from './service.mjs'

// These two capabilities are added by configure() once the module supplies its
// migration and reset participants. The host must provide the others before bind().
const HOST_CAPABILITIES = REQUIRED_CAPABILITIES.filter(
  capability => capability !== 'legacy-import' && capability !== 'reset-participants',
)

const HOST_METHODS = [
  'bind', 'unbind', 'configure', 'persona', 'ownerQQ',
  'prepare', 'activate', 'pause', 'currentScope', 'resetParticipants',
  'prepareNative', 'activateNative', 'previewSessionReset', 'validateSessionReset',
  'clearSessions', 'clearAuxiliary',
]

export function inspectHostBridge(bridge) {
  if (!bridge) {
    return { ready: false, api: 0, missing: ['当前 Aurabot 没有提供记忆宿主接口'] }
  }
  if (bridge.api !== 1) {
    return { ready: false, api: 0, missing: ['当前记忆宿主接口版本不受支持，需要 v1'] }
  }

  const capabilities = new Set(Array.isArray(bridge.capabilities) ? bridge.capabilities : [])
  const missing = HOST_CAPABILITIES.filter(capability => !capabilities.has(capability))
  for (const method of HOST_METHODS) {
    if (typeof bridge[method] !== 'function') missing.push('接口: ' + method)
  }
  if (typeof bridge.root !== 'string' || !bridge.root) missing.push('接口: root')
  return { ready: missing.length === 0, api: 1, missing }
}
