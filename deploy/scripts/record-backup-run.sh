#!/usr/bin/env bash
#
# Pustaka bersama untuk mencatat SATU eksekusi backup/drill ke tabel
# `backup_runs` (migrasi 0011). Dipakai backup-db.sh dan
# verify-backup-fresh-cluster.sh lewat `source`, bukan sebagai proses
# terpisah, supaya keduanya mewarisi COMPOSE_FILE/DB_SERVICE/DB_USER/DB_NAME
# yang sama dan tidak ada salinan yang menyimpang.
#
# Kontraknya sengaja lunak: pencatatan TIDAK PERNAH menggagalkan backup.
# Kalau DB sedang mati atau tabel belum ada (migrasi belum jalan), barisnya
# tidak tercatat dan panel akan berkata "belum ada catatan" — itulah hasil
# yang jujur. Memaksa exit != 0 di sini justru akan membuat backup gagal
# gara-gara komponen yang seharusnya hanya memantau.
#
# Argumen: record_backup_run <kind> <status> <size_bytes|""> <detail>
#   kind   = daily | drill
#   status = ok | failed
#
# Nilai-nilai ini seluruhnya berasal dari skrip pemanggil (string tetap,
# angka, dan STAMP), bukan input pengguna. Tetap dibatasi panjangnya supaya
# tidak ada kejutan dari nama berkas yang aneh.

record_backup_run() {
  local kind="${1:-unknown}"
  local status="${2:-failed}"
  local size="${3:-}"
  local detail="${4:-}"
  local sql_size="NULL"

  kind="${kind:0:16}"
  status="${status:0:16}"
  detail="${detail:0:255}"
  # Satu-satunya tempat karakter khusus bisa masuk; ganti kutip tunggal
  # agar tidak keluar dari literal SQL.
  detail="${detail//\'/\'\'}"
  kind="${kind//\'/\'\'}"
  status="${status//\'/\'\'}"

  if [[ "$size" =~ ^[0-9]+$ ]]; then
    sql_size="$size"
  fi

  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 -c \
    "INSERT INTO backup_runs (kind, status, size_bytes, detail)
       VALUES ('${kind}', '${status}', ${sql_size}, '${detail}')" \
    >/dev/null 2>&1
}
