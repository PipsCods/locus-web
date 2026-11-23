#!/usr/bin/env bash
# locus tiered-serving benchmark: two models on one 2-GPU box behind router.py.
#   deep = Qwen3.8-Flash-Next hybrid (ik, GPU0, experts on CPU), port base+1
#   fast = Qwen3.8-27B dense (mainline, GPU1, may spill to GPU0 with -ts), port base+2
#   router.py on the base port (default 8080)
# Runs ON the rented machine, after bench.sh (it reuses its model files and
# -ncmoe fill value). It starts and stops the servers itself (not via
# onstart.sh), runs loadgen.py (closed loop, or Poisson open loop) and records
# a sampler.sh time series next to every run.
#
# Phases (--phases, default all, in this order):
#   A1  deep alone, ik-1slot and ik-8slots, same method as bench-concurrency.sh
#   A2  fast alone: 1/4/8/16 slots, -ts spill to GPU0, KV q8_0
#   A3  both up: load one, then both at once; pinned vs unpinned CPU split;
#       VRAM reserve on GPU0 (--reserve-specs)
#   Q   quality: every task on each tier, thinking off and on (router ground truth)
#   B   through the router: policies x users x workloads, plus the task mix
#   C1  difficulty skew: hard share 0..100% (step 20) at --c1-users
#   C2  open loop: Poisson rate sweep per policy until TTFT p95 > --c2-stop-ttft
#   C3  hard-heavy burst, spill on (difficulty+spill) vs off (difficulty)
#   C4  long-document flood (the six long-doc tasks, Poisson)
#   C5  CPU/RAM-bandwidth contention: deep alone vs deep while fast is loaded,
#       unpinned vs pinned
#   C6  resilience: kill one backend mid-run (Poisson load through the router)
#   C7  router overhead: direct to each backend vs via the router, 1 and 32 users
#
# Usage: bench-tiered.sh --deep-model GGUF --deep-ncmoe N --fast-model GGUF [options]
#   --deep-model FILE      first shard of the Flash-Next quant
#   --deep-ncmoe N         -ncmoe for deep on its own GPU (bench.sh's fill value);
#                          +2 per retry (up to 3) if a config does not start
#   --deep-runtime R       default ik
#   --deep-slots N         slots in tiered phases, default 4
#   --deep-ctx N           context per slot in tiered phases, default 32768
#   --deep-extra "FLAGS"   extra deep server flags
#   --deep-gpus LIST       CUDA_VISIBLE_DEVICES for deep, default 0
#   --fast-model FILE      first shard of the 27B quant
#   --fast-runtime R       default mainline
#   --fast-slots N         default 8
#   --fast-ctx N           default 16384
#   --fast-ts "A,B"        -ts for fast, default "1,0" (all on its first GPU)
#   --fast-extra "FLAGS"   extra fast server flags
#   --fast-gpus LIST       CUDA_VISIBLE_DEVICES for fast, default "1,0"
#   --threads-deep N       default: physical cores of the slice minus --threads-fast
#   --threads-fast N       default 4
#   --pin                  pin deep and fast to separate cores (taskset) in the
#                          phases that do not compare pinning themselves
#   --reserve-specs "GB|FAST_TS|NCMOE_DELTA ..."  A3 VRAM reserve on GPU0,
#                          default "0|1,0|0 4|0.85,0.15|4 8|0.7,0.3|8" (the ts split
#                          and the -ncmoe delta are first guesses: check VRAM)
#   --users "U ..."        A users, default "1 2 4 8"
#   --fast-users "U ..."   A2 users, default "1 2 4 8 16 32"
#   --b-users "U ..."      B users, default "1 2 4 8 16"
#   --c1-users "U ..."     default "8 16"
#   --c1-policies "P ..."  default "difficulty+spill"
#   --workloads "W ..."    default "chat doc shared-doc" (B adds tasks)
#   --rounds N             requests per user per run, default 2
#   --max-tokens N         answer length for chat/doc (ignore_eos), default 256
#   --task-max-tokens N    cap for task answers, default 768 (4096 with thinking)
#   --task-rounds N        tasks per user in B/C1/C3, default 4
#   --mix SPEC             B task mix, default easy=0.5,medium=0.3,hard=0.2
#   --policies "P ..."     B policies, default "deep-only fast-only random:0.5
#                          difficulty difficulty+spill difficulty+spill@judge"
#                          (@judge adds router_judge fast)
#   --c2-policies "P ..."  default "fast-only deep-only difficulty difficulty+spill"
#   --rates "R ..."        C2 Poisson rates (req/s), default "0.25 0.5 1 2 3 4 6 8"
#   --c2-stop-ttft S       default 10
#   --c4-rates "R ..."     default "0.2 0.5 1"
#   --duration S           Poisson run length, default 120
#   --c6-kill deep|fast    backend to kill in C6, default fast
#   --c6-rate R            default 1
#   --seed N               task sampling / arrivals, default 1
#   --dph USD              Vast $/hour of the rental, for $/1M output tokens
#   --phases "P ..."       default "A1 A2 A3 Q B C1 C2 C3 C4 C5 C6 C7"
#   --port-base N          router port; deep = N+1, fast = N+2. Default 8080
#   --run-timeout S        per loadgen run, default 1800
#   --quick                small smoke pass: users "1 4", rounds 1, short runs
#   --router FILE          default router.py next to this script
#   --out DIR              default /workspace/bench/tiered-<UTC timestamp>
#   --report FILE          default prompts/sample-report.txt
#   --tasks FILE           default prompts/tiered-tasks.jsonl
#   --summarize DIR        only rebuild results.md from DIR/results.jsonl
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
A_CTX_PER_SLOT=8192   # A1/A2 as in bench-concurrency.sh, so the tables line up
DEEP_ALIAS=Qwen3.8-Flash-Next
FAST_ALIAS=Qwen3.8-27B

DEEP_MODEL="" DEEP_NCMOE="" DEEP_RT=ik DEEP_SLOTS=4 DEEP_CTX=32768 DEEP_EXTRA="" DEEP_GPUS=0
FAST_MODEL="" FAST_RT=mainline FAST_SLOTS=8 FAST_CTX=16384 FAST_TS="1,0" FAST_EXTRA="" FAST_GPUS="1,0"
THREADS_DEEP="" THREADS_FAST=4 PIN=0
RESERVE_SPECS="0|1,0|0 4|0.85,0.15|4 8|0.7,0.3|8"
USERS="1 2 4 8" FAST_USERS="1 2 4 8 16 32" B_USERS="1 2 4 8 16" C1_USERS="8 16" C1_POLICIES="difficulty+spill"
WORKLOADS="chat doc shared-doc" ROUNDS=2 MAX_TOKENS=256 TASK_MAX_TOKENS=768 TASK_MAX_TOKENS_THINK=4096 TASK_ROUNDS=4
MIX="easy=0.5,medium=0.3,hard=0.2"
POLICIES="deep-only fast-only random:0.5 difficulty difficulty+spill difficulty+spill@judge"
C2_POLICIES="fast-only deep-only difficulty difficulty+spill"
RATES="0.25 0.5 1 2 3 4 6 8" C2_STOP_TTFT=10 C4_RATES="0.2 0.5 1" DURATION=120
C6_KILL=fast C6_RATE=1 SEED=1 DPH="" PHASES="A1 A2 A3 Q B C1 C2 C3 C4 C5 C6 C7"
PORT_BASE=8080 RUN_TIMEOUT=1800
ROUTER=$SCRIPT_DIR/router.py
OUT="" SUMMARIZE=""
REPORT=$SCRIPT_DIR/prompts/sample-report.txt
TASKS=$SCRIPT_DIR/prompts/tiered-tasks.jsonl

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$OUT/run.log" >&2; }

