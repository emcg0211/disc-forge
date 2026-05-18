'use strict';
/**
 * menu-builder.js — Tier 2 interactive menu generator for BD-ROM discs.
 *
 * Generates a minimal 2-button IG display set for use as a disc menu.
 * The display set is suitable for injection into a menu m2ts alongside
 * a solid-color background video.
 *
 * Architecture:
 *   buildMenuDisplaySet(options) → Buffer (TS-packetized IG PES stream)
 *     → renderButtonPixels(...)        creates RLE-ready palette-indexed bitmaps
 *     → ig-encoder.buildIGDisplaySet() assembles the full BD IG display set
 *
 * Palette:
 *   0 = transparent (background video shows through)
 *   1 = white text/border
 *   2 = red/orange highlight (selected button)
 *   3 = dark gray (normal button)
 *
 * Button layout (1920×1080 canvas):
 *   Button 1 (obj 0/1/2): 800×90 at (560, 420)  — Episode 1 → PLAY_PL(0)
 *   Button 2 (obj 3/4/5): 800×90 at (560, 540)  — Episode 2 → PLAY_PL(1)
 *   (3 object IDs per button: normal=0, selected=1, activated=2)
 */

const { buildNavCmd, buildIGDisplaySet, encodePDS, encodeODS, encodeWDS, encodeICS, encodeEND, encodeRLE, wrapInPES, buildSegment, SEG } = require('./ig-encoder');

// ── Palette definition ─────────────────────────────────────────────────────────
// YCbCr-601 values. T=0 opaque, T=255 fully transparent.
const PALETTE = [
  { id: 0, Y: 16,  Cr: 128, Cb: 128, T: 255 },  // transparent
  { id: 1, Y: 235, Cr: 128, Cb: 128, T:   0 },  // white
  { id: 2, Y:  76, Cr: 210, Cb:  85, T:   0 },  // red (selected highlight)
  { id: 3, Y:  64, Cr: 128, Cb: 128, T: 160 },  // semi-transparent dark gray
];

// ── Button geometry ───────────────────────────────────────────────────────────
const BTN_W   = 800;
const BTN_H   = 90;
const BTN1_X  = 560;
const BTN1_Y  = 420;
const BTN2_X  = 560;
const BTN2_Y  = 540;
const BORDER  = 3;  // border thickness in pixels

// IG stream PID (0x1200 is standard for BD IG)
const IG_PID = 0x1200;

/**
 * Render a button bitmap as a palette-indexed pixel array.
 * state: 'normal' | 'selected' | 'activated'
 *
 * @param {number} w - button width
 * @param {number} h - button height
 * @param {'normal'|'selected'|'activated'} state
 * @returns {Uint8Array} palette-indexed pixels (w*h bytes)
 */
function renderButtonPixels(w, h, state) {
  const bgIdx     = state === 'normal' ? 3 : 2;   // 3=gray, 2=red
  const borderIdx = 1;                              // white border
  const pixels    = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isBorder = x < BORDER || x >= w - BORDER || y < BORDER || y >= h - BORDER;
      pixels[y * w + x] = isBorder ? borderIdx : bgIdx;
    }
  }
  return pixels;
}

/**
 * Build the complete IG display set for a 2-button menu.
 *
 * Object IDs:
 *   0 = btn1 normal,  1 = btn1 selected,  2 = btn1 activated
 *   3 = btn2 normal,  4 = btn2 selected,  5 = btn2 activated
 *
 * Button IDs:
 *   0 = Episode 1 button → PLAY_PL(0)
 *   1 = Episode 2 button → PLAY_PL(1)
 *
 * @param {object} opts
 * @param {number} opts.videoWidth   - video frame width (default 1920)
 * @param {number} opts.videoHeight  - video frame height (default 1080)
 * @param {number} opts.pl1          - playlist ID for episode 1 button (default 0)
 * @param {number} opts.pl2          - playlist ID for episode 2 button (default 1)
 * @param {number} opts.pts          - PTS for the display set in 90kHz ticks (default 0)
 * @returns {Buffer} TS-packetized IG PES stream (188-byte packets)
 */
