#!/usr/bin/env bash
#
# Memasang notifikasi Telegram untuk backup: memvalidasi token bot,
# menemukan chat_id sendiri, menulis ALERT_WEBHOOK_URL ke backup.env, lalu
# mengirim pesan uji.
#
#   deploy/scripts/setup-alert-telegram.sh <BOT_TOKEN> [CHAT_ID]
#
# Tanpa CHAT_ID, skrip memanggil getUpdates dan mengambil percakapan terakhir
# yang pernah menghubungi bot itu. Syaratnya satu: bot harus sudah pernah
# dikirimi pesan (bot tidak bisa memulai percakapan). Ini langkah yang paling
# sering terlewat kalau chat_id dicari manual.
#
# Kenapa chat_id ditaruh di URL, bukan variabel kedua: notify() di
# lib-notify.sh hanya butuh satu ALERT_WEBHOOK_URL, dan Telegram menerima
# chat_id sebagai query string pada sendMessage.
#
# Token TIDAK dicetak ulang oleh skrip ini; yang ditampilkan hanya nama bot
# dan judul percakapan, supaya hasilnya bisa diperiksa tanpa membocorkan
# kredensial ke log.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$DEPLOY_DIR/backup.env}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  printf '%s GALAT: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

TOKEN="${1:-}"
CHAT_ID="${2:-}"
[ -n "$TOKEN" ] || die "pemakaian: $0 <BOT_TOKEN> [CHAT_ID]"
case "$TOKEN" in
  *:*) : ;;
  *) die "token tidak berbentuk token bot Telegram (harus memuat ':')" ;;
esac

API="https://api.telegram.org/bot$TOKEN"

# --- 1. Validasi token ------------------------------------------------------
me="$(curl -fsS -m 10 "$API/getMe" 2>/dev/null)" ||
  die "token ditolak Telegram (getMe gagal) — periksa kembali token dari @BotFather"
bot_name="$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
[ -n "$bot_name" ] || die "jawaban getMe tidak dikenali"
log "token valid: bot @$bot_name"

# --- 2. Temukan chat_id -----------------------------------------------------
chat_title=""
if [ -z "$CHAT_ID" ]; then
  updates="$(curl -fsS -m 10 "$API/getUpdates" 2>/dev/null)" || updates=""
  # Ambil chat id dari update TERAKHIR. Sed tidak bisa mengurai JSON
  # bersarang dengan benar, tetapi di sini yang dicari hanya angka id pada
  # objek "chat" — cukup untuk keperluan ini dan tanpa dependensi jq.
  CHAT_ID="$(printf '%s' "$updates" |
    grep -o '"chat":{"id":-\?[0-9]*' | tail -1 | grep -o '\-\?[0-9]*$')"
  chat_title="$(printf '%s' "$updates" |
    sed -n 's/.*"chat":{[^}]*"title":"\([^"]*\)".*/\1/p' | tail -1)"
  [ -n "$CHAT_ID" ] ||
    die "tidak menemukan chat_id — kirim dulu satu pesan apa saja ke @$bot_name, lalu jalankan ulang"
fi
log "chat_id: $CHAT_ID${chat_title:+ ($chat_title)}"

WEBHOOK_URL="$API/sendMessage?chat_id=$CHAT_ID"

# --- 3. Tulis backup.env ----------------------------------------------------
# Diperbarui di tempat bila baris ALERT_WEBHOOK_URL sudah ada, supaya
# komentar dan pengaturan lain di berkas itu tidak hilang.
touch "$BACKUP_ENV_FILE"
chmod 600 "$BACKUP_ENV_FILE"

if grep -q '^ALERT_WEBHOOK_URL=' "$BACKUP_ENV_FILE"; then
  # Pakai | sebagai pemisah: URL memuat / dan ? yang akan bentrok dengan s.
  sed -i "s|^ALERT_WEBHOOK_URL=.*|ALERT_WEBHOOK_URL='$WEBHOOK_URL'|" "$BACKUP_ENV_FILE"
else
  {
    printf '\n# Notifikasi kegagalan backup (dipasang oleh setup-alert-telegram.sh).\n'
    printf "ALERT_WEBHOOK_URL='%s'\n" "$WEBHOOK_URL"
  } >>"$BACKUP_ENV_FILE"
fi
log "ALERT_WEBHOOK_URL ditulis ke $BACKUP_ENV_FILE"

# --- 4. Kirim pesan uji -----------------------------------------------------
if curl -fsS -m 10 -o /dev/null --data-urlencode \
  "text=Pemasangan notifikasi Sahabat Kreator berhasil. Mulai sekarang kegagalan backup dikirim ke sini." \
  "$WEBHOOK_URL"; then
  log "pesan uji TERKIRIM — periksa Telegram"
else
  die "pesan uji gagal terkirim — periksa apakah bot diblokir atau chat_id salah"
fi
