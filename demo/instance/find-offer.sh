#!/usr/bin/env bash
# Find (and optionally rent) a Vast.ai machine for the locus benchmark/demo.
#
# Searches verified on-demand offers with exactly one GPU (RTX 5090 unless --gpu), reliability
# > 0.99, >= 1000 Mb/s download, >= 250 GB disk and >= 128 GB RAM, then ranks
# them client-side:
#   1. RAM tier: >= 192 GB first, then >= 128 GB
#   2. CPU class: EPYC / Xeon / Threadripper first (cpu_name is not a server-side
#      search field, so this is done here with jq)
#   3. DDR5-era server CPU first (EPYC 9004/9005, Xeon 4th gen and later,
#      Threadripper 7000/9000): CPU-side expert throughput is bound by memory
#      bandwidth, and these have 8-12 DDR5 channels
#   4. more effective CPU cores
#   5. lower $/h
#
# A single-GPU rental gets only a slice of the host: cpu_ram and
# cpu_cores_effective in the offer are already that slice, cpu_cores is the
# whole host. Ranking uses the slice.
#
# Usage:
#   find-offer.sh [options]            print ranked candidates
#   find-offer.sh --create [options]   rent the best one
#
# Options:
#   --create             rent the top-ranked offer (--cancel-unavail, ssh)
#   --image IMAGE        image to run (required with --create; or $LOCUS_IMAGE)
#   --login 'ARGS'       docker login args for a private registry ($LOCUS_IMAGE_LOGIN)
#   --label LABEL        instance label (default locus-bench-<UTC timestamp>)
#   --gpu NAME           GPU model as Vast names it, e.g. 'RTX 3090' (default RTX 5090)
#   --disk GB            disk to allocate and to require (default 250)
#   --min-ram GB         lowest RAM tier to accept (default 128)
#   --top-ram GB         preferred RAM tier (default 192)
#   --max-dph USD        price cap per hour, total incl. storage (default 3.00)
#   --server-cpu-only    drop non-EPYC/Xeon/Threadripper offers instead of ranking them lower
#   --offer ID           with --create: rent this offer id instead of the top one
#   --limit N            rows to print (default 15)
#   --json               print the ranked offers as JSON instead of a table
#
# Needs: vastai (pip install vastai), jq. Searching works without an API key;
# --create needs one (vastai set api-key ... or VAST_API_KEY).
set -euo pipefail

CREATE=0
IMAGE=${LOCUS_IMAGE:-}
LOGIN=${LOCUS_IMAGE_LOGIN:-}
LABEL=""
DISK=250
MIN_RAM=128
TOP_RAM=192
MAX_DPH=3.00
SERVER_ONLY=0
OFFER_ID=""
LIMIT=15
JSON=0
# Oldest CUDA the image runs on; keep in sync with CUDA_VERSION in Dockerfile.
MIN_CUDA=13.0
GPU=RTX_5090

die() { echo "find-offer: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create) CREATE=1 ;;
    --image) IMAGE=${2:?}; shift ;;
    --login) LOGIN=${2:?}; shift ;;
    --label) LABEL=${2:?}; shift ;;
    --gpu) GPU=${2:?}; GPU=${GPU// /_}; shift ;;
    --disk) DISK=${2:?}; shift ;;
    --min-ram) MIN_RAM=${2:?}; shift ;;
    --top-ram) TOP_RAM=${2:?}; shift ;;
    --max-dph) MAX_DPH=${2:?}; shift ;;
    --server-cpu-only) SERVER_ONLY=1 ;;
    --offer) OFFER_ID=${2:?}; shift ;;
    --limit) LIMIT=${2:?}; shift ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

command -v vastai >/dev/null || die "vastai CLI not found (pip install vastai)"
command -v jq >/dev/null || die "jq not found"

api_key_args=()
if [[ -n "${VAST_API_KEY:-}" ]]; then
  api_key_args=(--api-key "$VAST_API_KEY")
fi

# Server-side filters. Syntax checked against vastai 1.11.0 (vastai/api/query.py):
# string values use _ for spaces; cpu_ram is given in GB (the CLI multiplies by
# 1000, raw results are in MB); cuda_vers is an alias of cuda_max_good;
# dph is an alias of dph_total. verified/rentable/external=false are also in
# the CLI's default query, stated here so the intent is visible.
query="num_gpus=1 gpu_name=${GPU} verified=true rentable=true rented=false"
query+=" external=false cpu_arch=amd64"
query+=" reliability>0.99 inet_down>=1000 disk_space>=${DISK}"
query+=" cpu_ram>=${MIN_RAM} cuda_vers>=${MIN_CUDA} dph<=${MAX_DPH}"

