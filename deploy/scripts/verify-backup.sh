#!/usr/bin/env bash
#
# UJI RESTORE — membuktikan bahwa berkas dump benar-benar dapat dipulihkan.
#
# Backup yang belum pernah di-restore bukan backup; ia hanya berkas yang
# kebetulan bernama .dump. Skrip ini melakukan yang seharusnya:
#
#   1. membuat database uji terpisah (produksi TIDAK disentuh),
#   2. memulihkan dump ke sana,
#   3. membandingkan jumlah baris SETIAP tabel dengan produksi,
#   4. membandingkan struktur: tabel, index, constraint, policy RLS,
#   5. menghapus database uji dan melaporkan selisih.
#
# Pemakaian:
#   ./verify-backup.sh                     # dump harian terbaru
#   ./verify-backup.sh /path/ke/file.dump
#
# Keluar != 0 bila ada selisih — cocok dipakai sebagai cron mingguan atau
# langkah manual sebelum menyatakan "backup aman".

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-sahabat}"
DB_NAME="${DB_NAME:-sahabat_kreator}"
VERIFY_DB="${VERIFY_DB:-${DB_NAME}_restore_test}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "GAGAL: $*"; exit 1; }

# --- Dump yang diuji ---------------------------------------------------------
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(find "$BACKUP_DIR/daily" -name '*.dump' -type f -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$DUMP" ] || die "tidak ada dump di $BACKUP_DIR/daily — jalankan backup dulu"
fi
[ -f "$DUMP" ] || die "berkas tidak ditemukan: $DUMP"
log "menguji: $DUMP ($(du -h "$DUMP" | cut -f1))"

psql_prod() {
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}
psql_verify() {
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$DB_USER" -d "$VERIFY_DB" -tA -c "$1"
}

# --- 1. Database uji bersih --------------------------------------------------
log "menyiapkan database uji '$VERIFY_DB'"
psql_prod "drop database if exists \"$VERIFY_DB\" with (force)" >/dev/null
psql_prod "create database \"$VERIFY_DB\"" >/dev/null

cleanup() {
  psql_prod "drop database if exists \"$VERIFY_DB\" with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 2. Restore --------------------------------------------------------------
#
# --no-owner/--no-privileges: objek menjadi milik role yang menjalankan
# restore, dan GRANT tidak diputar ulang (dump memang dibuat tanpa GRANT).
# Policy RLS BUKAN privilege — ia bagian dari definisi tabel, jadi tetap
# ikut dipulihkan dan ikut diperiksa di langkah 4.
log "memulihkan dump…"
if ! docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
  pg_restore -U "$DB_USER" -d "$VERIFY_DB" --no-owner --no-privileges --exit-on-error \
  <"$DUMP" 2>/tmp/sk-restore.err; then
  log "--- stderr pg_restore ---"
  tail -20 /tmp/sk-restore.err
  die "pg_restore gagal"
fi
log "restore selesai"

# --- 3. Bandingkan jumlah baris per tabel ------------------------------------
#
# Satu kueri UNION ALL per sisi, bukan 59 kueri terpisah: hasilnya dapat
# di-diff langsung dan galatnya menunjuk tabel yang tepat.
tables="$(psql_prod "select tablename from pg_tables where schemaname='public' order by tablename")"
[ -n "$tables" ] || die "tidak ada tabel di produksi"

build_counts() {
  local q=""
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    q+="select '$t' as tbl, count(*)::text as n from public.\"$t\" union all "
  done <<<"$tables"
  printf '%s' "${q% union all } order by tbl"
}

COUNTS_Q="$(build_counts)"
psql_prod "$COUNTS_Q" >/tmp/sk-prod-counts.txt
psql_verify "$COUNTS_Q" >/tmp/sk-restore-counts.txt

total_prod="$(awk -F'|' '{s+=$2} END {print s+0}' /tmp/sk-prod-counts.txt)"
total_restore="$(awk -F'|' '{s+=$2} END {print s+0}' /tmp/sk-restore-counts.txt)"

if diff -u /tmp/sk-prod-counts.txt /tmp/sk-restore-counts.txt >/tmp/sk-counts.diff; then
  log "baris: IDENTIK ($total_prod baris di $(printf '%s\n' "$tables" | wc -l) tabel)"
else
  log "--- selisih jumlah baris (kiri=produksi, kanan=restore) ---"
  head -40 /tmp/sk-counts.diff
  die "jumlah baris TIDAK identik"
fi

# --- 4. Bandingkan struktur --------------------------------------------------
#
# Jumlah baris yang cocok di atas skema yang salah tetap berarti restore
# rusak. Empat hitungan ini menangkap kehilangan index, constraint, atau
# policy RLS — yang terakhir paling penting: dump tanpa policy berarti
# restore ke cluster baru akan berjalan TANPA isolasi tenant.
struct_q() {
  printf "%s" "select
    (select count(*) from pg_tables where schemaname='public') || '|' ||
    (select count(*) from pg_indexes where schemaname='public') || '|' ||
    (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public') || '|' ||
    (select count(*) from pg_policies where schemaname='public')"
}
prod_struct="$(psql_prod "$(struct_q)")"
ver_struct="$(psql_verify "$(struct_q)")"

IFS='|' read -r p_tbl p_idx p_con p_pol <<<"$prod_struct"
IFS='|' read -r v_tbl v_idx v_con v_pol <<<"$ver_struct"

log "struktur produksi : tabel=$p_tbl index=$p_idx constraint=$p_con policy=$p_pol"
log "struktur restore  : tabel=$v_tbl index=$v_idx constraint=$v_con policy=$v_pol"

[ "$p_tbl" = "$v_tbl" ] || die "jumlah tabel berbeda"
[ "$p_idx" = "$v_idx" ] || die "jumlah index berbeda"
[ "$p_con" = "$v_con" ] || die "jumlah constraint berbeda"
[ "$p_pol" = "$v_pol" ] || die "jumlah policy RLS berbeda — restore kehilangan isolasi tenant"

log "SELESAI: dump dapat dipulihkan dan identik dengan produksi"
