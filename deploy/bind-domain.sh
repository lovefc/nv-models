#!/usr/bin/env bash
# nv-models 一键绑定域名：生成 nginx 单域名反代、修改 .env、验证 HTTPS，失败自动回滚。
set -euo pipefail

SERVICE_NAME="nv-models"
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DOMAIN_INPUT=""
CERT_FILE=""
KEY_FILE=""
NGINX_DIR_OPT=""
ENV_OPT=""
APP_DIR_OPT=""
DRY_RUN=0
FORCE=0
ASSUME_YES=0

ROLLBACK_ARMED=0
CONF_WRITTEN=0
ENV_WRITTEN=0
SERVICE_TOUCHED=0
CONF_BACKUP=""
ENV_BACKUP=""

say()  { printf '[nv-models] %s\n' "$*"; }
warn() { printf '[nv-models] 注意：%s\n' "$*" >&2; }
die()  { printf '[nv-models] 错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
用法：sudo bash $SCRIPT_NAME 你的域名 [选项]

一条命令完成：
  - 自动识别宝塔面板 / 标准 nginx 的站点配置目录
  - 自动查找该域名已有的 HTTPS 证书
  - 生成一个域名同时提供网页和 OpenAI 兼容 API 的反代配置
  - 备份并修改 .env，重启 nv-models，重载 nginx
  - 用 HTTPS 验证网页和 API；任何一步失败都会自动回滚

示例：
  sudo bash $SCRIPT_NAME model.example.com
  sudo bash $SCRIPT_NAME https://model.example.com/
  sudo bash $SCRIPT_NAME model.example.com --cert /path/fullchain.pem --key /path/privkey.pem
  sudo bash $SCRIPT_NAME model.example.com --dry-run

选项：
  --cert PATH      证书文件（fullchain.pem / fullchain.cer）
  --key PATH       证书私钥（privkey.pem / 域名.key）
  --nginx-dir DIR  指定 nginx 站点配置目录（默认自动识别）
  --env PATH       指定 .env（默认安装目录下的 .env）
  --app-dir DIR    指定 nv-models 安装目录（默认 /opt/nv-models）
  --dry-run        只显示将要修改的内容，不写文件、不重启
  --force          覆盖不是本脚本生成的同名 nginx 配置（会先备份）
  -y, --yes        所有确认自动通过（适合脚本化执行）
  -h, --help       显示本帮助

提示：脚本不会自动申请证书。没有证书时会提示宝塔 / certbot / acme.sh 的申请方法。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --cert)
      [ "$#" -ge 2 ] || die "--cert 需要一个证书路径"
      CERT_FILE="$2"
      shift 2
      ;;
    --key)
      [ "$#" -ge 2 ] || die "--key 需要一个私钥路径"
      KEY_FILE="$2"
      shift 2
      ;;
    --nginx-dir)
      [ "$#" -ge 2 ] || die "--nginx-dir 需要一个目录路径"
      NGINX_DIR_OPT="$2"
      shift 2
      ;;
    --env)
      [ "$#" -ge 2 ] || die "--env 需要一个文件路径"
      ENV_OPT="$2"
      shift 2
      ;;
    --app-dir)
      [ "$#" -ge 2 ] || die "--app-dir 需要一个目录路径"
      APP_DIR_OPT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        [ -z "$DOMAIN_INPUT" ] || die "多余的参数：$1"
        DOMAIN_INPUT="$1"
        shift
      done
      ;;
    -*)
      die "未知选项：$1（用 --help 查看用法）"
      ;;
    *)
      [ -z "$DOMAIN_INPUT" ] || die "多余的参数：$1"
      DOMAIN_INPUT="$1"
      shift
      ;;
  esac
done

