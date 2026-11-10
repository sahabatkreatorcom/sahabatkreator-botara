#!/usr/bin/env bash
#
# Backup harian Postgres Sahabat Kreator.
#
# Menghasilkan dump format custom (sudah terkompresi) ke
# ~/backups/sahabat-kreator/{daily,weekly}, lalu MEMVERIFIKASI bahwa dump
# itu dapat dibaca ulang (`pg_restore --list`). Dump yang tidak lolos
# verifikasi langsung dihapus — lebih baik tidak punya berkas daripada
# punya berkas yang dikira backup.
#
# Dipanggil oleh cron (lihat deploy/scripts/install-backup-cron.sh) dan
# boleh dijalankan manual kapan pun.
#
# Variabel lingkungan (semua opsional). Nilai di bawah ini biasanya
# diletakkan di $DEPLOY_DIR/backup.env, yang dibaca otomatis:
#   BACKUP_DIR            default ~/backups/sahabat-kreator
#   KEEP_DAILY            default 7   (hari)
#   KEEP_WEEKLY           default 28  (hari; cadangan mingguan)
#   BACKUP_UPLOAD_CMD     perintah off-site; berkas dump diterima sebagai $1.
#                         Contoh: 'deploy/scripts/upload-backup-r2.sh "$1"'
#                         Kosong = hanya salinan lokal (BELUM off-site).
#   ALERT_WEBHOOK_URL     URL webhook (Slack/Discord/generic) untuk notifikasi
#                         kegagalan. Kosong = hanya log.
#
# Keluar dengan status != 0 bila backup gagal, sehingga cron menandainya
# sebagai kegagalan.

set -euo pipefail

# --- Lokasi & parameter -----------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

# Konfigurasi off-site & notifikasi dibaca dari berkas terpisah, bukan dari
# .env aplikasi: .env berisi rahasia runtime (kunci sesi, enkripsi, DSN)
# yang tidak ada urusannya dengan skrip backup, dan mencampurnya membuat
# satu berkas menjadi izin akses untuk dua hal berbeda.
#
#   BACKUP_ENV_FILE  default $DEPLOY_DIR/backup.env
#
# Berkas itu berisi mis.:
#   BACKUP_UPLOAD_CMD='/path/deploy/scripts/upload-backup-r2.sh "$1"'
#   ALERT_WEBHOOK_URL='https://...'
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$DEPLOY_DIR/backup.env}"
if [ -f "$BACKUP_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-sahabat}"
DB_NAME="${DB_NAME:-sahabat_kreator}"

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-28}"

# Ruang minimum sebelum mulai (KB). Dump DB ini ~beberapa MB, tetapi
# ruang yang habis di tengah pg_dump menghasilkan dump terpotong.
MIN_FREE_KB=$((2 * 1024 * 1024)) # 2 GB

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DOW="$(date -u +%u)" # 1=Senin … 7=Minggu

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
chmod 700 "$BACKUP_DIR"

# log / json_escape / notify tinggal di pustaka bersama: heartbeat.sh juga
# memakainya, dan bentuk body per penyedia terlalu mudah salah untuk
# disalin dua kali.
# shellcheck source=lib-notify.sh
. "$SCRIPT_DIR/lib-notify.sh"

# Pencatatan hasil eksekusi ke DB (migrasi 0011) supaya Panel Admin bisa
# menunjukkan kapan backup terakhir benar-benar berjalan — bukan sekadar
# "cron terpasang". Fungsinya sengaja tidak pernah menggagalkan backup.
# shellcheck source=record-backup-run.sh
. "$SCRIPT_DIR/record-backup-run.sh"

BACKUP_RUN_RECORDED=0

fail() {
  log "GAGAL: $*"
  notify "Backup Sahabat Kreator GAGAL: $*" || true
  exit 1
}

# --- 0. Mode uji notifikasi -------------------------------------------------
#
# Menguji jalur notifikasi tanpa menunggu backup benar-benar gagal, dan
# tanpa menyentuh database:
#   ALERT_WEBHOOK_URL=... ./backup-db.sh --test-notify
# URL webhook TIDAK dicetak: di Slack/Discord URL itu sendiri adalah
# rahasia (siapa pun yang memegangnya bisa menulis ke kanal tersebut).
if [ "${1:-}" = "--test-notify" ]; then
  if [ -z "${ALERT_WEBHOOK_URL:-}" ]; then
    log "GAGAL: ALERT_WEBHOOK_URL kosong — tidak ada yang bisa diuji"
    exit 2
  fi
  # Pesan uji sengaja memuat karakter yang biasanya merusak JSON dan
  # encoding URL: kutip ganda, backslash, ampersand, plus. Kalau pesan ini
  # sampai utuh, pesan sungguhan juga akan sampai.
  log "mengirim notifikasi uji…"
  if notify "Uji notifikasi Sahabat Kreator — \"kutip\" \\ backslash & plus + tanda=tanya?"; then
    log "notifikasi uji TERKIRIM — cek kanal tujuan"
    exit 0
  fi
  log "GAGAL: notifikasi tidak terkirim (periksa URL/izin webhook)"
  exit 1
fi

