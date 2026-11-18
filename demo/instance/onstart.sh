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
#
# Tiered mode (several model servers behind router.py) replaces the four
# MODEL_*/RUNTIME/LLAMA_ARGS variables. Flat variables only, because the
# Worker's env string cannot carry quotes:
#   SERVERS           e.g. "DEEP FAST"; the tier id is the lower-cased name
#                     (deep | fast). Server k listens on 127.0.0.1:808<k>
#                     (8081, 8082, ...), router.py on 8080.
#   <N>_REPO, <N>_FILES, <N>_RUNTIME, <N>_ARGS   as MODEL_REPO etc. above
#   <N>_CTX           context per slot (required); the server gets
#                     -np <N>_SLOTS -c <N>_SLOTS*<N>_CTX
#   <N>_SLOTS         parallel slots (default 1)
#   <N>_GPUS          CUDA_VISIBLE_DEVICES for this server, e.g. 0 or 1,0
#   <N>_CPUS          optional taskset core list, e.g. 0-27
#   <N>_ALIAS         model name in the streamed chunks (--alias)
#   ROUTER_POLICY     default difficulty+spill (see router.py)
#   ROUTER_DEFAULT    tier for requests without "model", default deep
#   ROUTER_JUDGE      none | fast, default none
# Each backend also gets --metrics. Status is "ready" only when every server
# and the router are healthy; each is restarted on its own after a crash.
# Optional:
#   HF_TOKEN, MODELS_DIR (default /workspace/models),
#   STARTUP_TIMEOUT (s to reach /health after download, default 1800),
#   DESTROY_ON_FAILURE=1 (destroy immediately if download/startup fails,
#   instead of waiting for the TTL or the orchestrator),
#   For local testing: LOCUS_ALLOW_NO_SELF_DESTRUCT=1 (no Vast variables),
#   LOCUS_CONTAINER_START (epoch to count the TTL from), LOCUS_STATE_DIR,
#   LOCUS_RUN_DIR, LOCUS_PORT (instead of 8080; backends follow it).
#   Logs and status go to $LOCUS_STATE_DIR (/var/lib/locus).
#
# Server defaults: 127.0.0.1:8080, -ngl 999 -np 1 --jinja (tiered: see above), plus
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
PORT=${LOCUS_PORT:-8080}
MAX_RESTARTS=5          # consecutive failed restarts before giving up (per server)
SELF=$(readlink -f "${BASH_SOURCE[0]}")
LOCUS_DIR=$(dirname "$SELF")
# GPU indices as nvidia-smi shows them (CUDA's default order is fastest first).
export CUDA_DEVICE_ORDER=PCI_BUS_ID

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
  pkill -f 'llama-server|locus/router\.py' 2>/dev/null || true
  while true; do
    # -y is required: without it vastai asks for confirmation, reads EOF in a
    # non-interactive shell, prints "Aborted." and exits 0 without destroying.
    if out=$(vastai destroy instance "$CONTAINER_ID" -y --api-key "$CONTAINER_API_KEY" 2>&1); then
      log "vastai: $out"
    else
      log "vastai destroy failed: $out"
    fi
    # Fallback: the REST call the CLI makes.
    if curl -fsS --max-time 15 -X DELETE -H "Authorization: Bearer $CONTAINER_API_KEY" \
      "https://console.vast.ai/api/v0/instances/$CONTAINER_ID/" >/dev/null 2>&1; then
      log "REST destroy accepted"
    fi
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

mkdir -p "$STATE_DIR" "$RUN_DIR"
chmod 700 "$RUN_DIR"

