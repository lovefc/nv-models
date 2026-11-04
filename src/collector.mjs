#!/usr/bin/env node
/**
 * 采集 build.nvidia.com/models 上标记为 Free Endpoint 的模型。
 *
 * 用法：
 *   node src/collector.mjs                 立即抓取并写入 data/models.json
 *   node src/collector.mjs --if-stale      缓存不足 8 小时就跳过（给定时任务用）
 *
 * 列表页自带 nimType 过滤参数，默认只取 Free Endpoint，通常 2 页即可。
 * 页面同时给出服务端渲染的卡片和 Next.js RSC 数据，优先使用后者（含日期、标签、logo）。
 * 翻页间隔默认 10s，遵守 robots.txt 的 Crawl-delay；连续快速请求会触发 AWS WAF（HTTP 202 challenge），
 * 这里会自动退避重试；失败时保留上一次的缓存。
 *
 * 英文简介默认通过微软 Edge 翻译接口（免密钥）批量翻译成中文，
 * 译文按原文哈希缓存在 data/translations.json，只有新增或变化的描述才会重新翻译。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
loadDotEnv(path.join(ROOT_DIR, '.env'));
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 nv-models-collector/0.1';
const CARD_MARK = 'data-testid="nv-card-root"';
const FREE_FILTER = 'nimType:nim_type_preview';
const SCHEMA_VERSION = 3;
const TRANSLATE_BATCH = 15;
const TRANSLATE_URL = 'https://edge.microsoft.com/translate/translatetext';
const TRANSLATE_TO = 'zh-Hans';
const TRANSLATE_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const DEFAULTS = {
  baseUrl: process.env.NV_MODELS_URL || 'https://build.nvidia.com/models',
  out: process.env.NV_MODELS_OUT || path.join(ROOT_DIR, 'data', 'models.json'),
  statusOut: process.env.NV_MODELS_STATUS || '',
  filter: process.env.NV_MODELS_FILTER || FREE_FILTER,
  filterFree: true,
  delayMs: parseDuration(process.env.NV_MODELS_DELAY, 10_000),
  ttlMs: parseDuration(process.env.NV_MODELS_TTL, 8 * 3_600_000),
  timeoutMs: parseDuration(process.env.NV_MODELS_TIMEOUT, 60_000),
  retryBaseMs: parseDuration(process.env.NV_MODELS_RETRY_BASE, 20_000),
  retries: 4,
  maxPages: 20,
  ifStale: false,
  saveRaw: false,
  quiet: false,
  translate: (process.env.NV_MODELS_TRANSLATE || 'auto').toLowerCase(),
  translateCache: process.env.NV_MODELS_TRANSLATE_CACHE || '',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--if-stale') {
      opts.ifStale = true;
    } else if (arg === '--translate') {
      opts.translate = 'on';
    } else if (arg === '--no-translate') {
      opts.translate = 'off';
    } else if (arg === '--raw') {
      opts.saveRaw = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--all') {
      opts.filterFree = false;
    } else if (arg === '--filter') {
      opts.filter = requireValue(argv, ++i, arg);
      opts.filterFree = true;
    } else if (arg === '--out') {
      opts.out = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === '--status-out') {
      opts.statusOut = path.resolve(requireValue(argv, ++i, arg));
    } else if (arg === '--base') {
      opts.baseUrl = requireValue(argv, ++i, arg);
    } else if (arg === '--delay') {
      opts.delayMs = parseDuration(requireValue(argv, ++i, arg), opts.delayMs);
    } else if (arg === '--ttl') {
      opts.ttlMs = parseDuration(requireValue(argv, ++i, arg), opts.ttlMs);
    } else if (arg === '--timeout') {
      opts.timeoutMs = parseDuration(requireValue(argv, ++i, arg), opts.timeoutMs);
    } else if (arg === '--retry-base') {
      opts.retryBaseMs = parseDuration(requireValue(argv, ++i, arg), opts.retryBaseMs);
    } else if (arg === '--retries') {
      opts.retries = Math.max(0, Number(requireValue(argv, ++i, arg)) || 0);
    } else if (arg === '--max-pages') {
      opts.maxPages = Math.max(1, Number(requireValue(argv, ++i, arg)) || 1);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!opts.statusOut) opts.statusOut = path.join(path.dirname(opts.out), 'status.json');
  if (!opts.translateCache) opts.translateCache = path.join(path.dirname(opts.out), 'translations.json');
  else opts.translateCache = path.resolve(opts.translateCache);
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value == null || value.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
  return value;
}

function printHelp() {
  console.log(`用法：node src/collector.mjs [选项]

  --if-stale        缓存未超过 --ttl 时直接跳过
  --ttl <时长>      缓存有效期，如 8h、30m（默认 8h）
  --delay <时长>    翻页间隔（默认 10s，遵守 robots.txt）
  --max-pages <n>   最多抓取页数（默认 20）
  --out <文件>      输出文件（默认 data/models.json）
  --status-out <文件>  状态文件（默认与 models.json 同目录的 status.json）
  --base <网址>     列表页地址（默认 https://build.nvidia.com/models）
  --filter <值>     自定义过滤条件（默认 ${FREE_FILTER}）
  --all             不加 Free Endpoint 过滤，扫完整目录
  --timeout <时长>  单次请求超时（默认 60s）
  --retry-base <时长>  WAF/网络失败后的首次等待（默认 20s，逐次翻倍）
  --retries <n>     重试次数（默认 4）
  --translate       启用英文描述翻译（默认开启，必应免费接口，无需 Key）
  --no-translate    跳过描述翻译
  --raw             保存原始 HTML 到 data/raw/
  --quiet           只输出错误
  -h, --help        显示帮助

翻译相关环境变量：
  NV_MODELS_TRANSLATE=auto|on|off
  NV_MODELS_TRANSLATE_CACHE`);
}

function log(opts, ...args) {
  if (!opts.quiet) console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function translationEnabled(opts) {
  return !['0', 'off', 'false', 'no'].includes(opts.translate);
}

async function requestTranslation(batch) {
  const url = new URL(TRANSLATE_URL);
  url.searchParams.set('from', '');
  url.searchParams.set('to', TRANSLATE_TO);
  url.searchParams.set('isEnterpriseClient', 'false');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim();
      throw new Error(`翻译接口 HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
    }
    const payload = await res.json();
    if (!Array.isArray(payload)) throw new Error('翻译接口返回格式异常');
    if (payload.length !== batch.length) {
      const error = new Error(`译文条数不符（期望 ${batch.length}，实际 ${payload.length}）`);
      error.split = true;
      throw error;
    }
    return payload.map((item, index) => {
      const text = item?.translations?.[0]?.text;
      if (typeof text !== 'string' || !text.trim()) {
        const error = new Error(`第 ${index + 1} 条没有译文`);
        error.split = true;
        throw error;
      }
      return text.trim();
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`翻译请求超时（${formatDuration(TRANSLATE_TIMEOUT_MS)}）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function translateBatch(batch, opts, results) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const translated = await requestTranslation(batch);
      batch.forEach((source, index) => {
        if (translated[index]) results.set(source, translated[index]);
      });
      return;
    } catch (error) {
      if (attempt === 0) {
        await sleep(3_000);
        continue;
      }
      if (batch.length > 1 && error.split) {
        const mid = Math.ceil(batch.length / 2);
        warn(`  翻译 ${batch.length} 条失败（${error.message}），拆成两批重试`);
        await translateBatch(batch.slice(0, mid), opts, results);
        await translateBatch(batch.slice(mid), opts, results);
        return;
      }
      warn(`  翻译失败，保留英文：${error.message}`);
      return;
    }
  }
}

async function translateModels(opts, models) {
  if (!translationEnabled(opts)) return;

  const cache = readJson(opts.translateCache);
  const entries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};
  const pending = new Map();
  let hits = 0;

  for (const model of models) {
    const source = (model.description || '').trim();
    if (!source) continue;
    const key = hashText(source);
    const cached = entries[key];
    if (cached?.zh) {
      model.descriptionZh = cached.zh;
      hits++;
    } else if (!pending.has(key)) {
      pending.set(key, source);
    }
  }

  if (!pending.size) {
    log(opts, `翻译：${hits} 条全部命中缓存`);
    return;
  }

  log(opts, `翻译：${pending.size} 条新描述，必应翻译…`);
  const sources = [...pending.values()];
  const results = new Map();
  for (let i = 0; i < sources.length; i += TRANSLATE_BATCH) {
    const batch = sources.slice(i, i + TRANSLATE_BATCH);
    const startedAt = Date.now();
    await translateBatch(batch, opts, results);
    log(
      opts,
      `  第 ${Math.floor(i / TRANSLATE_BATCH) + 1} 批：${batch.length} 条，${formatDuration(Date.now() - startedAt)}`,
    );
  }

  if (!results.size) return;
  const now = new Date().toISOString();
  for (const [source, zh] of results) {
    entries[hashText(source)] = { en: source, zh, at: now };
  }
  writeJsonAtomic(opts.translateCache, { schemaVersion: 1, updatedAt: now, entries });

  for (const model of models) {
    if (model.descriptionZh) continue;
    const source = (model.description || '').trim();
    if (!source) continue;
    const cached = entries[hashText(source)];
    if (cached?.zh) model.descriptionZh = cached.zh;
  }
  log(opts, `翻译完成：${results.size} 条已写入 ${opts.translateCache}`);
}

function cacheAgeMs(cache) {
  const fetchedAt = Date.parse(cache?.fetchedAt || '');
  return Number.isFinite(fetchedAt) ? Date.now() - fetchedAt : Infinity;
}

class RetryableError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
  }
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(headers) {
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    if (!values.length) {
      const single = headers.get('set-cookie');
      if (single) values.push(single);
    }
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const cookieValue = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (/max-age=0/i.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function fetchOnce(url, opts, jar, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
  };
  if (referer) headers.referer = referer;
  const cookie = jar.header();
  if (cookie) headers.cookie = cookie;

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    const html = await res.text();
    jar.absorb(res.headers);

    const waf = (res.headers.get('x-amzn-waf-action') || '').toLowerCase();
    if (waf === 'challenge' || (res.status === 202 && html.trim().length < 4096)) {
      throw new RetryableError(`被 WAF 拦截（HTTP ${res.status}${waf ? `，${waf}` : ''}）`, res.status);
    }
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new RetryableError(`上游返回 HTTP ${res.status}`, res.status);
    }
    if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
    return html;
  } catch (error) {
    if (error instanceof RetryableError) throw error;
    if (error.name === 'AbortError') throw new RetryableError(`请求超时（${formatDuration(opts.timeoutMs)}）`);
    throw new RetryableError(`网络错误：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(url, opts, jar, referer) {
  let lastError;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fetchOnce(url, opts, jar, referer);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableError) || attempt === opts.retries) break;
      const wait = Math.round(opts.retryBaseMs * 2 ** attempt + Math.random() * 3_000);
      log(opts, `  ${error.message}，${formatDuration(wait)} 后重试（${attempt + 1}/${opts.retries}）`);
      await sleep(wait);
    }
  }
  throw lastError;
}

function decodeEntities(input) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (named[key] != null) return named[key];
    const value = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}

function cleanText(input) {
  return decodeEntities(String(input).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSlug(input) {
  return String(input || '').trim().toLowerCase().replace(/_/g, '-');
}

function firstValue(label) {
  return label?.values?.[0] || label?.unresolvedValues?.[0] || '';
}

function parseFilterCount(html) {
  const match = html.match(
    /Free Endpoint<\/span><span class="nv-menu-item-slot">[\s\S]{0,500}?data-testid="nv-text">(\d+)<\/span>/i,
  );
  return match ? Number(match[1]) : null;
}

export function parseModelsPage(html) {
  const chunks = html.split(CARD_MARK).slice(1);
  const models = [];

  for (const chunk of chunks) {
    const card = chunk.split('</li>')[0];
    if (!/data-testid="nv-badge"[^>]*>\s*Free Endpoint\s*<\/span>/i.test(card)) continue;

    const heading = card.match(
      /<h3\b[^>]*>[\s\S]*?<a\b[^>]*\bhref="([^"]+)"[^>]*>[\s\S]*?<span\b[^>]*data-testid="nv-text"[^>]*>([\s\S]*?)<\/span>/i,
    );
    if (!heading) continue;

    const modelPath = decodeEntities(heading[1]).trim();
    if (!modelPath.startsWith('/') || modelPath.split('/').filter(Boolean).length < 2) continue;

    const links = [...card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
      attrs: match[1],
      href: (match[1].match(/\bhref="([^"]*)"/i) || [])[1] || '',
      text: cleanText(match[2]),
      isPublisher: /data-nvtrack-nav-object="artifact-card-publisher-link"/i.test(match[1]),
    }));
    const publisher =
      links.find((link) => link.isPublisher) ||
      links.find((link) => link.href.split('/').filter(Boolean).length === 1);

    const publisherHref = decodeEntities(publisher?.href || '').trim();
    const publisherSlug = publisherHref.split('/').filter(Boolean)[0] || '';
    const descriptionMatch = card.match(
      /<span\b[^>]*class="[^"]*nv-text--label-regular-md[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    );

    const segments = modelPath.split('/').filter(Boolean);
    models.push({
      id: segments.join('/'),
      name: cleanText(heading[2]) || segments[segments.length - 1],
      slug: segments[segments.length - 1],
      publisher: { slug: publisherSlug, name: publisher?.text || publisherSlug },
      description: descriptionMatch ? cleanText(descriptionMatch[1]) : '',
      url: `https://build.nvidia.com${modelPath}`,
    });
  }

  return { models, totalCards: chunks.length, filterCount: parseFilterCount(html) };
}

function decodePushPayloads(html) {
  const parts = [];
  const re = /<script>self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  for (const match of html.matchAll(re)) {
    try {
      parts.push(JSON.parse(`"${match[1]}"`));
    } catch {
      // 单段解析失败不影响其余片段
    }
  }
  return parts.join('');
}

function extractJsonObject(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseSearchPayload(html) {
  const text = decodePushPayloads(html);
  if (!text) return null;
  const searchResult = extractJsonObject(text, '"searchResult":');
  if (!searchResult) return null;

  const resources = [];
  const seen = new Set();
  for (const group of searchResult.results || []) {
    for (const resource of group.resources || []) {
      const key = resource.resourceId || `${resource.name}:${resource.displayName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(resource);
    }
  }

  const facet = text.match(
    /"filterValue":"nim_type_preview","displayName":"Free Endpoint","facetCount":(\d+)/,
  );
  return {
    resources,
    resultTotal: Number.isFinite(searchResult.resultTotal) ? searchResult.resultTotal : null,
    resultPageTotal: Number.isFinite(searchResult.resultPageTotal) ? searchResult.resultPageTotal : null,
    facetCount: facet ? Number(facet[1]) : null,
  };
}

function isFreeResource(resource) {
  const label = (resource.labels || []).find((item) => item.key === 'nimType');
  const values = [...(label?.values || []), ...(label?.unresolvedValues || [])];
  return values.some((value) => /free endpoint|nim_type_preview/i.test(String(value)));
}

function extractTags(labels) {
  const tags = [];
  for (const label of labels || []) {
    if (label.key === 'nimType' || label.key === 'publisher') continue;
    for (const value of label.values || []) {
      if (value && !tags.includes(value)) tags.push(value);
    }
  }
  return tags;
}

function resourceToModel(resource, cardsByKey, cardsByName) {
  const labels = resource.labels || [];
  const publisherSlug = firstValue(labels.find((label) => label.key === 'publisher'));
  const card =
    cardsByKey.get(`${normalizeSlug(publisherSlug)}/${resource.name}`) ||
    cardsByName.get(resource.name);

  const id =
    card?.id ||
    (publisherSlug ? `${publisherSlug}/${resource.name}` : resource.resourceId?.split('/').slice(1).join('/') || '');
  if (!id) return null;

  const attributes = Object.fromEntries(
    (resource.attributes || []).map((attribute) => [String(attribute.key).toLowerCase(), attribute.value]),
  );

  return {
    id,
    name: resource.displayName || card?.name || resource.name,
    slug: resource.name,
    publisher: {
      slug: card?.publisher.slug || publisherSlug,
      name: card?.publisher.name || publisherSlug,
    },
    description: resource.description || card?.description || '',
    url: card?.url || (publisherSlug ? `https://build.nvidia.com/${publisherSlug}/${resource.name}` : ''),
    createdAt: resource.dateCreated || null,
    modifiedAt: resource.dateModified || null,
    tags: extractTags(labels),
    logo: attributes.logo || '',
  };
}

function buildPageUrl(baseUrl, page, opts) {
  const url = new URL(baseUrl);
  if (opts.filterFree && !url.searchParams.has('filters')) {
    url.searchParams.set('filters', opts.filter);
  }
  if (page > 1) url.searchParams.set('page', String(page));
  else url.searchParams.delete('page');
  return url.toString();
}

function sourceUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    url.search = '';
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function saveRawPage(opts, runStamp, page, html) {
  if (!opts.saveRaw) return;
  const dir = path.join(path.dirname(opts.out), 'raw', runStamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `page-${page}.html`), html, 'utf8');
}

function addCardFallback(state, cards) {
  for (const card of cards.models) {
    if (state.byId.has(card.id)) continue;
    state.byId.set(card.id, {
      ...card,
      createdAt: null,
      modifiedAt: null,
      tags: [],
      logo: '',
    });
  }
}

function addPage(state, parsed) {
  if (parsed.payload?.resources?.length) {
    const cardsByKey = new Map();
    const cardsByName = new Map();
    for (const card of parsed.cards.models) {
      cardsByKey.set(`${normalizeSlug(card.publisher.slug)}/${card.slug}`, card);
      if (!cardsByName.has(card.slug)) cardsByName.set(card.slug, card);
    }
    for (const resource of parsed.payload.resources) {
      if (!isFreeResource(resource)) continue;
      const model = resourceToModel(resource, cardsByKey, cardsByName);
      if (!model || state.byId.has(model.id)) continue;
      state.byId.set(model.id, model);
    }
  }

  // RSC 数据缺字段或整段缺失时，用同页卡片补齐
  addCardFallback(state, parsed.cards);
}

async function collect(opts, startedAt, previousCache) {
  const jar = new CookieJar();
  const runStamp = startedAt.replace(/[:.]/g, '-');
  const state = { byId: new Map() };
  const pageStats = [];
  let filterCount = null;
  let totalPages = null;
  let previousUrl = sourceUrl(opts.baseUrl);

  for (let page = 1; page <= opts.maxPages; page++) {
    const url = buildPageUrl(opts.baseUrl, page, opts);
    log(opts, `抓取第 ${page} 页…`);
    const html = await fetchPage(url, opts, jar, previousUrl);
    saveRawPage(opts, runStamp, page, html);

    const parsed = {
      cards: parseModelsPage(html),
      payload: parseSearchPayload(html),
    };

    if (page === 1) {
      filterCount = parsed.payload?.facetCount ?? parsed.cards.filterCount;
      totalPages = parsed.payload?.resultPageTotal ?? null;
      if (totalPages != null && totalPages > opts.maxPages) {
        throw new Error(`列表共 ${totalPages} 页，超过 --max-pages=${opts.maxPages}，请调大上限`);
      }
    }

    const before = state.byId.size;
    addPage(state, parsed);
    const addedOnPage = state.byId.size - before;
    pageStats.push({
      page,
      totalCards: parsed.cards.totalCards,
      freeCards: parsed.cards.models.length,
      resources: parsed.payload?.resources?.length ?? null,
      added: addedOnPage,
    });

    log(
      opts,
      `  第 ${page} 页：${parsed.cards.totalCards} 张卡片，RSC ${parsed.payload?.resources?.length ?? '无'} 条资源，免费模型 +${addedOnPage}`,
    );

    if (page === 1 && state.byId.size === 0) {
      throw new Error('第 1 页没有解析到任何 Free Endpoint，页面结构或过滤参数可能变了');
    }
    if (totalPages != null && page < totalPages && state.byId.size === before) {
      throw new Error(`第 ${page} 页没有新增任何模型，但列表还有后续页，疑似请求被拦截`);
    }
    if (totalPages != null && page >= totalPages) break;
    if (totalPages == null && parsed.cards.totalCards === 0) break;

    previousUrl = url;
    if (page < opts.maxPages) await sleep(opts.delayMs);
  }

  const models = [...state.byId.values()];
  if (!models.length) {
    throw new Error('一个 Free Endpoint 都没解析出来，页面结构可能变了');
  }
  if (filterCount != null) {
    if (models.length < Math.floor(filterCount * 0.5)) {
      throw new Error(`只解析到 ${models.length} 个 Free Endpoint，筛选器标注 ${filterCount} 个，疑似解析失败`);
    }
    if (models.length !== filterCount) {
      warn(`注意：筛选器标注 ${filterCount} 个 Free Endpoint，实际解析到 ${models.length} 个`);
    }
  }

  await translateModels(opts, models);

  const fetchedAt = new Date().toISOString();
  const previousById = new Map((previousCache?.models || []).map((model) => [model.id, model]));
  for (const model of models) {
    model.firstSeenAt = previousById.get(model.id)?.firstSeenAt || fetchedAt;
  }
  const added = models.filter((model) => !previousById.has(model.id)).map((model) => model.id);
  const removed = [...previousById.keys()].filter((id) => !state.byId.has(id));

  const cache = {
    schemaVersion: SCHEMA_VERSION,
    source: sourceUrl(opts.baseUrl),
    filter: opts.filterFree ? opts.filter : null,
    fetchedAt,
    count: models.length,
    filterCount,
    pagesFetched: pageStats.length,
    pageStats,
    models,
  };

  writeJsonAtomic(opts.out, cache);
  return { cache, added, removed, durationMs: Date.now() - Date.parse(startedAt) };
}

function writeStatus(opts, patch) {
  const previous = readJson(opts.statusOut);
  writeJsonAtomic(opts.statusOut, { ...previous, ...patch });
}

async function main() {
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

  const startedAt = new Date().toISOString();
  const previousCache = readJson(opts.out);

  if (opts.ifStale) {
    const age = cacheAgeMs(previousCache);
    if (age < opts.ttlMs) {
      log(
        opts,
        `缓存仍新鲜（${formatDuration(age)} < ${formatDuration(opts.ttlMs)}），跳过抓取：${opts.out}`,
      );
      return;
    }
  }

  try {
    const { cache, added, removed, durationMs } = await collect(opts, startedAt, previousCache);
    writeStatus(opts, {
      ok: true,
      lastAttemptAt: startedAt,
      lastSuccessAt: cache.fetchedAt,
      durationMs,
      count: cache.count,
      filterCount: cache.filterCount,
      pagesFetched: cache.pagesFetched,
      source: cache.source,
      filter: cache.filter,
      error: null,
    });

    log(
      opts,
      `完成：${cache.count} 个 Free Endpoint（筛选器 ${cache.filterCount ?? '未知'}），共 ${cache.pagesFetched} 页，用时 ${formatDuration(durationMs)}`,
    );
    if (added.length) log(opts, `新增 ${added.length}：${added.join(', ')}`);
    if (removed.length) log(opts, `下架 ${removed.length}：${removed.join(', ')}`);
    log(opts, `缓存：${opts.out}`);
  } catch (error) {
    const durationMs = Date.now() - Date.parse(startedAt);
    writeStatus(opts, {
      ok: false,
      lastAttemptAt: startedAt,
      lastSuccessAt: previousCache?.fetchedAt || null,
      durationMs,
      source: sourceUrl(opts.baseUrl),
      filter: opts.filterFree ? opts.filter : null,
      error: error.message,
    });
    console.error(`采集失败：${error.message}`);
    if (previousCache?.models?.length) {
      console.error(`已保留上一次缓存（${previousCache.count ?? previousCache.models.length} 个，抓取于 ${previousCache.fetchedAt}）`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
