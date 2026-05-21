'use strict';
/**
 * menu-builder.js — Tier 2 interactive menu generator for BD-ROM discs.
 *
 * Generates an N-button IG display set for use as a disc menu (2–9 episodes).
 * Buttons are centered vertically and horizontally on the 1920×1080 frame.
 * The display set is injected into a solid-color background video m2ts.
 *
 * Architecture:
 *   buildMenuDisplaySet(options) → Buffer (TS-packetized IG PES stream)
 *     → renderButtonBitmap(text,state) or renderButtonPixels(state)
 *     → ig-encoder.buildIGDisplaySet() assembles the full BD IG display set
 *
 * Palette:
 *   0 = transparent (background video shows through)
 *   1 = white (text + border)
 *   2 = orange (selected button fill, YCbCr → RGB ≈ 201,100,0)
 *   3 = dark slate blue (normal button fill, YCbCr → RGB ≈ 0,37,120)
 *
 * Button layout (auto-centered, 800×90 each, 30px gap):
 *   Button i (obj i*3/i*3+1/i*3+2): Episode i+1 → PLAY_PL(i+1)
 *   Single WDS window covers all buttons (BD spec: max 2 windows per page).
 */

const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

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
const BTN_GAP = 30;  // vertical gap between buttons
const BORDER  = 3;   // border thickness in pixels

// ── Text rendering constants ──────────────────────────────────────────────────
// Font for drawtext (SIL Open Font License — Inter Regular).
const FONT_PATH = path.join(__dirname, '../assets/fonts/MenuFont.ttf');

// RGB equivalents of our YCbCr palette entries — used for ffmpeg bg and pixel quantization.
// Derived from: R = 1.164*(Y-16) + 1.596*(Cr-128), G = ..., B = ...
const ENTRY_RGB = {
  2: [201, 100,   0],  // orange (selected fill)
  3: [  0,  37, 120],  // dark slate blue (normal fill)
};
// Hex strings for ffmpeg color= filter
const ENTRY_HEX = {
  2: 'c96400',  // orange
  3: '002578',  // dark blue
};

function _colorDist2(r1, g1, b1, r2, g2, b2) {
  return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
}

/**
 * Render a button bitmap with text label using ffmpeg drawtext.
 * Falls back to renderButtonPixels if ffmpeg or font is unavailable.
 *
 * @param {string} text       - button label text
 * @param {'normal'|'selected'|'activated'} state
 * @param {number} w          - button width in pixels
 * @param {number} h          - button height in pixels
 * @param {string} ffmpegPath - path to ffmpeg binary
 * @returns {Uint8Array} palette-indexed pixel array (w*h bytes)
 */
