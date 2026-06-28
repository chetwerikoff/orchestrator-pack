# Shell wrapper: intercept ao send and log with timestamp
# Source this in the orchestrator tmux session.
# Usage: source /path/to/diag-ao-send-logger.sh
#
# DO NOT add to ~/.bashrc — source manually in the orchestrator session.

_ao_send_log="${DIAG_AO_SEND_LOG:-/tmp/ao-send-diag.log}"

_ao_real() {
  command ao "$@"
}

ao() {
  if [ "$1" = "send" ] || [ "$1" = "send-keys" ]; then
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S.%3N')
    local target="$2"
    local msg="$3"
    local rest="$*"
    printf '[%s] ao %s\ntarget=%s msg=%s\n' "$ts" "$rest" "$target" "$msg" >> "$_ao_send_log"
  fi
  _ao_real "$@"
}

export DIAG_AO_SEND_LOG="$_ao_send_log"
