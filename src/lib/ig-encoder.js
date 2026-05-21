'use strict';
/**
 * ig-encoder.js — BD-ROM Interactive Graphics stream encoder
 *
 * Encodes a minimal 2-button HDMV IG menu into a PES stream suitable for
 * injection into a .m2ts file as a BD-ROM Interactive Graphics stream.
 *
 * Architecture:
 *   buildIGDisplaySet(options) → Buffer
 *     → encodePDS(palette)        → Buffer  (segment type 0x14)
 *     → encodeWDS(windows)        → Buffer  (segment type 0x17)
 *     → encodeODS(bitmap, id)     → Buffer  (segment type 0x15)
 *     → encodeICS(composition)    → Buffer  (segment type 0x18)
 *     → encodeEND()               → Buffer  (segment type 0x80)
 *     → wrapSegmentsInPES(...)    → Buffer  (TS-packetized PES)
 *
 * Segment ordering in a Display Set: ICS → PDS → WDS → ODS(s) → END
 * (per BD-ROM spec and libbluray graphics_processor.c display set decoder)
 *
 * Sources:
 *   - libbluray/src/libbluray/decoders/ig_decode.c
 *   - libbluray/src/libbluray/decoders/pg_decode.c
 *   - libbluray/src/libbluray/decoders/graphics_processor.c
 *   - libbluray/src/libbluray/decoders/ig.h, pg.h
 *
 * Segment type constants (from graphics_processor.c):
 *   PGS_PALETTE        = 0x14
 *   PGS_OBJECT         = 0x15
 *   PGS_PG_COMPOSITION = 0x16  (PG subtitles — not used here)
 *   PGS_WINDOW         = 0x17
 *   PGS_IG_COMPOSITION = 0x18  (Interactive Graphics / ICS)
 *   PGS_END_OF_DISPLAY = 0x80
 */

// ── Segment type codes ─────────────────────────────────────────────────────────
const SEG = {
  PALETTE:        0x14,
  OBJECT:         0x15,
  WINDOW:         0x17,
  IG_COMPOSITION: 0x18,
  END_OF_DISPLAY: 0x80,
};

// ── PES stream ID for graphics ─────────────────────────────────────────────────
const PES_STREAM_ID = 0xBD;  // private_stream_1

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Build a 3-byte segment header + payload buffer.
 *
 * Segment header format (from libbluray graphics_processor.c):
 *   byte 0   : segment_type
 *   bytes 1-2: segment_length (16-bit BE, = payload.length)
 *
 * @param {number} segType - segment type constant (SEG.*)
 * @param {Buffer} payload - segment payload bytes
 * @returns {Buffer}
 */
