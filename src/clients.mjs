import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROVIDER_NAME = 'NVIDIA Free (nv-models)';

export const CLIENT_IDS = ['qoder', 'workbuddy', 'workbuddy-ai', 'zcode'];

const WORKBUDDY_IDS = new Set(['workbuddy', 'workbuddy-ai']);

const QODER_DIRS = ['.qoder-cn', '.qoder'];
const QODER_EXTRA = [
  ['.config', 'Qoder', 'User', 'settings.json'],
  ['.config', 'qoder', 'User', 'settings.json'],
];

const ZCODE_PROVIDER_KEY = 'nv-models';

export class SetupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function clientHome(home) {
  return path.resolve(home || process.env.NV_CLIENTS_HOME || os.homedir());
}

export function qoderConfigCandidates(home) {
  const root = clientHome(home);
  return [
    ...QODER_DIRS.map((dir) => path.join(root, dir, 'settings.json')),
    ...QODER_EXTRA.map((parts) => path.join(root, ...parts)),
  ];
}

export function qoderConfigPath(home) {
  const candidates = qoderConfigCandidates(home);
  return candidates.find((file) => fs.existsSync(file)) || candidates[0];
}

export function workbuddyConfigPath(home, env = process.env) {
  const root = clientHome(home);
  const dir = env.WORKBUDDY_CONFIG_DIR || env.CODEBUDDY_CONFIG_DIR;
  return dir ? path.join(path.resolve(dir), 'models.json') : path.join(root, '.workbuddy', 'models.json');
}

export function workbuddyAiConfigPath(home, env = process.env) {
  const root = clientHome(home);
  const dir = env.WORKBUDDY_AI_CONFIG_DIR;
  return dir ? path.join(path.resolve(dir), 'models.json') : path.join(root, '.workbuddy-ai', 'models.json');
}

function workbuddyAppDirs(env) {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'WorkBuddy'));
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, 'WorkBuddy'));
    for (const name of ['WorkBuddy', 'workbuddy', 'CodeBuddy', 'codebuddy']) {
      dirs.push(path.join(env.LOCALAPPDATA, 'Programs', name));
    }
  }
  return dirs;
}

function workbuddyAiAppDirs(env) {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'WorkBuddy AI'));
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, 'workbuddy-ai'));
    dirs.push(path.join(env.LOCALAPPDATA, '@genieworkbuddy-desktop-updater'));
    for (const name of ['WorkBuddy AI', 'workbuddy-ai']) {
      dirs.push(path.join(env.LOCALAPPDATA, 'Programs', name));
    }
  }
  return dirs;
}

function workbuddyInstalled(configPath, env) {
  return (
    fs.existsSync(configPath) ||
    fs.existsSync(path.dirname(configPath)) ||
    Boolean(env.WORKBUDDY_CONFIG_DIR || env.CODEBUDDY_CONFIG_DIR) ||
    workbuddyAppDirs(env).some((dir) => fs.existsSync(dir))
  );
}

function workbuddyAiInstalled(configPath, env) {
  return (
    fs.existsSync(configPath) ||
    fs.existsSync(path.dirname(configPath)) ||
    Boolean(env.WORKBUDDY_AI_CONFIG_DIR) ||
    workbuddyAiAppDirs(env).some((dir) => fs.existsSync(dir))
  );
}

export function zcodeConfigPath(home, env = process.env) {
  if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    return path.resolve(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
  }
  const root = env.ZCODE_HOME
    ? path.resolve(env.ZCODE_HOME)
    : path.join(clientHome(home), '.zcode');
  return path.join(root, 'v2', 'provider_config.json');
}

function zcodeAppDirs(env) {
  if (process.platform === 'darwin') return ['/Applications/ZCode.app'];
  if (process.platform === 'linux') return ['/opt/ZCode', '/usr/share/zcode'];
  if (process.platform !== 'win32') return [];
  return [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'ZCode'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'ZCode'),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'ZCode'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'ZCode'),
  ].filter(Boolean);
}

function zcodeInstalled(configPath, env) {
  return (
    fs.existsSync(configPath) ||
    fs.existsSync(path.dirname(configPath)) ||
    Boolean(env.ZCODE_HOME || env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) ||
    zcodeAppDirs(env).some((dir) => fs.existsSync(dir))
  );
}