[ -n "$DOMAIN_INPUT" ] || { usage >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $SCRIPT_NAME 你的域名"
[ "$(uname -s)" = "Linux" ] || die "这个脚本只支持 Linux 服务器"

normalize_domain() {
  local value="$1"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  value="${value%.}"
  printf '%s' "$value"
}

DOMAIN="$(normalize_domain "$DOMAIN_INPUT")"
[ -n "$DOMAIN" ] || die "域名不能为空"
[ "${#DOMAIN}" -le 253 ] || die "域名太长：$DOMAIN"
if ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  die "域名格式不正确：$DOMAIN_INPUT（示例：model.example.com）"
fi

NGINX_BIN="$(command -v nginx 2>/dev/null || true)"
if [ -z "$NGINX_BIN" ]; then
  for candidate in /usr/sbin/nginx /usr/local/nginx/sbin/nginx /www/server/nginx/sbin/nginx; do
    if [ -x "$candidate" ]; then
      NGINX_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$NGINX_BIN" ] || die "找不到 nginx，请先安装 nginx"
command -v systemctl >/dev/null 2>&1 || die "当前系统没有 systemd，无法管理 nv-models 服务"
systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1 || \
  die "没有找到 $SERVICE_NAME 服务，请先运行 deploy/install.sh"

NGINX_VERSION="$("$NGINX_BIN" -v 2>&1 | sed -n 's/^nginx version: nginx\///p' | head -n 1)" || NGINX_VERSION=""

version_ge() {
  local -a a b
  local i av bv
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    av="${a[$i]:-0}"
    bv="${b[$i]:-0}"
    av="${av//[^0-9]/}"
    bv="${bv//[^0-9]/}"
    av="${av:-0}"
    bv="${bv:-0}"
    if [ "$av" -gt "$bv" ]; then return 0; fi
    if [ "$av" -lt "$bv" ]; then return 1; fi
  done
  return 0
}

APP_DIR="${APP_DIR_OPT:-}"
if [ -z "$APP_DIR" ]; then
  if [ -f /opt/nv-models/src/server.mjs ]; then
    APP_DIR="/opt/nv-models"
  else
    APP_DIR="$DEFAULT_APP_DIR"
  fi
fi
[ -d "$APP_DIR" ] || die "安装目录不存在：$APP_DIR（可用 --app-dir 指定）"
APP_DIR="$(cd -P "$APP_DIR" && pwd)"

ENV_FILE="${ENV_OPT:-$APP_DIR/.env}"
[ -f "$ENV_FILE" ] || die "找不到 .env：$ENV_FILE，请先完成安装或首次配置"
ENV_FILE="$(readlink -f "$ENV_FILE")" || die "无法解析 .env 路径：$ENV_FILE"

SERVICE_WAS_ACTIVE=0
if systemctl is-active --quiet "$SERVICE_NAME"; then
  SERVICE_WAS_ACTIVE=1
fi

say "检查现有 nginx 配置..."
if ! "$NGINX_BIN" -t; then
  die "当前 nginx 配置本身没有通过检查，请先修复后再运行本脚本"
fi
if ! systemctl is-active --quiet nginx; then
  die "nginx 当前没有运行，请先启动 nginx"
fi

if [ -n "$NGINX_DIR_OPT" ]; then
  NGINX_DIR="$NGINX_DIR_OPT"
elif [ -d /www/server/panel/vhost/nginx ]; then
  NGINX_DIR="/www/server/panel/vhost/nginx"
elif [ -d /etc/nginx/conf.d ]; then
  NGINX_DIR="/etc/nginx/conf.d"
elif [ -d /etc/nginx/sites-enabled ]; then
  NGINX_DIR="/etc/nginx/sites-enabled"
else
  die "无法识别 nginx 站点配置目录，请用 --nginx-dir 指定（例如 /etc/nginx/conf.d）"
fi
NGINX_DIR="${NGINX_DIR%/}"
[ -d "$NGINX_DIR" ] || die "nginx 配置目录不存在：$NGINX_DIR"

NGINX_STYLE="standard"
if [ "$NGINX_DIR" = "/www/server/panel/vhost/nginx" ]; then
  NGINX_STYLE="bt"
fi

TARGET_PATH="$NGINX_DIR/$DOMAIN.conf"
[ -d "$TARGET_PATH" ] && die "同名路径是一个目录：$TARGET_PATH"
if [ -L "$TARGET_PATH" ]; then
  TARGET_REAL="$(readlink -f "$TARGET_PATH")" || die "无法解析软链接：$TARGET_PATH"
else
  TARGET_REAL="$TARGET_PATH"
fi

TARGET_EXISTS=0
if [ -e "$TARGET_REAL" ]; then
  TARGET_EXISTS=1
fi
if [ "$TARGET_EXISTS" -eq 1 ] && ! grep -q 'managed by nv-models bind-domain.sh' "$TARGET_REAL"; then
  warn "已存在同名 nginx 配置：$TARGET_PATH"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "预览模式：实际运行时会先备份并询问是否覆盖。"
  elif [ "$FORCE" -ne 1 ]; then
    if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
      die "为避免覆盖现有站点，已停止。确认覆盖请加 --force（原文件会先备份）"
    fi
    printf '覆盖现有配置吗？原文件会先备份 [y/N]：'
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *) die "已取消，未修改任何文件" ;;
    esac
  fi
