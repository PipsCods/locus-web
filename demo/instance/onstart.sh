#!/usr/bin/env bash
# locus demo machine start script. Lives in the image at /opt/locus/onstart.sh;
# Vast's onstart field (capped at 4048 chars) only invokes it, e.g.
#   nohup /opt/locus/onstart.sh >>/var/log/locus-onstart.log 2>&1 &
#
# Contract with the backend (names are fixed):
#   MODEL_REPO        HF repo, e.g. unsloth/Qwen3.8-Flash-Next-GGUF
#   MODEL_FILES       space-separated repo paths; the model is the first
#                     "-00001-of-" shard, else the first file
#   RUNTIME           ik | mainline
#   LLAMA_ARGS        extra llama-server flags chosen after the benchmark
#                     (e.g. "-ncmoe 14 -t 32 -c 40960"); appended last, so
#                     they win over the defaults below. Quotes are honoured
#                     (put JSON values in single quotes).
#   LLAMA_API_KEY     required bearer key for the server
#   CF_TUNNEL_TOKEN   token of the per-demo remotely-managed tunnel, whose
#                     ingress points at http://localhost:8080
#   DEMO_TTL_SECONDS  hard lifetime, counted from container start; then the
#                     instance destroys itself
#   CONTAINER_ID, CONTAINER_API_KEY   injected by Vast; used for self-destruct
# Optional:
#   HF_TOKEN, MODELS_DIR (default /workspace/models),
#   STARTUP_TIMEOUT (s to reach /health after download, default 1800),
#   DESTROY_ON_FAILURE=1 (destroy immediately if download/startup fails,
#   instead of waiting for the TTL or the orchestrator),
#   For local testing: LOCUS_ALLOW_NO_SELF_DESTRUCT=1 (no Vast variables),
#   LOCUS_CONTAINER_START (epoch to count the TTL from), LOCUS_STATE_DIR,
#   LOCUS_RUN_DIR. Logs and status go to $LOCUS_STATE_DIR (/var/lib/locus).
#   LOCUS_DRY_RUN=1 checks the variables, prints the server command (one
#   word per line) and exits: no timer, tunnel, download or server, and the
#   Vast variables and runtime binaries are not required.
#
# Server defaults: 127.0.0.1:8080, -ngl 999 -np 1 --jinja, plus
#   ik:       --defer-ple (GGML_CUDA_NO_PINNED=1 via the wrapper)
#   mainline: --fit off
# matching bench.sh, so a benchmarked config is reproduced by LLAMA_ARGS.
#
# Order: self-destruct timer first (so nothing outlives the TTL, even a hung
# download), then the tunnel (so the orchestrator can tell "up, loading" from
# "gone"), then download, then the server under a restart loop.
# Exit status: non-zero if download or first startup fails, or if the server
# cannot be brought back after crashes. The timer keeps running either way.
set -euo pipefail

STATE_DIR=${LOCUS_STATE_DIR:-/var/lib/locus}
RUN_DIR=${LOCUS_RUN_DIR:-/run/locus}
MODELS_DIR=${MODELS_DIR:-/workspace/models}
STARTUP_TIMEOUT=${STARTUP_TIMEOUT:-1800}
PORT=8080
MAX_RESTARTS=5          # consecutive failed restarts before giving up
SELF=$(readlink -f "${BASH_SOURCE[0]}")

