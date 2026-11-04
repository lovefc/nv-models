#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash deploy/install.sh" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="/opt/nv-models"
UNIT_SRC="$SRC_DIR/deploy/nv-models.service"
UNIT_DEST="/etc/systemd/system/nv-models.service"

command -v systemctl >/dev/null 2>&1 || {
  echo "当前系统没有 systemd" >&2
  exit 1
}

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js 20.18 或更高版本" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  echo "Node.js 版本过低：$(node -v)，需要 20.18 或更高版本" >&2
  exit 1
fi

if ! id -u nv-models >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$DEST_DIR" --shell /usr/sbin/nologin nv-models
fi

install -d -o nv-models -g nv-models "$DEST_DIR" "$DEST_DIR/src" "$DEST_DIR/data" "$DEST_DIR/logs" "$DEST_DIR/public"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
fi
[ -n "$SERVER_IP" ] || SERVER_IP="127.0.0.1"
if [ -n "${NV_PUBLIC_HOST:-}" ]; then
  SERVER_IP="$NV_PUBLIC_HOST"
fi

gen_token() {
  "$NODE_BIN" -e "console.log('nv-' + require('node:crypto').randomBytes(16).toString('hex'))"
}

LEGACY_API_TOKEN=""
if [ -f /opt/nv-gateway/.env ]; then
  LEGACY_API_TOKEN="$(sed -n 's/^AUTH_TOKEN=//p' /opt/nv-gateway/.env | head -n 1 | tr -d '\r')"
fi

if [ "$SRC_DIR" != "$DEST_DIR" ]; then
  install -m 0644 "$SRC_DIR/package.json" "$DEST_DIR/package.json"
  install -m 0644 "$SRC_DIR/src/env.mjs" "$SRC_DIR/src/server.mjs" "$SRC_DIR/src/service.mjs" "$SRC_DIR/src/setup-script.mjs" "$SRC_DIR/src/collector.mjs" "$SRC_DIR/src/benchmark.mjs" "$SRC_DIR/src/gateway.mjs" "$SRC_DIR/src/clients.mjs" "$SRC_DIR/src/request-ip.mjs" "$DEST_DIR/src/"
  install -m 0644 "$SRC_DIR/public/index.html" "$SRC_DIR/public/style.css" "$SRC_DIR/public/app.js" "$SRC_DIR/public/login.html" "$SRC_DIR/public/login.js" "$SRC_DIR/public/setup.html" "$SRC_DIR/public/setup.js" "$DEST_DIR/public/"
  install -m 0644 "$SRC_DIR/.env.example" "$DEST_DIR/.env.example"
  install -d "$DEST_DIR/deploy" "$DEST_DIR/tools"
  install -m 0755 "$SRC_DIR/deploy/install.sh" "$DEST_DIR/deploy/install.sh"
  install -m 0755 "$SRC_DIR/deploy/bind-domain.sh" "$DEST_DIR/deploy/bind-domain.sh"
  install -m 0644 "$SRC_DIR/deploy/nv-models.service" "$DEST_DIR/deploy/nv-models.service"
  install -m 0644 "$SRC_DIR/deploy/nginx.conf.example" "$DEST_DIR/deploy/nginx.conf.example"
  install -m 0644 "$SRC_DIR/tools/setup-clients.mjs" "$SRC_DIR/tools/setup-clients.cmd" "$DEST_DIR/tools/"
  install -m 0755 "$SRC_DIR/tools/setup-clients.sh" "$DEST_DIR/tools/setup-clients.sh"
  if [ ! -f "$DEST_DIR/data/models.json" ] && [ -f "$SRC_DIR/data/models.json" ]; then
    install -m 0644 "$SRC_DIR/data/models.json" "$DEST_DIR/data/models.json"
  fi
  if [ ! -f "$DEST_DIR/data/translations.json" ] && [ -f "$SRC_DIR/data/translations.json" ]; then
    install -m 0644 "$SRC_DIR/data/translations.json" "$DEST_DIR/data/translations.json"
  fi
  if [ ! -f "$DEST_DIR/data/api-models.json" ] && [ -f "$SRC_DIR/data/api-models.json" ]; then
    install -m 0644 "$SRC_DIR/data/api-models.json" "$DEST_DIR/data/api-models.json"
  fi
fi

# 0.8.0 起源码统一放在 src/，清理旧版本散落在根目录的模块副本。
for legacy in env.mjs server.mjs service.mjs setup-script.mjs collector.mjs benchmark.mjs gateway.mjs clients.mjs request-ip.mjs; do
  rm -f "$DEST_DIR/$legacy"
done

if [ ! -f "$DEST_DIR/.env" ]; then
  UI_TOKEN="$(gen_token)"
  API_TOKEN="${LEGACY_API_TOKEN:-$(gen_token)}"
  cat > "$DEST_DIR/.env" <<'EOF'
# ============================================================
# nv-models 服务器配置
# 只需要填 NVIDIA_API_KEY，其余已按服务器访问配好。
# 改完执行：systemctl restart nv-models
# ============================================================

# 【必填】NVIDIA API Key
# 获取：https://build.nvidia.com → 任选一个模型 → Get API Key
NVIDIA_API_KEY=

# ==================== 访问地址（已自动配好） ====================
NV_MODELS_HOST=0.0.0.0
NV_MODELS_PORT=18788
NV_GATEWAY_HOST=0.0.0.0
NV_GATEWAY_PORT=18787

# 客户端（Qoder / WorkBuddy / ZCode）填写的地址。
# 有域名或换端口时，直接改这一行。
NV_GATEWAY_URL=http://__SERVER_IP__:18787/v1

