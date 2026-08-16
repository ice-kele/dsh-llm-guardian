/**
 * Local model API guardian.
 *
 * Besides health polling and local token quotas, this package runs an optional
 * provider-scoped usage script. The script may only describe one same-origin
 * HTTP request and synchronously extract JSON; the Host owns credentials,
 * networking, timeouts, and persistence.
 */
import { Script, createContext } from 'node:vm';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

const NS = settingsNamespace('llm-guardian');
const API_PATH = '/plugins/dsh-llm-guardian/api';
const MAX_SCRIPT_BYTES = 50_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 64_000;

const ZAI_CODING_CN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const ZAI_CODING_CN_USAGE_CODE = `({
  request: {
    url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    method: "GET",
    headers: {
      Authorization: "{{apiKey}}",
      "Content-Type": "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9"
    }
  },
  extractor(response) {
    const data = response && response.data && typeof response.data === "object" ? response.data : {};
    const source = Array.isArray(data.limits) ? data.limits : [];
    const tiers = source
      .filter(function (item) {
        const type = String(item && item.type || "").toUpperCase();
        return type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
      })
      .map(function (item, index) {
        const raw = Number(item.percentage);
        const used = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
        const unit = Number(item.unit);
        return {
          name: unit === 3 ? "5 小时窗口" : unit === 6 ? "每周窗口" : "额度 " + (index + 1),
          used: used,
          remaining: 100 - used,
          total: 100,
          nextResetTime: Number(item.nextResetTime) || 0
        };
      });
    const primary = tiers.find(function (tier) { return tier.name === "5 小时窗口"; }) || tiers[0];
    const valid = response && response.success !== false && Boolean(primary);
    return {
      isValid: valid,
      invalidMessage: valid ? "" : String(response && (response.msg || response.message) || "未返回 Coding Plan 额度"),
      planName: data.level ? "智谱 " + String(data.level) : "智谱 Coding Plan",
      ...(primary ? {
        remaining: primary.remaining,
        used: primary.used,
        total: primary.total,
        unit: "%"
      } : {}),
      extra: { tiers: tiers }
    };
  }
})`;

const SCHEMA = z.object({
  enabled: z.boolean().default(true),
  healthCheckIntervalMs: z.number().default(60_000),
  healthTimeoutMs: z.number().default(15_000),
  providers: z.dict(z.object({
    limitTokens: z.number(),
    usedTokens: z.number().default(0),
  })).default({}),
  status: z.dict(z.object({
    ok: z.boolean().default(false),
    error: z.string(),
    checkedAt: z.number().default(0),
  })).default({}),
  probeRequests: z.dict(z.number()).default({}),
  usageScripts: z.dict(z.object({
    enabled: z.boolean().default(false),
    showInProvider: z.boolean().default(true),
    code: z.string(),
    timeoutMs: z.number().default(10_000),
    autoQueryIntervalMs: z.number().default(0),
  })).default({}),
  usageResults: z.dict(z.object({
    ok: z.boolean().default(false),
    error: z.string(),
    queriedAt: z.number().default(0),
    isValid: z.boolean().default(true),
    invalidMessage: z.string(),
    remaining: z.number(),
    used: z.number(),
    total: z.number(),
    unit: z.string(),
    planName: z.string(),
    extraJson: z.string(),
  })).default({}),
  usageRunRequests: z.dict(z.number()).default({}),
});

export const name = 'llm-guardian';
export const inject = ['timer', 'llm', 'settings', 'credentials', 'webServer'];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new Error('content-type must be application/json');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 128_000) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function boundedString(value, max = 500) {
  return String(value ?? '').slice(0, max);
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function localHttp(url) {
  return url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
}

function replacePlaceholders(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(apiKey|baseUrl|providerId)\}\}/g, (_match, name) => variables[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(item => replacePlaceholders(item, variables));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, variables)]));
  }
  return value;
}

