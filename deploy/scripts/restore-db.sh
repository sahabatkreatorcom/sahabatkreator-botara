#!/usr/bin/env bash
#
# PEMULIHAN — mengembalikan dump ke database produksi.
#
# Berbeda dari verify-backup.sh (yang memulihkan ke database uji), skrip ini
# MENIMPA data produksi. Karena itu ia:
#   - menolak berjalan tanpa argumen --yes,
#   - menghentikan api/worker/realtime lebih dulu supaya tidak ada penulisan
#     di tengah pemulihan (worker menulis outbox & status pesan),
#   - membuat dump penyelamat dari kondisi SEKARANG sebelum menimpa, sehingga
#     "salah pilih berkas" masih bisa dibatalkan,
#   - memulihkan hak role aplikasi `sk_app` sesudahnya (dump dibuat dengan
#     --no-privileges, dan role tidak ikut di dalam dump).
#
# Pemakaian:
#   ./restore-db.sh /path/ke/file.dump --yes
#
# Setelah selesai, jalankan `docker compose ps` dan periksa /ready.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-sahabat}"
DB_NAME="${DB_NAME:-sahabat_kreator}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "GAGAL: $*"; exit 1; }

DUMP="${1:-}"
CONFIRM="${2:-}"

[ -n "$DUMP" ] || die "pemakaian: $0 <berkas.dump> --yes"
[ -f "$DUMP" ] || die "berkas tidak ditemukan: $DUMP"
[ "$CONFIRM" = "--yes" ] || die "ini MENIMPA database produksi. Ulangi dengan --yes bila yakin."

# Password role aplikasi dibaca dari .env — dipakai ulang setelah restore.
[ -f .env ] || die ".env tidak ditemukan di $DEPLOY_DIR"
APP_PW="$(grep '^DATABASE_URL=' .env | sed -E 's#^postgres://sk_app:([^@]*)@.*#\1#')"
[ -n "$APP_PW" ] || die "tidak dapat membaca password sk_app dari DATABASE_URL"

psql_prod() {
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}

# --- 1. Dump penyelamat dari kondisi sekarang --------------------------------
RESCUE="$HOME/backups/sahabat-kreator/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
mkdir -p "$(dirname "$RESCUE")"
umask 077
log "membuat dump penyelamat: $RESCUE"
docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-privileges --format=custom \
  >"$RESCUE" || die "gagal membuat dump penyelamat — pemulihan dibatalkan"
[ -s "$RESCUE" ] || die "dump penyelamat kosong — pemulihan dibatalkan"

# --- 2. Hentikan penulis -----------------------------------------------------
log "menghentikan api, worker, realtime"
docker compose -f "$COMPOSE_FILE" stop api worker realtime

# --- 3. Pulihkan -------------------------------------------------------------
# Database dibuat ulang, bukan ditimpa dengan --clean: skema sisa rilis yang
# lebih baru tidak boleh bertahan di bawah data rilis lama.
log "membuat ulang database $DB_NAME"
psql_prod "drop database if exists \"$DB_NAME\" with (force)" >/dev/null
psql_prod "create database \"$DB_NAME\"" >/dev/null

log "memulihkan dump…"
docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --exit-on-error \
  <"$DUMP" || die "pg_restore gagal — DB dalam keadaan TIDAK lengkap. Dump penyelamat: $RESCUE"

# --- 4. Kembalikan hak role aplikasi ----------------------------------------
# GRANT tidak ada di dump (--no-privileges), dan role `sk_app` hidup di level
# cluster sehingga tidak ikut terhapus — tetapi haknya hilang bersama DB lama.
log "memberi ulang hak role aplikasi sk_app"
docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" \
  -c "grant usage on schema public to sk_app" \
  -c "grant select, insert, update, delete on all tables in schema public to sk_app" \
  -c "grant usage, select on all sequences in schema public to sk_app" \
  -c "alter default privileges in schema public grant select, insert, update, delete on tables to sk_app" \
  -c "alter default privileges in schema public grant usage, select on sequences to sk_app" \
  -c "alter role sk_app with login password '$APP_PW'" >/dev/null

# --- 5. Nyalakan kembali -----------------------------------------------------
log "menyalakan kembali layanan"
docker compose -f "$COMPOSE_FILE" up -d

log "SELESAI. Periksa: docker compose -f $COMPOSE_FILE ps && curl -s localhost:5180/ready"
log "Dump penyelamat kondisi sebelumnya: $RESCUE"
