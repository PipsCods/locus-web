#!/usr/bin/env bash
# locus time-series sampler: one JSON line per interval until killed, for
# lining up throughput and latency with what the GPUs, CPU and servers were
# doing at the time. Started in the background by bench-tiered.sh for each run.
#
# Each line: {ts, t, gpus:[...], cpu:{...}, mem:{...}, procs:[...],
#             metrics:{PORT:{...}}, router:{...}}
#   gpus     per GPU: utilization (gpu, memory), memory used, power, SM clock,
#            PCIe generation, temperature (nvidia-smi --query-gpu), PCIe rx/tx
#            MB/s (nvidia-smi dmon -s t)
#   cpu      host CPU busy % and iowait % from /proc/stat deltas
#   procs    per process (--pids, or command lines matching --match): CPU %
#            (100 = one core), RSS, page faults/s, threads, its --port
#   metrics  each llama-server's /metrics (needs --metrics): requests
#            processing/deferred, KV-cache usage, token counters and their
#            rate, plus every llamacpp:* value as raw (names differ between
#            ik and mainline, so missing ones are null)
#   router   router.py's /router/stats JSON as returned
# Anything that is not there (no nvidia-smi, a server not up yet) is null, not
# an error: the sampler keeps going.
#
# Usage: sampler.sh --out FILE [options]
#   --out FILE           JSONL to append to (required)
#   --interval S         seconds between samples, default 1
#   --metrics-port P     a llama-server port to scrape (repeatable)
#   --router-port P      router.py port for /router/stats
#   --key-file F         bearer key for /metrics and /router/stats
#   --pids "PID ..."     processes to follow
#   --match REGEX        follow processes whose command line matches (repeatable;
#                        re-resolved every sample, so restarts are picked up)
#   --host H             default 127.0.0.1
#   --count N            stop after N samples (default: run until killed)
set -euo pipefail

OUT=""
INTERVAL=1
PORTS=()
ROUTER_PORT=""
KEY_FILE=""
PIDS=""
MATCH=()
HOST=127.0.0.1
COUNT=0

die() { echo "sampler: $*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --out) OUT=${2:?}; shift ;;
    --interval) INTERVAL=${2:?}; shift ;;
    --metrics-port) PORTS+=("${2:?}"); shift ;;
    --router-port) ROUTER_PORT=${2:?}; shift ;;
    --key-file) KEY_FILE=${2:?}; shift ;;
    --pids) PIDS=${2:?}; shift ;;
    --match) MATCH+=("${2:?}"); shift ;;
    --host) HOST=${2:?}; shift ;;
    --count) COUNT=${2:?}; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$OUT" ]] || die "--out FILE is required"
[[ -z "$KEY_FILE" || -r "$KEY_FILE" ]] || die "key file not readable: $KEY_FILE"
mkdir -p "$(dirname "$OUT")"

PY=$(command -v python3) || die "python3 not found"
[[ -x /opt/venv/bin/python3 ]] && PY=/opt/venv/bin/python3

