#!/usr/bin/env bash
# Install the Strata Terminal (the `strata` command) from one pinned release.
# Called by the Dockerfile and by setup-on-box.sh, so the pin lives here only.
#
# Steps, the same ones the 2026-11-21 RTX 3090 benchmark ran:
#   1. fetch the release's install.sh and check it against the SHA-256 below
#      (the value the release's SHA256SUMS.txt lists);
#   2. run it with STRATA_FEED set to this release's folder, not "latest".
#      install.sh checks the Terminal archive's SHA-256 against the release's
#      install-manifest.txt and then the release's signed feed;
#   3. check that the Terminal build it installed is this release's.
# The engine (about 580 MB, per graphics card) is not installed here: the first
# `strata launch` on the GPU machine fetches it from the same release folder,
# checks its signature and test-starts it. The release folder is written to
# STRATA_FEED_FILE (/opt/locus/strata-feed) for onstart.sh to pass as --feed.
#
# Release v0.2.17 is commit 12d491da4a6904eb49aaa6f2f63ec4b1a17582e3
# (Terminal / engine build 0.1.63).
#
# Settings: STRATA_VERSION (release tag), STRATA_INSTALL_SHA256 (of that
# release's install.sh), STRATA_TERMINAL_BUILD (the Terminal build that
# release's install-manifest.txt names), STRATA_BIN_DIR (where the `strata` link goes,
# default /usr/local/bin). The Terminal itself goes to install.sh's default,
# ~/.local/share/strata, as in the benchmark.
set -euo pipefail

STRATA_VERSION=${STRATA_VERSION:-v0.2.17}
STRATA_INSTALL_SHA256=${STRATA_INSTALL_SHA256:-9001ad878d0ea63f5a568b5b6feeb47757fed55c3f85f4ad3034dacf03e46545}
STRATA_TERMINAL_BUILD=${STRATA_TERMINAL_BUILD:-0.1.63}
STRATA_BIN_DIR=${STRATA_BIN_DIR:-/usr/local/bin}
STRATA_FEED_FILE=${STRATA_FEED_FILE:-/opt/locus/strata-feed}
feed="https://github.com/Niko1221/Strata/releases/download/$STRATA_VERSION"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --connect-timeout 15 --retry 3 --retry-delay 5 -o "$work/install.sh" "$feed/install.sh"
echo "$STRATA_INSTALL_SHA256  $work/install.sh" | sha256sum -c -
STRATA_FEED=$feed STRATA_BIN_DIR=$STRATA_BIN_DIR sh "$work/install.sh"

# install.sh unpacks the Terminal into terminal/<build> and points
# terminal/current at it; the build comes from the release's manifest.
current=$(readlink -f "${XDG_DATA_HOME:-$HOME/.local/share}/strata/terminal/current")
if [[ "${current##*/}" != "$STRATA_TERMINAL_BUILD" ]]; then
  echo "install-strata: expected Terminal build $STRATA_TERMINAL_BUILD, got ${current##*/}" >&2
  exit 1
fi
"$STRATA_BIN_DIR/strata" --version || true

# onstart.sh passes this to `strata launch --feed`, so the engine comes from
# the same release and not from Strata's "latest".
mkdir -p "$(dirname "$STRATA_FEED_FILE")"
echo "$feed" >"$STRATA_FEED_FILE"
