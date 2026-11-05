#!/usr/bin/env bash
#
# DRILL BENCANA — memulihkan dump ke cluster Postgres yang benar-benar BARU.
#
# `verify-backup.sh` memulihkan ke database uji di dalam cluster produksi.
# Itu membuktikan dump dapat dibaca, tetapi TIDAK membuktikan hal yang
# paling penting saat bencana: apakah dump cukup untuk menghidupkan ulang
# sistem di mesin yang tidak punya apa pun.
#
# Bedanya nyata. Di cluster produksi sudah ada:
#   - role aplikasi `sk_app`  (dibuat migrasi 0002, BUKAN oleh dump)
#   - ekstensi `vector` dan `btree_gist` (dipasang saat provisioning)
#   - template, tablespace, dan setelan yang sudah "benar"
# Cluster perawan tidak punya satu pun dari itu.
#
# Skrip ini menyalakan container Postgres sekali pakai dengan volume
# kosong, memulihkan dump ke sana, lalu membandingkan isi dan strukturnya
# dengan produksi. Container dan volumenya dihapus lagi di akhir.
#
# Pemakaian:
#   ./verify-backup-fresh-cluster.sh                  # dump harian terbaru
#   ./verify-backup-fresh-cluster.sh /path/file.dump  # dump tertentu
#
# Keluar != 0 bila ada selisih.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-sahabat}"
DB_NAME="${DB_NAME:-sahabat_kreator}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"

# Harus sama dengan image layanan `db` di docker-compose.prod.yml. Kalau
# berbeda, drill ini menguji Postgres yang tidak dipakai produksi.
DRILL_IMAGE="${DRILL_IMAGE:-pgvector/pgvector:pg16}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DRILL="sk-restore-drill-$STAMP"
DRILL_VOL="sk-restore-drill-vol-$STAMP"
DRILL_PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"

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
log "drill: $DUMP ($(du -h "$DUMP" | cut -f1))"

psql_prod() {
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}
psql_drill() {
  docker exec -i "$DRILL" \
    psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}