TMP=$(mktemp -d)
CHILDREN=()
cleanup() {
  local p
  for p in "${CHILDREN[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 0' TERM INT HUP

# PCIe throughput comes from a long-running dmon; the loop reads its last rows.
DMON=""
if command -v nvidia-smi >/dev/null 2>&1; then
  DMON=$TMP/dmon.txt
  nvidia-smi dmon -s t -d "$(printf '%.0f' "$INTERVAL" | sed 's/^0$/1/')" >"$DMON" 2>/dev/null &
  CHILDREN+=($!)
fi

# The sampling loop, in the image's python3 (stdlib only).
read -r -d '' LOOP <<'PY' || true
import json, os, re, subprocess, sys, time, urllib.request

cfg = json.loads(sys.argv[1])
key = open(cfg["key_file"]).read().strip() if cfg["key_file"] else ""
match = [re.compile(m) for m in cfg["match"]]
fixed_pids = [int(p) for p in cfg["pids"].split()]
hz = os.sysconf("SC_CLK_TCK")
page = os.sysconf("SC_PAGE_SIZE")
me = {os.getpid(), os.getppid()}
have_smi = subprocess.run(["sh", "-c", "command -v nvidia-smi"], capture_output=True).returncode == 0
GPU_FIELDS = ["index", "utilization.gpu", "utilization.memory", "memory.used", "power.draw",
              "clocks.sm", "pcie.link.gen.current", "temperature.gpu"]
GPU_KEYS = ["index", "util_gpu", "util_mem", "mem_used_mib", "power_w", "sm_mhz", "pcie_gen", "temp_c"]
# llamacpp:* names differ between ik and mainline builds: first present wins.
PICK = {
    "processing": ["requests_processing"],
    "deferred": ["requests_deferred"],
    "kv_usage": ["kv_cache_usage_ratio", "kv_cache_usage"],
    "kv_tokens": ["kv_cache_tokens"],
    "predicted_total": ["tokens_predicted_total", "n_tokens_predicted_total"],
    "prompt_total": ["prompt_tokens_total", "n_prompt_tokens_processed_total"],
    "decode_total": ["n_decode_total"],
    "busy_slots_per_decode": ["n_busy_slots_per_decode"],
    "predicted_tps": ["predicted_tokens_seconds"],
    "prompt_tps": ["prompt_tokens_seconds"],
}


def num(s):
    try:
        f = float(s)
    except (TypeError, ValueError):
        return None
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


def gpus():
    if not have_smi:
        return None
    try:
        out = subprocess.run(["nvidia-smi", f"--query-gpu={','.join(GPU_FIELDS)}", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    rows = []
    for line in out.strip().splitlines():
        vals = [v.strip() for v in line.split(",")]
        if len(vals) == len(GPU_KEYS):
            rows.append({k: num(v) for k, v in zip(GPU_KEYS, vals)})
    pcie = dmon()
    for r in rows:
        r.update(pcie.get(r["index"], {"pcie_rx_mbs": None, "pcie_tx_mbs": None}))
    return rows


def dmon():
    res = {}
    path = cfg["dmon"]
    if not path:
        return res
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 4096))
            lines = f.read().decode(errors="replace").splitlines()
    except OSError:
        return res
    for line in lines:
        parts = line.split()
        if len(parts) >= 3 and not line.lstrip().startswith("#"):
            res[num(parts[0])] = {"pcie_rx_mbs": num(parts[1]), "pcie_tx_mbs": num(parts[2])}
    return res


def cpu_times():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle = v[3] + (v[4] if len(v) > 4 else 0)
    return sum(v[:8]), idle, v[4] if len(v) > 4 else 0


def mem():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0]) // 1024
    return {"total_mib": m.get("MemTotal"), "avail_mib": m.get("MemAvailable"),
            "used_mib": (m.get("MemTotal") or 0) - (m.get("MemAvailable") or 0)}


