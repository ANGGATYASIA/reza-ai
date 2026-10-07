#!/usr/bin/env bash
# ============================================================
# Reza AI — setup produksi satu perintah (Ubuntu VPS, tanpa SSH)
#
# Cara pakai (di console UpCloud, sebagai root):
#   curl -fsSL https://raw.githubusercontent.com/ANGGATYASIA/reza-ai/main/deploy/setup.sh | bash
#
# Script ini:
#  1. Install Docker + Compose plugin + Caddy + UFW
#  2. Menawarkan backup & hapus project lama "sakani closer"
#  3. Clone repo Reza AI ke /opt/reza-ai
#  4. Generate secrets ke /opt/reza-ai/.env (tidak menimpa bila sudah ada)
#  5. Build & jalankan stack (postgres pgvector, redis, web, worker)
#     — migrasi Prisma jalan otomatis di entrypoint container
#  6. Caddy reverse proxy https://app.sakani.id -> 127.0.0.1:3000
#  7. UFW (22,80,443), unattended-upgrades, backup DB harian
# ============================================================
set -euo pipefail

DOMAIN="app.sakani.id"
APP_DIR="/opt/reza-ai"
REPO_URL="https://github.com/ANGGATYASIA/reza-ai.git"
VPS_IP="$(curl -fsSL --max-time 10 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"

