#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════╗
# ║   Disc Forge — One-Command macOS App Builder                     ║
# ║   Run this once to produce Disc Forge.app + .dmg installer       ║
# ╚═══════════════════════════════════════════════════════════════════╝
set -euo pipefail
cd "$(dirname "$0")"

# ── Colours ────────────────────────────────────────────────────────
C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
C_GOLD='\033[38;5;220m'; C_GREEN='\033[38;5;78m'
C_RED='\033[38;5;196m';  C_BLUE='\033[38;5;75m'
C_GREY='\033[38;5;240m'

step()  { echo -e "${C_BOLD}${C_GOLD}  →${C_RESET} ${C_BOLD}$1${C_RESET}"; }
ok()    { echo -e "${C_GREEN}  ✓${C_RESET} $1"; }
warn()  { echo -e "  ${C_GOLD}⚠${C_RESET}  $1"; }
fail()  { echo -e "${C_RED}  ✗${C_RESET} ${C_BOLD}$1${C_RESET}"; exit 1; }
dim()   { echo -e "${C_DIM}    $1${C_RESET}"; }

echo ""
echo -e "${C_GOLD}${C_BOLD}╔══════════════════════════════════════════╗${C_RESET}"
echo -e "${C_GOLD}${C_BOLD}║        💿  Disc Forge Builder  💿        ║${C_RESET}"
echo -e "${C_GOLD}${C_BOLD}╚══════════════════════════════════════════╝${C_RESET}"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────
step "Bundling dependencies"
if [ ! -f "bin/ffmpeg" ]; then
  dim "Running download-deps.sh to bundle FFmpeg and tsMuxeR..."
  ./download-deps.sh
else
  ok "Dependencies already bundled"
fi

step "Checking prerequisites"

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install with: brew install node"
fi
NODE_VER=$(node --version)
ok "Node.js $NODE_VER"

if ! command -v npm &>/dev/null; then fail "npm not found"; fi
ok "npm $(npm --version)"

if ! command -v sips &>/dev/null; then fail "sips not found — this script requires macOS"; fi
ok "sips (macOS built-in)"

# ── Icon ───────────────────────────────────────────────────────────
echo ""
step "Building app icon (.icns)"

ICONSET="assets/AppIcon.iconset"
mkdir -p "$ICONSET"

declare -a SIZES=(16 32 64 128 256 512)
for SZ in "${SIZES[@]}"; do
  sips -z $SZ $SZ assets/icon-1024.png   --out "${ICONSET}/icon_${SZ}x${SZ}.png"    &>/dev/null
  D2=$((SZ*2))
  sips -z $D2 $D2 assets/icon-1024.png  --out "${ICONSET}/icon_${SZ}x${SZ}@2x.png" &>/dev/null
done
sips -z 1024 1024 assets/icon-1024.png   --out "${ICONSET}/icon_512x512@2x.png"    &>/dev/null

iconutil -c icns "$ICONSET" -o assets/icon.icns
rm -rf "$ICONSET"
ok "assets/icon.icns ($(du -sh assets/icon.icns | cut -f1))"

# ── npm install ────────────────────────────────────────────────────
echo ""
step "Installing dependencies"
dim "Electron ~130 MB — this is a one-time download"

if [ -d node_modules/electron ]; then
  ok "Dependencies already installed (node_modules present)"
else
  npm install --prefer-offline --loglevel=error
  ok "Dependencies installed"
fi

# ── Build ──────────────────────────────────────────────────────────
echo ""
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BUILD_FLAG="--universal"
  step "Building universal binary (Intel + Apple Silicon)"
else
  BUILD_FLAG="--x64"
  step "Building Intel x64 binary"
fi
dim "This takes 2–5 minutes…"
echo ""

npm run build -- --mac $BUILD_FLAG 2>&1 \
  | grep -E --color=never '^\s+(•|✓|✗|building|packing|writing|created|error)' \
  || true

# ── Results ────────────────────────────────────────────────────────
echo ""
DMG=$(ls dist/*.dmg 2>/dev/null | head -1)
ZIP=$(ls dist/*.zip 2>/dev/null | head -1)
APP=$(find dist -name "Disc Forge.app" -maxdepth 3 2>/dev/null | head -1)

if [ -n "$DMG" ] || [ -n "$APP" ]; then
  echo -e "${C_GREEN}${C_BOLD}  ✓  Build complete!${C_RESET}"
  echo ""
  [ -n "$DMG" ] && echo -e "  ${C_GOLD}DMG${C_RESET}  $DMG  ${C_DIM}($(du -sh "$DMG" | cut -f1))${C_RESET}"
  [ -n "$ZIP" ] && echo -e "  ${C_BLUE}ZIP${C_RESET}  $ZIP  ${C_DIM}($(du -sh "$ZIP" | cut -f1))${C_RESET}"
  [ -n "$APP" ] && echo -e "  ${C_GREEN}APP${C_RESET}  $APP"
  echo ""
  echo -e "  ${C_BOLD}To install:${C_RESET} open the .dmg and drag ${C_GOLD}Disc Forge${C_RESET} to Applications"
  echo -e "  ${C_BOLD}First launch:${C_RESET} if macOS blocks it, go to"
  echo -e "               ${C_DIM}System Settings → Privacy & Security → Open Anyway${C_RESET}"
else
  echo -e "${C_GOLD}  Build output not found in dist/ — check the output above for errors${C_RESET}"
  echo -e "  You can still run the app directly: ${C_BOLD}npm start${C_RESET}"
fi
echo ""

# ── Patch asar to inject latest source files ──────────────────────────────
ASAR_PATH="dist/mac-universal/Disc Forge.app/Contents/Resources/app.asar"
ASAR_DIR="dist/mac-universal/Disc Forge.app/Contents/Resources/app"

if [ -f "$ASAR_PATH" ]; then
  step "Patching app.asar with latest source files"
  
  # Install asar tool if needed
  if ! npx asar --version &>/dev/null 2>&1; then
    dim "Installing asar tool..."
    npm install --save-dev @electron/asar --prefer-offline --loglevel=error
  fi

  # Extract, patch, repack
  rm -rf "$ASAR_DIR"
  npx asar extract "$ASAR_PATH" "$ASAR_DIR" 2>/dev/null
  cp src/main.js     "$ASAR_DIR/src/main.js"
  cp src/renderer.js "$ASAR_DIR/src/renderer.js"
  cp src/preload.js  "$ASAR_DIR/src/preload.js"
  cp src/styles.css  "$ASAR_DIR/src/styles.css"
  cp src/index.html  "$ASAR_DIR/src/index.html"
  npx asar pack "$ASAR_DIR" "$ASAR_PATH" 2>/dev/null
  rm -rf "$ASAR_DIR"
  ok "Source files patched into app.asar"

  # Also patch the installed app if present
  INSTALLED="/Applications/Disc Forge.app/Contents/Resources/app.asar"
  if [ -f "$INSTALLED" ]; then
    step "Updating installed app in /Applications"
    cp "$ASAR_PATH" "$INSTALLED"
    ok "Installed app updated — relaunch Disc Forge"
  fi
fi
