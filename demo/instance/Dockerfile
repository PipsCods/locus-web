# syntax=docker/dockerfile:1.7
#
# locus demo instance image: ik_llama.cpp + mainline llama.cpp built for the
# RTX 5090 (sm_120), plus the tools the start script and the benchmark need.
# Weights are NOT baked in; they are downloaded at boot (see onstart.sh).
#
# Build from the repo root:
#   docker build -t <registry>/locus-instance:<tag> demo/instance
#
# Every upstream input is pinned through a build arg. The defaults are the
# commits the flags in bench.sh / onstart.sh were checked against (2026-11-16).

# CUDA 13.0 because the oldest driver among verified single-5090 Vast offers
# is the 580 branch (cuda_max_good 13.0). nvidia/cuda images carry
# NVIDIA_REQUIRE_CUDA=cuda>=<this version>, so a 13.4 image would refuse to
# start on those hosts. find-offer.sh filters on cuda_vers >= this version.
ARG CUDA_VERSION=13.0.3
ARG UBUNTU_VERSION=24.04

############################################################################
# Shared build toolchain
############################################################################
FROM docker.io/nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS toolchain

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates libssl-dev \
 && rm -rf /var/lib/apt/lists/*

# Fetch one exact ref (commit SHA or tag) without cloning the full history.
# usage: fetch-ref <repo-url> <ref> <dir>
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
      'git init -q "$3"' \
      'git -C "$3" remote add origin "$1"' \
      'git -C "$3" fetch -q --depth 1 origin "$2"' \
      'git -C "$3" checkout -q FETCH_HEAD' \
      'git -C "$3" log -1 --format="%H %cI" > "$3/.locus-ref"' \
      > /usr/local/bin/fetch-ref \
 && chmod +x /usr/local/bin/fetch-ref

############################################################################
# ik_llama.cpp
#
# ik has no runtime CPU dispatch (no GGML_BACKEND_DL / CPU_ALL_VARIANTS), and
# GGML_NATIVE would tune for the build machine, not the Vast host. So we build
# one static binary set per CPU class and pick at runtime (llama-wrapper.sh):
#   v3   = x86-64-v3 (AVX2/FMA/F16C): EPYC Zen2/Zen3, older Xeons
#   zen4 = x86-64-v4 + VNNI/VBMI/BF16: EPYC Zen4/Zen5, Sapphire Rapids and up.
#          This is what enables ik's HAVE_FANCY_SIMD kernels.
# Each variant compiles the CUDA kernels again; drop one with
# --build-arg IK_CPU_VARIANTS=zen4 if build time matters more than coverage.
############################################################################
FROM toolchain AS ik

ARG IK_REPO=https://github.com/ikawrakow/ik_llama.cpp
ARG IK_REF=a6383da414f74c944999e7b9312a5a5d76191f6b
ARG CUDA_ARCHITECTURES=120
ARG IK_CPU_VARIANTS="v3 zen4"
ARG BUILD_JOBS=

RUN fetch-ref "$IK_REPO" "$IK_REF" /src/ik

RUN set -eu; \
    for v in $IK_CPU_VARIANTS; do \
      case "$v" in \
        v3)   cpu="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; \
              march="-march=x86-64-v3" ;; \
        zen4) cpu="-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_AVX512=ON -DGGML_AVX512_VBMI=ON -DGGML_AVX512_VNNI=ON -DGGML_AVX512_BF16=ON"; \
              march="-march=x86-64-v4 -mavx512vnni -mavx512vbmi -mavx512bf16" ;; \
        *) echo "unknown IK_CPU_VARIANTS entry: $v" >&2; exit 1 ;; \
      esac; \
      cmake -S /src/ik -B /build/ik-$v \
        -DCMAKE_BUILD_TYPE=Release \
        -DGGML_NATIVE=OFF $cpu \
        -DCMAKE_C_FLAGS="$march" -DCMAKE_CXX_FLAGS="$march" \
        -DGGML_CUDA=ON \
        -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
        -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_BUILD_TESTS=OFF \
        -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined; \
      cmake --build /build/ik-$v --config Release -j ${BUILD_JOBS:-$(nproc)} \
        --target llama-server llama-bench; \
      mkdir -p /opt/ik/$v/bin; \
      cp /build/ik-$v/bin/llama-server /build/ik-$v/bin/llama-bench /opt/ik/$v/bin/; \
    done; \
    cp /src/ik/.locus-ref /opt/ik/REF; \
    rm -rf /build

############################################################################
# mainline llama.cpp
#
# Built the way upstream's own CUDA image is (.devops/cuda.Dockerfile):
# dynamic backends with every CPU variant, chosen at load time. Mainline turns
# CUDA arch 120 into 120a itself (ggml/src/ggml-cuda/CMakeLists.txt).
############################################################################
FROM toolchain AS mainline

ARG MAINLINE_REPO=https://github.com/ggml-org/llama.cpp
ARG MAINLINE_REF=ad5cbfa911b975b2bf987d3bf7d8f2b3f36671ab
ARG CUDA_ARCHITECTURES=120
ARG BUILD_JOBS=

RUN fetch-ref "$MAINLINE_REPO" "$MAINLINE_REF" /src/mainline

RUN set -eu; \
    cmake -S /src/mainline -B /build/mainline \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_NATIVE=OFF \
      -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
      -DGGML_CUDA=ON \
      -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
      -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
      -DCMAKE_EXE_LINKER_FLAGS=-Wl,--allow-shlib-undefined; \
    cmake --build /build/mainline --config Release -j ${BUILD_JOBS:-$(nproc)}; \
    mkdir -p /opt/mainline/bin; \
    cp /build/mainline/bin/llama-server /build/mainline/bin/llama-bench /opt/mainline/bin/; \
    find /build/mainline -name '*.so*' -exec cp -P {} /opt/mainline/bin/ \; ; \
    cp /src/mainline/.locus-ref /opt/mainline/REF; \
    rm -rf /build

############################################################################
# Runtime image
############################################################################
FROM docker.io/nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION} AS runtime

ARG CLOUDFLARED_VERSION=2026.11.0
ARG CLOUDFLARED_SHA256=5305dbaf62984e92e7daa29cdd6a35a4797edc23385d4c5b8422ff97eb96a19b
ARG HF_HUB_VERSION=2.4.0
ARG HF_XET_VERSION=1.8.0
ARG VASTAI_VERSION=1.11.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl jq libgomp1 libssl3 \
      python3 python3-venv \
      procps pciutils dmidecode util-linux numactl tmux \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    curl -fsSL -o /tmp/cloudflared.deb \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb"; \
    echo "${CLOUDFLARED_SHA256}  /tmp/cloudflared.deb" | sha256sum -c -; \
    dpkg -i /tmp/cloudflared.deb; \
    rm /tmp/cloudflared.deb; \
    cloudflared --version

# hf CLI with Xet high-performance transfer (hf_transfer is deprecated in
# huggingface_hub 2.x; HF_XET_HIGH_PERFORMANCE replaces it) and the vastai CLI
# (used by the in-container self-destruct timer).
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir \
      "huggingface_hub==${HF_HUB_VERSION}" "hf_xet==${HF_XET_VERSION}" "vastai==${VASTAI_VERSION}" \
 && /opt/venv/bin/hf version \
 && /opt/venv/bin/vastai --version

COPY --from=ik /opt/ik /opt/ik
COPY --from=mainline /opt/mainline /opt/mainline

COPY llama-wrapper.sh onstart.sh bench.sh /opt/locus/
COPY prompts/ /opt/locus/prompts/
RUN chmod +x /opt/locus/*.sh \
 && for n in llama-server-ik llama-bench-ik llama-server-mainline llama-bench-mainline; do \
      ln -s /opt/locus/llama-wrapper.sh /usr/local/bin/$n; \
    done

ENV PATH=/opt/venv/bin:/opt/locus:$PATH \
    HF_XET_HIGH_PERFORMANCE=1 \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /workspace

# Entrypoint launch mode runs the demo directly. In Vast's ssh/jupyter launch
# modes the entrypoint is replaced and the onstart field calls onstart.sh
# instead (see README.md).
CMD ["/opt/locus/onstart.sh"]
