const $ = (id) => document.getElementById(id);

const status = {
  data: null,
  loaded: false,
};

function redirectToLogin() {
  location.replace('/login?next=/setup');
}

function authRedirect(response) {
  if (response.status !== 401) return false;
  redirectToLogin();
  return true;
}

function setBusy(busy) {
  const submit = $('setup-submit');
  submit.disabled = busy;
  submit.textContent = busy ? '保存中…' : status.data?.firstRun ? '保存并启动' : '保存';
}

function hideAlerts() {
  $('setup-error').hidden = true;
  $('setup-warning').hidden = true;
}

function showError(message) {
  const box = $('setup-error');
  box.textContent = message;
  box.hidden = false;
}

function showWarning(message) {
  const box = $('setup-warning');
  box.textContent = message;
  box.hidden = false;
}

function syncClearToken() {
  const clear = $('token-clear').checked;
  $('token').disabled = clear;
  $('token-generate').disabled = clear;
}

function syncClearPanelToken() {
  const clear = $('panel-token-clear').checked;
  $('panel-token').disabled = clear;
  $('panel-token-generate').disabled = clear;
}

function fillRandom(inputId, clearId) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const input = $(inputId);
  input.value = `nv-${hex}`;
  $(clearId).checked = false;
  syncClearToken();
  syncClearPanelToken();
  input.focus();
}

function randomToken() {
  fillRandom('token', 'token-clear');
}

function randomPanelToken() {
  fillRandom('panel-token', 'panel-token-clear');
}

function applyStatus(data, { keepIntro = false } = {}) {
  status.data = data;
  status.loaded = true;

  selectDuration($('refresh'), data.auto ? data.ttlMs : 0, data.ttlLabel);
  selectDuration($('benchmark-auto'), data.benchmarkAutoMs, data.benchmarkAutoLabel);

  $('key').required = data.firstRun;
  $('key').placeholder = data.firstRun ? 'nvapi-…' : '留空表示不修改';
  $('token').placeholder = data.hasToken
    ? '留空表示不修改'
    : data.firstRun
      ? '留空自动生成'
      : '留空表示不设置';
  $('panel-token').placeholder = data.hasPanelToken ? '留空表示不修改' : '留空则不设口令';
  $('show-refresh').value = data.showRefresh === false ? '0' : '1';
  $('benchmark').value = data.benchmarkEnabled === false ? '0' : '1';
  $('translate').value = data.translateEnabled === false ? '0' : '1';
  $('settings').value = data.settingsSwitch === false ? '0' : '1';
  $('setup-back').hidden = data.firstRun;
  $('setup-logout').hidden = !data.session;
  if (!data.firstRun && !keepIntro) {
    $('setup-title').textContent = '设置';
    $('setup-sub').textContent = data.gatewayAvailable
      ? '修改后立即生效，无需重启'
      : '保存后启动 API 并继续采集模型';
    document.title = '设置 · NVIDIA 免费模型';
  }
  setBusy(false);
}

function parseDuration(input) {
  const match = String(input).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return 0;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    (match[2] || 'ms').toLowerCase()
  ];
  return Math.round(Number(match[1]) * unit);
}

function selectDuration(select, ms, label) {
  if (!ms) {
    select.value = 'off';
    return;
  }
  let value = `${ms}ms`;
  for (const option of select.options) {
    if (option.value !== 'off' && parseDuration(option.value) === ms) {
      value = option.value;
      break;
    }
  }
  if (![...select.options].some((option) => option.value === value)) {
    select.add(new Option(`每 ${label}`, value));
  }
  select.value = value;
}

async function loadStatus() {
  try {
    const response = await fetch('/api/setup', { headers: { accept: 'application/json' } });
    if (authRedirect(response)) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `加载失败（${response.status}）`);
    applyStatus(data);
  } catch (error) {
    status.loaded = false;
    setBusy(true);
    showError(error.message);
  }
}

$('key-toggle').addEventListener('click', () => {
  const input = $('key');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  $('key-toggle').setAttribute('aria-pressed', String(reveal));
  $('key-toggle').setAttribute('aria-label', reveal ? '隐藏 Key' : '显示 Key');
});

$('token-generate').addEventListener('click', randomToken);
$('token-clear').addEventListener('change', syncClearToken);
$('panel-token-generate').addEventListener('click', randomPanelToken);
$('panel-token-clear').addEventListener('change', syncClearPanelToken);

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  hideAlerts();

  const key = $('key').value.trim();
  const token = $('token').value.trim();
  const clearToken = $('token-clear').checked;
  const panelToken = $('panel-token').value.trim();
  const clearPanelToken = $('panel-token-clear').checked;

  if (!key && !status.data?.hasKey) {
    showError('请填写 NVIDIA API Key');
    $('key').focus();
    return;
  }

  const payload = {
    refresh: $('refresh').value,
    clearToken,
    showRefresh: $('show-refresh').value,
    benchmark: $('benchmark').value,
    benchmarkAuto: $('benchmark-auto').value,
    translate: $('translate').value,
    settings: $('settings').value,
  };
  if (key) payload.key = key;
  if (!clearToken && token) payload.token = token;
  if (!clearPanelToken && panelToken) payload.panelToken = panelToken;
  if (clearPanelToken) payload.clearPanelToken = true;

  setBusy(true);
  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv-models': '1' },
      body: JSON.stringify(payload),
    });
    if (authRedirect(response)) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `保存失败（${response.status}）`);

    $('key').value = '';
    $('token').value = '';
    $('token-clear').checked = false;
    $('panel-token').value = '';
    $('panel-token-clear').checked = false;
    $('key').type = 'password';
    syncClearToken();
    syncClearPanelToken();
    applyStatus(data.status);

    if (data.reloginRequired) {
      window.location.assign('/login?next=/setup');
      return;
    }
    if (data.settingsClosed) {
      showWarning('设置页已关闭。要重新打开，请在 .env 中设置 NV_MODELS_SETTINGS=1 并重启服务。');
      $('setup-submit').disabled = true;
      return;
    }
    if (data.warning) {
      showWarning(data.warning);
      return;
    }
    window.location.assign('/');
  } catch (error) {
    showError(error.message);
    setBusy(false);
  }
});

$('setup-logout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'x-nv-models': '1' },
    });
  } catch {
    // 回到登录页由服务端继续判断
  }
  window.location.assign('/login');
});

syncClearToken();
syncClearPanelToken();
loadStatus();
