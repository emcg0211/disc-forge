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
// Entry 3 was T=160 (63% transparent) — near-invisible on dark background.
// Fixed to T=0 (opaque dark slate blue) so both buttons are clearly visible.
const PALETTE = [
  { id: 0, Y: 16,  Cr: 128, Cb: 128, T: 255 },  // transparent (background shows through)
  { id: 1, Y: 235, Cr: 128, Cb: 128, T:   0 },  // white border (both states)
  { id: 2, Y: 112, Cr: 184, Cb:  42, T:   0 },  // orange-yellow (selected fill)
  { id: 3, Y:  45, Cr: 103, Cb: 171, T:   0 },  // dark slate blue (normal fill)
];

// ── Button geometry ───────────────────────────────────────────────────────────
const BTN_W   = 800;
const BTN_H   = 90;
const BTN1_X  = 560;
const BTN1_Y  = 420;
const BTN2_X  = 560;
const BTN2_Y  = 540;
const BORDER  = 3;  // border thickness in pixels

// IG stream PID: BD spec assigns 0x1400-0x141F to Interactive Graphics.
// 0x1200-0x121F is reserved for Presentation Graphics (subtitles).
// libbluray IS_HDMV_PID_IG() checks range 0x1400-0x141F; using 0x1200
// causes gc_decode_ts() to route the data to the PG decoder instead of IG.
const IG_PID = 0x1400;

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
 * Patch a CLPI ProgramInfo section to declare an IG stream at IG_PID.
 *
 * CLPI ProgramInfo layout (confirmed from tsMuxeR-produced files):
 *   ProgramInfo section at piAddr (from header offset 0x0C):
 *     length(4)           number of bytes that follow this field
 *     reserved(1)
 *     number_of_programs(1)
 *     program_sequence[]:
 *       SPN(4) + PMT_PID(2) + num_streams(1) + num_groups(1) = 8 bytes
 *       stream_entries[]:
 *         PID(2) + entry_length(1)=0x15 + StreamCodingInfo(21) = 24 bytes each
 *         StreamCodingInfo: coding_type(1) + data(20)
 *
 * After patching: num_streams++ and a new 24-byte IG entry appended.
 * All header address fields after ProgramInfo are incremented by 24.
 *
 * @param {Buffer} clpiBuf - CLPI file buffer
 * @returns {Buffer|null} new buffer with IG stream added, or null on error
 */
function patchClpiForIG(clpiBuf) {
  if (clpiBuf.length < 0x1C) return null;

  const piAddr = clpiBuf.readUInt32BE(0x0C);   // ProgramInfo_start_address
  if (piAddr + 16 > clpiBuf.length) return null;

  const numPrograms = clpiBuf[piAddr + 5];       // byte at piAddr+5
  if (numPrograms === 0) return null;

  // Program[0] header: SPN(4)+PMT_PID(2)+num_streams(1)+num_groups(1) = 8 bytes at piAddr+6
  const prog0Off  = piAddr + 6;
  const numStreams = clpiBuf[prog0Off + 6];

  // Walk stream entries (each: PID(2)+entry_len(1)+StreamCodingInfo(entry_len)) to find append point
  let streamOff = prog0Off + 8;
  for (let i = 0; i < numStreams; i++) {
    const entryLen = clpiBuf[streamOff + 2];
    streamOff += 3 + entryLen;
  }
  const appendAt = streamOff;

  // 24-byte IG stream entry: PID(2)=0x1200 + length(1)=21 + coding_type(1)=0x91 + 20 zero bytes
  const igEntry = Buffer.alloc(24);
  igEntry.writeUInt16BE(IG_PID, 0);
  igEntry[2] = 0x15;   // StreamCodingInfo length = 21
  igEntry[3] = 0x91;   // coding_type = Interactive Graphics
  // bytes 4–23 remain zero

  const newBuf = Buffer.concat([clpiBuf.slice(0, appendAt), igEntry, clpiBuf.slice(appendAt)]);

  // Update num_streams_in_PS for program[0]
  newBuf[prog0Off + 6] = numStreams + 1;

  // Update ProgramInfo.length (bytes following the 4-byte length field)
  newBuf.writeUInt32BE(clpiBuf.readUInt32BE(piAddr) + 24, piAddr);

  // Increment all header section addresses that fall after ProgramInfo
  for (const off of [0x10, 0x14, 0x18]) {
    const addr = clpiBuf.readUInt32BE(off);
    if (addr > piAddr) newBuf.writeUInt32BE(addr + 24, off);
  }

  return newBuf;
}