fi

detect_cert() {
  if [ -n "$CERT_FILE" ] || [ -n "$KEY_FILE" ]; then
    [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ] || die "--cert 和 --key 必须同时指定"
    [ -f "$CERT_FILE" ] && [ -r "$CERT_FILE" ] || die "证书文件不可读：$CERT_FILE"
    [ -f "$KEY_FILE" ] && [ -r "$KEY_FILE" ] || die "私钥文件不可读：$KEY_FILE"
    return 0
  fi
  local pair cert key
  for pair in \
    "/www/server/panel/vhost/cert/$DOMAIN/fullchain.pem|/www/server/panel/vhost/cert/$DOMAIN/privkey.pem" \
    "/etc/letsencrypt/live/$DOMAIN/fullchain.pem|/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
    "/root/.acme.sh/$DOMAIN/fullchain.cer|/root/.acme.sh/$DOMAIN/$DOMAIN.key" \
    "/root/.acme.sh/${DOMAIN}_ecc/fullchain.cer|/root/.acme.sh/${DOMAIN}_ecc/$DOMAIN.key" \
    "/etc/nginx/ssl/$DOMAIN/fullchain.pem|/etc/nginx/ssl/$DOMAIN/privkey.pem" \
    "/etc/nginx/ssl/$DOMAIN.crt|/etc/nginx/ssl/$DOMAIN.key" \
    "/etc/nginx/ssl/$DOMAIN.pem|/etc/nginx/ssl/$DOMAIN.key"; do
    cert="${pair%%|*}"
    key="${pair#*|}"
    if [ -f "$cert" ] && [ -r "$cert" ] && [ -f "$key" ] && [ -r "$key" ]; then
      CERT_FILE="$cert"
      KEY_FILE="$key"
      return 0
    fi
  done
  return 1
}

if ! detect_cert; then
  warn "没有找到 $DOMAIN 的 HTTPS 证书"
  cat >&2 <<EOF
请先申请证书（任选一种）：
  宝塔面板：网站 → 设置 → SSL → Let's Encrypt
  certbot： certbot certonly --nginx -d $DOMAIN
  acme.sh： acme.sh --issue --nginx -d $DOMAIN

证书已存在但路径特殊时，重新运行并指定：
  sudo bash $SCRIPT_NAME $DOMAIN --cert /path/fullchain.pem --key /path/privkey.pem
EOF
  if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    printf '证书路径（fullchain，直接回车退出）：'
    read -r answer || answer=""
    if [ -n "$answer" ]; then
      CERT_FILE="$answer"
      printf '私钥路径（privkey）：'
      read -r KEY_FILE || KEY_FILE=""
      [ -n "$KEY_FILE" ] || die "未填写私钥路径"
      [ -f "$CERT_FILE" ] && [ -r "$CERT_FILE" ] || die "证书文件不可读：$CERT_FILE"
      [ -f "$KEY_FILE" ] && [ -r "$KEY_FILE" ] || die "私钥文件不可读：$KEY_FILE"
    else
      exit 1
    fi
  else
    exit 1
  fi
fi

if command -v openssl >/dev/null 2>&1; then
  if ! openssl x509 -checkend 0 -noout -in "$CERT_FILE" >/dev/null 2>&1; then
    die "证书已过期或无法解析：$CERT_FILE，请先续期"
  fi
  if ! openssl x509 -checkend 2592000 -noout -in "$CERT_FILE" >/dev/null 2>&1; then
    warn "证书将在 30 天内到期，请记得续期"
  fi
fi