cleanup() {
  docker rm -f "$DRILL" >/dev/null 2>&1 || true
  docker volume rm "$DRILL_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 1. Cluster perawan ------------------------------------------------------
#
# --network none: pg_restore memakai socket lokal di dalam container, jadi
# tidak ada alasan container ini menyentuh jaringan sama sekali.
log "menyalakan cluster perawan ($DRILL_IMAGE)"
docker volume create "$DRILL_VOL" >/dev/null
docker run -d --name "$DRILL" --network none \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DRILL_PW" \
  -e POSTGRES_DB="$DB_NAME" \
  -v "$DRILL_VOL":/var/lib/postgresql/data \
  "$DRILL_IMAGE" >/dev/null

# Jangan pakai pg_isready saja. Pada volume kosong, entrypoint resmi
# menjalankan server SEMENTARA untuk initdb dan skrip init, lalu mematikannya
# dan menyalakan server final. pg_isready bisa lolos pada server sementara
# itu, sehingga pemeriksaan berikutnya menabrak socket yang sudah hilang.
# Karena itu: minta satu kueri sungguhan berhasil, jeda, lalu minta lagi —
# dua keberhasilan berurutan menandakan server final sudah stabil.
ready=""
for _ in $(seq 1 90); do
  if docker exec "$DRILL" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then
    sleep 2
    if docker exec "$DRILL" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then
      ready=1
      break
    fi
  fi
  sleep 1
done
[ -n "$ready" ] || { docker logs --tail 30 "$DRILL" 2>&1 || true; die "cluster drill tidak siap dalam ~3 menit"; }
log "cluster perawan siap"

# Bukti bahwa titik awalnya memang kosong — tanpa ini, "restore berhasil"
# bisa berarti "restore ke tempat yang sudah ada isinya".
ext_awal="$(psql_drill "select coalesce(string_agg(extname, ',' order by extname), '-') from pg_extension where extname <> 'plpgsql'")"
tbl_awal="$(psql_drill "select count(*) from pg_tables where schemaname='public'")"
log "titik awal: $tbl_awal tabel, ekstensi non-bawaan: $ext_awal"
[ "$tbl_awal" = "0" ] || die "cluster drill tidak kosong ($tbl_awal tabel) — drill tidak sah"

# --- 2. Restore --------------------------------------------------------------
log "memulihkan dump ke cluster perawan…"
if ! docker exec -i "$DRILL" \
  pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges --exit-on-error \
  <"$DUMP" 2>/tmp/sk-drill-restore.err; then
  log "--- stderr pg_restore ---"
  tail -20 /tmp/sk-drill-restore.err
  die "pg_restore gagal di cluster perawan"
fi
log "restore selesai"

# --- 3. Ekstensi yang dihidupkan ulang oleh dump -----------------------------
#
# Kalau dump tidak membawa CREATE EXTENSION, restore "sukses" tetapi tabel
# dengan kolom vector akan gagal dibuat — atau lebih buruk, dibuat tanpa
# index vector sehingga pencarian kemiripan menjadi pemindaian penuh.
ext_akhir="$(psql_drill "select coalesce(string_agg(extname, ',' order by extname), '-') from pg_extension where extname <> 'plpgsql'")"
log "ekstensi setelah restore: $ext_akhir"
for need in vector btree_gist; do
  psql_drill "select 1 from pg_extension where extname='$need'" | grep -q 1 \
    || die "ekstensi '$need' tidak ikut dipulihkan"
done

# --- 4. Jumlah baris per tabel -----------------------------------------------
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
psql_prod "$COUNTS_Q" >/tmp/sk-drill-prod-counts.txt
psql_drill "$COUNTS_Q" >/tmp/sk-drill-fresh-counts.txt

total_prod="$(awk -F'|' '{s+=$2} END {print s+0}' /tmp/sk-drill-prod-counts.txt)"
total_fresh="$(awk -F'|' '{s+=$2} END {print s+0}' /tmp/sk-drill-fresh-counts.txt)"

if diff -u /tmp/sk-drill-prod-counts.txt /tmp/sk-drill-fresh-counts.txt >/tmp/sk-drill-counts.diff; then
  log "baris: IDENTIK ($total_prod baris di $(printf '%s\n' "$tables" | wc -l) tabel)"
else
  log "--- selisih jumlah baris (kiri=produksi, kanan=cluster perawan) ---"
  head -40 /tmp/sk-drill-counts.diff
  die "jumlah baris TIDAK identik"
fi

# --- 5. Sidik jari isi tabel kecil -------------------------------------------
#
# Jumlah baris yang sama belum berarti isi yang sama. Untuk tabel yang
# cukup kecil, bandingkan md5 dari seluruh barisnya yang diurutkan — ini
# membuktikan isinya benar-benar identik, bukan sekadar sama banyak.
# Batas 50.000 baris menjaga drill tetap cepat; di atas itu, jumlah baris
# adalah pemeriksaan yang wajar.
LIMIT_ROWS=50000

build_digests() {
  local q=""
  while IFS='|' read -r t n; do
    [ -n "$t" ] || continue
    [ "${n:-0}" -gt 0 ] || continue
    [ "${n:-0}" -le "$LIMIT_ROWS" ] || continue
    q+="select '$t' as tbl, md5(coalesce(string_agg(x, E'\n' order by x), '')) as h from (select t::text as x from public.\"$t\" t) s union all "
  done <<<"$(paste -d'|' <(cut -d'|' -f1 /tmp/sk-drill-prod-counts.txt) <(cut -d'|' -f2 /tmp/sk-drill-prod-counts.txt))"
  printf '%s' "${q% union all } order by tbl"
}

DIGEST_Q="$(build_digests)"
if [ -n "$DIGEST_Q" ]; then
  psql_prod "$DIGEST_Q" >/tmp/sk-drill-prod-digest.txt
  psql_drill "$DIGEST_Q" >/tmp/sk-drill-fresh-digest.txt
  if diff -u /tmp/sk-drill-prod-digest.txt /tmp/sk-drill-fresh-digest.txt >/tmp/sk-drill-digest.diff; then
    n_dig="$(grep -c . /tmp/sk-drill-prod-digest.txt || true)"
    log "isi: IDENTIK ($n_dig tabel disidik jari md5)"
  else
    log "--- selisih sidik jari isi (kiri=produksi, kanan=cluster perawan) ---"
    head -40 /tmp/sk-drill-digest.diff
    die "isi tabel TIDAK identik"
  fi
else
  log "isi: tidak ada tabel berisi data — pemeriksaan isi dilewati"
fi

# --- 6. Struktur -------------------------------------------------------------
struct_q() {
  printf "%s" "select
    (select count(*) from pg_tables where schemaname='public') || '|' ||
    (select count(*) from pg_indexes where schemaname='public') || '|' ||
    (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public') || '|' ||
    (select count(*) from pg_policies where schemaname='public') || '|' ||
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relrowsecurity)"
}

prod_struct="$(psql_prod "$(struct_q)")"
fresh_struct="$(psql_drill "$(struct_q)")"

IFS='|' read -r p_tbl p_idx p_con p_pol p_rls <<<"$prod_struct"
IFS='|' read -r f_tbl f_idx f_con f_pol f_rls <<<"$fresh_struct"

log "struktur produksi     : tabel=$p_tbl index=$p_idx constraint=$p_con policy=$p_pol rls_aktif=$p_rls"
log "struktur cluster baru : tabel=$f_tbl index=$f_idx constraint=$f_con policy=$f_pol rls_aktif=$f_rls"

[ "$p_tbl" = "$f_tbl" ] || die "jumlah tabel berbeda"
[ "$p_idx" = "$f_idx" ] || die "jumlah index berbeda"
[ "$p_con" = "$f_con" ] || die "jumlah constraint berbeda"
[ "$p_pol" = "$f_pol" ] || die "jumlah policy RLS berbeda — restore kehilangan isolasi tenant"

# Policy yang ada di atas tabel dengan RLS dimatikan tidak melakukan apa pun.
# Hitungan policy bisa cocok sempurna sementara isolasi tenant sebenarnya
# tidak berlaku — jadi jumlah tabel ber-RLS aktif dibandingkan terpisah.
[ "$p_rls" = "$f_rls" ] || die "jumlah tabel dengan RLS aktif berbeda — isolasi tenant tidak utuh"

# Constraint exclusion pada bookings (migrasi 0003) pernah hilang tanpa
# ketahuan karena migrasinya tidak tercatat di _journal.json. Periksa
# namanya, bukan hanya jumlahnya — kode menangkap pelanggaran lewat
# SQLSTATE 23P01 atau nama `bookings_no_overlap_confirmed`
# (lihat isExclusionViolation() di packages/core/src/appointments.ts),
# jadi nama itu bagian dari kontrak, bukan sekadar label.
psql_drill "select 1 from pg_constraint where conname='bookings_no_overlap_confirmed' and contype='x'" | grep -q 1 \
  || die "constraint exclusion 'bookings_no_overlap_confirmed' tidak ikut dipulihkan"

# --- 7. Yang TIDAK dibawa dump -----------------------------------------------
#
# Role `sk_app` hidup di level cluster, bukan di dalam database, sehingga
# tidak pernah ikut pg_dump. Restore bencana karena itu WAJIB menjalankan
# migrasi (0002 membuat role) atau `restore-db.sh` (yang membuat ulang role
# + GRANT). Dicetak agar tidak jadi kejutan saat benar-benar dipakai.
role_drill="$(psql_drill "select count(*) from pg_roles where rolname='sk_app'")"
log "role sk_app di cluster baru: $role_drill (0 = normal; dibuat migrasi 0002 / restore-db.sh)"

log "SELESAI: dump dapat menghidupkan cluster kosong dan identik dengan produksi"