/**
 * Patch every PlayItem STN_table in an MPLS to declare an IG stream at IG_PID.
 *
 * MPLS PlayItem→STN_table layout (confirmed from tsMuxeR-produced files):
 *   STN_table at pi_off + 34:
 *     length(2)         bytes following this field
 *     reserved(2)
 *     num_vid(1) num_aud(1) num_PG(1) num_IG(1) num_SA(1) num_SV(1) num_PiP(1)
 *     reserved(5)        → 16-byte header total
 *     stream_entries[]:
 *       StreamEntry(10): entry_len(1)=9 + flag(1)=1 + PID(2) + reserved(6)
 *       StreamCodingInfo(6): sci_len(1)=5 + coding_type(1) + data(4)
 *       Total per entry = 16 bytes
 *
 * IG entries come after PG entries. This appends one IG entry per PlayItem.
 * Updates: num_IG, STN_table.length, PlayItem.length, PlayList.length,
 * PlayListMark_start_address, ExtensionData_start_address (if non-zero).
 *
 * @param {Buffer} mplsBuf - MPLS file buffer
 * @returns {Buffer} new buffer with IG stream added to every PlayItem
 */
function patchMplsForIG(mplsBuf) {
  const plStart    = mplsBuf.readUInt32BE(8);
  const plMarkStart = mplsBuf.readUInt32BE(12);
  const extStart   = mplsBuf.readUInt32BE(16);

  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);

  // Build the 16-byte IG stream entry:
  //   StreamEntry(10): 09 01 PID_HI PID_LO 00*6
  //   StreamCodingInfo(6): 05 91 00 00 00 00
  const igEntry = Buffer.from([
    0x09, 0x01, (IG_PID >> 8) & 0xFF, IG_PID & 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x91, 0x00, 0x00, 0x00, 0x00,
  ]);

  let newBuf      = Buffer.from(mplsBuf);
  let totalAdded  = 0;  // cumulative bytes inserted so far
  let piOrgOffset = plStart + 10;  // PlayItem[0] offset in the ORIGINAL buffer

  for (let i = 0; i < numPlayItems; i++) {
    const origPiLen = mplsBuf.readUInt16BE(piOrgOffset);  // from original buffer (pre-patch)
    const piOff     = piOrgOffset + totalAdded;            // offset in current newBuf

    const stnOff = piOff + 34;
    const numVid = newBuf[stnOff + 4];
    const numAud = newBuf[stnOff + 5];
    const numPg  = newBuf[stnOff + 6];
    const numIg  = newBuf[stnOff + 7];

    // IG entries start after vid+aud+pg entries (each 16 bytes)
    const igEntriesOff = stnOff + 16 + (numVid + numAud + numPg) * 16;

    newBuf = Buffer.concat([newBuf.slice(0, igEntriesOff), igEntry, newBuf.slice(igEntriesOff)]);
    totalAdded += 16;

    // Update num_IG
    newBuf[stnOff + 7] = numIg + 1;
    // Update STN_table.length (+16 for the new entry, read from original buffer)
    const origStnLen = mplsBuf.readUInt16BE(piOrgOffset + 34);
    newBuf.writeUInt16BE(origStnLen + 16, stnOff);
    // Update PlayItem.length (+16)
    newBuf.writeUInt16BE(origPiLen + 16, piOff);

    piOrgOffset += 2 + origPiLen;  // advance in original buffer
  }

  // Update PlayList.length (bytes following the 4-byte length field)
  newBuf.writeUInt32BE(mplsBuf.readUInt32BE(plStart) + totalAdded, plStart);
  // Update PlayListMark_start_address
  newBuf.writeUInt32BE(plMarkStart + totalAdded, 12);
  // Update ExtensionData_start_address (if present)
  if (extStart > 0) newBuf.writeUInt32BE(extStart + totalAdded, 16);

  return newBuf;
}

/**
 * Patch every PlayItem clip_information_file_name in an MPLS to a new 5-char name.
 * Used to rename the clip reference from "00000" (tsMuxeR default) to "00099" (menu slot).
 *
 * @param {Buffer} mplsBuf - MPLS file buffer
 * @param {string} name    - exactly 5 ASCII characters, e.g. "00099"
 * @returns {Buffer} new buffer with clip names updated
 */
function patchMplsClipName(mplsBuf, name) {
  if (name.length !== 5) throw new Error(`patchMplsClipName: name must be 5 chars, got ${name.length}`);
  const plStart      = mplsBuf.readUInt32BE(8);
  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);
  const newBuf = Buffer.from(mplsBuf);
  const nameBytes = Buffer.from(name, 'ascii');

  let piOff = plStart + 10;
  for (let i = 0; i < numPlayItems; i++) {
    const piLen = newBuf.readUInt16BE(piOff);
    nameBytes.copy(newBuf, piOff + 2);   // clip_information_file_name at PlayItem+2
    piOff += 2 + piLen;
  }
  return newBuf;
}

module.exports = {
  buildMenuDisplaySet,
  convertTsBdFormat,
  injectIGIntoM2ts,
  patchClpiForIG,
  patchMplsForIG,
  patchMplsClipName,
  IG_PID,
  BTN_W, BTN_H, BTN1_X, BTN1_Y, BTN2_X, BTN2_Y,
  PALETTE,
};
