const els = {
  progress: document.getElementById('progress'),
  meta: document.getElementById('meta'),
  settings: document.getElementById('settings'),
  logout: document.getElementById('logout'),
  refresh: document.getElementById('refresh'),
  refreshLabel: document.querySelector('#refresh span'),
  error: document.getElementById('error'),
  errorTitle: document.getElementById('error-title'),
  errorText: document.getElementById('error-text'),
  errorRetry: document.getElementById('error-retry'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  sort: document.getElementById('sort'),
  filterRow: document.getElementById('filter-row'),
  publishers: document.getElementById('publishers'),
  tagFilter: document.getElementById('tag-filter'),
  resultCount: document.getElementById('result-count'),
  clearFilters: document.getElementById('clear-filters'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  emptySpinner: document.getElementById('empty-spinner'),
  emptyIcon: document.getElementById('empty-icon'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDesc: document.getElementById('empty-desc'),
  emptyAction: document.getElementById('empty-action'),
  usage: document.getElementById('usage-dialog'),
  usageTitle: document.getElementById('usage-title'),
  usageSub: document.getElementById('usage-sub'),
  usageClose: document.getElementById('usage-close'),
  usageTabs: document.getElementById('usage-tabs'),
  usageBody: document.getElementById('usage-body'),
  usageHint: document.getElementById('usage-hint'),
  usageSetup: document.getElementById('usage-setup'),
};

const SORTS = new Set(['newest', 'added', 'name', 'publisher', 'ttft', 'tps', 'speed']);
const NEW_WINDOW_MS = 30 * 86_400_000;
const state = {
  data: null,
  connectionError: false,
};
const filters = { q: '', publisher: '', tag: '', sort: 'newest' };

let pollTimer = 0;
let searchTimer = 0;
let transientTimer = 0;
let transientError = '';
let transientKind = 'refresh';
const pendingTests = new Set();
let loading = false;
let gridSignature = '';
let publisherListSignature = '';
let usageModel = null;
let usageTab = 'qoder';
let usageRequest = 0;
const clientState = {
  data: null,
  error: '',
  loading: false,
  busy: false,
  notice: null,
};

function safeUrl(value, allowedHost) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === allowedHost) return url.href;
  } catch {
    // 非法 URL 直接忽略
  }
  return '';
}

function logoUrl(value) {
  return safeUrl(value, 'assets.ngc.nvidia.com');
}

function models() {
  const list = state.data?.cache?.models;
  return Array.isArray(list) ? list : [];
}

function hasFilters() {
  return Boolean(filters.q.trim() || filters.publisher || filters.tag);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  filters.q = (params.get('q') || '').slice(0, 120);
  const sort = params.get('s');
  filters.sort = SORTS.has(sort) ? sort : 'newest';
  filters.publisher = (params.get('p') || '').slice(0, 80);
  filters.tag = (params.get('t') || '').slice(0, 80);
}

