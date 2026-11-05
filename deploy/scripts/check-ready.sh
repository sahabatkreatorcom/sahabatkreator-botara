#!/usr/bin/env bash
#
# Memeriksa kesiapan aplikasi dan memberi tahu saat TIDAK siap.
#
#   check-ready.sh                 periksa sekali (dipakai cron)
#   check-ready.sh --status        cetak status terakhir, tanpa memeriksa
#   check-ready.sh --dry-run       periksa dan cetak aksi, tanpa kirim apa pun
#   check-ready.sh --force-fail    perlakukan sebagai gagal (uji jalur alert)
#
# Flag bisa digabung: `--dry-run --force-fail` mencetak isi pesan alarm
# tanpa mengirimkannya dan tanpa mengubah state.
#
# Yang diperiksa: `GET /api/ready` LEWAT nginx (127.0.0.1:5180), bukan
# langsung ke container api. Dengan begitu satu pemeriksaan mencakup rantai
# yang benar-benar dilalui pengguna: nginx → api → Postgres + Redis. Kalau
# nginx mati, itu juga gangguan nyata, dan pemeriksaan langsung ke api tidak
# akan melihatnya.
#
# Kenapa perlu, padahal container `restart: unless-stopped`?
# Restart otomatis menangani proses yang mati, TIDAK menangani proses yang
# crash-loop, dan sama sekali tidak memberi tahu siapa pun. Sebelum skrip ini
# tidak ada satu pun alarm yang berbunyi saat aplikasi berhenti melayani —
# yang ada hanya alarm untuk backup gagal.
#
# DUA LAPIS, dan bedanya penting:
#
#   1. Alert Telegram (dari skrip ini, dijalankan cron di VPS yang sama).
#      Menangkap: container mati, crash-loop, DB/Redis tidak siap, nginx rusak.
#      TIDAK menangkap: VPS mati total — karena yang mengirim alarm ikut mati.
#
#   2. Dead-man's switch (READY_HEARTBEAT_URL, opsional).
#      Skrip ini hanya "mengetuk" layanan pemantau di luar VPS ketika
#      aplikasi SEHAT. Kalau VPS mati, ketukan berhenti dan layanan pemantau
#      yang membunyikan alarm. Inilah satu-satunya lapis yang menangkap
#      kematian total mesin. Isi dengan URL ping healthchecks.io (period
#      5 menit, grace 10 menit) — lihat docs/PRODUCTION.md §7.
#
# Ambang: 2 kegagalan berturut-turut sebelum memberi kabar, supaya satu
# blip jaringan tidak membangunkan siapa pun. Dengan cron */5 itu berarti
# alarm paling lambat ~10 menit setelah gangguan mulai. Pesan hanya dikirim
# SEKALI per insiden (saat ambang tercapai), lalu sekali lagi saat pulih.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/sahabat-kreator}"
STATE_FILE="$BACKUP_DIR/ready-state"
BODY_FILE="$BACKUP_DIR/.ready-body"

READY_URL="${READY_URL:-http://127.0.0.1:5180/api/ready}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-10}"
READY_FAIL_THRESHOLD="${READY_FAIL_THRESHOLD:-2}"

MODE="run"
FORCE_FAIL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry" ;;
    --status) MODE="status" ;;
    --force-fail) FORCE_FAIL=1 ;;
    -h | --help)
      sed -n "2,46p" "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "pemakaian: $0 [--dry-run] [--status] [--force-fail]" >&2
      exit 2
      ;;
  esac
  shift
done

# --force-fail bisa digabung dengan --dry-run untuk melihat isi pesan tanpa
# mengirim apa pun.
[ "$FORCE_FAIL" -eq 1 ] && MODE_FORCE_FAIL=1 || MODE_FORCE_FAIL=0