env_get() {
  local key="$1" fallback="$2" value
  value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$/\2/p" "$ENV_FILE" 2>/dev/null | tail -n 1)" || value=""
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "${#value}" -ge 2 ]; then
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
  fi
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%%[[:space:]]#*}"
  printf '%s' "${value:-$fallback}"
}

WEB_PORT="$(env_get NV_MODELS_PORT 18788)"
GATEWAY_PORT="$(env_get NV_GATEWAY_PORT 18787)"
MAX_BODY_MB="$(env_get MAX_BODY_MB 40)"

case "$WEB_PORT" in
  ''|*[!0-9]*) die "NV_MODELS_PORT 不是有效端口：$WEB_PORT" ;;
esac
case "$GATEWAY_PORT" in
  ''|*[!0-9]*) die "NV_GATEWAY_PORT 不是有效端口：$GATEWAY_PORT" ;;
esac
[ "$WEB_PORT" -ge 1 ] && [ "$WEB_PORT" -le 65535 ] || die "NV_MODELS_PORT 超出范围：$WEB_PORT"
[ "$GATEWAY_PORT" -ge 1 ] && [ "$GATEWAY_PORT" -le 65535 ] || die "NV_GATEWAY_PORT 超出范围：$GATEWAY_PORT"
case "$MAX_BODY_MB" in
  ''|*[!0-9]*) warn "MAX_BODY_MB 不是整数，按 40 处理"; MAX_BODY_MB=40 ;;
esac

DESIRED_HOST="127.0.0.1"
DESIRED_URL="https://$DOMAIN/v1"

env_count() {
  local key="$1"
  grep -cE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null || true
}

ENV_CHANGED=0
[ "$(env_get NV_MODELS_HOST '')" = "$DESIRED_HOST" ] || ENV_CHANGED=1
[ "$(env_get NV_GATEWAY_HOST '')" = "$DESIRED_HOST" ] || ENV_CHANGED=1
[ "$(env_get NV_GATEWAY_URL '')" = "$DESIRED_URL" ] || ENV_CHANGED=1
[ "$(env_get NV_TRUST_PROXY '')" = "1" ] || ENV_CHANGED=1
for key in NV_MODELS_HOST NV_GATEWAY_HOST NV_GATEWAY_URL NV_TRUST_PROXY; do
  if [ "$(env_count "$key")" -gt 1 ]; then
    ENV_CHANGED=1
  fi
done

if command -v curl >/dev/null 2>&1; then
  CURL_BIN="$(command -v curl)"
else
  CURL_BIN=""
fi

DNS_IPS=""
if command -v getent >/dev/null 2>&1; then
  DNS_IPS="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')" || DNS_IPS=""
fi
if [ -z "$DNS_IPS" ] && command -v dig >/dev/null 2>&1; then
  DNS_IPS="$(dig +short A "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | sort -u | tr '\n' ' ')" || DNS_IPS=""
fi
DNS_IPS="${DNS_IPS% }"
if [ -z "$DNS_IPS" ]; then
  warn "没有查到 $DOMAIN 的 A 记录，请确认域名已解析到本机；脚本会继续，绑定后客户端可能暂时访问不了"
else
  say "域名解析：$DNS_IPS"
fi

ACME_ROOT=""
if [ "$TARGET_EXISTS" -eq 1 ]; then
  ACME_ROOT="$(sed -n -E 's/^[[:space:]]*root[[:space:]]+([^;]+);.*$/\1/p' "$TARGET_REAL" | head -n 1 | tr -d "\"'" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" || ACME_ROOT=""
fi
case "$ACME_ROOT" in
  ''|'$'*) ACME_ROOT="" ;;
esac
if [ -z "$ACME_ROOT" ]; then
  if [ "$NGINX_STYLE" = "bt" ]; then
    ACME_ROOT="/www/wwwroot/$DOMAIN"
  else
    ACME_ROOT="/var/www/html"
  fi
fi

IPV6_LISTEN=0
if [ "$TARGET_EXISTS" -eq 1 ]; then
  if grep -Eq '^[[:space:]]*listen[[:space:]]+\[::\]:' "$TARGET_REAL"; then
    IPV6_LISTEN=1
  fi
elif [ "$NGINX_STYLE" = "bt" ] && [ -f /proc/net/if_inet6 ]; then
  IPV6_LISTEN=1
fi

