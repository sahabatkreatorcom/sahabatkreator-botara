#!/usr/bin/env bash
#
# Menyelaraskan kredensial Cloudflare R2 dari Panel Admin ke konfigurasi
# rclone di host.
#
# Kenapa begini: kredensial R2 hanya punya SATU sumber kebenaran, yaitu
# Panel Admin (tabel `platform_settings`, terenkripsi). Menyalinnya manual
# ke berkas di host berarti dua salinan yang bisa berbeda diam-diam —
# rotasi kunci di panel tidak akan terlihat sampai backup off-site gagal
# tengah malam. Skrip ini menariknya dari panel saat diminta, jadi tidak
# ada nilai rahasia yang diketik tangan.
#
# Yang ditulis hanya `~/.config/rclone/rclone.conf` (mode 600). Nilai
# rahasia TIDAK PERNAH dicetak ke layar/log — hanya status keberhasilan.
#
# Dipakai:
#   deploy/scripts/sync-r2-credentials.sh          # tulis/perbarui konfigurasi
#   deploy/scripts/sync-r2-credentials.sh --check  # uji koneksi saja, tanpa tulis
#
# Wajib ada di $DEPLOY_DIR/.env:
#   R2_ACCOUNT_ID      (bukan rahasia; sama dengan di packages/config)
#
# Opsional:
#   RCLONE_CONF        default ~/.config/rclone/rclone.conf
#   COMPOSE_FILE       default docker-compose.prod.yml
#   R2_REMOTE          default r2 (nama remote di rclone.conf)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
RCLONE_CONF="${RCLONE_CONF:-$HOME/.config/rclone/rclone.conf}"
R2_REMOTE="${R2_REMOTE:-r2}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() {
  printf '%s GALAT: %s\n' "$(date -u +%FT%TZ)" "$*" >&2
  exit 1
}

if command -v rclone >/dev/null 2>&1; then
  RCLONE="$(command -v rclone)"
elif [ -x "$HOME/bin/rclone" ]; then
  RCLONE="$HOME/bin/rclone"
else
  die "rclone tidak ditemukan — pasang di \$PATH atau \$HOME/bin/rclone"
fi

# --- Ambil account id dari .env -------------------------------------------
# Dibaca dengan sed, bukan `source`, supaya nilai ber-spasi/ber-karakter
# khusus di .env tidak diinterpretasikan oleh shell.
ENV_FILE="$DEPLOY_DIR/.env"
[ -f "$ENV_FILE" ] || die "$ENV_FILE tidak ada"
env_get() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/'
}
R2_ACCOUNT_ID="$(env_get R2_ACCOUNT_ID)"
[ -n "$R2_ACCOUNT_ID" ] ||
  die "R2_ACCOUNT_ID kosong di $ENV_FILE (tambahkan baris R2_ACCOUNT_ID=...; nilainya ada di packages/config/src/index.ts)"

# --- Ambil nilai terenkripsi dari DB --------------------------------------
# Dijalankan sebagai owner tabel, jadi RLS platform_settings tidak berlaku
# di sini — sama seperti psql manual. Yang diambil tetap ciphertext.
psql_q() {
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U "${DB_USER:-sahabat}" -d "${DB_NAME:-sahabat_kreator}" -tAc "$1" |
    tr -d '\r' | sed '/^$/d'
}

ENC_ACCESS="$(psql_q "select value_encrypted from platform_settings where key = 'r2_access_key_id'")"
ENC_SECRET="$(psql_q "select value_encrypted from platform_settings where key = 'r2_secret_access_key'")"

[ -n "$ENC_ACCESS" ] ||
  die "r2_access_key_id belum diisi di Panel Admin (Pengaturan Platform → Cloudflare R2)"
[ -n "$ENC_SECRET" ] ||
  die "r2_secret_access_key belum diisi di Panel Admin (Pengaturan Platform → Cloudflare R2)"

