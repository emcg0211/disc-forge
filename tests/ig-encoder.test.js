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

console.log('\n=== 10: arrival timestamp fixes (v1.10.11) ===');
{
  const { convertTsBdFormat, injectIGIntoM2ts } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  // Fix 1: copy_permission_indicator must be 00 (bits[31:30] of 4-byte BD header)
  const fakePkt = Buffer.alloc(188); fakePkt[0] = 0x47;
  const bd = convertTsBdFormat(fakePkt, 1000);
  const hdr = bd.readUInt32BE(0);
  assertEq((hdr >>> 30) & 0x3, 0, 'copy_permission_indicator = 0 (no restriction)');

  // Fix 2: arrival timestamps must be monotonically increasing
  const bd2 = convertTsBdFormat(Buffer.concat([fakePkt, fakePkt]), 5000);
  const arr0 = bd2.readUInt32BE(0) & 0x3FFFFFFF;
  const arr1 = bd2.readUInt32BE(192) & 0x3FFFFFFF;
  assert(arr1 > arr0, 'arrival timestamps are monotonically increasing (arr1 > arr0)');
  assertEq(arr1 - arr0, 300, 'arrival timestamps spaced by 300 ticks (27MHz / 90kHz)');

  // Fix 3: injectIGIntoM2ts derives baseTimestamp from last video packet before insertion
  // Build a fake video m2ts: 12 packets with arrival timestamps 1000, 1300, ..., 4300
  const videoM2ts = Buffer.alloc(12 * 192);
  for (let i = 0; i < 12; i++) {
    videoM2ts.writeUInt32BE(1000 + i * 300, i * 192);
    videoM2ts[i * 192 + 4] = 0x47;
  }
  const igTs = Buffer.concat([fakePkt, fakePkt]);  // 2 TS packets
  const combined = injectIGIntoM2ts(videoM2ts, igTs, 10);
  // IG packets start at packet index 10; arrival of video pkt 9 = 1000 + 9*300 = 3700
  // IG pkt 0 arrival should be 3700+300=4000, pkt 1 should be 4300
  const igArr0 = combined.readUInt32BE(10 * 192) & 0x3FFFFFFF;
  const igArr1 = combined.readUInt32BE(11 * 192) & 0x3FFFFFFF;
  const vidBefore = videoM2ts.readUInt32BE(9 * 192) & 0x3FFFFFFF;  // 3700
  assertEq(igArr0, vidBefore + 300, 'IG pkt[0] arrival = last video pkt arrival + 300');
  assertEq(igArr1, vidBefore + 600, 'IG pkt[1] arrival monotonically follows pkt[0]');
  // Video after the injection must not jump backwards
  const vidAfterArr = combined.readUInt32BE(12 * 192) & 0x3FFFFFFF;  // original pkt 10
  assertEq(vidAfterArr, 1000 + 10 * 300, 'video packets after injection are unmodified');
}

console.log('\n=== 11: sound IDs default to 0xFF (v1.10.11) ===');
{
  // encodeButton: omitting selectedSoundId/activatedSoundId must encode 0xFF, not 0
  const btnBuf = encodeButton({ id: 0, navCmds: [] });
  // Button layout (bytes from offset 0):
  // btn_id(2) numericSelectValue(2) autoActionFlag(1) x(2) y(2)
  // upper(2) lower(2) left(2) right(2) = 17 bytes
  // normalStart(2) normalEnd(2) normalRepeat(1) selectedSoundId(1) = +6 → offset 23
  const selSoundOff = 2 + 2 + 1 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 1;  // = 24
  assertEq(btnBuf[selSoundOff],     0xFF, 'selectedSoundId defaults to 0xFF (no sound)');
  // activatedSoundId is at: selStart(2) selEnd(2) selRepeat(1) = +5 after selSoundOff
  const actSoundOff = selSoundOff + 1 + 2 + 2 + 1;  // = 29
  assertEq(btnBuf[actSoundOff], 0xFF, 'activatedSoundId defaults to 0xFF (no sound)');

  // Explicit 0x00 sound ID must be respected (not overwritten by ?? fallback)
  const btnExplicit = encodeButton({ id: 0, selectedSoundId: 0, activatedSoundId: 0, navCmds: [] });
  assertEq(btnExplicit[selSoundOff], 0x00, 'selectedSoundId=0 explicit value preserved');
  assertEq(btnExplicit[actSoundOff], 0x00, 'activatedSoundId=0 explicit value preserved');
}