HTTP_LISTEN='    listen 80;'
if version_ge "$NGINX_VERSION" "1.25.1"; then
  HTTPS_LISTEN=$'    listen 443 ssl;\n    http2 on;'
  if [ "$IPV6_LISTEN" -eq 1 ]; then
    HTTP_LISTEN=$'    listen 80;\n    listen [::]:80;'
    HTTPS_LISTEN=$'    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;'
  fi
else
  HTTPS_LISTEN='    listen 443 ssl http2;'
  if [ "$IPV6_LISTEN" -eq 1 ]; then
    HTTP_LISTEN=$'    listen 80;\n    listen [::]:80;'
    HTTPS_LISTEN=$'    listen 443 ssl http2;\n    listen [::]:443 ssl http2;'
  fi
fi

render_config() {
  cat <<EOF
# managed by nv-models bind-domain.sh
# 域名：$DOMAIN
# 生成时间：$(date '+%Y-%m-%d %H:%M:%S')
# 重新运行 deploy/bind-domain.sh 会覆盖本文件（覆盖前自动备份）。

server {
$HTTP_LISTEN
    server_name $DOMAIN;

    root "$ACME_ROOT";

    location ^~ /.well-known/acme-challenge/ {
        default_type text/plain;
        root "$ACME_ROOT";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
$HTTPS_LISTEN
    server_name $DOMAIN;

    ssl_certificate     "$CERT_FILE";
    ssl_certificate_key "$KEY_FILE";
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size ${MAX_BODY_MB}m;

    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header Connection "";

    location /v1/ {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:${GATEWAY_PORT};
        proxy_read_timeout 15s;
    }

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_read_timeout 120s;
    }
}
EOF
}

CONFIG_TEXT="$(render_config)"
BACKUP_SUFFIX="$(date '+%Y%m%d-%H%M%S')-$$"

say "准备绑定：$DOMAIN"
printf '  nginx 配置：%s\n' "$TARGET_PATH"
printf '  证书：%s\n' "$CERT_FILE"
printf '  私钥：%s\n' "$KEY_FILE"
printf '  .env：%s\n' "$ENV_FILE"
printf '  网页：127.0.0.1:%s\n' "$WEB_PORT"
printf '  API ：127.0.0.1:%s\n' "$GATEWAY_PORT"
if [ "$TARGET_EXISTS" -eq 1 ]; then
  printf '  原配置备份：%s.bak-%s\n' "$TARGET_REAL" "$BACKUP_SUFFIX"
fi
if [ "$ENV_CHANGED" -eq 1 ]; then
  printf '  原 .env 备份：%s.bak-%s\n' "$ENV_FILE" "$BACKUP_SUFFIX"
fi
echo '  .env 将设置为：'
printf '    NV_MODELS_HOST=%s\n' "$DESIRED_HOST"
printf '    NV_GATEWAY_HOST=%s\n' "$DESIRED_HOST"
printf '    NV_GATEWAY_URL=%s\n' "$DESIRED_URL"
echo '    NV_TRUST_PROXY=1'
if [ "$ENV_CHANGED" -eq 0 ]; then
  echo '  （当前 .env 已经一致，无需修改）'
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo '---- 将写入的 nginx 配置开始 ----'
  printf '%s\n' "$CONFIG_TEXT"
  echo '---- 将写入的 nginx 配置结束 ----'
  say "预览完成，没有修改任何文件。去掉 --dry-run 即可执行。"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  if [ ! -t 0 ]; then
    die "当前不是交互终端，确认执行请加 --yes（可先用 --dry-run 预览）"
  fi
  printf '确认执行？[Y/n]：'
  read -r answer || answer=""
  case "$answer" in
    ''|y|Y|yes|YES) ;;
    *) say "已取消，未修改任何文件"; exit 0 ;;
  esac
fi

