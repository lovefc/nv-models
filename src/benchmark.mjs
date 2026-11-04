import fs from 'node:fs';
import path from 'node:path';

const API_MODELS_TTL_MS = 60 * 60_000;
const AUTO_CHECK_MAX_MS = 15 * 60_000;
const AUTO_RETRY_MS = 5 * 60_000;
const CHAT_TAGS = new Set([
  'chat',
  'text-to-text',
  'large language models',
  'language generation',
  'vision language model',
  'vlm',
  'agent',
]);

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

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatDuration(ms) {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(ms % 60_000 ? 1 : 0)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)}s`;
  return `${ms}ms`;
}

function isLikelyChat(model) {
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  return tags.some((tag) => CHAT_TAGS.has(String(tag || '').trim().toLowerCase()));
}

export function createBenchmarkManager(options) {
  const config = {
    enabled: Boolean(options.enabled),
    apiKey: String(options.apiKey || ''),
    apiBase: String(options.apiBase || '').replace(/\/+$/, ''),
    modelsFile: options.modelsFile,
    resultsFile: options.resultsFile,
    prompt: String(options.prompt || '用一句话解释什么是 GPU。'),
    samples: Math.max(1, Math.min(5, Number(options.samples) || 2)),
    maxTokens: Math.max(16, Math.min(1024, Number(options.maxTokens) || 160)),
    timeoutMs: Math.max(5_000, Number(options.timeoutMs) || 120_000),
    gapMs: Math.max(0, Number(options.gapMs) || 0),
    autoMs: Math.max(0, Number(options.autoIntervalMs) || 0),
    log: typeof options.log === 'function' ? options.log : () => {},
    warn: typeof options.warn === 'function' ? options.warn : () => {},
  };

  const state = {
    running: false,
    cancelRequested: false,
    cancelled: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    done: 0,
    current: null,
    error: null,
    source: null,
  };
  const mapping = {
    at: 0,
    ids: [],
    testable: new Map(),
    error: null,
  };
  const auto = {
    started: false,
    timer: null,
    nextAt: 0,
    lastRunAt: 0,
  };
  const manual = new Map();
  let mappingPromise = null;
  let batchTask = null;

  function available() {
    return config.enabled && Boolean(config.apiKey);
  }

  function refreshMapping(force = false) {
    if (!available()) return Promise.resolve();
    if (!force && mapping.ids.length && Date.now() - mapping.at < API_MODELS_TTL_MS) {
      return Promise.resolve();
    }
    if (mappingPromise) return mappingPromise;

    mappingPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(`${config.apiBase}/models`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).trim();
          throw new Error(`HTTP ${res.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
        }
        const payload = await res.json();
        const ids = (Array.isArray(payload?.data) ? payload.data : [])
          .map((item) => String(item?.id || '').trim())
          .filter(Boolean);
        if (!ids.length) throw new Error('接口没有返回模型列表');

        const exact = new Set(ids);
        const byNormalized = new Map(ids.map((id) => [normalizeId(id), id]));
        const cache = readJson(config.modelsFile);
        const testable = new Map();
        for (const model of cache?.models || []) {
          if (!model?.id || !isLikelyChat(model)) continue;
          const apiModel = exact.has(model.id) ? model.id : byNormalized.get(normalizeId(model.id));
          if (apiModel) testable.set(model.id, apiModel);
        }

        mapping.at = Date.now();
        mapping.ids = ids;
        mapping.testable = testable;
        mapping.error = null;
        config.log(`测速：API 模型 ${ids.length} 个，可测 ${testable.size} 个`);
      } catch (error) {
        const detail = error.cause?.code || error.message;
        const message =
          error.name === 'AbortError'
            ? '获取模型列表超时'
            : error instanceof TypeError
              ? `无法连接 NVIDIA API（${detail}）`
              : detail;
        mapping.error = message;
        config.warn(`测速：获取模型列表失败：${message}`);
        throw new Error(message);
      } finally {
        clearTimeout(timer);
        mappingPromise = null;
      }
    })();
    return mappingPromise;
  }

  function saveResult(result) {
    const previous = readJson(config.resultsFile);
    const results = previous?.results && typeof previous.results === 'object' ? previous.results : {};
    results[result.id] = result;
    writeJsonAtomic(config.resultsFile, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      results,
    });
  }

  function errorResult(pageId, apiModel, error) {
    return {
      id: pageId,
      apiModel,
      status: error.unsupported ? 'unsupported' : 'error',
      testedAt: new Date().toISOString(),
      ttftMs: null,
      tokPerSec: null,
      totalMs: null,
      completionTokens: null,
      samples: [],
      error: String(error.message || error).slice(0, 500),
    };
  }

  async function streamChat(apiModel, overrides = {}, task) {
    const controller = task?.controller || new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const startedAt = performance.now();

    try {
      const res = await fetch(`${config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify({
          model: apiModel,
          messages: [{ role: 'user', content: config.prompt }],
          temperature: 0,
          max_tokens: overrides.maxTokens || config.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).trim();
        const error = new Error(`HTTP ${res.status}${detail ? `：${detail.slice(0, 240)}` : ''}`);
        error.status = res.status;
        error.unsupported = [400, 404, 405, 415, 422].includes(res.status);
        throw error;
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        const payload = await res.json().catch(() => null);
        const totalMs = performance.now() - startedAt;
        const content = payload?.choices?.[0]?.message?.content;
        const usage = payload?.usage;
        const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;
        if (!completionTokens && !content) throw new Error('接口没有返回内容');
        return {
          streamed: false,
          ttftMs: Math.round(totalMs),
          totalMs: Math.round(totalMs),
          tokPerSec:
            completionTokens && totalMs > 0
              ? Math.round((completionTokens / (totalMs / 1000)) * 10) / 10
              : null,
          completionTokens,
          estimated: true,
        };
      }

      if (!res.body) throw new Error('响应没有可读取的流');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let firstTokenAt = null;
      let lastTokenAt = null;
      let chunks = 0;
      let usage = null;

      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        if (payload?.usage) usage = payload.usage;
        const delta = payload?.choices?.[0]?.delta;
        if (!delta) return;
        const hasToken =
          (typeof delta.content === 'string' && delta.content.length > 0) ||
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
          (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0);
        if (!hasToken) return;
        const now = performance.now();
        if (firstTokenAt == null) firstTokenAt = now;
        lastTokenAt = now;
        chunks += 1;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);

      const totalMs = performance.now() - startedAt;
      if (firstTokenAt == null) throw new Error('没有收到模型输出');
      const streamMs = Math.max(0, (lastTokenAt ?? firstTokenAt) - firstTokenAt);
      const generationMs = streamMs >= 10 ? streamMs : totalMs;
      const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null;
      const tokenCount = completionTokens || chunks;
      return {
        streamed: true,
        ttftMs: Math.round(firstTokenAt - startedAt),
        totalMs: Math.round(totalMs),
        tokPerSec:
          tokenCount && generationMs
            ? Math.round((tokenCount / (generationMs / 1000)) * 10) / 10
            : null,
        completionTokens,
        estimated: !completionTokens,
      };
    } catch (error) {
      if (error.name === 'AbortError' || timedOut) {
        const aborted = Boolean(task?.cancelled);
        const wrapped = new Error(
          aborted ? '已取消' : `测速超时（${Math.round(config.timeoutMs / 1000)} 秒）`,
        );
        wrapped.aborted = aborted;
        wrapped.timedOut = timedOut && !aborted;
        throw wrapped;
      }
      if (error instanceof TypeError) {
        const wrapped = new Error(`网络错误（${error.cause?.code || error.message}）`);
        wrapped.network = true;
        throw wrapped;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestWithRetry(apiModel, overrides = {}, task) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (task?.cancelled) {
        const error = new Error('已取消');
        error.aborted = true;
        throw error;
      }
      try {
        return await streamChat(apiModel, overrides, task);
      } catch (error) {
        const retryable = error.status === 429 || error.status >= 500;
        if (attempt === 0 && retryable) {
          await sleep(2_000);
          continue;
        }
        throw error;
      }
    }
  }

  async function testModel(pageId, apiModel, task) {
    const warmup = await requestWithRetry(apiModel, { maxTokens: Math.min(32, config.maxTokens) }, task);
    const samples = [];
    for (let index = 0; index < config.samples; index++) {
      if (task.cancelled) {
        const error = new Error('已取消');
        error.aborted = true;
        throw error;
      }
      samples.push(await requestWithRetry(apiModel, {}, task));
      if (index < config.samples - 1) await sleep(300);
    }

    const ttftMs = median(samples.map((sample) => sample.ttftMs));
    const tokPerSec = median(samples.map((sample) => sample.tokPerSec));
    const totalMs = median(samples.map((sample) => sample.totalMs));
    const completionTokens = median(samples.map((sample) => sample.completionTokens));
    if (ttftMs == null && tokPerSec == null) throw new Error('没有收到可计量的输出');

    return {
      id: pageId,
      apiModel,
      status: 'ok',
      testedAt: new Date().toISOString(),
      ttftMs: ttftMs == null ? null : Math.round(ttftMs),
      tokPerSec: tokPerSec == null ? null : Math.round(tokPerSec * 10) / 10,
      totalMs: totalMs == null ? null : Math.round(totalMs),
      completionTokens: completionTokens == null ? null : Math.round(completionTokens),
      estimated: samples.some((sample) => sample.estimated),
      samples: samples.map((sample) => ({
        ttftMs: sample.ttftMs == null ? null : Math.round(sample.ttftMs),
        tokPerSec: sample.tokPerSec == null ? null : Math.round(sample.tokPerSec * 10) / 10,
        totalMs: Math.round(sample.totalMs),
        completionTokens: sample.completionTokens ?? null,
        estimated: Boolean(sample.estimated),
      })),
      warmup: {
        ttftMs: warmup.ttftMs == null ? null : Math.round(warmup.ttftMs),
        totalMs: Math.round(warmup.totalMs),
      },
      error: null,
    };
  }

  function testedSince(pageId, since) {
    const result = readJson(config.resultsFile)?.results?.[pageId];
    if (result?.status !== 'ok') return false;
    const testedAt = Date.parse(result.testedAt || '');
    return Number.isFinite(testedAt) && testedAt >= since;
  }

  async function runBatch(targets, source) {
    const startedAt = Date.now();
    const task = { controller: new AbortController(), cancelled: false };
    batchTask = task;
    try {
      for (let index = 0; index < targets.length; index++) {
        if (task.cancelled) {
          state.cancelled = true;
          break;
        }
        const [pageId, apiModel] = targets[index];
        state.current = pageId;
        state.done = index;

        if (manual.has(pageId) || testedSince(pageId, startedAt)) {
          state.done = index + 1;
          if (index < targets.length - 1 && config.gapMs) await sleep(config.gapMs);
          continue;
        }

        try {
          const result = await testModel(pageId, apiModel, task);
          if (task.cancelled || state.cancelRequested) {
            state.cancelled = true;
            break;
          }
          saveResult(result);
          config.log(`测速：${pageId} 首字 ${result.ttftMs ?? '?'}ms，${result.tokPerSec ?? '?'} tok/s`);
        } catch (error) {
          if (error.aborted || task.cancelled || state.cancelRequested) {
            state.cancelled = true;
            break;
          }
          saveResult(errorResult(pageId, apiModel, error));
          state.done = index + 1;
          if (error.status === 401 || error.status === 403) {
            state.error = 'NVIDIA API Key 无效或没有权限';
            break;
          }
          config.warn(`测速：${pageId} 失败：${error.message}`);
        }

        state.done = index + 1;
        if (index < targets.length - 1 && config.gapMs) await sleep(config.gapMs);
        if (task.cancelled || state.cancelRequested) {
          state.cancelled = true;
          break;
        }
      }
    } finally {
      state.running = false;
      state.current = null;
      state.finishedAt = new Date().toISOString();
      state.cancelRequested = false;
      if (batchTask === task) batchTask = null;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const label = source === 'auto' ? '后台测速' : '测速';
      if (state.cancelled) config.log(`${label}：已取消（完成 ${state.done}/${state.total}，${seconds}s）`);
      else if (state.error) config.warn(`${label}：已中止（完成 ${state.done}/${state.total}，${seconds}s）`);
      else config.log(`${label}：完成 ${state.done}/${state.total}，用时 ${seconds}s`);
    }
  }

  function beginBatch(targets, source) {
    if (state.running) throw httpError('已有测速任务在运行', 409);
    if (!targets.length) throw httpError('没有需要测速的模型', 400);

    state.running = true;
    state.cancelRequested = false;
    state.cancelled = false;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.total = targets.length;
    state.done = 0;
    state.current = null;
    state.error = null;
    state.source = source;
    config.log(
      source === 'auto' ? `测速：后台开始刷新 ${targets.length} 个模型` : `测速：开始 ${targets.length} 个模型`,
    );
    runBatch(targets, source).catch((error) => {
      state.running = false;
      state.current = null;
      state.finishedAt = new Date().toISOString();
      state.error = error.message;
      batchTask = null;
      config.warn(`测速任务失败：${error.message}`);
    });
    return { started: true, total: targets.length };
  }

  async function startSingle(id) {
    if (!available()) throw httpError('测速未启用：请配置 NVIDIA_API_KEY', 409);
    const pageId = typeof id === 'string' ? id.trim() : '';
    if (!pageId) throw httpError('缺少模型 ID', 400);
    if (manual.has(pageId)) throw httpError('该模型正在测速', 409);

    try {
      await refreshMapping();
    } catch (error) {
      if (!mapping.testable.size) throw httpError(`无法获取可测模型列表：${error.message}`, 503);
    }
    if (state.running && state.current === pageId) {
      throw httpError('该模型正在后台测速，请稍后再试', 409);
    }
    if (manual.has(pageId)) throw httpError('该模型正在测速', 409);

    const apiModel = mapping.testable.get(pageId);
    if (!apiModel) throw httpError('该模型不在可测速列表中', 400);

    const task = { controller: new AbortController(), cancelled: false };
    manual.set(pageId, task);
    testModel(pageId, apiModel, task)
      .then((result) => {
        saveResult(result);
        config.log(`测速：${pageId} 首字 ${result.ttftMs ?? '?'}ms，${result.tokPerSec ?? '?'} tok/s`);
      })
      .catch((error) => {
        if (error.aborted || task.cancelled) return;
        saveResult(errorResult(pageId, apiModel, error));
        config.warn(`测速：${pageId} 失败：${error.message}`);
      })
      .finally(() => {
        if (manual.get(pageId) === task) manual.delete(pageId);
      });
    return { started: true, total: 1 };
  }

  function cancel() {
    if (!state.running) return false;
    state.cancelRequested = true;
    if (batchTask) {
      batchTask.cancelled = true;
      batchTask.controller.abort();
    }
    return true;
  }

  function staleTargets() {
    const results = readJson(config.resultsFile)?.results || {};
    const now = Date.now();
    const targets = [];
    for (const [pageId, apiModel] of mapping.testable) {
      const result = results[pageId];
      if (result?.status === 'unsupported') continue;
      const testedAt = Date.parse(result?.testedAt || '');
      if (!Number.isFinite(testedAt) || now - testedAt >= config.autoMs) {
        targets.push([pageId, apiModel]);
      }
    }
    return targets;
  }

  function nextAutoCheckMs() {
    return Math.max(60_000, Math.min(config.autoMs, AUTO_CHECK_MAX_MS));
  }

  function scheduleAutoCheck(delay) {
    if (!config.autoMs || !available() || !auto.started) return;
    clearTimeout(auto.timer);
    auto.nextAt = Date.now() + delay;
    auto.timer = setTimeout(() => {
      auto.timer = null;
      auto.nextAt = 0;
      autoCheck();
    }, delay);
    auto.timer.unref?.();
  }

  function autoCheck() {
    runAutoCheck().catch((error) => {
      config.warn(`测速：后台自动测速失败：${error.message}`);
      scheduleAutoCheck(AUTO_RETRY_MS);
    });
  }

  async function runAutoCheck() {
    if (!config.autoMs || !available() || !auto.started) return;
    if (state.running || manual.size) {
      scheduleAutoCheck(AUTO_RETRY_MS);
      return;
    }
    try {
      await refreshMapping();
    } catch {
      scheduleAutoCheck(AUTO_RETRY_MS);
      return;
    }
    if (state.running || manual.size) {
      scheduleAutoCheck(AUTO_RETRY_MS);
      return;
    }
    const targets = staleTargets();
    if (targets.length) {
      auto.lastRunAt = Date.now();
      beginBatch(targets, 'auto');
    }
    scheduleAutoCheck(nextAutoCheckMs());
  }

  function startAuto() {
    if (auto.started || !config.autoMs || !available()) return;
    auto.started = true;
    config.log(`测速：后台自动测速已开启（结果超过 ${formatDuration(config.autoMs)} 自动重扫）`);
    scheduleAutoCheck(5_000);
  }

  function stop() {
    auto.started = false;
    if (auto.timer) clearTimeout(auto.timer);
    auto.timer = null;
    auto.nextAt = 0;
    cancel();
    for (const task of manual.values()) {
      task.cancelled = true;
      task.controller.abort();
    }
    manual.clear();
  }

  function snapshot() {
    const file = readJson(config.resultsFile);
    return {
      available: available(),
      running: state.running,
      cancelRequested: state.cancelRequested,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      total: state.total,
      done: state.done,
      current: state.current,
      cancelled: state.cancelled,
      error: state.error,
      source: state.source,
      testing: [...manual.keys()],
      mappingError: mapping.error,
      mappingAt: mapping.at ? new Date(mapping.at).toISOString() : null,
      testable: [...mapping.testable.keys()],
      results: file?.results && typeof file.results === 'object' ? file.results : {},
      updatedAt: file?.updatedAt || null,
      auto: {
        enabled: config.autoMs > 0,
        intervalMs: config.autoMs || null,
        nextCheckAt: auto.nextAt ? new Date(auto.nextAt).toISOString() : null,
        lastRunAt: auto.lastRunAt ? new Date(auto.lastRunAt).toISOString() : null,
      },
    };
  }

  return { available, startSingle, cancel, snapshot, refreshMapping, startAuto, stop };
}