function buildSegment(segType, payload) {
  const hdr = Buffer.alloc(3);
  hdr[0] = segType;
  hdr.writeUInt16BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

/**
 * Write a 90kHz PTS value as a 5-byte PES PTS field.
 * PTS field: 4 bits marker + 3 bits PTS[32:30] + 1 marker + 15 bits PTS[29:15]
 * + 1 marker + 15 bits PTS[14:0] + 1 marker
 *
 * @param {number} pts - PTS in 90kHz ticks
 * @returns {Buffer} 5 bytes
 */
function encodePTS(pts) {
  const buf = Buffer.alloc(5);
  buf[0] = 0x31 | (((pts >> 30) & 0x07) << 1);    // 0011 PTS[32:30] 1
  buf[1] = (pts >> 22) & 0xFF;
  buf[2] = ((pts >> 15) & 0x7F) << 1 | 1;
  buf[3] = (pts >> 7) & 0xFF;
  buf[4] = ((pts & 0x7F) << 1) | 1;
  return buf;
}

// ── PDS Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode a Palette Definition Segment (PDS, type 0x14).
 *
 * Payload format (from pg_decode.c pg_decode_palette_entry):
 *   palette_id(8) palette_version(8)
 *   [per entry]: entry_id(8) Y(8) Cr(8) Cb(8) T(8)
 *   (T=0 opaque, T=255 transparent; Y/Cr/Cb are YCbCr-601 values)
 *
 * @param {object} opts
 * @param {number} opts.paletteId - palette ID (0-7)
 * @param {number} opts.version   - palette version (0)
 * @param {Array<{id,Y,Cr,Cb,T}>} opts.entries - palette entries (max 256)
 * @returns {Buffer}
 */
function encodePDS({ paletteId = 0, version = 0, entries = [] }) {
  const payload = Buffer.alloc(2 + entries.length * 5);
  payload[0] = paletteId;
  payload[1] = version;
  entries.forEach((e, i) => {
    const off = 2 + i * 5;
    payload[off]     = e.id;
    payload[off + 1] = e.Y;
    payload[off + 2] = e.Cr;
    payload[off + 3] = e.Cb;
    payload[off + 4] = e.T;
  });
  return buildSegment(SEG.PALETTE, payload);
}

// ── RLE Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode an RGBA pixel array to BD-ROM 4-color RLE format.
 *
 * RLE encoding rules (from libbluray/decoders/rle.c):
 *   - 0x00 = escape byte
 *   - 0x00 0x00                     = end of line
 *   - 0x00 [0x01..0x3F]             = N transparent pixels (N = byte & 0x3F)
 *   - 0x00 [0x40..0x7F] NN          = (byte & 0x3F)<<8 | NN transparent pixels
 *   - 0x00 [0x80..0xBF] CC          = (byte & 0x3F) pixels of color CC
 *   - 0x00 [0xC0..0xFF] NN CC       = (byte & 0x3F)<<8 | NN pixels of color CC
 *   - CC (non-zero)                 = 1 pixel of color CC
 *
 * TODO: implement full RLE encoder
 *
 * @param {Uint8Array} pixels - palette indices, one per pixel, row-major
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} RLE-encoded pixel data
 */
function encodeRLE(pixels, width, height) {
  // BD-ROM RLE encoding (from libbluray rle.c):
  //   CC (non-zero, non-0x00)                     = 1 pixel of color CC
  //   0x00 0x01..0x3F                             = 1-63 transparent pixels
  //   0x00 (0x40|(N>>8)) (N&0xFF)                 = 64-16383 transparent pixels
  //   0x00 (0x80|N) CC                            = 1-63 pixels of color CC
  //   0x00 (0xC0|(N>>8)) (N&0xFF) CC              = 64-16383 pixels of color CC
  //   0x00 0x00                                   = end of line
  const out = [];
  const MAX_RUN = 0x3FFF;  // 16383 pixels max per run

  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const color = pixels[y * width + x];
      // Measure run length
      let runLen = 1;
      while (x + runLen < width && runLen < MAX_RUN && pixels[y * width + x + runLen] === color) {
        runLen++;
      }
      if (color === 0) {
        // Transparent run
        if (runLen <= 0x3F) {
          out.push(0x00, runLen);                        // 0x00 N (1-63)
        } else {
          out.push(0x00, 0x40 | (runLen >> 8), runLen & 0xFF);  // 0x00 (0x40|hi) lo
        }
      } else if (runLen === 1) {
        out.push(color);                                 // single literal pixel
      } else if (runLen <= 0x3F) {
        out.push(0x00, 0x80 | runLen, color);           // 0x00 (0x80|N) CC
      } else {
        out.push(0x00, 0xC0 | (runLen >> 8), runLen & 0xFF, color);  // 0x00 (0xC0|hi) lo CC
      }
      x += runLen;
    }
    out.push(0x00, 0x00);  // end of line
  }
  return Buffer.from(out);
}

// ── ODS Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode an Object Definition Segment (ODS, type 0x15).
 *
 * Payload format (from pg_decode.c pg_decode_object):
 *   object_id(16) object_version(8)           3 bytes
 *   sequence_descriptor: first(1) last(1) reserved(6)  1 byte
 *   [if first_in_seq]:
 *     data_length(24)                          3 bytes (total RLE data + 4 bytes for w/h)
 *     width(16) height(16)                     4 bytes
 *   [RLE pixel data]
 *
 * TODO: support fragmented ODS (segments >64KB)
 *
 * @param {object} opts
 * @param {number} opts.objectId  - object ID (0-based)
 * @param {number} opts.version   - version (0)
 * @param {number} opts.width     - bitmap width in pixels
 * @param {number} opts.height    - bitmap height in pixels
 * @param {Uint8Array} opts.pixels - palette-indexed pixel data (width*height bytes)
 * @returns {Buffer}
 */