rollback() {
  set +e
  warn "执行失败，正在恢复到执行前状态..."
  if [ "$ENV_WRITTEN" -eq 1 ] && [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ]; then
    cp -p "$ENV_BACKUP" "$ENV_FILE" && warn "已恢复 .env"
  fi
  if [ "$CONF_WRITTEN" -eq 1 ]; then
    if [ -n "$CONF_BACKUP" ] && [ -f "$CONF_BACKUP" ]; then
      cp -p "$CONF_BACKUP" "$TARGET_REAL" && warn "已恢复 nginx 配置"
    else
      rm -f "$TARGET_REAL" && warn "已删除新生成的 nginx 配置"
    fi
  fi
  if "$NGINX_BIN" -t >/dev/null 2>&1; then
    if systemctl is-active --quiet nginx; then
      systemctl reload nginx >/dev/null 2>&1 || "$NGINX_BIN" -s reload >/dev/null 2>&1
    fi
  else
    warn "恢复后的 nginx 配置仍未通过检查，请手动执行 nginx -t 查看"
  fi
  if [ "$SERVICE_TOUCHED" -eq 1 ]; then
    if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
      systemctl restart "$SERVICE_NAME" >/dev/null 2>&1
    else
      systemctl stop "$SERVICE_NAME" >/dev/null 2>&1
    fi
  fi
  warn "回滚完成"
}

on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$ROLLBACK_ARMED" -eq 1 ]; then
    rollback
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

ROLLBACK_ARMED=1

if [ "$TARGET_EXISTS" -eq 1 ]; then
  CONF_BACKUP="$TARGET_REAL.bak-$BACKUP_SUFFIX"
  cp -p "$TARGET_REAL" "$CONF_BACKUP" || die "备份原 nginx 配置失败"
  say "已备份原配置：$CONF_BACKUP"
fi

TMP_CONF="$(mktemp "$NGINX_DIR/.nv-models-$DOMAIN.XXXXXX")"
if ! printf '%s\n' "$CONFIG_TEXT" > "$TMP_CONF"; then
  rm -f "$TMP_CONF"
  die "写入 nginx 配置失败"
fi
chmod 0644 "$TMP_CONF"
CONF_WRITTEN=1
if ! mv -f "$TMP_CONF" "$TARGET_REAL"; then
  rm -f "$TMP_CONF"
  die "替换 nginx 配置失败"
fi
say "已写入 nginx 配置：$TARGET_PATH"

if ! "$NGINX_BIN" -t; then
  die "nginx 配置检查失败，已回滚"
fi
NGINX_DUMP="$("$NGINX_BIN" -T 2>/dev/null)" || die "nginx -T 执行失败，已回滚"
if ! printf '%s\n' "$NGINX_DUMP" | grep -Fq "# configuration file $TARGET_PATH:" && \
   ! printf '%s\n' "$NGINX_DUMP" | grep -Fq "# configuration file $TARGET_REAL:"; then
  unset NGINX_DUMP
  die "nginx 没有加载 $TARGET_PATH，请确认 --nginx-dir 指向 nginx 实际 include 的目录"
fi
unset NGINX_DUMP

if [ "$ENV_CHANGED" -eq 1 ]; then
  ENV_UID="$(stat -c '%u' "$ENV_FILE")" || die "无法读取 .env 所有者"
  ENV_GID="$(stat -c '%g' "$ENV_FILE")" || die "无法读取 .env 所有者"
  ENV_MODE="$(stat -c '%a' "$ENV_FILE")" || die "无法读取 .env 权限"
  ENV_BACKUP="$ENV_FILE.bak-$BACKUP_SUFFIX"
  cp -p "$ENV_FILE" "$ENV_BACKUP" || die "备份 .env 失败"
  say "已备份原配置：$ENV_BACKUP"

  TMP_ENV="$(mktemp "$ENV_FILE.tmp.XXXXXX")" || die "无法创建 .env 临时文件"
  if ! awk \
    -v host="$DESIRED_HOST" \
    -v url="$DESIRED_URL" '
      function is_key(line, key) {
        return line ~ ("^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=")
      }
      {
        if (is_key($0, "NV_MODELS_HOST")) {
          if (!host_done) { print "NV_MODELS_HOST=" host; host_done=1 }
          next
        }
        if (is_key($0, "NV_GATEWAY_HOST")) {
          if (!gateway_host_done) { print "NV_GATEWAY_HOST=" host; gateway_host_done=1 }
          next
        }
        if (is_key($0, "NV_GATEWAY_URL")) {
          if (!url_done) { print "NV_GATEWAY_URL=" url; url_done=1 }
          next
        }
        if (is_key($0, "NV_TRUST_PROXY")) {
          if (!trust_done) { print "NV_TRUST_PROXY=1"; trust_done=1 }
          next
        }
        print
      }
      END {
        if (!host_done) print "NV_MODELS_HOST=" host
        if (!gateway_host_done) print "NV_GATEWAY_HOST=" host
        if (!url_done) print "NV_GATEWAY_URL=" url
        if (!trust_done) print "NV_TRUST_PROXY=1"
      }
    ' "$ENV_FILE" > "$TMP_ENV"; then
    rm -f "$TMP_ENV"
    die "写入 .env 失败"
  fi
  chmod "$ENV_MODE" "$TMP_ENV" 2>/dev/null || chmod 0600 "$TMP_ENV"
  chown "$ENV_UID:$ENV_GID" "$TMP_ENV" 2>/dev/null || true
  ENV_WRITTEN=1
  if ! mv -f "$TMP_ENV" "$ENV_FILE"; then
    rm -f "$TMP_ENV"
    die "替换 .env 失败"
  fi
  say "已更新 .env"