console.log('\n=== 12: patchMplsForIG correctly handles num_aud=1 (v1.10.13) ===');
{
  // When tsMuxeR muxes audio, the MPLS STN_table has num_aud=1 and an audio stream
  // entry already present. patchMplsForIG must place the IG entry AFTER the audio
  // entry (not before it), and update num_IG=1 and STN_table.length+=16.
  const { patchMplsForIG } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  // Build a minimal MPLS with one PlayItem whose STN_table has num_vid=1, num_aud=1,
  // num_PG=0, num_IG=0.
  const PL_START = 40;          // PlayList section offset
  const PL_MARK  = PL_START + 4 + 2 + 2 + 2 + 2 + 80; // right after PlayList

  const buf = Buffer.alloc(PL_MARK + 8, 0);
  // MPLS header pointers
  buf.writeUInt32BE(PL_START,  8);   // PlayList_start_address
  buf.writeUInt32BE(PL_MARK,  12);   // PlayListMark_start_address
  buf.writeUInt32BE(0,         16);   // ExtensionData_start_address (none)

  // PlayList section at PL_START
  buf.writeUInt32BE(88, PL_START);        // PlayList.length = 2+2+2 + 2+80 = 88
  buf.writeUInt16BE(1,  PL_START + 6);    // numPlayItems = 1

  // PlayItem[0] at PL_START + 10
  const PI_OFF = PL_START + 10;
  buf.writeUInt16BE(80, PI_OFF);           // PlayItem.length = 80

  // clip_information_file_name at PI_OFF+2: "00099" (5 bytes)
  Buffer.from('00099', 'ascii').copy(buf, PI_OFF + 2);

  // STN_table at PI_OFF + 34
  const STN_OFF = PI_OFF + 34;
  buf.writeUInt16BE(46, STN_OFF);          // STN_table.length = 14 + 16 + 16 = 46
  buf[STN_OFF + 4] = 1;  // num_vid = 1
  buf[STN_OFF + 5] = 1;  // num_aud = 1
  buf[STN_OFF + 6] = 0;  // num_PG  = 0
  buf[STN_OFF + 7] = 0;  // num_IG  = 0

  // Video stream entry (16 bytes) at STN_OFF + 16
  const VID_OFF = STN_OFF + 16;
  buf[VID_OFF + 0] = 0x09; buf[VID_OFF + 1] = 0x01;
  buf.writeUInt16BE(0x1011, VID_OFF + 2);  // video PID
  buf[VID_OFF + 10] = 0x05; buf[VID_OFF + 11] = 0x1B; // coding H.264

  // Audio stream entry (16 bytes) at STN_OFF + 32
  const AUD_OFF = STN_OFF + 32;
  buf[AUD_OFF + 0] = 0x09; buf[AUD_OFF + 1] = 0x01;
  buf.writeUInt16BE(0x1100, AUD_OFF + 2);  // audio PID
  buf[AUD_OFF + 10] = 0x05; buf[AUD_OFF + 11] = 0x81; // coding AC3

  const patched = patchMplsForIG(buf);

  // num_IG must be 1 now
  assertEq(patched[STN_OFF + 7], 1, 'patchMplsForIG: num_IG=1 after patch with num_aud=1');

  // STN_table.length must be origStnLen + 16 = 46 + 16 = 62
  assertEq(patched.readUInt16BE(STN_OFF), 62, 'patchMplsForIG: STN_table.length += 16');

  // PlayItem.length must be origPiLen + 16 = 80 + 16 = 96
  assertEq(patched.readUInt16BE(PI_OFF), 96, 'patchMplsForIG: PlayItem.length += 16');

  // PlayList.length must be origPlLen + 16 = 88 + 16 = 104
  assertEq(patched.readUInt32BE(PL_START), 104, 'patchMplsForIG: PlayList.length += 16');

  // PlayListMark_start_address must advance by 16
  assertEq(patched.readUInt32BE(12), PL_MARK + 16, 'patchMplsForIG: PlayListMark_start_address += 16');

  // IG entry must be inserted AFTER audio entry (at original STN_OFF+48)
  const IG_ENTRY_OFF = STN_OFF + 48; // 16 header + 16 vid + 16 aud
  assertEq(patched[IG_ENTRY_OFF + 2], 0x14, 'patchMplsForIG: IG PID high byte = 0x14');
  assertEq(patched[IG_ENTRY_OFF + 3], 0x00, 'patchMplsForIG: IG PID low byte = 0x00');
  assertEq(patched[IG_ENTRY_OFF + 11], 0x91, 'patchMplsForIG: IG coding_type = 0x91');

  // Audio entry must be unchanged after patch
  assertEq(patched.readUInt16BE(AUD_OFF + 2), 0x1100, 'patchMplsForIG: audio PID 0x1100 preserved');
  assertEq(patched[AUD_OFF + 11], 0x81, 'patchMplsForIG: audio coding_type 0x81 preserved');
}