function encodeODS({ objectId, version = 0, width, height, pixels }) {
  const rle = encodeRLE(pixels, width, height);
  // data_length = 4 (w/h) + rle.length
  const dataLength = 4 + rle.length;

  const payload = Buffer.alloc(3 + 1 + 3 + 4 + rle.length);
  let off = 0;

  payload.writeUInt16BE(objectId, off); off += 2;
  payload[off++] = version;

  // sequence descriptor: first_in_seq=1, last_in_seq=1 → 0xC0
  payload[off++] = 0xC0;

  // data_length (24-bit BE)
  payload[off++] = (dataLength >> 16) & 0xFF;
  payload[off++] = (dataLength >>  8) & 0xFF;
  payload[off++] =  dataLength        & 0xFF;

  payload.writeUInt16BE(width,  off); off += 2;
  payload.writeUInt16BE(height, off); off += 2;

  rle.copy(payload, off);

  return buildSegment(SEG.OBJECT, payload);
}

// ── WDS Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode a Window Definition Segment (WDS, type 0x17).
 *
 * Payload format (from pg_decode.c pg_decode_window):
 *   num_windows(8)
 *   [per window]:
 *     window_id(8) x(16) y(16) width(16) height(16)  9 bytes
 *
 * @param {Array<{id,x,y,width,height}>} windows
 * @returns {Buffer}
 */
function encodeWDS(windows) {
  const payload = Buffer.alloc(1 + windows.length * 9);
  payload[0] = windows.length;
  windows.forEach((w, i) => {
    const off = 1 + i * 9;
    payload[off] = w.id;
    payload.writeUInt16BE(w.x,      off + 1);
    payload.writeUInt16BE(w.y,      off + 3);
    payload.writeUInt16BE(w.width,  off + 5);
    payload.writeUInt16BE(w.height, off + 7);
  });
  return buildSegment(SEG.WINDOW, payload);
}

// ── ICS Encoder ───────────────────────────────────────────────────────────────

/**
 * Encode an Interactive Composition Segment (ICS, type 0x18).
 *
 * Encodes the full InteractiveComposition structure as decoded by ig_decode.c.
 * See tier2_menu_design.md for complete byte-by-byte layout.
 *
 * @param {object} opts
 * @param {number} opts.videoWidth
 * @param {number} opts.videoHeight
 * @param {number} opts.frameRate              - 4-bit frame rate code (0x40 = 24fps, 0x50 = 25fps, 0x60 = 29.97fps)
 * @param {number} opts.compositionNumber      - display set counter
 * @param {number} opts.compositionState       - 0=normal, 1=acq_point, 2=epoch_start, 3=epoch_continue
 * @param {boolean} opts.streamModel           - false=InMux/Multiplexed (stream_model bit=0, IG in same clip as video,
 *                                               requires compositionTimeoutPts/selectionTimeoutPts fields),
 *                                               true=OutMux/Non-Multiplexed (stream_model bit=1, IG from SubPath, no PTS fields)
 * @param {boolean} opts.uiModel               - false=always-on, true=popup
 * @param {number}  opts.compositionTimeoutPts - (InMux only) PTS at which to display composition (90kHz ticks, default 0)
 * @param {number}  opts.selectionTimeoutPts   - (InMux only) PTS at which selection times out (0=no timeout)
 * @param {number} opts.userTimeoutMs          - user timeout in ms (0=infinite)
 * @param {Array<IGPage>} opts.pages           - page descriptors (see IGPage below)
 * @returns {Buffer}
 *
 * IGPage: {
 *   id(number), version(number),
 *   uoMask(Buffer 8 bytes),
 *   animationFrameRateCode(number),
 *   defaultSelectedButtonIdRef(number),
 *   defaultActivatedButtonIdRef(number),
 *   paletteIdRef(number),
 *   bogs: [{
 *     defaultValidButtonIdRef(number),
 *     buttons: [{
 *       id, numericSelectValue, autoActionFlag,
 *       x, y,
 *       upperBtnId, lowerBtnId, leftBtnId, rightBtnId,
 *       normalStartObjId, normalEndObjId, normalRepeat,
 *       selectedSoundId, selStartObjId, selEndObjId, selRepeat,
 *       activatedSoundId, actStartObjId, actEndObjId,
 *       navCmds: [Buffer(12)]  -- 12-byte HDMV commands
 *     }]
 *   }]
 * }
 */