fi

say "重启 $SERVICE_NAME..."
SERVICE_TOUCHED=1
if ! systemctl restart "$SERVICE_NAME"; then
  die "nv-models 重启失败，已回滚"
fi

wait_service() {
  local i=0
  while [ "$i" -lt 30 ]; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if ! wait_service; then
  systemctl --no-pager --lines=20 status "$SERVICE_NAME" >&2 || true
  die "nv-models 没有正常启动，已回滚"
fi

say "重载 nginx..."
if ! systemctl reload nginx; then
  "$NGINX_BIN" -s reload || die "nginx 重载失败，已回滚"
fi

verify_https() {
  local path="$1" expected="$2" label="$3" code="" want i=0
  while [ "$i" -lt 20 ]; do
    code="$("$CURL_BIN" -sS --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$DOMAIN$path" 2>/dev/null || true)"
    for want in $expected; do
      if [ "$code" = "$want" ]; then
        return 0
      fi
    done
    i=$((i + 1))
    sleep 1
  done
  warn "$label 校验失败：HTTP ${code:-无响应}（期望 $expected）"
  return 1
}

verify_http_redirect() {
  local code="" i=0
  while [ "$i" -lt 10 ]; do
    code="$("$CURL_BIN" -sS --max-time 15 --resolve "$DOMAIN:80:127.0.0.1" -o /dev/null -w '%{http_code}' "http://$DOMAIN/" 2>/dev/null || true)"
    case "$code" in
      301|302|307|308) return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  warn "HTTP 跳转校验失败：HTTP ${code:-无响应}（期望 301）"
  return 1
}

if [ -n "$CURL_BIN" ]; then
  say "验证 HTTPS..."
  if ! verify_http_redirect; then
    die "HTTP 跳转校验失败，已回滚"
  fi
  if ! verify_https "/api/health" "200" "网页健康检查"; then
    die "网页没有通过 nginx 正常响应，已回滚"
  fi
  if ! verify_https "/" "200 302 303 307 308" "网页首页"; then
    die "网页首页没有正常响应，已回滚"
  fi
  if ! verify_https "/health" "200" "API 健康检查"; then
    die "API 没有通过 nginx 正常响应，已回滚"
  fi
else
  warn "未安装 curl，跳过 HTTPS 自动验证；请手动打开 https://$DOMAIN/ 检查"
fi

ROLLBACK_ARMED=0
say "绑定完成"
echo
echo "  网页：https://$DOMAIN/"
echo "  API ：https://$DOMAIN/v1"
echo "  证书：$CERT_FILE"
echo "  nginx 配置：$TARGET_PATH"
if [ -n "$CONF_BACKUP" ]; then
  echo "  原配置备份：$CONF_BACKUP"
fi
if [ -n "$ENV_BACKUP" ]; then
  echo "  原 .env 备份：$ENV_BACKUP"
fi
echo
echo "网页登录口令和 API 口令仍在 $ENV_FILE 中："
echo "  grep -E '^(NV_MODELS_TOKEN|AUTH_TOKEN)=' $ENV_FILE"
echo "安全组/防火墙只需放行 80 和 443；18787、18788 已经改为只监听本机。"
echo "客户端里原来填 IP:端口 的，请改成 https://$DOMAIN/v1。"