export function detectClients({ home, env = process.env, catalog = [], baseUrl = '' } = {}) {
  const root = clientHome(home);
  const workbuddyPath = workbuddyConfigPath(root, env);
  const workbuddyAiPath = workbuddyAiConfigPath(root, env);
  const clients = [
    detectQoder({ home: root, env, baseUrl, catalog }),
    detectWorkbuddyVariant({
      id: 'workbuddy',
      name: 'WorkBuddy',
      versionLabel: '国内版',
      configPath: workbuddyPath,
      installed: workbuddyInstalled(workbuddyPath, env),
      baseUrl,
      catalog,
    }),
    detectWorkbuddyVariant({
      id: 'workbuddy-ai',
      name: 'WorkBuddy AI',
      versionLabel: '国际版',
      configPath: workbuddyAiPath,
      installed: workbuddyAiInstalled(workbuddyAiPath, env),
      baseUrl,
      catalog,
    }),
    detectZcode({ home: root, env, baseUrl, catalog }),
  ];
  return { home: root, platform: process.platform, clients, catalog: catalog.length };
}

function clientAliasMap(catalog) {
  const alias = new Map();
  for (const model of Array.isArray(catalog) ? catalog : []) {
    const short = String(model?.short || '').trim();
    if (!short) continue;
    alias.set(short, short);
    if (model.id) alias.set(String(model.id), short);
    for (const name of Array.isArray(model.aliases) ? model.aliases : []) {
      if (name) alias.set(String(name), short);
    }
  }
  return alias;
}

