#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/env.mjs';
import {
  CLIENT_IDS,
  SetupError,
  applySetup,
  buildCatalog,
  buildModelAliases,
  detectClients,
  fetchApiModelIds,
  planSetup,
  removeSetup,
} from '../src/clients.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
loadDotEnv(path.join(ROOT, '.env'));

const FALLBACK_ALIASES = new Map([
  ['glm-5.3-flash', 'z-ai/glm-5.3-flash'],
  ['deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4.1-flash'],
  ['mistral-large-4-1t-a52b', 'mistralai/mistral-large-4-1t-a52b'],
  ['muse-glimmer-30b', 'meta/muse-glimmer-30b'],
]);

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function modelsFile() {
  return process.env.NV_MODELS_OUT || path.join(ROOT, 'data', 'models.json');
}

function apiModelsFile() {
  return process.env.NV_API_MODELS_OUT || path.join(ROOT, 'data', 'api-models.json');
}

function apiModelIds() {
  const cache = readJson(apiModelsFile());
  return Array.isArray(cache?.ids) ? cache.ids : [];
}

function catalog() {
  const cache = readJson(modelsFile());
  const models = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
  const aliases = buildModelAliases(models, apiModelIds(), FALLBACK_ALIASES);
  for (const part of String(process.env.MODEL_ALIASES || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const target = part.slice(index + 1).trim();
    if (name && target) aliases.set(name, target);
  }
  return buildCatalog(models, aliases);
}

let preparePromise = null;

function prepareCatalog() {
  if (preparePromise) return preparePromise;
  preparePromise = (async () => {
    const cache = readJson(apiModelsFile());
    const fetchedAt = Date.parse(cache?.fetchedAt || '');
    if (
      Array.isArray(cache?.ids) &&
      cache.ids.length &&
      Number.isFinite(fetchedAt) &&
      Date.now() - fetchedAt < 12 * 3_600_000
    ) {
      return;
    }
    const apiKey =
      process.env.NV_MODELS_BENCHMARK_KEY || process.env.NVIDIA_API_KEY || '';
    if (!apiKey) return;
    try {
      const ids = await fetchApiModelIds({
        apiKey,
        apiBase:
          process.env.NV_GATEWAY_UPSTREAM ||
          process.env.NV_MODELS_BENCHMARK_URL ||
          'https://integrate.api.nvidia.com/v1',
        timeoutMs: 12_000,
      });
      const target = apiModelsFile();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temp, `${JSON.stringify({ fetchedAt: new Date().toISOString(), ids }, null, 2)}\n`);
      fs.renameSync(temp, target);
    } catch {
      // 网络不可用时继续用缓存或回退映射
    }
  })();
  return preparePromise;
}

function baseUrl(options = {}) {
  return (
    options.baseUrl ||
    process.env.NV_CLIENTS_BASE_URL ||
    `http://127.0.0.1:${process.env.NV_GATEWAY_PORT || 18787}/v1`
  ).replace(/\/+$/, '');
}

function home(options = {}) {
  return path.resolve(options.home || process.env.NV_CLIENTS_HOME || os.homedir());
}

function token(options = {}) {
  return options.token != null ? options.token : process.env.AUTH_TOKEN || '';
}

function help() {
  console.log(`用法：node tools/setup-clients.mjs <命令> [选项]

命令：
  detect              查看 Qoder / WorkBuddy（国内版、国际版）/ ZCode 是否安装、是否已配置
  plan                预览会新增哪些模型（不写文件）
  apply               写入客户端配置
  remove              移除本工具添加的模型
  check               检查网关是否在线
  mcp                 以 MCP stdio 服务器运行

选项：
  --client <name>     qoder、workbuddy、workbuddy-ai、zcode 或 all（默认 all）
  --model <name>      模型短名，可重复；默认全部模型
  --all               等同于不传 --model
  --base-url <url>    客户端使用的地址（默认 http://127.0.0.1:18787/v1）
  --token <token>     API 口令（默认读 .env 的 AUTH_TOKEN）
  --home <dir>        临时替换用户目录（测试用）
  --json              输出 JSON
  -h, --help          显示帮助

示例：
  node tools/setup-clients.mjs detect
  node tools/setup-clients.mjs apply --client qoder --model glm-5.3-flash
  node tools/setup-clients.mjs apply --client workbuddy-ai
  node tools/setup-clients.mjs apply --client all
  node tools/setup-clients.mjs remove --client zcode

在 MCP 客户端里注册本工具（以 OpenCode 为例）：
  opencode mcp add nv-models --global -- node "${path.join(__dirname, 'setup-clients.mjs')}" mcp

Qoder 在 MCP 管理里新增本地服务器，命令填 node，参数填：
  "${path.join(__dirname, 'setup-clients.mjs')}" mcp

网页端的一键添加只对“nv-models 与客户端在同一台机器”时可用；
远程网页可下载配置脚本，在运行客户端的电脑上执行。`);
}

