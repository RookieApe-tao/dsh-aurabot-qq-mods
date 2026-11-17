import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { packModule } from '../../../scripts/lib.mjs'
import definition from '../index.mjs'

const source = globalThis.aurabot?.src
const supportsPreview = source && existsSync(fileURLToPath(new URL('core/persona-memory-bridge.js', source)))
const MODULE_ID = 'persona-memory'
const ENDPOINT = '/aurabot/api/ext/' + MODULE_ID + '/state'
const OWNER = '10000001'
const BOT = '20000002'
const CHAT = 'private:' + OWNER
const OTHER = 'private:10000003'
const GROUP = 'group:30000004'

test('the module remains a read-only compatibility panel without the beta bridge', () => {
  let state
  const config = { ownerQQ: OWNER, botQQ: BOT, persona: { current: 'dafeiyu', dataOwner: 'dafeiyu' } }
  definition.setup({
    config: () => config,
    core: {},
    route(path, handle, options) {
      assert.equal(path, '/state')
      assert.equal(options.access, 'panel')
      state = handle
    },
    on() {},
    onDispose() {},
    dataDir() { assert.fail('Incompatible host attempted to open data') },
  })
  assert.equal(state({ method: 'GET' }).available, false)
  assert.equal(state({ method: 'POST' }).ok, false)
})

