#!/usr/bin/env bash
# Build the locus instance layout directly on a rented machine, for when the
# image cannot be built and pushed (no docker on the workstation). Mirrors the
# Dockerfile: same refs, same flags, same paths. Run as root on a machine
# started from nvidia/cuda:13.0.3-devel-ubuntu24.04, from a copy of this
# directory:
#   scp -P <port> -r demo/instance root@<host>:/opt/locus && ssh ... /opt/locus/setup-on-box.sh
#
# Keep the pinned refs in step with the Dockerfile's build args.
set -euo pipefail

IK_REPO=${IK_REPO:-https://github.com/ikawrakow/ik_llama.cpp}
IK_REF=${IK_REF:-a6383da414f74c944999e7b9312a5a5d76191f6b}
MAINLINE_REPO=${MAINLINE_REPO:-https://github.com/ggml-org/llama.cpp}
MAINLINE_REF=${MAINLINE_REF:-ad5cbfa911b975b2bf987d3bf7d8f2b3f36671ab}
CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES:-120}
HF_HUB_VERSION=${HF_HUB_VERSION:-2.4.0}
HF_XET_VERSION=${HF_XET_VERSION:-1.8.0}
JOBS=${BUILD_JOBS:-$(nproc)}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ "$SCRIPT_DIR" == /opt/locus ]] || { echo "copy this directory to /opt/locus first" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential cmake git ca-certificates libssl-dev \
  curl jq libgomp1 python3 python3-venv \
  procps pciutils dmidecode util-linux numactl tmux

fetch_ref() { # repo ref dir
  rm -rf "$3"; git init -q "$3"
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
  git -C "$3" log -1 --format="%H %cI" > "$3/.locus-ref"
}

# ik_llama.cpp: only the CPU variant this host can run (the image builds both).
if grep -qw avx512_bf16 /proc/cpuinfo && grep -qw avx512_vnni /proc/cpuinfo && grep -qw avx512vbmi /proc/cpuinfo; then
  v=zen4
  cpu="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX512=ON -DGGML_AVX512_VBMI=ON -DGGML_AVX512_VNNI=ON -DGGML_AVX512_BF16=ON"
  march="-march=x86-64-v4 -mavx512vnni -mavx512vbmi -mavx512bf16"
else
  v=v3
  cpu="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"
  march="-march=x86-64-v3"
fi
echo "== ik_llama.cpp ($v) =="
fetch_ref "$IK_REPO" "$IK_REF" /src/ik
# shellcheck disable=SC2086  # $cpu is a list of flags
cmake -S /src/ik -B "/build/ik-$v" \
  -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF $cpu \
  -DCMAKE_C_FLAGS="$march" -DCMAKE_CXX_FLAGS="$march" \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
  -DBUILD_SHARED_LIBS=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build "/build/ik-$v" --config Release -j "$JOBS" --target llama-server llama-bench
mkdir -p "/opt/ik/$v/bin"
cp "/build/ik-$v/bin/llama-server" "/build/ik-$v/bin/llama-bench" "/opt/ik/$v/bin/"
cp /src/ik/.locus-ref /opt/ik/REF

echo "== mainline llama.cpp =="
fetch_ref "$MAINLINE_REPO" "$MAINLINE_REF" /src/mainline
cmake -S /src/mainline -B /build/mainline \
  -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
  -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build /build/mainline --config Release -j "$JOBS"
mkdir -p /opt/mainline/bin
cp /build/mainline/bin/llama-server /build/mainline/bin/llama-bench /opt/mainline/bin/
find /build/mainline -name '*.so*' -exec cp -P {} /opt/mainline/bin/ \;
cp /src/mainline/.locus-ref /opt/mainline/REF
rm -rf /build

echo "== tools =="
python3 -m venv /opt/venv
/opt/venv/bin/pip install --no-cache-dir -q "huggingface_hub==${HF_HUB_VERSION}" "hf_xet==${HF_XET_VERSION}"
chmod +x /opt/locus/*.sh
for n in llama-server-ik llama-bench-ik llama-server-mainline llama-bench-mainline; do
  ln -sf /opt/locus/llama-wrapper.sh "/usr/local/bin/$n"
done
cat > /etc/profile.d/locus.sh <<'EOF'
export PATH=/opt/venv/bin:/opt/locus:$PATH
export HF_XET_HIGH_PERFORMANCE=1 HF_HUB_DISABLE_TELEMETRY=1
EOF
mkdir -p /workspace
echo "setup done: ik $(cat /opt/ik/REF) | mainline $(cat /opt/mainline/REF)"
