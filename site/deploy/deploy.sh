#!/usr/bin/env bash
# 把 site/ 部署到服务器 PP（~/.ssh/config 里的主机名）。
# 用法：bash site/deploy/deploy.sh            # 更新代码并重启
#      bash site/deploy/deploy.sh --init     # 第一次：建用户、装 systemd 服务和 nginx 站点
set -euo pipefail

HOST="${DEPLOY_HOST:-PP}"
REMOTE_DIR=/var/www/emoji
SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN=emoji.ourmeetismyserendipity-pplovecpu.fun

echo "==> 打包上传 $SITE_DIR -> $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
tar -C "$SITE_DIR" -czf - --exclude=node_modules --exclude=data --exclude=data-dev --exclude=.DS_Store . | ssh "$HOST" "tar -xzf - -C $REMOTE_DIR"

if [[ "${1:-}" == "--init" ]]; then
  echo "==> 初始化：用户、依赖、服务、nginx"
  ssh "$HOST" bash -s <<EOF
set -e
id -u emoji >/dev/null 2>&1 || useradd --system --home $REMOTE_DIR --shell /usr/sbin/nologin emoji
mkdir -p $REMOTE_DIR/data
cd $REMOTE_DIR && pnpm install --prod --frozen-lockfile 2>/dev/null || (cd $REMOTE_DIR && pnpm install --prod)
chown -R emoji:emoji $REMOTE_DIR
[ -f /etc/emoji-site.env ] || printf 'PORT=8844\nHOST=127.0.0.1\nEMOJI_DATA_DIR=$REMOTE_DIR/data\nNODE_ENV=production\n' > /etc/emoji-site.env
install -m 644 $REMOTE_DIR/deploy/emoji-site.service /etc/systemd/system/emoji-site.service
install -m 644 $REMOTE_DIR/deploy/nginx-emoji.conf /etc/nginx/sites-available/emoji
ln -sf /etc/nginx/sites-available/emoji /etc/nginx/sites-enabled/emoji
nginx -t && systemctl reload nginx
systemctl daemon-reload
systemctl enable --now emoji-site
sleep 1
systemctl --no-pager --lines=5 status emoji-site || true
EOF
else
  ssh "$HOST" bash -s <<EOF
set -e
cd $REMOTE_DIR && pnpm install --prod --frozen-lockfile 2>/dev/null || (cd $REMOTE_DIR && pnpm install --prod)
chown -R emoji:emoji $REMOTE_DIR
systemctl restart emoji-site
sleep 1
systemctl --no-pager --lines=3 status emoji-site || true
EOF
fi

echo "==> 健康检查"
ssh "$HOST" "curl -sk --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/healthz || curl -s -H 'Host: $DOMAIN' http://127.0.0.1:8844/healthz; echo"
echo "完成：https://$DOMAIN"