function syncUrl() {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set('q', q);
  if (filters.publisher) params.set('p', filters.publisher);
  if (filters.tag) params.set('t', filters.tag);
  if (filters.sort !== 'newest') params.set('s', filters.sort);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

function matches(model, query) {
  if (filters.publisher) {
    const name = model.publisher?.name || '未知发布方';
    if (name !== filters.publisher) return false;
  }
  if (filters.tag) {
    const tags = Array.isArray(model.tags) ? model.tags : [];
    if (!tags.includes(filters.tag)) return false;
  }
  if (query) {
    const haystack = [
      model.name,
      model.slug,
      model.id,
      model.publisher?.name,
      model.publisher?.slug,
      model.description,
      model.descriptionZh,
      ...(Array.isArray(model.tags) ? model.tags : []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function benchmarkResults() {
  const results = state.data?.benchmark?.results;
  return results && typeof results === 'object' ? results : {};
}

function speedMetric(model, key) {
  const result = benchmarkResults()[model.id];
  if (result?.status !== 'ok') return null;
  return Number.isFinite(result[key]) ? result[key] : null;
}

function sorted(list) {
  const copy = list.slice();
  const compareName = (a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base', numeric: true });
  const time = (value) => {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? t : 0;
  };
  copy.sort((a, b) => {
    if (filters.sort === 'added') {
      return time(b.firstSeenAt) - time(a.firstSeenAt) || time(b.createdAt) - time(a.createdAt) || compareName(a, b);
    }
    if (filters.sort === 'name') return compareName(a, b);
    if (filters.sort === 'publisher') {
      return (
        String(a.publisher?.name || '').localeCompare(String(b.publisher?.name || ''), 'en', {
          sensitivity: 'base',
        }) || compareName(a, b)
      );
    }
    if (filters.sort === 'ttft' || filters.sort === 'tps' || filters.sort === 'speed') {
      const key = filters.sort === 'ttft' ? 'ttftMs' : filters.sort === 'tps' ? 'tokPerSec' : 'totalMs';
      const av = speedMetric(a, key);
      const bv = speedMetric(b, key);
      if (av == null && bv == null) return compareName(a, b);
      if (av == null) return 1;
      if (bv == null) return -1;
      const order = filters.sort === 'tps' ? bv - av : av - bv;
      if (order) return order;
      const attft = speedMetric(a, 'ttftMs');
      const bttft = speedMetric(b, 'ttftMs');
      if (attft != null && bttft != null && attft !== bttft) return attft - bttft;
      return compareName(a, b);
    }
    return time(b.createdAt) - time(a.createdAt) || compareName(a, b);
  });
  return copy;
}

function filtered() {
  const query = filters.q.trim().toLowerCase();
  return sorted(models().filter((model) => matches(model, query)));
}

function timeAgo(value) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function cardDate(value) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return '';
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('zh-CN', {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function initials(model) {
  const source = String(model.publisher?.name || model.name || '?').trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function makeChip(label, count, active, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = active ? 'chip chip-active' : 'chip';
  chip.setAttribute('aria-pressed', String(active));
  chip.append(document.createTextNode(label));
  if (count != null) {
    const counter = document.createElement('span');
    counter.className = 'chip-count';
    counter.textContent = String(count);
    chip.append(counter);
  }
  chip.addEventListener('click', onClick);
  return chip;
}

function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 10_000) return `${(Math.round(ms / 10) / 100).toFixed(2)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(value) {
  if (!Number.isFinite(value)) return '';
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} t/s`;
}

function speedLabel(result) {
  return [formatSeconds(result.ttftMs), formatRate(result.tokPerSec)].filter(Boolean).join(' · ');
}

function speedTitle(result) {
  const parts = [];
  if (Number.isFinite(result.ttftMs)) parts.push(`首字 ${formatSeconds(result.ttftMs)}`);
  if (Number.isFinite(result.tokPerSec)) parts.push(`生成 ${formatRate(result.tokPerSec)}`);
  if (Number.isFinite(result.totalMs)) parts.push(`总耗时 ${formatSeconds(result.totalMs)}`);
  if (Number.isFinite(result.completionTokens)) parts.push(`${result.completionTokens} tokens`);
  if (result.estimated) parts.push('token 数按流片段估算');
  if (result.testedAt) parts.push(`${timeAgo(result.testedAt)}测试`);
  parts.push('点击重新测速');
  return parts.join(' · ');
}

function gatewayInfo() {
  const gateway = state.data?.gateway;
  const base = String(gateway?.baseUrl || 'http://127.0.0.1:18787/v1').replace(/\/+$/, '');
  const root = base.replace(/\/chat\/completions$/i, '');
  return {
    base: root,
    endpoint: base.endsWith('/chat/completions') ? base : `${base}/chat/completions`,
    token: typeof gateway?.token === 'string' ? gateway.token : '',
    available: gateway?.available !== false,
  };
}

const CLIENT_LABELS = { qoder: 'Qoder', workbuddy: 'WorkBuddy', zcode: 'ZCode' };
const WORKBUDDY_IDS = ['workbuddy', 'workbuddy-ai'];
const WORKBUDDY_VARIANT_LABELS = { workbuddy: '国内版', 'workbuddy-ai': '国际版' };

function clientLabel(id) {
  if (id === 'workbuddy-ai') return 'WorkBuddy AI';
  return CLIENT_LABELS[id] || String(id || '');
}

function variantLabel(id) {
  return WORKBUDDY_VARIANT_LABELS[id] || clientLabel(id);
}

function usageEndpoint() {
  const { base, endpoint } = gatewayInfo();
  return usageTab === 'zcode' ? base : endpoint;
}

function usageField(label, value, { muted = false, copyable = true } = {}) {
  const row = document.createElement('div');
  row.className = 'usage-field';
  const head = document.createElement('div');
  head.className = 'usage-field-head';
  const name = document.createElement('span');
  name.textContent = label;
  head.append(name);
  if (copyable && value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usage-copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', `复制${label}`);
    button.addEventListener('click', () => copyValue(value, button));
    head.append(button);
  }
  const code = document.createElement('code');
  code.className = muted ? 'usage-value is-muted' : 'usage-value';
  code.textContent = value;
  row.append(head, code);
  return row;
}

async function copyValue(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  if (!button.isConnected) return;
  button.textContent = '已复制';
  setTimeout(() => {
    if (button.isConnected) button.textContent = '复制';
  }, 1400);
}

function shortModelName(model) {
  const short = String(model.short || '').trim();
  if (short) return short;
  const id = String(model.id || '').trim();
  if (id) return id.includes('/') ? id.split('/').pop() : id;
  return String(model.slug || '').trim();
}

function renderUsage() {
  if (!usageModel) return;
  const model = usageModel;
  const { token, available } = gatewayInfo();
  const tokenText = token || '未设置，可留空';
  els.usageTitle.textContent = String(model.name || model.slug || '未命名模型');
  els.usageSub.textContent = String(model.id || model.slug || '');
  els.usageBody.replaceChildren(
    usageField(usageTab === 'workbuddy' ? '接口地址' : 'Base URL', usageEndpoint()),
    usageField('Token', tokenText, { muted: !token, copyable: Boolean(token) }),
    usageField('模型名称', shortModelName(model)),
  );
  els.usageBody.setAttribute('aria-labelledby', `usage-tab-${usageTab}`);
  els.usageHint.textContent = available
    ? usageTab === 'qoder'
      ? 'Qoder → 自定义模型：Base URL 和 Token 照抄，模型名填上面的短名。'
      : usageTab === 'workbuddy'
        ? 'WorkBuddy → 模型接入：接口地址填完整路径，Token 照抄，模型名填上面的短名。'
        : 'ZCode → 自定义模型服务：Base URL 填到 /v1，Token 照抄，模型名填上面的短名。'
    : 'API 服务器未启动：请检查 NVIDIA_API_KEY 配置。';
  for (const tab of els.usageTabs.querySelectorAll('.usage-tab')) {
    const active = tab.dataset.tab === usageTab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

function usageClients() {
  const clients = Array.isArray(clientState.data?.clients) ? clientState.data.clients : [];
  if (usageTab !== 'workbuddy') {
    const client = clients.find((item) => item.id === usageTab);
    return client ? [client] : [];
  }
  const variants = WORKBUDDY_IDS.map((id) => clients.find((item) => item.id === id)).filter(Boolean);
  const installed = variants.filter((item) => item.installed);
  return installed.length ? installed : variants.slice(0, 1);
}

function setupStatus(text, tone = '') {
  const row = document.createElement('div');
  row.className = tone ? `usage-setup-status is-${tone}` : 'usage-setup-status';
  const dot = document.createElement('span');
  dot.className = 'usage-setup-dot';
  const label = document.createElement('span');
  label.textContent = text;
  row.append(dot, label);
  return row;
}

function setupAction(label, { primary = false, ghost = false, disabled = false, onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `usage-action${primary ? ' is-primary' : ''}${ghost ? ' is-ghost' : ''}`;
  button.textContent = label;
  button.disabled = disabled;
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function downloadAction(label, href, primary = false) {
  const link = document.createElement('a');
  link.className = `usage-action${primary ? ' is-primary' : ''}`;
  link.href = href;
  link.download = '';
  link.textContent = label;
  return link;
}

function isWindowsClient() {
  return /Windows/i.test(navigator.userAgent || '');
}

function scriptUrl(client, model, format) {
  const query = new URLSearchParams({ client });
  if (model === 'all') query.set('models', 'all');
  else query.set('model', model);
  if (format) query.set('format', format);
  return `/api/clients/script?${query.toString()}`;
}

function setupNote(text, className = 'usage-setup-note') {
  const note = document.createElement('p');
  note.className = className;
  note.textContent = text;
  return note;
}

function setupClientBlock(multi, clientId) {
  const block = document.createElement('div');
  block.className = 'usage-setup-client';
  if (multi) {
    const title = document.createElement('div');
    title.className = 'usage-setup-client-title';
    title.textContent = variantLabel(clientId);
    block.append(title);
  }
  return block;
}

function appendClientNotice(block, clientId) {
  if (clientState.notice?.clientId !== clientId) return;
  block.append(
    setupNote(
      clientState.notice.text,
      `usage-setup-feedback${clientState.notice.kind === 'error' ? ' is-error' : ''}`,
    ),
  );
}

function renderRemoteSetup(box, gateway) {
  const short = shortModelName(usageModel);
  const apiNames = Array.isArray(gateway.modelNames) ? gateway.modelNames : [];
  const mapped = Boolean(gateway.mapped);
  const supported = !mapped || apiNames.includes(short);
  const total = mapped ? apiNames.length : Number(gateway.models) || 0;

  if (!gateway.available) {
    box.append(setupStatus('API 服务器未启动，暂时无法下载配置脚本', 'error'));
    return;
  }

  const name = clientLabel(usageTab);
  const variants = usageTab === 'workbuddy' ? WORKBUDDY_IDS : [usageTab];
  const multi = variants.length > 1;
  const windows = isWindowsClient();
  const format = windows ? 'bat' : 'sh';

  box.append(setupStatus(`远程访问：下载脚本，在运行 ${name} 的电脑上执行`, 'ready'));
  if (!supported) {
    box.append(setupNote('该模型没有可用的 API ID，无法接入', 'usage-setup-feedback is-error'));
  }

  for (const id of variants) {
    const block = setupClientBlock(multi, id);
    const label = multi ? variantLabel(id) : name;
    const actions = document.createElement('div');
    actions.className = 'usage-setup-actions';
    if (supported) {
      actions.append(
        downloadAction(
          multi
            ? `下载配置脚本 (.${format})`
            : `下载 ${label} 配置脚本 (.${format})`,
          scriptUrl(id, short, format),
          true,
        ),
      );
    }
    if (total > 0) {
      actions.append(
        downloadAction(
          multi ? `下载全部 ${total} 个 (.${format})` : `下载全部 ${total} 个模型 (.${format})`,
          scriptUrl(id, 'all', format),
        ),
      );
    }
    block.append(actions);
    box.append(block);
  }

  box.append(
    setupNote(
      windows
        ? 'Windows：下载后双击运行，使用系统自带 PowerShell，无需安装 Python。脚本包含 Token，用完请删除。'
        : 'Linux / macOS：下载后运行 bash 脚本（需要 python3）。Windows 用户请在 Windows 浏览器里打开本页下载 .bat。脚本包含 Token，用完请删除。',
    ),
  );
}

function renderLocalClient(box, client, multi) {
  const block = setupClientBlock(multi, client.id);
  const name = clientLabel(client.id);

  if (!client.installed) {
    block.append(
      setupStatus(
        multi ? '未检测到该版本，安装并启动一次后再试' : `未检测到 ${name}，安装并启动一次后再试`,
        'error',
      ),
    );
    if (clientState.data.platform === 'linux') {
      block.append(
        setupNote(
          'Linux 用 systemd 部署时，服务账号读不到桌面用户的配置；可在终端运行 node src/server.mjs，或用 tools/setup-clients.mjs 添加。',
        ),
      );
    }
    const actions = document.createElement('div');
    actions.className = 'usage-setup-actions';
    actions.append(setupAction('重新检测', { ghost: true, onClick: loadClientInfo }));
    block.append(actions);
    box.append(block);
    return;
  }

  const gateway = clientState.data.gateway || {};
  if (!gateway.available) {
    block.append(setupStatus('API 服务器未启动，暂时无法写入配置', 'error'));
    box.append(block);
    return;
  }

  const short = shortModelName(usageModel);
  const configuredNames = Array.isArray(client.modelNames) ? client.modelNames : [];
  const present = configuredNames.includes(short);
  const apiNames = Array.isArray(gateway.modelNames) ? gateway.modelNames : [];
  const mapped = Boolean(gateway.mapped);
  const supported = !mapped || apiNames.includes(short);
  const total = mapped ? apiNames.length : Number(gateway.models) || 0;
  const allPresent = total > 0 && client.models >= total;
  const disabled = clientState.busy;

  const addText = present
    ? '当前模型已加入'
    : disabled
      ? '写入中…'
      : multi
        ? '一键加入'
        : `一键加入 ${name}`;
  const statusText = client.configured
    ? `已接入 ${client.models} 个模型`
    : multi
      ? '未接入，可一键写入本机配置'
      : `检测到 ${name}，可一键写入本机配置`;

  block.append(
    supported
      ? setupStatus(statusText, 'ready')
      : setupStatus('该模型没有可用的 API ID，无法一键接入', 'error'),
  );

  const actions = document.createElement('div');
  actions.className = 'usage-setup-actions';
  if (supported) {
    actions.append(
      setupAction(addText, {
        primary: true,
        disabled: disabled || present,
        onClick: () => runClientAction('add', [short], client.id),
      }),
    );
  }
  if (total > 0 && !allPresent) {
    actions.append(
      setupAction(`加入全部 ${total} 个`, {
        disabled,
        onClick: () => runClientAction('add', 'all', client.id),
      }),
    );
  }
  if (client.configured) {
    actions.append(
      setupAction('移除配置', {
        ghost: true,
        disabled,
        onClick: () => runClientAction('remove', undefined, client.id),
      }),
    );
  }
  block.append(actions);

  if (client.configPath) block.append(setupNote(`配置文件：${client.configPath}`, 'usage-setup-path'));
  if (client.error) {
    block.append(setupNote(`配置读取失败：${client.error}`, 'usage-setup-feedback is-error'));
  }
  appendClientNotice(block, client.id);
  box.append(block);
}

function renderUsageSetup() {
  const box = els.usageSetup;
  if (!usageModel) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();

  if (clientState.loading && !clientState.data) {
    box.append(setupStatus('正在检测本机客户端…'));
    return;
  }

  if (!clientState.data) {
    box.append(
      setupStatus(
        clientState.error ? `检测失败：${clientState.error}` : '无法检测本机客户端',
        clientState.error ? 'error' : '',
      ),
    );
    const actions = document.createElement('div');
    actions.className = 'usage-setup-actions';
    actions.append(setupAction('重新检测', { ghost: true, onClick: loadClientInfo }));
    box.append(actions);
    return;
  }

  const gateway = clientState.data.gateway || {};
  if (!clientState.data.local) {
    renderRemoteSetup(box, gateway);
    return;
  }

  const clients = usageClients();
  if (!clients.length) {
    box.append(setupStatus(`没有读到 ${clientLabel(usageTab)} 的检测结果`, 'error'));
    return;
  }

  const multi = clients.length > 1;
  for (const client of clients) renderLocalClient(box, client, multi);

  if (clientState.error) {
    box.append(setupNote(`检测失败：${clientState.error}`, 'usage-setup-feedback is-error'));
  }
}

async function loadClientInfo() {
  const request = ++usageRequest;
  clientState.loading = true;
  clientState.error = '';
  renderUsageSetup();
  try {
    const response = await fetch('/api/clients', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (authRedirect(response)) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (request !== usageRequest) return;
    clientState.data = data;
  } catch (error) {
    if (request !== usageRequest) return;
    clientState.error = error.message || String(error);
  } finally {
    if (request === usageRequest) {
      clientState.loading = false;
      renderUsageSetup();
    }
  }
}

async function runClientAction(action, models, clientId = usageTab) {
  if (clientState.busy) return;
  clientState.busy = true;
  clientState.notice = null;
  clientState.error = '';
  renderUsageSetup();
  try {
    const body = { client: clientId };
    if (action === 'add') body.models = models;
    const response = await fetch(`/api/clients/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv-models': '1' },
      body: JSON.stringify(body),
    });
    if (authRedirect(response)) return;
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      const failed = Array.isArray(result.results)
        ? result.results.find((item) => !item.ok)
        : null;
      throw new Error(failed?.error || result.error || `写入失败（HTTP ${response.status}）`);
    }
    const own = Array.isArray(result.results)
      ? result.results.find((item) => item.client === clientId)
      : null;
    if (action === 'add') {
      const added = own?.added?.length || 0;
      const skipped = own?.skipped?.length || 0;
      const parts = [];
      if (added) parts.push(`已加入 ${added} 个模型`);
      if (skipped) parts.push(`${skipped} 个同名模型指向其他服务，未覆盖`);
      clientState.notice = {
        clientId,
        kind: skipped && !added ? 'error' : 'ok',
        text: parts.length ? parts.join('；') : '配置已是最新，无需重复写入',
      };
    } else {
      const removed = own?.removed || 0;
      clientState.notice = {
        clientId,
        kind: 'ok',
        text: removed ? `已移除 ${removed} 个模型` : '没有需要移除的配置',
      };
    }
    await loadClientInfo();
  } catch (error) {
    clientState.notice = { clientId, kind: 'error', text: error.message || String(error) };
  } finally {
    clientState.busy = false;
    renderUsageSetup();
  }
}

function openUsage(model) {
  usageModel = model;
  usageTab = 'qoder';
  clientState.notice = null;
  clientState.error = '';
  renderUsage();
  loadClientInfo();
  if (!els.usage.open) els.usage.showModal();
  document.body.classList.add('modal-open');
}

function buildSpeedControl(model) {
  const bench = state.data?.benchmark;
  if (!bench?.available) return null;
  const testable = Array.isArray(bench.testable) ? bench.testable : [];
  if (!testable.includes(model.id)) return null;

  const result = benchmarkResults()[model.id] || null;
  const testing = Array.isArray(bench.testing) ? bench.testing : [];
  const isTesting =
    pendingTests.has(model.id) ||
    testing.includes(model.id) ||
    Boolean(bench.running && bench.current === model.id);

  if (isTesting) {
    const current = document.createElement('span');
    current.className = 'speed-btn is-busy';
    const spinner = document.createElement('span');
    spinner.className = 'mini-spinner';
    current.append(spinner, document.createTextNode('测速中'));
    return current;
  }

  if (result?.status === 'ok' && speedLabel(result)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'speed-chip';
    chip.textContent = speedLabel(result);
    chip.title = speedTitle(result);
    chip.setAttribute('aria-label', `测速结果 ${speedLabel(result)}，点击重新测速`);
    chip.addEventListener('click', () => requestBenchmark(model.id));
    return chip;
  }

  if (result?.status === 'unsupported') {
    const muted = document.createElement('span');
    muted.className = 'speed-btn is-muted';
    muted.textContent = '不可测';
    if (result.error) muted.title = `不可测：${result.error}`;
    return muted;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = result?.status === 'error' ? 'speed-btn is-error' : 'speed-btn';
  button.textContent = result?.status === 'error' ? '测速失败' : '测速';
  if (result?.error) button.title = `测速失败：${result.error}；点击重试`;
  else button.title = '运行一次流式测速';
  button.setAttribute('aria-label', `${result?.status === 'error' ? '重试测速' : '测速'} ${model.name || model.id}`);
  button.addEventListener('click', () => requestBenchmark(model.id));
  return button;
}

function buildCard(model) {
  const card = document.createElement('article');
  card.className = 'card';
  const name = String(model.name || model.slug || '未命名模型');
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, select, textarea')) return;
    if (window.getSelection()?.toString().trim()) return;
    openUsage(model);
  });

  const top = document.createElement('div');
  top.className = 'card-top';

  const logoWrap = document.createElement('div');
  logoWrap.className = 'logo-wrap';
  const fallback = document.createElement('span');
  fallback.className = 'logo-fallback';
  fallback.textContent = initials(model);
  logoWrap.append(fallback);
  const logo = logoUrl(model.logo);
  if (logo) {
    const image = document.createElement('img');
    image.src = logo;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove());
    logoWrap.append(image);
  }

  const badges = document.createElement('div');
  badges.className = 'badges';
  const freeBadge = document.createElement('span');
  freeBadge.className = 'badge badge-free';
  freeBadge.textContent = 'Free';
  badges.append(freeBadge);
  const created = Date.parse(model.createdAt || '');
  if (Number.isFinite(created) && Date.now() - created < NEW_WINDOW_MS) {
    const newBadge = document.createElement('span');
    newBadge.className = 'badge badge-new';
    newBadge.textContent = 'New';
    badges.append(newBadge);
  }

  top.append(logoWrap, badges);

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = name;

  const publisher = document.createElement('div');
  publisher.className = 'publisher';
  publisher.textContent = String(model.publisher?.name || '未知发布方');

  const desc = document.createElement('p');
  desc.className = 'desc';
  const originalDesc = String(model.description || '').trim();
  const translatedDesc = String(model.descriptionZh || '').trim();
  desc.textContent = translatedDesc || originalDesc;
  if (translatedDesc && originalDesc) desc.title = originalDesc;

  const tagWrap = document.createElement('div');
  tagWrap.className = 'tags';
  const tags = (Array.isArray(model.tags) ? model.tags : []).filter(
    (tag) => typeof tag === 'string' && tag.trim(),
  );
  for (const tag of tags.slice(0, 4)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag';
    chip.textContent = tag;
    chip.addEventListener('click', () => setTag(tag));
    tagWrap.append(chip);
  }
  if (tags.length > 4) {
    const more = document.createElement('span');
    more.className = 'tag-more';
    more.textContent = `+${tags.length - 4}`;
    tagWrap.append(more);
  }

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const date = document.createElement('span');
  date.className = 'date';
  const stamp = model.createdAt || model.firstSeenAt;
  if (stamp) {
    date.textContent = `${model.createdAt ? '发布于' : '收录于'} ${cardDate(stamp)}`;
    date.title = new Date(stamp).toLocaleString('zh-CN');
  }
  footer.append(date);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const speed = buildSpeedControl(model);
  if (speed) actions.append(speed);
  const usageButton = document.createElement('button');
  usageButton.type = 'button';
  usageButton.className = 'usage-btn';
  usageButton.textContent = '接入';
  usageButton.title = '查看 Qoder / WorkBuddy / ZCode 接入方式';
  usageButton.setAttribute('aria-label', `查看 ${name} 的接入方式`);
  usageButton.addEventListener('click', () => openUsage(model));
  actions.append(usageButton);
  footer.append(actions);

  card.append(top, title, publisher, desc, tagWrap, footer);
  return card;
}

function updateMeta() {
  const data = state.data;
  const cache = data?.cache;
  const count = Array.isArray(cache?.models) ? cache.models.length : 0;

  if (state.connectionError) {
    els.meta.textContent = count ? `${count} 个模型 · 连接中断，重试中…` : '连接中断，重试中…';
  } else if (!data) {
    els.meta.textContent = '正在连接…';
  } else if (data.refresh?.running) {
    const startedAt = Date.parse(data.refresh.startedAt || '');
    els.meta.textContent = Number.isFinite(startedAt)
      ? `正在采集 · 已用 ${formatElapsed(Date.now() - startedAt)}`
      : '正在采集…';
  } else if (!count) {
    els.meta.textContent = data.server?.auto ? '暂无数据 · 等待自动采集' : '暂无数据';
  } else {
    const fetchedAt = Date.parse(cache.fetchedAt || '');
    const ttl = Number(data.server?.ttlMs) || 0;
    const stale = Number.isFinite(fetchedAt) && ttl > 0 && Date.now() - fetchedAt > ttl;
    const updated = Number.isFinite(fetchedAt) ? `${timeAgo(cache.fetchedAt)}更新` : '更新时间未知';
    els.meta.textContent = `${cache.count ?? count} 个模型 · ${updated}${stale ? ' · 缓存已过期' : ''}`;
  }

  document.title = count ? `${cache.count ?? count} 个免费模型 · NVIDIA` : 'NVIDIA 免费模型';
}

function visibleError() {
  if (transientError) return { message: transientError, kind: transientKind };
  if (state.data?.refresh?.error) return { message: state.data.refresh.error, kind: 'refresh' };
  if (state.data?.benchmark?.available && state.data.benchmark.mappingError) {
    return { message: `测速服务不可用：${state.data.benchmark.mappingError}`, kind: 'benchmark' };
  }
  return null;
}

function refreshEnabled() {
  return Boolean(state.data) && state.data.server?.showRefresh !== false;
}

function updateChrome() {
  const visible = refreshEnabled();
  const running = !state.connectionError && Boolean(state.data?.refresh?.running);
  els.logout.hidden = !(state.data?.server?.authEnabled && state.data?.server?.session);
  els.settings.hidden = !(state.data?.server?.settingsEnabled && state.data?.server?.canConfigure);
  els.refresh.hidden = !visible;
  els.refresh.disabled = running;
  els.refresh.classList.toggle('is-loading', running);
  els.refreshLabel.textContent = running ? '采集中' : '刷新';
  els.progress.hidden = !running;
  document.body.classList.toggle('refreshing', running);

  const error = visibleError();
  els.error.hidden = !error;
  if (error) {
    els.errorTitle.textContent = error.kind === 'benchmark' ? '测速失败' : '刷新失败';
    els.errorText.textContent = truncate(error.message, 260);
    els.errorRetry.hidden = error.kind === 'benchmark' || !visible;
    els.errorRetry.textContent = '重试';
  }

  updateMeta();
}

function setPublisher(name) {
  filters.publisher = name && filters.publisher !== name ? name : '';
  syncUrl();
  renderContent();
}

function setTag(tag) {
  filters.tag = filters.tag === tag ? '' : tag;
  syncUrl();
  renderContent();
}

function clearAllFilters() {
  filters.q = '';
  filters.publisher = '';
  filters.tag = '';
  els.search.value = '';
  els.searchClear.hidden = true;
  syncUrl();
  renderContent();
}

function renderPublishers(all) {
  const counts = new Map();
  for (const model of all) {
    const name = String(model.publisher?.name || '未知发布方');
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const entries = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }),
  );
  if (filters.publisher && !counts.has(filters.publisher)) entries.push([filters.publisher, 0]);

  const signature = entries.map(([name, count]) => `${name}\u0000${count}`).join('\u0001');
  if (signature !== publisherListSignature) {
    publisherListSignature = signature;
    const fragment = document.createDocumentFragment();
    fragment.append(makeChip('全部', all.length, !filters.publisher, () => setPublisher('')));
    for (const [name, count] of entries) {
      const chip = makeChip(name, count, filters.publisher === name, () => setPublisher(name));
      chip.dataset.publisher = name;
      fragment.append(chip);
    }
    els.publishers.replaceChildren(fragment);
    return;
  }

  for (const chip of els.publishers.children) {
    const active = (chip.dataset.publisher || '') === filters.publisher;
    chip.classList.toggle('chip-active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
}

function renderTagFilter() {
  els.tagFilter.hidden = !filters.tag;
  if (!filters.tag) {
    els.tagFilter.replaceChildren();
    return;
  }
  const cross = document.createElement('span');
  cross.textContent = '×';
  cross.setAttribute('aria-hidden', 'true');
  els.tagFilter.replaceChildren(document.createTextNode(`标签：${filters.tag} `), cross);
  els.tagFilter.setAttribute('aria-label', `清除标签筛选：${filters.tag}`);
}

function renderGrid(list) {
  const bench = state.data?.benchmark;
  const benchSignature = bench
    ? [
        bench.available,
        bench.running,
        bench.current,
        bench.updatedAt,
        Array.isArray(bench.testing) ? bench.testing.join(',') : '',
        [...pendingTests].sort().join(','),
        Array.isArray(bench.testable) ? bench.testable.join(',') : '',
      ].join('~')
    : '';
  const signature = [
    state.data?.cache?.fetchedAt || '',
    filters.q,
    filters.publisher,
    filters.tag,
    filters.sort,
    benchSignature,
    list.map((model) => model.id).join(','),
  ].join('|');
  if (signature === gridSignature) return;
  gridSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const model of list) fragment.append(buildCard(model));
  els.grid.replaceChildren(fragment);
}

function updateEmpty(all, list) {
  if (list.length) {
    els.empty.hidden = true;
    return;
  }

  let spinner = false;
  let title = '';
  let desc = '';
  let actionLabel = '';
  let action = null;

  if (!all.length) {
    if (state.connectionError) {
      title = '无法连接本地服务';
      desc = '请确认 node src/server.mjs 仍在运行，然后重试。';
      actionLabel = '重试连接';
      action = loadState;
    } else if (!state.data) {
      spinner = true;
      title = '正在加载…';
      desc = '读取本地缓存。';
    } else if (state.data.refresh?.running) {
      spinner = true;
      title = '首次采集进行中…';
      desc = '从 build.nvidia.com 获取 Free Endpoint 模型，通常需要一到两分钟。';
    } else {
      const canStart = refreshEnabled();
      title = '还没有模型数据';
      desc = state.data.server?.auto
        ? '自动采集会在稍后开始。'
        : canStart
          ? '自动采集已关闭，可以手动开始一次采集。'
          : '自动采集已关闭，暂时没有可展示的数据。';
      if (canStart) {
        actionLabel = '开始采集';
        action = requestRefresh;
      }
    }
  } else {
    title = '没有匹配的模型';
    desc = '换个关键词，或清除发布方和标签筛选。';
    actionLabel = '清除筛选';
    action = clearAllFilters;
  }

  els.empty.hidden = false;
  els.emptySpinner.hidden = !spinner;
  els.emptyIcon.hidden = spinner;
  els.emptyTitle.textContent = title;
  els.emptyDesc.textContent = desc;
  els.emptyAction.hidden = !actionLabel;
  els.emptyAction.textContent = actionLabel;
  els.emptyAction.onclick = action;
}

function renderContent() {
  const all = models();
  const list = filtered();
  const active = hasFilters();

  els.filterRow.hidden = all.length === 0;
  els.resultCount.textContent = all.length
    ? active
      ? `${list.length} / ${all.length} 个模型`
      : `${all.length} 个模型`
    : '';
  els.clearFilters.hidden = !active;
  els.searchClear.hidden = !els.search.value;

  renderPublishers(all);
  renderTagFilter();
  renderGrid(list);
  updateEmpty(all, list);
}

function renderAll() {
  updateChrome();
  renderContent();
}

function scheduleNext() {
  clearTimeout(pollTimer);
  let delay = 60_000;
  if (state.connectionError) delay = 5000;
  else if (state.data?.refresh?.running) delay = 2000;
  else if (state.data?.benchmark?.running) delay = 2000;
  else if (Array.isArray(state.data?.benchmark?.testing) && state.data.benchmark.testing.length) {
    delay = 2000;
  } else if (pendingTests.size) delay = 2000;
  else if (
    state.data?.benchmark?.available &&
    !state.data.benchmark.mappingAt &&
    !state.data.benchmark.mappingError
  ) {
    delay = 2000;
  } else if (!state.data?.cache?.models?.length && state.data?.server?.auto) delay = 3000;
  pollTimer = setTimeout(loadState, delay);
}

function redirectToLogin() {
  const next = `${location.pathname}${location.search}`;
  location.replace(`/login?next=${encodeURIComponent(next)}`);
}

function authRedirect(response) {
  if (response.status !== 401) return false;
  redirectToLogin();
  return true;
}

async function loadState() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/state', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (authRedirect(response)) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.connectionError = false;
    renderAll();
  } catch {
    state.connectionError = true;
    updateChrome();
    renderContent();
  } finally {
    loading = false;
    scheduleNext();
  }
}

function showTransientError(message, kind = 'refresh') {
  transientError = message;
  transientKind = kind;
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientError = '';
    updateChrome();
  }, 10_000);
  updateChrome();
}

async function requestRefresh() {
  if (state.data?.refresh?.running) return;
  if (!refreshEnabled()) {
    showTransientError('手动刷新已关闭。');
    return;
  }
  clearTimeout(transientTimer);
  transientError = '';
  try {
    const response = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'x-nv-models': '1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (authRedirect(response)) return;
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ? `刷新请求被拒绝：${body.error}` : `刷新请求失败（HTTP ${response.status}）`);
    }
    if (state.data) {
      state.data.refresh = {
        ...(state.data.refresh || {}),
        running: Boolean(body?.running),
        startedAt: body?.startedAt || state.data.refresh?.startedAt || new Date().toISOString(),
        error: null,
      };
    }
    updateChrome();
    loadState();
    scheduleNext();
  } catch (error) {
    showTransientError(
      error?.name === 'TimeoutError' ? '刷新请求超时，请稍后重试。' : error?.message || '刷新请求失败。',
    );
  }
}

function applyControls() {
  els.search.value = filters.q;
  els.sort.value = filters.sort;
  els.searchClear.hidden = !filters.q;
}

async function requestBenchmark(id) {
  const bench = state.data?.benchmark;
  if (!bench?.available || !id) return;
  const testing = Array.isArray(bench.testing) ? bench.testing : [];
  if (pendingTests.has(id) || testing.includes(id) || (bench.running && bench.current === id)) return;

  clearTimeout(transientTimer);
  transientError = '';
  pendingTests.add(id);
  renderContent();
  scheduleNext();

  try {
    const response = await fetch('/api/benchmark', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv-models': '1' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(30_000),
    });
    if (authRedirect(response)) return;
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        body?.error ? `测速请求被拒绝：${body.error}` : `测速请求失败（HTTP ${response.status}）`,
      );
    }
    if (state.data?.benchmark) {
      const current = Array.isArray(state.data.benchmark.testing) ? state.data.benchmark.testing : [];
      if (!current.includes(id)) state.data.benchmark.testing = [...current, id];
    }
    updateChrome();
    renderContent();
    loadState();
    scheduleNext();
  } catch (error) {
    showTransientError(
      error?.name === 'TimeoutError'
        ? '测速请求超时，模型列表可能加载失败，请稍后重试。'
        : error?.message || '测速请求失败。',
      'benchmark',
    );
    renderContent();
  } finally {
    pendingTests.delete(id);
    renderContent();
    scheduleNext();
  }
}

els.search.addEventListener('input', () => {
  els.searchClear.hidden = !els.search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filters.q = els.search.value.trim();
    syncUrl();
    renderContent();
  }, 120);
});

els.searchClear.addEventListener('click', () => {
  els.search.value = '';
  els.search.focus();
  clearAllFilters();
});

els.sort.addEventListener('change', () => {
  filters.sort = SORTS.has(els.sort.value) ? els.sort.value : 'newest';
  syncUrl();
  renderContent();
});

els.tagFilter.addEventListener('click', () => setTag(filters.tag));
els.clearFilters.addEventListener('click', clearAllFilters);
els.refresh.addEventListener('click', requestRefresh);
els.errorRetry.addEventListener('click', requestRefresh);
els.logout.addEventListener('click', async () => {
  els.logout.disabled = true;
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-nv-models': '1' },
    });
  } catch {
    // 即使请求失败也回到登录页，由服务端重新判断
  }
  location.replace('/login');
});

els.usageClose.addEventListener('click', () => els.usage.close());
els.usage.addEventListener('click', (event) => {
  if (event.target === els.usage) els.usage.close();
});
els.usage.addEventListener('close', () => {
  usageModel = null;
  usageRequest += 1;
  clientState.loading = false;
  els.usageSetup.hidden = true;
  els.usageSetup.replaceChildren();
  document.body.classList.remove('modal-open');
});
els.usageTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.usage-tab');
  if (!tab || tab.dataset.tab === usageTab) return;
  const next = tab.dataset.tab;
  if (!CLIENT_LABELS[next]) return;
  usageTab = next;
  clientState.notice = null;
  renderUsage();
  renderUsageSetup();
});
els.usageTabs.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const ids = Object.keys(CLIENT_LABELS);
  const index = ids.indexOf(usageTab);
  const step = event.key === 'ArrowRight' ? 1 : -1;
  usageTab = ids[(index + step + ids.length) % ids.length];
  clientState.notice = null;
  renderUsage();
  renderUsageSetup();
  els.usageTabs.querySelector(`[data-tab="${usageTab}"]`)?.focus();
});

document.addEventListener('keydown', (event) => {
  if (els.usage.open) return;
  if (event.key === 'Escape' && (filters.q || els.search.value)) {
    els.search.value = '';
    clearAllFilters();
    return;
  }
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const editing =
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (editing) return;
  event.preventDefault();
  els.search.focus();
  els.search.select();
});

window.addEventListener('popstate', () => {
  readUrl();
  applyControls();
  renderContent();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadState();
});

setInterval(() => {
  if (state.data?.refresh?.running) updateMeta();
}, 1000);

readUrl();
applyControls();
renderAll();
loadState();
