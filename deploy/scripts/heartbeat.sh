#!/usr/bin/env bash
#
# Heartbeat (dead-man's switch) untuk backup.
#
# Masalah yang ditutup skrip ini: notifikasi dari backup-db.sh dikirim oleh
# MESIN YANG SAMA dengan yang diawasi. Kalau VPS-nya mati, cron berhenti,
# dan tidak ada proses yang hidup untuk mengirim apa pun — justru kejadian
# yang paling perlu diketahui. Yang bisa menutupnya hanya pengamat di luar:
# kita memberi kabar secara berkala, dan pengamat itu yang berteriak kalau
# kabar berhenti datang.
#
# Ping TIDAK dikirim hanya karena mesin hidup. Ping dikirim hanya kalau
# dump TERBARU masih segar (default < 36 jam, backup berjalan tiap 24 jam).
# Dengan begitu satu pemeriksaan menutup dua kegagalan sekaligus:
#   - mesin mati            → tidak ada ping
#   - backup diam-diam stop → dump basi → tidak ada ping
# Kalau hanya "mesin hidup" yang diperiksa, backup yang berhenti berbulan
# bulan tetap terlihat sehat.
#
# Dipanggil cron tiap jam. Konfigurasi di $DEPLOY_DIR/backup.env:
#   HEARTBEAT_URL             URL ping (mis. https://hc-ping.com/<uuid>)
#                             Kosong = heartbeat tidak aktif (bukan galat).
#   HEARTBEAT_MAX_AGE_HOURS   default 36
#
# Opsi:
#   --dry-run   cetak keputusan tanpa menghubungi apa pun
#
# Keluar != 0 bila tidak mem-ping, supaya cron menandainya gagal.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$DEPLOY_DIR/backup.env}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ -f "$BACKUP_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

# shellcheck source=lib-notify.sh
. "$SCRIPT_DIR/lib-notify.sh"

HEARTBEAT_MAX_AGE_HOURS="${HEARTBEAT_MAX_AGE_HOURS:-36}"

if [ -z "${HEARTBEAT_URL:-}" ]; then
  log "heartbeat: tidak dikonfigurasi (HEARTBEAT_URL kosong)"
  exit 0
fi

# --- 1. Cari dump terbaru ---------------------------------------------------
newest="$(find "$BACKUP_DIR/daily" -name '*.dump' -type f -printf '%T@ %p\n' 2>/dev/null |
  sort -rn | head -1 | cut -d' ' -f2-)"

if [ -z "$newest" ]; then
  log "heartbeat: TIDAK mem-ping — belum ada dump sama sekali"
  notify "Heartbeat: tidak ada dump backup sama sekali di $BACKUP_DIR/daily" || true
  exit 1
fi

# --- 2. Umur dump -----------------------------------------------------------
age_s=$(( $(date +%s) - $(stat -c %Y -- "$newest") ))
age_h=$(( age_s / 3600 ))

if [ "$age_h" -ge "$HEARTBEAT_MAX_AGE_HOURS" ]; then
  log "heartbeat: TIDAK mem-ping — dump terbaru $age_h jam (> $HEARTBEAT_MAX_AGE_HOURS jam): $newest"
  notify "Heartbeat: backup terakhir $age_h jam lalu (batas $HEARTBEAT_MAX_AGE_HOURS jam). Backup kemungkinan berhenti berjalan." || true
  exit 1
fi

# --- 3. Ping ----------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  log "heartbeat: DRY-RUN — akan ping, dump terbaru $age_h jam: $newest"
  exit 0
fi

# -f: status HTTP != 2xx dianggap gagal. Tanpa ini, ping ke URL yang sudah
# tidak berlaku (check dihapus di sisi layanan) akan terlihat sukses.
if curl -fsS -m 10 -o /dev/null "$HEARTBEAT_URL"; then
  log "heartbeat: ping terkirim (dump terbaru $age_h jam)"
  exit 0
fi

log "heartbeat: ping GAGAL dikirim ke layanan pemantau"
# Tetap beri tahu lewat webhook: kalau yang bermasalah hanya layanan
# pemantau (URL kedaluwarsa, check dihapus), Telegram masih sampai — dan
# itulah satu-satunya kanal yang bisa memberi tahu bahwa pemantauan
# sendiri sedang buta.
notify "Heartbeat: ping ke layanan pemantau GAGAL dikirim. Pemantauan otomatis kemungkinan tidak aktif." || true
exit 1