// ── ICS sub-encoders ─────────────────────────────────────────────────────────

function encodeEffectSequence(effects = []) {
  // Minimal effect_sequence: 0 windows, 0 effects (2 bytes)
  // Full implementation would serialize animation windows and effects.
  if (!effects || effects.length === 0) {
    return Buffer.from([0x00, 0x00]);  // num_windows=0, num_effects=0
  }
  // For now only the empty case is needed to build a working display set.
  return Buffer.from([0x00, 0x00]);
}

function encodeButton(btn) {
  // Per button: id(2) numeric_select_value(2) auto_action(1) x(2) y(2)
  //   upper(2) lower(2) left(2) right(2)
  //   normal_start(2) normal_end(2) normal_repeat_and_flags(1)
  //   sel_sound(1) sel_start(2) sel_end(2) sel_repeat_and_flags(1)
  //   act_sound(1) act_start(2) act_end(2)
  //   num_nav_cmds(2) [nav_cmds * 12]
  const navCmds = btn.navCmds || [];
  const fixedSize = 2+2+1+2+2+2+2+2+2+2+2+1+1+2+2+1+1+2+2+2;  // = 35 bytes
  const buf = Buffer.alloc(fixedSize + navCmds.length * 12);
  let o = 0;

  buf.writeUInt16BE(btn.id                   || 0,  o); o += 2;
  buf.writeUInt16BE(btn.numericSelectValue   || 0,  o); o += 2;
  buf[o++] = btn.autoActionFlag ? 0x80 : 0x00;
  buf.writeUInt16BE(btn.x                    || 0,  o); o += 2;
  buf.writeUInt16BE(btn.y                    || 0,  o); o += 2;
  buf.writeUInt16BE(btn.upperBtnId           ?? 0xFFFF, o); o += 2;
  buf.writeUInt16BE(btn.lowerBtnId           ?? 0xFFFF, o); o += 2;
  buf.writeUInt16BE(btn.leftBtnId            ?? 0xFFFF, o); o += 2;
  buf.writeUInt16BE(btn.rightBtnId           ?? 0xFFFF, o); o += 2;
  buf.writeUInt16BE(btn.normalStartObjId     || 0,  o); o += 2;
  buf.writeUInt16BE(btn.normalEndObjId       || 0,  o); o += 2;
  buf[o++] = btn.normalRepeat ? 0x80 : 0x00;
  buf[o++] = btn.selectedSoundId             || 0;
  buf.writeUInt16BE(btn.selStartObjId        || 0,  o); o += 2;
  buf.writeUInt16BE(btn.selEndObjId          || 0,  o); o += 2;
  buf[o++] = btn.selRepeat ? 0x80 : 0x00;
  buf[o++] = btn.activatedSoundId            || 0;
  buf.writeUInt16BE(btn.actStartObjId        || 0,  o); o += 2;
  buf.writeUInt16BE(btn.actEndObjId          || 0,  o); o += 2;
  buf.writeUInt16BE(navCmds.length,                 o); o += 2;
  navCmds.forEach(cmd => { cmd.copy(buf, o); o += 12; });
  return buf;
}

function encodeBOG(bog) {
  // default_valid_button_id_ref(2) num_buttons(1) [buttons...]
  const buttons = (bog.buttons || []).map(encodeButton);
  const total = 3 + buttons.reduce((s, b) => s + b.length, 0);
  const buf = Buffer.alloc(3);
  buf.writeUInt16BE(bog.defaultValidButtonIdRef ?? (bog.buttons?.[0]?.id || 0), 0);
  buf[2] = bog.buttons.length;
  return Buffer.concat([buf, ...buttons]);
}