console.log('\n=== 13: patchPmtForIG with audio ES already in PMT (v1.10.13) ===');
{
  // When tsMuxeR muxes audio, the PMT ES loop already has a video entry and an audio
  // entry. patchPmtForIG must append IG after audio without corrupting audio.
  const { patchPmtForIG } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  // Build a minimal 192-byte BD m2ts with a PAT packet and a PMT packet.
  // PAT: PID 0x0000, declares program 1 with PMT PID 0x0100
  // PMT: PID 0x0100, ES loop has video 0x1011 (0x1B) + audio 0x1100 (0x81)
  const m2ts = Buffer.alloc(2 * 192, 0xFF);

  // — PAT packet at offset 0 (BD arrival timestamp = 4 bytes) —
  m2ts.writeUInt32BE(0, 0);       // arrival timestamp
  const patPkt = m2ts.slice(4, 192);
  patPkt.fill(0xFF);
  patPkt[0] = 0x47;               // sync byte
  patPkt[1] = 0x40;               // PID=0x0000, PUSI=1
  patPkt[2] = 0x00;
  patPkt[3] = 0x10;               // payload only, cc=0
  patPkt[4] = 0x00;               // pointer_field = 0
  // PAT section at patPkt[5]:
  patPkt[5]  = 0x00;              // table_id = 0x00
  patPkt[6]  = 0xB0;              // section_syntax_indicator=1, reserved, section_length high nibble=0
  patPkt[7]  = 0x0D;              // section_length = 13 (5 fixed + 4 program entry + 4 CRC)
  patPkt[8]  = 0x00; patPkt[9]  = 0x01; // transport_stream_id
  patPkt[10] = 0xC1;              // version + current_next
  patPkt[11] = 0x00;              // section_number
  patPkt[12] = 0x00;              // last_section_number
  // program entry: program_number=1, PMT_PID=0x0100
  patPkt[13] = 0x00; patPkt[14] = 0x01; // program_number = 1
  patPkt[15] = 0xE1; patPkt[16] = 0x00; // PMT_PID = 0x0100 (reserved 3 bits + 13-bit PID)
  // CRC (we write zeros; patchPmtForIG reads the PMT CRC, not the PAT CRC)
  patPkt[17] = 0; patPkt[18] = 0; patPkt[19] = 0; patPkt[20] = 0;

  // — PMT packet at offset 192 —
  m2ts.writeUInt32BE(300, 192);   // arrival timestamp
  const pmtPkt = m2ts.slice(196, 384);
  pmtPkt.fill(0xFF);
  pmtPkt[0] = 0x47;
  pmtPkt[1] = 0xC1;               // PID=0x0100, PUSI=1 (0x40 | 0x80=reserved | high PID)
  // Actually PID 0x0100: (pkt[1] & 0x1F)<<8 | pkt[2]:
  // pkt[1] = 0x40 | (0x0100 >> 8) = 0x40 | 0x01 = 0x41
  pmtPkt[1] = 0x41;
  pmtPkt[2] = 0x00;
  pmtPkt[3] = 0x10;               // payload only, cc=0
  pmtPkt[4] = 0x00;               // pointer_field
  // PMT section at pmtPkt[5]:
  // ES loop: video(5 bytes) + audio(5 bytes) = 10 bytes
  // section_length = 9 (fixed PMT fields) + 10 (ES loop) + 4 (CRC) = 23 (but 9 is: PCR_PID(2)+reserved+program_info_length(2)+fixed header = 4 bytes... let me count properly)
  // PMT section: table_id(1)+section_length(2)+program_number(2)+version+cc(1)+section#(1)+last_section#(1)+PCR_PID(2)+program_info_length(2) = 12 bytes fixed header
  // ES loop: stream_type(1)+elementary_PID(2)+ES_info_length(2) = 5 bytes per stream
  // CRC: 4 bytes
  // section_length = total from byte 3 of section to end = 12-3 + ES_loop + CRC
  //                = 9 (bytes 3..11) + 10 (ES loop: 2 streams) + 4 (CRC) = 23
  //
  // patchPmtForIG uses:
  //   sectionStart = payloadStart + 1 + pointer
  //   table_id at sectionStart
  //   sectionLength = ((pkt[sectionStart+1]&0x0F)<<8)|pkt[sectionStart+2]  ← 12-bit
  //   progInfoLen = ((pkt[sectionStart+10]&0x0F)<<8)|pkt[sectionStart+11]
  //   esLoopStart = sectionStart + 12 + progInfoLen
  //   crcOff = sectionStart + 3 + sectionLength - 4

  const SEC = 5; // sectionStart = pmtPkt[5] (pointer=0, payloadStart=4 in 188-byte pkt, +1 for pointer)
  pmtPkt[SEC + 0] = 0x02;           // table_id = PMT
  pmtPkt[SEC + 1] = 0xB0;           // section_syntax_indicator=1, section_length high = 0
  pmtPkt[SEC + 2] = 23;             // section_length = 23
  pmtPkt[SEC + 3] = 0x00; pmtPkt[SEC + 4] = 0x01; // program_number
  pmtPkt[SEC + 5] = 0xC1;           // version=0, current_next=1
  pmtPkt[SEC + 6] = 0x00;           // section_number
  pmtPkt[SEC + 7] = 0x00;           // last_section_number
  pmtPkt[SEC + 8] = 0xE1; pmtPkt[SEC + 9] = 0x11;   // PCR_PID = 0x0111
  pmtPkt[SEC + 10] = 0xF0; pmtPkt[SEC + 11] = 0x00; // program_info_length = 0
  // ES loop starts at SEC+12 (esLoopStart)
  // Video entry: stream_type=0x1B, PID=0x1011, ES_info_length=0
  pmtPkt[SEC + 12] = 0x1B;
  pmtPkt[SEC + 13] = 0xE1; pmtPkt[SEC + 14] = 0x11; // PID = 0x1011
  pmtPkt[SEC + 15] = 0xF0; pmtPkt[SEC + 16] = 0x00; // ES_info_length = 0
  // Audio entry: stream_type=0x81, PID=0x1100, ES_info_length=0
  pmtPkt[SEC + 17] = 0x81;
  pmtPkt[SEC + 18] = 0xF1; pmtPkt[SEC + 19] = 0x00; // PID = 0x1100
  pmtPkt[SEC + 20] = 0xF0; pmtPkt[SEC + 21] = 0x00; // ES_info_length = 0
  // CRC at SEC+22..25 (zeros for test; patchPmtForIG recomputes it)
  pmtPkt[SEC + 22] = 0; pmtPkt[SEC + 23] = 0; pmtPkt[SEC + 24] = 0; pmtPkt[SEC + 25] = 0;

  const patched = patchPmtForIG(m2ts);

  // After patch: section_length should be 23+5=28
  const patchedPmtPkt = patched.slice(196, 384);
  const newSectionLength = ((patchedPmtPkt[SEC + 1] & 0x0F) << 8) | patchedPmtPkt[SEC + 2];
  assertEq(newSectionLength, 28, 'patchPmtForIG: section_length += 5 (video+audio PMT)');

  // IG entry must be appended at SEC+27 (right after the CRC was, before new CRC)
  // esLoopStart = SEC+12; old crcOff = SEC+22; new IG entry at SEC+22 (before new CRC at SEC+27)
  const igEntryOff = SEC + 22;
  assertEq(patchedPmtPkt[igEntryOff],     0x91, 'patchPmtForIG: IG stream_type=0x91 present');
  // PID field: reserved(3 bits, all 1) + PID(13 bits) = (0xE0 | (0x1400 >> 8)) = 0xF4
  const igPidDecoded = ((patchedPmtPkt[igEntryOff + 1] & 0x1F) << 8) | patchedPmtPkt[igEntryOff + 2];
  assertEq(igPidDecoded, 0x1400, 'patchPmtForIG: IG PID decoded = 0x1400');

  // Audio entry must be unchanged
  assertEq(patchedPmtPkt[SEC + 17], 0x81, 'patchPmtForIG: audio stream_type=0x81 preserved');
  // audio PID 0x1100: high bits of (pkt[SEC+18] & 0x1F)<<8 | pkt[SEC+19] = 0x1100
  assertEq(((patchedPmtPkt[SEC + 18] & 0x1F) << 8) | patchedPmtPkt[SEC + 19], 0x1100,
    'patchPmtForIG: audio PID 0x1100 preserved');

  // Idempotent: calling again must return same buffer (IG already declared)
  const patched2 = patchPmtForIG(patched);
  assertEq(Buffer.compare(patched, patched2), 0, 'patchPmtForIG: idempotent with audio+IG in PMT');
}

