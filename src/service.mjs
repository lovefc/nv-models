#!/usr/bin/env node
/**
 * 本地服务管理：npm start / stop / restart / run status。
 * Linux 服务器部署后仍用 systemctl 管理，不必使用本脚本。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
loadDotEnv(path.join(ROOT_DIR, '.env'));

const PID_FILE = path.join(ROOT_DIR, 'data', 'server.pid');
const LOG_FILE = path.join(ROOT_DIR, 'logs', 'server.log');
const DEFAULT_PORT = Number(process.env.NV_MODELS_PORT || 18788);
const GATEWAY_PORT = Number(process.env.NV_GATEWAY_PORT || 18787);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (!Number.isInteger(record?.pid) || record.pid <= 0) return null;
    return {
      pid: record.pid,
      port: Number(record.port) || DEFAULT_PORT,
      instance: typeof record.instance === 'string' ? record.instance : '',
      startedAt: record.startedAt || null,
    };
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearRecord(record) {
  try {
    const current = readRecord();
    if (!record || !current || current.pid === record.pid) fs.unlinkSync(PID_FILE);
  } catch {
    // 文件可能已被服务自己清理
  }
}

function writeRecord(pid, port, instance) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({
        pid,
        port,
        instance: instance || '',
        startedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // 记录失败不影响服务，下次仍可按端口探测
  }
}

function runTool(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 4_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

function listeningPids(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    for (const line of runTool('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const match = line.match(/(?:^|\s)(?:\[[^\]]+\]|[^\s:]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (match && Number(match[1]) === port && Number(match[2]) > 0) pids.add(Number(match[2]));
    }
    return [...pids];
  }

  for (const line of runTool('ss', ['-ltnp']).split(/\r?\n/)) {
    if (!/LISTEN/i.test(line) || !new RegExp(`:${port}\\s`).test(line)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  if (pids.size) return [...pids];

  for (const line of runTool('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function readCommandLine(pid) {
  if (process.platform === 'linux') {
    try {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
    } catch {
      return '';
    }
  }
  if (process.platform === 'darwin') {
    return runTool('ps', ['-o', 'command=', '-p', String(pid)]).trim();
  }
  const wmic = runTool('wmic', ['process', 'where', `processid=${pid}`, 'get', 'commandline', '/value']);
  const line = wmic.match(/CommandLine=(.*)/i);
  if (line) return line[1].trim();
  return runTool('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ]).trim();
}

function sameDir(left, right) {
  try {
    const normalize = (value) => {
      const resolved = fs.realpathSync(path.resolve(value));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function sameProjectDir(dir) {
  return sameDir(dir, __dirname) || sameDir(dir, ROOT_DIR);
}

function processMatch(pid) {
  const command = readCommandLine(pid);
  if (!command) return 'unknown';
  const token = (command.match(/"[^"]*"|\S+/g) || []).find((item) => /server\.mjs/i.test(item));
  if (!token) return 'other';
  const script = token.replace(/^"|"$/g, '');
  if (path.isAbsolute(script)) {
    return sameProjectDir(path.dirname(script)) ? 'ours' : 'other';
  }
  if (process.platform === 'linux') {
    try {
      return sameProjectDir(fs.realpathSync(`/proc/${pid}/cwd`)) ? 'ours' : 'other';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

async function probePort(port) {
  const health = await fetchHealth(port);
  const valid = Boolean(health && health.ok === true && typeof health.instance === 'string');
  return { port, health: valid ? health : null, listeners: listeningPids(port) };
}

function canStop(pid, probe, expectedInstance) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isAlive(pid)) return false;
  const match = processMatch(pid);
  if (match === 'other') return false;
  if (match === 'ours') return true;
  if (!probe.health || !probe.listeners.includes(pid)) return false;
  if (expectedInstance && probe.health.instance !== expectedInstance) return false;
  return true;
}

function portHasEntries(port) {
  if (process.platform === 'win32') {
    return new RegExp(`[:.]${port}\\s`).test(runTool('netstat', ['-ano', '-p', 'tcp']));
  }
  return new RegExp(`:${port}\\s`).test(runTool('ss', ['-tan']));
}

async function fetchHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function webUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function tailLog(lines = 12) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function runningMessage(record, health) {
  console.log('运行中');
  console.log(`  PID    ${record?.pid ?? '未知'}`);
  console.log(`  网页   ${webUrl(record?.port ?? DEFAULT_PORT)}`);
  if (health) {
    console.log(`  模型   ${health.count ?? 0} 个`);
    console.log(`  API    ${health.gateway ? '运行中' : '未启动'}`);
    console.log(`  采集   ${health.refreshing ? '正在刷新' : '空闲'}`);
  }
}

async function start({ open = false } = {}) {
  const record = readRecord();
  if (record && isAlive(record.pid)) {
    const health = await fetchHealth(record.port);
    if (!health || !health.instance || !record.instance || health.instance === record.instance) {
      console.log(`已在运行（PID ${record.pid}）：${webUrl(record.port)}`);
      return 0;
    }
  }

  const probe = await probePort(DEFAULT_PORT);
  const ours = probe.listeners.find((pid) => processMatch(pid) === 'ours');
  if (ours) {
    if (probe.health) {
      writeRecord(ours, DEFAULT_PORT, probe.health.instance);
      console.log(`已在运行（PID ${ours}）：${webUrl(DEFAULT_PORT)}`);
      return 0;
    }
    console.error(`端口 ${DEFAULT_PORT} 被本项目的进程占用（PID ${ours}），但健康检查未响应`);
    console.error('请先运行 npm stop 停止它，再重新启动');
    return 1;
  }
  if (probe.health) {
    const pid = probe.listeners.find((item) => canStop(item, probe, null));
    if (pid) {
      writeRecord(pid, DEFAULT_PORT, probe.health.instance);
      console.log(`已在运行（PID ${pid}）：${webUrl(DEFAULT_PORT)}`);
      return 0;
    }
    console.error(`端口 ${DEFAULT_PORT} 上有服务响应，但无法确认对应进程`);
    return 1;
  }
  if (probe.listeners.length) {
    console.error(`端口 ${DEFAULT_PORT} 已被占用（PID ${probe.listeners.join('、')}）`);
    console.error('请先停止占用该端口的程序，或在 .env 中修改 NV_MODELS_PORT');
    return 1;
  }
  if (record) clearRecord(record);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `\n===== ${new Date().toISOString()} 启动 =====\n`);
  const out = fs.openSync(LOG_FILE, 'a');
  const args = [path.join(__dirname, 'server.mjs')];
  if (open) args.push('--open');

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: process.env,
    });
  } finally {
    fs.closeSync(out);
  }
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(400);
    const saved = readRecord();
    if (saved?.pid === child.pid) {
      const health = await fetchHealth(saved.port);
      if (health) {
        console.log(`已启动（PID ${saved.pid}）：${webUrl(saved.port)}`);
        return 0;
      }
      continue;
    }
    if (!isAlive(child.pid)) break;
  }

  console.error('启动失败。最近的日志：');
  const tail = tailLog();
  if (tail) console.error(tail);
  else console.error(`请查看日志：${LOG_FILE}`);
  return 1;
}

async function stop() {
  const record = readRecord();
  const port = record?.port ?? DEFAULT_PORT;
  const probes = [];
  for (const item of new Set([port, DEFAULT_PORT])) probes.push(await probePort(item));
  const targets = new Map();

  if (record) {
    const probe = probes.find((item) => item.port === record.port) || probes[0];
    if (canStop(record.pid, probe, record.instance)) targets.set(record.pid, record.port);
  }
  for (const probe of probes) {
    for (const pid of probe.listeners) {
      if (canStop(pid, probe, null)) targets.set(pid, probe.port);
    }
  }

  if (!targets.size) {
    const healthy = probes.find((item) => item.health);
    if (healthy) {
      const owners = healthy.listeners.filter((pid) => pid !== process.pid);
      console.log(`端口 ${healthy.port} 上仍有服务响应，但无法确认对应进程`);
      if (owners.length) console.log(`  占用 PID：${owners.join('、')}`);
      console.log(
        `  请用 ${
          process.platform === 'win32'
            ? `netstat -ano | findstr :${healthy.port}`
            : `ss -ltnp | grep :${healthy.port}`
        } 查看后手动结束`,
      );
      return 1;
    }
    if (record && isAlive(record.pid)) {
      const foreign = processMatch(record.pid) === 'other';
      clearRecord(record);
      console.log(
        `未在运行（已清理过期记录；PID ${record.pid} ${
          foreign ? '属于其他程序，未结束' : '无法确认，未结束'
        }）`,
      );
      return 0;
    }
    if (record) clearRecord(record);
    console.log('未在运行');
    return 0;
  }

  const pids = [...targets.keys()];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (isAlive(pid)) console.error(`无法停止 PID ${pid}：${error.message}`);
    }
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pids.some(isAlive)) await sleep(300);
  if (pids.some(isAlive)) {
    for (const pid of pids.filter(isAlive)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 进程可能刚好退出
      }
    }
    await sleep(500);
  }

  clearRecord(record);
  const remaining = pids.filter(isAlive);
  if (remaining.length) {
    console.error(`停止失败（PID ${remaining.join('、')} 仍在运行）`);
    return 1;
  }

  const watched = [...new Set(probes.map((item) => item.port))];
  if (probes.some((item) => item.health?.gateway)) watched.push(GATEWAY_PORT);
  const still = watched.filter((item) => listeningPids(item).length > 0);
  if (still.length) {
    console.error(`进程已结束，但端口 ${still.join('、')} 仍被其他程序监听`);
    return 1;
  }

  console.log(pids.length === 1 ? `已停止（PID ${pids[0]}）` : `已停止（PID ${pids.join('、')}）`);
  const lingering = watched.filter((item) => portHasEntries(item));
  if (lingering.length) {
    console.log(`端口 ${lingering.join('、')} 已无监听；netstat/ss 里的 TIME_WAIT 或重试连接会由系统自动回收`);
  }
  return 0;
}

async function restart({ open = false } = {}) {
  const stopped = await stop();
  if (stopped !== 0) return stopped;
  return start({ open });
}

async function status() {
  const record = readRecord();
  const port = record?.port ?? DEFAULT_PORT;
  const probes = [];
  for (const item of new Set([port, DEFAULT_PORT])) probes.push(await probePort(item));
  const probe = probes.find((item) => item.port === port) || probes[0];
  const health = probe.health || probes.find((item) => item.health)?.health || null;
  const instanceOk = !health?.instance || !record?.instance || health.instance === record.instance;

  if (record && isAlive(record.pid) && instanceOk && canStop(record.pid, probe, record.instance)) {
    runningMessage(record, health);
    return 0;
  }

  const healthy = probes.find((item) => item.health);
  if (healthy) {
    const pid = healthy.listeners.find((item) => canStop(item, healthy, null));
    if (pid) {
      writeRecord(pid, healthy.port, healthy.health.instance);
      runningMessage({ pid, port: healthy.port }, healthy.health);
      console.log('  （已补写 PID 记录）');
      return 0;
    }
    console.log(`服务在端口 ${healthy.port} 运行，但无法确认对应进程`);
    return 1;
  }

  if (record && isAlive(record.pid)) {
    console.log(`进程存在（PID ${record.pid}），但健康检查未通过，可能正在启动或端口未响应`);
    if (processMatch(record.pid) === 'other') console.log('该进程不是本项目的服务，PID 记录已过期');
    return 1;
  }

  if (record) clearRecord(record);
  console.log('未在运行');
  return 1;
}

const command = process.argv[2] || 'status';
const open = process.argv.includes('--open');
const actions = { start, stop, restart, status };

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`用法：node src/service.mjs <命令>

  start     后台启动服务
  stop      停止服务
  restart   重启服务
  status    查看运行状态

  --open    启动后打开浏览器（与 start/restart 一起使用）`);
  process.exit(0);
}

const action = actions[command];
if (!action) {
  console.error(`未知命令：${command}`);
  console.error('可用命令：start、stop、restart、status');
  process.exit(1);
}

try {
  const code = await action({ open });
  process.exitCode = code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