function buildMenuDisplaySet({ videoWidth = 1920, videoHeight = 1080, pl1 = 0, pl2 = 1, pts = 0 } = {}) {
  // Render button bitmaps for all 6 object states
  const btn1Normal   = renderButtonPixels(BTN_W, BTN_H, 'normal');
  const btn1Selected = renderButtonPixels(BTN_W, BTN_H, 'selected');
  const btn1Activ    = renderButtonPixels(BTN_W, BTN_H, 'activated');
  const btn2Normal   = renderButtonPixels(BTN_W, BTN_H, 'normal');
  const btn2Selected = renderButtonPixels(BTN_W, BTN_H, 'selected');
  const btn2Activ    = renderButtonPixels(BTN_W, BTN_H, 'activated');

  // Nav commands: button activation → PLAY_PL(playlist ID)
  const cmd1 = buildNavCmd('PLAY_PL', pl1);
  const cmd2 = buildNavCmd('PLAY_PL', pl2);

  return buildIGDisplaySet({
    composition: {
      videoWidth,
      videoHeight,
      frameRate:        0x40,  // 24fps
      compositionNumber: 0,
      compositionState:  2,    // epoch_start (fresh display set)
      streamModel:       false, // ODS in same stream as ICS
      uiModel:           false, // always-on (not popup)
      userTimeoutMs:     0,    // no timeout
      pages: [{
        id:      0,
        version: 0,
        uoMask:  Buffer.alloc(8),  // all UO flags enabled (0 = allow)
        animationFrameRateCode:       0,
        defaultSelectedButtonIdRef:   0,   // start with btn1 selected
        defaultActivatedButtonIdRef:  0xFFFF,
        paletteIdRef: 0,
        bogs: [
          // BOG 0: Episode 1 button
          {
            defaultValidButtonIdRef: 0,
            buttons: [{
              id:                 0,
              numericSelectValue: 1,
              autoActionFlag:     false,
              x:                  BTN1_X,
              y:                  BTN1_Y,
              upperBtnId:         1,     // wrap around to btn2
              lowerBtnId:         1,     // down → btn2
              leftBtnId:          0,     // stay
              rightBtnId:         0,     // stay
              normalStartObjId:   0,  normalEndObjId: 0,  normalRepeat: false,
              selectedSoundId:    0,
              selStartObjId:      1,  selEndObjId: 1,  selRepeat: false,
              activatedSoundId:   0,
              actStartObjId:      2,  actEndObjId: 2,
              navCmds: [cmd1],
            }],
          },
          // BOG 1: Episode 2 button
          {
            defaultValidButtonIdRef: 1,
            buttons: [{
              id:                 1,
              numericSelectValue: 2,
              autoActionFlag:     false,
              x:                  BTN2_X,
              y:                  BTN2_Y,
              upperBtnId:         0,     // up → btn1
              lowerBtnId:         0,     // wrap around to btn1
              leftBtnId:          1,     // stay
              rightBtnId:         1,     // stay
              normalStartObjId:   3,  normalEndObjId: 3,  normalRepeat: false,
              selectedSoundId:    0,
              selStartObjId:      4,  selEndObjId: 4,  selRepeat: false,
              activatedSoundId:   0,
              actStartObjId:      5,  actEndObjId: 5,
              navCmds: [cmd2],
            }],
          },
        ],
      }],
    },
    palette: { paletteId: 0, version: 0, entries: PALETTE },
    windows: [
      { id: 0, x: BTN1_X, y: BTN1_Y, width: BTN_W, height: BTN_H },
      { id: 1, x: BTN2_X, y: BTN2_Y, width: BTN_W, height: BTN_H },
    ],
    objects: [
      { objectId: 0, version: 0, width: BTN_W, height: BTN_H, pixels: btn1Normal   },
      { objectId: 1, version: 0, width: BTN_W, height: BTN_H, pixels: btn1Selected },
      { objectId: 2, version: 0, width: BTN_W, height: BTN_H, pixels: btn1Activ    },
      { objectId: 3, version: 0, width: BTN_W, height: BTN_H, pixels: btn2Normal   },
      { objectId: 4, version: 0, width: BTN_W, height: BTN_H, pixels: btn2Selected },
      { objectId: 5, version: 0, width: BTN_W, height: BTN_H, pixels: btn2Activ    },
    ],
    pid: IG_PID,
    pts,
  });
}

/**
 * Convert 188-byte TS packets to 192-byte BD m2ts format.
 * BD m2ts prepends a 4-byte arrival timestamp (in 27MHz ticks) to each packet.
 *
 * @param {Buffer} tsPackets - raw 188-byte TS packets
 * @param {number} baseTimestamp - 27MHz timestamp for first packet
 * @returns {Buffer} 192-byte BD m2ts packets
 */