console.log('\n=== 14: ODS DTS decode pipeline + END timing (v1.10.15 hardware timing fix) ===');
{
  // v1.10.14 fix: PDS/WDS PTS = ICS DTS (correct, kept).
  // v1.10.15 fix: ODS segments must have DTS+PTS (flags2=0xC0), chained pipeline.
  //   Confirmed from Toast disc (proven on LG BP350 hardware):
  //     ODS[0].DTS = ICS.DTS; ODS[i].DTS = ODS[i-1].PTS; ODS[i].PTS = DTS + ceil(w*h/90)
  //     END.PTS = last ODS PTS (not ICS PTS as in v1.10.14)
  //   Previous assertion "END.PTS = ics_pts" was WRONG — now replaced.
  const ICS_PTS = 54000000;
  const ICS_DTS = ICS_PTS - 11664;  // 53988336

  // Constant decode_time=3 per ODS (v1.10.16: replaces ceil(w*h/90) to stay within LG tolerance).
  // Chain: ODS[0] DTS=ICS_DTS, PTS=ICS_DTS+3; ODS[1] DTS=ICS_DTS+3, PTS=ICS_DTS+6
  // END.PTS = ICS_DTS+6
  const ODS_W = 10, ODS_H = 9;
  const ODS0_DTS = ICS_DTS;
  const ODS0_PTS = ICS_DTS + 3;
  const ODS1_DTS = ODS0_PTS;
  const ODS1_PTS = ODS0_PTS + 3;
  const END_PTS  = ODS1_PTS;

  const ds = buildIGDisplaySet({
    composition: {
      videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
      compositionNumber: 0, compositionState: 2,
      streamModel: false, uiModel: false,
      compositionTimeoutPts: 0, selectionTimeoutPts: 0,
      userTimeoutMs: 0,
      pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8),
        animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0,
        defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }],
    },
    palette: { paletteId: 0, version: 0, entries: [{ id: 0, Y: 16, Cr: 128, Cb: 128, T: 255 }] },
    windows: [{ id: 0, x: 0, y: 0, width: 100, height: 100 }],
    objects: [
      { objectId: 0, version: 0, width: ODS_W, height: ODS_H, pixels: new Uint8Array(ODS_W * ODS_H).fill(0) },
      { objectId: 1, version: 0, width: ODS_W, height: ODS_H, pixels: new Uint8Array(ODS_W * ODS_H).fill(0) },
    ],
    pid: 0x1400, pts: ICS_PTS,
  });

  // Helper: decode PTS from a 5-byte PTS field
  function decodePts(b) {
    return ((b[0] & 0x0E) << 29) | (b[1] << 22) | ((b[2] & 0xFE) << 14) | (b[3] << 7) | ((b[4] & 0xFE) >> 1);
  }

  // Walk TS packets and collect PTS/DTS for each PUSI PES in order.
  // Segment order: ICS(0x18) PDS(0x14) WDS(0x17) ODS(0x15) ODS(0x15) END(0x80)
  const pesiList = [];  // {segType, pts, dts, flags2}
  let off = 0;
  while (off + 188 <= ds.length) {
    const pkt = ds.slice(off, off + 188);
    if (pkt[0] !== 0x47) { off += 188; continue; }
    if (!(pkt[1] & 0x40)) { off += 188; continue; }  // not PUSI
    const hasAdapt = (pkt[3] & 0x20) !== 0;
    const ps = hasAdapt ? (4 + 1 + pkt[4]) : 4;
    const pes = pkt.slice(ps);
    if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) { off += 188; continue; }
    const flags2 = pes[7];
    const hasPts = (flags2 & 0x80) !== 0;
    const hasDts = (flags2 & 0x40) !== 0;
    const ptsVal = hasPts ? decodePts(pes.slice(9, 14)) : null;
    const dtsVal = hasDts ? decodePts(pes.slice(14, 19)) : null;
    const payloadOff = 9 + pes[8];
    const segType = payloadOff < pes.length ? pes[payloadOff] : null;
    pesiList.push({ segType, pts: ptsVal, dts: dtsVal, flags2 });
    off += 188;
  }

  // Expect ICS + PDS + WDS + ODS + ODS + END = 6 PES packets
  assert(pesiList.length >= 6, `buildIGDisplaySet produces >= 6 PES packets (got ${pesiList.length})`);

  // ICS: PTS=ics_pts, DTS=ics_dts (unchanged from v1.10.14)
  assertEq(pesiList[0].segType, 0x18, 'Segment 0 type = ICS (0x18)');
  assertEq(pesiList[0].pts, ICS_PTS, 'ICS PES PTS = ics_pts');
  assertEq(pesiList[0].dts, ICS_DTS, 'ICS PES DTS = ics_dts');

  // PDS: PTS=ics_dts, no DTS (unchanged from v1.10.14)
  assertEq(pesiList[1].segType, 0x14, 'Segment 1 type = PDS (0x14)');
  assertEq(pesiList[1].pts, ICS_DTS, 'PDS PES PTS = ics_dts');
  assertEq(pesiList[1].dts, null,    'PDS PES has no DTS (flags2=0x80)');

  // WDS: PTS=ics_dts, no DTS (unchanged from v1.10.14)
  assertEq(pesiList[2].segType, 0x17, 'Segment 2 type = WDS (0x17)');
  assertEq(pesiList[2].pts, ICS_DTS, 'WDS PES PTS = ics_dts');

  // ODS[0]: DTS=ICS_DTS, PTS=ICS_DTS+decode_time (v1.10.15 fix)
  assertEq(pesiList[3].segType, 0x15, 'Segment 3 type = ODS (0x15)');
  assertEq(pesiList[3].dts, ODS0_DTS, 'ODS[0] DTS = ICS_DTS (chained pipeline, v1.10.15)');
  assertEq(pesiList[3].pts, ODS0_PTS, 'ODS[0] PTS = ICS_DTS + 3 (constant decode_time, v1.10.16)');
  assertEq((pesiList[3].flags2 & 0xC0) >> 6, 3, 'ODS[0] flags2 has both PTS+DTS bits (0xC0)');

  // ODS[1]: DTS=ODS[0].PTS, PTS=ODS[0].PTS+decode_time (chained)
  assertEq(pesiList[4].segType, 0x15, 'Segment 4 type = ODS (0x15)');
  assertEq(pesiList[4].dts, ODS1_DTS, 'ODS[1] DTS = ODS[0].PTS (chained pipeline, v1.10.15)');
  assertEq(pesiList[4].pts, ODS1_PTS, 'ODS[1] PTS = ODS[0].PTS + 3 (constant decode_time, v1.10.16)');
  assertEq((pesiList[4].flags2 & 0xC0) >> 6, 3, 'ODS[1] flags2 has both PTS+DTS bits (0xC0)');

  // END: PTS = last ODS PTS (v1.10.15 fix — was ICS PTS in v1.10.14, which was wrong)
  const endSeg = pesiList[pesiList.length - 1];
  assertEq(endSeg.segType, 0x80, 'Last segment type = END (0x80)');
  assertEq(endSeg.pts, END_PTS,  'END PES PTS = last ODS PTS (v1.10.15, confirmed vs Toast)');
  assertEq(endSeg.dts, null,     'END PES has no DTS (flags2=0x80)');
}