function encodePage(page) {
  // page_id(1) page_version(1) uo_mask(8) in_effects out_effects
  // animation_frame_rate_code(1) default_selected_btn(2) default_activated_btn(2)
  // palette_id_ref(1) num_bogs(1) [bogs...]
  const uoMask = page.uoMask || Buffer.alloc(8);
  const inFx   = encodeEffectSequence(page.inEffects);
  const outFx  = encodeEffectSequence(page.outEffects);
  const bogs   = (page.bogs || []).map(encodeBOG);

  const hdr = Buffer.alloc(2 + 8 + inFx.length + outFx.length + 1 + 2 + 2 + 1 + 1);
  let o = 0;
  hdr[o++] = page.id        || 0;
  hdr[o++] = page.version   || 0;
  uoMask.copy(hdr, o); o += 8;
  inFx.copy(hdr, o);   o += inFx.length;
  outFx.copy(hdr, o);  o += outFx.length;
  hdr[o++] = page.animationFrameRateCode    || 0;
  hdr.writeUInt16BE(page.defaultSelectedButtonIdRef  ?? (page.bogs?.[0]?.buttons?.[0]?.id || 0), o); o += 2;
  hdr.writeUInt16BE(page.defaultActivatedButtonIdRef ?? 0xFFFF, o); o += 2;
  hdr[o++] = page.paletteIdRef  || 0;
  hdr[o++] = bogs.length;
  return Buffer.concat([hdr, ...bogs]);
}

function encodeICS(opts) {
  const {
    videoWidth = 1920, videoHeight = 1080, frameRate = 0x40,
    compositionNumber = 0, compositionState = 2,
    streamModel = false, uiModel = false,
    compositionTimeoutPts = 0, selectionTimeoutPts = 0,
    userTimeoutMs = 0, pages = [],
  } = opts;

  const icParts = [];

  // stream_model(1) ui_model(1) reserved(6) = 1 byte
  // streamModel=false → bit=0 → InMux/Multiplexed: IG in same clip, timeout fields present
  // streamModel=true  → bit=1 → OutMux/Non-Multiplexed: IG in SubPath, no timeout fields
  icParts.push(Buffer.from([
    (streamModel ? 0x80 : 0x00) | (uiModel ? 0x40 : 0x00),
  ]));

  // InMux (stream_model=0): composition_timeout_pts and selection_timeout_pts.
  // Each is encoded as: 7 reserved bits + 33-bit PTS value = 5 bytes.
  // libbluray ig_decode.c line 291-294: bb_skip(7); read_u64(33) × 2.
  if (!streamModel) {
    const encPts = (pts) => {
      const b = Buffer.alloc(5);
      // 7 reserved zero bits in top of byte 0, then 33-bit PTS
      b[0] = Math.floor(pts / 0x100000000) & 0x01; // bit 32 of PTS
      b[1] = (pts >>> 24) & 0xFF;
      b[2] = (pts >>> 16) & 0xFF;
      b[3] = (pts >>>  8) & 0xFF;
      b[4] =  pts         & 0xFF;
      return b;
    };
    icParts.push(encPts(compositionTimeoutPts));
    icParts.push(encPts(selectionTimeoutPts));
  }

  // user_timeout_duration (24-bit, in 90kHz ticks)
  const userTimeoutTicks = Math.round((userTimeoutMs / 1000) * 90000);
  const utd = Buffer.alloc(3);
  utd[0] = (userTimeoutTicks >> 16) & 0xFF;
  utd[1] = (userTimeoutTicks >>  8) & 0xFF;
  utd[2] =  userTimeoutTicks        & 0xFF;
  icParts.push(utd);

  // num_pages(8) + each page.
  // libbluray _decode_interactive_composition reads user_timeout_duration then DIRECTLY
  // num_pages — there is NO number_of_composition_objects byte at this level.
  // (number_of_composition_objects exists inside each effect_info(), NOT here.)
  icParts.push(Buffer.from([pages.length]));
  pages.forEach(page => icParts.push(encodePage(page)));

  const icData = Buffer.concat(icParts);

  // Prepend data_len (24-bit BE)
  const dataLenBuf = Buffer.alloc(3);
  dataLenBuf[0] = (icData.length >> 16) & 0xFF;
  dataLenBuf[1] = (icData.length >>  8) & 0xFF;
  dataLenBuf[2] =  icData.length        & 0xFF;
  const ic = Buffer.concat([dataLenBuf, icData]);

  // VideoDescriptor: width(16) height(16) frameRate(4) reserved(4)
  const vd = Buffer.alloc(4);
  vd.writeUInt16BE(videoWidth,  0);
  vd.writeUInt16BE(videoHeight, 2);
  // TODO: write frame_rate in high nibble: vd[4] = (frameRate << 4) & 0xF0
  // (Only 4 bytes — frame_rate is packed at bit 32, i.e. byte 4 high nibble)
  // Actually videoDescriptor is 4 bytes: [W(2)] [H(2)] then [frameRate(4)|reserved(4)] = 1 more byte = 5 total
  // Fixing: re-allocate as 5 bytes
  const vd5 = Buffer.alloc(5);
  vd5.writeUInt16BE(videoWidth,  0);
  vd5.writeUInt16BE(videoHeight, 2);
  vd5[4] = frameRate & 0xF0;  // high nibble = frame_rate code, low nibble = reserved

  // CompositionDescriptor: composition_number(16) composition_state(2) reserved(6)
  const cd = Buffer.alloc(3);
  cd.writeUInt16BE(compositionNumber, 0);
  cd[2] = (compositionState & 0x03) << 6;

  // SequenceDescriptor: first_in_seq=1, last_in_seq=1 = 0xC0
  const sd = Buffer.from([0xC0]);

  const payload = Buffer.concat([vd5, cd, sd, ic]);
  return buildSegment(SEG.IG_COMPOSITION, payload);
}