log()  { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn() { echo -e "\033[1;33m[peringatan]\033[0m $*"; }
die()  { echo -e "\033[1;31m[gagal]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Jalankan sebagai root (di console UpCloud: langsung root)."
grep -qi ubuntu /etc/os-release || warn "Bukan Ubuntu — script ini dioptimasi untuk Ubuntu, lanjut dengan risiko sendiri."
log "VPS IP terdeteksi: $VPS_IP"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl dnsutils ufw cron > /dev/null

# ---------- 1. Docker ----------
if ! command -v docker > /dev/null; then
  log "Install Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin > /dev/null
  systemctl enable --now docker
else
  log "Docker sudah ada: $(docker --version | head -1)"
fi

# ---------- 2. Caddy ----------
if ! command -v caddy > /dev/null; then
  log "Install Caddy..."
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy > /dev/null
else
  log "Caddy sudah ada."
fi

# ---------- 3. Project lama: sakani closer ----------
log "Memeriksa project lama 'sakani closer'..."
echo "--- container docker ---"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || echo "(tidak ada)"
echo "--- direktori kandidat ---"
SAKANI_DIRS="$(ls -d /opt/sakani* /srv/sakani* /root/sakani* /home/*/sakani* 2>/dev/null || true)"
[ -n "$SAKANI_DIRS" ] && echo "$SAKANI_DIRS" || echo "(tidak ada)"
SAKANI_CONTAINERS="$(docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -i sakani || true)"
[ -n "$SAKANI_CONTAINERS" ] && { echo "--- container sakani ---"; echo "$SAKANI_CONTAINERS"; }

BACKUP_FILE="/root/backup-sakani-closer-$(date +%F).tgz"
# Baca dari /dev/tty agar tidak menelan sisa script saat dijalankan via pipe
read -r -p "Backup ke $BACKUP_FILE lalu HENTIKAN & HAPUS project sakani closer? [y/N] " jawab < /dev/tty
if [[ "$jawab" =~ ^[Yy]$ ]]; then
  log "Membackup..."
  # shellcheck disable=SC2086
  tar -czf "$BACKUP_FILE" $SAKANI_DIRS 2>/dev/null || warn "Tidak ada direktori untuk dibackup."
  log "Backup tersimpan: $BACKUP_FILE"
  if [ -n "$SAKANI_CONTAINERS" ]; then
    NAMES="$(echo "$SAKANI_CONTAINERS" | awk '{print $1}')"
    log "Menghentikan container sakani..."
    echo "$NAMES" | xargs -r docker stop > /dev/null 2>&1 || true
    sleep 3
    log "Menghapus container sakani..."
    echo "$NAMES" | xargs -r docker rm -f > /dev/null 2>&1 || true
    SISA="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -i sakani || true)"
    if [ -n "$SISA" ]; then
      warn "Container bandel (dibiarkan, sudah berhenti): $SISA"
    else
      log "Container sakani closer bersih."
    fi
  fi
  if [ -n "$SAKANI_DIRS" ]; then
    echo "$SAKANI_DIRS" | xargs -r rm -rf || warn "Sebagian direktori gagal dihapus."
    log "Direktori sakani closer dihapus."
  fi
else
  warn "Project sakani closer DIBIARKAN. Pastikan tidak bentrok di port 80/443/3000."
fi

# ---------- 4. Clone repo ----------
if [ -d "$APP_DIR/.git" ]; then
  log "Update repo di $APP_DIR..."
  git -C "$APP_DIR" pull --ff-only
else
  log "Clone repo ke $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
fi

# Rakit kembali pnpm-lock.yaml (dipecah saat push karena batas ukuran argumen)
if ls "$APP_DIR"/pnpm-lock.yaml.part* > /dev/null 2>&1; then
  log "Merakit pnpm-lock.yaml..."
  cat "$APP_DIR"/pnpm-lock.yaml.part* > "$APP_DIR/pnpm-lock.yaml"
fi

# ---------- 5. .env ----------
if [ ! -f "$APP_DIR/.env" ]; then
  log "Generate secrets..."
  cat > "$APP_DIR/.env" <<EOF
# Dibuat otomatis oleh deploy/setup.sh pada $(date -u +%FT%TZ). JANGAN commit.
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MASTER_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
APP_URL=https://$DOMAIN
OWNER_WA_NUMBER=082114812842
EOF
  chmod 600 "$APP_DIR/.env"
else
  log ".env sudah ada — tidak ditimpa."
fi

# ---------- 6. Build & up ----------
log "Build & jalankan stack (bisa beberapa menit saat pertama kali)..."
cd "$APP_DIR"
docker compose up -d --build

log "Menunggu web sehat (maks 5 menit)..."
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:3000/api/health > /dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 10
done
[ "$HEALTHY" -eq 1 ] || die "Web tidak sehat setelah 5 menit. Cek: docker compose logs web worker"

# ---------- 7. Caddy ----------
log "Konfigurasi Caddy untuk $DOMAIN..."
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy > /dev/null 2>&1 || true
systemctl restart caddy
sleep 2
systemctl is-active --quiet caddy || die "Caddy gagal start. Cek: journalctl -u caddy"

# ---------- 8. Hardening ----------
log "UFW: buka 22, 80, 443..."
ufw allow 22,80,443/tcp > /dev/null
yes | ufw enable > /dev/null 2>&1 || true

log "Unattended upgrades..."
apt-get install -y -qq unattended-upgrades > /dev/null

log "Backup DB harian (cron jam 02:00, retensi 7 hari)..."
mkdir -p /var/backups
(crontab -l 2>/dev/null; echo "0 2 * * * docker exec reza-postgres pg_dump -U reza reza_ai | gzip > /var/backups/reza_ai-\$(date +\%F).sql.gz && find /var/backups -name 'reza_ai-*.sql.gz' -mtime +7 -delete") | crontab -

# ---------- 9. Ringkasan ----------
echo ""
echo "=============================================================="
log "SELESAI. Ringkasan:"
echo "  Dashboard : https://$DOMAIN"
echo "  Health    : $(curl -fsS --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null || echo 'cek manual')"
echo ""
DNS_IP="$(dig +short "$DOMAIN" | head -1)"
if [ "$DNS_IP" = "$VPS_IP" ]; then
  log "DNS $DOMAIN sudah mengarah ke VPS ini ($VPS_IP). HTTPS aktif otomatis."
else
  warn "DNS BELUM benar: $DOMAIN -> ${DNS_IP:-'(tidak resolve)'}, seharusnya $VPS_IP."
  warn "Di panel DNS sakani.id buat record: Type A, Host 'app', Value '$VPS_IP'."
  warn "Setelah propagasi (±30 mnt), Caddy otomatis menerbitkan sertifikat HTTPS."
fi
echo ""
log "Langkah berikut di browser: buka https://$DOMAIN/setup untuk buat akun admin,"
log "lalu scan QR WhatsApp di menu WhatsApp, isi API key di Settings > AI,"
log "dan upload knowledge di menu Knowledge."
echo "=============================================================="
