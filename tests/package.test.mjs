import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('package metadata exposes the host and browser plugins', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.name, 'dsh-llm-guardian')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-api-remotes'], '0.1.0-rc.7')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], '0.1.0-rc.7')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-settings-models'], '0.1.0-rc.7')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-settings'], '0.1.0-rc.7')
  for (const name of Object.keys(manifest.peerDependencies)) {
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true)
  }
})

test('host and client agree on the local API path and public module id', async () => {
  const [host, client] = await Promise.all([read('lib/index.js'), read('lib/client.js')])
  assert.match(host, /\/plugins\/dsh-llm-guardian\/api/u)
  assert.match(client, /\/plugins\/dsh-llm-guardian\/api/u)
  assert.match(client, /id: "dsh-llm-guardian"/u)
  assert.doesNotMatch(host + client, /dsh-llm-guardian-local/u)
})

test('credentials are placeholders rather than committed secrets', async () => {
  const source = await read('lib/client.js')
  assert.match(source, /Authorization: "\{\{apiKey\}\}"/u)
  assert.match(source, /Authorization: "Bearer \{\{apiKey\}\}"/u)
  assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{12,}/u)
})

test('local usage statistics are mounted from the session-query service', async () => {
  const [host, client] = await Promise.all([read('lib/index.js'), read('lib/client.js')])
  assert.match(host, /'sessionQuery'/u)
  assert.match(host, /statsRangeDays/u)
  assert.match(host, /heatmapDays/u)
  assert.match(client, /function UsageSection\(/u)
  assert.match(client, /id: "local-usage-stats"/u)
  assert.match(client, /settings\.section/u)
})