function parseArgs(argv) {
  const options = { clients: [], models: [], json: false };
  const hasCommand = Boolean(argv[0] && !argv[0].startsWith('-'));
  const command = hasCommand ? argv[0] : 'help';
  for (let index = hasCommand ? 1 : 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--all') {
      options.models = [];
      options.all = true;
    } else if (arg === '--client') {
      const value = requireValue(argv, ++index, arg);
      options.clients.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
    } else if (arg === '--model') {
      options.models.push(requireValue(argv, ++index, arg));
    } else if (arg === '--base-url') {
      options.baseUrl = requireValue(argv, ++index, arg);
    } else if (arg === '--token') {
      options.token = requireValue(argv, ++index, arg);
    } else if (arg === '--home') {
      options.home = requireValue(argv, ++index, arg);
    } else {
      throw new SetupError(`未知参数：${arg}`, 400);
    }
  }
  return { command, options };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value == null || value.startsWith('--')) throw new SetupError(`${flag} 缺少参数值`, 400);
  return value;
}

function clientsOption(options) {
  const raw = options.clients.length ? options.clients : ['all'];
  if (raw.includes('all')) return [...CLIENT_IDS];
  return [...new Set(raw)];
}

function clientName(id) {
  return { qoder: 'Qoder', workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI', zcode: 'ZCode' }[id] || id;
}

function modelsOption(options) {
  return options.models.length ? options.models : 'all';
}

function commonOptions(options) {
  return {
    catalog: catalog(),
    models: modelsOption(options),
    baseUrl: baseUrl(options),
    token: token(options),
    home: home(options),
  };
}

function runDetect(options) {
  const info = detectClients({
    catalog: catalog(),
    baseUrl: baseUrl(options),
    home: home(options),
  });
  if (options.json) {
    console.log(JSON.stringify(info, null, 2));
    return 0;
  }
  console.log(`平台：${info.platform}`);
  console.log(`模型目录：${info.catalog} 个`);
  for (const client of info.clients) {
    const state = !client.installed
      ? '未安装'
      : client.error
        ? `配置错误：${client.error}`
        : client.configured
          ? `已配置 ${client.models} 个模型`
          : '已安装，未配置';
    console.log(`${client.name.padEnd(10)} ${state}`);
    if (client.configPath) console.log(`  ${client.configPath}`);
  }
  return 0;
}

function runPlan(options) {
  const common = commonOptions(options);
  let failed = false;
  const out = [];
  for (const client of clientsOption(options)) {
    try {
      const result = planSetup({ client, ...common });
      out.push(result);
      if (options.json) continue;
      if (!result.installed) {
        console.log(`${result.name}：未检测到，跳过`);
        continue;
      }
      console.log(`${result.name}：${result.added.length ? `将添加 ${result.added.length} 个模型` : '无需添加'}`);
      if (result.added.length) console.log(`  新增：${result.added.join(', ')}`);
      if (result.already.length) console.log(`  已存在：${result.already.length} 个`);
      if (result.skipped?.length) console.log(`  跳过：${result.skipped.length} 个同名模型指向其他服务`);
      console.log(`  配置：${result.configPath}`);
      for (const warning of result.warnings || []) console.log(`  提示：${warning}`);
    } catch (error) {
      failed = true;
      if (options.json) out.push({ client, ok: false, error: error.message });
      else console.error(`${client}：${error.message}`);
    }
  }
  if (options.json) console.log(JSON.stringify(out, null, 2));
  return failed ? 1 : 0;
}

function runApply(options) {
  const common = commonOptions(options);
  const results = applySetup({ clients: clientsOption(options), ...common, backup: options.backup !== false });
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (!result.ok) {
        console.error(`${result.client}：失败 - ${result.error}`);
        continue;
      }
      const name = clientName(result.client);
      if (!result.added.length) {
        console.log(`${name}：已经是最新（共 ${result.total} 个模型）`);
      } else {
        console.log(`${name}：已添加 ${result.added.length} 个模型（共 ${result.total} 个）`);
        console.log(`  ${result.added.join(', ')}`);
      }
      console.log(`  配置：${result.configPath}`);
      if (result.backup) console.log(`  备份：${result.backup}`);
      if (result.skipped?.length) {
        console.log(`  跳过：${result.skipped.length} 个同名模型指向其他服务，未覆盖`);
      }
      for (const warning of result.warnings || []) console.log(`  提示：${warning}`);
      if (result.added.length) {
        console.log(`  提示：重启 ${name} 后可在模型列表里看到`);
      }
    }
  }
  return results.some((result) => !result.ok) ? 1 : 0;
}