# Kredensial notifikasi hidup di backup.env (mode 600, tidak masuk git).
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$DEPLOY_DIR/backup.env}"
if [ -f "$BACKUP_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

# shellcheck source=lib-notify.sh
. "$SCRIPT_DIR/lib-notify.sh"

mkdir -p "$BACKUP_DIR"

read_state() {
  STATE="ok"
  COUNT=0
  if [ -r "$STATE_FILE" ]; then
    # shellcheck disable=SC2034
    read -r STATE COUNT <"$STATE_FILE" 2>/dev/null || true
    STATE="${STATE:-ok}"
    COUNT="${COUNT:-0}"
    case "$COUNT" in
      '' | *[!0-9]*) COUNT=0 ;;
    esac
  fi
}

write_state() {
  printf '%s %d\n' "$1" "$2" >"$STATE_FILE"
}

if [ "$MODE" = "status" ]; then
  read_state
  if [ "$STATE" = "fail" ]; then
    echo "status: GAGAL ($COUNT pemeriksaan berturut-turut)"
  else
    echo "status: SEHAT"
  fi
  echo "url   : $READY_URL"
  exit 0
fi

read_state

# --- pemeriksaan -----------------------------------------------------------

CODE="000"
BODY=""
if [ "$MODE_FORCE_FAIL" -eq 1 ]; then
  BODY='{"status":"simulasi-kegagalan"}'
else
  CODE="$(curl -sS -m "$READY_TIMEOUT_SECONDS" -o "$BODY_FILE" \
    -w '%{http_code}' "$READY_URL" 2>/dev/null || true)"
  CODE="${CODE:-000}"
  BODY="$(head -c 300 "$BODY_FILE" 2>/dev/null || true)"
fi

# 200 = siap. 503 = proses hidup tapi dependensi tidak siap (tetap gangguan).
if [ "$CODE" = "200" ]; then
  if [ "$STATE" = "fail" ]; then
    MSG="✅ botara.my.id SEHAT kembali.
Sebelumnya gagal $COUNT kali berturut-turut.
Waktu: $(date -u +%FT%TZ)"
    if [ "$MODE" = "dry" ]; then
      log "[dry-run] akan kirim: $MSG"
    else
      notify "$MSG" || true
      log "pulih: status kembali sehat setelah $COUNT kegagalan"
    fi
  fi

  if [ "$MODE" = "dry" ]; then
    log "[dry-run] sehat: HTTP $CODE dari $READY_URL"
  fi

  # Dry-run TIDAK mengubah state: ia hanya melaporkan apa yang akan terjadi.
  [ "$MODE" = "dry" ] || write_state ok 0

  # Dead-man's switch: ketuk HANYA saat sehat.
  if [ -n "${READY_HEARTBEAT_URL:-}" ]; then
    if [ "$MODE" = "dry" ]; then
      log "[dry-run] akan ping $READY_HEARTBEAT_URL"
    elif curl -fsS -m 10 "$READY_HEARTBEAT_URL" >/dev/null 2>&1; then
      : # senyap saat sehat: log hanya diisi ketika ada yang salah
    else
      log "PERINGATAN: ping pemantau gagal dikirim"
    fi
  fi

  exit 0
fi

# --- gagal -----------------------------------------------------------------

COUNT=$((COUNT + 1))
[ "$MODE" = "dry" ] || write_state fail "$COUNT"

SNIPPET="$(printf '%s' "$BODY" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)"
log "GAGAL ($COUNT/$READY_FAIL_THRESHOLD): HTTP $CODE dari $READY_URL ${SNIPPET:+| $SNIPPET}"

# Kirim tepat sekali per insiden: pada saat ambang tercapai.
MSG="🔴 botara.my.id TIDAK SIAP.
URL    : $READY_URL
HTTP   : $CODE
Gagal  : $COUNT kali berturut-turut
Respons: ${SNIPPET:-(kosong)}
Waktu  : $(date -u +%FT%TZ)

Cek cepat:
  docker compose -f $DEPLOY_DIR/docker-compose.prod.yml ps
  docker compose -f $DEPLOY_DIR/docker-compose.prod.yml logs --tail 50 api"

if [ "$MODE" = "dry" ]; then
  log "[dry-run] gagal $COUNT/$READY_FAIL_THRESHOLD — pesan berikut dikirim saat ambang tercapai:"
  log "$MSG"
elif [ "$COUNT" -eq "$READY_FAIL_THRESHOLD" ]; then
  notify "$MSG" || true
fi

exit 1
