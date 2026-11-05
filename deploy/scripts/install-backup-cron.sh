#!/usr/bin/env bash
#
# Memasang jadwal backup + uji restore di crontab pengguna saat ini.
#
# Idempoten: blok milik skrip ini ditandai komentar, sehingga menjalankan
# ulang akan MENGGANTI jadwal lama, bukan menumpuknya.
#
#   backup  : setiap hari 02:30 UTC
#   verifikasi: setiap Minggu 03:30 UTC (memulihkan dump terbaru ke DB uji
#               dan membandingkan baris + struktur dengan produksi)
#
# Log: ~/backups/sahabat-kreator/backup.log
#
# Hapus jadwal:  crontab -e  lalu hapus blok bertanda
#                # >>> sahabat-kreator backup >>>
#                # <<< sahabat-kreator backup <<<

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"

chmod +x "$SCRIPT_DIR"/backup-db.sh "$SCRIPT_DIR"/verify-backup.sh "$SCRIPT_DIR"/restore-db.sh
mkdir -p "$BACKUP_DIR"

BEGIN="# >>> sahabat-kreator backup >>>"
END="# <<< sahabat-kreator backup <<<"

current="$(crontab -l 2>/dev/null || true)"

# Buang blok lama (bila ada), lalu susun ulang.
filtered="$(printf '%s\n' "$current" | sed "/^${BEGIN}$/,/^${END}$/d")"

block="$BEGIN
# Backup harian Postgres (dump custom + verifikasi baca ulang).
30 2 * * * cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/backup-db.sh >> $BACKUP_DIR/backup.log 2>&1
# Uji restore mingguan: buktikan dump benar-benar dapat dipulihkan.
30 3 * * 0 cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/verify-backup.sh >> $BACKUP_DIR/verify.log 2>&1
$END"

printf '%s\n%s\n' "$filtered" "$block" | sed '/^$/N;/^\n$/D' | crontab -

echo "Jadwal terpasang:"
crontab -l | sed -n "/^${BEGIN}$/,/^${END}$/p"
echo
echo "Log backup : $BACKUP_DIR/backup.log"
echo "Log verifikasi: $BACKUP_DIR/verify.log"
