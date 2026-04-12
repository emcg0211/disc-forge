#!/bin/bash
# Disc Forge Dependency Bundler
# Run once before building: ./download-deps.sh

set -e

BOLD='\033[1m'; GOLD='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; DIM='\033[2m'; NC='\033[0m'
step() { echo -e "\n${GOLD}  → ${1}${NC}"; }
ok()   { echo -e "  ${GREEN}✓ ${1}${NC}"; }
dim()  { echo -e "  ${DIM}${1}${NC}"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   💿  Disc Forge Dependency Bundler  💿   ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
mkdir -p bin

# ── FFmpeg ────────────────────────────────────────────────────────────────────
# A distributable bundle requires statically linked binaries.  Homebrew ffmpeg
# is dynamically linked against Cellar dylibs that don't exist on other machines.
# We detect dynamic linking and always download the static build in that case.

is_static() {
  # Returns 0 (true) if the binary has no non-system dynamic dependencies
  local deps
  deps=$(otool -L "$1" 2>/dev/null | grep -v ':$' | grep -v '/System/' | grep -v '/usr/lib/' | grep -v "$1" | wc -l | tr -d ' ')
  [ "$deps" -eq 0 ]
}

download_static_ffmpeg() {
  step "Downloading FFmpeg static build from evermeet.cx..."
  mkdir -p /tmp/df_deps
  curl -L "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"  -o /tmp/df_deps/ffmpeg.zip  --progress-bar
  unzip -o /tmp/df_deps/ffmpeg.zip  -d /tmp/df_deps/ff_out  > /dev/null
  chmod -f +w bin/ffmpeg bin/ffprobe 2>/dev/null || true
  cp /tmp/df_deps/ff_out/ffmpeg  bin/ffmpeg  && chmod +x bin/ffmpeg
  curl -L "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o /tmp/df_deps/ffprobe.zip --progress-bar
  unzip -o /tmp/df_deps/ffprobe.zip -d /tmp/df_deps/fp_out > /dev/null
  chmod -f +w bin/ffmpeg bin/ffprobe 2>/dev/null || true
  cp /tmp/df_deps/fp_out/ffprobe bin/ffprobe && chmod +x bin/ffprobe
  rm -rf /tmp/df_deps
  ok "FFmpeg static build downloaded and bundled"
}

if [ -f "bin/ffmpeg" ] && [ -f "bin/ffprobe" ]; then
  if is_static "bin/ffmpeg"; then
    ok "FFmpeg already bundled (static)"
  else
    echo -e "  ${GOLD}⚠ Bundled FFmpeg is dynamically linked — replacing with static build${NC}"
    download_static_ffmpeg
  fi
else
  FFMPEG_PATH=$(which ffmpeg 2>/dev/null || echo "")
  FFPROBE_PATH=$(which ffprobe 2>/dev/null || echo "")
  if [ -n "$FFMPEG_PATH" ] && [ -n "$FFPROBE_PATH" ] && is_static "$FFMPEG_PATH"; then
    cp "$FFMPEG_PATH" bin/ffmpeg && cp "$FFPROBE_PATH" bin/ffprobe
    chmod +x bin/ffmpeg bin/ffprobe
    ok "FFmpeg bundled from system (static)"
  else
    download_static_ffmpeg
  fi
fi

# ── tsMuxeR ───────────────────────────────────────────────────────────────────
if [ -f "bin/tsMuxeR" ]; then
  ok "tsMuxeR already bundled"
else
  step "Bundling tsMuxeR..."
  TSMUXER_PATH=$(which tsMuxeR 2>/dev/null || which tsmuxer 2>/dev/null || echo "")
  if [ -n "$TSMUXER_PATH" ]; then
    cp "$TSMUXER_PATH" bin/tsMuxeR && chmod +x bin/tsMuxeR
    ok "tsMuxeR bundled from $TSMUXER_PATH"
  elif [ -f "$HOME/Downloads/tsMuxer-master/build/tsMuxer/tsmuxer" ]; then
    cp "$HOME/Downloads/tsMuxer-master/build/tsMuxer/tsmuxer" bin/tsMuxeR && chmod +x bin/tsMuxeR
    ok "tsMuxeR bundled from build directory"
  elif [ -f "/Applications/tsMuxeR.app/Contents/MacOS/tsMuxeR" ]; then
    cp "/Applications/tsMuxeR.app/Contents/MacOS/tsMuxeR" bin/tsMuxeR && chmod +x bin/tsMuxeR
    ok "tsMuxeR bundled from /Applications"
  else
    echo -e "  ${GOLD}⚠️  tsMuxeR not found — app will use fallback BDMV writer${NC}"
    echo "     For full hardware player support, build from:"
    echo "     https://github.com/justdan96/tsMuxeR"
  fi
fi

echo ""
echo -e "  ${GREEN}${BOLD}Done!${NC} Run ./build.sh next."
ls -lh bin/ 2>/dev/null | grep -v total