# --quick sets smaller defaults first, so explicit options still override them
for arg in "$@"; do
  if [[ "$arg" == --quick ]]; then
    USERS="1 4" FAST_USERS="1 4 16" B_USERS="1 8" C1_USERS="8" ROUNDS=1 TASK_ROUNDS=2
    RATES="0.5 2 8" C4_RATES="0.5" DURATION=30 RESERVE_SPECS="0|1,0|0"
    POLICIES="deep-only fast-only difficulty+spill" C2_POLICIES="difficulty+spill"
  fi
done

while (($#)); do
  case "$1" in
    --deep-model) DEEP_MODEL=${2:?}; shift ;;
    --deep-ncmoe) DEEP_NCMOE=${2:?}; shift ;;
    --deep-runtime) DEEP_RT=${2:?}; shift ;;
    --deep-slots) DEEP_SLOTS=${2:?}; shift ;;
    --deep-ctx) DEEP_CTX=${2:?}; shift ;;
    --deep-extra) DEEP_EXTRA=${2?}; shift ;;
    --deep-gpus) DEEP_GPUS=${2:?}; shift ;;
    --fast-model) FAST_MODEL=${2:?}; shift ;;
    --fast-runtime) FAST_RT=${2:?}; shift ;;
    --fast-slots) FAST_SLOTS=${2:?}; shift ;;
    --fast-ctx) FAST_CTX=${2:?}; shift ;;
    --fast-ts) FAST_TS=${2:?}; shift ;;
    --fast-extra) FAST_EXTRA=${2?}; shift ;;
    --fast-gpus) FAST_GPUS=${2:?}; shift ;;
    --threads-deep) THREADS_DEEP=${2:?}; shift ;;
    --threads-fast) THREADS_FAST=${2:?}; shift ;;
    --pin) PIN=1 ;;
    --reserve-specs) RESERVE_SPECS=${2:?}; shift ;;
    --users) USERS=${2:?}; shift ;;
    --fast-users) FAST_USERS=${2:?}; shift ;;
    --b-users) B_USERS=${2:?}; shift ;;
    --c1-users) C1_USERS=${2:?}; shift ;;
    --c1-policies) C1_POLICIES=${2:?}; shift ;;
    --workloads) WORKLOADS=${2:?}; shift ;;
    --rounds) ROUNDS=${2:?}; shift ;;
    --max-tokens) MAX_TOKENS=${2:?}; shift ;;
    --task-max-tokens) TASK_MAX_TOKENS=${2:?}; shift ;;
    --task-rounds) TASK_ROUNDS=${2:?}; shift ;;
    --mix) MIX=${2:?}; shift ;;
    --policies) POLICIES=${2:?}; shift ;;
    --c2-policies) C2_POLICIES=${2:?}; shift ;;
    --rates) RATES=${2:?}; shift ;;
    --c2-stop-ttft) C2_STOP_TTFT=${2:?}; shift ;;
    --c4-rates) C4_RATES=${2:?}; shift ;;
    --duration) DURATION=${2:?}; shift ;;
    --c6-kill) C6_KILL=${2:?}; shift ;;
    --c6-rate) C6_RATE=${2:?}; shift ;;
    --seed) SEED=${2:?}; shift ;;
    --dph) DPH=${2:?}; shift ;;
    --phases) PHASES=${2:?}; shift ;;
    --port-base) PORT_BASE=${2:?}; shift ;;
    --run-timeout) RUN_TIMEOUT=${2:?}; shift ;;
    --quick) ;;
    --router) ROUTER=${2:?}; shift ;;
    --out) OUT=${2:?}; shift ;;
    --report) REPORT=${2:?}; shift ;;
    --tasks) TASKS=${2:?}; shift ;;
    --summarize) SUMMARIZE=${2:?}; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# results.md
# ---------------------------------------------------------------------------