// ── END Segment ───────────────────────────────────────────────────────────────

/**
 * Encode an End of Display Set segment (END, type 0x80).
 * Payload is empty (length = 0).
 * @returns {Buffer} 3 bytes
 */
function encodeEND() {
  return buildSegment(SEG.END_OF_DISPLAY, Buffer.alloc(0));
}

// ── HDMV Nav Command Builder ───────────────────────────────────────────────────

/**
 * Build a 12-byte HDMV navigation command for a button action.
 *
 * Commands use the same format as MovieObject.bdmv movie objects.
 * The most common button command: PLAY_PL(playlistId)
 *
 * @param {string} type - 'PLAY_PL' | 'JUMP_TITLE' | 'NOOP'
 * @param {number} arg  - playlist ID for PLAY_PL, title ID for JUMP_TITLE
 * @returns {Buffer} 12 bytes
 */
function buildNavCmd(type, arg = 0) {
  const cmd = Buffer.alloc(12);
  switch (type) {
    case 'PLAY_PL':
      // PLAY_PL opcode: 0x22800000, w1=playlistId, w2=0
      cmd.writeUInt32BE(0x22800000, 0);
      cmd.writeUInt32BE(arg,        4);
      cmd.writeUInt32BE(0,          8);
      break;
    case 'JUMP_TITLE':
      // JUMP_TITLE with imm_op1=1 (0x21810000 matches tsMuxeR/libbluray)
      cmd.writeUInt32BE(0x21810000, 0);
      cmd.writeUInt32BE(arg,        4);
      cmd.writeUInt32BE(0,          8);
      break;
    case 'NOOP':
    default:
      // NOP: 0x00020000 0 0
      cmd.writeUInt32BE(0x00020000, 0);
      break;
  }
  return cmd;
}

// ── PES Wrapper ───────────────────────────────────────────────────────────────

/**
 * Wrap a segment buffer in a PES packet and then TS packets.
 *
 * TODO: implement PES/TS packetization for IG stream injection.
 * This requires:
 *   1. PES header with PTS stamping
 *   2. Splitting payload into 184-byte TS payload chunks
 *   3. Assigning correct PID and continuity counter
 *
 * @param {Buffer} segmentData - concatenated segment buffers
 * @param {number} pid         - IG stream PID (typically 0x1200)
 * @param {number} pts         - presentation timestamp (90kHz)
 * @returns {Buffer} TS-packetized PES
 */
