#!/usr/bin/env bash
# One-click deploy for a fresh Ubuntu 22.04 / 24.04 server (e.g. Tencent Cloud Lighthouse)
# Usage:  bash deploy.sh https://github.com/YOUR_NAME/YOUR_REPO.git
set -euo pipefail

REPO_URL="${1:-}"
if [ -z "$REPO_URL" ]; then
  echo "Usage: bash deploy.sh <github-repo-url>"
  exit 1
fi

APP_DIR="/opt/reading-club"
PORT="${PORT:-8443}"

echo "==> [1/7] Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git openssl ufw >/dev/null

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node: $(node -v)  npm: $(npm -v)"

echo "==> [2/7] Fetching source code"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --ff-only
else
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> [3/7] Installing dependencies"
npm install --omit=dev --no-audit --no-fund

echo "==> [4/7] Generating HTTPS certificate (needed for microphone recording)"
mkdir -p "$APP_DIR/data"
if [ ! -f "$APP_DIR/data/cert.pem" ] || [ ! -f "$APP_DIR/data/key.pem" ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$APP_DIR/data/key.pem" \
    -out "$APP_DIR/data/cert.pem" \
    -subj "/CN=Reading Club" >/dev/null 2>&1
  chmod 600 "$APP_DIR/data/key.pem"
fi

echo "==> [5/7] Generating secure credentials"
SECRET="$(openssl rand -hex 32)"
TEACHER_PASS="$(openssl rand -hex 6)"
ISABELLA_PASS="$(openssl rand -hex 6)"
TATA_PASS="$(openssl rand -hex 6)"
cat > /etc/reading-club.env <<EOF
PORT=$PORT
SESSION_SECRET=$SECRET
TEACHER_PASSWORD=$TEACHER_PASS
ISABELLA_PASSWORD=$ISABELLA_PASS
TATA_PASSWORD=$TATA_PASS
EOF
chmod 600 /etc/reading-club.env

echo "==> [6/7] Registering system service"
cat > /etc/systemd/system/reading-club.service <<EOF
[Unit]
Description=Reading Club - English Reading Check-in
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/reading-club.env
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/reading-club.log
StandardError=append:/var/log/reading-club.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable reading-club >/dev/null
systemctl restart reading-club

echo "==> [7/7] Opening firewall port"
ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true

sleep 2
SERVER_IP="$(curl -s --max-time 5 https://api.ipify.org || echo 'YOUR_SERVER_IP')"
echo ""
echo "=================== DEPLOY COMPLETE ==================="
echo "Open in browser:  https://${SERVER_IP}:${PORT}"
echo "If it does not load, open port ${PORT} in the cloud provider's Security Group."
echo ""
echo "Login names / passwords (save these!):"
echo "  Teacher  /  ${TEACHER_PASS}"
echo "  Isabella /  ${ISABELLA_PASS}"
echo "  Tata     /  ${TATA_PASS}"
echo ""
echo "Browser will show a certificate warning on first visit (self-signed)."
echo "Click Advanced -> Proceed. Microphone recording works after that."
echo "Check status:  systemctl status reading-club"
echo "View logs:     tail -f /var/log/reading-club.log"
echo "======================================================="