# --- 1. Pagar ruang disk ----------------------------------------------------
#
# EXIT trap: apapun yang menghentikan skrip sebelum baris sukses dicatat
# (disk penuh, pg_dump gagal, dump tak terbaca) meninggalkan SATU baris
# "failed". Tanpa ini kegagalan justru TIDAK terlihat di panel: yang tampil
# tetap backup sukses kemarin, seolah semuanya baik-baik saja.
record_backup_exit() {
  local code=$?
  if [ "$BACKUP_RUN_RECORDED" -eq 0 ]; then
    record_backup_run daily failed "" "exit=${code}" || true
  fi
}
trap record_backup_exit EXIT

free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
[ -n "$free_kb" ] || fail "tidak dapat membaca ruang disk"
if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
  fail "ruang disk tinggal $((free_kb / 1024)) MB (< $((MIN_FREE_KB / 1024)) MB)"
fi

# --- 2. Dump -----------------------------------------------------------------
#
# --no-privileges: GRANT/REVOKE tidak ikut. Restore ke cluster lain (atau ke
#   database uji) akan gagal pada GRANT ke role yang tidak ada di sana, dan
#   role aplikasi `sk_app` memang dibuat ulang oleh migrasi 0002 — bukan oleh
#   backup. Alasan lengkap: docs/PRODUCTION.md §6.
# --format=custom: terkompresi + memungkinkan pg_restore selektif.
file="$BACKUP_DIR/daily/${DB_NAME}_${STAMP}.dump"

log "mulai: $file"
if ! docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --no-privileges --format=custom --compress=6 >"$file"; then
  rm -f "$file"
  fail "pg_dump keluar dengan status tidak nol"
fi

[ -s "$file" ] || { rm -f "$file"; fail "dump kosong"; }

# --- 3. Verifikasi bahwa dump dapat dibaca ulang -----------------------------
#
# Ini pembeda antara "ada berkas" dan "ada backup". Dump terpotong tetap
# berukuran besar dan terlihat wajar sampai seseorang mencoba restore.
if ! docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_restore --list <"$file" >/dev/null 2>&1; then
  rm -f "$file"
  fail "dump tidak dapat dibaca ulang (pg_restore --list gagal)"
fi

entries="$(docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_restore --list <"$file" 2>/dev/null | grep -c 'TABLE DATA' || true)"
size="$(du -h "$file" | cut -f1)"
log "ok: $size, $entries tabel berisi data"

# Jumlah tabel yang masuk akal menahan "backup" yang isinya cuma skema.
if [ "${entries:-0}" -lt 40 ]; then
  fail "hanya $entries TABLE DATA (diharapkan >= 40) — dump mencurigakan"
fi

# --- 4. Salinan mingguan -----------------------------------------------------
if [ "$DOW" = "7" ]; then
  cp -p "$file" "$BACKUP_DIR/weekly/${DB_NAME}_${STAMP}.dump"
  log "salinan mingguan dibuat"
fi

# --- 5. Off-site (opsional) --------------------------------------------------
OFFSITE_OK=1
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  if sh -c "$BACKUP_UPLOAD_CMD" -- "$file"; then
    log "off-site: terkirim"
  else
    # Backup lokal tetap sah dan TIDAK dihapus; yang gagal hanya salinan
    # di luar VPS. Tetap ditandai gagal (exit != 0) karena kontrak skrip
    # ini adalah "backup + off-site" — setengah berhasil bukan berhasil,
    # dan tanpa exit code cron tidak punya cara memberi tahu siapa pun.
    OFFSITE_OK=0
    log "PERINGATAN: off-site gagal — salinan hanya ada di VPS ini"
    notify "Backup lokal sukses, tetapi unggahan off-site GAGAL." || true
  fi
else
  log "off-site: tidak dikonfigurasi (BACKUP_UPLOAD_CMD kosong)"
fi

# --- 6. Retensi --------------------------------------------------------------
#
# Dihitung dari mtime. Dijalankan SESUDAH backup baru sukses, sehingga
# kegagalan backup tidak pernah mengurangi jumlah salinan yang ada.
find "$BACKUP_DIR/daily" -name '*.dump' -type f -mtime "+$KEEP_DAILY" -delete
find "$BACKUP_DIR/weekly" -name '*.dump' -type f -mtime "+$KEEP_WEEKLY" -delete

kept_daily="$(find "$BACKUP_DIR/daily" -name '*.dump' -type f | wc -l)"
kept_weekly="$(find "$BACKUP_DIR/weekly" -name '*.dump' -type f | wc -l)"
log "selesai: tersimpan $kept_daily harian, $kept_weekly mingguan di $BACKUP_DIR"

size_bytes="$(stat -c %s "$file" 2>/dev/null || echo "")"

if [ "$OFFSITE_OK" = "0" ]; then
  # Kontrak skrip: setengah berhasil = gagal. Barisnya tetap mencatat
  # ukuran dump, karena salinan lokalnya memang sah dan tersimpan.
  record_backup_run daily failed "$size_bytes" "off-site gagal" || true
  BACKUP_RUN_RECORDED=1
  log "GAGAL (sebagian): backup lokal ada, salinan off-site TIDAK"
  exit 1
fi

record_backup_run daily ok "$size_bytes" "dump terverifikasi" || true
BACKUP_RUN_RECORDED=1
log "catatan eksekusi tersimpan di backup_runs"
