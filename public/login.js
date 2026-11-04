const $ = (id) => document.getElementById(id);

const form = $('login-form');
const input = $('token');
const submit = $('login-submit');
const errorBox = $('login-error');
const toggle = $('token-toggle');

function nextPath() {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

$('token-toggle').addEventListener('click', () => {
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(reveal));
  toggle.setAttribute('aria-label', reveal ? '隐藏口令' : '显示口令');
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const token = input.value.trim();
  if (!token) {
    showError('请输入访问口令');
    input.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = '登录中…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nv-models': '1' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `登录失败（HTTP ${response.status}）`);
    location.replace(nextPath());
  } catch (error) {
    showError(error.message || String(error));
    submit.disabled = false;
    submit.textContent = '登录';
    input.select();
  }
});

input.focus();