log() { printf '[%s] onstart: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
status() { echo "$1" >"$STATE_DIR/status"; log "status: $1"; }

# ---------------------------------------------------------------------------
# Self-destruct
# ---------------------------------------------------------------------------

destroy_now() {
  local out
  log "destroying instance ${CONTAINER_ID:-?}"
  # Tell the supervisor not to restart anything, then stop serving now even
  # if the destroy call itself is slow or failing.
  touch "$STATE_DIR/expired"
  pkill -f 'llama-server' 2>/dev/null || true
  while true; do
    # -y is required: without it vastai asks for confirmation, reads EOF in a
    # non-interactive shell, prints "Aborted." and exits 0 without destroying.
    if out=$(vastai destroy instance "$CONTAINER_ID" -y --api-key "$CONTAINER_API_KEY" 2>&1); then
      log "vastai: $out"
    else
      log "vastai destroy failed: $out"
    fi
    # Fallback: the REST call the CLI makes.
    curl -fsS -X DELETE -H "Authorization: Bearer $CONTAINER_API_KEY" \
      "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/" >/dev/null 2>&1 \
      && log "REST destroy accepted"
    # If either worked, the container is torn down around us; otherwise retry.
    sleep 30
  done
}

if [[ "${1:-}" == --self-destruct-at ]]; then
  deadline=${2:?}
  echo $$ >"$RUN_DIR/self-destruct.pid"
  log "self-destruct armed for $(date -u -d "@$deadline" +%FT%TZ)"
  while (( $(date +%s) < deadline )); do
    sleep $(( deadline - $(date +%s) > 60 ? 60 : 1 ))
  done
  destroy_now
fi

# Epoch seconds when the container started: start time of PID 1.
container_start() {
  local btime ticks hz
  if [[ -n "${LOCUS_CONTAINER_START:-}" ]]; then
    echo "$LOCUS_CONTAINER_START"
    return
  fi
  btime=$(awk '/^btime/ { print $2 }' /proc/stat)
  # Field 22 of /proc/1/stat; the command name (field 2) may contain spaces,
  # so count from after the closing parenthesis.
  ticks=$(sed 's/^.*) //' /proc/1/stat | awk '{ print $20 }')
  hz=$(getconf CLK_TCK)
  if [[ "$btime" =~ ^[0-9]+$ && "$ticks" =~ ^[0-9]+$ && "$hz" =~ ^[0-9]+$ ]]; then
    echo $(( btime + ticks / hz ))
  else
    date +%s
  fi
}

arm_self_destruct() {
  local deadline pid
  if [[ -s "$STATE_DIR/deadline" ]]; then
    deadline=$(cat "$STATE_DIR/deadline")   # never extended by a re-run
  else
    deadline=$(( $(container_start) + DEMO_TTL_SECONDS ))
    echo "$deadline" >"$STATE_DIR/deadline"
  fi
  if [[ -s "$RUN_DIR/self-destruct.pid" ]] && pid=$(cat "$RUN_DIR/self-destruct.pid") && kill -0 "$pid" 2>/dev/null; then
    log "self-destruct already running (pid $pid)"
    return
  fi
  if (( deadline <= $(date +%s) )); then
    log "TTL already expired"
    destroy_now
  fi
  # Own session, so it survives this script failing or being killed.
  setsid nohup bash "$SELF" --self-destruct-at "$deadline" >>"$STATE_DIR/self-destruct.log" 2>&1 </dev/null &
  log "self-destruct at $(date -u -d "@$deadline" +%FT%TZ) ($(( deadline - $(date +%s) ))s left)"
}

fail() {
  status "failed: $*"
  if [[ "${DESTROY_ON_FAILURE:-0}" == 1 && -n "${CONTAINER_ID:-}" && -n "${CONTAINER_API_KEY:-}" ]]; then
    destroy_now
  fi
  exit 1
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

DRY_RUN=${LOCUS_DRY_RUN:-0}
mkdir -p "$STATE_DIR" "$RUN_DIR"
chmod 700 "$RUN_DIR"

missing=()
for v in MODEL_REPO MODEL_FILES RUNTIME LLAMA_API_KEY CF_TUNNEL_TOKEN DEMO_TTL_SECONDS; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if [[ "${LOCUS_ALLOW_NO_SELF_DESTRUCT:-0}" != 1 && "$DRY_RUN" != 1 ]]; then
  for v in CONTAINER_ID CONTAINER_API_KEY; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
fi
(( ${#missing[@]} == 0 )) || { status "failed: missing env ${missing[*]}"; exit 1; }
[[ "$DEMO_TTL_SECONDS" =~ ^[0-9]+$ && "$DEMO_TTL_SECONDS" -gt 0 ]] || { status "failed: DEMO_TTL_SECONDS must be a positive integer"; exit 1; }
case "$RUNTIME" in
  ik|mainline) ;;
  *) status "failed: RUNTIME must be ik or mainline, got '$RUNTIME'"; exit 1 ;;
esac
if ! command -v "llama-server-$RUNTIME" >/dev/null; then
  [[ "$DRY_RUN" == 1 ]] || { status "failed: llama-server-$RUNTIME not found"; exit 1; }
  log "dry run: llama-server-$RUNTIME not found (ignored)"
fi

# Split LLAMA_ARGS into words without eval: xargs honours single and double
# quotes (no backslash escapes inside quotes), so pass JSON in single quotes:
#   LLAMA_ARGS="-ncmoe 14 --chat-template-kwargs '{\"reasoning_effort\":\"low\"}'"
extra_args=()
if [[ -n "${LLAMA_ARGS:-}" ]]; then
  split=$(xargs -n1 printf '%s\n' <<<"$LLAMA_ARGS" 2>&1) || { status "failed: cannot parse LLAMA_ARGS: $split"; exit 1; }
  mapfile -t extra_args <<<"$split"
fi

read -r -a files <<<"$MODEL_FILES"
model=""
for f in "${files[@]}"; do
  if [[ "$f" == *-00001-of-*.gguf ]]; then model=$MODELS_DIR/$f; break; fi
done
model=${model:-$MODELS_DIR/${files[0]}}

case "$RUNTIME" in
  ik) runtime_args=(--defer-ple) ;;
  mainline) runtime_args=(--fit off) ;;
esac
server_cmd=("llama-server-$RUNTIME" -m "$model"
  --host 127.0.0.1 --port "$PORT"
  --api-key-file "$RUN_DIR/api-key"
  -ngl 999 -np 1 --jinja
  "${runtime_args[@]}" "${extra_args[@]}")

if [[ "$DRY_RUN" == 1 ]]; then
  printf '%s\n' "${server_cmd[@]}"
  exit 0
fi
mkdir -p "$MODELS_DIR" || { status "failed: cannot create $MODELS_DIR"; exit 1; }

if [[ -n "${CONTAINER_ID:-}" && -n "${CONTAINER_API_KEY:-}" ]]; then
  arm_self_destruct
else
  log "WARNING: no CONTAINER_ID/CONTAINER_API_KEY, self-destruct disabled (LOCUS_ALLOW_NO_SELF_DESTRUCT=1)"
fi

TUNNEL_LOOP_PID=""
SERVER_PID=""
# Stop the tunnel and the server when this script ends, so a failed machine
# drops off the tunnel instead of answering 502 forever. The self-destruct
# timer runs in its own session and is not touched.
cleanup() {
  [[ -n "$TUNNEL_LOOP_PID" ]] && kill "$TUNNEL_LOOP_PID" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# ---------------------------------------------------------------------------
# Tunnel (supervised)
# ---------------------------------------------------------------------------

(
  # Token via env (TUNNEL_TOKEN) rather than argv, so it is not in `ps`.
  export TUNNEL_TOKEN=$CF_TUNNEL_TOKEN
  cf=""
  trap '[[ -n "$cf" ]] && kill "$cf" 2>/dev/null; exit 0' TERM
  while true; do
    cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20241 run &
    cf=$!
    wait "$cf" || true
    log "cloudflared exited, restarting in 5s"
    sleep 5
  done
) >>"$STATE_DIR/cloudflared.log" 2>&1 &
TUNNEL_LOOP_PID=$!
log "cloudflared started (log: $STATE_DIR/cloudflared.log)"

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

status "downloading ${#files[@]} file(s) from $MODEL_REPO"
t0=$(date +%s)
ok=0
for attempt in 1 2 3; do
  if hf download "$MODEL_REPO" "${files[@]}" --local-dir "$MODELS_DIR" >>"$STATE_DIR/download.log" 2>&1; then
    ok=1
    break
  fi
  log "download attempt $attempt failed (see $STATE_DIR/download.log)"
  sleep $(( attempt * 10 ))
done
[[ "$ok" -eq 1 ]] || fail "download failed after 3 attempts"
for f in "${files[@]}"; do
  [[ -s "$MODELS_DIR/$f" ]] || fail "downloaded file missing: $f"
done
log "download done in $(( $(date +%s) - t0 ))s ($(du -sh "$MODELS_DIR" | cut -f1))"

# ---------------------------------------------------------------------------
# Server (supervised)
# ---------------------------------------------------------------------------

umask 077
printf '%s\n' "$LLAMA_API_KEY" >"$RUN_DIR/api-key"
umask 022

log "server command: ${server_cmd[*]}"

# start_and_wait -> 0 when /health answers 200, 1 if the process exits or times out.
start_and_wait() {
  local t0 deadline
  t0=$(date +%s)
  deadline=$(( t0 + STARTUP_TIMEOUT ))
  "${server_cmd[@]}" >>"$STATE_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  while (( $(date +%s) < deadline )); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID" 2>/dev/null || true
      log "server exited during startup (see $STATE_DIR/server.log)"
      return 1
    fi
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")" == 200 ]]; then
      log "server ready in $(( $(date +%s) - t0 ))s"
      return 0
    fi
    sleep 2
  done
  log "server not healthy after ${STARTUP_TIMEOUT}s"
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  return 1
}

status "loading model ($RUNTIME)"
start_and_wait || fail "server failed to start"
status "ready"

failures=0
while true; do
  wait "$SERVER_PID" && rc=0 || rc=$?
  if [[ -e "$STATE_DIR/expired" ]]; then
    status "expired"
    exit 0
  fi
  log "server exited with status $rc; restarting"
  status "restarting after crash (exit $rc)"
  if start_and_wait; then
    failures=0
    status "ready"
  else
    failures=$(( failures + 1 ))
    (( failures < MAX_RESTARTS )) || fail "server failed to restart $failures times in a row"
    sleep $(( failures * 10 ))
  fi
done