function detectQoder({ home, baseUrl, catalog }) {
  const candidates = qoderConfigCandidates(home);
  const configPath = candidates.find((file) => fs.existsSync(file)) || candidates[0];
  const installed =
    candidates.some((file) => fs.existsSync(path.dirname(file))) ||
    QODER_DIRS.some((dir) => fs.existsSync(path.join(home, dir)));
  const result = {
    id: 'qoder',
    name: 'Qoder',
    installed,
    configPath,
    configured: false,
    models: 0,
    modelNames: [],
    error: null,
  };
  if (!fs.existsSync(configPath)) return result;
  try {
    const data = readJsonFile(configPath).data;
    const entry = findQoderProvider(data, baseUrl);
    if (entry) {
      const models = Array.isArray(entry.provider.models) ? entry.provider.models : [];
      const alias = clientAliasMap(catalog);
      result.configured = true;
      result.models = models.length;
      result.modelNames = models
        .map((item) => {
          const id = String(item?.model || '').trim();
          return alias.get(id) || id;
        })
        .filter(Boolean);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function detectWorkbuddyVariant({ id, name, versionLabel, configPath, installed, baseUrl, catalog }) {
  const result = {
    id,
    name,
    versionLabel,
    installed,
    configPath,
    configured: false,
    models: 0,
    modelNames: [],
    error: null,
  };
  if (!fs.existsSync(configPath)) return result;
  try {
    const data = readJsonFile(configPath, { allowArray: true }).data;
    const entries = workbuddyModels(data).filter((entry) => sameGatewayEndpoint(entry?.url, baseUrl));
    if (entries.length) {
      result.configured = true;
      result.models = entries.length;
      const alias = clientAliasMap(catalog);
      result.modelNames = entries
        .map((entry) => {
          const id = String(entry?.id || '').trim();
          return alias.get(id) || id;
        })
        .filter(Boolean);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

function detectZcode({ home, env, baseUrl, catalog }) {
  const configPath = zcodeConfigPath(home, env);
  const result = {
    id: 'zcode',
    name: 'ZCode',
    installed: zcodeInstalled(configPath, env),
    configPath,
    configured: false,
    models: 0,
    modelNames: [],
    error: null,
  };
  if (!fs.existsSync(configPath)) return result;
  try {
    const data = readJsonFile(configPath).data;
    const rule = findZcodeProvider(data, baseUrl);
    if (rule) {
      const config = rule.config && typeof rule.config === 'object' ? rule.config : {};
      const ids = Array.isArray(config.personalModelIds)
        ? config.personalModelIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
      result.configured = true;
      result.models = ids.length;
      const alias = clientAliasMap(catalog);
      result.modelNames = ids.map((id) => alias.get(id) || id);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export function normalizeModelId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function fetchApiModelIds({
  apiKey,
  apiBase = 'https://integrate.api.nvidia.com/v1',
  timeoutMs = 12000,
} = {}) {
  if (!apiKey) throw new SetupError('缺少 NVIDIA_API_KEY', 400);
  const base = String(apiBase || '').replace(/\/+$/, '');
  const response = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SetupError(`获取 API 模型列表失败：HTTP ${response.status}`, 502);
  const payload = await response.json();
  const ids = (Array.isArray(payload?.data) ? payload.data : [])
    .map((item) => String(item?.id || '').trim())
    .filter(Boolean);
  if (!ids.length) throw new SetupError('API 模型列表为空', 502);
  return ids;
}

export function canonicalModelShort(id) {
  const text = String(id || '').trim();
  const index = text.lastIndexOf('/');
  return index >= 0 ? text.slice(index + 1) : text;
}

export function buildModelAliases(models, apiIds, fallback = new Map()) {
  const list = Array.isArray(models) ? models : [];
  const ids = Array.isArray(apiIds)
    ? apiIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const exact = new Set(ids);
  const byNormalized = new Map();
  for (const id of ids) {
    const key = normalizeModelId(id);
    if (key && !byNormalized.has(key)) byNormalized.set(key, id);
  }

  const fallbackEntries = fallback instanceof Map ? [...fallback.entries()] : Object.entries(fallback || {});
  const fallbackByNormalized = new Map();
  for (const [, value] of fallbackEntries) {
    const target = String(value || '').trim();
    const key = normalizeModelId(target);
    if (key && !fallbackByNormalized.has(key)) fallbackByNormalized.set(key, target);
  }

  const pairs = [];
  const slugCounts = new Map();
  for (const model of list) {
    const pageId = String(model?.id || '').trim();
    const slug = String(model?.slug || '').trim();
    if (!pageId || !slug) continue;
    slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
    const target = ids.length
      ? exact.has(pageId)
        ? pageId
        : byNormalized.get(normalizeModelId(pageId)) || ''
      : fallbackByNormalized.get(normalizeModelId(pageId)) || pageId;
    if (target) pairs.push({ slug, target });
  }

  const fallbackPairs = [];
  for (const [rawName, rawTarget] of fallbackEntries) {
    const alias = String(rawName || '').trim();
    const target = String(rawTarget || '').trim();
    if (!alias || !target) continue;
    if (!ids.length) {
      fallbackPairs.push({ alias, target });
      continue;
    }
    const resolved = exact.has(target) ? target : byNormalized.get(normalizeModelId(target));
    if (resolved) fallbackPairs.push({ alias, target: resolved });
  }

  const targets = [];
  const seenTargets = new Set();
  for (const pair of [...pairs, ...fallbackPairs]) {
    if (seenTargets.has(pair.target)) continue;
    seenTargets.add(pair.target);
    targets.push(pair.target);
  }

  const candidateCounts = new Map();
  for (const target of targets) {
    const candidate = canonicalModelShort(target) || target;
    candidateCounts.set(candidate, (candidateCounts.get(candidate) || 0) + 1);
  }
  const slugByTarget = new Map();
  for (const { slug, target } of pairs) {
    if (!slugByTarget.has(target)) slugByTarget.set(target, slug);
  }

  const canonicalByTarget = new Map();
  const used = new Set();
  for (const target of targets) {
    const candidate = canonicalModelShort(target) || target;
    let canonical = candidate;
    if ((candidateCounts.get(candidate) || 0) > 1 || used.has(candidate)) {
      const slug = slugByTarget.get(target);
      canonical = slug && slugCounts.get(slug) === 1 && !used.has(slug) ? slug : target;
    }
    if (used.has(canonical)) canonical = target;
    used.add(canonical);
    canonicalByTarget.set(target, canonical);
  }

  const map = new Map();
  for (const target of targets) {
    const canonical = canonicalByTarget.get(target);
    if (!map.has(canonical)) map.set(canonical, target);
  }
  for (const { slug, target } of pairs) {
    if (slug && !map.has(slug)) map.set(slug, target);
  }
  for (const { alias, target } of fallbackPairs) {
    if (alias && !map.has(alias)) map.set(alias, target);
  }
  return map;
}

function catalogMeta(models, id, short) {
  const list = Array.isArray(models) ? models : [];
  const normalizedId = normalizeModelId(id);
  const normalizedShort = normalizeModelId(short);
  return (
    list.find((item) => String(item?.id || '').trim() === id) ||
    (normalizedId && list.find((item) => normalizeModelId(item?.id) === normalizedId)) ||
    (normalizedShort && list.find((item) => normalizeModelId(item?.slug) === normalizedShort)) ||
    {}
  );
}

export function buildCatalog(models, aliases = new Map()) {
  const list = Array.isArray(models) ? models : [];
  const byId = new Map();
  const create = (short, id) => {
    const meta = catalogMeta(list, id, short);
    const rawName = String(meta.name || short).trim() || short;
    const pageSlug = String(meta.slug || '').trim();
    const pageId = String(meta.id || '').trim();
    return {
      short,
      id,
      name: rawName === pageSlug || rawName === pageId ? short : rawName,
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      publisher: String(meta.publisher?.name || meta.publisher || ''),
      aliases: [short],
    };
  };
  const addAlias = (entry, name) => {
    if (name && !entry.aliases.includes(name)) entry.aliases.push(name);
  };
  if (aliases && aliases.size) {
    for (const [rawName, rawId] of aliases) {
      const short = String(rawName || '').trim();
      const id = String(rawId || '').trim();
      if (!short || !id) continue;
      let entry = byId.get(id);
      if (!entry) {
        entry = create(short, id);
        byId.set(id, entry);
      } else {
        addAlias(entry, short);
      }
    }
  } else {
    for (const model of list) {
      const short = String(model?.slug || '').trim();
      const id = String(model?.id || '').trim();
      if (!short || !id || byId.has(id)) continue;
      byId.set(id, create(short, id));
    }
  }
  return [...byId.values()].sort((a, b) => a.short.localeCompare(b.short));
}

export function matchesModelName(value, model) {
  const name = String(value || '').trim();
  if (!name) return false;
  if (name === model.short || name === model.id) return true;
  return Array.isArray(model.aliases) && model.aliases.includes(name);
}

export function selectModels(catalog, selection) {
  const all = Array.isArray(catalog) ? catalog : [];
  if (selection == null || selection === '' || selection === 'all') return { selected: all, unknown: [] };
  const requested = Array.isArray(selection) ? selection : [selection];
  const selected = [];
  const unknown = [];
  for (const value of requested) {
    const name = String(value || '').trim();
    if (!name) continue;
    const hit = all.find((model) => matchesModelName(name, model));
    if (hit) {
      if (!selected.some((model) => model.short === hit.short)) selected.push(hit);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return { selected, unknown };
}

export function planSetup({
  client,
  catalog,
  models = 'all',
  baseUrl = '',
  token = '',
  home,
  env = process.env,
} = {}) {
  const { selected, unknown } = selectModels(catalog, models);
  if (unknown.length) throw new SetupError(`未知模型：${unknown.join(', ')}`, 400);
  if (!selected.length) throw new SetupError('没有可添加的模型', 400);
  const def = clientDef(client);
  const prepared = prepareClient(def, { selected, baseUrl, token, home: clientHome(home), env });
  return {
    client: def.id,
    name: def.name,
    installed: prepared.installed,
    configPath: prepared.configPath,
    exists: prepared.exists,
    comments: prepared.comments,
    configured: prepared.configured,
    providerKey: prepared.providerKey,
    added: prepared.added.map((model) => model.short),
    already: prepared.already.map((model) => model.short),
    skipped: prepared.skipped.map((model) => model.short),
    total: prepared.total,
    changed: prepared.changed,
    warnings: prepared.warnings,
  };
}

export function applySetup(options = {}) {
  const clients = normalizeClients(options.clients);
  const results = [];
  for (const client of clients) {
    try {
      const result = applyOne({ ...options, clients: [client] });
      results.push(...result);
    } catch (error) {
      results.push({
        client,
        ok: false,
        error: error.message,
        statusCode: error.statusCode || 400,
      });
    }
  }
  return results;
}

function applyOne(options) {
  const { selected, unknown } = selectModels(options.catalog, options.models);
  if (unknown.length) throw new SetupError(`未知模型：${unknown.join(', ')}`, 400);
  if (!selected.length) throw new SetupError('没有可添加的模型', 400);
  const def = clientDef(options.clients?.[0]);
  const home = clientHome(options.home);
  const prepared = prepareClient(def, {
    selected,
    baseUrl: options.baseUrl,
    token: options.token,
    home,
    env: options.env || process.env,
  });
  if (!prepared.installed) {
    throw new SetupError(`未检测到 ${def.name}，请先安装并启动一次`, 409);
  }
  if (!prepared.changed) {
    return [
      {
        client: def.id,
        ok: true,
        installed: true,
        configPath: prepared.configPath,
        providerKey: prepared.providerKey,
        added: [],
        already: prepared.already.map((model) => model.short),
        skipped: prepared.skipped.map((model) => model.short),
        total: prepared.total,
        backup: null,
        warnings: prepared.warnings,
      },
    ];
  }
  const backup = writeConfig(prepared.configPath, prepared.data, prepared.comments, options.backup !== false);
  return [
    {
      client: def.id,
      ok: true,
      installed: true,
      configPath: prepared.configPath,
      providerKey: prepared.providerKey,
      added: prepared.added.map((model) => model.short),
      already: prepared.already.map((model) => model.short),
      skipped: prepared.skipped.map((model) => model.short),
      total: prepared.total,
      backup,
      warnings: prepared.warnings,
    },
  ];
}

export function removeSetup(options = {}) {
  const clients = normalizeClients(options.clients);
  const results = [];
  for (const client of clients) {
    try {
      results.push(removeOne(client, options));
    } catch (error) {
      results.push({ client, ok: false, error: error.message, statusCode: error.statusCode || 400 });
    }
  }
  return results;
}

function removeOne(client, options) {
  const def = clientDef(client);
  const home = clientHome(options.home);
  const env = options.env || process.env;
  const configPath = def.configPath(home, env);
  if (!fs.existsSync(configPath)) {
    return { client: def.id, ok: true, removed: 0, configPath, backup: null };
  }
  const parsed = readJsonFile(configPath, { allowArray: WORKBUDDY_IDS.has(def.id) });
  if (def.id === 'zcode') {
    const config = readZcodeConfig(parsed.data);
    const rule = findZcodeProvider(parsed.data, options.baseUrl);
    if (!config || !rule) {
      return { client: def.id, ok: true, removed: 0, configPath, backup: null };
    }
    const rules = config.providerConfigRules.providerRules;
    const index = rules.indexOf(rule);
    if (index >= 0) rules.splice(index, 1);
    config.providerOrder = config.providerOrder.filter((id) => id !== rule.providerId);
    config.modelConfigRules.providerModelRules = config.modelConfigRules.providerModelRules.filter(
      (item) => item?.providerId !== rule.providerId,
    );
    config.modelConfigRules.manualProviderModelRules = config.modelConfigRules.manualProviderModelRules.filter(
      (item) => item?.providerId !== rule.providerId,
    );
    const removed = def.count(rule);
    const backup = writeConfig(configPath, parsed.data, parsed.comments, options.backup !== false);
    return { client: def.id, ok: true, removed, configPath, backup };
  }
  if (WORKBUDDY_IDS.has(def.id)) {
    const list = workbuddyModels(parsed.data);
    const kept = list.filter((entry) => !sameGatewayEndpoint(entry?.url, options.baseUrl));
    const removed = list.length - kept.length;
    if (!removed) {
      return { client: def.id, ok: true, removed: 0, configPath, backup: null };
    }
    const data = Array.isArray(parsed.data) ? kept : { ...parsed.data, models: kept };
    const backup = writeConfig(configPath, data, parsed.comments, options.backup !== false);
    return { client: def.id, ok: true, removed, configPath, backup };
  }
  const entry = def.find(parsed.data, options.baseUrl);
  if (!entry) {
    return { client: def.id, ok: true, removed: 0, configPath, backup: null };
  }
  const total = def.count(entry.provider);
  delete parsed.data.providers[entry.key];
  const backup = writeConfig(configPath, parsed.data, parsed.comments, options.backup !== false);
  return { client: def.id, ok: true, removed: total, configPath, backup };
}

function normalizeClients(value) {
  if (value == null || value === '' || value === 'all') return [...CLIENT_IDS];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const id = String(item || '').trim().toLowerCase();
    if (id === 'all') return [...CLIENT_IDS];
    if (CLIENT_IDS.includes(id)) {
      if (!out.includes(id)) out.push(id);
    } else {
      throw new SetupError(`未知客户端：${item}`, 400);
    }
  }
  if (!out.length) throw new SetupError(`请指定 ${CLIENT_IDS.join('、')}`, 400);
  return out;
}

function clientDef(id) {
  if (id === 'qoder') {
    return {
      id: 'qoder',
      name: 'Qoder',
      configPath: qoderConfigPath,
      find: findQoderProvider,
      count: (provider) => (Array.isArray(provider.models) ? provider.models.length : 0),
    };
  }
  if (WORKBUDDY_IDS.has(id)) {
    return {
      id,
      name: id === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddy AI',
      versionLabel: id === 'workbuddy' ? '国内版' : '国际版',
      configPath: id === 'workbuddy' ? workbuddyConfigPath : workbuddyAiConfigPath,
    };
  }
  if (id === 'zcode') {
    return {
      id: 'zcode',
      name: 'ZCode',
      configPath: zcodeConfigPath,
      find: findZcodeProvider,
      count: (provider) =>
        Array.isArray(provider?.config?.personalModelIds) ? provider.config.personalModelIds.length : 0,
    };
  }
  throw new SetupError(`未知客户端：${id}`, 400);
}

function prepareClient(def, { selected, baseUrl, token, home, env }) {
  const configPath = def.configPath(home, env);
  const installed =
    def.id === 'qoder'
      ? fs.existsSync(path.dirname(configPath)) || QODER_DIRS.some((dir) => fs.existsSync(path.join(home, dir)))
      : def.id === 'zcode'
        ? zcodeInstalled(configPath, env)
        : def.id === 'workbuddy-ai'
          ? workbuddyAiInstalled(configPath, env)
          : workbuddyInstalled(configPath, env);
  if (!installed) {
    return {
      installed: false,
      configPath,
      exists: fs.existsSync(configPath),
      comments: false,
      data: null,
      provider: null,
      providerKey: null,
      configured: false,
      added: [],
      already: [],
      skipped: [],
      total: 0,
      changed: false,
      warnings: [],
    };
  }
  const parsed = fs.existsSync(configPath)
    ? readJsonFile(configPath, { allowArray: WORKBUDDY_IDS.has(def.id) })
    : {
        data:
          def.id === 'qoder'
            ? { providers: {} }
            : def.id === 'zcode'
              ? zcodeDefaultConfig()
              : { models: [] },
        comments: false,
      };
  const before = JSON.stringify(parsed.data);
  let provider;
  let providerKey;
  let configured = false;
  const skipped = [];
  if (def.id === 'qoder') {
    if (!parsed.data.providers || typeof parsed.data.providers !== 'object') parsed.data.providers = {};
    const found = findQoderProvider(parsed.data, baseUrl);
    providerKey = found?.key || `qoder-custom-${randomUUID()}`;
    provider = found?.provider || {
      baseUrl: chatEndpoint(baseUrl),
      apiKey: token || 'nv-local',
      type: 'openai-compatible',
      protocol: 'openai',
      authType: 'bearer',
      model: selected[0].short,
      models: [],
      displayName: PROVIDER_NAME,
      nvModels: true,
    };
    parsed.data.providers[providerKey] = provider;
    configured = Boolean(found);
  } else if (WORKBUDDY_IDS.has(def.id)) {
    provider = workbuddyModels(parsed.data);
    providerKey = 'models';
    configured = provider.some((entry) => sameGatewayEndpoint(entry?.url, baseUrl));
  } else {
    if (!parsed.data.schemaVersion) parsed.data.schemaVersion = 1;
    const config = zcodeConfig(parsed.data);
    const found = findZcodeProvider(parsed.data, baseUrl);
    providerKey = found?.providerId || nextZcodeProviderId(config);
    provider = found || {
      providerId: providerKey,
      providerName: PROVIDER_NAME,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key' },
        api: { type: 'openai-chat-completions' },
        personalModelIds: [],
        modelOrder: [],
      },
    };
    if (!found) config.providerConfigRules.providerRules.push(provider);
    if (!config.providerOrder.includes(providerKey)) config.providerOrder.push(providerKey);
    configured = Boolean(found);
  }

  let added = [];
  let already = [];
  if (def.id === 'qoder') {
    provider.baseUrl = chatEndpoint(baseUrl);
    if (token) provider.apiKey = token;
    if (!provider.apiKey) provider.apiKey = 'nv-local';
    provider.displayName = PROVIDER_NAME;
    provider.nvModels = true;
    if (!Array.isArray(provider.models)) provider.models = [];
    for (const model of selected) {
      const hit = provider.models.find((item) => matchesModelName(item?.model, model));
      if (hit) {
        already.push(model);
      } else {
        provider.models.push(qoderModelEntry(model));
        added.push(model);
      }
    }
    if (!provider.model || !provider.models.some((item) => item?.model === provider.model)) {
      provider.model = selected[0].short;
    }
  } else if (WORKBUDDY_IDS.has(def.id)) {
    const endpoint = chatEndpoint(baseUrl);
    const apiKey = token || 'nv-local';
    for (const model of selected) {
      const hit = provider.find(
        (entry) => entry && typeof entry === 'object' && matchesModelName(entry.id, model),
      );
      if (hit) {
        if (!sameGatewayEndpoint(hit.url, baseUrl)) {
          skipped.push(model);
          continue;
        }
        if (endpoint) hit.url = endpoint;
        if (token) hit.apiKey = token;
        else if (!hit.apiKey) hit.apiKey = 'nv-local';
        already.push(model);
      } else {
        const entry = workbuddyModelsJsonEntry(model);
        if (endpoint) entry.url = endpoint;
        entry.apiKey = apiKey;
        provider.push(entry);
        added.push(model);
      }
    }
  } else {
    const ruleConfig =
      provider.config && typeof provider.config === 'object' && !Array.isArray(provider.config)
        ? provider.config
        : (provider.config = {});
    if (!ruleConfig.group) ruleConfig.group = 'standard-personal';
    if (!ruleConfig.access || typeof ruleConfig.access !== 'object') ruleConfig.access = {};
    ruleConfig.access.type = 'api-key';
    if (token) ruleConfig.access.apiKey = token;
    else if (!ruleConfig.access.apiKey) ruleConfig.access.apiKey = 'nv-local';
    if (!ruleConfig.api || typeof ruleConfig.api !== 'object') ruleConfig.api = {};
    ruleConfig.api.type = 'openai-chat-completions';
    const root = gatewayRoot(baseUrl);
    if (root) ruleConfig.api.baseUrl = root;
    provider.providerName = PROVIDER_NAME;
    if (!Array.isArray(ruleConfig.personalModelIds)) ruleConfig.personalModelIds = [];
    for (const model of selected) {
      const hit = ruleConfig.personalModelIds.some((id) => matchesModelName(id, model));
      if (hit) {
        already.push(model);
      } else {
        ruleConfig.personalModelIds.push(model.short);
        added.push(model);
      }
    }
    if (!Array.isArray(ruleConfig.modelOrder)) ruleConfig.modelOrder = [];
    for (const id of ruleConfig.personalModelIds) {
      if (!ruleConfig.modelOrder.includes(id)) ruleConfig.modelOrder.push(id);
    }
    ruleConfig.modelOrder = ruleConfig.modelOrder.filter((id) => ruleConfig.personalModelIds.includes(id));
  }

  const changed = before !== JSON.stringify(parsed.data);
  const warnings = [];
  if (parsed.comments) warnings.push('原配置含注释，写入后会变成标准 JSON；已保留备份');
  if (!fs.existsSync(configPath)) warnings.push('首次创建客户端配置文件');
  const total = WORKBUDDY_IDS.has(def.id)
    ? provider.filter((entry) => sameGatewayEndpoint(entry?.url, baseUrl)).length
    : def.count(provider);
  return {
    installed: true,
    configPath,
    exists: fs.existsSync(configPath),
    comments: parsed.comments,
    data: parsed.data,
    provider,
    providerKey,
    configured,
    added,
    already,
    skipped,
    total,
    changed,
    warnings,
  };
}

function findQoderProvider(data, baseUrl) {
  const providers = data?.providers;
  if (!providers || typeof providers !== 'object') return null;
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue;
    if (provider.nvModels === true || provider.displayName === PROVIDER_NAME) {
      return { key, provider };
    }
  }
  if (baseUrl) {
    const endpoint = chatEndpoint(baseUrl);
    for (const [key, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object') continue;
      if (chatEndpoint(String(provider.baseUrl || '')) === endpoint && provider.displayName === PROVIDER_NAME) {
        return { key, provider };
      }
    }
  }
  return null;
}

export function qoderModelEntry(model) {
  const tags = model.tags.map((tag) => String(tag).toLowerCase());
  const vision = tags.some((tag) => /multimodal|image-to-text|vision/.test(tag));
  const reasoning = tags.some((tag) => /reasoning/.test(tag));
  return {
    model: model.short,
    displayName: model.name || model.short,
    contextWindow: 200000,
    maxOutputTokens: 16384,
    capabilities: {
      vision,
      thinking: {
        modes: reasoning ? ['enabled'] : [],
        supportsEffort: reasoning,
        supportedEffortLevels: reasoning ? ['low', 'medium', 'high'] : [],
      },
    },
  };
}

export function workbuddyModelsJsonEntry(model) {
  const tags = model.tags.map((tag) => String(tag).toLowerCase());
  const entry = {
    id: model.short,
    name: model.name || model.short,
    maxInputTokens: 200000,
    maxOutputTokens: 16384,
    supportsToolCall: tags.some((tag) => /tool use|function calling|tools/.test(tag)),
    supportsImages: tags.some((tag) => /multimodal|image-to-text|vision/.test(tag)),
    supportsReasoning: tags.some((tag) => /reasoning/.test(tag)),
  };
  if (model.publisher) entry.vendor = model.publisher;
  return entry;
}

function workbuddyModels(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') {
    throw new SetupError('WorkBuddy 配置不是 JSON 对象或数组', 409);
  }
  if (data.models == null) data.models = [];
  if (!Array.isArray(data.models)) {
    throw new SetupError('WorkBuddy 配置里的 models 不是数组', 409);
  }
  return data.models;
}

export function zcodeDefaultConfig() {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

function readZcodeConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const config = data.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (!Array.isArray(config.providerConfigRules?.providerRules)) return null;
  return config;
}

function zcodeConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SetupError('ZCode 配置不是 JSON 对象', 409);
  }
  if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) data.config = {};
  const config = data.config;
  if (!Array.isArray(config.providerOrder)) config.providerOrder = [];
  if (!config.providerConfigRules || typeof config.providerConfigRules !== 'object') {
    config.providerConfigRules = {};
  }
  if (!Array.isArray(config.providerConfigRules.providerRules)) config.providerConfigRules.providerRules = [];
  if (!config.modelConfigRules || typeof config.modelConfigRules !== 'object') config.modelConfigRules = {};
  if (!Array.isArray(config.modelConfigRules.providerModelRules)) {
    config.modelConfigRules.providerModelRules = [];
  }
  if (!Array.isArray(config.modelConfigRules.manualProviderModelRules)) {
    config.modelConfigRules.manualProviderModelRules = [];
  }
  return config;
}

function findZcodeProvider(data, baseUrl) {
  const config = readZcodeConfig(data);
  if (!config) return null;
  const rules = config.providerConfigRules.providerRules;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.providerName === PROVIDER_NAME || rule.providerId === ZCODE_PROVIDER_KEY) return rule;
  }
  if (baseUrl) {
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') continue;
      if (sameGatewayEndpoint(rule?.config?.api?.baseUrl, baseUrl)) return rule;
    }
  }
  return null;
}

function nextZcodeProviderId(config) {
  const used = new Set(
    config.providerConfigRules.providerRules.map((rule) => String(rule?.providerId || '')).filter(Boolean),
  );
  if (!used.has(ZCODE_PROVIDER_KEY)) return ZCODE_PROVIDER_KEY;
  let index = 2;
  while (used.has(`${ZCODE_PROVIDER_KEY}-${index}`)) index++;
  return `${ZCODE_PROVIDER_KEY}-${index}`;
}

function sameGatewayEndpoint(value, baseUrl) {
  const left = gatewayRoot(value);
  const right = gatewayRoot(baseUrl);
  return Boolean(left) && left === right;
}

function gatewayRoot(value) {
  return normalizedBaseUrl(value).replace(/\/chat\/completions$/i, '');
}

function normalizedBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function chatEndpoint(value) {
  const base = gatewayRoot(value);
  if (!base) return '';
  return `${base}/chat/completions`;
}

function readJsonFile(file, { allowArray = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new SetupError(`读取配置失败：${error.message}`, 500);
  }
  if (!text.trim()) return { data: {}, comments: false };
  const parsed = parseJsonc(text);
  if (!parsed.value || typeof parsed.value !== 'object' || (!allowArray && Array.isArray(parsed.value))) {
    throw new SetupError(`配置不是 JSON 对象${allowArray ? '或数组' : ''}：${file}`, 409);
  }
  return { data: parsed.value, comments: parsed.comments };
}

export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let comments = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        out += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      comments = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      comments = true;
      index++;
      continue;
    }
    out += char;
  }
  out = stripTrailingCommas(out);
  try {
    return { value: JSON.parse(out || '{}'), comments };
  } catch (error) {
    throw new SetupError(`配置不是合法 JSON：${error.message}`, 409);
  }
}

function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    out += char;
  }
  return out;
}

function writeConfig(file, data, comments, backup = true) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backupPath = backup && fs.existsSync(file) ? backupFile(file) : null;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // 读不到权限时用 0600
    }
  }
  const temp = `${file}.nv-models-${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Windows 上忽略权限
  }
  return backupPath;
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.nv-models-backup-${stamp}.bak`;
  fs.copyFileSync(file, backup);
  pruneBackups(file);
  return backup;
}

function pruneBackups(file) {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.nv-models-backup-`;
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse();
    for (const name of backups.slice(5)) {
      fs.unlinkSync(path.join(dir, name));
    }
  } catch {
    // 清理旧备份失败不影响本次写入
  }
}