function renderButtonBitmap(text, state, w, h, ffmpegPath) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath) || !fs.existsSync(FONT_PATH) || !text) {
    return renderButtonPixels(w, h, state);
  }

  const fillEntry = state === 'normal' ? 3 : 2;
  const fillRGB   = ENTRY_RGB[fillEntry];
  const bgHex     = ENTRY_HEX[fillEntry];
  const fontSize  = Math.round((h - BORDER * 2) * 0.55);

  // Escape characters that break ffmpeg filter syntax
  const safeText = (text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "’")    // curly apostrophe (avoids shell quoting issues)
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  let rawData;
  try {
    rawData = execFileSync(ffmpegPath, [
      '-f', 'lavfi',
      '-i', `color=c=0x${bgHex}:size=${w}x${h}:rate=1`,
      '-frames:v', '1',
      '-vf', `drawtext=fontfile=${FONT_PATH}:text='${safeText}':fontsize=${fontSize}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return renderButtonPixels(w, h, state);
  }

  if (!rawData || rawData.length < w * h * 3) {
    return renderButtonPixels(w, h, state);
  }

  // Quantize RGB pixels to nearest palette entry (1=white vs fillEntry)
  const WHITE = [255, 255, 255];
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rawData[i * 3], g = rawData[i * 3 + 1], b = rawData[i * 3 + 2];
    const dWhite = _colorDist2(r, g, b, WHITE[0], WHITE[1], WHITE[2]);
    const dFill  = _colorDist2(r, g, b, fillRGB[0], fillRGB[1], fillRGB[2]);
    pixels[i] = dWhite <= dFill ? 1 : fillEntry;
  }

  // Overlay 3px white border
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < BORDER || x >= w - BORDER || y < BORDER || y >= h - BORDER) {
        pixels[y * w + x] = 1;
      }
    }
  }

  return pixels;
}

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
 * Build the complete IG display set for an N-button menu.
 * Buttons are auto-laid out and centered vertically on the frame.
 * Object IDs: i*3+0 = normal, i*3+1 = selected, i*3+2 = activated for button i.
 *
 * @param {object}   opts
 * @param {number}   opts.videoWidth   - video frame width (default 1920)
 * @param {number}   opts.videoHeight  - video frame height (default 1080)
 * @param {number[]} opts.playlists    - playlist IDs for each button (e.g. [1,2,3])
 * @param {number}   opts.pl1          - legacy: playlist for button 0 (ignored when playlists provided)
 * @param {number}   opts.pl2          - legacy: playlist for button 1 (ignored when playlists provided)
 * @param {number}   opts.pts          - PTS for the display set in 90kHz ticks (default 0)
 * @param {string[]} opts.labels       - button label text array
 * @param {string}   opts.ffmpegPath   - ffmpeg binary path for text rendering
 * @returns {Buffer} TS-packetized IG PES stream (188-byte packets)
 */
function buildMenuDisplaySet({ videoWidth = 1920, videoHeight = 1080, playlists = null, pl1 = 0, pl2 = 1, pts = 0, labels = [], ffmpegPath = null } = {}) {
  const playlistIds = playlists || [pl1, pl2];
  const N = playlistIds.length;

  // Auto-layout: center all buttons vertically, left-align buttons horizontally
  const totalH = N * BTN_H + (N - 1) * BTN_GAP;
  const topY   = Math.round((videoHeight - totalH) / 2);
  const btnX   = Math.round((videoWidth  - BTN_W)  / 2);
  const btnY   = Array.from({ length: N }, (_, i) => topY + i * (BTN_H + BTN_GAP));

  // Render 3 bitmaps per button (normal, selected, activated)
  const bitmaps = playlistIds.map((_, i) => {
    const label = (labels[i] && labels[i].trim()) ? labels[i].trim() : `Play Episode ${i + 1}`;
    return {
      normal:    renderButtonBitmap(label, 'normal',    BTN_W, BTN_H, ffmpegPath),
      selected:  renderButtonBitmap(label, 'selected',  BTN_W, BTN_H, ffmpegPath),
      activated: renderButtonBitmap(label, 'activated', BTN_W, BTN_H, ffmpegPath),
    };
  });

  // One BOG per button, circular up/down navigation
  const bogs = playlistIds.map((pl, i) => ({
    defaultValidButtonIdRef: i,
    buttons: [{
      id:                 i,
      numericSelectValue: i + 1,
      autoActionFlag:     false,
      x:                  btnX,
      y:                  btnY[i],
      upperBtnId:         (i - 1 + N) % N,
      lowerBtnId:         (i + 1) % N,
      leftBtnId:          i,
      rightBtnId:         i,
      normalStartObjId:   i * 3,      normalEndObjId: i * 3,      normalRepeat: false,
      selectedSoundId:    0,
      selStartObjId:      i * 3 + 1,  selEndObjId: i * 3 + 1,  selRepeat: false,
      activatedSoundId:   0,
      actStartObjId:      i * 3 + 2,  actEndObjId: i * 3 + 2,
      navCmds: [buildNavCmd('PLAY_PL', pl)],
    }],
  }));

  // ODS objects: 3 per button
  const objects = [];
  for (let i = 0; i < N; i++) {
    objects.push({ objectId: i * 3,     version: 0, width: BTN_W, height: BTN_H, pixels: bitmaps[i].normal    });
    objects.push({ objectId: i * 3 + 1, version: 0, width: BTN_W, height: BTN_H, pixels: bitmaps[i].selected  });
    objects.push({ objectId: i * 3 + 2, version: 0, width: BTN_W, height: BTN_H, pixels: bitmaps[i].activated });
  }

  return buildIGDisplaySet({
    composition: {
      videoWidth, videoHeight,
      frameRate:        0x40,   // 24fps
      compositionNumber: 0,
      compositionState:  2,     // epoch_start
      streamModel:       false, // Multiplexed (stream_model=0): IG is in the same m2ts clip as video
      // composition_timeout_pts=0 is the universal 'no timeout' convention; setting to video PTS in v1.10.8 caused hardware to reject the disc at load time, likely because the composition appears 'expired' immediately.
      uiModel:           false,
      userTimeoutMs:     0,
      pages: [{
        id: 0, version: 0,
        uoMask: Buffer.alloc(8),
        animationFrameRateCode:      0,
        defaultSelectedButtonIdRef:  0,
        defaultActivatedButtonIdRef: 0xFFFF,
        paletteIdRef: 0,
        bogs,
      }],
    },
    palette: { paletteId: 0, version: 0, entries: PALETTE },
    // Single window spanning all buttons (BD spec allows max 2 windows per page;
    // one large window covering all buttons is the simplest valid choice for N≥3).
    windows: [{ id: 0, x: btnX, y: topY, width: BTN_W, height: totalH }],
    objects,
    pid: IG_PID,
    pts,
  });
}

/**
 * Extract the first video PES PTS from a BD m2ts buffer.
 *
 * Scans for the first PID=0x1011 (HDMV video) PUSI packet that has a PTS.
 * This PTS value equals the MPLS in_pts (in_time << 1 in 90kHz) used by
 * libbluray's m2ts_filter, so it is the minimum value an IG PES PTS must
 * meet to pass the filter's `pts >= in_pts` check.
 *
 * @param {Buffer} m2tsBuf - 192-byte BD m2ts packets
 * @returns {number} PTS in 90kHz ticks, or 54000000 as fallback
 */
function extractFirstVideoPTS(m2tsBuf) {
  const VIDEO_PID = 0x1011;
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pkt = m2tsBuf.slice(i + 4, i + 192);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== VIDEO_PID) continue;
    if (!(pkt[1] & 0x40)) continue;                      // not PUSI
    const payloadStart = (pkt[3] & 0x20) ? 5 + pkt[4] : 4;
    const pes = pkt.slice(payloadStart);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) continue;
    if (!(pes[7] & 0x80)) continue;                      // no PTS flag
    const p = pes.slice(9, 14);
    return ((p[0] & 0x0e) * (1 << 29)) +
           (p[1] * (1 << 22)) +
           ((p[2] & 0xfe) * (1 << 14)) +
           (p[3] * (1 << 7)) +
           ((p[4] & 0xfe) >> 1);
  }
  return 54000000;  // fallback: tsMuxeR default for 600s clip start
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

// ── MPEG-2 CRC32 (polynomial 0x04C11DB7, initial 0xFFFFFFFF, no final XOR, big-endian) ───────
function mpegCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 24);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
      crc = crc >>> 0;
    }
  }
  return crc >>> 0;
}

/**
 * Patch the PMT packet in a BD m2ts buffer to add an IG stream entry.
 *
 * Hardware demuxers route PES packets to the IG decoder only when the PMT
 * declares the stream. CLPI/MPLS declarations alone are not sufficient.
 * This function locates the PMT via the PAT, appends a 5-byte ES entry for
 * PID igPid with stream_type igStreamType, updates section_length, and
 * rewrites the CRC_32. Idempotent: returns the original buffer if the PID
 * is already declared.
 *
 * @param {Buffer} m2tsBuf      - 192-byte BD m2ts stream (with arrival timestamps)
 * @param {number} igPid        - IG elementary stream PID (default 0x1400)
 * @param {number} igStreamType - IG stream type (default 0x91 = HDMV IG)
 * @returns {Buffer} patched m2ts buffer (or original if already patched)
 */
function patchPmtForIG(m2tsBuf, igPid = 0x1400, igStreamType = 0x91) {
  // Step 1: Parse PAT (PID 0x0000) to find PMT PID
  let pmtPid = -1;
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pkt = m2tsBuf.slice(i + 4, i + 192); // skip 4-byte BD arrival timestamp
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    if (pid !== 0x0000) continue;
    if (!(pkt[1] & 0x40)) continue; // need PUSI to start section
    const hasAdaptation = (pkt[3] & 0x20) !== 0;
    const payloadStart = hasAdaptation ? (4 + 1 + pkt[4]) : 4;
    const pointer = pkt[payloadStart];
    const sectionStart = payloadStart + 1 + pointer;
    if (pkt[sectionStart] !== 0x00) continue; // table_id must be 0x00 for PAT
    const sectionLength = ((pkt[sectionStart + 1] & 0x0F) << 8) | pkt[sectionStart + 2];
    // program entries: sectionStart+3 (table_id+2 bytes) +5 fixed bytes = sectionStart+8
    const programsStart = sectionStart + 8;
    const programsEnd   = sectionStart + 3 + sectionLength - 4; // exclude CRC_32
    for (let p = programsStart; p + 4 <= programsEnd; p += 4) {
      const progNum = (pkt[p] << 8) | pkt[p + 1];
      if (progNum !== 0) { // program_number 0 = NIT pointer, skip
        pmtPid = ((pkt[p + 2] & 0x1F) << 8) | pkt[p + 3];
        break;
      }
    }
    if (pmtPid !== -1) break;
  }
  if (pmtPid === -1) throw new Error('patchPmtForIG: PAT not found in m2ts stream');

  // Step 2: Find PMT packet (table_id 0x02) and patch it
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pktOff = i + 4;
    const pkt    = m2tsBuf.slice(pktOff, pktOff + 188);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1F) << 8) | pkt[2];
    if (pid !== pmtPid) continue;
    if (!(pkt[1] & 0x40)) continue; // only PUSI packet starts the section
    const hasAdaptation = (pkt[3] & 0x20) !== 0;
    const payloadStart  = hasAdaptation ? (4 + 1 + pkt[4]) : 4;
    const pointer       = pkt[payloadStart];
    const sectionStart  = payloadStart + 1 + pointer;
    if (pkt[sectionStart] !== 0x02) continue; // table_id must be 0x02 for PMT

    const sectionLength = ((pkt[sectionStart + 1] & 0x0F) << 8) | pkt[sectionStart + 2];
    // sectionStart+10..11: reserved(4)+program_info_length(12)
    const progInfoLen   = ((pkt[sectionStart + 10] & 0x0F) << 8) | pkt[sectionStart + 11];
    const esLoopStart   = sectionStart + 12 + progInfoLen;
    const crcOff        = sectionStart + 3 + sectionLength - 4; // first byte of CRC_32

    // Walk ES loop: check for igPid (idempotency) and find loop end
    let esOff = esLoopStart;
    while (esOff + 5 <= crcOff) {
      const esPid      = ((pkt[esOff + 1] & 0x1F) << 8) | pkt[esOff + 2];
      const esInfoLen  = ((pkt[esOff + 3] & 0x0F) << 8) | pkt[esOff + 4];
      if (esPid === igPid) return m2tsBuf; // already declared, nothing to do
      esOff += 5 + esInfoLen;
    }

    const newSectionLength = sectionLength + 5;
    if (newSectionLength + 4 > 184) {
      throw new Error(`patchPmtForIG: PMT section too large after IG insertion (section_length + 4 = ${newSectionLength + 4} > 184)`);
    }

    // Build updated 3-byte section header with new section_length
    const sectionHeader = Buffer.from(pkt.slice(sectionStart, sectionStart + 3));
    sectionHeader[1] = (sectionHeader[1] & 0xF0) | ((newSectionLength >> 8) & 0x0F);
    sectionHeader[2] = newSectionLength & 0xFF;

    // New ES entry: stream_type(1) + reserved(3)+PID(13 in 2 bytes) + reserved(4)+ES_info_length(12 in 2 bytes)
    const igEntry = Buffer.from([
      igStreamType,
      0xE0 | (igPid >> 8),
      igPid & 0xFF,
      0xF0,
      0x00,
    ]);

    // Full section body: header + fixed fields + program_info + ES loop + new IG entry
    const sectionBody = Buffer.concat([
      sectionHeader,
      pkt.slice(sectionStart + 3, crcOff), // everything between header and old CRC
      igEntry,
    ]);

    // Recompute CRC_32 over the complete section body
    const newCrc = mpegCrc32(sectionBody);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(newCrc, 0);

    // Pad remaining TS payload with 0xFF stuffing bytes
    const newSectionEndInPkt = sectionStart + sectionBody.length + 4;
    const stuffLen = 188 - newSectionEndInPkt;

    const newPkt = Buffer.concat([
      pkt.slice(0, sectionStart),
      sectionBody,
      crcBuf,
      Buffer.alloc(Math.max(0, stuffLen), 0xFF),
    ]);

    const newM2ts = Buffer.from(m2tsBuf);
    newPkt.copy(newM2ts, pktOff, 0, 188);
    return newM2ts;
  }

  throw new Error(`patchPmtForIG: PMT packet (PID 0x${pmtPid.toString(16).padStart(4, '0')}) not found`);
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

/**
 * Find the BD packet index immediately before the first video PES whose PTS
 * is >= targetPts. Used to interleave IG packets at the correct position in
 * a high-bitrate stream so GC fires after the vout is initialized.
 *
 * @param {Buffer} m2tsBuf   - 192-byte BD m2ts stream
 * @param {number} targetPts - PTS threshold in 90kHz ticks
 * @returns {number} BD packet index; falls back to 90% of total if not found
 */
function findPtsInsertionPoint(m2tsBuf, targetPts) {
  const VIDEO_PID = 0x1011;
  const numPkts   = Math.floor(m2tsBuf.length / 192);
  for (let i = 0; i < numPkts; i++) {
    const pkt = m2tsBuf.slice(i * 192 + 4, i * 192 + 192);
    if (pkt[0] !== 0x47) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid !== VIDEO_PID) continue;
    if (!(pkt[1] & 0x40)) continue;                      // not PUSI
    const payloadStart = (pkt[3] & 0x20) ? 5 + pkt[4] : 4;
    const pes = pkt.slice(payloadStart);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) continue;
    if (!(pes[7] & 0x80)) continue;                      // no PTS flag
    const p = pes.slice(9, 14);
    const pts = ((p[0] & 0x0e) * (1 << 29)) +
                (p[1] * (1 << 22)) +
                ((p[2] & 0xfe) * (1 << 14)) +
                (p[3] * (1 << 7)) +
                ((p[4] & 0xfe) >> 1);
    if (pts >= targetPts) return i;
  }
  return Math.floor(numPkts * 0.9);
}

/**
 * Set still_mode=2 (infinite still) on every PlayItem in a menu MPLS.
 * With infinite still the player holds the last frame indefinitely instead
 * of firing End-of-title, which would call blurayReleaseVout and destroy
 * the IG overlay before any video frame is displayed.
 *
 * PlayItem byte layout (BDMV spec §5.3.4):
 *   piOff+0-1  : length of PlayItem data (not counting these 2 bytes)
 *   piOff+2-6  : ClipInformationFileName (5 chars)
 *   piOff+7-10 : Clip_codec_identifier (4 chars)
 *   piOff+11   : reserved(7) + is_multi_angle(1)
 *   piOff+12   : connection_condition(4) + reserved(4)
 *   piOff+13   : ref_to_STC_id
 *   piOff+14-17: IN_time
 *   piOff+18-21: OUT_time
 *   piOff+22-29: UO_mask_table (8 bytes)
 *   piOff+30   : random_access_flag(1) + still_mode(2) + reserved(5)
 *   piOff+31-32: still_time (2 bytes, only meaningful when still_mode==1)
 */
function patchMplsForStill(mplsBuf) {
  const plStart      = mplsBuf.readUInt32BE(8);
  const numPlayItems = mplsBuf.readUInt16BE(plStart + 6);
  const newBuf       = Buffer.from(mplsBuf);

  let piOff = plStart + 10;
  for (let i = 0; i < numPlayItems; i++) {
    const piLen = newBuf.readUInt16BE(piOff);
    // PlayItem byte layout (after UO_mask_table at [22-29]):
    //   [30]: random_access_flag(1) + reserved(7)
    //   [31]: still_mode — 0x00=no-still, 0x01=infinite-still, 0x02=timed-still
    //   [32-33]: still_time (only meaningful when still_mode==0x02)
    // Ref: Beach Boys 50 Live reference disc — 00001.mpls PlayItem byte[31]=0x01 for IG menu clip.
    newBuf[piOff + 30] = newBuf[piOff + 30] & 0x80;  // keep only RAF bit, clear reserved bits
    newBuf[piOff + 31] = 0x01;                        // still_mode = 0x01 (infinite still)
    newBuf.writeUInt16BE(0x0000, piOff + 32);          // still_time = 0 (N/A for infinite still)
    piOff += 2 + piLen;
  }
  return newBuf;
}

module.exports = {
  buildMenuDisplaySet,
  extractFirstVideoPTS,
  renderButtonBitmap,
  renderButtonPixels,
  convertTsBdFormat,
  injectIGIntoM2ts,
  patchPmtForIG,
  patchClpiForIG,
  patchMplsForIG,
  patchMplsClipName,
  patchMplsForStill,
  findPtsInsertionPoint,
  IG_PID,
  BTN_W, BTN_H,
  PALETTE,
  ENTRY_RGB,
  FONT_PATH,
};