function readRequestAndExtractor(code) {
  if (typeof code !== 'string' || code.trim() === '') throw new Error('usage script is empty');
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) throw new Error('usage script is too large');
  const sandbox = Object.create(null);
  const context = createContext(sandbox, {
    name: 'llm-guardian-usage',
    codeGeneration: { strings: false, wasm: false },
  });
  const declaration = new Script(`"use strict"; globalThis.__usage = (${code}\n);`, {
    filename: 'usage-query.js',
  });
  declaration.runInContext(context, { timeout: 500 });
  const requestJson = new Script('JSON.stringify(globalThis.__usage && globalThis.__usage.request)')
    .runInContext(context, { timeout: 200 });
  if (typeof requestJson !== 'string') throw new Error('script must return a request object');
  const request = JSON.parse(requestJson);
  const extractorType = new Script('typeof (globalThis.__usage && globalThis.__usage.extractor)')
    .runInContext(context, { timeout: 100 });
  if (extractorType !== 'function') throw new Error('script must provide extractor(response)');
  return { context, request };
}

function normalizeRequest(raw, variables, timeoutMs) {
  const request = replacePlaceholders(raw, variables);
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('script request must be an object');
  }
  const method = String(request.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error('usage request method must be GET or POST');
  const endpoint = new URL(String(request.url ?? ''));
  if (endpoint.protocol !== 'https:' && !localHttp(endpoint)) {
    throw new Error('usage request must use HTTPS (HTTP is allowed only for loopback)');
  }
  const providerBase = new URL(variables.baseUrl);
  if (endpoint.origin !== providerBase.origin) {
    throw new Error('usage request must use the provider endpoint origin');
  }
  const headers = {};
  if (request.headers !== undefined) {
    if (request.headers === null || typeof request.headers !== 'object' || Array.isArray(request.headers)) {
      throw new Error('usage request headers must be an object');
    }
    const entries = Object.entries(request.headers);
    if (entries.length > 32) throw new Error('usage request has too many headers');
    for (const [name, value] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('usage request has an invalid header name');
      const text = String(value);
      if (text.length > 8_192 || /[\r\n]/.test(text)) throw new Error('usage request has an invalid header value');
      headers[name] = text;
    }
  }
  let body;
  if (request.body !== undefined) {
    if (method !== 'POST') throw new Error('usage request body requires POST');
    body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (Buffer.byteLength(body, 'utf8') > 256_000) throw new Error('usage request body is too large');
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return {
    endpoint,
    method,
    headers,
    body,
    timeoutMs: Math.max(2_000, Math.min(30_000, Number(timeoutMs) || 10_000)),
  };
}

async function readLimitedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('usage response is too large');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('usage response is too large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('usage response is too large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function extractUsageResult(context, responseBody) {
  context.__responseJson = JSON.stringify(responseBody);
  const resultJson = new Script(`
    JSON.stringify(globalThis.__usage.extractor(JSON.parse(globalThis.__responseJson)))
  `).runInContext(context, { timeout: 1_000 });
  if (typeof resultJson !== 'string') throw new Error('extractor must return an object');
  if (Buffer.byteLength(resultJson, 'utf8') > MAX_RESULT_BYTES) throw new Error('extractor result is too large');
  const raw = JSON.parse(resultJson);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('extractor must return an object');
  }
  const remaining = finiteNumber(raw.remaining);
  const used = finiteNumber(raw.used);
  const total = finiteNumber(raw.total);
  if (remaining === undefined && used === undefined && total === undefined && raw.extra === undefined) {
    throw new Error('extractor must return remaining, used, total, or extra');
  }
  const extraJson = raw.extra === undefined ? '' : JSON.stringify(raw.extra).slice(0, 8_000);
  return {
    ok: true,
    error: '',
    queriedAt: Date.now(),
    isValid: raw.isValid !== false,
    invalidMessage: boundedString(raw.invalidMessage),
    ...(remaining === undefined ? {} : { remaining }),
    ...(used === undefined ? {} : { used }),
    ...(total === undefined ? {} : { total }),
    unit: boundedString(raw.unit, 40),
    planName: boundedString(raw.planName, 120),
    extraJson,
  };
}

export function apply(ctx) {
  const scope = ctx.settings.register(NS, SCHEMA, { applies: 'live' });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, value: scope.get() });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (!body || !Array.isArray(body.ops) || body.ops.length > 128) {
          throw new Error('ops must be an array with at most 128 entries');
        }
        await ctx.settings.mutate(NS, body.ops);
        writeJson(res, 200, { ok: true, value: scope.get() });
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorMessage(error) });
      }
    },
  }), 'llm-guardian: local configuration API');

  const health = new Map();
  const used = new Map();
  const baseline = new Map();
  const persistedStatus = new Map();
  const probeBaseline = new Map();
  const usageRequestBaseline = new Map();
  const usageRunning = new Set();
  const lastAutoQuery = new Map();
  let requestsLive = false;
  let cfg = scope.get();

  function syncConfig() {
    cfg = scope.get();
    for (const [providerId, provider] of Object.entries(cfg.providers ?? {})) {
      if (!baseline.has(providerId)) {
        const value = provider.usedTokens ?? 0;
        baseline.set(providerId, value);
        used.set(providerId, value);
      } else {
        const disk = provider.usedTokens ?? 0;
        if (disk < baseline.get(providerId)) used.set(providerId, disk);
        baseline.set(providerId, disk);
      }
    }
    for (const [providerId, requestedAt] of Object.entries(cfg.probeRequests ?? {})) {
      const previous = probeBaseline.get(providerId);
      probeBaseline.set(providerId, requestedAt);
      if (requestsLive && (previous === undefined || requestedAt > previous)) void checkProvider(providerId);
    }
    for (const [providerId, requestedAt] of Object.entries(cfg.usageRunRequests ?? {})) {
      const previous = usageRequestBaseline.get(providerId);
      usageRequestBaseline.set(providerId, requestedAt);
      if (requestsLive && (previous === undefined || requestedAt > previous)) void runUsageQuery(providerId);
    }
  }

  ctx.effect(() => scope.watch(() => {
    syncConfig();
  }));


  function readProfile(providerId) {
    const entry = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === providerId);
    if (!entry) return null;
    const section = ctx.settings.get(entry.settingsNs);
    let profile = section;
    for (const key of entry.settingsPath) {
      if (profile == null) return null;
      profile = profile[key];
    }
    if (profile == null) return null;
    return { entry, profile };
  }

  async function resolveApiKey(profile) {
    if (!profile.apiKeyEnv) return undefined;
    const resolved = await ctx.credentials.resolve(profile.apiKeyEnv);
    return resolved ? resolved.value : undefined;
  }

  function providerBaseUrl(entry, profile) {
    if (profile.baseURL) return String(profile.baseURL).replace(/\/+$/, '');
    if (entry.provider === 'zai-coding-cn') return ZAI_CODING_CN_BASE_URL;
    if (entry.settingsNs === 'llm-deepseek') return 'https://api.deepseek.com';
    return '';
  }

  function effectiveUsageCode(providerId, configuredCode) {
    if (providerId === 'zai-coding-cn'
      && (!configuredCode || configuredCode.includes('{{baseUrl}}/usage'))) {
      return ZAI_CODING_CN_USAGE_CODE;
    }
    return configuredCode;
  }

  async function persistStatus(providerId) {
    const status = health.get(providerId);
    if (!status) return;
    const signature = `${status.ok}::${status.error ?? ''}::${status.checkedAt}`;
    if (persistedStatus.get(providerId) === signature) return;
    persistedStatus.set(providerId, signature);
    try {
      await ctx.settings.mutate(NS, [{
        op: 'set',
        path: ['status', providerId],
        value: { ok: status.ok, error: status.error ?? '', checkedAt: status.checkedAt },
      }]);
    } catch {
      persistedStatus.delete(providerId);
    }
  }

  async function clearPersistedStatus(providerId) {
    health.delete(providerId);
    persistedStatus.delete(providerId);
    if (cfg.status?.[providerId] === undefined) return;
    try {
      await ctx.settings.mutate(NS, [{ op: 'unset', path: ['status', providerId] }]);
    } catch {
      // A cleanup failure must not turn an unprobeable provider into a failed one.
    }
  }

  async function probeDeepSeekModels(profile, apiKey) {
    if (!apiKey) throw new Error('missing API key for health check');
    const baseURL = profile.baseURL || 'https://api.deepseek.com';
    const endpoint = new URL(`${String(baseURL).replace(/\/+$/, '')}/models`);
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data)) throw new Error('health endpoint returned an invalid model list');
  }

  async function discoverOrProbe(entry, profile, request, apiKey) {
    try {
      await ctx.llm.discoverModels(entry.settingsNs, request);
      return true;
    } catch (error) {
      if (error?.code !== 'NO_DISCOVERY') throw error;
      if (entry.settingsNs !== 'llm-deepseek') return false;
      await probeDeepSeekModels(profile, apiKey);
      return true;
    }
  }

  async function checkProvider(providerId) {
    const info = readProfile(providerId);
    if (!info) {
      health.set(providerId, { ok: false, checkedAt: Date.now(), error: 'no profile' });
      await persistStatus(providerId);
      return;
    }
    const { entry, profile } = info;
    const apiKey = await resolveApiKey(profile);
    try {
      const request = {
        provider: providerId,
        ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
        ...(profile.api ? { api: profile.api } : {}),
        ...(apiKey ? { apiKey } : {}),
      };
      const probeable = await Promise.race([
        discoverOrProbe(entry, profile, request, apiKey),
        ctx.timeout(cfg.healthTimeoutMs ?? 15_000).then(() => { throw new Error('health check timeout'); }),
      ]);
      if (!probeable) {
        await clearPersistedStatus(providerId);
        return;
      }
      health.set(providerId, { ok: true, checkedAt: Date.now(), error: '' });
    } catch (error) {
      health.set(providerId, { ok: false, checkedAt: Date.now(), error: errorMessage(error) });
    }
    await persistStatus(providerId);
  }

  let checking = false;
  async function runHealthCheck() {
    if (checking) return;
    checking = true;
    try {
      if (cfg.enabled === false) return;
      for (const provider of ctx.llm.listProviders()) {
        try { await checkProvider(provider.id); } catch { /* One failure does not stop the remaining probes. */ }
      }
    } finally {
      checking = false;
    }
  }

  async function persistUsageResult(providerId, result) {
    await ctx.settings.mutate(NS, [{ op: 'set', path: ['usageResults', providerId], value: result }]);
  }

  function redactedError(error, secrets) {
    let message = errorMessage(error);
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length >= 3) message = message.split(secret).join('[REDACTED]');
    }
    return boundedString(message);
  }

  async function runUsageQuery(providerId) {
    if (usageRunning.has(providerId)) return;
    usageRunning.add(providerId);
    let apiKey;
    let baseUrl = '';
    try {
      const info = readProfile(providerId);
      if (!info) throw new Error('provider profile is unavailable');
      const config = cfg.usageScripts?.[providerId];
      const code = effectiveUsageCode(providerId, config?.code);
      if (!code) throw new Error('usage script is not configured');
      apiKey = await resolveApiKey(info.profile);
      baseUrl = providerBaseUrl(info.entry, info.profile);
      if (!baseUrl) throw new Error('provider base URL is unavailable');
      const { context, request: rawRequest } = readRequestAndExtractor(code);
      const request = normalizeRequest(rawRequest, {
        apiKey: apiKey ?? '',
        baseUrl,
        providerId,
      }, config.timeoutMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
      let response;
      try {
        response = await fetch(request.endpoint, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`);
      const text = await readLimitedText(response);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error('usage endpoint did not return JSON'); }
      const result = extractUsageResult(context, payload);
      await persistUsageResult(providerId, result);
      lastAutoQuery.set(providerId, result.queriedAt);
    } catch (error) {
      const result = {
        ok: false,
        error: redactedError(error, [apiKey, baseUrl]),
        queriedAt: Date.now(),
        isValid: false,
        invalidMessage: '',
        unit: '',
        planName: '',
        extraJson: '',
      };
      try { await persistUsageResult(providerId, result); } catch { /* Keep the Host alive if persistence also fails. */ }
      lastAutoQuery.set(providerId, result.queriedAt);
    } finally {
      usageRunning.delete(providerId);
    }
  }

  function runAutomaticUsageQueries() {
    const now = Date.now();
    for (const [providerId, config] of Object.entries(cfg.usageScripts ?? {})) {
      const interval = Number(config.autoQueryIntervalMs) || 0;
      if (!config.enabled || !config.code || interval < 60_000) continue;
      const persistedAt = cfg.usageResults?.[providerId]?.queriedAt ?? 0;
      const last = Math.max(lastAutoQuery.get(providerId) ?? 0, persistedAt);
      if (now - last >= interval) void runUsageQuery(providerId);
    }
  }

  syncConfig();
  requestsLive = true;

  void runHealthCheck();
  ctx.effect(() => {
    const dispose = ctx.interval(runHealthCheck, cfg.healthCheckIntervalMs ?? 60_000);
    return () => dispose();
  });
  ctx.effect(() => {
    const dispose = ctx.interval(runAutomaticUsageQueries, 30_000);
    return () => dispose();
  });
  runAutomaticUsageQueries();

  function effectiveUsed(providerId) {
    return used.get(providerId) ?? 0;
  }

  function quotaExceeded(providerId) {
    const provider = cfg.providers?.[providerId];
    return Boolean(provider && provider.limitTokens > 0 && effectiveUsed(providerId) >= provider.limitTokens);
  }

  const scheduleFlush = ctx.throttle(async () => {
    const ops = [];
    for (const [providerId, total] of used) {
      const base = baseline.get(providerId) ?? 0;
      if (total !== base) ops.push({ op: 'set', path: ['providers', providerId, 'usedTokens'], value: total });
    }
    if (ops.length === 0) return;
    try {
      await ctx.settings.mutate(NS, ops);
      for (const [providerId, total] of used) baseline.set(providerId, total);
    } catch { /* Retain the delta for the next flush. */ }
  }, 5_000);

  function addUsage(providerId, usage) {
    const tokens = (usage.inputTokens ?? 0)
      + (usage.outputTokens ?? 0)
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + (usage.reasoningTokens ?? 0);
    if (!(tokens > 0)) return;
    used.set(providerId, effectiveUsed(providerId) + tokens);
    scheduleFlush();
  }

  ctx.on('llm/stream', (options, next) => {
    const provider = options.provider;
    if (cfg.enabled !== false) {
      if (quotaExceeded(provider)) {
        const limit = cfg.providers[provider].limitTokens;
        return disabledStream(provider, `token quota exceeded (${effectiveUsed(provider)} / ${limit})`);
      }
      const status = health.get(provider);
      if (status?.ok === false) {
        return disabledStream(provider, `provider unavailable${status.error ? `: ${status.error}` : ''}`);
      }
    }
    const inner = next();
    return (async function* () {
      for await (const chunk of inner) {
        if (chunk.type === 'usage') addUsage(provider, chunk.usage);
        yield chunk;
      }
    })();
  });

  function disabledStream(provider, reason) {
    return (async function* () {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `model provider "${provider}" disabled by llm-guardian: ${reason}`,
            code: 'GUARDIAN_DISABLED',
          },
        },
      };
    })();
  }

  ctx.effect(() => () => {
    if (scheduleFlush?.dispose) scheduleFlush.dispose();
  });
}
