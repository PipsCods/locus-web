#!/bin/bash
# usage: export.sh manifest.tsv  — renders each SVG to a transparent PNG at the requested width
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
render() {
  svg="$1"; png="$2"; px="$3"
  head=$(grep -o '<svg[^>]*' "$svg" | head -1)
  w=$(echo "$head" | sed -E 's/.* width="([0-9.]+)".*/\1/'); h=$(echo "$head" | sed -E 's/.* height="([0-9.]+)".*/\1/')
  scale=$(python3 -c "print($px/$w)")
  mkdir -p "$(dirname "$png")"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --user-data-dir="$(mktemp -d)" --force-device-scale-factor=$scale --window-size=$w,$h \
    --screenshot="$png" "file://$svg" >/dev/null 2>&1
}
export -f render; export CHROME
tr '\t' '\n' < "$1" | xargs -n 3 -P 6 bash -c 'render "$0" "$1" "$2"'