test('official beta market install previews only the current owner chat and counts real gateway confirmations', {
  skip: !supportsPreview && 'Set AURABOT_PLUGIN_DIR to the official beta source tree',
  timeout: 35_000,
}, async t => {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(join(temp, 'persona-memory-preview-'))
  const env = {
    AURABOT_DATA_DIR: root,
    AURABOT_WORKSPACE: join(root, 'workspace'),
    AURABOT_REGISTRY_URL: 'http://127.0.0.1:9/index.json',
  }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  let fake, mock
  t.after(async () => {
    try {
      fake?.dispose()
      await mock?.close()
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      assert.equal(dirname(await realpath(root)), temp)
      await rm(root, { recursive: true, force: true })
    }
  })
  const hostImport = path => import(new URL(path, source))
  const { createFakeDsh } = await hostImport('../test/helpers/fake-dsh.js')
  const { startMockOneBot } = await hostImport('../test/helpers/mock-onebot.js')
  const { apply } = await hostImport('host.js')
  const { createCommunity } = await hostImport('core/community.js')
  const { personaScope } = await hostImport('persona/personas.js')
  fake = createFakeDsh({ brain: async () => assert.fail('The preview must not invoke a model') })
  mock = await startMockOneBot({ selfId: BOT })
  const privateDir = join(root, 'modules-data', MODULE_ID)
  const legacyFile = join(privateDir, 'memory.sqlite')
  const legacyBytes = Buffer.from('existing enhanced memory archive fixture')
  await mkdir(privateDir, { recursive: true })
  await writeFile(legacyFile, legacyBytes)
  await writeFile(join(root, 'config.json'), JSON.stringify({
    enabled: true, dryRun: false, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    persona: { current: 'dafeiyu', dataOwner: 'dafeiyu' },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'fixture'),
      httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token },
    memory: { enabled: true, auto: false }, modules: { bili: { enabled: false } },
  }))
  const app = apply(fake.ctx)
  await app.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  assert.equal(app.modules.running('memory'), 'builtin')

  const packageDir = join(root, 'packages')
  const entry = packModule({ id: MODULE_ID, dir: fileURLToPath(new URL('../', import.meta.url)) }, packageDir)
  const archive = await readFile(join(packageDir, entry.file))
  const registryUrl = 'https://market-test.invalid/index.json'
  const assetsBase = 'https://market-test.invalid/assets/'
  const { version } = JSON.parse(await readFile(new URL('../package.json', source), 'utf8'))
  const market = createCommunity({
    mods: app.modules, getConfig: app.getConfig, setConfig: app.setConfig, log: app.logger.child('market-test'),
    version, registryUrl, assetsBase,
    fetcher: async url => {
      if (url === registryUrl) return Response.json({ schema: 1, assetsBase, modules: [entry] })
      assert.equal(url, assetsBase + entry.path)
      return new Response(archive)
    },
  })
  const installed = await market.install(MODULE_ID)
  assert.equal(installed.ok, true, installed.message)
  assert.equal(app.modules.running(MODULE_ID), 'user')
  assert.equal(app.modules.routeAccess(ENDPOINT), 'panel')
  const state = (query = '') => app.modules.handle(ENDPOINT, { method: 'GET', url: ENDPOINT + query })

  const originalItems = Array.from({ length: 21 }, (_, n) => app.memory.add({
    chatId: CHAT, about: OWNER, text: '合成记忆 ' + (n + 1),
  }))
  app.memory.add({ chatId: OTHER, text: '另一段私聊' })
  app.memory.add({ chatId: GROUP, text: '群聊资料' })
  app.memory.add({ chatId: CHAT, about: '10000003', text: '其他人物的资料' })
  app.memory.add({ chatId: CHAT, validUntil: Date.now() - 60_000, text: '已过期的记忆' })
  personaScope.run('other-persona', () => app.memory.add({ chatId: CHAT, text: '另一个人格的记忆' }))

  const page = await state('?chatId=' + encodeURIComponent(OTHER))
  assert.equal(page.available, true)
  assert.equal(page.personaId, 'dafeiyu')
  assert.equal(page.items.length, 20)
  assert.equal(page.nextOffset, 20)
  const rest = await state('?offset=20')
  assert.equal(rest.items.length, 1)
  assert.equal(rest.nextOffset, null)
  assert.deepEqual(new Set([...page.items, ...rest.items].map(row => row.id)),
    new Set(originalItems.map(row => row.id)))
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['at', 'id', 'text'])
  assert.equal((await state('?offset=NaN')).offset, 0)
  assert.equal((await app.modules.handle(ENDPOINT, { method: 'POST' })).ok, false)
  for (const path of ['activate', 'reset', 'legacy-import', 'native-activate']) {
    assert.equal(app.modules.hasRoute(ENDPOINT.replace('/state', '/' + path)), false)
  }

  let messageId = -1000
  const onebotCall = app.onebot.call
  app.onebot.call = async (action, params, options) => {
    const result = await onebotCall(action, params, options)
    return action === 'send_private_msg' ? { ...result, message_id: messageId } : result
  }
  const send = (chatId, text) => app.hub.sendSegments(chatId, [{ type: 'text', data: { text } }], text)
  assert.equal((await state()).delivery.count, 0)
  await send(CHAT, '已确认')
  await send(CHAT, '重复网关标识')
  await send(OTHER, '另一个私聊')
  await send(GROUP, '群聊')
  messageId = -1001
  await personaScope.run('other-persona', () => send(CHAT, '另一个人格'))
  await app.modules.emit('chat/delivery', { chatId: CHAT, status: 'confirmed', at: Date.now() })
  assert.equal((await state()).delivery.count, 1)
  const cacheFile = join(privateDir, 'preview-delivery.json')
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), ['at', 'count', 'scope'])
  assert.match(saved.scope, /^[a-f0-9]{64}$/)
  assert.equal(saved.count, 1)

  await app.modules.reload(MODULE_ID)
  assert.equal((await state()).delivery.count, 1)
  messageId = -1002
  await send(CHAT, '重载后的确认')
  assert.equal((await state()).delivery.count, 2)

  const initial = app.getConfig()
  app.setConfig({ ...initial, persona: { ...initial.persona, current: 'other-persona' } })
  const other = await state()
  assert.equal(other.personaId, 'other-persona')
  assert.deepEqual(other.items.map(row => row.text), ['另一个人格的记忆'])
  assert.equal(other.delivery.count, 0)
  app.setConfig({ ...initial, debug: true })
  assert.equal((await state()).available, false)
  app.setConfig({ ...initial, persona: { ...initial.persona, dataOwner: '' } })
  assert.equal((await state()).available, false)
  app.setConfig({ ...initial, safeMode: true })
  assert.notEqual((await state())?.available, true)
  assert.equal(app.modules.running('memory'), 'builtin')
  assert.deepEqual(await readFile(legacyFile), legacyBytes)
  assert.equal(existsSync(legacyFile + '-wal'), false)
})