function runRemove(options) {
  const results = removeSetup({
    clients: clientsOption(options),
    baseUrl: baseUrl(options),
    home: home(options),
  });
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (!result.ok) {
        console.error(`${result.client}：失败 - ${result.error}`);
        continue;
      }
      const name = clientName(result.client);
      console.log(`${name}：${result.removed ? `已移除 ${result.removed} 个模型` : '没有可移除的配置'}`);
      if (result.backup) console.log(`  备份：${result.backup}`);
    }
  }
  return results.some((result) => !result.ok) ? 1 : 0;
}

async function runCheckGateway(options) {
  const target = new URL('/health', baseUrl(options));
  const response = await fetch(target, {
    headers: token(options) ? { authorization: `Bearer ${token(options)}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new SetupError(`网关返回 HTTP ${response.status}`, 502);
  const data = await response.json();
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`网关正常：${target.origin}`);
    console.log(`模型短名：${Object.keys(data.aliases || {}).length} 个`);
  }
  return 0;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultText(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

const MCP_TOOLS = [
  {
    name: 'detect_clients',
    description:
      '检测本机是否安装 Qoder / WorkBuddy（国内版、国际版）/ ZCode，以及它们的配置文件和已添加模型数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_models',
    description:
      '把 nv-models 的模型写入 Qoder、WorkBuddy（国内版或国际版）或 ZCode 配置。默认添加全部模型；会先备份，可重复执行。',
    inputSchema: {
      type: 'object',
      properties: {
        client: {
          type: 'string',
          enum: ['qoder', 'workbuddy', 'workbuddy-ai', 'zcode', 'all'],
          description: '目标客户端；workbuddy 是国内版，workbuddy-ai 是国际版',
        },
        models: {
          oneOf: [
            { type: 'string', enum: ['all'] },
            { type: 'array', items: { type: 'string' } },
          ],
          description: '模型短名；all 表示全部',
        },
        baseUrl: { type: 'string', description: '写入客户端的地址，默认 http://127.0.0.1:18787/v1' },
        token: { type: 'string', description: 'API 口令；不填则读 .env 的 AUTH_TOKEN' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remove_models',
    description: '移除本工具写入 Qoder / WorkBuddy（国内版、国际版）/ ZCode 的模型，并保留备份。',
    inputSchema: {
      type: 'object',
      properties: {
        client: {
          type: 'string',
          enum: ['qoder', 'workbuddy', 'workbuddy-ai', 'zcode', 'all'],
          description: '目标客户端；workbuddy 是国内版，workbuddy-ai 是国际版',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_gateway',
    description: '检查 nv-models 网关是否在线，并返回模型短名数量。',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: '网关地址，默认 http://127.0.0.1:18787/v1' },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  await prepareCatalog();
  if (name === 'detect_clients') {
    return detectClients({ catalog: catalog(), baseUrl: baseUrl(args), home: home(args) });
  }
  if (name === 'add_models') {
    const results = applySetup({
      clients: args.client || 'all',
      catalog: catalog(),
      models: args.models == null ? 'all' : args.models,
      baseUrl: baseUrl(args),
      token: token(args),
      home: home(args),
    });
    return { ok: results.every((result) => result.ok), results };
  }
  if (name === 'remove_models') {
    const results = removeSetup({
      clients: args.client || 'all',
      baseUrl: baseUrl(args),
      home: home(args),
    });
    return { ok: results.every((result) => result.ok), results };
  }
  if (name === 'check_gateway') {
    const target = new URL('/health', baseUrl(args));
    const response = await fetch(target, {
      headers: token(args) ? { authorization: `Bearer ${token(args)}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new SetupError(`网关返回 HTTP ${response.status}`, 502);
    return response.json();
  }
  throw new SetupError(`未知工具：${name}`, 404);
}

function runMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (message.id == null) return;
    const { id, method, params = {} } = message;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'nv-models-client-setup', version: packageVersion() },
          },
        });
        return;
      }
      if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      }
      if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        return;
      }
      if (method === 'tools/call') {
        try {
          const value = await callTool(params.name, params.arguments || {});
          send({ jsonrpc: '2.0', id, result: resultText(value) });
        } catch (error) {
          send({
            jsonrpc: '2.0',
            id,
            result: resultText(error.message || String(error), true),
          });
        }
        return;
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (error) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message || String(error) } });
    }
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    help();
    process.exitCode = 1;
    return;
  }
  const { command, options } = parsed;
  if (options.help || command === 'help') {
    help();
    return;
  }
  try {
    if (command !== 'mcp') await prepareCatalog();
    if (command === 'detect') process.exitCode = runDetect(options);
    else if (command === 'plan') process.exitCode = runPlan(options);
    else if (command === 'apply') process.exitCode = runApply(options);
    else if (command === 'remove') process.exitCode = runRemove(options);
    else if (command === 'check') process.exitCode = await runCheckGateway(options);
    else if (command === 'mcp') runMcp();
    else {
      console.error(`未知命令：${command}`);
      help();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

main();