function wrapInPES(segmentData, pid = 0x1200, pts = 0, startCC = 0) {
  // Build PES packet:
  //   0x000001 stream_id(1) PES_length(2) flags(2) hdr_data_len(1) PTS(5) data
  const ptsBuf = encodePTS(pts);
  const pesLength = 3 + ptsBuf.length + segmentData.length; // flags(2)+hdr_len(1)+pts(5)+data
  const hdr = Buffer.alloc(9);
  hdr[0] = 0x00; hdr[1] = 0x00; hdr[2] = 0x01;
  hdr[3] = PES_STREAM_ID;
  hdr.writeUInt16BE(Math.min(pesLength, 0xFFFF), 4);
  hdr[6] = 0x84;  // marker=1 | data_alignment_indicator (bit 2, required for IG PES)
  hdr[7] = 0x80;  // PTS only (PTS_DTS_flags=10)
  hdr[8] = 0x05;  // PES_header_data_length = 5 bytes (PTS)
  const pes = Buffer.concat([hdr, ptsBuf, segmentData]);

  // Packetize into 188-byte TS packets
  const packets = [];
  let offset = 0;
  let cc = startCC & 0x0F;

  while (offset < pes.length) {
    const pkt = Buffer.alloc(188, 0xFF);
    pkt[0] = 0x47;
    const pusi = (offset === 0) ? 0x40 : 0x00;
    pkt[1] = pusi | ((pid >> 8) & 0x1F);
    pkt[2] = pid & 0xFF;

    const remaining = pes.length - offset;
    const stuffing = 184 - Math.min(remaining, 184);

    if (stuffing === 0) {
      pkt[3] = 0x10 | cc;
      pes.copy(pkt, 4, offset, offset + 184);
      offset += 184;
    } else {
      // Adaptation field for stuffing
      pkt[3] = 0x30 | cc;
      pkt[4] = stuffing - 1;        // adaptation_field_length
      if (stuffing >= 2) pkt[5] = 0x00;  // adaptation flags (no optional fields)
      pkt.fill(0xFF, 6, 4 + stuffing);   // stuffing bytes
      pes.copy(pkt, 4 + stuffing, offset, offset + remaining);
      offset = pes.length;
    }
    packets.push(pkt);
    cc = (cc + 1) & 0x0F;
  }
  return Buffer.concat(packets);
}

// ── Display Set Builder ───────────────────────────────────────────────────────

/**
 * Build a complete IG Display Set.
 *
 * Segment ordering per BD-ROM spec and libbluray graphics_processor.c:
 *   ICS → PDS → WDS → ODS(s) → END
 *
 * @param {object} opts
 * @param {object} opts.composition  - ICS options (passed to encodeICS)
 * @param {object} opts.palette      - PDS options (passed to encodePDS)
 * @param {Array}  opts.windows      - WDS windows (passed to encodeWDS)
 * @param {Array}  opts.objects      - Array of ODS options (each passed to encodeODS)
 * @param {number} opts.pid          - IG stream PID
 * @param {number} opts.pts          - PTS timestamp
 * @returns {Buffer}
 */
function buildIGDisplaySet({ composition, palette, windows, objects, pid, pts }) {
  const ics  = encodeICS(composition || {});
  const pds  = encodePDS(palette     || {});
  const wds  = encodeWDS(windows     || []);
  const ods  = (objects || []).map(o => encodeODS(o));
  const end  = encodeEND();

  // BD spec: each segment must be in its own PES packet.
  // m2ts_demux creates one PES_BUFFER per PES; graphics_processor_decode_pes
  // processes one segment per PES_BUFFER then advances to next — all segments
  // in a single PES means only the first (ICS) is decoded, END never reached,
  // s->complete stays 0, and GC_CTRL_INIT_MENU is never called.
  // CC must be continuous across all PES packets for the same PID.
  const segments = [ics, pds, wds, ...ods, end];
  let cc = 0;
  const pesPackets = segments.map(seg => {
    const pkt = wrapInPES(seg, pid, pts, cc);
    cc = (cc + Math.ceil((14 + seg.length) / 184)) & 0x0F;
    return pkt;
  });
  return Buffer.concat(pesPackets);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  SEG,
  buildNavCmd,
  encodePDS,
  encodeODS,
  encodeWDS,
  encodeICS,
  encodeEND,
  encodeRLE,
  buildIGDisplaySet,
  wrapInPES,
  buildSegment,
  encodePTS,
  encodeEffectSequence,
  encodePage,
  encodeBOG,
  encodeButton,
};
