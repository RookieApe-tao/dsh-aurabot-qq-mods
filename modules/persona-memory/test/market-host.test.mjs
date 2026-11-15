import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { packModule } from '../../../scripts/lib.mjs'
import definition from '../index.mjs'
import { REQUIRED_CAPABILITIES } from '../lib/service.mjs'

test('an incomplete v1 bridge and a different API version are rejected before binding', async () => {
  for (const candidate of [
    { api: 2, capabilities: REQUIRED_CAPABILITIES },
    { api: 1, capabilities: REQUIRED_CAPABILITIES },
    { api: 1, capabilities: {} },
  ]) {
    let endpoint
    const loaded = definition.setup({
      core: { personaMemoryBridge: { ...candidate, bind: () => assert.fail('partial host was bound') } },
      settings: () => ({ enabled: true }),
      dataDir: () => assert.fail('unavailable host resolved the data path'),
      route(path, handler, options) {
        assert.equal(path, '/state')
        assert.equal(options.access, 'panel')
        endpoint = handler
      },
    })
    try {
      const state = await endpoint()
      assert.equal(state.capabilities.ready, false)
      assert.ok(state.capabilities.missing.length > 0)
      assert.equal(state.active, false)
    } finally {
      loaded.dispose()
    }
  }
})

test('the stock Aurabot installer preserves its native provider and existing archive', {
  skip: !globalThis.aurabot?.src && 'Use scripts/plugin-env.mjs to supply the Aurabot source',
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'persona-memory-stock-'))
  const previous = process.env.AURABOT_DATA_DIR
  const { createModules } = await import(new URL('core/modules.js', globalThis.aurabot.src))
  const { createCommunity } = await import(new URL('core/community.js', globalThis.aurabot.src))
  const savedArchive = join(root, 'modules-data/persona-memory/memory.sqlite')
  let modules
  t.after(async () => {
    modules?.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  process.env.AURABOT_DATA_DIR = root
  const path = fileURLToPath(new URL('../', import.meta.url))
  const packageDir = join(root, 'packages')
  const entry = packModule({ id: definition.id, dir: path }, packageDir)
  const zip = readFileSync(join(packageDir, entry.file))
  const config = { modules: {}, ext: { 'persona-memory': { ...definition.defaults, enabled: true } } }
  const stockProvider = { sentinel: 'native stays loaded' }
  let writes = 0
  const log = { child: () => log, info() {}, warn() {}, error() {} }
  modules = createModules({
    ctx: {}, core: { http: {}, hub: {}, onebot: {} },
    getConfig: () => config, setConfig: () => { writes++ },
    logger: log, version: '1.3.0',
    builtins: [{ id: 'memory', name: 'Native memory test provider', api: 1, setup: () => stockProvider }],
  })
  await modules.boot()
  const registryUrl = 'https://market-test.invalid/index.json'
  const assetsBase = 'https://market-test.invalid/assets/'
  const community = createCommunity({
    mods: modules, getConfig: () => config, setConfig: () => { writes++ },
    log, version: '1.3.0', registryUrl,
    fetcher: async url => {
      if (url === registryUrl) return Response.json({ schema: 1, assetsBase, modules: [entry] })
      assert.equal(url, assetsBase + entry.path)
      return new Response(zip)
    },
  })
  const result = await community.install(definition.id)
  assert.equal(result.ok, true, result.message)
  assert.equal(modules.use('memory'), stockProvider)
  assert.ok(modules.use('persona-memory'))
  const endpoint = '/aurabot/api/ext/persona-memory/'
  assert.equal(modules.hasRoute(endpoint + 'state'), true)
  for (const operation of ['prepare', 'activate', 'reset-preview', 'reset', 'native-activate', 'legacy-import']) {
    assert.equal(modules.hasRoute(endpoint + operation), false)
  }
  assert.equal(existsSync(join(root, 'modules-data/persona-memory')), false)
  assert.equal(modules.use('persona-memory').service.active(), false)

  // Reinstalling from the market must preserve an existing archive even when an
  // incompatible host finds a saved enabled flag.
  mkdirSync(join(root, 'modules-data/persona-memory'), { recursive: true })
  const contents = Buffer.from('existing archive fixture')
  writeFileSync(savedArchive, contents)
  const reinstall = await community.install(definition.id)
  assert.equal(reinstall.ok, true, reinstall.message)
  assert.deepEqual(readFileSync(savedArchive), contents)
  assert.equal(existsSync(savedArchive + '-wal'), false)
  assert.equal(modules.use('memory'), stockProvider)
  assert.equal(writes, 0)
})