echo "query: $query" >&2
raw=$(vastai search offers "$query" --type on-demand --storage "$DISK" --order 'dph_total' --raw "${api_key_args[@]}") \
  || die "vastai search offers failed"

ranked=$(jq --argjson top "$TOP_RAM" --argjson server_only "$SERVER_ONLY" '
  def server_cpu: (.cpu_name // "") | test("EPYC|Xeon|Threadripper"; "i");
  def ddr5_cpu: (.cpu_name // "")
    | test("EPYC 9[0-9A-Z]{3}|Xeon.*(Platinum|Gold|Silver) [3-9][4-9][0-9]{2}|Xeon 6[0-9]{3}|Threadripper.*(PRO )?[79][0-9]{3}"; "i");
  [ .[]
    | . + {
        ram_gb: ((.cpu_ram // 0) / 1000 | floor),
        tier: (if (.cpu_ram // 0) >= ($top * 1000) then 1 else 2 end),
        server: server_cpu,
        ddr5: ddr5_cpu
      }
    | select($server_only == 0 or .server)
  ]
  | sort_by(.tier, (if .server then 0 else 1 end), (if .ddr5 then 0 else 1 end),
          -(.cpu_cores_effective // 0), (.dph_total // 99))
' <<<"$raw")

count=$(jq 'length' <<<"$ranked")
[[ "$count" -gt 0 ]] || die "no offers match (try --max-dph, --min-ram, or drop --server-cpu-only)"

if [[ "$JSON" -eq 1 ]]; then
  jq --argjson n "$LIMIT" '.[:$n]' <<<"$ranked"
else
  {
    printf 'rank\toffer\ttier\tddr5\tram_GB\tcores_eff\thost_cores\tcpu\t$/h\tdown_Mbps\tdisk_GB\treliab\tcuda\tpcie\twhere\n'
    jq -r --argjson n "$LIMIT" '
      .[:$n] | to_entries[] | .value as $o | [
        (.key + 1),
        $o.id,
        (if $o.tier == 1 then "A" else "B" end),
        (if $o.ddr5 then "yes" else "-" end),
        $o.ram_gb,
        ($o.cpu_cores_effective // 0 | floor),
        ($o.cpu_cores // 0),
        (($o.cpu_name // "?") | .[0:34]),
        (($o.dph_total // 0) * 1000 | round / 1000),
        ($o.inet_down // 0 | floor),
        ($o.disk_space // 0 | floor),
        (($o.reliability2 // $o.reliability // 0) * 1000 | floor / 1000),
        ($o.cuda_max_good // "?"),
        ($o.pci_gen // "?"),
        ($o.geolocation // "?")
      ] | @tsv' <<<"$ranked"
  } | column -t -s $'\t'
  echo "tier A = >= ${TOP_RAM} GB RAM, B = >= ${MIN_RAM} GB; ${count} offers total" >&2
fi

[[ "$CREATE" -eq 1 ]] || exit 0

[[ -n "$IMAGE" ]] || die "--create needs --image (or LOCUS_IMAGE)"
if [[ -z "$OFFER_ID" ]]; then
  OFFER_ID=$(jq -r '.[0].id' <<<"$ranked")
fi
LABEL=${LABEL:-locus-bench-$(date -u +%Y%m%d-%H%M%S)}

create=(vastai create instance "$OFFER_ID"
  --image "$IMAGE"
  --disk "$DISK"
  --label "$LABEL"
  --ssh --direct
  --cancel-unavail
  # ssh launch mode hides -e vars from ssh sessions unless exported here.
  # The chown/chmod works around hosts that leave authorized_keys with modes
  # sshd refuses ("bad ownership or modes"), which locks ssh out entirely.
  --onstart-cmd 'chown -R root:root /root/.ssh; chmod 700 /root /root/.ssh; chmod 600 /root/.ssh/authorized_keys; env | grep -E "^(CONTAINER_|HF_|VAST_)" >> /etc/environment'
  --raw)
if [[ -n "$LOGIN" ]]; then
  create+=(--login "$LOGIN")
fi
if [[ -n "${HF_TOKEN:-}" ]]; then
  create+=(--env "-e HF_TOKEN=$HF_TOKEN")
fi

echo "renting offer $OFFER_ID as '$LABEL' ..." >&2
out=$("${create[@]}" "${api_key_args[@]}") || die "create instance failed: $out"
echo "$out"
id=$(jq -r '.new_contract // empty' <<<"$out" 2>/dev/null || true)
if [[ -n "$id" ]]; then
  cat >&2 <<EOF
instance $id created. Next:
  vastai show instance $id            # wait for status 'running'
  vastai ssh-url $id                  # ssh in, then: bench.sh --help
  vastai destroy instance $id -y      # when done; then: vastai show instances
EOF
fi
