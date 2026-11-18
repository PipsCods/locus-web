#!/usr/bin/env bash
# Run the full benchmark on the rented EPYC/3090 box. Pass a UTC epoch
# deadline computed at rental time and an unused results directory. Use
# --reuse-build after setup has completed on this instance.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
deadline=${1:?usage: bench-3090.sh DEADLINE_EPOCH /workspace/bench/RUN}
out=${2:?results directory required}
setup_mode=${3:-}
[[ -z "$setup_mode" || "$setup_mode" == --reuse-build ]] || { echo "Unknown option: $setup_mode" >&2; exit 1; }
if ! [[ "$deadline" =~ ^[0-9]+$ ]] || (( deadline <= $(date +%s) )); then
  echo "Rental deadline must be in the future" >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$out")"
mkdir "$out"
out=$(realpath "$out")
exec > >(tee -a "$out/run.log") 2>&1

# Vast exports the container-scoped credential in the SSH startup hook.
while IFS='=' read -r name value; do
  case "$name" in CONTAINER_ID|CONTAINER_API_KEY) export "$name=$value" ;; esac
done </etc/environment
: "${CONTAINER_ID:?Vast container ID missing}" "${CONTAINER_API_KEY:?Vast container API key missing}"
export LOCUS_STATE_DIR="$out" LOCUS_RUN_DIR="$out"
setsid nohup ./onstart.sh --self-destruct-at "$deadline" >"$out/self-destruct.log" 2>&1 </dev/null &
for _ in {1..10}; do
  [[ -s "$out/self-destruct.pid" ]] && break
  sleep 1
done
if [[ ! -s "$out/self-destruct.pid" ]] || ! kill -0 "$(cat "$out/self-destruct.pid")"; then
  echo "Self-destruct failed to arm" >&2
  exit 1
fi
unset CONTAINER_API_KEY

if [[ "$setup_mode" != --reuse-build ]]; then
  ./setup-on-box.sh
fi
export PATH=/opt/venv/bin:$PATH
./bench.sh --hw-only --out "$out/preflight"
jq -e '
  (.cpu_model | test("EPYC"; "i")) and
  (.gpu_name == "NVIDIA GeForce RTX 3090") and
  (.host_threads | tonumber) as $host_threads |
  (.cpu_affinity_threads == $host_threads) and
  (.cpu_quota_threads == null or .cpu_quota_threads >= 0.95 * $host_threads) and
  ((.ram_slice_gb | tonumber) >= 190)
' "$out/preflight/hardware.json" >/dev/null \
  || { echo "Expected EPYC, full host CPU allocation, one RTX 3090 and at least 190 GB RAM" >&2; exit 1; }
[[ "$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)" -eq 1 ]] \
  || { echo "Expected exactly one visible GPU" >&2; exit 1; }
[[ -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader)" ]] \
  || { echo "GPU already has active compute workloads" >&2; exit 1; }

cat /proc/loadavg >"$out/preflight/loadavg.txt"
vmstat -w -t 1 11 >"$out/preflight/vmstat.txt"
# Ignore the first row, which is the average since boot.
awk 'NR > 3 { idle += $15; n++ } END { exit !(n && idle / n >= 90) }' "$out/preflight/vmstat.txt" \
  || { echo "Host averaged less than 90% CPU idle during the preflight sample" >&2; exit 1; }
vmstat -w -t 5 >"$out/vmstat.txt" &
vmstat_pid=$!
nvidia-smi --query-gpu=timestamp,utilization.gpu,memory.used,temperature.gpu,power.draw,clocks.sm,clocks.mem,pcie.link.gen.current,pcie.link.width.current \
  --format=csv -l 5 >"$out/gpu.csv" &
gpu_pid=$!
trap 'kill "$vmstat_pid" "$gpu_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM

models=/workspace/models
repo=unsloth/Qwen3.8-Flash-Next-GGUF
export MODEL_REPO_BENCH="$repo"
./bench.sh --quants "UD-IQ4_XS UD-Q4_K_XL" --keep-models --models-dir "$models" --out "$out/full"

# Both repeats at the fill configuration must be present for the 16k baseline.
threads=$(jq -er '.physical_cores' "$out/full/hardware.json")
fill_spec=()
for runtime in ik mainline; do
  fill=$(jq -ser --arg rt "$runtime" '
    map(select(.type == "probe" and .quant == "UD-IQ4_XS" and .runtime == $rt and .fits))
    | min_by(.ncmoe).ncmoe' "$out/full/results.jsonl")
  jq -se --arg rt "$runtime" --argjson n "$fill" --argjson t "$threads" '
    [.[] | select(.type == "run" and .quant == "UD-IQ4_XS" and .runtime == $rt and
      .ncmoe == $n and .threads == $t and .ctx == "16k" and .mode == "off" and .ok)]
    | length == 2' "$out/full/results.jsonl" >/dev/null \
    || { echo "Missing a valid 16k baseline for $runtime at -ncmoe $fill" >&2; exit 1; }
  fill_spec+=("$runtime=$fill")
done

shared=MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf
full=MTP/mtp-Qwen3.8-Flash-Next-Q8_0.gguf
hf download "$repo" "$shared" "$full" --local-dir "$models"
shards=("$models"/UD-IQ4_XS/*-00001-of-*.gguf)
./bench-concurrency.sh --model "${shards[0]}" --ncmoe "${fill_spec[*]}" --threads "$threads" \
  --mtp-head "$models/$shared" --mtp-head-full "$models/$full" --out "$out/concurrency"