def find_pids():
    pids = set(fixed_pids)
    if match:
        for d in os.listdir("/proc"):
            if not d.isdigit() or int(d) in me:
                continue
            try:
                cmd = open(f"/proc/{d}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()
            except OSError:
                continue
            if cmd and any(m.search(cmd) for m in match) and "sampler" not in cmd:
                pids.add(int(d))
    return sorted(pids)


def proc_stat(pid):
    try:
        raw = open(f"/proc/{pid}/stat").read()
        cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        with open(f"/proc/{pid}/statm") as s:
            rss = int(s.read().split()[1]) * page
    except (OSError, IndexError, ValueError):
        return None  # exited between listing and reading
    comm = raw[raw.index("(") + 1:raw.rindex(")")]
    f = raw[raw.rindex(")") + 2:].split()  # f[0] is field 3 (state)
    args = [a.decode(errors="replace") for a in cmd if a]
    port = None
    for i, a in enumerate(args[:-1]):
        if a == "--port":
            port = num(args[i + 1])
    return {"pid": pid, "name": comm, "port": port, "cpu_ticks": int(f[11]) + int(f[12]),
            "minflt": int(f[7]), "majflt": int(f[9]), "threads": int(f[17]), "rss_mib": rss // 1048576}


def get(path, port, timeout=1.0):
    req = urllib.request.Request(f"http://{cfg['host']}:{port}{path}")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode(errors="replace")
    except Exception:  # noqa: BLE001 - a server that is down is a null sample
        return None


def metrics(port, prev, dt):
    text = get("/metrics", port)
    if text is None:
        return None
    raw = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, rest = line.partition(" ")
        name = name.split("{", 1)[0]
        if name.startswith("llamacpp:"):
            raw[name[9:]] = num(rest.split()[0] if rest.split() else None)
    out = {k: next((raw[n] for n in names if n in raw), None) for k, names in PICK.items()}
    old = prev.get(port)
    for k in ("predicted_total", "prompt_total"):
        cur, was = out[k], (old or {}).get(k)
        out[k.replace("_total", "_rate")] = round((cur - was) / dt, 1) if dt and cur is not None and was is not None and cur >= was else None
    prev[port] = out
    return dict(out, raw=raw)


def main():
    out = open(cfg["out"], "a", buffering=1)
    t_start = time.time()
    last_cpu = cpu_times()
    last_proc, last_t, prev_metrics = {}, time.monotonic(), {}
    n = 0
    while True:
        time.sleep(max(0.0, cfg["interval"] - (time.monotonic() - last_t)))
        now = time.monotonic()
        dt = now - last_t
        last_t = now
        tot, idle, iow = cpu_times()
        dtot = tot - last_cpu[0] or 1
        cpu = {"util": round(100 * (1 - (idle - last_cpu[1]) / dtot), 1), "iowait": round(100 * (iow - last_cpu[2]) / dtot, 1),
               "ncpu": os.cpu_count()}
        last_cpu = (tot, idle, iow)
        procs = []
        for pid in find_pids():
            p = proc_stat(pid)
            if p is None:
                continue
            o = last_proc.get(pid)
            p["cpu_pct"] = round(100 * (p["cpu_ticks"] - o["cpu_ticks"]) / hz / dt, 1) if o else None
            p["minflt_s"] = round((p["minflt"] - o["minflt"]) / dt) if o else None
            p["majflt_s"] = round((p["majflt"] - o["majflt"]) / dt) if o else None
            last_proc[pid] = p
            procs.append({k: p[k] for k in ("pid", "name", "port", "cpu_pct", "rss_mib", "minflt_s", "majflt_s", "threads")})
        rec = {"ts": round(time.time(), 3), "t": round(time.time() - t_start, 2), "gpus": gpus(), "cpu": cpu, "mem": mem(),
               "procs": procs, "metrics": {str(p): metrics(p, prev_metrics, dt) for p in cfg["ports"]}}
        if cfg["router_port"]:
            txt = get("/router/stats", cfg["router_port"])
            try:
                rec["router"] = json.loads(txt) if txt else None
            except ValueError:
                rec["router"] = None
        out.write(json.dumps(rec, separators=(",", ":")) + "\n")
        n += 1
        if cfg["count"] and n >= cfg["count"]:
            return


try:
    main()
except KeyboardInterrupt:
    pass
PY

CFG=$(OUT="$OUT" INTERVAL="$INTERVAL" ROUTER_PORT="$ROUTER_PORT" KEY_FILE="$KEY_FILE" PIDS="$PIDS" \
  HOST="$HOST" COUNT="$COUNT" DMON="$DMON" "$PY" -I -c '
import json, os, sys
e = os.environ
print(json.dumps({"out": e["OUT"], "interval": float(e["INTERVAL"]), "router_port": e["ROUTER_PORT"],
  "key_file": e["KEY_FILE"], "pids": e["PIDS"], "host": e["HOST"], "count": int(e["COUNT"]), "dmon": e["DMON"],
  "ports": [p for p in sys.argv[1].split(",") if p], "match": [m for m in sys.argv[2:]]}))
' "$(IFS=,; echo "${PORTS[*]}")" "${MATCH[@]}")

"$PY" -I -c "$LOOP" "$CFG" &
CHILDREN+=($!)
wait "${CHILDREN[-1]}"