# One table per phase: bench-concurrency.sh's columns, then tier, accuracy,
# goodput and cost columns.
summarize() {
  local dir=$1 dph phase
  dph=$(jq -r 'select(.type == "hardware") | .dph // empty' "$dir/results.jsonl" | tail -n1)
  {
    echo "<!-- generated by bench-tiered.sh from $(basename "$dir")/results.jsonl -->"
    echo
    jq -r 'select(.type == "hardware") | "Hardware: \(.gpu_count) x \(.gpu_name) (\(.gpu_mem_mib) MiB, driver \(.driver)), GPU link: \(.gpu_link) | \(.cpu_model), slice \(.slice_cpus) CPUs / \(.physical_cores) physical | \(.ram_slice_gb) GB RAM | $/h: \(.dph // "n/a")"' "$dir/results.jsonl"
    echo
    echo "Columns after \"failed\": routing policy and requested model, arrival (closed, or Poisson req/s), TTFT p99,"
    echo "inter-token latency p50, requests and mean gen t/s per tier, task accuracy (all, easy/medium/hard),"
    echo "goodput (req/s with TTFT <= 2 s and >= 10 t/s) and the share of requests within that SLO, router spills,"
    echo "and \$ per 1M output tokens at the rental price if the box ran at this load all the time."
    for phase in $(jq -r 'select(.type == "run") | .phase' "$dir/results.jsonl" | awk '!seen[$0]++'); do
      echo
      echo "## Phase $phase"
      echo
      echo "| config | ncmoe | workload | users | aggregate gen t/s | per-user gen t/s | TTFT mean s | TTFT p95 s | latency mean s | cached prompt tok | failed | policy / model | arrival | TTFT p99 s | ITL p50 ms | deep req | fast req | deep t/s | fast t/s | accuracy | acc e/m/h | goodput rps | SLO ok | spills | \$/1M tok |"
      echo "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
      jq -r --arg p "$phase" --arg dph "$dph" '
        def f: if . == null then "-" else tostring end;
        def r1: if . == null then null else (. * 10 | round / 10) end;
        select(.type == "run" and .phase == $p) | .s as $s |
        [ .config + (if .label then " " + .label else "" end), .ncmoe, $s.workload + (if $s.thinking then " +think" else "" end), $s.users,
          $s.aggregate_gen_tps, $s.per_user_gen_tps_mean, $s.ttft_mean_s, $s.ttft_p95_s, $s.latency_mean_s,
          $s.cache_hit_tokens_mean, $s.failed,
          ([($s.policy // empty), ($s.model // empty), (if $s.judge == "fast" then "judge" else empty end)] | if length == 0 then "direct" else join(" / ") end),
          (if $s.arrival == "poisson" then "poisson \($s.rate)/s" else "closed" end),
          $s.ttft_p99_s, $s.itl_p50_ms,
          $s.tiers.deep.requests, $s.tiers.fast.requests, $s.tiers.deep.gen_tps_mean, $s.tiers.fast.gen_tps_mean,
          $s.accuracy,
          (if $s.accuracy_by_label then ([$s.accuracy_by_label.easy, $s.accuracy_by_label.medium, $s.accuracy_by_label.hard] | map(f) | join("/")) else null end),
          $s.goodput_rps, $s.slo_ok_frac, .router.spills,
          (if ($dph | length) > 0 and ($s.aggregate_gen_tps // 0) > 0 then ($dph | tonumber) * 1e6 / ($s.aggregate_gen_tps * 3600) | r1 else null end)
        ] | map(f) | "| " + join(" | ") + " |"' "$dir/results.jsonl"
      if [[ "$phase" == C6 ]]; then
        echo
        jq -r 'select(.type == "run" and .phase == "C6") | "C6 \(.label): killed \(.c6.killed) at \(.c6.kill_at_s) s; requests failed after the kill: \(.c6.failed_after_kill); last failure \(.c6.last_failure_after_kill_s // "-") s after the kill; first success on the other tier \(.c6.first_ok_other_tier_after_kill_s // "-") s after the kill"' "$dir/results.jsonl"
      fi
    done
    echo
    quality_tables "$dir"
    echo
    echo "Configs that did not start:"
    jq -r 'select(.type == "start_failed") | "- \(.phase // "") \(.config): \(.reason)"' "$dir/results.jsonl"
    echo
    echo "Runs that failed or timed out:"
    jq -r 'select(.type == "run_failed") | "- \(.phase) \(.config) \(.label): \(.reason)"' "$dir/results.jsonl"
  } >"$dir/results.md"
}

# Quality calibration (Q) and router decisions (B, C1, C3) against the oracle:
# the cheapest tier (fast) that answered a task correctly, else deep.
quality_tables() {
  local dir=$1
  "${PY:-python3}" -I - "$dir" <<'PY'
import json, os, sys
d = sys.argv[1]
runs = [json.loads(l) for l in open(os.path.join(d, "results.jsonl")) if l.strip()]
runs = [r for r in runs if r.get("type") == "run" and r["s"].get("workload") == "tasks"]

def rows(r):
    try:
        return json.load(open(os.path.join(d, r["log"])))["rows"]
    except (OSError, ValueError, KeyError):
        return []

q = [r for r in runs if r["phase"] == "Q"]
if not q:
    sys.exit(0)
print("\n## Quality calibration (Q): accuracy by difficulty\n")
print("| tier | thinking | easy | medium | hard | all | scored | mean answer tokens |")
print("|---|---|---|---|---|---|---|---|")
correct = {}  # (task, tier) -> bool, thinking off
for r in q:
    rs = [x for x in rows(r) if x.get("ok") and x.get("correct") is not None]
    tier = r.get("tier")
    think = bool(r["s"].get("thinking"))
    def acc(lab):
        v = [x["correct"] for x in rs if lab is None or x["label"] == lab]
        return f"{sum(v) / len(v):.2f}" if v else "-"
    toks = [x.get("predicted_n") or 0 for x in rows(r) if x.get("ok")]
    print(f"| {tier} | {'on' if think else 'off'} | {acc('easy')} | {acc('medium')} | {acc('hard')} | {acc(None)} | {len(rs)} | {round(sum(toks) / len(toks)) if toks else '-'} |")
    if not think:
        for x in rs:
            correct[(x["task_id"], tier)] = x["correct"]
tasks = {t for t, _ in correct}
oracle = {}
for t in tasks:
    if correct.get((t, "fast")):
        oracle[t] = "fast"
    elif correct.get((t, "deep")):
        oracle[t] = "deep"
    else:
        oracle[t] = "none"
print("\nOracle (thinking off): fast %d, deep only %d, neither %d of %d tasks." % (
    sum(v == "fast" for v in oracle.values()), sum(v == "deep" for v in oracle.values()),
    sum(v == "none" for v in oracle.values()), len(oracle)))
routed = [r for r in runs if r["phase"] in ("B", "C1", "C3") and r["s"].get("model") == "auto" and not r["s"].get("thinking")]
if not routed or not oracle:
    sys.exit(0)
print("\n## Router decisions vs oracle (task runs through the router)\n")
print("| phase | run | n | oracle fast -> fast | oracle fast -> deep | oracle deep -> deep | oracle deep -> fast | neither | routing accuracy | regret |")
print("|---|---|---|---|---|---|---|---|---|---|")
for r in routed:
    rs = [x for x in rows(r) if x.get("ok") and x.get("task_id") in oracle and x.get("tier") in ("deep", "fast")]
    if not rs:
        continue
    c = {}
    for x in rs:
        k = (oracle[x["task_id"]], x["tier"])
        c[k] = c.get(k, 0) + 1
    decided = [x for x in rs if oracle[x["task_id"]] != "none"]
    right = sum(1 for x in decided if oracle[x["task_id"]] == x["tier"])
    # regret: answered wrong although the oracle tier would have been right
    regret = sum(1 for x in decided if not x.get("correct") and oracle[x["task_id"]] != x["tier"])
    print(f"| {r['phase']} | {r['config']} {r.get('label', '')} | {len(rs)} | {c.get(('fast', 'fast'), 0)} | {c.get(('fast', 'deep'), 0)} | "
          f"{c.get(('deep', 'deep'), 0)} | {c.get(('deep', 'fast'), 0)} | {sum(v for k, v in c.items() if k[0] == 'none')} | "
          f"{(right / len(decided)) if decided else 0:.2f} | {(regret / len(decided)) if decided else 0:.2f} |")
PY
}

if [[ -n "$SUMMARIZE" ]]; then summarize "$SUMMARIZE"; cat "$SUMMARIZE/results.md"; exit 0; fi

# ---------------------------------------------------------------------------
# Checks and defaults
# ---------------------------------------------------------------------------

[[ -f "$DEEP_MODEL" ]] || die "--deep-model must be an existing GGUF file"
[[ -f "$FAST_MODEL" ]] || die "--fast-model must be an existing GGUF file"
[[ "$DEEP_NCMOE" =~ ^[0-9]+$ ]] || die "--deep-ncmoe N is required"
[[ -s "$REPORT" ]] || die "report file not found: $REPORT"
[[ -s "$TASKS" ]] || die "task file not found: $TASKS"
[[ -f "$ROUTER" ]] || die "router not found: $ROUTER"
[[ "$C6_KILL" == deep || "$C6_KILL" == fast ]] || die "--c6-kill must be deep or fast"
LOADGEN=$SCRIPT_DIR/loadgen.py
grep -q -- '--arrival' "$LOADGEN" 2>/dev/null || die "$LOADGEN lacks the tiered options (--model/--policy/--arrival): apply loadgen-tiered.patch"
command -v jq >/dev/null || die "jq is required"

lscpu_field() { lscpu | awk -F: -v k="$1" '$1 == k { sub(/^[ \t]+/, "", $2); print $2; exit }'; }

# CPUs this container may use: cgroup v2 cpu.max, then v1 CFS quota, then cpuset (as bench.sh).
slice_cpus() {
  local q p
  if [[ -r /sys/fs/cgroup/cpu.max ]]; then
    read -r q p </sys/fs/cgroup/cpu.max
    if [[ "$q" != max ]]; then awk -v q="$q" -v p="$p" 'BEGIN { printf "%d quota\n", q / p }'; return; fi
  elif [[ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]]; then
    q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us); p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
    if [[ "$q" -gt 0 ]]; then awk -v q="$q" -v p="$p" 'BEGIN { printf "%d quota\n", q / p }'; return; fi
  fi
  echo "$(nproc) cpuset"
}

slice_ram_bytes() {
  local host lim=""
  host=$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo)
  if [[ -r /sys/fs/cgroup/memory.max ]]; then lim=$(cat /sys/fs/cgroup/memory.max)
  elif [[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then lim=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes); fi
  if [[ "$lim" =~ ^[0-9]+$ ]] && [[ "$lim" -lt "$host" ]]; then echo "$lim"; else echo "$host"; fi
}

read -r SLICE_CPUS SLICE_SRC < <(slice_cpus)
TPC=$(lscpu_field "Thread(s) per core"); TPC=${TPC:-1}
PHYS=$(( SLICE_CPUS / TPC )); (( PHYS >= 1 )) || PHYS=1
THREADS_ALL=$PHYS   # A1/A2: one server alone uses the whole slice, as in bench-concurrency.sh
if [[ -z "$THREADS_DEEP" ]]; then THREADS_DEEP=$(( PHYS - THREADS_FAST )); (( THREADS_DEEP >= 1 )) || THREADS_DEEP=1; fi

# Core lists for pinning: deep gets the first THREADS_DEEP physical cores the
# container may run on (with their SMT siblings), fast the next THREADS_FAST.
split_cpus() {
  local allowed
  allowed=$(awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)
  "${PY:-python3}" -I - "$allowed" "$THREADS_DEEP" "$THREADS_FAST" <<'PY'
import subprocess, sys
allowed, nd, nf = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
cpus = set()
for part in allowed.split(","):
    a, _, b = part.partition("-")
    cpus.update(range(int(a), int(b or a) + 1))
cores = {}
try:
    out = subprocess.run(["lscpu", "-p=CPU,CORE"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line and not line.startswith("#"):
            c, core = (int(x) for x in line.split(",")[:2])
            if c in cpus:
                cores.setdefault(core, []).append(c)
except (OSError, ValueError):
    cores = {c: [c] for c in cpus}
order = [cores[k] for k in sorted(cores, key=lambda k: min(cores[k]))]
fmt = lambda groups: ",".join(str(c) for g in groups for c in sorted(g))
print(fmt(order[:nd]) or "0", fmt(order[nd:nd + nf]) or fmt(order[-nf:]) or "0")
PY
}

OUT=${OUT:-/workspace/bench/tiered-$(date -u +%Y%m%d-%H%M%S)}
mkdir -p "$OUT/logs"
: >"$OUT/results.jsonl"
PY=$(command -v python3)
[[ -x /opt/venv/bin/python3 ]] && PY=/opt/venv/bin/python3
read -r PIN_DEEP_CPUS PIN_FAST_CPUS < <(split_cpus)
ROUTER_PORT=$PORT_BASE DEEP_PORT=$(( PORT_BASE + 1 )) FAST_PORT=$(( PORT_BASE + 2 ))
KEY_FILE=$OUT/api-key
( umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$KEY_FILE" )
KEY=$(cat "$KEY_FILE")
export CUDA_DEVICE_ORDER=PCI_BUS_ID

emit() { echo "$1" >>"$OUT/results.jsonl"; }

# ---------------------------------------------------------------------------
# Hardware: both GPUs, how they are linked, the CPU/RAM slice, the price
# ---------------------------------------------------------------------------

record_hardware() {
  local gpus first topo link
  gpus=$(nvidia-smi --query-gpu=index,name,memory.total,driver_version,pcie.link.gen.max,pcie.link.width.max,pci.bus_id \
         --format=csv,noheader,nounits 2>/dev/null || true)
  first=$(head -n1 <<<"$gpus")
  topo=$(nvidia-smi topo -m 2>/dev/null || true)
  # GPU0 -> GPU1 cell of the topology matrix: NV# (NVLink), PIX/PXB (PCIe switch),
  # PHB (host bridge), NODE/SYS (across NUMA nodes / sockets)
  link=$(awk '$1 == "GPU0" { print $3; exit }' <<<"$topo")
  jq -n \
    --arg cpu_model "$(lscpu_field 'Model name')" \
    --arg sockets "$(lscpu_field 'Socket(s)')" \
    --arg host_threads "$(lscpu_field 'CPU(s)')" \
    --arg numa "$(lscpu_field 'NUMA node(s)')" \
    --arg slice_cpus "$SLICE_CPUS" --arg cpu_limit_source "$SLICE_SRC" \
    --arg physical_cores "$PHYS" --arg threads_per_core "$TPC" \
    --arg ram_slice_gb "$(( $(slice_ram_bytes) / 1000000000 ))" \
    --arg ram_host_gb "$(awk '/^MemTotal:/ { printf "%d", $2 * 1024 / 1e9 }' /proc/meminfo)" \
    --arg gpu_count "$(grep -c . <<<"$gpus" || true)" \
    --arg gpu_name "$(cut -d, -f2 <<<"$first" | xargs)" \
    --arg gpu_mem_mib "$(cut -d, -f3 <<<"$first" | xargs)" \
    --arg driver "$(cut -d, -f4 <<<"$first" | xargs)" \
    --arg gpus "$gpus" \
    --arg gpu_link "${link:-?}" \
    --arg topology "$topo" \
    --arg nvlink "$(nvidia-smi nvlink -s 2>/dev/null | head -n 20 || true)" \
    --arg cuda "$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\([0-9.]*\).*/\1/p' | head -n1)" \
    --arg ik_ref "$(cut -c1-12 /opt/ik/REF 2>/dev/null || echo '?')" \
    --arg mainline_ref "$(cut -c1-12 /opt/mainline/REF 2>/dev/null || echo '?')" \
    --arg vast_instance "${CONTAINER_ID:-?}" \
    --arg dph "$DPH" \
    '$ARGS.named | .dph = (if .dph == "" then null else (.dph | tonumber) end)' >"$OUT/hardware.json"
  {
    lscpu; echo; nvidia-smi 2>/dev/null; echo; echo "$topo"; echo
    nvidia-smi -q -d CLOCK,POWER,PCIE 2>/dev/null || true; echo
    cat /proc/meminfo; echo; numactl --hardware 2>/dev/null || true
  } >"$OUT/hardware.txt" 2>&1
  emit "$(jq -c '{type: "hardware"} + .' "$OUT/hardware.json")"
  log "hardware: $(jq -r '"\(.gpu_count) x \(.gpu_name) (\(.gpu_link)) | \(.cpu_model) | slice \(.slice_cpus) CPUs, \(.physical_cores) phys | \(.ram_slice_gb) GB"' "$OUT/hardware.json")"
}

# ---------------------------------------------------------------------------
# Servers. Each backend is restarted only when its wanted config changes.
# ---------------------------------------------------------------------------

DEEP_PID="" FAST_PID="" ROUTER_PID="" SAMPLER_PID=""
DEEP_CUR="" FAST_CUR="" ROUTER_CUR=""
DEEP_JSON=null FAST_JSON=null
DEEP_N=""   # -ncmoe deep actually started with
PHASE=""

kill_wait() {  # PID: TERM, then KILL after 15 s
  local pid=$1 _
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
deep_down() { kill_wait "$DEEP_PID"; DEEP_PID="" DEEP_CUR="" DEEP_JSON=null; }
fast_down() { kill_wait "$FAST_PID"; FAST_PID="" FAST_CUR="" FAST_JSON=null; }
router_down() { kill_wait "$ROUTER_PID"; ROUTER_PID="" ROUTER_CUR=""; }
sampler_stop() { kill_wait "$SAMPLER_PID"; SAMPLER_PID=""; }

cleanup() {
  trap - EXIT INT TERM
  sampler_stop; router_down; deep_down; fast_down
  local p
  for p in $(jobs -p); do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'log "interrupted"; exit 130' INT TERM

wait_health() {  # PID PORT -> 0 when /health answers 200
  local pid=$1 port=$2 deadline
  deadline=$(( $(date +%s) + 900 ))
  while (( $(date +%s) < deadline )); do
    kill -0 "$pid" 2>/dev/null || return 1
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" == 200 ]] && return 0
    sleep 2
  done
  return 1
}

# launch NAME RUNTIME GPUS CPUS PORT ALIAS SLOTS CTX THREADS LOG FLAGS... -> PID in LAUNCHED
launch() {
  local name=$1 rt=$2 gpus=$3 cpus=$4 port=$5 alias=$6 slots=$7 ctx=$8 threads=$9 logf=${10} base
  shift 10
  case "$rt" in
    ik) base="--defer-ple --jinja" ;;
    mainline) base="--fit off --jinja" ;;
    *) die "$name: unknown runtime $rt" ;;
  esac
  local pin=()
  [[ -n "$cpus" ]] && pin=(taskset -c "$cpus")
  echo "# $(date -u +%FT%TZ) CUDA_VISIBLE_DEVICES=$gpus ${pin[*]} llama-server-$rt $* -t $threads -np $slots -c $(( ctx * slots )) --port $port $base" >>"$logf"
  # shellcheck disable=SC2086  # flag lists
  CUDA_VISIBLE_DEVICES=$gpus "${pin[@]}" "llama-server-$rt" "$@" -ngl 999 -t "$threads" -np "$slots" -c $(( ctx * slots )) \
    --host 127.0.0.1 --port "$port" --alias "$alias" --api-key-file "$KEY_FILE" --metrics $base >>"$logf" 2>&1 &
  LAUNCHED=$!
}

# deep_up SLOTS CTX THREADS CPUS NCMOE_DELTA EXTRA -> 0 when healthy
deep_up() {
  local slots=$1 ctx=$2 threads=$3 cpus=$4 delta=$5 extra=$6 want try n logf
  want="$slots|$ctx|$threads|$cpus|$delta|$extra"
  if [[ "$want" == "$DEEP_CUR" ]] && kill -0 "$DEEP_PID" 2>/dev/null; then return 0; fi
  deep_down
  router_down   # its backend spec follows the slots
  for try in 0 1 2 3; do
    n=$(( DEEP_NCMOE + delta + 2 * try ))
    logf=$OUT/logs/server-deep-$(safe "$PHASE-s$slots-n$n${cpus:+-pinned}").log
    log "deep: starting ($DEEP_RT, $slots slots x $ctx, -ncmoe $n, $threads threads${cpus:+, cpus $cpus}${extra:+, $extra})"
    # shellcheck disable=SC2086
    launch deep "$DEEP_RT" "$DEEP_GPUS" "$cpus" "$DEEP_PORT" "$DEEP_ALIAS" "$slots" "$ctx" "$threads" "$logf" \
      -m "$DEEP_MODEL" -ncmoe "$n" $DEEP_EXTRA $extra
    DEEP_PID=$LAUNCHED
    if wait_health "$DEEP_PID" "$DEEP_PORT"; then
      DEEP_CUR=$want DEEP_N=$n
      DEEP_JSON=$(jq -nc --arg rt "$DEEP_RT" --argjson slots "$slots" --argjson ctx "$ctx" --argjson n "$n" --argjson t "$threads" \
        --arg cpus "$cpus" --arg extra "$DEEP_EXTRA $extra" '{runtime: $rt, slots: $slots, ctx_per_slot: $ctx, ncmoe: $n, threads: $t, cpus: $cpus, extra: ($extra | ltrimstr(" "))}')
      return 0
    fi
    log "deep: did not start at -ncmoe $n (tail: $(tail -n 2 "$logf" | tr '\n' ' ' | cut -c1-200))"
    deep_down
  done
  emit "$(jq -nc --arg p "$PHASE" --arg c "deep $want" --arg r "no start up to -ncmoe $n" '{type: "start_failed", phase: $p, config: $c, reason: $r}')"
  return 1
}

# fast_up SLOTS CTX THREADS CPUS TS EXTRA -> 0 when healthy
fast_up() {
  local slots=$1 ctx=$2 threads=$3 cpus=$4 ts=$5 extra=$6 want logf
  want="$slots|$ctx|$threads|$cpus|$ts|$extra"
  if [[ "$want" == "$FAST_CUR" ]] && kill -0 "$FAST_PID" 2>/dev/null; then return 0; fi
  fast_down
  router_down
  logf=$OUT/logs/server-fast-$(safe "$PHASE-s$slots-ts$ts${cpus:+-pinned}${extra:+-$extra}").log
  log "fast: starting ($FAST_RT, $slots slots x $ctx, -ts $ts, $threads threads${cpus:+, cpus $cpus}${extra:+, $extra})"
  # shellcheck disable=SC2086
  launch fast "$FAST_RT" "$FAST_GPUS" "$cpus" "$FAST_PORT" "$FAST_ALIAS" "$slots" "$ctx" "$threads" "$logf" \
    -m "$FAST_MODEL" -ts "$ts" $FAST_EXTRA $extra
  FAST_PID=$LAUNCHED
  if wait_health "$FAST_PID" "$FAST_PORT"; then
    FAST_CUR=$want
    FAST_JSON=$(jq -nc --arg rt "$FAST_RT" --argjson slots "$slots" --argjson ctx "$ctx" --arg ts "$ts" --argjson t "$threads" \
      --arg cpus "$cpus" --arg extra "$FAST_EXTRA $extra" '{runtime: $rt, slots: $slots, ctx_per_slot: $ctx, ts: $ts, threads: $t, cpus: $cpus, extra: ($extra | ltrimstr(" "))}')
    return 0
  fi
  log "fast: did not start (tail: $(tail -n 2 "$logf" | tr '\n' ' ' | cut -c1-200))"
  fast_down
  emit "$(jq -nc --arg p "$PHASE" --arg c "fast $want" --arg r "no start" '{type: "start_failed", phase: $p, config: $c, reason: $r}')"
  return 1
}

# Tiered layout: both backends with the tiered slot/ctx settings, then the router.
tiered_up() {
  local pinned=${1:-$PIN} dc="" fc="" ds fs want
  if [[ "$pinned" == 1 ]]; then dc=$PIN_DEEP_CPUS fc=$PIN_FAST_CPUS; fi
  deep_up "$DEEP_SLOTS" "$DEEP_CTX" "$THREADS_DEEP" "$dc" 0 "" || return 1
  fast_up "$FAST_SLOTS" "$FAST_CTX" "$THREADS_FAST" "$fc" "$FAST_TS" "" || return 1
  ds=$(jq -r .slots <<<"$DEEP_JSON") fs=$(jq -r .slots <<<"$FAST_JSON")
  want="deep=$DEEP_PORT:$ds:$DEEP_CTX fast=$FAST_PORT:$fs:$FAST_CTX"
  if [[ "$want" == "$ROUTER_CUR" ]] && kill -0 "$ROUTER_PID" 2>/dev/null; then return 0; fi
  router_down
  log "router: starting ($want)"
  "$PY" -I "$ROUTER" --port "$ROUTER_PORT" --key-file "$KEY_FILE" \
    --backend "deep=$DEEP_PORT:$ds:$DEEP_CTX" --backend "fast=$FAST_PORT:$fs:$FAST_CTX" \
    --policy difficulty+spill --default deep --log "$OUT/logs/router-decisions.jsonl" >>"$OUT/logs/router.log" 2>&1 &
  ROUTER_PID=$!
  if wait_health "$ROUTER_PID" "$ROUTER_PORT"; then ROUTER_CUR=$want; return 0; fi
  log "router: did not start (tail: $(tail -n 2 "$OUT/logs/router.log" | tr '\n' ' ' | cut -c1-200))"
  router_down
  emit "$(jq -nc --arg p "$PHASE" --arg c "router $want" '{type: "start_failed", phase: $p, config: $c, reason: "router /health not 200"}')"
  return 1
}

# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

safe() { tr -c 'A-Za-z0-9._=-' '_' <<<"$1" | sed 's/_$//'; }

sampler_start() {
  local ports=()
  [[ -n "$DEEP_PID" ]] && ports+=(--metrics-port "$DEEP_PORT")
  [[ -n "$FAST_PID" ]] && ports+=(--metrics-port "$FAST_PORT")
  [[ -n "$ROUTER_PID" ]] && ports+=(--router-port "$ROUTER_PORT")
  "$SCRIPT_DIR/sampler.sh" --out "$1" --key-file "$KEY_FILE" --match 'llama-server|router\.py' "${ports[@]}" \
    2>>"$OUT/logs/sampler.err" &
  SAMPLER_PID=$!
}

router_stats() {
  [[ -n "$ROUTER_PID" ]] || { echo null; return; }
  curl -s -m 5 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$ROUTER_PORT/router/stats" | jq -c . 2>/dev/null || echo null
}

# loadgen ARGS... (to stdout); the key and the tier aliases are always passed
loadgen() {
  timeout -k 10 "$RUN_TIMEOUT" "$PY" -I "$LOADGEN" --key "$KEY" --report "$REPORT" --tasks "$TASKS" \
    --tier-alias "$DEEP_ALIAS=deep" --tier-alias "$FAST_ALIAS=fast" "$@"
}

# record CONFIG LABEL META_JSON JSON_FILE RC TIMESERIES ROUTER_PRE ROUTER_POST
record() {
  local config=$1 label=$2 meta=$3 jf=$4 rc=$5 ts=$6 pre=$7 post=$8
  if [[ "$rc" -ne 0 ]] || ! jq -e .summary "$jf" >/dev/null 2>&1; then
    local why="loadgen exit $rc"; [[ "$rc" -eq 124 ]] && why="timed out after ${RUN_TIMEOUT}s"
    emit "$(jq -nc --arg p "$PHASE" --arg c "$config" --arg l "$label" --arg r "$why" '{type: "run_failed", phase: $p, config: $c, label: $l, reason: $r}')"
    log "$PHASE $config $label: FAILED ($why)"
    return 1
  fi
  emit "$(jq -c --arg p "$PHASE" --arg c "$config" --arg l "$label" --argjson meta "$meta" \
    --argjson deep "$DEEP_JSON" --argjson fast "$FAST_JSON" --arg dn "$DEEP_N" \
    --arg log "logs/$(basename "$jf")" --arg ts "logs/$(basename "$ts")" --argjson pre "$pre" --argjson post "$post" '
      {type: "run", phase: $p, config: $c, label: $l, policy: .summary.policy, model: .summary.model,
       ncmoe: (if $deep then $deep.ncmoe else null end), deep: $deep, fast: $fast,
       router: (if $pre and $post then {spills: (($post.spills // 0) - ($pre.spills // 0)),
                 judge_calls: (($post.judge_calls // 0) - ($pre.judge_calls // 0)), judge_ms_mean: $post.judge_ms_mean,
                 routed: ($post.tiers // {} | with_entries(.value = ((.value.routed // 0) - ($pre.tiers[.key].routed // 0))))}
               else null end),
       log: $log, timeseries: $ts, s: .summary} + $meta' "$jf")"
  log "$PHASE $config $label: $(jq -r '.summary | "aggregate \(.aggregate_gen_tps) t/s, per user \(.per_user_gen_tps_mean) t/s, TTFT \(.ttft_mean_s)s (p95 \(.ttft_p95_s)), acc \(.accuracy), tiers \(.tiers | map_values(.requests) | tostring), failed \(.failed)"' "$jf")"
}

# run CONFIG LABEL PORT META_JSON LOADGEN_ARGS...: one loadgen run with a time series
run() {
  local config=$1 label=$2 port=$3 meta=$4 base jf ts pre post rc=0
  shift 4
  base=$(safe "$PHASE-$config-$label")
  jf=$OUT/logs/$base.json ts=$OUT/logs/$base.timeseries.jsonl
  sampler_start "$ts"
  pre=$(router_stats)
  loadgen --port "$port" "$@" >"$jf" 2>"$OUT/logs/$base.err" || rc=$?
  post=$(router_stats)
  sampler_stop
  record "$config" "$label" "$meta" "$jf" "$rc" "$ts" "$pre" "$post" || return 1
}

# run_pair CONFIG LABEL META -- DEEP_ARGS... -- FAST_ARGS...: deep and fast loaded at the same time
run_pair() {
  local config=$1 label=$2 meta=$3 base ts rc1=0 rc2=0 p1 p2
  shift 3
  local dargs=() fargs=()
  while (($#)) && [[ "$1" != -- ]]; do dargs+=("$1"); shift; done
  shift
  fargs=("$@")
  base=$(safe "$PHASE-$config-$label")
  ts=$OUT/logs/$base.timeseries.jsonl
  sampler_start "$ts"
  loadgen --port "$DEEP_PORT" "${dargs[@]}" >"$OUT/logs/$base-deep.json" 2>"$OUT/logs/$base-deep.err" & p1=$!
  loadgen --port "$FAST_PORT" "${fargs[@]}" >"$OUT/logs/$base-fast.json" 2>"$OUT/logs/$base-fast.err" & p2=$!
  wait "$p1" || rc1=$?
  wait "$p2" || rc2=$?
  sampler_stop
  record "$config" "$label deep-side" "$(jq -c '. + {target: "deep", concurrent: "fast"}' <<<"$meta")" "$OUT/logs/$base-deep.json" "$rc1" "$ts" null null || true
  record "$config" "$label fast-side" "$(jq -c '. + {target: "fast", concurrent: "deep"}' <<<"$meta")" "$OUT/logs/$base-fast.json" "$rc2" "$ts" null null || true
}

closed() {  # WORKLOAD USERS -> loadgen args for a closed-loop run
  if [[ "$1" == tasks ]]; then
    echo "--workload tasks --users $2 --rounds $TASK_ROUNDS --max-tokens $TASK_MAX_TOKENS --seed $SEED"
  else
    echo "--workload $1 --users $2 --rounds $ROUNDS --max-tokens $MAX_TOKENS"
  fi
}

policy_args() {  # POLICY[@judge] -> loadgen args
  local p=${1%@judge}
  echo "--model auto --policy $p"
  [[ "$1" == *@judge ]] && echo "--judge fast"
  return 0
}

ttft_p95_of_last() { jq -r 'select(.type == "run") | .s.ttft_p95_s // 999' "$OUT/results.jsonl" | tail -n1; }
failed_frac_of_last() { jq -r 'select(.type == "run") | if .s.requests > 0 then .s.failed / .s.requests else 1 end' "$OUT/results.jsonl" | tail -n1; }

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

phase_A1() {
  local slots name w u
  fast_down; router_down
  for slots in 1 8; do
    name="ik-${slots}slot"; (( slots > 1 )) && name+="s"
    deep_up "$slots" "$A_CTX_PER_SLOT" "$THREADS_ALL" "" 0 "" || continue
    for w in $WORKLOADS; do for u in $USERS; do
      # shellcheck disable=SC2046
      run "$name" "$w-u$u" "$DEEP_PORT" '{"target":"deep"}' $(closed "$w" "$u") || true
    done; done
  done
  deep_down
}

phase_A2() {
  local spec name slots ts extra w u
  deep_down; router_down
  # name|slots|-ts|extra: one knob at a time, as in bench-concurrency.sh
  for spec in "fast-1slot|1|$FAST_TS|" "fast-4slots|4|$FAST_TS|" "fast-8slots|8|$FAST_TS|" "fast-16slots|16|$FAST_TS|" \
              "fast-8slots-spill|8|0.85,0.15|" "fast-8slots-kvq8|8|$FAST_TS|-ctk q8_0 -ctv q8_0" "fast-16slots-kvq8|16|$FAST_TS|-ctk q8_0 -ctv q8_0"; do
    IFS='|' read -r name slots ts extra <<<"$spec"
    fast_up "$slots" "$A_CTX_PER_SLOT" "$THREADS_ALL" "" "$ts" "$extra" || continue
    for w in $WORKLOADS; do for u in $FAST_USERS; do
      # shellcheck disable=SC2046
      run "$name" "$w-u$u" "$FAST_PORT" '{"target":"fast"}' $(closed "$w" "$u") || true
    done; done
  done
  fast_down
}

phase_A3() {
  local pinned spec gb ts delta dc fc u cfg
  router_down
  for spec in $RESERVE_SPECS; do
    IFS='|' read -r gb ts delta <<<"$spec"
    for pinned in 0 1; do
      # VRAM reserve only matters unpinned-vs-pinned at 0 GB; other reserves run unpinned
      [[ "$gb" != 0 && "$pinned" == 1 ]] && continue
      dc="" fc=""; [[ "$pinned" == 1 ]] && dc=$PIN_DEEP_CPUS fc=$PIN_FAST_CPUS
      cfg="reserve${gb}gb-$([[ $pinned == 1 ]] && echo pinned || echo unpinned)"
      deep_up "$DEEP_SLOTS" "$DEEP_CTX" "$THREADS_DEEP" "$dc" "$delta" "" || continue
      fast_up "$FAST_SLOTS" "$FAST_CTX" "$THREADS_FAST" "$fc" "$ts" "" || continue
      local meta
      meta=$(jq -nc --argjson gb "$gb" --arg ts "$ts" --argjson p "$pinned" '{reserve_gb: $gb, fast_ts: $ts, pinned: ($p == 1)}')
      for u in $USERS; do
        # shellcheck disable=SC2046
        run "$cfg" "deep-only-load-chat-u$u" "$DEEP_PORT" "$(jq -c '. + {target: "deep"}' <<<"$meta")" $(closed chat "$u") || true
        # shellcheck disable=SC2046
        run "$cfg" "fast-only-load-chat-u$u" "$FAST_PORT" "$(jq -c '. + {target: "fast"}' <<<"$meta")" $(closed chat "$u") || true
        # shellcheck disable=SC2046
        run_pair "$cfg" "both-chat-u$u" "$meta" $(closed chat "$u") -- $(closed chat "$u")
      done
    done
  done
}

phase_Q() {
  local tier port think mt
  tiered_up || return 0
  for think in 0 1; do
    for tier in deep fast; do
      port=$DEEP_PORT; [[ $tier == fast ]] && port=$FAST_PORT
      mt=$TASK_MAX_TOKENS; [[ $think == 1 ]] && mt=$TASK_MAX_TOKENS_THINK
      local slots; slots=$(jq -r .slots <<<"$([[ $tier == deep ]] && echo "$DEEP_JSON" || echo "$FAST_JSON")")
      local args=(--workload tasks --task-ids all --users "$slots" --max-tokens "$mt" --seed "$SEED")
      [[ $think == 1 ]] && args+=(--thinking)
      run "$tier" "all-tasks-think$think" "$port" "$(jq -nc --arg t "$tier" '{target: $t, tier: $t}')" "${args[@]}" || true
    done
  done
}

phase_B() {
  local p w u
  tiered_up || return 0
  for p in $POLICIES; do
    for w in $WORKLOADS tasks; do for u in $B_USERS; do
      local extra=()
      [[ $w == tasks ]] && extra=(--mix "$MIX")
      # shellcheck disable=SC2046
      run "$p" "$w-u$u" "$ROUTER_PORT" '{"target":"router"}' $(closed "$w" "$u") $(policy_args "$p") "${extra[@]}" || true
    done; done
  done
}

phase_C1() {
  local u h e m p
  tiered_up || return 0
  for p in $C1_POLICIES; do
    for u in $C1_USERS; do
      for h in 0 20 40 60 80 100; do
        # the rest split easy:medium 5:3, as in the default mix
        e=$(awk -v h="$h" 'BEGIN { printf "%.3f", (100 - h) / 100 * 0.625 }')
        m=$(awk -v h="$h" 'BEGIN { printf "%.3f", (100 - h) / 100 * 0.375 }')
        # shellcheck disable=SC2046
        run "$p" "hard$h-u$u" "$ROUTER_PORT" "$(jq -nc --argjson h "$h" '{target: "router", hard_pct: $h}')" \
          $(closed tasks "$u") $(policy_args "$p") --mix "easy=$e,medium=$m,hard=$(awk -v h="$h" 'BEGIN { printf "%.2f", h / 100 }')" || true
      done
    done
  done
}

phase_C2() {
  local p r
  tiered_up || return 0
  for p in $C2_POLICIES; do
    for r in $RATES; do
      # shellcheck disable=SC2046
      run "$p" "poisson-r$r" "$ROUTER_PORT" '{"target":"router"}' --workload tasks --mix "$MIX" --max-tokens "$TASK_MAX_TOKENS" \
        --arrival poisson --rate "$r" --duration "$DURATION" --seed "$SEED" $(policy_args "$p") || continue
      if awk -v t="$(ttft_p95_of_last)" -v s="$C2_STOP_TTFT" -v f="$(failed_frac_of_last)" 'BEGIN { exit !(t > s || f > 0.5) }'; then
        log "C2 $p: TTFT p95 above ${C2_STOP_TTFT}s (or most requests failed) at $r req/s; next policy"
        break
      fi
    done
  done
}

phase_C3() {
  local p u
  tiered_up || return 0
  for p in difficulty difficulty+spill; do
    for u in 16 32; do
      # shellcheck disable=SC2046
      run "$p" "hardburst-u$u" "$ROUTER_PORT" '{"target":"router","spill":'"$([[ $p == *spill ]] && echo true || echo false)"'}' \
        $(closed tasks "$u") $(policy_args "$p") --mix "easy=0.1,medium=0.1,hard=0.8" || true
    done
  done
}

phase_C4() {
  local p r ids
  tiered_up || return 0
  ids=$(jq -r 'select(.category == "long-doc") | .id' "$TASKS" | paste -sd, -)
  [[ -n "$ids" ]] || { log "C4: no long-doc tasks in $TASKS"; return 0; }
  for p in fast-only difficulty+spill; do
    for r in $C4_RATES; do
      # shellcheck disable=SC2046
      run "$p" "longdoc-r$r" "$ROUTER_PORT" '{"target":"router"}' --workload tasks --task-ids "$ids" --max-tokens "$TASK_MAX_TOKENS" \
        --arrival poisson --rate "$r" --duration "$DURATION" --seed "$SEED" $(policy_args "$p") || true
    done
  done
}

phase_C5() {
  local pinned cfg
  for pinned in 0 1; do
    cfg=$([[ $pinned == 1 ]] && echo pinned || echo unpinned)
    tiered_up "$pinned" || continue
    # shellcheck disable=SC2046
    run "$cfg" "deep-alone-chat-u1" "$DEEP_PORT" "$(jq -nc --argjson p "$pinned" '{target: "deep", pinned: ($p == 1)}')" $(closed chat 1) || true
    # shellcheck disable=SC2046
    run_pair "$cfg" "deep-u1-while-fast-u16" "$(jq -nc --argjson p "$pinned" '{pinned: ($p == 1)}')" $(closed chat 1) -- $(closed chat 16)
  done
}

phase_C6() {
  local base jf ts pid rc=0 kill_at victim
  tiered_up || return 0
  victim=$C6_KILL
  kill_at=$(awk -v d="$DURATION" 'BEGIN { printf "%d", d / 3 }')
  base=$(safe "C6-kill-$victim")
  jf=$OUT/logs/$base.json ts=$OUT/logs/$base.timeseries.jsonl
  sampler_start "$ts"
  local pre; pre=$(router_stats)
  # shellcheck disable=SC2046
  loadgen --port "$ROUTER_PORT" --workload tasks --mix "$MIX" --max-tokens "$TASK_MAX_TOKENS" --arrival poisson \
    --rate "$C6_RATE" --duration "$DURATION" --seed "$SEED" $(policy_args difficulty+spill) >"$jf" 2>"$OUT/logs/$base.err" &
  pid=$!
  sleep "$kill_at"
  log "C6: kill -9 $victim at ${kill_at}s"
  if [[ $victim == fast ]]; then kill -9 "$FAST_PID" 2>/dev/null || true; else kill -9 "$DEEP_PID" 2>/dev/null || true; fi
  wait "$pid" || rc=$?
  local post; post=$(router_stats)
  sampler_stop
  local meta
  meta=$(jq -c --arg v "$victim" --argjson k "$kill_at" '
    [.rows[] | select(.t_end_s >= $k)] as $after |
    {target: "router", c6: {killed: $v, kill_at_s: $k,
      failed_after_kill: ([$after[] | select(.ok | not)] | length),
      last_failure_after_kill_s: ([$after[] | select(.ok | not) | .t_end_s - $k] | max | if . then (. * 1000 | round / 1000) else . end),
      first_ok_other_tier_after_kill_s: ([$after[] | select(.ok and .tier != $v and .t_start_s >= $k) | .t_end_s - $k] | min
        | if . then (. * 1000 | round / 1000) else . end)}}' "$jf" 2>/dev/null || echo '{}')
  record "difficulty+spill" "kill-$victim" "$meta" "$jf" "$rc" "$ts" "$pre" "$post" || true
  if [[ $victim == fast ]]; then wait "$FAST_PID" 2>/dev/null || true; fast_down; else wait "$DEEP_PID" 2>/dev/null || true; deep_down; fi
  router_down
}

phase_C7() {
  local tier port u
  tiered_up || return 0
  for tier in deep fast; do
    port=$DEEP_PORT; [[ $tier == fast ]] && port=$FAST_PORT
    for u in 1 32; do
      # shellcheck disable=SC2046
      run "$tier-direct" "chat-u$u" "$port" "$(jq -nc --arg t "$tier" '{target: $t, tier: $t}')" $(closed chat "$u") || true
      # shellcheck disable=SC2046
      run "$tier-via-router" "chat-u$u" "$ROUTER_PORT" "$(jq -nc --arg t "$tier" '{target: "router", tier: $t}')" $(closed chat "$u") --model "$tier" || true
    done
  done
}

# ---------------------------------------------------------------------------

record_hardware
log "deep $(basename "$DEEP_MODEL") (-ncmoe $DEEP_NCMOE, $THREADS_DEEP threads tiered / $THREADS_ALL alone) | fast $(basename "$FAST_MODEL") (-ts $FAST_TS, $THREADS_FAST threads) | pin cpus deep $PIN_DEEP_CPUS fast $PIN_FAST_CPUS"
log "phases: $PHASES | users $USERS | workloads $WORKLOADS | rounds $ROUNDS | max tokens $MAX_TOKENS | out $OUT"
for PHASE in $PHASES; do
  case "$PHASE" in
    A1|A2|A3|Q|B|C1|C2|C3|C4|C5|C6|C7) log "== phase $PHASE"; "phase_$PHASE"; summarize "$OUT" ;;
    *) log "unknown phase $PHASE, skipping" ;;
  esac
done
cleanup
summarize "$OUT"
log "done: $OUT/results.md"
