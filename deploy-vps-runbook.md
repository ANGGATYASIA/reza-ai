# Reza AI — VPS Deploy Runbook (Task 17)

Disiapkan: 2026-10-07 · VPS UpCloud IP 85.211.254.195 · Domain: app.sakani.id
SSH key `hatch` sudah dipasang reja. Izinkan menghapus project lama "sakani closer" — eksplisit dari reja 2026-10-07.

## A. DNS (reja kerjakan — tidak butuh SSH)

Di panel DNS domain sakani.id, buat satu record:

- Type: `A`
- Host/Name: `app`
- Value: `85.211.254.195`
- TTL: 300 (atau default)

Verifikasi: `dig +short app.sakani.id` → `85.211.254.195`. Propagasi biasanya < 30 menit.

## B. SSH pertama (butuh outbound SSH diaktifkan di Muse settings)

1. `ssh root@85.211.254.195` (atau user yang tersedia)
2. Identifikasi project lama "sakani closer": `docker ps -a`, `ls /srv /opt /root`, `pm2 list` — catat apa yang jalan.
3. Stop + hapus container/volume milik sakani closer (izin eksplisit reja). **Jangan** hapus data sebelum konfirmasi isi `docker ps` ke reja bila ada yang meragukan.

## C. Deploy Reza AI

1. Install Docker + compose plugin: `apt update && apt install -y docker.io docker-compose-plugin` (Ubuntu; sesuaikan distro).
2. Copy repo ke VPS: `rsync -a --exclude node_modules --exclude .git ~/workspace/reza-ai/ root@85.211.254.195:/opt/reza-ai/`
3. Di VPS, buat `/opt/reza-ai/.env` dari env var yang sama dipakai compose (APP_URL=https://app.sakani.id, MASTER_KEY, SESSION_SECRET, POSTGRES_PASSWORD, LLM API key setelah reja isi di Settings › AI).
4. `cd /opt/reza-ai && docker compose up -d --build` → tunggu postgres healthy → cek `curl localhost:3000`.

## D. HTTPS untuk app.sakani.id

Pakai Caddy (paling gampang, Let's Encrypt otomatis):

1. `apt install -y caddy`
2. `/etc/caddy/Caddyfile`:
   ```
   app.sakani.id {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. `systemctl reload caddy` → buka https://app.sakani.id

## E. Hardening + backup (sesuai janji ke reja)

- UFW: `ufw allow 22,80,443/tcp && ufw enable`
- Compose mem-publish 5432/6379 — pastikan UFW menutupnya dari luar (hanya 22/80/443 terbuka), atau bind ulang ke `127.0.0.1` di compose.
- `apt install -y unattended-upgrades` → update keamanan otomatis.
- Backup DB harian via cron: `docker exec reza-postgres pg_dump -U reza reza_ai | gzip > /var/backups/reza_ai-$(date +%F).sql.gz` + retensi 7 hari.

## Setelah deploy

- QR pairing WhatsApp di-scan dari https://app.sakani.id (bukan dari sandbox lagi).
- API key provider LLM diisi reja di Settings › AI.
- Knowledge di-upload manual di dashboard (keputusan reja: tanpa seed otomatis).