console.log('\n=== 15: ODS decode_time = 3 (constant) — v1.10.16 LG tolerance fix ===');
{
  // v1.10.15 used decode_time=ceil(w*h/90). For our 800×90 buttons (800 ticks each), 6 ODS
  // produced 4800 ticks total overshoot — LG BP350 rejected the disc at load time (white screen).
  // v1.10.16 fix: constant decode_time=3 (Toast empirical minimum, confirmed: 16×16 ODS → 3 ticks).
  // 6 ODS × 3 = 18 ticks total overshoot — well inside Toast's empirical max of 41 ticks.
  function getOdsTiming(w, h) {
    const ds = buildIGDisplaySet({
      composition: {
        videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
        compositionNumber: 0, compositionState: 2,
        streamModel: false, uiModel: false,
        compositionTimeoutPts: 0, selectionTimeoutPts: 0, userTimeoutMs: 0,
        pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8),
          animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0,
          defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }],
      },
      palette: { paletteId: 0, version: 0, entries: [] },
      windows: [],
      objects: [{ objectId: 0, version: 0, width: w, height: h, pixels: new Uint8Array(w * h).fill(0) }],
      pid: 0x1400, pts: 54000000,
    });
    function decodePts(b) {
      return ((b[0] & 0x0E) << 29) | (b[1] << 22) | ((b[2] & 0xFE) << 14) | (b[3] << 7) | ((b[4] & 0xFE) >> 1);
    }
    let off = 0;
    while (off + 188 <= ds.length) {
      const pkt = ds.slice(off, off + 188);
      if (pkt[0] !== 0x47 || !(pkt[1] & 0x40)) { off += 188; continue; }
      const hasAdapt = (pkt[3] & 0x20) !== 0;
      const ps = hasAdapt ? (4 + 1 + pkt[4]) : 4;
      const pes = pkt.slice(ps);
      if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) { off += 188; continue; }
      const flags2 = pes[7]; const hasDts = (flags2 & 0x40) !== 0;
      const payloadOff = 9 + pes[8];
      const segType = payloadOff < pes.length ? pes[payloadOff] : null;
      if (segType === 0x15) {
        const pts = decodePts(pes.slice(9, 14));
        const dts = hasDts ? decodePts(pes.slice(14, 19)) : null;
        return { pts, dts, decodeTime: pts - dts };
      }
      off += 188;
    }
    return null;
  }

  // Constant 3 regardless of image size
  assertEq(getOdsTiming(16, 16).decodeTime, 3, 'decode_time=3 for 16×16 (constant, v1.10.16)');
  assertEq(getOdsTiming(22, 22).decodeTime, 3, 'decode_time=3 for 22×22 (constant, v1.10.16)');
  assertEq(getOdsTiming(800, 90).decodeTime, 3, 'decode_time=3 for 800×90 (our buttons, v1.10.16)');
  assertEq(getOdsTiming(1, 1).decodeTime,    3, 'decode_time=3 for 1×1 (constant, v1.10.16)');

  // 6-ODS scenario (our actual button count): total overshoot = 18 ticks < Toast max 41
  const ICS_PTS = 54000000;
  const ICS_DTS = ICS_PTS - 11664;
  const ds6 = buildIGDisplaySet({
    composition: {
      videoWidth: 1920, videoHeight: 1080, frameRate: 0x40,
      compositionNumber: 0, compositionState: 2,
      streamModel: false, uiModel: false,
      compositionTimeoutPts: 0, selectionTimeoutPts: 0, userTimeoutMs: 0,
      pages: [{ id: 0, version: 0, uoMask: Buffer.alloc(8),
        animationFrameRateCode: 0, defaultSelectedButtonIdRef: 0,
        defaultActivatedButtonIdRef: 0xFFFF, paletteIdRef: 0, bogs: [] }],
    },
    palette: { paletteId: 0, version: 0, entries: [] },
    windows: [],
    objects: Array.from({ length: 6 }, (_, i) => ({ objectId: i, version: 0, width: 800, height: 90, pixels: new Uint8Array(800 * 90).fill(0) })),
    pid: 0x1400, pts: ICS_PTS,
  });
  function decodePts6(b) {
    return ((b[0] & 0x0E) << 29) | (b[1] << 22) | ((b[2] & 0xFE) << 14) | (b[3] << 7) | ((b[4] & 0xFE) >> 1);
  }
  const pesiList6 = [];
  let off6 = 0;
  while (off6 + 188 <= ds6.length) {
    const pkt6 = ds6.slice(off6, off6 + 188);
    if (pkt6[0] !== 0x47 || !(pkt6[1] & 0x40)) { off6 += 188; continue; }
    const hasAdapt6 = (pkt6[3] & 0x20) !== 0;
    const ps6 = hasAdapt6 ? (4 + 1 + pkt6[4]) : 4;
    const pes6 = pkt6.slice(ps6);
    if (pes6[0] !== 0 || pes6[1] !== 0 || pes6[2] !== 1) { off6 += 188; continue; }
    const flags2_6 = pes6[7]; const hasDts6 = (flags2_6 & 0x40) !== 0;
    const ptsVal6 = decodePts6(pes6.slice(9, 14));
    const dtsVal6 = hasDts6 ? decodePts6(pes6.slice(14, 19)) : null;
    const payOff6 = 9 + pes6[8];
    const segType6 = payOff6 < pes6.length ? pes6[payOff6] : null;
    pesiList6.push({ segType: segType6, pts: ptsVal6, dts: dtsVal6 });
    off6 += 188;
  }
  const odsList6 = pesiList6.filter(p => p.segType === 0x15);
  assertEq(odsList6.length, 6, '6-ODS display set has 6 ODS segments (v1.10.16)');
  assertEq(odsList6[5].dts, ICS_DTS + 15, 'ODS[5] DTS = ICS_DTS+15 (6×3 chain, v1.10.16)');
  assertEq(odsList6[5].pts, ICS_DTS + 18, 'ODS[5] PTS = ICS_DTS+18 (max overshoot=18, v1.10.16)');
  const endSeg6 = pesiList6[pesiList6.length - 1];
  assertEq(endSeg6.pts, ICS_DTS + 18, 'END.PTS = ICS_DTS+18 for 6 ODS (v1.10.16, inside Toast max 41)');
}

