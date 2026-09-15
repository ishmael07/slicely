#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 (arm64 or amd64) VM: Docker, the
# firewall holes Oracle's image ships closed, a checkout, and the first build.
# Run as the default user (ubuntu):  bash <(curl -fsSL <raw url of this file>)
# or after cloning:                   bash deploy/oracle/setup.sh
set -euo pipefail

REPO="${SLICELY_REPO:-https://github.com/ishmael07/slicely.git}"
BRANCH="${SLICELY_BRANCH:-slicely-v3}"
DIR="$HOME/slicely"

echo "== Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "== Open 80/443 in the instance firewall (Oracle's Ubuntu image blocks them by default)"
sudo iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "== Checkout"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR/deploy/oracle"
[ -f .env ] || { cp .env.example .env; echo "!! Fill in $DIR/deploy/oracle/.env (SLICELY_HOST, SLICELY_PUBLIC_URL, SLICELY_MASTER_KEY at least), then re-run this script."; exit 0; }

echo "== Build and start"
export SOURCE_COMMIT="$(git -C "$DIR" rev-parse HEAD)"
sg docker -c "docker compose up -d --build"
echo
echo "Started. Follow the boot: sg docker -c 'docker compose logs -f app'"
echo "Then open https://$(grep ^SLICELY_HOST= .env | cut -d= -f2)/healthz"
