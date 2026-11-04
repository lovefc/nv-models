/**
 * NVIDIA NIM 网关（OpenAI 兼容），由 server.mjs 一起启动。
 *
 * 负责把 WorkBuddy / Qoder 等客户端的请求转发给 NVIDIA，同时剥掉上游不认的参数。
 * 支持流式、图片、工具调用、深度思考透传。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { clientAddress, isLoopbackAddress } from './request-ip.mjs';

const DEFAULT_STRIP = [
  'reasoning',
  'verbosity',
  'reasoning_summary',
  'thinking_budget',
  'reasoning_budget_tokens',
  'max_thinking_tokens',
  'preserve_thinking',
  'context_length',
  'custom_model',
];
const MAX_LEARN = 8;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function parseAliases(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const model = part.slice(index + 1).trim();
    if (name && model) map.set(name, model);
  }
  return map;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isLoopback(req, trustProxy) {
  return isLoopbackAddress(clientAddress(req, trustProxy));
}

// 从上游 400 里抠出 "Unsupported parameter(s): `a`, `b`"
function pickUnsupported(text) {
  const match = String(text || '').match(/Unsupported parameter\(s\):\s*([^\r\n]+)/i);
  if (!match) return [];
  // JSON 错误体会在同一行继续出现 "type"/"code" 等字段，先截断到 JSON 结构之前
  const raw = match[1].split(/["}]/)[0].slice(0, 500);
  const quoted = [...raw.matchAll(/`([A-Za-z0-9_.-]+)`/g)].map((item) => item[1]);
  const names = quoted.length
    ? quoted
    : raw
        .split(/[,，\s]+/)
        .map((item) => item.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/[.;]+$/, ''))
        .filter((item) => /^[A-Za-z0-9_.-]+$/.test(item));
  return [...new Set(names)];
}

async function readStreamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function createGateway(options = {}) {
  const config = {
    host: options.host || '127.0.0.1',
    port: Number(options.port) || 18787,
    upstream: String(options.upstream || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    apiKey: options.apiKey || '',
    authToken: options.authToken || '',
    authScope: (options.authScope || 'remote').toLowerCase(),
    trustProxy: options.trustProxy === true || String(options.trustProxy || '') === '1',
    aliases: options.aliases instanceof Map ? options.aliases : parseAliases(options.aliases),
    maxBodyMB: Number(options.maxBodyMB) || 40,
    upstreamIdleTimeoutMs: Number(options.upstreamIdleTimeoutMs) || 300_000,
    defaultReasoningEffort: options.defaultReasoningEffort || '',
    disabledEffort: options.disabledEffort || '',
    tlsCert: options.tlsCert || '',
    tlsKey: options.tlsKey || '',
  };
  const strip = new Set(
    (Array.isArray(options.strip) && options.strip.length ? options.strip : DEFAULT_STRIP)
      .map((field) => String(field).trim())
      .filter(Boolean),
  );
  const log = typeof options.log === 'function' ? options.log : () => {};

  // 长连接复用，避免每轮对话间隔几秒就重新做 DNS/TLS 握手。
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 64,
    maxFreeSockets: 16,
    scheduling: 'lifo',
  };
  const httpAgent = new http.Agent(agentOptions);
  const httpsAgent = new https.Agent(agentOptions);

  function openUpstream({ target, method, headers, payload, signal }) {
    return new Promise((resolve, reject) => {
      const url = new URL(target);
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
          signal,
        },
        (response) => resolve({ request, response }),
      );
      request.on('socket', (socket) => socket.setNoDelay(true));
      request.on('error', reject);
      request.end(payload && payload.length ? payload : undefined);
    });
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  // WorkBuddy 只发 enable_thinking；Qoder/ZCode 还会带 thinking 对象和 reasoning.effort。
  function normalizeThinking(body) {
    const thinking = body.thinking && typeof body.thinking === 'object' ? body.thinking : null;
    const reasoning = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : null;
    const hadFields = 'enable_thinking' in body || 'thinking' in body || 'reasoning' in body;
    const oldEffort = body.reasoning_effort;

    let enabled;
    if (thinking) {
      if (thinking.type === 'disabled') enabled = false;
      else if (thinking.type === 'enabled' || thinking.type === 'adaptive') enabled = true;
    }
    if (body.enable_thinking === false || body.enable_thinking === 0 || body.enable_thinking === 'false') {
      enabled = false;
    } else if (body.enable_thinking === true || body.enable_thinking === 1 || body.enable_thinking === 'true') {
      enabled ??= true;
    }

    let effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim().toLowerCase() : '';
    if (!effort && reasoning && typeof reasoning.effort === 'string') {
      effort = reasoning.effort.trim().toLowerCase();
    }
    if (effort === 'none') enabled = false;
    else if (effort) enabled ??= true;

    delete body.enable_thinking;
    delete body.thinking;
    delete body.reasoning;

    if (enabled === false) {
      if (config.disabledEffort) body.reasoning_effort = config.disabledEffort;
      else delete body.reasoning_effort;
      return hadFields || body.reasoning_effort !== oldEffort;
    }

    if (!effort && enabled === true) effort = config.defaultReasoningEffort || 'high';
    if (!effort && config.defaultReasoningEffort) effort = config.defaultReasoningEffort;
    if (effort) body.reasoning_effort = effort;
    return hadFields || body.reasoning_effort !== oldEffort;
  }

  function stripFields(body) {
    const removed = [];
    for (const field of strip) {
      if (!(field in body)) continue;
      delete body[field];
      removed.push(field);
    }
    return removed;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const limit = config.maxBodyMB * 1024 * 1024;
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error(`请求体超过 ${config.maxBodyMB}MB`), { code: 'BODY_TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        upstream: config.upstream,
        authRequired: Boolean(config.authToken),
        authScope: config.authScope,
        aliases: Object.fromEntries(config.aliases),
        stripped: [...strip],
        maxBodyMB: config.maxBodyMB,
      });
      return;
    }

    if (config.authToken && (config.authScope === 'all' || !isLoopback(req, config.trustProxy))) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!safeEqual(got, config.authToken)) {
        json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
        return;
      }
    }

    const isChat = url.pathname.includes('chat/completions');

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      json(res, 413, { error: { message: error.message } });
      return;
    }

    let body = null;
    if (raw.length && isChat) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        log('WARN 请求体不是合法 JSON，按原样转发');
      }
    }

    let aliasUsed = '';
    let bodyChanged = false;
    if (body && typeof body.model === 'string' && config.aliases.has(body.model)) {
      aliasUsed = body.model;
      body.model = config.aliases.get(body.model);
      bodyChanged = true;
    }

    if (body && normalizeThinking(body)) bodyChanged = true;

    const upstreamPath = url.pathname.replace(/^\/v1/, '') + url.search;
    let target = config.upstream + upstreamPath;
    let method = req.method;
    let forceGet = false;

    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const baseHeaders = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: req.headers.accept || 'application/json',
      'Accept-Encoding': 'identity',
    };

    let attempt = 0;
    let redirects = 0;
    const strippedAll = new Set();

    while (attempt <= MAX_LEARN) {
      if (body && stripFields(body).length) bodyChanged = true;

      const payload = forceGet
        ? undefined
        : body
          ? bodyChanged
            ? JSON.stringify(body)
            : raw
          : raw.length
            ? raw
            : undefined;
      const headers = { ...baseHeaders };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const idle = setTimeout(() => ac.abort(), config.upstreamIdleTimeoutMs);

      let upstream;
      try {
        ({ response: upstream } = await openUpstream({
          target,
          method,
          headers,
          payload,
          signal: ac.signal,
        }));
      } catch (error) {
        clearTimeout(idle);
        if (ac.signal.aborted) {
          log('ABORT 客户端断开或上游超时');
          if (!res.writableEnded) res.end();
          return;
        }
        log('ERROR 上游连接失败:', error.message);
        json(res, 502, { error: { message: 'upstream unreachable: ' + error.message } });
        return;
      }
      clearTimeout(idle);

      const upstreamStatus = upstream.statusCode || 502;

      const location = upstream.headers.location;
      if (location && REDIRECT_STATUS.has(upstreamStatus) && redirects < MAX_REDIRECTS) {
        upstream.resume();
        redirects++;
        const nextTarget = new URL(location, target);
        if (nextTarget.origin !== new URL(target).origin) delete baseHeaders.Authorization;
        target = nextTarget.toString();
        if (upstreamStatus === 303 || ((upstreamStatus === 301 || upstreamStatus === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          forceGet = true;
        }
        continue;
      }

      if (upstreamStatus === 400 && body && attempt < MAX_LEARN) {
        const text = await readStreamText(upstream);
        const bad = pickUnsupported(text).filter((field) => !strip.has(field));
        if (bad.length && strip.size < 32) {
          for (const field of bad) strip.add(field);
          log(`AUTO-STRIP 上游拒绝 ${bad.map((field) => `"${field}"`).join(' ')}，加入黑名单后重试 (第 ${attempt + 1} 次)`);
          attempt++;
          continue;
        }
        if (/reasoning_effort/i.test(text) && 'reasoning_effort' in body) {
          const fieldRejected = /Unsupported parameter\(s\)/i.test(text);
          if (!fieldRejected && body.reasoning_effort !== 'high') {
            const old = body.reasoning_effort;
            body.reasoning_effort = 'high';
            log(`AUTO-FIX 上游不认 reasoning_effort=${old}，退回 high 重试 (第 ${attempt + 1} 次)`);
          } else {
            delete body.reasoning_effort;
            log(`AUTO-STRIP 上游不认 reasoning_effort，去掉后重试 (第 ${attempt + 1} 次)`);
          }
          bodyChanged = true;
          attempt++;
          continue;
        }
        log(`FAIL 400 ${text.slice(0, 300)}`);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(text);
        return;
      }

      const contentType = upstream.headers['content-type'] || 'application/json';
      res.writeHead(upstreamStatus, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });

      let bytes = 0;
      try {
        for await (const chunk of upstream) {
          bytes += chunk.length;
          if (!res.write(chunk)) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      } catch (error) {
        log('ERROR 传输中断:', error.message);
      }
      res.end();

      const tag = strippedAll.size ? `STRIP(${[...strippedAll].join(',')})` : 'PASS';
      log(
        `${tag} ${req.method} ${url.pathname} model=${body?.model ?? '-'} ` +
          `${aliasUsed ? `(alias ${aliasUsed}) ` : ''}` +
          `stream=${body?.stream ?? false} status=${upstreamStatus} bytes=${bytes} ${Date.now() - started}ms`,
      );
      return;
    }

    json(res, 400, { error: { message: '重试次数超限' } });
  }

  const listener = (req, res) => {
    handle(req, res).catch((error) => {
      log('FATAL', error.stack || error.message);
      if (!res.headersSent) json(res, 500, { error: { message: error.message } });
      else res.end();
    });
  };

  const server =
    config.tlsCert && config.tlsKey
      ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, listener)
      : http.createServer(listener);

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 72_000;
  server.timeout = 0;

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (error) => log('ERROR 网关:', error.message));
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  }

  function close() {
    return new Promise((resolve) => {
      const done = () => {
        httpAgent.destroy();
        httpsAgent.destroy();
        resolve();
      };
      if (!server.listening) {
        done();
        return;
      }
      server.close(done);
    });
  }

  return { config, server, listen, close };
}