function convertTsBdFormat(tsPackets, baseTimestamp = 0) {
  if (tsPackets.length % 188 !== 0) {
    throw new Error(`TS packet stream not aligned to 188 bytes (got ${tsPackets.length} bytes)`);
  }
  const numPackets = tsPackets.length / 188;
  const out = Buffer.alloc(numPackets * 192);
  for (let i = 0; i < numPackets; i++) {
    const ts = baseTimestamp + i * 300;  // 300 = 1 tick spacing (27MHz / 90kHz)
    // 4-byte timestamp: top 30 bits are the 27MHz clock value
    // >>> 0 converts signed 32-bit result to unsigned for writeUInt32BE
    out.writeUInt32BE(((ts & 0x3FFFFFFF) | 0x80000000) >>> 0, i * 192);
    tsPackets.copy(out, i * 192 + 4, i * 188, (i + 1) * 188);
  }
  return out;
}

/**
 * Inject IG TS packets into an existing BD m2ts stream.
 *
 * The IG packets are inserted after the initial PAT/PMT packets (first 10
 * 192-byte packets) so the player sees IG data early in the stream.
 * This is a "dirty injection" — the PMT is NOT updated to list the IG PID.
 * libbluray uses the CLPI STN_table to discover stream PIDs, not the PMT,
 * so this works if the CLPI is patched to declare the IG stream.
 *
 * @param {Buffer} videoM2ts  - 192-byte BD m2ts video stream
 * @param {Buffer} igTs188    - 188-byte TS IG stream (from wrapInPES / buildMenuDisplaySet)
 * @param {number} insertAfterN - insert after this many 192-byte packets (default 10)
 * @returns {Buffer} combined 192-byte BD m2ts
 */
function injectIGIntoM2ts(videoM2ts, igTs188, insertAfterN = 10) {
  if (videoM2ts.length % 192 !== 0) {
    throw new Error(`Video m2ts not aligned to 192 bytes (${videoM2ts.length} bytes)`);
  }
  const igBd = convertTsBdFormat(igTs188);
  const insertAt = Math.min(insertAfterN * 192, videoM2ts.length);
  return Buffer.concat([
    videoM2ts.slice(0, insertAt),
    igBd,
    videoM2ts.slice(insertAt),
  ]);
}

/**
 * Patch the CLPI STN_table to declare an IG stream at PID 0x1200.
 *
 * WARNING: This is a best-effort binary patch. CLPI parsing is complex;
 * this modifies a specific known location in tsMuxeR-produced CLPIs where
 * num_IG (stream count byte for IG streams) is guaranteed to be 0x00.
 *
 * The CLPI ProgramInfo STN_table layout (BD-ROM spec):
 *   STN_table:
 *     length(2) reserved(2) reserved(2) num_Video(1) num_Audio(1)
 *     num_PG(1) num_IG(1) num_SecondaryAudio(1) num_SecondaryVideo(1)
 *     num_PiP_PG(1) reserved(4)
 *     [video stream entries]
 *     [audio stream entries]
 *     [PG stream entries]
 *     [IG stream entries] ← we need to ADD one entry here
 *
 * Since we're adding a new stream entry, the STN_table length field also
 * needs updating. This function does NOT handle that — it is marked as
 * INCOMPLETE and left for the next implementation phase.
 *
 * @param {Buffer} clpiBuf - CLPI file buffer (will be modified in place)
 * @param {number} programInfoAddr - offset to ProgramInfo section (from header)
 * @returns {boolean} true if patch succeeded
 */
function patchClpiForIG(clpiBuf, programInfoAddr) {
  // IG stream entry to append to STN_table:
  // stream_pid(2) + stream_type(1=0x91) + ref_to_stream_pid_of_mainClip(2)
  // + StreamCodingInfo: coding_type(1=0x91) + reserved(6) + (no language)
  // Standard IG stream entry in STN_table is 9 bytes:
  //   stream_pid(2) | coding_type(1) | reserved(6)
  // But the exact format requires reverse-engineering the real CLPI.
  // INCOMPLETE — left for next session.
  return false;
}

module.exports = {
  buildMenuDisplaySet,
  convertTsBdFormat,
  injectIGIntoM2ts,
  patchClpiForIG,
  IG_PID,
  BTN_W, BTN_H, BTN1_X, BTN1_Y, BTN2_X, BTN2_Y,
  PALETTE,
};