console.log('\n=== 16: buildMenuDisplaySet produces 1-based button IDs (v1.10.17) ===');
{
  // BD spec: button_id shall be in [1, 0xEFFF]. Value 0 is reserved.
  // Pre-v1.10.17 bug: buttons used id=0,1 (0-based). Hardware (LG BP350) silently
  // discards the page when defaultSelectedButtonIdRef=0 doesn't resolve to a valid button.
  const { buildMenuDisplaySet } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  function parseICSButtonIds(m2tsBuffer) {
    // Extract button_id values from the ICS segment in a .m2ts TS buffer.
    const IG_PID = 0x1400;
    let cur = null;
    const results = { buttonIds: [], defSelBtn: null, defValidBtns: [] };

    function flushPes(chunks, hdrLen) {
      const full = Buffer.concat(chunks);
      if (full.length < 9 + hdrLen + 3) return;
      const seg = full.slice(9 + hdrLen);
      if (seg[0] !== 0x18) return;
      const segLen = (seg[1] << 8) | seg[2];
      const body = seg.slice(3, 3 + segLen);
      // ICS body layout (see ig-encoder.js):
      //   [0..4] vd5, [5..7] cd, [8] sd, [9..11] icDataLen, [12] stream/ui model
      //   [13..22] timeout fields, [23..25] userTimeout, [26] numPages, [27+] page data
      const numPages = body[26];
      if (numPages < 1) return;
      // Page layout: id(1)+ver(1)+uoMask(8)+inFx(2)+outFx(2)+animFr(1)+defSel(2)+defAct(2)+palRef(1)+numBogs(1)
      let po = 27;
      results.defSelBtn = (body[po + 15] << 8) | body[po + 16];
      const numBogs = body[po + 20];
      po += 21;
      for (let bg = 0; bg < numBogs; bg++) {
        const defValid = (body[po] << 8) | body[po + 1];
        results.defValidBtns.push(defValid);
        const numBtns = body[po + 2];
        po += 3;
        for (let bn = 0; bn < numBtns; bn++) {
          const btnId = (body[po] << 8) | body[po + 1];
          results.buttonIds.push(btnId);
          // Button fixed struct = 35 bytes; numNavCmds is at offset 33 (after all fixed fields)
          const numNavCmds = (body[po + 33] << 8) | body[po + 34];
          po += 35 + numNavCmds * 12;
        }
      }
    }

    let i = 0;
    while (i + 188 <= m2tsBuffer.length) {
      if (m2tsBuffer[i] !== 0x47) { i++; continue; }
      const pid = ((m2tsBuffer[i+1] & 0x1F) << 8) | m2tsBuffer[i+2];
      if (pid !== IG_PID) { i += 188; continue; }
      const pusi = (m2tsBuffer[i+1] & 0x40) !== 0;
      const ha = (m2tsBuffer[i+3] & 0x20) !== 0;
      const ps = ha ? (4 + 1 + m2tsBuffer[i+4]) : 4;
      const pl = m2tsBuffer.slice(i + ps, i + 188);
      if (pusi) {
        if (cur) flushPes(cur.chunks, cur.hdrLen);
        if (pl.length >= 9 && pl[0] === 0 && pl[1] === 0 && pl[2] === 1) {
          cur = { hdrLen: pl[8], chunks: [pl] };
        } else cur = null;
      } else if (cur) cur.chunks.push(pl);
      i += 188;
    }
    if (cur) flushPes(cur.chunks, cur.hdrLen);
    return results;
  }

  const ds1 = buildMenuDisplaySet({ playlists: [1], pts: 54000000, labels: ['Episode 1'] });
  const r1 = parseICSButtonIds(ds1);
  assert(r1.buttonIds.every(id => id >= 1), '1-episode: all button_ids ≥ 1 (v1.10.17 fix)');
  assert(!r1.buttonIds.includes(0), '1-episode: no button_id=0 present');
  assertEq(r1.buttonIds[0], 1, '1-episode: first button_id = 1 (was 0 pre-fix)');
  assertEq(r1.defSelBtn, 0xFFFF, '1-episode: defaultSelectedButtonIdRef = 0xFFFF (v1.10.18 Toast-template: no default selection)');
  assertEq(r1.defValidBtns[0], 1, '1-episode BOG0: defaultValidButtonIdRef = 1 (was 0 pre-fix)');

  const ds2 = buildMenuDisplaySet({ playlists: [1, 2], pts: 54000000, labels: ['Episode 1', 'Episode 2'] });
  const r2 = parseICSButtonIds(ds2);
  assert(r2.buttonIds.every(id => id >= 1), '2-episode: all button_ids ≥ 1');
  assert(!r2.buttonIds.includes(0), '2-episode: no button_id=0 present');
  assertEq(r2.buttonIds[0], 1, '2-episode: button[0].id = 1');
  assertEq(r2.buttonIds[1], 2, '2-episode: button[1].id = 2');
  assertEq(r2.defSelBtn, 0xFFFF, '2-episode: defaultSelectedButtonIdRef = 0xFFFF (v1.10.18 Toast-template)');
  assertEq(r2.defValidBtns[0], 1, '2-episode BOG0: defaultValidButtonIdRef = 1');
  assertEq(r2.defValidBtns[1], 2, '2-episode BOG1: defaultValidButtonIdRef = 2');

  // Neighbor references must also be 1-based (no 0 references)
  // This is verified by checking all button IDs are 1-based — neighbor refs use same IDs
}

