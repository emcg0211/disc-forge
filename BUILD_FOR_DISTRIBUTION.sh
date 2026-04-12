#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  Disc Forge — Full Distribution Build               ║
# ║  Produces a self-contained DMG with all deps inside  ║
# ╚══════════════════════════════════════════════════════╝
set -e
cd "$(dirname "$0")"

BOLD='\033[1m'; GOLD='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; NC='\033[0m'
step() { echo -e "\n${GOLD}${BOLD}→ ${1}${NC}"; }
ok()   { echo -e "  ${GREEN}✓ ${1}${NC}"; }
fail() { echo -e "  ${RED}✗ ${1}${NC}"; exit 1; }

echo ""
echo -e "${GOLD}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GOLD}${BOLD}║   💿  Disc Forge Distribution Builder  💿    ║${NC}"
echo -e "${GOLD}${BOLD}╚══════════════════════════════════════════════╝${NC}"

# Step 1: Bundle FFmpeg + tsMuxeR
step "Bundling FFmpeg and tsMuxeR"
./download-deps.sh

if [ ! -f "bin/ffmpeg" ] || [ ! -f "bin/ffprobe" ]; then
  fail "FFmpeg not bundled — check download-deps.sh output above"
fi
ok "FFmpeg bundled: $(bin/ffmpeg -version 2>&1 | head -1 | cut -d' ' -f1-3)"

if [ -f "bin/tsMuxeR" ]; then
  ok "tsMuxeR bundled"
else
  echo -e "  ${GOLD}⚠ tsMuxeR not bundled — fallback BDMV writer will be used${NC}"
fi

# Step 2: Check Node.js
step "Checking prerequisites"
command -v node >/dev/null || fail "Node.js not found: brew install node"
command -v npm  >/dev/null || fail "npm not found"
ok "Node.js $(node --version)"

# Step 3: Install npm deps
step "Installing Electron and build tools"
if [ -d node_modules/electron ]; then
  ok "Already installed"
else
  npm install --prefer-offline --loglevel=error
  ok "Installed"
fi

# Step 4: Build icon
step "Building app icon"
ICONSET="assets/AppIcon.iconset"
mkdir -p "$ICONSET"
for SZ in 16 32 64 128 256 512; do
  sips -z $SZ $SZ assets/icon-1024.png --out "${ICONSET}/icon_${SZ}x${SZ}.png" &>/dev/null
  sips -z $((SZ*2)) $((SZ*2)) assets/icon-1024.png --out "${ICONSET}/icon_${SZ}x${SZ}@2x.png" &>/dev/null
done
sips -z 1024 1024 assets/icon-1024.png --out "${ICONSET}/icon_512x512@2x.png" &>/dev/null
iconutil -c icns "$ICONSET" -o assets/icon.icns
rm -rf "$ICONSET"
ok "Icon built"

# Step 5: Build the app
step "Building universal app + DMG (this takes 3–5 minutes)"
npm run build 2>&1 | grep -E '^(  •|  ✓|  building|  packing|  created|error)' || true

# Step 6: Verify output
DMG=$(ls dist/*.dmg 2>/dev/null | head -1)
APP=$(find dist -name "Disc Forge.app" -maxdepth 4 2>/dev/null | head -1)

echo ""
if [ -n "$DMG" ]; then
  SIZE=$(du -sh "$DMG" | cut -f1)
  echo -e "${GREEN}${BOLD}  ✓ Build complete!${NC}"
  echo ""
  echo -e "  ${GOLD}DMG:${NC}  $DMG  (${SIZE})"
  [ -n "$APP" ] && echo -e "  ${GOLD}APP:${NC}  $APP"
  echo ""
  echo -e "  ${BOLD}Ready to distribute!${NC}"
  echo "  Upload the DMG to Gumroad, share the link — no other installs required."
  echo ""
  
  # Verify bundled binaries are inside the built app
  if [ -n "$APP" ]; then
    BUNDLED_FFMPEG="$APP/Contents/Resources/bin/ffmpeg"
    if [ -f "$BUNDLED_FFMPEG" ]; then
      ok "FFmpeg confirmed inside .app bundle"
    else
      echo -e "  ${GOLD}⚠ FFmpeg not found inside built .app — check extraResources config${NC}"
    fi
  fi
else
  fail "Build failed — no DMG found in dist/"
fi