# 用域名访问（nginx 单域名反代，网页和 API 共用一个域名）：
#   sudo bash /opt/nv-models/deploy/bind-domain.sh 你的域名
# 脚本会自动设置监听地址、公开地址和代理头，检查 nginx、重启服务并验证 HTTPS。
# 证书需先在宝塔面板 / certbot / acme.sh 申请；手动配置见 deploy/nginx.conf.example。
# NV_TRUST_PROXY=1

# 网页登录口令：打开网页后在登录页输入这个口令，登录状态保留 7 天。
NV_MODELS_TOKEN=__UI_TOKEN__
# API 口令：Qoder / WorkBuddy / ZCode 的 API Key 栏填这个。
AUTH_TOKEN=__API_TOKEN__
# 校验范围：remote=只校验非本机（默认），all=本机也要口令
# AUTH_SCOPE=remote
# NV_MODELS_AUTH_SCOPE=remote

# ==================== 以下全部可选 ====================

# 自动采集：默认开启，每 8 小时检查一次。
# 关闭自动采集（页面右上角“刷新”仍可手动采集）：
# NV_MODELS_AUTO=0
# 自定义检查间隔，支持 ms/s/m/h/d：
# NV_MODELS_TTL=8h
# 公开访问时隐藏刷新按钮，并拒绝远程手动刷新（本机仍可调用刷新接口）：
# NV_MODELS_SHOW_REFRESH=0

# 后台自动重扫测速结果（默认每 24h）；改成 0 关闭后台（单个测速仍可用）。
NV_MODELS_BENCHMARK_AUTO=24h
# 彻底关闭测速（页面不显示测速按钮）：
# NV_MODELS_BENCHMARK=0

# 英文简介自动翻译（必应免费接口，无需配置）；关闭：
# NV_MODELS_TRANSLATE=off

# 模型短名（如 glm-5.3-flash，官网的 glm-5-3-flash 也兼容）由程序按模型清单自动维护，不需要配置。
EOF
  sed -i "s|__SERVER_IP__|$SERVER_IP|g; s|__UI_TOKEN__|$UI_TOKEN|g; s|__API_TOKEN__|$API_TOKEN|g" "$DEST_DIR/.env"
  chmod 0600 "$DEST_DIR/.env"
fi

# 从旧 nv-gateway 配置继承密钥，避免升级后 API 因缺 Key 不启动
if [ -f /opt/nv-gateway/.env ]; then
  echo "检测到旧网关配置，正在补全 /opt/nv-models/.env 的空项"
  "$NODE_BIN" - "$DEST_DIR/.env" /opt/nv-gateway/.env <<'NODE'
const fs = require('fs');
const [target, legacy] = process.argv.slice(2);
function parse(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const old = parse(legacy);
let text = fs.readFileSync(target, 'utf8');
const added = [];
for (const key of ['NVIDIA_API_KEY', 'AUTH_TOKEN', 'AUTH_SCOPE']) {
  if (!old[key]) continue;
  const line = new RegExp('^' + key + '=(.*)$', 'm');
  const hit = text.match(line);
  if (hit && hit[1].trim()) continue;
  if (hit) text = text.replace(line, () => key + '=' + old[key]);
  else text += (text.endsWith('\n') ? '' : '\n') + key + '=' + old[key] + '\n';
  added.push(key);
}
fs.writeFileSync(target, text, { mode: 0o600 });
console.log('已继承：' + (added.join(', ') || '无（新配置已填写）'));
NODE
fi

# 服务账号需要写 .env，网页里的首次配置才能保存
chown nv-models:nv-models "$DEST_DIR/.env" 2>/dev/null || true
chmod 0600 "$DEST_DIR/.env"

sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $DEST_DIR/src/server.mjs|" "$UNIT_SRC" > "$UNIT_DEST"
chmod 0644 "$UNIT_DEST"

chown -R nv-models:nv-models "$DEST_DIR/data" "$DEST_DIR/logs" "$DEST_DIR/public"
chown nv-models:nv-models "$DEST_DIR"/*.mjs "$DEST_DIR/package.json" 2>/dev/null || true

if systemctl cat nv-gateway.service >/dev/null 2>&1; then
  echo "检测到旧 nv-gateway 服务，正在停止并禁用（网关已合并到 nv-models）"
  systemctl disable --now nv-gateway.service >/dev/null 2>&1 || true
  sleep 1
fi

systemctl daemon-reload
systemctl enable nv-models >/dev/null 2>&1
systemctl restart nv-models
sleep 1
systemctl --no-pager --lines=5 status nv-models || true

echo
echo "已启动："
echo "  网页  http://$SERVER_IP:18788"
echo "  API   http://$SERVER_IP:18787/v1/chat/completions"
echo "WorkBuddy（国内版/国际版）/ Qoder / ZCode：地址填上面的 API 地址，Token 填 .env 里的 AUTH_TOKEN"
echo "网页登录口令：.env 里的 NV_MODELS_TOKEN（打开网页后输入，登录保留 7 天）"
echo "查看口令：grep -E 'NV_MODELS_TOKEN|AUTH_TOKEN' /opt/nv-models/.env"
echo "只需在 /opt/nv-models/.env 填 NVIDIA_API_KEY，然后 systemctl restart nv-models"
echo "云服务器记得在安全组/防火墙放行 18788 和 18787"
echo "用域名或公网 IP：sudo NV_PUBLIC_HOST=你的域名 bash deploy/install.sh"
echo "绑定域名（自动改配置并验证 HTTPS）：sudo bash /opt/nv-models/deploy/bind-domain.sh 你的域名"
echo "绑定后防火墙只放行 80/443，18787、18788 会自动改为只监听本机"
echo "其余选项（关闭自动采集/测速/翻译、端口）都在 .env 注释里写明"
echo "查看日志：journalctl -u nv-models -f"
