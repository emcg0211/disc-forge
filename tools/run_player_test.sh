#!/usr/bin/env bash
# run_player_test.sh — Multi-player IG menu test harness
#
# Usage: ./run_player_test.sh <iso_path> <player>  [wait_seconds]
#   player: vlc | mpv
#   wait_seconds: stabilization delay (default 8)
#
# Outputs:
#   /tmp/player_test_<player>.log — verbose player log
#   /tmp/player_test_<player>.png — screencap at t+wait
#   /tmp/player_test_<player>_debug.png — annotated pixel-test debug PNG
#
# Exit 0 = PASS (pixel test), 1 = FAIL.

set -euo pipefail

ISO="${1:-}"
PLAYER="${2:-mpv}"
WAIT="${3:-8}"
VLC="/Applications/VLC.app/Contents/MacOS/VLC"
MPV="/opt/homebrew/bin/mpv"
PYTHON3="/usr/bin/python3"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$TOOLS/verify_menu_buttons.py"

if [[ -z "$ISO" ]]; then
    echo "Usage: $0 <iso_path> <vlc|mpv> [wait_seconds]"
    exit 1
fi

if [[ ! -f "$ISO" ]]; then
    echo "ERROR: ISO not found: $ISO"
    exit 1
fi

LOG="/tmp/player_test_${PLAYER}.log"
SHOT="/tmp/player_test_${PLAYER}.png"
DBUG="/tmp/player_test_${PLAYER}_debug.png"

echo "=== Player test: $PLAYER ==="
echo "ISO:  $ISO"
echo "Wait: ${WAIT}s"
echo "Log:  $LOG"
echo "Shot: $SHOT"

# Detach stale TEST volumes
for vol in /Volumes/TEST* /Volumes/V1103*; do
    [[ -d "$vol" ]] && hdiutil detach "$vol" -force 2>/dev/null || true
done

# Mount ISO
echo "Mounting ISO..."
MOUNT_OUT=$(hdiutil attach "$ISO" -readonly -noverify 2>&1)
MOUNT_PT=$(echo "$MOUNT_OUT" | tail -1 | awk -F'\t' '{print $NF}' | xargs)
if [[ -z "$MOUNT_PT" || ! -d "$MOUNT_PT" ]]; then
    echo "ERROR: hdiutil mount failed"
    echo "$MOUNT_OUT"
    exit 1
fi
echo "Mounted at: $MOUNT_PT"

PLAYER_PID=""
EXIT_CODE=1

cleanup() {
    if [[ -n "$PLAYER_PID" ]]; then
        kill "$PLAYER_PID" 2>/dev/null || true
        sleep 1
        kill -9 "$PLAYER_PID" 2>/dev/null || true
    fi
    hdiutil detach "$MOUNT_PT" -force 2>/dev/null || true
}
trap cleanup EXIT

# Launch player
echo "Launching $PLAYER..."
if [[ "$PLAYER" == "vlc" ]]; then
    if [[ ! -x "$VLC" ]]; then
        echo "ERROR: VLC not found at $VLC"
        exit 1
    fi
    # VLC: headless BD playback with verbose logging
    BD_DEBUG_MASK=0xFFFF "$VLC" \
        -vvv \
        --video-on-top \
        --intf dummy \
        --no-embedded-video \
        --bluray-menu \
        "bluray://${MOUNT_PT}/" \
        > "$LOG" 2>&1 &
    PLAYER_PID=$!

elif [[ "$PLAYER" == "mpv" ]]; then
    if [[ ! -x "$MPV" ]]; then
        echo "ERROR: mpv not found at $MPV"
        exit 1
    fi
    # mpv: BD playback with overlay support
    BD_DEBUG_MASK=0xFFFF "$MPV" \
        --v \
        --log-file="$LOG" \
        --osd-level=0 \
        --no-sub \
        "bd://" \
        --bluray-device="$MOUNT_PT" \
        &
    PLAYER_PID=$!
else
    echo "ERROR: Unknown player: $PLAYER"
    exit 1
fi

echo "Player PID: $PLAYER_PID"
echo "Waiting ${WAIT}s for decoder stabilization..."
sleep "$WAIT"

# Check player is still running
if ! kill -0 "$PLAYER_PID" 2>/dev/null; then
    echo "WARNING: player exited early"
fi

# Screencap (macOS screencapture -x = no click sound, silent)
echo "Taking screenshot..."
screencapture -x "$SHOT" 2>/dev/null || \
    screencapture "$SHOT" 2>/dev/null || \
    { echo "ERROR: screencapture failed"; exit 1; }

echo "Screenshot: $SHOT ($(wc -c < "$SHOT") bytes)"

# Kill player
kill "$PLAYER_PID" 2>/dev/null || true
sleep 1
kill -9 "$PLAYER_PID" 2>/dev/null || true
PLAYER_PID=""

# Pixel verification
echo ""
echo "Running pixel verifier..."
"$PYTHON3" "$VERIFY" "$SHOT" --debug-png "$DBUG"
EXIT_CODE=$?

# Print last 80 lines of player log
echo ""
echo "--- Last 80 lines of $PLAYER log ---"
if [[ -f "$LOG" ]]; then
    grep -i "overlay\|libbluray\|IG\|button\|BD_\|bluray\|menu\|interactive\|GC_CTRL" "$LOG" 2>/dev/null | tail -40 || true
    echo "..."
    tail -20 "$LOG" || true
fi

echo ""
echo "=== RESULT: $([ $EXIT_CODE -eq 0 ] && echo PASS || echo FAIL) ==="
exit $EXIT_CODE