# --- Dekripsi di dalam container api --------------------------------------
# Envelope-nya sama dengan kredensial channel: v1:<iv>:<tag>:<ciphertext>,
# AES-256-GCM, kunci = base64(PLATFORM_SETTINGS_SECRET) 32 byte. Container
# api yang memegang kunci itu, jadi dekripsi terjadi di sana dan hasilnya
# mengalir langsung ke berkas tujuan — tidak pernah lewat layar.
read -r ACCESS_KEY SECRET_KEY <<EOF
$(docker compose -f "$COMPOSE_FILE" exec -T \
  -e ENC_ACCESS="$ENC_ACCESS" -e ENC_SECRET="$ENC_SECRET" \
  api node -e '
    const { createDecipheriv } = require("node:crypto");
    const key = Buffer.from(process.env.PLATFORM_SETTINGS_SECRET || "", "base64");
    if (key.length !== 32) {
      console.error("PLATFORM_SETTINGS_SECRET tidak valid: harus base64 dari tepat 32 byte");
      process.exit(2);
    }
    function dec(stored) {
      const p = String(stored || "").trim().split(":");
      if (p.length !== 4 || p[0] !== "v1") throw new Error("envelope tidak dikenal");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(p[1], "base64url"));
      d.setAuthTag(Buffer.from(p[2], "base64url"));
      return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
    }
    process.stdout.write(dec(process.env.ENC_ACCESS) + " " + dec(process.env.ENC_SECRET) + "\n");
  ')
EOF

[ -n "${ACCESS_KEY:-}" ] && [ -n "${SECRET_KEY:-}" ] ||
  die "dekripsi gagal — cek PLATFORM_SETTINGS_SECRET di .env apakah sama dengan saat kredensial disimpan"

# --- Tulis konfigurasi rclone ---------------------------------------------
TMP_CONF="$(mktemp)"
chmod 600 "$TMP_CONF"
trap 'rm -f "$TMP_CONF"' EXIT

cat >"$TMP_CONF" <<CONF
# Dibuat otomatis oleh deploy/scripts/sync-r2-credentials.sh
# Jangan diedit tangan: kredensial berasal dari Panel Admin (terenkripsi
# di DB). Untuk memperbarui, jalankan ulang skrip ini.
[$R2_REMOTE]
type = s3
provider = Cloudflare
access_key_id = $ACCESS_KEY
secret_access_key = $SECRET_KEY
endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
region = auto
acl = private
CONF
# Sengaja TIDAK memakai `no_check_bucket = true` di sini. Opsi itu membuat
# `rclone mkdir` menjadi no-op yang tetap keluar dengan status 0 — bucket
# yang tidak pernah dibuat lalu baru ketahuan saat unggah gagal. Opsi itu
# dipakai per-perintah di upload-backup-r2.sh saja, di tempat yang memang
# butuh.

if [ "$CHECK_ONLY" = "1" ]; then
  # Uji dengan konfigurasi sementara, tanpa menyentuh yang sudah ada.
  if "$RCLONE" --config "$TMP_CONF" lsd "$R2_REMOTE:" >/dev/null 2>&1; then
    log "kredensial VALID (uji baca daftar bucket berhasil)"
  else
    die "kredensial ditolak R2 — periksa Access Key ID / Secret di Panel Admin"
  fi
  exit 0
fi

mkdir -p "$(dirname -- "$RCLONE_CONF")"
chmod 700 "$(dirname -- "$RCLONE_CONF")" 2>/dev/null || true
# Salin isi, bukan pindahkan: mktemp menghasilkan 600, dan `install` menjaga
# mode itu tanpa pernah membuat berkas tujuan dengan izin longgar.
install -m 600 "$TMP_CONF" "$RCLONE_CONF"

log "konfigurasi rclone ditulis ke $RCLONE_CONF (mode 600, remote: $R2_REMOTE)"
