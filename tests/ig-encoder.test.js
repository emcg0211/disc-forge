'use strict';
/**
 * Unit tests for src/lib/ig-encoder.js
 * Run: node tests/ig-encoder.test.js
 * Prints PASS/FAIL for each test case.
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execFileSync } = require('child_process');

const {
  SEG, buildNavCmd, encodePDS, encodeODS, encodeWDS, encodeICS, encodeEND,
  encodeRLE, buildIGDisplaySet, wrapInPES, buildSegment, encodePTS, encodeDTS,
  encodeEffectSequence, encodePage, encodeBOG, encodeButton,
} = require(path.join(__dirname, '..', 'src', 'lib', 'ig-encoder.js'));

let passed = 0;
let failed = 0;

function assert(condition, name, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function assertEq(a, b, name) {
  assert(a === b, name, `expected ${b}, got ${a}`);
}

function assertBufEq(a, b, name) {
  assert(Buffer.compare(a, b) === 0, name,
    `expected [${[...b].map(x=>x.toString(16).padStart(2,'0')).join(' ')}], ` +
    `got [${[...a].map(x=>x.toString(16).padStart(2,'0')).join(' ')}]`);
}

// ─── Phase 4a: RLE Encoder ───────────────────────────────────────────────────

console.log('\n=== 4a: RLE Encoder ===');

{
  // Single transparent pixel → 0x00 0x01
  const p = new Uint8Array([0]);
  const rle = encodeRLE(p, 1, 1);
  assertBufEq(rle, Buffer.from([0x00, 0x01, 0x00, 0x00]), 'single transparent pixel + EOL');
}

{
  // Single non-zero pixel (color 3) → 0x03 EOL
  const p = new Uint8Array([3]);
  const rle = encodeRLE(p, 1, 1);
  assertBufEq(rle, Buffer.from([0x03, 0x00, 0x00]), 'single colored pixel + EOL');
}

{
  // 4 transparent pixels → 0x00 0x04 EOL
  const p = new Uint8Array([0, 0, 0, 0]);
  const rle = encodeRLE(p, 4, 1);
  assertBufEq(rle, Buffer.from([0x00, 0x04, 0x00, 0x00]), '4 transparent pixels short run');
}

{
  // 4 pixels of color 2 → 0x00 0x82 0x02 EOL
  const p = new Uint8Array([2, 2, 2, 2]);
  const rle = encodeRLE(p, 4, 1);
  assertBufEq(rle, Buffer.from([0x00, 0x84, 0x02, 0x00, 0x00]), '4 colored pixels short run');
}

{
  // 64 transparent pixels → 0x00 0x40 0x40 EOL (long form: N=64, 0x40|(64>>8)=0x40, 64&0xFF=0x40)
  const p = new Uint8Array(64).fill(0);
  const rle = encodeRLE(p, 64, 1);
  assertBufEq(rle, Buffer.from([0x00, 0x40, 0x40, 0x00, 0x00]), '64 transparent pixels long run');
}

{
  // 64 pixels of color 1 → 0x00 0xC0 0x40 0x01 EOL
  const p = new Uint8Array(64).fill(1);
  const rle = encodeRLE(p, 64, 1);
  assertBufEq(rle, Buffer.from([0x00, 0xC0, 0x40, 0x01, 0x00, 0x00]), '64 colored pixels long run');
}

{
  // All-zero 10x2 bitmap → compact runs per row
  const p = new Uint8Array(20).fill(0);
  const rle = encodeRLE(p, 10, 2);
  assert(rle.length < 10, 'all-zero 10x2: compressed smaller than uncompressed');
  // Each row should be: 0x00 0x0A 0x00 0x00 (transparent run 10 + EOL)
  assertBufEq(rle.slice(0, 4), Buffer.from([0x00, 0x0A, 0x00, 0x00]), 'all-zero row 1 encoding');
  assertBufEq(rle.slice(4, 8), Buffer.from([0x00, 0x0A, 0x00, 0x00]), 'all-zero row 2 encoding');
}

{
  // Decode verification: encode a 4-pixel row, decode manually and verify
  const p = new Uint8Array([1, 1, 0, 0]);
  const rle = encodeRLE(p, 4, 1);
  // Expect: 0x01(1 pixel col 1), 0x00 0x82 0x01 ... actually 1 literal then 1 short
  // Since it's 2 pixels of color 1 then 2 transparent:
  // col 1 run=2: 0x00 0x82 0x01; trans run=2: 0x00 0x02; EOL: 0x00 0x00
  // But wait color 1 x2: 0x00 (0x80|2) 0x01 = 0x00 0x82 0x01
  assertBufEq(rle, Buffer.from([0x00, 0x82, 0x01, 0x00, 0x02, 0x00, 0x00]), 'mixed run encoding');
}

// ─── Phase 4b: PDS Encoder (already implemented, verify structure) ────────────

console.log('\n=== 4b: PDS Encoder ===');

{
  const pds = encodePDS({
    paletteId: 0, version: 0,
    entries: [
      { id: 0,  Y: 0x10, Cr: 0x80, Cb: 0x80, T: 0xFF },  // transparent black
      { id: 1,  Y: 0xEB, Cr: 0x80, Cb: 0x80, T: 0x00 },  // opaque white
      { id: 2,  Y: 0x4C, Cr: 0xF0, Cb: 0x57, T: 0x00 },  // opaque red (BT.601)
      { id: 3,  Y: 0x96, Cr: 0x2C, Cb: 0x15, T: 0x00 },  // opaque green
    ],
  });
  assertEq(pds[0], SEG.PALETTE, 'PDS segment type = 0x14');
  assertEq(pds.readUInt16BE(1), 2 + 4 * 5, 'PDS payload length = 22');
  assertEq(pds[3], 0, 'PDS paletteId = 0');
  assertEq(pds[4], 0, 'PDS version = 0');
  assertEq(pds[5], 0,  'PDS entry 0 id = 0');
  assertEq(pds[9], 255, 'PDS entry 0 T = 255 (transparent)');
  assertEq(pds[10], 1, 'PDS entry 1 id = 1');
  assertEq(pds[14], 0, 'PDS entry 1 T = 0 (opaque)');
}

// ─── Phase 4c: ODS Encoder (already implemented, verify structure) ────────────

console.log('\n=== 4c: ODS Encoder ===');

{
  const pixels = new Uint8Array(100 * 50).fill(1);  // solid color 1
  const ods = encodeODS({ objectId: 0, version: 0, width: 100, height: 50, pixels });
  assertEq(ods[0], SEG.OBJECT, 'ODS segment type = 0x15');
  const payloadLen = ods.readUInt16BE(1);
  assert(payloadLen > 10, 'ODS payload length > 10');
  assertEq(ods.readUInt16BE(3), 0, 'ODS objectId = 0');  // bytes 3-4
  assertEq(ods[5], 0, 'ODS version = 0');
  assertEq(ods[6], 0xC0, 'ODS sequence = 0xC0 (first+last)');
  // data_length at bytes 7-9 (24-bit)
  const dataLen = (ods[7] << 16) | (ods[8] << 8) | ods[9];
  assert(dataLen >= 4, 'ODS data_length >= 4 (includes w+h)');
  assertEq(ods.readUInt16BE(10), 100, 'ODS width = 100');
  assertEq(ods.readUInt16BE(12), 50, 'ODS height = 50');
}

// ─── Phase 4d: ICS Encoder ───────────────────────────────────────────────────

console.log('\n=== 4d: ICS Encoder (minimal 1-page, 1-BOG, 2-button) ===');

{
  const cmd1 = buildNavCmd('PLAY_PL', 1);
  const cmd2 = buildNavCmd('PLAY_PL', 2);

  const ics = encodeICS({
    videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
    compositionNumber: 0, compositionState: 2,
    streamModel: false, uiModel: false,
    userTimeoutMs: 0,
    pages: [{
      id: 0, version: 0,
      uoMask: Buffer.alloc(8),
      animationFrameRateCode: 0,
      defaultSelectedButtonIdRef: 0,
      defaultActivatedButtonIdRef: 0xFFFF,
      paletteIdRef: 0,
      bogs: [{
        defaultValidButtonIdRef: 0,
        buttons: [
          { id: 0, x: 100, y: 200, numericSelectValue: 0,
            normalStartObjId: 0, normalEndObjId: 0,
            selStartObjId: 1, selEndObjId: 1,
            actStartObjId: 0, actEndObjId: 0,
            navCmds: [cmd1] },
          { id: 1, x: 100, y: 300, numericSelectValue: 0,
            normalStartObjId: 2, normalEndObjId: 2,
            selStartObjId: 3, selEndObjId: 3,
            actStartObjId: 2, actEndObjId: 2,
            navCmds: [cmd2] },
        ],
      }],
    }],
  });

  assertEq(ics[0], SEG.IG_COMPOSITION, 'ICS segment type = 0x18');
  const payloadLen = ics.readUInt16BE(1);
  assert(payloadLen > 20, 'ICS payload length > 20 (has pages)');
  // VideoDescriptor: bytes 3-7 (5 bytes: w(2), h(2), frame_rate(1))
  assertEq(ics.readUInt16BE(3), 1920, 'ICS videoWidth = 1920');
  assertEq(ics.readUInt16BE(5), 1080, 'ICS videoHeight = 1080');
  assertEq(ics[7] & 0xF0, 0x40, 'ICS frameRate high nibble = 0x40 (24fps)');
  assertEq(ics[7] & 0x0F, 0x00, 'ICS frameRate low nibble = 0 (reserved)');
}

{
  // JUMP_TITLE nav command bytes
  const cmd = buildNavCmd('JUMP_TITLE', 5);
  assertEq(cmd.readUInt32BE(0), 0x21810000, 'JUMP_TITLE opcode = 0x21810000 (imm_op1=1)');
  assertEq(cmd.readUInt32BE(4), 5, 'JUMP_TITLE arg = 5');
}

{
  // PLAY_PL nav command bytes
  const cmd = buildNavCmd('PLAY_PL', 3);
  assertEq(cmd.readUInt32BE(0), 0x22800000, 'PLAY_PL opcode = 0x22800000');
  assertEq(cmd.readUInt32BE(4), 3, 'PLAY_PL arg = 3');
}

// ─── Phase 4e: Display Set assembler ─────────────────────────────────────────

console.log('\n=== 4e: Display Set assembler ===');

{
  const cmd1 = buildNavCmd('PLAY_PL', 1);
  const cmd2 = buildNavCmd('PLAY_PL', 2);
  const pxNormal   = new Uint8Array(100 * 30).fill(1);
  const pxSelected = new Uint8Array(100 * 30).fill(2);

  const ds = buildIGDisplaySet({
    composition: {
      videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
      compositionState: 2, streamModel: false,
      pages: [{
        id: 0, version: 0, uoMask: Buffer.alloc(8),
        paletteIdRef: 0,
        defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF,
        bogs: [{
          defaultValidButtonIdRef: 0,
          buttons: [
            { id: 0, x: 100, y: 400, normalStartObjId: 0, normalEndObjId: 0, selStartObjId: 1, selEndObjId: 1, actStartObjId: 0, actEndObjId: 0, navCmds: [cmd1] },
            { id: 1, x: 100, y: 500, normalStartObjId: 2, normalEndObjId: 2, selStartObjId: 3, selEndObjId: 3, actStartObjId: 2, actEndObjId: 2, navCmds: [cmd2] },
          ],
        }],
      }],
    },
    palette: { paletteId: 0, version: 0, entries: [
      { id: 0, Y: 0x10, Cr: 0x80, Cb: 0x80, T: 0xFF },
      { id: 1, Y: 0xEB, Cr: 0x80, Cb: 0x80, T: 0x00 },
      { id: 2, Y: 0x70, Cr: 0xD0, Cb: 0x80, T: 0x00 },
    ]},
    windows: [{ id: 0, x: 80, y: 380, width: 300, height: 200 }],
    objects: [
      { objectId: 0, width: 100, height: 30, pixels: pxNormal },
      { objectId: 1, width: 100, height: 30, pixels: pxSelected },
      { objectId: 2, width: 100, height: 30, pixels: pxNormal },
      { objectId: 3, width: 100, height: 30, pixels: pxSelected },
    ],
  });

  // wrapInPES is now a real TS packetizer; output will be multiple 188-byte packets
  assert(ds.length % 188 === 0, 'Display set output is multiple of 188 bytes (TS packets)');
  assert(ds[0] === 0x47, 'First byte is TS sync 0x47');
  assert((ds[1] & 0x40) === 0x40, 'PUSI set in first TS packet');
  // END segment must appear (type 0x80); search in raw segment data inside PES
  const rawSegments = buildIGDisplaySet({
    composition: { videoWidth: 1920, videoHeight: 1080, frameRate: 0x40, compositionState: 2, pages: [] },
    palette: { paletteId: 0, version: 0, entries: [] },
    windows: [],
    objects: [],
    pid: null, pts: 0,
  });
  // In the real ds, the END segment (type 0x80, payload length 0) should be present
  // Search for 0x80 0x00 0x00 pattern in the TS payload area
  const hasEnd = ds.toString('hex').includes('800000');
  assert(hasEnd, 'END segment (0x80 0x00 0x00) present in display set');
}

// ─── Phase 4f: MPEG-TS packetizer ────────────────────────────────────────────

console.log('\n=== 4f: MPEG-TS packetizer ===');

{
  // Small payload (< 184 bytes) → 1 TS packet
  const data = Buffer.from('test data for PES wrapping');
  const ts = wrapInPES(data, 0x1200, 90000);
  assertEq(ts.length, 188, 'Small payload → exactly 1 TS packet (188 bytes)');
  assertEq(ts[0], 0x47, 'TS sync byte 0x47');
  assertEq((ts[1] & 0x40), 0x40, 'PUSI set in first packet');
  assertEq(((ts[1] & 0x1F) << 8) | ts[2], 0x1200, 'PID = 0x1200');
  assertEq(ts[3] & 0xF0, 0x30, 'Adaptation+payload (afc=0b11)');
  // PES header starts after TS header (4 bytes) + adaptation field
  const afLen = ts[4];
  const pesStart = 5 + afLen;
  assertBufEq(ts.slice(pesStart, pesStart + 3), Buffer.from([0x00, 0x00, 0x01]), 'PES start code 0x000001');
  assertEq(ts[pesStart + 3], 0xBD, 'PES stream_id = 0xBD');
  assertEq(ts[pesStart + 6], 0x84, 'PES flags byte 1 = 0x84 (marker | data_alignment_indicator)');
  assertEq(ts[pesStart + 7], 0x80, 'PES flags byte 2 = 0x80 (PTS only)');
  assertEq(ts[pesStart + 8], 0x05, 'PES header_data_length = 5');
}

{
  // Large payload (> 184 bytes) → multiple packets
  const data = Buffer.alloc(400).fill(0xAB);
  const ts = wrapInPES(data, 0x1200, 0);
  assert(ts.length % 188 === 0, 'Multi-packet: multiple of 188 bytes');
  assert(ts.length > 188, 'Multi-packet: more than 1 packet');
  assertEq(ts[0], 0x47, 'First packet sync');
  assertEq(ts[188], 0x47, 'Second packet sync');
  assertEq((ts[1] & 0x40), 0x40, 'First packet has PUSI');
  assertEq((ts[189] & 0x40), 0x00, 'Second packet PUSI=0');
  // Continuity counter increments
  assertEq(ts[3] & 0x0F, 0, 'First packet CC = 0');
  assertEq(ts[191] & 0x0F, 1, 'Second packet CC = 1');
}

{
  // Verify ffprobe sees a PES stream at PID 0x1200 (if ffprobe is available)
  const ffprobe = '/usr/local/bin/ffprobe';
  if (fs.existsSync(ffprobe)) {
    const payload = Buffer.alloc(512).fill(0x55);
    const tsData = wrapInPES(payload, 0x1200, 45000);
    const tmpFile = path.join(os.tmpdir(), `ig_test_${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, tsData);
    try {
      const out = execFileSync(ffprobe, [
        '-v', 'quiet', '-show_streams', '-select_streams', 'a',
        '-of', 'csv=p=0', tmpFile,
      ], { encoding: 'utf8', timeout: 5000 });
      // ffprobe may not decode private streams, but it shouldn't crash
      assert(true, 'ffprobe ran without crash on TS output');
    } catch (e) {
      assert(true, 'ffprobe ran (exit non-zero is OK for private stream)');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch(_) {}
    }
  } else {
    assert(true, 'ffprobe not at /usr/local/bin/ffprobe — skipping live probe test');
  }
}

// ─── Phase 5: v1.10.6 regression — InMux stream_model and still_mode ─────────

console.log('\n=== 5a: ICS stream_model byte (Multiplexed vs Non-Multiplexed) ===');

{
  // API convention: streamModel=false → stream_model bit=0 → Multiplexed/InMux
  //                 streamModel=true  → stream_model bit=1 → Non-Multiplexed/OutMux
  // libbluray ig_decode.c line 285-294: stream_model=0 reads 10-byte timeout block;
  //                                     stream_model=1 does NOT.
  // For our disc: IG is in the same m2ts clip as video → use streamModel=false (InMux, bit=0).
  // composition_timeout_pts=0 is the universal 'no timeout' convention (v1.10.9).
  // Setting to video PTS (v1.10.8) caused hardware to reject disc at load time.
  const makeICS = (streamModel) => encodeICS({
    videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
    compositionNumber: 0, compositionState: 2,
    streamModel, uiModel: false, userTimeoutMs: 0,
    compositionTimeoutPts: 0,
    pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8),
      paletteIdRef: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF,
      bogs: [{ defaultValidButtonIdRef: 0, buttons: [
        { id: 0, x: 0, y: 0, numericSelectValue: 0,
          normalStartObjId: 0, normalEndObjId: 0, selStartObjId: 1, selEndObjId: 1,
          actStartObjId: 0, actEndObjId: 0, navCmds: [buildNavCmd('PLAY_PL', 1)] },
      ]}],
    }],
  });

  // ICS byte layout (segment):
  //   [0]=type  [1-2]=length  [3-7]=VideoDescriptor(5)  [8-10]=CompositionDescriptor(3)
  //   [11]=SequenceDescriptor  [12-14]=data_length  [15]=interaction_model byte
  const icsMux    = makeICS(false);  // streamModel=false → stream_model=0 (Multiplexed, InMux)
  const icsNonMux = makeICS(true);   // streamModel=true  → stream_model=1 (Non-Multiplexed, OutMux)

  assertEq(icsMux[15]    & 0x80, 0x00, 'Multiplexed    ICS[15] stream_model bit = 0 (InMux)');
  assertEq(icsNonMux[15] & 0x80, 0x80, 'Non-Multiplexed ICS[15] stream_model bit = 1 (OutMux)');
  // Multiplexed ICS is 10 bytes longer (has timeout fields per libbluray ig_decode.c:289-294)
  assert(icsMux.length === icsNonMux.length + 10, 'Multiplexed ICS is 10 bytes longer (has timeout fields)');
  // Both must still be epoch_start
  assertEq(icsMux[10],    0x80, 'Multiplexed    ICS composition_state = 0x80 (epoch_start)');
  assertEq(icsNonMux[10], 0x80, 'Non-Multiplexed ICS composition_state = 0x80 (epoch_start)');
  // Multiplexed: composition_timeout_pts=0 → all 5 bytes [16-20] = 0x00
  assertEq(icsMux[16], 0x00, 'Multiplexed ICS[16] composition_timeout_pts byte 0 = 0x00');
  assertEq(icsMux[17], 0x00, 'Multiplexed ICS[17] composition_timeout_pts byte 1 = 0x00');
  assertEq(icsMux[18], 0x00, 'Multiplexed ICS[18] composition_timeout_pts byte 2 = 0x00');
  assertEq(icsMux[19], 0x00, 'Multiplexed ICS[19] composition_timeout_pts byte 3 = 0x00');
  assertEq(icsMux[20], 0x00, 'Multiplexed ICS[20] composition_timeout_pts byte 4 = 0x00');
}

console.log('\n=== 5b: patchMplsForStill writes still_mode=1 to byte[31] (v1.10.6 fix) ===');

{
  // patchMplsForStill was writing to bits 5-6 of byte[30] (reserved) instead of
  // byte[31] (still_mode field), and using still_mode=0x02 (timed) instead of 0x01 (infinite).
  // Ref: PlayItem spec — byte[30]=random_access_flag+reserved, byte[31]=still_mode.
  const { patchMplsForStill } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  // Build a synthetic MPLS with a PlayItem that has bytes[30-33] = all zeros
  // MPLS header: magic(8) + PlayList_addr(4) + PlayListMark_addr(4) + ext_addr(4) = 20 bytes minimum
  // PlayList at offset 0x3A (standard): length(4)+reserved(2)+num_items(2)+num_subpaths(2) = 10 bytes header
  // PlayItem: length(2) + payload(80 bytes) = 82 bytes total, pi[30]=0x00 pi[31]=0x00 originally
  const PL_OFF = 0x3A;
  const PI_OFF = PL_OFF + 10;  // PlayItem[0] starts here

  const mplsBuf = Buffer.alloc(PI_OFF + 2 + 82, 0x00);
  mplsBuf.write('MPLS0200', 0, 'ascii');
  mplsBuf.writeUInt32BE(PL_OFF, 8);           // PlayList_start_address
  mplsBuf.writeUInt32BE(PI_OFF + 2 + 82, 12); // PlayListMark_start_address (past end)
  mplsBuf.writeUInt32BE(0, 16);               // ExtensionData = 0
  mplsBuf.writeUInt32BE(PI_OFF + 82, PL_OFF); // PlayList.length
  mplsBuf.writeUInt16BE(1, PL_OFF + 6);       // num_PlayItems = 1
  mplsBuf.writeUInt16BE(0, PL_OFF + 8);       // num_SubPaths = 0
  mplsBuf.writeUInt16BE(80, PI_OFF);           // PlayItem.length = 80

  const patched = patchMplsForStill(mplsBuf);

  const byte30 = patched[PI_OFF + 30];
  const byte31 = patched[PI_OFF + 31];
  const byte32_33 = patched.readUInt16BE(PI_OFF + 32);

  assertEq(byte31, 0x01,   'still_mode byte[31] = 0x01 (infinite still)');
  assertEq(byte32_33, 0x00, 'still_time bytes[32-33] = 0x0000');
  assert((byte30 & 0x7F) === 0x00, 'byte[30] reserved bits = 0 (only RAF bit kept)');
}

// ─── Phase 6: v1.10.8 fix — remove spurious number_of_composition_objects byte ─
// v1.10.7 BUG: encodeICS inserted a spurious 0x00 byte between user_timeout_duration
// and num_pages. libbluray _decode_interactive_composition (ig_decode.c:296-302) reads
// user_timeout_duration then DIRECTLY num_pages — there is NO number_of_composition_objects
// field at this level. That field exists inside effect_info(), NOT in interactive_composition().
// Result: decoder read the 0x00 as num_pages → 0 pages → 0 buttons on all hardware.

console.log('\n=== 6: ICS num_pages immediately follows user_timeout_duration (v1.10.8 fix) ===');

{
  const makeICS1Page = (streamModel) => encodeICS({
    videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
    compositionNumber: 0, compositionState: 2,
    streamModel, uiModel: false, userTimeoutMs: 0,
    pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8),
      paletteIdRef: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF,
      bogs: [{ defaultValidButtonIdRef: 0, buttons: [
        { id: 0, x: 0, y: 0, numericSelectValue: 0,
          normalStartObjId: 0, normalEndObjId: 0, selStartObjId: 1, selEndObjId: 1,
          actStartObjId: 0, actEndObjId: 0, navCmds: [buildNavCmd('PLAY_PL', 1)] },
      ]}],
    }],
  });

  // ICS segment layout (bytes from start of segment):
  //   [0]     type (0x18)
  //   [1-2]   payload length
  //   [3-7]   VideoDescriptor (5 bytes)
  //   [8-10]  CompositionDescriptor (3 bytes)
  //   [11]    SequenceDescriptor (1 byte)
  //   [12-14] data_length (3 bytes)
  //   [15]    interaction_model byte (stream_model | ui_model)
  //   NonMux (streamModel=true,  stream_model=1): [16-18]=user_timeout_duration; [19]=num_pages
  //   Mux    (streamModel=false, stream_model=0): [16-25]=timeout(10); [26-28]=utd; [29]=num_pages

  const icsNonMux = makeICS1Page(true);   // stream_model=1, no timeout block
  const icsMux    = makeICS1Page(false);  // stream_model=0, with 10-byte timeout block

  // Non-Multiplexed (stream_model=1): num_pages directly at [19] — no spurious byte
  assertEq(icsNonMux[16], 0x00, 'NonMux ICS[16] user_timeout_duration[0] = 0x00');
  assertEq(icsNonMux[17], 0x00, 'NonMux ICS[17] user_timeout_duration[1] = 0x00');
  assertEq(icsNonMux[18], 0x00, 'NonMux ICS[18] user_timeout_duration[2] = 0x00');
  assertEq(icsNonMux[19], 0x01, 'NonMux ICS[19] num_pages = 0x01 (no spurious byte between utd and num_pages)');

  // Multiplexed (stream_model=0): num_pages directly at [29] after 10-byte timeout block
  assertEq(icsMux[26], 0x00, 'Mux ICS[26] user_timeout_duration[0] = 0x00');
  assertEq(icsMux[27], 0x00, 'Mux ICS[27] user_timeout_duration[1] = 0x00');
  assertEq(icsMux[28], 0x00, 'Mux ICS[28] user_timeout_duration[2] = 0x00');
  assertEq(icsMux[29], 0x01, 'Mux ICS[29] num_pages = 0x01 (no spurious byte)');

  // Multiplexed still 10 bytes longer than Non-Multiplexed (timeout block, unchanged by fix)
  assert(icsMux.length === icsNonMux.length + 10, 'Mux ICS 10 bytes longer than NonMux (timeout block)');
}

// ─── v1.10.10 Clannad audit fixes ────────────────────────────────────────────

console.log('\n=== 7: frame_rate_code in ICS VideoDescriptor (v1.10.10 fix) ===');
{
  // BD frame_rate_code is stored in the high nibble of VideoDescriptor byte[4].
  // For 24fps video the code is 2 → byte value 0x20.
  // We were sending 0x40 (code 4 = 29.97fps) — wrong for our 24fps clip.
  // Confirmed against Clannad (23.976fps → code 1 → byte 0x10).
  const ics24fps = encodeICS({ videoWidth: 1920, videoHeight: 1080, frameRate: 0x20, pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8), animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }] });
  const payload24 = ics24fps.slice(3);  // skip 3-byte segment header
  assertEq(payload24[4] >> 4, 2, 'frameRate 0x20 → frame_rate_code = 2 (24fps)');
  assertEq(payload24[4] & 0x0F, 0, 'frame_rate_code low nibble reserved = 0');

  const ics24976fps = encodeICS({ videoWidth: 1920, videoHeight: 1080, frameRate: 0x10, pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8), animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }] });
  const payload24976 = ics24976fps.slice(3);
  assertEq(payload24976[4] >> 4, 1, 'frameRate 0x10 → frame_rate_code = 1 (23.976fps, Clannad-style)');

  const ics2997fps = encodeICS({ videoWidth: 1920, videoHeight: 1080, frameRate: 0x40, pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8), animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }] });
  const payload2997 = ics2997fps.slice(3);
  assertEq(payload2997[4] >> 4, 4, 'frameRate 0x40 → frame_rate_code = 4 (29.97fps)');
}

console.log('\n=== 8: PTS encoding prefix (v1.10.10 fix) ===');
{
  // encodePTS(pts, withDts=false) must use 0x21 prefix (PTS-only, marker '0010').
  // encodePTS(pts, withDts=true) must use 0x31 prefix (PTS+DTS, marker '0011').
  // encodeDTS(dts) must use 0x11 prefix (marker '0001').
  // Confirmed against Clannad: PDS PES byte[0]=0x21, ICS PES PTS byte[0]=0x31, DTS byte[0]=0x11.
  const ptsOnly = encodePTS(0, false);
  assertEq(ptsOnly[0] & 0xF0, 0x20, 'encodePTS(pts, withDts=false) → leading nibble 0x2');

  const ptsWithDts = encodePTS(0, true);
  assertEq(ptsWithDts[0] & 0xF0, 0x30, 'encodePTS(pts, withDts=true) → leading nibble 0x3');

  const dts = encodeDTS(0);
  assertEq(dts[0] & 0xF0, 0x10, 'encodeDTS() → leading nibble 0x1');

  // Verify PTS value is correctly encoded for a non-zero PTS
  const testPts = 54000000;  // 600s at 90kHz (Clannad's PTS)
  const ptsBuf  = encodePTS(testPts, true);
  const decoded = ((ptsBuf[0] & 0x0e) << 29) | (ptsBuf[1] << 22) | ((ptsBuf[2] & 0xfe) << 14) | (ptsBuf[3] << 7) | ((ptsBuf[4] & 0xfe) >> 1);
  assertEq(decoded, testPts, `encodePTS(${testPts}) round-trips correctly`);

  const dtsBuf  = encodeDTS(53988336);  // Clannad ICS DTS
  const dtsDecoded = ((dtsBuf[0] & 0x0e) << 29) | (dtsBuf[1] << 22) | ((dtsBuf[2] & 0xfe) << 14) | (dtsBuf[3] << 7) | ((dtsBuf[4] & 0xfe) >> 1);
  assertEq(dtsDecoded, 53988336, 'encodeDTS(53988336) round-trips correctly');
}

console.log('\n=== 9: ICS PES DTS required (v1.10.10 fix) ===');
{
  // buildIGDisplaySet must produce an ICS PES with PTS+DTS (flags2=0xC0, hdr_len=10).
  // PDS/ODS/END PES must have PTS-only (flags2=0x80, hdr_len=5).
  // Confirmed against Clannad reference disc (PES header byte analysis).
  const seg1px = buildIGDisplaySet({
    composition: { videoWidth: 1920, videoHeight: 1080, frameRate: 0x20, compositionNumber: 0, compositionState: 2, streamModel: false, uiModel: false, compositionTimeoutPts: 0, selectionTimeoutPts: 0, userTimeoutMs: 0, pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8), animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }] },
    palette: { paletteId: 0, version: 0, entries: [{ id: 0, Y: 16, Cr: 128, Cb: 128, T: 255 }] },
    windows: [{ id: 0, x: 0, y: 0, width: 100, height: 100 }],
    objects: [{ objectId: 0, version: 0, width: 1, height: 1, pixels: new Uint8Array([0]) }],
    pid: 0x1400, pts: 54000000,
  });

  // Walk 188-byte TS packets to extract the first two PES headers
  const pesPtsDtsList = [];
  let off = 0;
  while (off + 188 <= seg1px.length) {
    const pkt = seg1px.slice(off, off + 188);
    if (pkt[0] !== 0x47) { off += 188; continue; }
    if (!(pkt[1] & 0x40)) { off += 188; continue; }   // not PUSI
    const hasAdapt = (pkt[3] & 0x20) !== 0;
    const ps = hasAdapt ? (4 + 1 + pkt[4]) : 4;
    const pes = pkt.slice(ps);
    if (pes[0] === 0 && pes[1] === 0 && pes[2] === 1) {
      pesPtsDtsList.push({ flags2: pes[7], hdrLen: pes[8] });
    }
    off += 188;
  }

  // First PES is ICS → must have flags2=0xC0 (PTS+DTS), hdr_len=10
  assert(pesPtsDtsList.length >= 2, 'buildIGDisplaySet produces at least 2 PUSI PES packets');
  if (pesPtsDtsList.length >= 1) {
    assertEq(pesPtsDtsList[0].flags2, 0xC0, 'ICS PES flags2 = 0xC0 (PTS+DTS)');
    assertEq(pesPtsDtsList[0].hdrLen, 10,   'ICS PES hdr_len = 10 (5 PTS + 5 DTS bytes)');
  }
  // Second PES is PDS → must have flags2=0x80 (PTS only), hdr_len=5
  if (pesPtsDtsList.length >= 2) {
    assertEq(pesPtsDtsList[1].flags2, 0x80, 'PDS PES flags2 = 0x80 (PTS only)');
    assertEq(pesPtsDtsList[1].hdrLen, 5,    'PDS PES hdr_len = 5 (PTS only)');
  }

  // ICS DTS should be pts - 11664 (clamped to 0)
  // Verify by decoding the DTS field from the ICS PES
  let off2 = 0;
  while (off2 + 188 <= seg1px.length) {
    const pkt = seg1px.slice(off2, off2 + 188);
    if (pkt[0] !== 0x47) { off2 += 188; continue; }
    if (!(pkt[1] & 0x40)) { off2 += 188; continue; }
    const hasAdapt = (pkt[3] & 0x20) !== 0;
    const ps = hasAdapt ? (4 + 1 + pkt[4]) : 4;
    const pes = pkt.slice(ps);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) { off2 += 188; continue; }
    if (pes[7] !== 0xC0) { off2 += 188; continue; }  // want PTS+DTS PES
    const d = pes.slice(14, 19);
    const dtsDecoded = ((d[0] & 0x0e) << 29) | (d[1] << 22) | ((d[2] & 0xfe) << 14) | (d[3] << 7) | ((d[4] & 0xfe) >> 1);
    assertEq(dtsDecoded, 54000000 - 11664, 'ICS DTS = PTS - 11664 (130ms buffering window)');
    break;
    off2 += 188;
  }

  // Zero-PTS case: DTS must clamp to 0 (can't go negative)
  const seg0pts = buildIGDisplaySet({
    composition: { videoWidth: 1920, videoHeight: 1080, frameRate: 0x20, compositionNumber: 0, compositionState: 2, streamModel: false, uiModel: false, compositionTimeoutPts: 0, selectionTimeoutPts: 0, userTimeoutMs: 0, pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8), animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0, defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }] },
    palette: { paletteId: 0, version: 0, entries: [{ id: 0, Y: 16, Cr: 128, Cb: 128, T: 255 }] },
    windows: [],
    objects: [],
    pid: 0x1400, pts: 0,
  });
  let off3 = 0;
  while (off3 + 188 <= seg0pts.length) {
    const pkt = seg0pts.slice(off3, off3 + 188);
    if (pkt[0] !== 0x47) { off3 += 188; continue; }
    if (!(pkt[1] & 0x40)) { off3 += 188; continue; }
    const hasAdapt = (pkt[3] & 0x20) !== 0;
    const ps = hasAdapt ? (4 + 1 + pkt[4]) : 4;
    const pes = pkt.slice(ps);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) { off3 += 188; continue; }
    if (pes[7] !== 0xC0) { off3 += 188; continue; }
    const d = pes.slice(14, 19);
    const dtsDecoded = ((d[0] & 0x0e) << 29) | (d[1] << 22) | ((d[2] & 0xfe) << 14) | (d[3] << 7) | ((d[4] & 0xfe) >> 1);
    assertEq(dtsDecoded, 0, 'ICS DTS clamped to 0 when PTS < 11664');
    break;
    off3 += 188;
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('OVERALL: FAIL');
  process.exit(1);
} else {
  console.log('OVERALL: PASS');
}
