#!/usr/bin/env bash
#
# Memasang jadwal backup + uji restore + pemeriksaan kesiapan di crontab
# pengguna saat ini.
#
# Idempoten: blok milik skrip ini ditandai komentar, sehingga menjalankan
# ulang akan MENGGANTI jadwal lama, bukan menumpuknya.
#
#   backup  : setiap hari 19:30 UTC (= 02:30 WIB) — jendela paling sepi.
#             Sebelumnya 02:30 UTC (09:30 WIB), yang jatuh di jam kerja.
#   drill   : setiap Minggu 03:30 UTC — memulihkan dump terbaru ke cluster
#             Postgres yang benar-benar BARU (volume kosong, tanpa ekstensi,
#             tanpa role aplikasi), lalu membandingkan isi dan struktur
#             dengan produksi.
#   heartbeat: setiap jam :17 — memberi kabar ke layanan pemantau di luar
#             VPS, TETAPI hanya bila dump terbaru masih segar (< 36 jam).
#             Ini satu-satunya yang bisa memberi tahu saat mesinnya sendiri
#             mati; notifikasi lain dikirim dari mesin yang sama.
#   ready   : setiap 5 menit — `GET /api/ready` lewat nginx. Alarm Telegram
#             saat aplikasi berhenti melayani (2 kegagalan berturut-turut),
#             plus ketukan dead-man's switch bila READY_HEARTBEAT_URL diisi.
#
# Kenapa drill, bukan verify-backup.sh? verify-backup.sh memulihkan ke
# database uji di dalam cluster produksi, yang sudah punya ekstensi dan
# role `sk_app`. Itu berguna untuk pemeriksaan cepat secara manual, tetapi
# tidak menguji skenario yang sebenarnya: mesin hilang. Drill memakai
# container sekali pakai sehingga setara dengan memulihkan di VPS baru.
#
# Log: ~/backups/sahabat-kreator/backup.log dan drill.log
#
# Hapus jadwal:  crontab -e  lalu hapus blok bertanda
#                # >>> sahabat-kreator backup >>>
#                # <<< sahabat-kreator backup <<<

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"

chmod +x "$SCRIPT_DIR"/backup-db.sh "$SCRIPT_DIR"/verify-backup.sh \
  "$SCRIPT_DIR"/verify-backup-fresh-cluster.sh "$SCRIPT_DIR"/restore-db.sh \
  "$SCRIPT_DIR"/heartbeat.sh "$SCRIPT_DIR"/check-ready.sh
mkdir -p "$BACKUP_DIR"

BEGIN="# >>> sahabat-kreator backup >>>"
END="# <<< sahabat-kreator backup <<<"

current="$(crontab -l 2>/dev/null || true)"

# Buang blok lama (bila ada), lalu susun ulang.
filtered="$(printf '%s\n' "$current" | sed "/^${BEGIN}$/,/^${END}$/d")"

block="$BEGIN
# Backup harian Postgres (dump custom + verifikasi baca ulang). 19:30 UTC = 02:30 WIB.
30 19 * * * cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/backup-db.sh >> $BACKUP_DIR/backup.log 2>&1
# Drill mingguan: pulihkan dump ke cluster Postgres baru dan bandingkan dengan produksi.
30 3 * * 0 cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/verify-backup-fresh-cluster.sh >> $BACKUP_DIR/drill.log 2>&1
# Heartbeat tiap jam: ping layanan pemantau HANYA bila dump terbaru masih segar.
17 * * * * cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/heartbeat.sh >> $BACKUP_DIR/heartbeat.log 2>&1
# Kesiapan aplikasi tiap 5 menit: alarm Telegram bila /api/ready tidak 200.
*/5 * * * * cd $DEPLOY_DIR && PATH=/usr/local/bin:/usr/bin:/bin $SCRIPT_DIR/check-ready.sh >> $BACKUP_DIR/ready.log 2>&1
$END"

printf '%s\n%s\n' "$filtered" "$block" | sed '/^$/N;/^\n$/D' | crontab -

echo "Jadwal terpasang:"
crontab -l | sed -n "/^${BEGIN}$/,/^${END}$/p"
echo
echo "Log backup : $BACKUP_DIR/backup.log"
echo "Log drill  : $BACKUP_DIR/drill.log"
echo "Log detak  : $BACKUP_DIR/heartbeat.log"
echo "Log siap   : $BACKUP_DIR/ready.log"
