#!/usr/bin/env node
/**
 * NVIDIA 免费模型浏览服务。
 *
 * 启动：
 *   node src/server.mjs                 默认 http://127.0.0.1:18788
 *   node src/server.mjs --open          启动后打开浏览器
 *   node src/server.mjs --no-auto       关闭自动采集，只手动刷新
 *
 * 同一个进程负责：
 *   - 读取 data/models.json 并提供浏览页面
 *   - 缓存过期（默认 8 小时）时调用 collector.mjs 更新
 *   - 提供手动刷新接口，并把采集日志尾巴暴露给页面
 *   - 提供模型测速接口（流式请求 integrate.api.nvidia.com）
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.mjs';
import { createBenchmarkManager } from './benchmark.mjs';
import { createGateway } from './gateway.mjs';
import { clientAddress, isLoopbackAddress } from './request-ip.mjs';
import {
  CLIENT_IDS,
  SetupError,
  applySetup,
  buildCatalog,
  buildModelAliases,
  detectClients,
  fetchApiModelIds,
  normalizeModelId,
  removeSetup,
  selectModels,
} from './clients.mjs';
import { buildSetupScript, setupScriptFileName } from './setup-script.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const COLLECTOR_FILE = path.join(__dirname, 'collector.mjs');
const DEFAULT_MODELS_FILE = path.join(ROOT_DIR, 'data', 'models.json');
const DEFAULT_STATUS_FILE = path.join(ROOT_DIR, 'data', 'status.json');
const DEFAULT_LOG_FILE = path.join(ROOT_DIR, 'logs', 'collector.log');
const DEFAULT_RESULTS_FILE = path.join(ROOT_DIR, 'data', 'benchmarks.json');
const DEFAULT_API_MODELS_FILE = path.join(ROOT_DIR, 'data', 'api-models.json');
const DEFAULT_SESSION_SECRET_FILE = path.join(ROOT_DIR, 'data', 'session-secret');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const PID_FILE = path.join(ROOT_DIR, 'data', 'server.pid');
const INSTANCE_ID = randomBytes(8).toString('hex');
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' https://assets.ngc.nvidia.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const SESSION_COOKIE = 'nv_session';
const SESSION_TTL_MS = 7 * 86_400_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_BLOCK_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 8;

loadDotEnv(ENV_FILE);

function parseDuration(input, fallback) {
  if (input == null || input === '') return fallback;
  const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  return Math.round(value * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]);
}

function formatDuration(ms) {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(ms % 60_000 ? 1 : 0)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;
  return `${ms}ms`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}


function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writePidFile() {
  try {
    ensureDir(path.dirname(PID_FILE));
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({
        pid: process.pid,
        port: CFG.port,
        instance: INSTANCE_ID,
        startedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // PID 文件只用于 npm stop/status，写不进去不影响服务
  }
}

function removePidFile() {
  try {
    const record = readJson(PID_FILE);
    if (record?.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    // 文件可能已被清理
  }
}

function isLoopback(req) {
  return isLoopbackAddress(clientAddress(req, CFG.trustProxy));
}

function isSameHost(req) {
  if (isLoopback(req)) return true;
  const remote = clientAddress(req, CFG.trustProxy);
  if (!remote) return false;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (String(entry.address || '').replace(/^::ffff:/, '') === remote) return true;
    }
  }
  return false;
}

function needsAuth(req) {
  if (!CFG.token) return false;
  return CFG.authScope === 'all' || !isLoopback(req);
}

function presentedToken(req) {
  const header = String(req.headers.authorization || '');
  const basic = header.match(/^Basic\s+(.+)$/i);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const index = decoded.indexOf(':');
      return index >= 0 ? decoded.slice(index + 1) : decoded;
    } catch {
      return '';
    }
  }
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
}

function tokenMatches(value) {
  const provided = Buffer.from(String(value));
  const expected = Buffer.from(String(CFG.token));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

let sessionKeyCache = null;

function sessionKey() {
  if (sessionKeyCache) return sessionKeyCache;
  const file = CFG.sessionSecretFile;
  let secret = '';
  try {
    secret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // 首次启动还没有密钥，下面生成
  }
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    secret = randomBytes(32).toString('hex');
    try {
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Windows 上 chmod 基本无效，忽略
      }
    } catch (error) {
      warn(`无法保存登录会话密钥：${error.message}`);
    }
  }
  // 口令变化后让已签发的 Cookie 全部失效
  sessionKeyCache = createHmac('sha256', secret).update(`nv-models-session:${CFG.token}`).digest();
  return sessionKeyCache;
}

function parseCookies(req) {
  const out = {};
  const header = String(req.headers.cookie || '');
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // 忽略格式错误的 Cookie
    }
  }
  return out;
}

function signSession(expiresAt) {
  const payload = String(expiresAt);
  const signature = createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySession(value) {
  const text = String(value || '');
  const index = text.indexOf('.');
  if (index <= 0) return false;
  const payload = text.slice(0, index);
  const signature = Buffer.from(text.slice(index + 1));
  const expected = Buffer.from(
    createHmac('sha256', sessionKey()).update(payload).digest('base64url'),
  );
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function sessionAuthenticated(req) {
  if (!CFG.token) return false;
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function authenticated(req) {
  if (!CFG.token) return false;
  return sessionAuthenticated(req) || tokenMatches(presentedToken(req));
}

function behindTrustedProxy(req) {
  return CFG.trustProxy && isLoopbackAddress(req.socket.remoteAddress || '');
}

function requestProtocol(req) {
  if (req.socket.encrypted) return 'https';
  if (behindTrustedProxy(req)) {
    const proto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (proto === 'https') return 'https';
  }
  return 'http';
}

function sessionCookie(req, value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (requestProtocol(req) === 'https') parts.push('Secure');
  return parts.join('; ');
}

const loginFailures = new Map();

function loginClientKey(req) {
  return clientAddress(req, CFG.trustProxy) || req.socket.remoteAddress || 'unknown';
}

function loginBlockedFor(key) {
  const entry = loginFailures.get(key);
  if (!entry) return 0;
  const now = Date.now();
  if (entry.blockedUntil > now) return entry.blockedUntil - now;
  if (entry.resetAt <= now) loginFailures.delete(key);
  return 0;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginFailures.get(key) || {
    count: 0,
    resetAt: now + LOGIN_WINDOW_MS,
    blockedUntil: 0,
  };
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_WINDOW_MS;
    entry.blockedUntil = 0;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.count = 0;
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
  }
  loginFailures.set(key, entry);
  if (loginFailures.size > 1000) {
    for (const [item, value] of loginFailures) {
      if (value.resetAt <= now && value.blockedUntil <= now) loginFailures.delete(item);
    }
  }
}

function log(...args) {
  if (CFG.quiet) return;
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function warn(...args) {
  console.warn(`[${new Date().toISOString()}]`, ...args);
}

const DEFAULTS = {
  host: process.env.NV_MODELS_HOST || '127.0.0.1',
  port: Number(process.env.NV_MODELS_PORT || 18788),
  ttlMs: parseDuration(process.env.NV_MODELS_TTL, 8 * 3_600_000),
  auto: process.env.NV_MODELS_AUTO !== '0',
  showRefresh: process.env.NV_MODELS_SHOW_REFRESH !== '0',
  settings: process.env.NV_MODELS_SETTINGS !== '0',
  token: process.env.NV_MODELS_TOKEN || '',
  authScope: (process.env.NV_MODELS_AUTH_SCOPE || 'remote').toLowerCase(),
  trustProxy: process.env.NV_TRUST_PROXY === '1',
  open: false,
  quiet: false,
  modelsFile: process.env.NV_MODELS_OUT || DEFAULT_MODELS_FILE,
  statusFile: process.env.NV_MODELS_STATUS || DEFAULT_STATUS_FILE,
  logFile: process.env.NV_MODELS_LOG || DEFAULT_LOG_FILE,
  collector: process.env.NV_MODELS_COLLECTOR || COLLECTOR_FILE,
  benchmark: process.env.NV_MODELS_BENCHMARK !== '0',
  benchmarkKey: process.env.NV_MODELS_BENCHMARK_KEY || process.env.NVIDIA_API_KEY || '',
  translate: (process.env.NV_MODELS_TRANSLATE || 'auto').toLowerCase(),
  benchmarkApiBase: process.env.NV_MODELS_BENCHMARK_URL || 'https://integrate.api.nvidia.com/v1',
  benchmarkResultsFile: process.env.NV_MODELS_BENCHMARK_OUT || DEFAULT_RESULTS_FILE,
  apiModelsFile: process.env.NV_API_MODELS_OUT || DEFAULT_API_MODELS_FILE,
  sessionSecretFile: process.env.NV_SESSION_SECRET_FILE || DEFAULT_SESSION_SECRET_FILE,
  benchmarkPrompt: process.env.NV_MODELS_BENCHMARK_PROMPT || '用一句话解释什么是 GPU。',
  benchmarkSamples: process.env.NV_MODELS_BENCHMARK_SAMPLES || '2',
  benchmarkMaxTokens: process.env.NV_MODELS_BENCHMARK_MAX_TOKENS || '160',
  benchmarkTimeoutMs: parseDuration(process.env.NV_MODELS_BENCHMARK_TIMEOUT, 120_000),
  benchmarkGapMs: parseDuration(process.env.NV_MODELS_BENCHMARK_GAP, 800),
  benchmarkAutoMs: parseDuration(process.env.NV_MODELS_BENCHMARK_AUTO, 24 * 3_600_000),
  gatewayHost: process.env.NV_GATEWAY_HOST || '127.0.0.1',
  gatewayPort: Number(process.env.NV_GATEWAY_PORT || 18787),
  gatewayUrl: process.env.NV_GATEWAY_URL || '',
  gatewayKey: process.env.NV_GATEWAY_KEY || process.env.NVIDIA_API_KEY || '',
  gatewayUpstream: process.env.NV_GATEWAY_UPSTREAM || 'https://integrate.api.nvidia.com/v1',
  gatewayToken: process.env.AUTH_TOKEN || '',
  gatewayAuthScope: (process.env.AUTH_SCOPE || 'remote').toLowerCase(),
  gatewayAliases: process.env.MODEL_ALIASES || '',
  gatewayMaxBodyMB: Number(process.env.MAX_BODY_MB || 40),
  gatewayIdleTimeoutMs: Number(process.env.UPSTREAM_IDLE_TIMEOUT_MS || 300_000),
  gatewayReasoningEffort: process.env.DEFAULT_REASONING_EFFORT || '',
  gatewayDisabledEffort: process.env.EFFORT_WHEN_DISABLED || '',
  gatewayStrip: process.env.STRIP_PARAMS || '',
  gatewayTlsCert: process.env.TLS_CERT || '',
  gatewayTlsKey: process.env.TLS_KEY || '',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--no-auto') {
      opts.auto = false;
    } else if (arg === '--no-benchmark') {
      opts.benchmark = false;
    } else if (arg === '--open') {
      opts.open = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--host') {
      opts.host = requireValue(argv, ++i, arg);
    } else if (arg === '--port') {
      opts.port = Number(requireValue(argv, ++i, arg));
    } else if (arg === '--ttl') {
      opts.ttlMs = parseDuration(requireValue(argv, ++i, arg), opts.ttlMs);
    } else if (arg === '--token') {
      opts.token = requireValue(argv, ++i, arg);
    } else if (arg === '--auth-scope') {
      opts.authScope = requireValue(argv, ++i, arg).toLowerCase();
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`端口不合法：${opts.port}`);
  }
  if (!opts.host) throw new Error('--host 不能为空');
  if (!['remote', 'all'].includes(opts.authScope)) {
    throw new Error('--auth-scope 只能是 remote 或 all');
  }
  if (!Number.isInteger(opts.gatewayPort) || opts.gatewayPort < 1 || opts.gatewayPort > 65535) {
    throw new Error(`网关端口不合法：${opts.gatewayPort}`);
  }
  if (!['remote', 'all'].includes(opts.gatewayAuthScope)) {
    throw new Error('AUTH_SCOPE 只能是 remote 或 all');
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value == null || value.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
  return value;
}

function printHelp() {
  console.log(`用法：node src/server.mjs [选项]

  --host <地址>     监听地址（默认 127.0.0.1；局域网/公网访问填 0.0.0.0）
  --port <端口>     监听端口（默认 18788）
  --ttl <时长>      缓存有效期（默认 8h）
  --token <口令>    访问口令（默认不启用）
  --auth-scope <s>  remote=只拦非本机（默认），all=本机也校验
  --no-auto         关闭自动采集，仍可在页面手动刷新
  --no-benchmark    关闭测速功能
  --open            启动后打开浏览器
  --quiet           不输出启动日志
  -h, --help        显示帮助

环境变量：
  NV_MODELS_HOST / NV_MODELS_PORT / NV_MODELS_TTL
  NV_MODELS_TOKEN / NV_MODELS_AUTH_SCOPE
  NV_MODELS_AUTO=0 等同 --no-auto
  NV_MODELS_SHOW_REFRESH=0 隐藏页面刷新按钮，并拒绝远程手动刷新
  NV_MODELS_SETTINGS=0 关闭网页设置页（改为 1 并重启恢复）
  NV_MODELS_TRANSLATE=off 关闭英文简介翻译
  NV_MODELS_BENCHMARK=0 等同 --no-benchmark
  NV_MODELS_BENCHMARK_KEY / NV_MODELS_BENCHMARK_URL
  NV_MODELS_BENCHMARK_SAMPLES / NV_MODELS_BENCHMARK_MAX_TOKENS
  NV_MODELS_BENCHMARK_TIMEOUT / NV_MODELS_BENCHMARK_GAP
  NV_MODELS_BENCHMARK_AUTO=24h 后台自动重扫过期结果，0 关闭
  测速 Key 也读取 NVIDIA_API_KEY
  NV_GATEWAY_HOST / NV_GATEWAY_PORT
  NV_GATEWAY_URL 客户端填写的地址（默认 http://127.0.0.1:<端口>/v1）
  NV_TRUST_PROXY=1 放在 nginx / Caddy 等本机反代后面时，
                   按 X-Real-IP / X-Forwarded-For 识别真实来源
  AUTH_TOKEN / AUTH_SCOPE 网关口令和校验范围
  模型短名自动维护（NVIDIA ID 去掉发布方前缀），无需配置
  NV_GATEWAY_KEY 网关密钥（默认 NVIDIA_API_KEY）
配置也可以写在项目根目录的 .env 里`);
}

const CFG = { ...DEFAULTS };
let benchmarker = null;
let gateway = null;

function gatewayBaseUrl() {
  if (CFG.gatewayUrl) return CFG.gatewayUrl.replace(/\/+$/, '');
  const scheme = CFG.gatewayTlsCert && CFG.gatewayTlsKey ? 'https' : 'http';
  const host =
    CFG.gatewayHost === '0.0.0.0' || CFG.gatewayHost === '::' ? '127.0.0.1' : CFG.gatewayHost;
  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${CFG.gatewayPort}/v1`;
}

function gatewayEndpoint() {
  const base = gatewayBaseUrl();
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function localGatewayBaseUrl() {
  const scheme = CFG.gatewayTlsCert && CFG.gatewayTlsKey ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${CFG.gatewayPort}/v1`;
}

function clientCatalog() {
  const cache = readJson(CFG.modelsFile);
  const models = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
  return buildCatalog(models, modelAliases());
}

// 模型短名（NVIDIA ID 去掉发布方前缀）由代码自动维护，.env 不用再配 MODEL_ALIASES。
// 万一模型缓存还没生成，先用这几个兜底，保证已接入的客户端不断。
const FALLBACK_ALIASES = new Map([
  ['glm-5.3-flash', 'z-ai/glm-5.3-flash'],
  ['deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4.1-flash'],
  ['mistral-large-4-1t-a52b', 'mistralai/mistral-large-4-1t-a52b'],
  ['muse-glimmer-30b', 'meta/muse-glimmer-30b'],
]);

function apiModelIds() {
  const cache = readJson(CFG.apiModelsFile);
  return Array.isArray(cache?.ids) ? cache.ids : [];
}

function filterModelsWithApiId(models, ids) {
  const list = Array.isArray(models) ? models : [];
  if (!ids.length) return list;
  const exact = new Set(ids);
  const normalized = new Set(ids.map((id) => normalizeModelId(id)));
  return list.filter((model) => {
    const id = String(model?.id || '').trim();
    return Boolean(id) && (exact.has(id) || normalized.has(normalizeModelId(id)));
  });
}

function modelAliases() {
  const cache = readJson(CFG.modelsFile);
  const models = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
  const map = buildModelAliases(models, apiModelIds(), FALLBACK_ALIASES);
  // 仍然支持 MODEL_ALIASES 覆盖，但默认配置里不再出现
  for (const part of String(CFG.gatewayAliases || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const target = part.slice(index + 1).trim();
    if (name && target) map.set(name, target);
  }
  return map;
}

function writeJsonFile(file, data) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
}

async function refreshApiModelMap() {
  const key = CFG.gatewayKey || CFG.benchmarkKey;
  if (!key) return false;
  try {
    const ids = await fetchApiModelIds({
      apiKey: key,
      apiBase: CFG.gatewayUpstream,
      timeoutMs: 12_000,
    });
    writeJsonFile(CFG.apiModelsFile, {
      fetchedAt: new Date().toISOString(),
      ids,
    });
    refreshGatewayAliases();
    log(`模型映射：API 可用 ${ids.length} 个，短名 ${modelAliases().size} 个`);
    return true;
  } catch (error) {
    warn(`模型映射刷新失败：${error.message}`);
    return false;
  }
}

function refreshGatewayAliases() {
  if (!gateway) return 0;
  const next = modelAliases();
  gateway.config.aliases.clear();
  for (const [name, id] of next) gateway.config.aliases.set(name, id);
  return next.size;
}

const refreshState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  nextRetryAt: 0,
  child: null,
  logTail: [],
};

function appendTail(line) {
  const text = String(line).replace(/\r/g, '').slice(0, 600);
  if (!text.trim()) return;
  refreshState.logTail.push(text);
  if (refreshState.logTail.length > 80) refreshState.logTail.shift();
}

function rotateLog() {
  try {
    const stat = fs.statSync(CFG.logFile);
    if (stat.size > 2 * 1024 * 1024) fs.renameSync(CFG.logFile, `${CFG.logFile}.1`);
  } catch {
    // 日志文件还不存在或正被占用，直接追加
  }
}

function startRefresh(reason) {
  if (refreshState.running) return false;

  ensureDir(path.dirname(CFG.logFile));
  rotateLog();
  refreshState.running = true;
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.error = null;
  refreshState.logTail = [];
  appendTail(`[server] 开始采集（${reason}）`);

  const logStream = fs.createWriteStream(CFG.logFile, { flags: 'a' });
  logStream.on('error', () => {});
  logStream.write(`\n===== ${new Date().toISOString()} ${reason} =====\n`);

  let child;
  try {
    child = spawn(
      process.execPath,
      [CFG.collector, '--out', CFG.modelsFile, '--status-out', CFG.statusFile],
      {
        cwd: ROOT_DIR,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    finishRefresh(logStream, null, null, error);
    return true;
  }

  refreshState.child = child;
  const pipe = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      logStream.write(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) appendTail(line);
    });
    stream.on('end', () => {
      if (buffer.trim()) appendTail(buffer);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    finishRefresh(logStream, code, signal, error);
  };
  child.on('error', (error) => finish(null, null, error));
  child.on('close', (code, signal) => finish(code, signal));
  return true;
}

function finishRefresh(logStream, code, signal, error) {
  logStream.end();
  refreshState.running = false;
  refreshState.finishedAt = new Date().toISOString();
  refreshState.child = null;

  const status = readJson(CFG.statusFile);
  if (error) {
    refreshState.error = error.message || String(error);
  } else if (code === 0) {
    refreshState.error = null;
  } else {
    refreshState.error = status?.error || `采集器退出码 ${code}${signal ? ` (${signal})` : ''}`;
  }
  refreshState.nextRetryAt = refreshState.error ? Date.now() + RETRY_AFTER_FAILURE_MS : 0;

  if (refreshState.error) {
    appendTail(`[server] 采集失败：${refreshState.error}`);
    warn(`采集失败：${refreshState.error}`);
  } else {
    const cache = readJson(CFG.modelsFile);
    appendTail(`[server] 采集完成：${cache?.count ?? '?'} 个模型`);
    log(`采集完成：${cache?.count ?? '?'} 个模型`);
    const aliasCount = refreshGatewayAliases();
    if (aliasCount) log(`模型短名已更新：${aliasCount} 个`);
    refreshApiModelMap().catch(() => {});
    benchmarker?.refreshMapping(true).catch(() => {});
  }
}

function cacheAgeMs() {
  const cache = readJson(CFG.modelsFile);
  const fetchedAt = Date.parse(cache?.fetchedAt || '');
  return Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Infinity;
}

function autoCheck() {
  if (!CFG.auto || refreshState.running) return;
  if (Date.now() < refreshState.nextRetryAt) return;
  if (cacheAgeMs() < CFG.ttlMs) return;
  log(`缓存已过期，开始自动采集`);
  startRefresh('auto');
}

function buildState({ auth = {}, settingsEnabled = false, canConfigure = false } = {}) {
  const rawCache = readJson(CFG.modelsFile);
  const allModels = Array.isArray(rawCache?.models) ? rawCache.models : [];
  const shortById = new Map();
  for (const model of clientCatalog()) {
    shortById.set(normalizeModelId(model.id), model.short);
  }
  const models = filterModelsWithApiId(allModels, apiModelIds()).map((model) => {
    const short = shortById.get(normalizeModelId(model?.id));
    return short ? { ...model, short } : model;
  });
  const cache = rawCache ? { ...rawCache, models, count: models.length } : rawCache;
  const status = readJson(CFG.statusFile);
  return {
    cache,
    status,
    gateway: {
      baseUrl: gatewayBaseUrl(),
      token: CFG.gatewayToken,
      available: Boolean(gateway?.server.listening),
    },
    refresh: {
      running: refreshState.running,
      startedAt: refreshState.startedAt,
      finishedAt: refreshState.finishedAt,
      error: refreshState.error,
      nextRetryAt: refreshState.nextRetryAt || null,
      logTail: refreshState.logTail.slice(-12),
    },
    benchmark: benchmarker ? benchmarker.snapshot() : null,
    server: {
      now: new Date().toISOString(),
      ttlMs: CFG.ttlMs,
      auto: CFG.auto,
      showRefresh: Boolean(CFG.showRefresh),
      authEnabled: Boolean(CFG.token),
      authScope: CFG.authScope,
      session: Boolean(auth.session),
      settingsEnabled: Boolean(settingsEnabled),
      canConfigure: Boolean(canConfigure),
    },
  };
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function isTrustedWrite(req, host) {
  if (req.headers['x-nv-models'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(httpError('请求体过大', 413));
        return;
      }
      if (!size) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(httpError('请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeSecret(value, label) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (text.length > 512) throw new SetupError(`${label} 过长`, 400);
  if (/[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new SetupError(`${label} 不能包含空格或控制字符`, 400);
  }
  return text;
}

function updateEnvFile(file, updates) {
  const entries = Object.entries(updates).filter(([, value]) => value != null);
  if (!entries.length) return;

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new SetupError(`读取 .env 失败：${error.message}`, 500);
  }
  const lines = text ? text.split(/\r?\n/) : [];
  const missing = [];

  for (const [key, value] of entries) {
    const line = `${key}=${value}`;
    const active = new RegExp(`^\\s*${key}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`);
    let index = lines.findIndex((current) => active.test(current));
    if (index < 0) index = lines.findIndex((current) => commented.test(current));
    if (index >= 0) lines[index] = line;
    else missing.push(line);
  }

  if (missing.length) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push('# 由首次配置页面写入', ...missing, '');
  }

  const content = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(temp, content, { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows 上 chmod 基本无效，忽略
    }
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 同上
    }
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 临时文件可能未创建
    }
    throw new SetupError(`写入 .env 失败：${error.message}`, 500);
  }
}

async function checkNvidiaKey(key) {
  const base = CFG.gatewayUpstream.replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return { ok: false, message: `暂时连不上 NVIDIA 校验 Key（${error.message}），已先保存` };
  }
  try {
    await response.body?.cancel();
  } catch {
    // 忽略释放失败
  }
  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      hard: true,
      message: 'API Key 无效或没有访问权限，请到 build.nvidia.com 重新创建',
    };
  }
  return { ok: false, message: `NVIDIA 校验返回 ${response.status}，已先保存` };
}

function setupRequired() {
  return !CFG.gatewayKey && !CFG.benchmarkKey;
}

function settingsAllowed() {
  return Boolean(CFG.settings) || setupRequired();
}

function translationEnabled() {
  return !['0', 'off', 'false', 'no'].includes(String(CFG.translate || '').toLowerCase());
}

function parseToggle(value, label) {
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  if (value === undefined || value === null || value === '') return null;
  throw new SetupError(`${label} 只能是 0 或 1`, 400);
}

function setupStatus() {
  return {
    firstRun: setupRequired(),
    hasKey: Boolean(CFG.gatewayKey || CFG.benchmarkKey),
    hasToken: Boolean(CFG.gatewayToken),
    hasPanelToken: Boolean(CFG.token),
    gatewayAvailable: Boolean(gateway?.server.listening),
    settingsEnabled: settingsAllowed(),
    settingsSwitch: Boolean(CFG.settings),
    benchmarkEnabled: Boolean(CFG.benchmark),
    benchmarkAutoMs: CFG.benchmarkAutoMs,
    benchmarkAutoLabel: CFG.benchmarkAutoMs ? formatDuration(CFG.benchmarkAutoMs) : '关闭',
    translateEnabled: translationEnabled(),
    auto: Boolean(CFG.auto),
    showRefresh: Boolean(CFG.showRefresh),
    ttlMs: CFG.ttlMs,
    ttlLabel: formatDuration(CFG.ttlMs),
    authScope: CFG.gatewayAuthScope,
  };
}

function canConfigure(req) {
  if (isLoopback(req)) return true;
  return authenticated(req);
}

async function applySetupConfig({
  key,
  keyChanged,
  token,
  panelToken,
  panelTokenChanged,
  refresh,
  showRefresh,
  benchmarkEnabled,
  benchmarkAutoMs,
  translateEnabled,
  settingsEnabled,
}) {
  const warnings = [];

  if (keyChanged) {
    process.env.NVIDIA_API_KEY = key;
    if (process.env.NV_MODELS_BENCHMARK_KEY) process.env.NV_MODELS_BENCHMARK_KEY = key;
    CFG.gatewayKey = key;
    CFG.benchmarkKey = key;
  }

  if (token !== CFG.gatewayToken) {
    process.env.AUTH_TOKEN = token;
    CFG.gatewayToken = token;
  }

  if (panelTokenChanged) {
    process.env.NV_MODELS_TOKEN = panelToken;
    CFG.token = panelToken;
    sessionKeyCache = null;
  }

  if (showRefresh !== null && showRefresh !== undefined && showRefresh !== CFG.showRefresh) {
    process.env.NV_MODELS_SHOW_REFRESH = showRefresh ? '1' : '0';
    CFG.showRefresh = showRefresh;
  }

  const benchmarkChanged =
    benchmarkEnabled !== null && benchmarkEnabled !== undefined && benchmarkEnabled !== CFG.benchmark;
  if (benchmarkChanged) {
    CFG.benchmark = benchmarkEnabled;
    process.env.NV_MODELS_BENCHMARK = benchmarkEnabled ? '1' : '0';
  }

  const benchmarkAutoChanged =
    benchmarkAutoMs !== null &&
    benchmarkAutoMs !== undefined &&
    benchmarkAutoMs !== CFG.benchmarkAutoMs;
  if (benchmarkAutoChanged) {
    CFG.benchmarkAutoMs = benchmarkAutoMs;
    process.env.NV_MODELS_BENCHMARK_AUTO = benchmarkAutoMs
      ? formatDuration(benchmarkAutoMs)
      : '0';
  }

  if (
    translateEnabled !== null &&
    translateEnabled !== undefined &&
    translateEnabled !== translationEnabled()
  ) {
    CFG.translate = translateEnabled ? 'on' : 'off';
    process.env.NV_MODELS_TRANSLATE = CFG.translate;
  }

  if (settingsEnabled !== null && settingsEnabled !== undefined) {
    CFG.settings = settingsEnabled;
    process.env.NV_MODELS_SETTINGS = settingsEnabled ? '1' : '0';
  }

  if (gateway) {
    gateway.config.apiKey = CFG.gatewayKey || CFG.benchmarkKey;
    gateway.config.authToken = token;
    if (keyChanged) await refreshApiModelMap();
  } else if (CFG.gatewayKey || CFG.benchmarkKey) {
    try {
      await startGateway({ fatal: false });
    } catch (error) {
      warnings.push(`API 未能启动：${error.message}`);
    }
  }

  if (keyChanged || benchmarkChanged || benchmarkAutoChanged) {
    benchmarker?.stop();
    benchmarker = buildBenchmarker();
    benchmarker.refreshMapping().catch(() => {});
    benchmarker.startAuto();
  }

  if (refresh === 'off') {
    CFG.auto = false;
    process.env.NV_MODELS_AUTO = '0';
  } else if (refresh) {
    CFG.auto = true;
    CFG.ttlMs = parseDuration(refresh, CFG.ttlMs);
    process.env.NV_MODELS_AUTO = '1';
    process.env.NV_MODELS_TTL = refresh;
    setTimeout(autoCheck, 0);
  }

  return warnings;
}

function safeNextPath(value) {
  const text = String(value || '');
  if (!text.startsWith('/') || text.startsWith('//') || text.startsWith('/\\')) return '/';
  return text;
}

function sendLoginRedirect(res, url) {
  const next = `${url.pathname}${url.search}`;
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    location: `/login?next=${encodeURIComponent(safeNextPath(next))}`,
    'cache-control': 'no-store',
  });
  res.end();
}

function serveStatic(pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }
  if (relative === '/') relative = '/index.html';
  if (relative.includes('\0')) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const resolved = path.resolve(PUBLIC_DIR, `.${relative}`);
  const root = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(root)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(resolved, (error, stat) => {
    if (error || !stat.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': type,
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

async function handleRequest(req, res) {
  const host = req.headers.host || 'localhost';
  let url;
  try {
    url = new URL(req.url || '/', `http://${host}`);
  } catch {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  const pathname = url.pathname;

  if (pathname === '/login' || pathname === '/login.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    if (!CFG.token) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        location: '/',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    if (needsAuth(req) && authenticated(req)) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        location: safeNextPath(url.searchParams.get('next')),
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    serveStatic('/login.html', req, res);
    return;
  }

  if (pathname === '/api/login') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!CFG.token) {
      sendJson(res, 400, { error: '未设置网页访问口令，可直接打开面板' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const key = loginClientKey(req);
    const waitMs = loginBlockedFor(key);
    if (waitMs) {
      res.setHeader('retry-after', String(Math.ceil(waitMs / 1000)));
      sendJson(res, 429, {
        error: `尝试次数过多，请 ${Math.ceil(waitMs / 60_000)} 分钟后再试`,
      });
      return;
    }
    try {
      const body = await readJsonBody(req, 4096);
      if (!tokenMatches(String(body.token ?? ''))) {
        recordLoginFailure(key);
        warn(`网页登录失败：${key}`);
        sendJson(res, 401, { error: '口令不正确' });
        return;
      }
      loginFailures.delete(key);
      const expiresAt = Date.now() + SESSION_TTL_MS;
      res.setHeader(
        'set-cookie',
        sessionCookie(req, signSession(expiresAt), Math.floor(SESSION_TTL_MS / 1000)),
      );
      log(`网页登录成功：${key}`);
      sendJson(res, 200, { ok: true, expiresAt: new Date(expiresAt).toISOString() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/logout') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    sendJson(res, 200, { ok: true });
    return;
  }

  const publicAsset =
    pathname === '/login.js' || pathname === '/style.css' || pathname === '/favicon.ico';
  if (pathname !== '/api/health' && !publicAsset && needsAuth(req) && !authenticated(req)) {
    if (pathname.startsWith('/api/')) {
      sendJson(res, 401, { error: '请先登录', login: true });
    } else {
      sendLoginRedirect(res, url);
    }
    return;
  }

  if (pathname === '/api/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const cache = readJson(CFG.modelsFile);
    sendJson(res, 200, {
      ok: true,
      instance: INSTANCE_ID,
      count: cache?.count ?? 0,
      fetchedAt: cache?.fetchedAt ?? null,
      refreshing: refreshState.running,
      gateway: Boolean(gateway?.server.listening),
    });
    return;
  }

  if (pathname === '/api/state') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const session = sessionAuthenticated(req);
    sendJson(
      res,
      200,
      buildState({
        auth: { session },
        settingsEnabled: settingsAllowed(),
        canConfigure: canConfigure(req),
      }),
    );
    return;
  }

  if (pathname === '/api/setup') {
    if (!settingsAllowed()) {
      sendJson(res, 403, {
        error: '设置页已关闭。在 .env 中设置 NV_MODELS_SETTINGS=1 并重启服务后可重新打开',
      });
      return;
    }
    if (!canConfigure(req)) {
      sendJson(res, 403, {
        error: '无权修改配置：请在本机打开页面，或先在 .env 设置 NV_MODELS_TOKEN 并登录',
      });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ...setupStatus(),
        session: sessionAuthenticated(req),
        remoteAuth: needsAuth(req),
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    try {
      const body = await readJsonBody(req, 16 * 1024);
      const warnings = [];
      const firstRun = setupRequired();
      const currentKey = CFG.gatewayKey || CFG.benchmarkKey || '';
      let key = currentKey;
      let keyChanged = false;

      if (body.key !== undefined && body.key !== null && String(body.key).trim() !== '') {
        const candidate = sanitizeSecret(body.key, 'API Key');
        if (!/^nvapi-/i.test(candidate)) {
          throw new SetupError('API Key 应以 nvapi- 开头，请检查是否复制完整', 400);
        }
        if (candidate !== currentKey) {
          const check = await checkNvidiaKey(candidate);
          if (check.hard) throw new SetupError(check.message, 400);
          if (!check.ok) warnings.push(check.message);
          key = candidate;
          keyChanged = true;
        }
      } else if (firstRun) {
        throw new SetupError('请填写 NVIDIA_API_KEY', 400);
      }

      let token = CFG.gatewayToken;
      const benchmarkEnabled = parseToggle(body.benchmark, '测速开关');
      const translateEnabled = parseToggle(body.translate, '翻译开关');
      const settingsEnabled = parseToggle(body.settings, '设置页开关');
      let benchmarkAutoMs = null;
      const benchmarkAutoInput = String(body.benchmarkAuto ?? '').trim();
      if (benchmarkAutoInput) {
        if (benchmarkAutoInput === 'off' || benchmarkAutoInput === '0') {
          benchmarkAutoMs = 0;
        } else {
          const ms = parseDuration(benchmarkAutoInput, 0);
          if (!ms || ms < 3_600_000 || ms > 30 * 86_400_000) {
            throw new SetupError('后台测速间隔需在 1h 到 30d 之间，或选择关闭', 400);
          }
          benchmarkAutoMs = ms;
        }
      }
      if (body.clearToken === true) token = '';
      else if (body.token !== undefined && String(body.token).trim() !== '') {
        token = sanitizeSecret(body.token, '网关口令');
      } else if (!token && firstRun) {
        token = `nv-${randomBytes(16).toString('hex')}`;
      }

      let panelToken = CFG.token;
      let panelTokenChanged = false;
      if (body.clearPanelToken === true) {
        if (panelToken) {
          panelToken = '';
          panelTokenChanged = true;
        }
      } else if (body.panelToken !== undefined && String(body.panelToken).trim() !== '') {
        const candidate = sanitizeSecret(body.panelToken, '网页口令');
        if (candidate !== panelToken) {
          panelToken = candidate;
          panelTokenChanged = true;
        }
      }

      let showRefresh = null;
      if (typeof body.showRefresh === 'boolean') {
        showRefresh = body.showRefresh;
      } else if (body.showRefresh === '0' || body.showRefresh === '1') {
        showRefresh = body.showRefresh === '1';
      } else if (body.showRefresh !== undefined && body.showRefresh !== null && body.showRefresh !== '') {
        throw new SetupError('showRefresh 只能是 0 或 1', 400);
      }

      let refresh = null;
      if (body.refresh !== undefined && body.refresh !== null && String(body.refresh).trim() !== '') {
        const raw = String(body.refresh).trim();
        if (raw === 'off') {
          refresh = 'off';
        } else {
          const ms = parseDuration(raw, 0);
          if (!ms || ms < 60_000 || ms > 30 * 86_400_000) {
            throw new SetupError('刷新间隔需在 1m 到 30d 之间，或选择关闭', 400);
          }
          refresh = formatDuration(ms);
        }
      }

      const envUpdates = {};
      if (keyChanged) envUpdates.NVIDIA_API_KEY = key;
      if (token !== CFG.gatewayToken) envUpdates.AUTH_TOKEN = token;
      if (panelTokenChanged) envUpdates.NV_MODELS_TOKEN = panelToken;
      if (showRefresh !== null && showRefresh !== CFG.showRefresh) {
        envUpdates.NV_MODELS_SHOW_REFRESH = showRefresh ? '1' : '0';
      }
      if (benchmarkEnabled !== null && benchmarkEnabled !== CFG.benchmark) {
        envUpdates.NV_MODELS_BENCHMARK = benchmarkEnabled ? '1' : '0';
      }
      if (benchmarkAutoMs !== null && benchmarkAutoMs !== CFG.benchmarkAutoMs) {
        envUpdates.NV_MODELS_BENCHMARK_AUTO = benchmarkAutoMs
          ? formatDuration(benchmarkAutoMs)
          : '0';
      }
      if (translateEnabled !== null && translateEnabled !== translationEnabled()) {
        envUpdates.NV_MODELS_TRANSLATE = translateEnabled ? 'on' : 'off';
      }
      if (settingsEnabled !== null && settingsEnabled !== CFG.settings) {
        envUpdates.NV_MODELS_SETTINGS = settingsEnabled ? '1' : '0';
      }
      if (refresh === 'off') {
        envUpdates.NV_MODELS_AUTO = '0';
      } else if (refresh) {
        envUpdates.NV_MODELS_AUTO = '1';
        envUpdates.NV_MODELS_TTL = refresh;
      }
      updateEnvFile(ENV_FILE, envUpdates);

      const applied = await applySetupConfig({
        key,
        keyChanged,
        token,
        panelToken,
        panelTokenChanged,
        refresh,
        showRefresh,
        benchmarkEnabled,
        benchmarkAutoMs,
        translateEnabled,
        settingsEnabled,
      });
      warnings.push(...applied);
      sendJson(res, 200, {
        ok: true,
        warning: warnings.join('；'),
        settingsClosed: settingsEnabled === false,
        reloginRequired: panelTokenChanged && Boolean(panelToken),
        status: { ...setupStatus(), session: sessionAuthenticated(req) },
      });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) warn(`保存配置失败：${error.message}`);
      sendJson(res, statusCode, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/clients/script') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const client = String(url.searchParams.get('client') || '');
    if (!CLIENT_IDS.includes(client)) {
      sendJson(res, 400, { error: `client 必须是 ${CLIENT_IDS.join('、')}` });
      return;
    }
    const catalog = clientCatalog();
    if (!catalog.length) {
      sendJson(res, 409, { error: '模型列表为空，请先采集模型' });
      return;
    }
    try {
      const model = String(url.searchParams.get('model') || '').trim();
      const all = url.searchParams.get('models') === 'all' || !model;
      const { selected, unknown } = selectModels(catalog, all ? 'all' : model);
      if (unknown.length) throw new SetupError(`未知模型：${unknown.join(', ')}`, 400);
      const formatValue = String(
        url.searchParams.get('format') || url.searchParams.get('platform') || 'sh',
      ).toLowerCase();
      const windows = ['bat', 'batch', 'cmd', 'win', 'windows', 'win32'].includes(formatValue);
      const fileName = setupScriptFileName({
        client,
        model: all ? '' : selected[0]?.short,
        all,
        format: windows ? 'bat' : 'sh',
      });
      const script = buildSetupScript({
        client,
        models: selected,
        baseUrl: gatewayBaseUrl(),
        token: CFG.gatewayToken,
        format: windows ? 'bat' : 'sh',
        fileName,
      });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': windows
          ? 'application/x-bat; charset=utf-8'
          : 'application/x-sh; charset=utf-8',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(script),
      });
      res.end(script);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/clients') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const catalog = clientCatalog();
    const available = Boolean(gateway?.server.listening);
    const gatewayInfo = {
      available,
      models: catalog.length,
      modelNames: catalog.map((model) => model.short),
      mapped: apiModelIds().length > 0,
      baseUrl: localGatewayBaseUrl(),
    };
    if (!isSameHost(req)) {
      sendJson(res, 200, {
        local: false,
        platform: process.platform,
        gateway: gatewayInfo,
        clients: [],
      });
      return;
    }
    const info = detectClients({ catalog, baseUrl: localGatewayBaseUrl() });
    sendJson(res, 200, {
      local: true,
      platform: process.platform,
      gateway: gatewayInfo,
      ...info,
    });
    return;
  }

  if (pathname === '/api/clients/add' || pathname === '/api/clients/remove') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!isSameHost(req)) {
      sendJson(res, 403, { error: '页面不是从本机打开的，无法写入本机客户端配置' });
      return;
    }
    if (!gateway?.server.listening) {
      sendJson(res, 409, { error: 'API 服务器未启动，无法写入客户端配置' });
      return;
    }
    try {
      const body = await readJsonBody(req, 64 * 1024);
      const client = body.client == null ? 'all' : body.client;
      if (pathname === '/api/clients/remove') {
        const results = removeSetup({
          clients: client,
          baseUrl: localGatewayBaseUrl(),
        });
        const failed = results.find((result) => !result.ok);
        sendJson(res, failed ? failed.statusCode || 500 : 200, { ok: !failed, results });
        return;
      }
      const models = body.models == null ? 'all' : body.models;
      if (typeof models !== 'string' && !Array.isArray(models)) {
        throw new SetupError('models 必须是模型名数组或 all', 400);
      }
      const catalog = clientCatalog();
      if (!catalog.length) throw new SetupError('模型列表为空，请先采集模型', 409);
      const results = applySetup({
        clients: client,
        catalog,
        models,
        baseUrl: localGatewayBaseUrl(),
        token: CFG.gatewayToken,
      });
      const failed = results.find((result) => !result.ok);
      sendJson(res, failed ? failed.statusCode || 500 : 200, { ok: !failed, results });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!CFG.showRefresh && !isLoopback(req)) {
      sendJson(res, 403, { error: '手动刷新已关闭' });
      return;
    }
    req.resume();
    refreshState.nextRetryAt = 0;
    const started = startRefresh('manual');
    sendJson(res, 202, {
      started,
      running: refreshState.running,
      startedAt: refreshState.startedAt,
    });
    return;
  }

  if (pathname === '/api/benchmark') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!benchmarker) {
      sendJson(res, 409, { error: '测速功能未启用' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await benchmarker.startSingle(typeof body.id === 'string' ? body.id : '');
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (pathname === '/api/benchmark/cancel') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!isTrustedWrite(req, host)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!benchmarker) {
      sendJson(res, 409, { error: '测速功能未启用' });
      return;
    }
    req.resume();
    const cancelled = benchmarker.cancel();
    sendJson(res, 200, { cancelled, running: cancelled });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (pathname === '/setup') {
    if (!settingsAllowed()) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        location: '/',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    serveStatic('/setup.html', req, res);
    return;
  }

  if (setupRequired() && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      location: '/setup',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  serveStatic(pathname, req, res);
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => warn(`无法自动打开浏览器，请手动访问 ${url}`));
    child.unref();
  } catch {
    warn(`无法自动打开浏览器，请手动访问 ${url}`);
  }
}

async function startGateway({ fatal = true } = {}) {
  const apiKey = CFG.gatewayKey || CFG.benchmarkKey;
  if (!apiKey) {
    warn('API：未启动（缺少 NVIDIA_API_KEY）');
    return;
  }

  await refreshApiModelMap();

  gateway = createGateway({
    host: CFG.gatewayHost,
    port: CFG.gatewayPort,
    upstream: CFG.gatewayUpstream,
    apiKey,
    authToken: CFG.gatewayToken,
    authScope: CFG.gatewayAuthScope,
    trustProxy: CFG.trustProxy,
    aliases: modelAliases(),
    maxBodyMB: CFG.gatewayMaxBodyMB,
    upstreamIdleTimeoutMs: CFG.gatewayIdleTimeoutMs,
    defaultReasoningEffort: CFG.gatewayReasoningEffort,
    disabledEffort: CFG.gatewayDisabledEffort,
    strip: CFG.gatewayStrip ? CFG.gatewayStrip.split(',') : [],
    tlsCert: CFG.gatewayTlsCert,
    tlsKey: CFG.gatewayTlsKey,
    log,
  });

  try {
    await gateway.listen();
  } catch (error) {
    gateway = null;
    console.error(`API 启动失败：${error.message}`);
    if (error.code === 'EADDRINUSE') {
      console.error(
        `端口 ${CFG.gatewayPort} 已被占用，请先停止旧网关（例如 nv stop）或修改 NV_GATEWAY_PORT`,
      );
    }
    if (fatal) process.exit(1);
    throw error;
  }

  log(`API：${gatewayEndpoint()}`);
  log(
    `网关鉴权：${
      CFG.gatewayToken
        ? CFG.gatewayAuthScope === 'all'
          ? '开启（本机也校验）'
          : '开启（仅非本机）'
        : '关闭'
    }`,
  );
  if (gateway.config.aliases.size) {
    const sample = [...gateway.config.aliases.keys()].slice(0, 3).join(', ');
    log(`模型短名：${gateway.config.aliases.size} 个（如 ${sample}…），客户端可直接填短名`);
  }
}

function buildBenchmarker() {
  return createBenchmarkManager({
    enabled: CFG.benchmark,
    apiKey: CFG.benchmarkKey,
    apiBase: CFG.benchmarkApiBase,
    modelsFile: CFG.modelsFile,
    resultsFile: CFG.benchmarkResultsFile,
    prompt: CFG.benchmarkPrompt,
    samples: Number(CFG.benchmarkSamples),
    maxTokens: Number(CFG.benchmarkMaxTokens),
    timeoutMs: CFG.benchmarkTimeoutMs,
    gapMs: CFG.benchmarkGapMs,
    autoIntervalMs: CFG.benchmarkAutoMs,
    log,
    warn,
  });
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }
  Object.assign(CFG, opts);

  ensureDir(path.dirname(CFG.modelsFile));
  ensureDir(path.dirname(CFG.statusFile));
  ensureDir(path.dirname(CFG.logFile));
  ensureDir(path.dirname(CFG.benchmarkResultsFile));

  benchmarker = buildBenchmarker();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      warn(`请求处理失败：${error.stack || error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${CFG.port} 已被占用，请用 --port 换一个端口`);
    } else {
      console.error(`服务启动失败：${error.message}`);
    }
    process.exit(1);
  });

  server.listen(CFG.port, CFG.host, () => {
    writePidFile();
    const displayHost = CFG.host === '0.0.0.0' || CFG.host === '::' ? '127.0.0.1' : CFG.host;
    const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${CFG.port}`;
    const cache = readJson(CFG.modelsFile);
    if (!CFG.quiet) {
      log('NVIDIA 免费模型浏览器已启动');
      log(`地址：${url}`);
      if (cache?.count) {
        log(`缓存：${cache.count} 个模型，抓取于 ${cache.fetchedAt}`);
      } else {
        log('缓存：暂无');
      }
      log(`自动刷新：${CFG.auto ? `开启（每 ${formatDuration(CFG.ttlMs)}）` : '关闭'}`);
      log(
        `测速：${
          benchmarker.available()
            ? CFG.benchmarkAutoMs
              ? `已启用（后台自动重扫 ${formatDuration(CFG.benchmarkAutoMs)}）`
              : '已启用（后台自动测速关闭）'
            : '未启用（缺少 NVIDIA_API_KEY）'
        }`,
      );
      log(`访问口令：${CFG.token ? `已启用（${CFG.authScope === 'all' ? '本机也校验' : '仅非本机'}）` : '未启用'}`);
    }
    if (CFG.host !== '127.0.0.1' && CFG.host !== 'localhost' && CFG.host !== '::1') {
      if (CFG.token) {
        warn('当前监听的不是本机地址，访问口令已启用');
      } else {
        warn('当前监听的不是本机地址，且未设置访问口令：任何能访问该端口的人都能查看和刷新数据');
      }
    }
    if (CFG.open) openBrowser(url);
    startGateway().catch((error) => {
      console.error(`API 启动失败：${error.message}`);
      process.exit(1);
    });
    benchmarker.refreshMapping().catch(() => {});
    benchmarker.startAuto();
    setTimeout(autoCheck, 400);
  });

  const timer = setInterval(autoCheck, 10 * 60_000);
  timer.unref();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在停止`);
    benchmarker?.stop();
    gateway?.close();
    removePidFile();
    if (refreshState.child) {
      try {
        refreshState.child.kill();
      } catch {
        // 子进程可能已经退出
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', removePidFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