# One entry per model server. Single mode: one unnamed server from
# MODEL_REPO/MODEL_FILES/RUNTIME/LLAMA_ARGS on $PORT. Tiered mode: one per
# name in SERVERS on $PORT+1, +2, ..., with router.py on $PORT.
read -r -a names <<<"${SERVERS:-}"
TIERED=0
(( ${#names[@]} == 0 )) || TIERED=1

missing=()
if (( TIERED )); then
  required=(LLAMA_API_KEY CF_TUNNEL_TOKEN DEMO_TTL_SECONDS)
  for n in "${names[@]}"; do
    [[ "$n" =~ ^[A-Z][A-Z0-9]*$ ]] || { status "failed: SERVERS names must be upper-case letters/digits, got '$n'"; exit 1; }
    required+=("${n}_REPO" "${n}_FILES" "${n}_RUNTIME" "${n}_CTX")
  done
else
  required=(MODEL_REPO MODEL_FILES RUNTIME LLAMA_API_KEY CF_TUNNEL_TOKEN DEMO_TTL_SECONDS)
fi
for v in "${required[@]}"; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if [[ "${LOCUS_ALLOW_NO_SELF_DESTRUCT:-0}" != 1 ]]; then
  for v in CONTAINER_ID CONTAINER_API_KEY; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
fi
(( ${#missing[@]} == 0 )) || { status "failed: missing env ${missing[*]}"; exit 1; }
[[ "$DEMO_TTL_SECONDS" =~ ^[0-9]+$ && "$DEMO_TTL_SECONDS" -gt 0 ]] || { status "failed: DEMO_TTL_SECONDS must be a positive integer"; exit 1; }

# Per server s (index into the arrays below; single mode has s=0 only):
srv_name=() srv_repo=() srv_files=() srv_runtime=() srv_args=() srv_gpus=() srv_cpus=() srv_alias=() srv_slots=() srv_ctx=()
if (( TIERED )); then
  declare -A seen=()
  for n in "${names[@]}"; do
    tier=${n,,}
    case "$tier" in
      deep|fast) ;;
      *) status "failed: SERVERS names must be DEEP or FAST (router tiers), got '$n'"; exit 1 ;;
    esac
    [[ -z "${seen[$tier]:-}" ]] || { status "failed: SERVERS lists $n twice"; exit 1; }
    seen[$tier]=1
    v=${n}_REPO; srv_repo+=("${!v}")
    v=${n}_FILES; srv_files+=("${!v}")
    v=${n}_RUNTIME; srv_runtime+=("${!v}")
    v=${n}_ARGS; srv_args+=("${!v:-}")
    v=${n}_GPUS; srv_gpus+=("${!v:-}")
    v=${n}_CPUS; srv_cpus+=("${!v:-}")
    v=${n}_ALIAS; srv_alias+=("${!v:-}")
    v=${n}_SLOTS; srv_slots+=("${!v:-1}")
    v=${n}_CTX; srv_ctx+=("${!v}")
    srv_name+=("$tier")
  done
  ROUTER_POLICY=${ROUTER_POLICY:-difficulty+spill}
  ROUTER_DEFAULT=${ROUTER_DEFAULT:-deep}
  ROUTER_JUDGE=${ROUTER_JUDGE:-none}
  command -v python3 >/dev/null || { status "failed: python3 not found (needed for router.py)"; exit 1; }
  [[ -f "$LOCUS_DIR/router.py" ]] || { status "failed: $LOCUS_DIR/router.py not found"; exit 1; }
else
  srv_name=("") srv_repo=("$MODEL_REPO") srv_files=("$MODEL_FILES") srv_runtime=("$RUNTIME")
  srv_args=("${LLAMA_ARGS:-}") srv_gpus=("") srv_cpus=("") srv_alias=("") srv_slots=(1) srv_ctx=("")
fi
for s in "${!srv_name[@]}"; do
  label=${srv_name[s]:+${names[s]}_}
  case "${srv_runtime[s]}" in
    ik|mainline) ;;
    *) status "failed: ${label}RUNTIME must be ik or mainline, got '${srv_runtime[s]}'"; exit 1 ;;
  esac
  command -v "llama-server-${srv_runtime[s]}" >/dev/null || { status "failed: llama-server-${srv_runtime[s]} not found"; exit 1; }
  if (( TIERED )); then
    [[ "${srv_slots[s]}" =~ ^[1-9][0-9]*$ ]] || { status "failed: ${label}SLOTS must be a positive integer"; exit 1; }
    [[ "${srv_ctx[s]}" =~ ^[1-9][0-9]*$ ]] || { status "failed: ${label}CTX must be a positive integer"; exit 1; }
    [[ -z "${srv_cpus[s]}" ]] || command -v taskset >/dev/null || { status "failed: ${label}CPUS set but taskset not found"; exit 1; }
  fi
done
mkdir -p "$MODELS_DIR" || { status "failed: cannot create $MODELS_DIR"; exit 1; }

if [[ -n "${CONTAINER_ID:-}" && -n "${CONTAINER_API_KEY:-}" ]]; then
  arm_self_destruct
else
  log "WARNING: no CONTAINER_ID/CONTAINER_API_KEY, self-destruct disabled (LOCUS_ALLOW_NO_SELF_DESTRUCT=1)"
fi

TUNNEL_LOOP_PID=""
declare -A PID=()
# Stop the tunnel, the servers and the router when this script ends, so a
# failed machine drops off the tunnel instead of answering 502 forever. The
# self-destruct timer runs in its own session and is not touched.
cleanup() {
  local p
  # "|| true": under set -e a failed kill (child already gone) would end the
  # trap before the remaining children are stopped.
  [[ -z "$TUNNEL_LOOP_PID" ]] || kill "$TUNNEL_LOOP_PID" 2>/dev/null || true
  for p in "${PID[@]}"; do
    [[ -z "$p" ]] || kill "$p" 2>/dev/null || true
  done
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
# Download (one hf download per repo)
# ---------------------------------------------------------------------------

# Where a repo's files land: MODELS_DIR itself in single mode (as always), a
# subfolder per repo in tiered mode so two repos cannot collide.
repo_dir() {
  if (( TIERED )); then echo "$MODELS_DIR/${1//\//--}"; else echo "$MODELS_DIR"; fi
}

repos=()
declare -A repo_files=()
for s in "${!srv_name[@]}"; do
  r=${srv_repo[s]}
  [[ -n "${repo_files[$r]+x}" ]] || repos+=("$r")
  read -r -a files <<<"${srv_files[s]}"
  for f in "${files[@]}"; do
    [[ " ${repo_files[$r]:-} " == *" $f "* ]] || repo_files[$r]+="${repo_files[$r]:+ }$f"
  done
done

t0=$(date +%s)
for r in "${repos[@]}"; do
  read -r -a files <<<"${repo_files[$r]}"
  dir=$(repo_dir "$r")
  mkdir -p "$dir" || fail "cannot create $dir"
  status "downloading ${#files[@]} file(s) from $r"
  ok=0
  for attempt in 1 2 3; do
    if hf download "$r" "${files[@]}" --local-dir "$dir" >>"$STATE_DIR/download.log" 2>&1; then
      ok=1
      break
    fi
    log "download attempt $attempt failed (see $STATE_DIR/download.log)"
    sleep $(( attempt * 10 ))
  done
  [[ "$ok" -eq 1 ]] || fail "download failed after 3 attempts"
  for f in "${files[@]}"; do
    [[ -s "$dir/$f" ]] || fail "downloaded file missing: $f"
  done
done
log "download done in $(( $(date +%s) - t0 ))s ($(du -sh "$MODELS_DIR" | cut -f1))"

# ---------------------------------------------------------------------------
# Servers and router (supervised)
# ---------------------------------------------------------------------------

umask 077
printf '%s\n' "$LLAMA_API_KEY" >"$RUN_DIR/api-key"
umask 022

# Children, in start order. Each has a command (array CMD_<i>), a log, a port
# whose /health tells when it is up, and optional GPU/CPU pinning.
children=() c_log=() c_port=() c_gpus=() c_cpus=() c_router=()
backend_specs=()

# Split extra flags into words without eval: xargs honours single and double
# quotes (no backslash escapes inside quotes), so pass JSON in single quotes:
#   LLAMA_ARGS="-ncmoe 14 --chat-template-kwargs '{\"reasoning_effort\":\"low\"}'"
split_args() {  # split_args NAME VALUE -> fills the array named NAME
  local -n out=$1
  local split
  out=()
  if [[ -n "$2" ]]; then
    split=$(xargs -n1 printf '%s\n' <<<"$2" 2>&1) || fail "cannot parse $3: $split"
    mapfile -t out <<<"$split"
  fi
}

for s in "${!srv_name[@]}"; do
  read -r -a files <<<"${srv_files[s]}"
  dir=$(repo_dir "${srv_repo[s]}")
  model=""
  for f in "${files[@]}"; do
    if [[ "$f" == *-00001-of-*.gguf ]]; then model=$dir/$f; break; fi
  done
  model=${model:-$dir/${files[0]}}

  case "${srv_runtime[s]}" in
    ik) runtime_args=(--defer-ple) ;;
    mainline) runtime_args=(--fit off) ;;
  esac
  if (( TIERED )); then
    port=$(( PORT + 1 + s ))
    args_name=${names[s]}_ARGS
    slot_args=(-np "${srv_slots[s]}" -c "$(( srv_slots[s] * srv_ctx[s] ))")
    tier_args=(--metrics)
    [[ -z "${srv_alias[s]}" ]] || tier_args+=(--alias "${srv_alias[s]}")
    logf=$STATE_DIR/server-${srv_name[s]}.log
    backend_specs+=(--backend "${srv_name[s]}=$port:${srv_slots[s]}:${srv_ctx[s]}")
  else
    port=$PORT
    args_name=LLAMA_ARGS
    slot_args=(-np 1)
    tier_args=()
    logf=$STATE_DIR/server.log
  fi
  extra_args=()
  split_args extra_args "${srv_args[s]}" "$args_name"
  i=${#children[@]}
  declare -ga "CMD_$i=()"
  # shellcheck disable=SC2178  # a nameref to the array CMD_<i>
  declare -n cmd="CMD_$i"
  cmd=("llama-server-${srv_runtime[s]}" -m "$model"
    --host 127.0.0.1 --port "$port"
    --api-key-file "$RUN_DIR/api-key"
    -ngl 999 "${slot_args[@]}" --jinja
    "${tier_args[@]}" "${runtime_args[@]}" "${extra_args[@]}")
  unset -n cmd
  children+=("${srv_name[s]:-server}")
  c_log+=("$logf") c_port+=("$port") c_gpus+=("${srv_gpus[s]}") c_cpus+=("${srv_cpus[s]}") c_router+=(0)
done

if (( TIERED )); then
  i=${#children[@]}
  declare -ga "CMD_$i=()"
  # shellcheck disable=SC2178  # a nameref to the array CMD_<i>
  declare -n cmd="CMD_$i"
  cmd=(python3 "$LOCUS_DIR/router.py" --host 127.0.0.1 --port "$PORT"
    --key-file "$RUN_DIR/api-key" "${backend_specs[@]}"
    --policy "$ROUTER_POLICY" --default "$ROUTER_DEFAULT" --judge "$ROUTER_JUDGE"
    --log "$STATE_DIR/router.jsonl")
  unset -n cmd
  children+=(router) c_log+=("$STATE_DIR/router.log") c_port+=("$PORT") c_gpus+=("") c_cpus+=("") c_router+=(1)
fi

for i in "${!children[@]}"; do
  # shellcheck disable=SC2178  # a nameref to the array CMD_<i>
  declare -n cmd="CMD_$i"
  log "${children[i]} command:${c_gpus[i]:+ CUDA_VISIBLE_DEVICES=${c_gpus[i]}}${c_cpus[i]:+ taskset -c ${c_cpus[i]}} ${cmd[*]}"
  unset -n cmd
done

# Per child: state starting|up|down, PID, start time, consecutive failures,
# earliest restart time.
declare -A STATE=() STARTED=() FAILS=() NEXT_AT=()

child_start() {
  local i=$1
  # shellcheck disable=SC2178  # a nameref to the array CMD_<i>
  declare -n cmd="CMD_$i"
  local pre=()
  [[ -z "${c_cpus[i]}" ]] || pre=(taskset -c "${c_cpus[i]}")
  (
    [[ -z "${c_gpus[i]}" ]] || export CUDA_VISIBLE_DEVICES=${c_gpus[i]}
    exec "${pre[@]}" "${cmd[@]}"
  ) >>"${c_log[i]}" 2>&1 &
  PID[$i]=$!
  STATE[$i]=starting
  STARTED[$i]=$(date +%s)
}

# Up = /health answers 200. The router answers 503 while a backend is down,
# which still means the router itself is up.
child_healthy() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${c_port[$1]}/health")
  [[ "$code" == 200 ]] || { [[ "${c_router[$1]}" == 1 && "$code" == 503 ]]; }
}

# A start that failed (exited or timed out during startup): back off, or give up.
child_failed() {
  local i=$1 why=$2
  log "${children[i]} $why (see ${c_log[i]})"
  PID[$i]=""
  STATE[$i]=down
  if (( INITIAL )); then
    fail "${children[i]} failed to start"
  fi
  FAILS[$i]=$(( ${FAILS[$i]:-0} + 1 ))
  (( FAILS[$i] < MAX_RESTARTS )) || fail "${children[i]} failed to restart ${FAILS[$i]} times in a row"
  NEXT_AT[$i]=$(( $(date +%s) + FAILS[$i] * 10 ))
}

# One pass over all children: reap, health-check, restart. Returns quickly.
supervise() {
  local i pid rc now
  for i in "${!children[@]}"; do
    pid=${PID[$i]:-}
    now=$(date +%s)
    case "${STATE[$i]:-down}" in
      starting)
        if ! kill -0 "$pid" 2>/dev/null; then
          wait "$pid" 2>/dev/null || true
          if [[ -e "$STATE_DIR/expired" ]]; then status "expired"; exit 0; fi
          child_failed "$i" "exited during startup"
        elif child_healthy "$i"; then
          log "${children[i]} ready in $(( now - STARTED[$i] ))s"
          STATE[$i]=up
          FAILS[$i]=0
        elif (( now - STARTED[$i] >= STARTUP_TIMEOUT )); then
          kill "$pid" 2>/dev/null || true
          wait "$pid" 2>/dev/null || true
          child_failed "$i" "not healthy after ${STARTUP_TIMEOUT}s"
        fi
        ;;
      up)
        if ! kill -0 "$pid" 2>/dev/null; then
          wait "$pid" && rc=0 || rc=$?
          PID[$i]=""
          if [[ -e "$STATE_DIR/expired" ]]; then status "expired"; exit 0; fi
          log "${children[i]} exited with status $rc; restarting"
          if (( TIERED )); then
            status "restarting ${children[i]} after crash (exit $rc)"
          else
            status "restarting after crash (exit $rc)"
          fi
          STATE[$i]=down
          NEXT_AT[$i]=0
        fi
        ;;
      down)
        if (( now >= ${NEXT_AT[$i]:-0} )); then child_start "$i"; fi
        ;;
    esac
  done
  return 0
}

all_up() {
  local i
  for i in "${!children[@]}"; do
    [[ "${STATE[$i]:-}" == up ]] || return 1
  done
  # In tiered mode the router must also see every backend as healthy.
  (( ! TIERED )) || [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health")" == 200 ]]
}

if (( TIERED )); then
  status "loading models (${srv_runtime[*]})"
else
  status "loading model ($RUNTIME)"
fi
INITIAL=1
for i in "${!children[@]}"; do child_start "$i"; done
last=""
while true; do
  supervise
  if all_up; then
    INITIAL=0
    [[ "$last" == ready ]] || status "ready"
    last=ready
  else
    last=""
  fi
  sleep 2
done
