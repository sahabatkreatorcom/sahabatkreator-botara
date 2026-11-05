#!/usr/bin/env bash
#
# Unggah satu berkas dump ke Cloudflare R2, VERIFIKASI hasilnya, lalu
# pangkas arsip lama.
#
# Dipanggil oleh backup-db.sh lewat variabel BACKUP_UPLOAD_CMD:
#   BACKUP_UPLOAD_CMD='deploy/scripts/upload-backup-r2.sh "$1"'
# (backup-db.sh menjalankannya sebagai `sh -c "$CMD" -- "$file"`, jadi
#  berkas dump tiba sebagai $1.)
#
# Kenapa ada verifikasi: `rclone copy` yang selesai tanpa galat berarti
# "tidak ada galat yang dilaporkan", bukan "objeknya ada dan utuh".
# Skrip ini membandingkan ukuran objek di R2 dengan berkas lokal; kalau
# beda, keluar dengan status != 0 supaya backup-db.sh melaporkannya
# sebagai off-site GAGAL (salinan lokal tetap sah).
#
# Variabel lingkungan:
#   R2_REMOTE          default r2
#   BACKUP_R2_BUCKET   default sahabat-kreator-backup
#   BACKUP_R2_PREFIX   default db
#   KEEP_REMOTE_DAYS   default 30 (objek lebih tua dipangkas)
#   RCLONE             default rclone (atau $HOME/bin/rclone)

set -euo pipefail

FILE="${1:-}"
[ -n "$FILE" ] || {
  echo "pemakaian: $0 <berkas-dump>" >&2
  exit 2
}
[ -f "$FILE" ] || {
  echo "berkas tidak ada: $FILE" >&2
  exit 2
}

R2_REMOTE="${R2_REMOTE:-r2}"
BACKUP_R2_BUCKET="${BACKUP_R2_BUCKET:-sahabat-kreator-backup}"
BACKUP_R2_PREFIX="${BACKUP_R2_PREFIX:-db}"
KEEP_REMOTE_DAYS="${KEEP_REMOTE_DAYS:-30}"

if [ -n "${RCLONE:-}" ]; then
  :
elif command -v rclone >/dev/null 2>&1; then
  RCLONE="$(command -v rclone)"
elif [ -x "$HOME/bin/rclone" ]; then
  RCLONE="$HOME/bin/rclone"
else
  echo "rclone tidak ditemukan" >&2
  exit 3
fi

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

BASE="$(basename -- "$FILE")"
DEST="$R2_REMOTE:$BACKUP_R2_BUCKET/$BACKUP_R2_PREFIX/$BASE"
LOCAL_SIZE="$(stat -c %s -- "$FILE")"

# --- Unggah ---------------------------------------------------------------
# --s3-no-check-bucket: bucket sudah dibuat manual di dashboard; tanpa ini
# rclone mencoba HeadBucket lebih dulu dan gagal bila token tidak punya
# izin list tingkat akun.
if ! "$RCLONE" copyto --s3-no-check-bucket --retries 3 --low-level-retries 5 \
  "$FILE" "$DEST" 2>&1; then
  echo "unggah gagal: $DEST" >&2
  exit 4
fi

# --- Verifikasi ukuran ----------------------------------------------------
REMOTE_SIZE="$("$RCLONE" size --s3-no-check-bucket --json "$DEST" 2>/dev/null |
  sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
if [ -z "$REMOTE_SIZE" ]; then
  echo "objek tidak ditemukan di R2 sesudah unggah: $DEST" >&2
  exit 5
fi
if [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]; then
  echo "ukuran tidak cocok: lokal=$LOCAL_SIZE remote=$REMOTE_SIZE ($DEST)" >&2
  exit 6
fi
log "terunggah & terverifikasi: $DEST ($REMOTE_SIZE byte)"

# --- Pangkas arsip lama ---------------------------------------------------
# Retensi lokal 7/28 hari; di R2 disimpan lebih lama karena justru itu
# gunanya off-site (menutup kasus "VPS-nya hilang"). Kegagalan memangkas
# TIDAK dianggap kegagalan backup — hanya dicatat.
if [ "$KEEP_REMOTE_DAYS" -gt 0 ] 2>/dev/null; then
  "$RCLONE" delete --s3-no-check-bucket --min-age "${KEEP_REMOTE_DAYS}d" \
    "$R2_REMOTE:$BACKUP_R2_BUCKET/$BACKUP_R2_PREFIX/" 2>&1 |
    sed 's/^/pangkas: /' || log "PERINGATAN: pemangkasan arsip R2 gagal (backup tetap sah)"
fi

exit 0
