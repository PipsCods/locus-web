#!/usr/bin/env bash
# Dispatches llama-{server,bench}-{ik,mainline} to the right build.
# Installed as symlinks in /usr/local/bin; the name it is called by decides.
#
#   ik:       picks the CPU variant built for this host (zen4 = AVX-512 with
#             VNNI/VBMI/BF16, else v3 = AVX2) and sets GGML_CUDA_NO_PINNED=1
#             (from the plan). Without it ik pins the host buffer of the
#             CPU-resident weights (tens of GB here); ik's own log warns this
#             "may take a while" and suggests this variable, at some cost in
#             prefill speed. Override with GGML_CUDA_NO_PINNED= / IK_VARIANT=v3|zen4;
#             `llama-server-ik --locus-variant` prints the variant choice.
#   mainline: dynamic CPU backends; libraries live next to the binaries.
set -euo pipefail

name=$(basename "$0")
tool=${name%-*}      # llama-server | llama-bench
runtime=${name##*-}  # ik | mainline

ik_variant() {
  if [[ -n "${IK_VARIANT:-}" ]]; then
    echo "$IK_VARIANT"
    return
  fi
  local flags need
  flags=$(grep -m1 '^flags' /proc/cpuinfo || true)
  for need in avx512f avx512bw avx512dq avx512vl avx512_vnni avx512vbmi avx512_bf16; do
    if [[ " $flags " != *" $need "* ]]; then
      echo v3
      return
    fi
  done
  echo zen4
}

case "$runtime" in
  ik)
    variant=$(ik_variant)
    if [[ "${1:-}" == --locus-variant ]]; then
      echo "$variant"
      exit 0
    fi
    bin=/opt/ik/$variant/bin/$tool
    if [[ ! -x "$bin" ]]; then
      # Image built with a single variant: fall back to whatever exists.
      for candidate in /opt/ik/*/bin/"$tool"; do
        [[ -x "$candidate" ]] && { bin=$candidate; break; }
      done
    fi
    export GGML_CUDA_NO_PINNED="${GGML_CUDA_NO_PINNED-1}"
    [[ -n "$GGML_CUDA_NO_PINNED" ]] || unset GGML_CUDA_NO_PINNED
    ;;
  mainline)
    bin=/opt/mainline/bin/$tool
    export LD_LIBRARY_PATH="/opt/mainline/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    ;;
  *)
    echo "llama-wrapper: unknown runtime in name '$name'" >&2
    exit 2
    ;;
esac

if [[ -z "${bin:-}" || ! -x "$bin" ]]; then
  echo "llama-wrapper: no $tool binary for runtime $runtime" >&2
  exit 127
fi

exec "$bin" "$@"
