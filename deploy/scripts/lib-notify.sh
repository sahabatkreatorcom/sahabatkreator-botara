#!/usr/bin/env bash
#
# Pustaka bersama untuk skrip operasional: log, escape JSON, dan notifikasi
# webhook. Di-source, bukan dijalankan.
#
#   . "$SCRIPT_DIR/lib-notify.sh"
#
# Variabel yang dibaca:
#   ALERT_WEBHOOK_URL   URL webhook tujuan (Slack/Mattermost/Discord/Telegram).
#                       Kosong = notifikasi dimatikan (bukan galat).
#
# Kenapa pustaka, bukan salinan di tiap skrip: bentuk body BERGANTUNG
# penyedia, dan itu mudah salah. Slack/Mattermost menerima {"text":...},
# Discord menolak body tanpa {"content":...}, dan Telegram Bot API bukan
# JSON melainkan form-encoded. Salinan yang menyimpang sedikit saja membuat
# notifikasi hilang tanpa jejak — persis kegagalan yang tidak boleh terjadi
# pada sistem yang tugasnya memberi tahu kegagalan.

# Jangan di-source dua kali (backup-db.sh bisa memanggil skrip lain).
[ -n "${_SK_NOTIFY_LIB:-}" ] && return 0
_SK_NOTIFY_LIB=1

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Escape untuk body JSON. Isi pesan dibuat oleh skrip ini sendiri (bukan
# input pengguna), jadi cukup menangani yang memang bisa muncul: backslash,
# kutip ganda, dan baris baru.
json_escape() {
  printf '%s' "$1" |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' |
    awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# Kirim notifikasi. Mengembalikan != 0 bila pengiriman gagal, supaya pemanggil
# bisa memutuskan sendiri (mode uji berhenti, jalur backup cukup mencatat).
notify() {
  local msg="$1"
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0

  if printf '%s' "$ALERT_WEBHOOK_URL" | grep -q 'api\.telegram\.org'; then
    # chat_id harus sudah ada di URL (…/bot<token>/sendMessage?chat_id=123)
    # supaya tidak perlu variabel lingkungan kedua.
    curl -fsS -m 10 --data-urlencode "text=$msg" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || {
      log "PERINGATAN: notifikasi gagal dikirim"
      return 1
    }
    return 0
  fi

  local body
  case "$ALERT_WEBHOOK_URL" in
    *discord.com* | *discordapp.com*)
      body="{\"content\":\"$(json_escape "$msg")\"}"
      ;;
    *)
      # Slack, Mattermost, dan webhook generik.
      body="{\"text\":\"$(json_escape "$msg")\"}"
      ;;
  esac

  # --data-raw, bukan -d: `-d` memperlakukan nilai berawalan `@` sebagai
  # nama berkas.
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    --data-raw "$body" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || {
    log "PERINGATAN: notifikasi gagal dikirim"
    return 1
  }
  return 0
}
