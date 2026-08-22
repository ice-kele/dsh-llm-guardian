import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

async function quotaWindowHelpers() {
  const source = await read('lib/client.js')
  const marker = '\t\texports.inject = inject;'
  const instrumented = source.replace(marker, `\t\texports.__quotaWindowTest = {
\t\t\tcountdownText,
\t\t\tnormalizeUsageTier,
\t\t\tremainingTone,
\t\t\tresetTimestamp,
\t\t\ttierShortName,
\t\t\tusageTiers,
\t\t};
${marker}`)
  assert.notEqual(instrumented, source)
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) { definition = value },
      },
    },
  }
  vm.runInNewContext(instrumented, sandbox, { filename: 'lib/client.js' })
  assert.ok(definition)
  const client = definition.factory(name => ({
    react: { createElement() {} },
    'react-dom': {},
    'react-dom/client': {},
  })[name] || {})
  return client.__quotaWindowTest
}

test('package metadata exposes the host and browser plugins', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.name, 'dsh-llm-guardian')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-api-remotes'], '0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-runtime'], '0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-ui-settings-models'], '0.1.1-rc.2')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-settings'], '0.1.1-rc.2')
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

test('provider quota windows accept CC Switch and existing Guardian fields', async () => {
  const helpers = await quotaWindowHelpers()
  const resetAt = '2026-08-24T08:00:00.000Z'
  assert.deepEqual(
    { ...helpers.normalizeUsageTier({ name: 'five_hour', utilization: 43, resetsAt: resetAt }) },
    {
      name: 'five_hour',
      used: 43,
      remaining: 57,
      total: 100,
      nextResetTime: Date.parse(resetAt),
    },
  )
  assert.deepEqual(
    { ...helpers.normalizeUsageTier({ name: '每周窗口', used: 12, total: 100, nextResetTime: 1_777_000_000 }) },
    {
      name: '每周窗口',
      used: 12,
      remaining: 88,
      total: 100,
      nextResetTime: 1_777_000_000_000,
    },
  )
  assert.equal(helpers.tierShortName('five_hour'), '5h')
  assert.equal(helpers.tierShortName('weekly-limit'), '7d')
})

test('provider quota reset countdown covers minute, hour, day, and elapsed windows', async () => {
  const { countdownText } = await quotaWindowHelpers()
  const now = Date.UTC(2026, 7, 23, 0, 0, 0)
  assert.equal(countdownText(now + 40_000, now), '1分钟后重置')
  assert.equal(countdownText(now + 2 * 3_600_000 + 40 * 60_000, now), '2小时40分后重置')
  assert.equal(countdownText(now + 6 * 86_400_000 + 3 * 3_600_000, now), '6天3小时后重置')
  assert.equal(countdownText(now, now), '即将重置')
  assert.equal(countdownText(0, now), '')
  assert.equal(countdownText(undefined, now), '')
})

test('provider quota risk colors follow CC Switch usage thresholds', async () => {
  const { remainingTone } = await quotaWindowHelpers()
  assert.match(remainingTone(31), /success/u)
  assert.match(remainingTone(30), /warn/u)
  assert.match(remainingTone(10), /error/u)
})