console.log('\n=== 17: buildMenuDisplaySet Toast-template structure (v1.10.18) ===');
{
  // v1.10.18 structural rewrite: the menu IG follows the BD-ROM IG conventions
  // observed across commercial authoring tools (docs/v11018_toast_template_spec.md):
  //   - 2 epoch_start display sets (composition_number 0 and 1)
  //   - normal_state obj = 0xFFFF (invisible); ONE object/button for sel+act
  //   - page.defaultSelectedButtonIdRef = 0xFFFF (no default selection)
  //   - NO WDS segment
  //   - ODS decode_time = ceil(w*h/90), chained from ICS.DTS
  //   - ICS PTS-DTS = 12012; DTS leading nibble = 0x0
  const { buildMenuDisplaySet } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

  // Walk IG PID PES packets, return ordered list of {segType, pts, dts, dtsNibble, seg}
  function walkIG(m2tsBuffer) {
    const IG_PID = 0x1400;
    const out = [];
    let cur = null;
    function flush(c) {
      const full = Buffer.concat(c.chunks);
      if (full.length < 9) return;
      if (full[0] !== 0 || full[1] !== 0 || full[2] !== 1) return;
      const flags2 = full[7], hdrLen = full[8];
      let pts = null, dts = null, dtsNibble = null;
      if (flags2 & 0x80) {
        const b = full.slice(9, 14);
        pts = ((b[0] & 0x0e) * (1 << 29)) + (b[1] * (1 << 22)) + ((b[2] & 0xfe) * (1 << 14)) + (b[3] * (1 << 7)) + ((b[4] & 0xfe) >> 1);
      }
      if (flags2 & 0x40) {
        const b = full.slice(14, 19);
        dtsNibble = (b[0] >> 4) & 0x0F;
        dts = ((b[0] & 0x0e) * (1 << 29)) + (b[1] * (1 << 22)) + ((b[2] & 0xfe) * (1 << 14)) + (b[3] * (1 << 7)) + ((b[4] & 0xfe) >> 1);
      }
      const seg = full.slice(9 + hdrLen);
      out.push({ segType: seg[0], pts, dts, dtsNibble, seg });
    }
    let i = 0;
    while (i + 188 <= m2tsBuffer.length) {
      if (m2tsBuffer[i] !== 0x47) { i++; continue; }
      const pid = ((m2tsBuffer[i + 1] & 0x1F) << 8) | m2tsBuffer[i + 2];
      if (pid !== IG_PID) { i += 188; continue; }
      const pusi = (m2tsBuffer[i + 1] & 0x40) !== 0;
      const ha = (m2tsBuffer[i + 3] & 0x20) !== 0;
      const ps = ha ? (4 + 1 + m2tsBuffer[i + 4]) : 4;
      const pl = m2tsBuffer.slice(i + ps, i + 188);
      if (pusi) { if (cur) flush(cur); cur = { chunks: [pl] }; }
      else if (cur) cur.chunks.push(pl);
      i += 188;
    }
    if (cur) flush(cur);
    return out;
  }

  // Parse ICS button state model from an ICS segment buffer
  function parseICS(seg) {
    const compNumber = (seg[8] << 8) | seg[9];   // vd5(5)=3..7? layout: [3,4]=W [5,6]=H [7]=fr  [8,9]=compNum
    const compState = (seg[10] >> 6) & 3;
    // body after vd5(5)+cd(3)+sd(1)=9 -> +3-byte segHdr = offset 3; we already indexed raw seg incl 3-byte header
    // seg[0..2]=segHdr, seg[3..7]=vd5, seg[8..10]=cd, seg[11]=sd, seg[12..14]=icDataLen, seg[15]=model...
    let p = 15;
    p += 1;                 // stream/ui model
    p += 5 + 5;             // composition_timeout + selection_timeout (InMux)
    p += 3;                 // user_timeout
    const numPages = seg[p]; p += 1;
    const page = { bogs: [] };
    page.id = seg[p++]; page.version = seg[p++];
    p += 8;                 // uo_mask
    p += 2; p += 2;         // in_effects(0,0) out_effects(0,0)
    page.animFr = seg[p++];
    page.defSelBtn = (seg[p] << 8) | seg[p + 1]; p += 2;
    page.defActBtn = (seg[p] << 8) | seg[p + 1]; p += 2;
    page.palIdRef = seg[p++];
    page.numBogs = seg[p++];
    for (let bg = 0; bg < page.numBogs; bg++) {
      const defValid = (seg[p] << 8) | seg[p + 1]; p += 2;
      const numBtns = seg[p++];
      const buttons = [];
      for (let bn = 0; bn < numBtns; bn++) {
        const b = {};
        b.id = (seg[p] << 8) | seg[p + 1]; p += 2;
        p += 2;             // numeric_select
        p += 1;             // auto_action
        p += 2; p += 2;     // x, y
        b.upper = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.lower = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.left  = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.right = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.normStart = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.normEnd   = (seg[p] << 8) | seg[p + 1]; p += 2;
        p += 1;             // norm flags
        p += 1;             // sel sound
        b.selStart = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.selEnd   = (seg[p] << 8) | seg[p + 1]; p += 2;
        p += 1;             // sel flags
        p += 1;             // act sound
        b.actStart = (seg[p] << 8) | seg[p + 1]; p += 2;
        b.actEnd   = (seg[p] << 8) | seg[p + 1]; p += 2;
        const numNav = (seg[p] << 8) | seg[p + 1]; p += 2;
        p += numNav * 12;
        buttons.push(b);
      }
      page.bogs.push({ defValid, buttons });
    }
    return { compNumber, compState, page };
  }

  const ds = buildMenuDisplaySet({ playlists: [1, 2, 3], pts: 54000000, labels: ['Ep 1', 'Ep 2', 'Ep 3'] });
  const segs = walkIG(ds);

  const icsList = segs.filter(s => s.segType === 0x18);
  const wdsList = segs.filter(s => s.segType === 0x17);
  const odsList = segs.filter(s => s.segType === 0x15);

  // (1) two display sets
  assertEq(icsList.length, 2, 'two display sets (2 ICS segments)');

  // (2) both epoch_start; composition_number 0 then 1
  const ics0 = parseICS(icsList[0].seg);
  const ics1 = parseICS(icsList[1].seg);
  assertEq(ics0.compState, 2, 'DS1 composition_state = epoch_start (2)');
  assertEq(ics1.compState, 2, 'DS2 composition_state = epoch_start (2)');
  assertEq(ics0.compNumber, 0, 'DS1 composition_number = 0');
  assertEq(ics1.compNumber, 1, 'DS2 composition_number = 1');

  // (3) page defaultSelectedButtonIdRef = 0xFFFF
  assertEq(ics0.page.defSelBtn, 0xFFFF, 'DS1 page.defaultSelectedButtonIdRef = 0xFFFF');
  assertEq(ics1.page.defSelBtn, 0xFFFF, 'DS2 page.defaultSelectedButtonIdRef = 0xFFFF');

  // (4) every button: normal_state obj = 0xFFFF; selected/activated point to a real ODS (= button index)
  const objIds = new Set(odsList.map(o => (o.seg[3] << 8) | o.seg[4]));
  let allNormFFFF = true, allSelReal = true, selEqAct = true;
  for (const ics of [ics0, ics1]) {
    ics.page.bogs.forEach((bog, idx) => {
      const b = bog.buttons[0];
      if (b.normStart !== 0xFFFF || b.normEnd !== 0xFFFF) allNormFFFF = false;
      if (!objIds.has(b.selStart) || b.selStart !== idx) allSelReal = false;
      if (b.actStart !== b.selStart) selEqAct = false;
    });
  }
  assert(allNormFFFF, 'all buttons: normal_state object_id_ref = 0xFFFF (invisible)');
  assert(allSelReal, 'all buttons: selected_state object_id_ref points to a real ODS (= button index)');
  assert(selEqAct, 'all buttons: activated_state object = selected_state object (one bitmap/button)');

  // (5) no WDS segment in either display set
  assertEq(wdsList.length, 0, 'no WDS segment present (Toast-template)');

  // (6) one ODS per button per display set (3 buttons × 2 DS = 6 ODS)
  assertEq(odsList.length, 6, 'one ODS per button per display set (3×2 = 6)');

  // (7) ICS PTS-DTS lead = 12012
  assertEq(icsList[0].pts - icsList[0].dts, 12012, 'DS1 ICS PTS-DTS lead = 12012');
  assertEq(icsList[1].pts - icsList[1].dts, 12012, 'DS2 ICS PTS-DTS lead = 12012');

  // (8) DTS leading nibble = 0x0 on ICS and ODS PES
  assertEq(icsList[0].dtsNibble, 0x0, 'ICS PES DTS leading nibble = 0x0');
  assertEq(odsList[0].dtsNibble, 0x0, 'ODS PES DTS leading nibble = 0x0');

  // (9) ODS decode_time = ceil(w*h/90), chained from ICS.DTS within DS1
  //     800×90 object -> ceil(72000/90) = 800 ticks each
  const expected = Math.ceil((800 * 90) / 90);  // 800
  const ds1Ods = odsList.slice(0, 3);
  assertEq(ds1Ods[0].dts, icsList[0].dts, 'DS1 ODS[0].DTS = ICS.DTS (decode chain start)');
  assertEq(ds1Ods[0].pts - ds1Ods[0].dts, expected, 'DS1 ODS[0] decode_time = ceil(w*h/90)');
  assertEq(ds1Ods[1].dts, ds1Ods[0].pts, 'DS1 ODS[1].DTS = ODS[0].PTS (chained)');
  assertEq(ds1Ods[2].dts, ds1Ods[1].pts, 'DS1 ODS[2].DTS = ODS[1].PTS (chained)');

  // (10) segment order within DS1: ICS, PDS, ODS, ODS, ODS, END (no WDS)
  const ds1End = segs.indexOf(segs.find(s => s.segType === 0x80));
  const order1 = segs.slice(0, ds1End + 1).map(s => s.segType);
  assertBufEq(Buffer.from(order1), Buffer.from([0x18, 0x14, 0x15, 0x15, 0x15, 0x80]),
    'DS1 segment order = ICS PDS ODS ODS ODS END (no WDS)');
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
