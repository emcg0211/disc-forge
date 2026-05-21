'use strict';
/**
 * Unit tests for rewriteVideoPesDts() in src/lib/menu-builder.js
 * Run: node tests/rewrite-video-pes-dts.test.js
 *
 * Verifies that every video PUSI packet (PID 0x1011) in the BD m2ts output
 * has flags2=0xC0 (PTS+DTS) and hdr_len=10 after the rewrite, and that the
 * DTS value equals PTS minus the specified frame duration.
 */

const path = require('path');
const { rewriteVideoPesDts } = require(path.join(__dirname, '..', 'src', 'lib', 'menu-builder.js'));

let passed = 0;
let failed = 0;

function assert(cond, name, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}
function assertEq(a, b, name) {
  assert(a === b, name, `expected ${b} (0x${b.toString(16)}), got ${a} (0x${a.toString(16)})`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VIDEO_PID = 0x1011;
const PMT_PID   = 0x0100;

/** Encode a 90kHz timestamp as 5 PTS bytes (PTS-only, prefix nibble 0x21). */
function encodePTS(ts) {
  const buf = Buffer.alloc(5);
  buf[0] = 0x21 | (((ts >> 30) & 0x07) << 1);
  buf[1] = (ts >> 22) & 0xFF;
  buf[2] = ((ts >> 15) & 0x7F) << 1 | 1;
  buf[3] = (ts >> 7) & 0xFF;
  buf[4] = ((ts & 0x7F) << 1) | 1;
  return buf;
}

/** Decode a 5-byte PTS/DTS field. */
function decodeTS(buf) {
  return ((buf[0] & 0x0e) * (1 << 29)) +
         (buf[1] * (1 << 22)) +
         ((buf[2] & 0xfe) * (1 << 14)) +
         (buf[3] * (1 << 7)) +
         ((buf[4] & 0xfe) >> 1);
}

/**
 * Build a minimal 192-byte BD m2ts packet for PID with PUSI set.
 * opts.hasDts: if true, write flags2=0xC0 with DTS already present
 * opts.afStuffing: if > 0, add adaptation field with this many stuffing bytes
 * opts.pts: 90kHz PTS value
 */
function makeVideoPusiPacket(opts = {}) {
  const { pts = 54000000, hasDts = false, afStuffing = 0 } = opts;

  const buf = Buffer.alloc(192, 0xFF);  // fill with 0xFF (stuffing)

  // 4-byte arrival timestamp
  buf.writeUInt32BE(0x12345678, 0);

  // TS header
  buf[4] = 0x47;                        // sync
  buf[5] = 0x40 | ((VIDEO_PID >> 8) & 0x1f);  // PUSI=1, PID high
  buf[6] = VIDEO_PID & 0xff;            // PID low
  // adaptation_field_control: 01=payload only, 11=AF+payload
  const hasAF = afStuffing > 0;
  buf[7] = hasAF ? 0x31 : 0x11;        // afc | cc=1

  let payloadOff = 8;  // offset into buf (= pkt[4] = TS packet byte 4)
  if (hasAF) {
    const afContent = afStuffing + 1;   // 1 flags byte + afStuffing stuffing bytes
    buf[8] = afContent;                 // adaptation_field_length
    buf[9] = 0x00;                      // AF flags (no PCR)
    // stuffing bytes at buf[10..10+afStuffing-1] are already 0xFF
    payloadOff = 9 + afContent;         // skip length byte + content
  }

  // PES header
  const hdrLen = hasDts ? 10 : 5;
  buf[payloadOff + 0] = 0x00;
  buf[payloadOff + 1] = 0x00;
  buf[payloadOff + 2] = 0x01;
  buf[payloadOff + 3] = 0xE0;          // video stream_id
  buf[payloadOff + 4] = 0x00;
  buf[payloadOff + 5] = 0x2C;          // PES_packet_length=44
  buf[payloadOff + 6] = 0x84;          // flags1
  buf[payloadOff + 7] = hasDts ? 0xC0 : 0x80;  // flags2
  buf[payloadOff + 8] = hdrLen;
  // PTS
  encodePTS(pts).copy(buf, payloadOff + 9);
  if (hasDts) {
    // DTS: same 5-byte encoding, prefix nibble 0x11
    const dts = pts - 3750;
    const dtsBuf = Buffer.alloc(5);
    dtsBuf[0] = 0x11 | (((dts / (1 << 29)) | 0) << 1);
    dtsBuf[1] = (dts >> 22) & 0xff;
    dtsBuf[2] = 0x01 | (((dts >> 14) & 0x7f) << 1);
    dtsBuf[3] = (dts >> 7) & 0xff;
    dtsBuf[4] = 0x01 | ((dts & 0x7f) << 1);
    dtsBuf.copy(buf, payloadOff + 14);
  }

  return buf;
}

/** Build a minimal 192-byte packet for a non-video PID (e.g. PMT). */
function makeOtherPacket(pid = PMT_PID) {
  const buf = Buffer.alloc(192, 0x00);
  buf.writeUInt32BE(0x00000000, 0);
  buf[4] = 0x47;
  buf[5] = 0x40 | ((pid >> 8) & 0x1f);
  buf[6] = pid & 0xff;
  buf[7] = 0x11;
  return buf;
}

/** Build a 192-byte video continuation packet (no PUSI). */
function makeVideoContinuationPacket(cc = 2) {
  const buf = Buffer.alloc(192, 0xAB);
  buf.writeUInt32BE(0x00000100, 0);
  buf[4] = 0x47;
  buf[5] = (VIDEO_PID >> 8) & 0x1f;   // PUSI=0
  buf[6] = VIDEO_PID & 0xff;
  buf[7] = 0x11 | (cc & 0x0f);
  return buf;
}

/**
 * Scan all video PUSI packets in a 192-byte m2ts buffer and return
 * { flags2, hdrLen, pts, dts } for each.
 */
function scanVideoPusi(m2tsBuf) {
  const results = [];
  for (let i = 0; i + 192 <= m2tsBuf.length; i += 192) {
    const pkt = m2tsBuf.slice(i + 4, i + 192);
    if (pkt[0] !== 0x47) continue;
    const pid  = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const pusi = (pkt[1] >> 6) & 1;
    const afc  = (pkt[3] >> 4) & 3;
    if (pid !== VIDEO_PID || !pusi) continue;
    const afLen = (afc & 2) ? pkt[4] : 0;
    const payloadStart = (afc & 2) ? 5 + afLen : 4;
    const pes = pkt.slice(payloadStart);
    if (pes.length < 19) continue;
    const flags2 = pes[7];
    const hdrLen = pes[8];
    const pts    = decodeTS(pes.slice(9, 14));
    const dts    = (flags2 & 0x40) ? decodeTS(pes.slice(14, 19)) : null;
    results.push({ flags2, hdrLen, pts, dts });
  }
  return results;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

console.log('\n=== rewriteVideoPesDts: basic cases ===');

{
  // Single PTS-only PUSI with 80 stuffing bytes → should gain DTS
  const pkt = makeVideoPusiPacket({ pts: 54003750, afStuffing: 80 });
  const out = rewriteVideoPesDts(pkt);
  const results = scanVideoPusi(out);
  assert(results.length === 1, 'single packet: one video PUSI found');
  assertEq(results[0].flags2, 0xC0, 'flags2 = 0xC0 (PTS+DTS)');
  assertEq(results[0].hdrLen, 10,   'hdr_len = 10');
  assertEq(results[0].pts,    54003750, 'PTS unchanged');
  assertEq(results[0].dts,    54003750 - 3750, 'DTS = PTS - 3750');
}

console.log('\n=== rewriteVideoPesDts: already-has-DTS packet is not re-patched ===');

{
  // If tsMuxeR already wrote DTS (e.g. I/P frame), leave it alone
  const pkt = makeVideoPusiPacket({ pts: 54000000, hasDts: true, afStuffing: 70 });
  const original = Buffer.from(pkt);
  const out = rewriteVideoPesDts(pkt);
  assert(Buffer.compare(original, out) === 0, 'packet with existing DTS is not modified');
}

console.log('\n=== rewriteVideoPesDts: non-video packets are untouched ===');

{
  const pmtPkt = makeOtherPacket(PMT_PID);
  const vidPkt = makeVideoPusiPacket({ pts: 54007500, afStuffing: 77 });
  const m2ts   = Buffer.concat([pmtPkt, vidPkt]);
  const out    = rewriteVideoPesDts(m2ts);
  // PMT packet bytes should be identical
  assert(Buffer.compare(pmtPkt, out.slice(0, 192)) === 0, 'PMT packet unchanged');
  const results = scanVideoPusi(out);
  assertEq(results[0].flags2, 0xC0, 'video PUSI patched');
}

console.log('\n=== rewriteVideoPesDts: no-AF packet skipped (I/P frame edge case) ===');

{
  // Packet with no adaptation field and no DTS: we skip it (it would be an
  // IDR that tsMuxeR already gave DTS, but even if it didn't, no AF to steal from)
  const pkt = makeVideoPusiPacket({ pts: 54000000, hasDts: false, afStuffing: 0 });
  const out  = rewriteVideoPesDts(pkt);
  const results = scanVideoPusi(out);
  // Should remain PTS-only since there's no AF to steal from
  assertEq(results[0].flags2, 0x80, 'no-AF packet left untouched (no stuffing to steal)');
}

console.log('\n=== rewriteVideoPesDts: multiple packets, mixed types ===');

{
  // Build a stream: continuation, PMT, PUSI(with DTS), continuation, PUSI(no DTS, af=80)
  const c1   = makeVideoContinuationPacket(1);
  const pmt  = makeOtherPacket(PMT_PID);
  const pusi1 = makeVideoPusiPacket({ pts: 54000000, hasDts: true,  afStuffing: 72 }); // I-frame
  const c2   = makeVideoContinuationPacket(2);
  const pusi2 = makeVideoPusiPacket({ pts: 54003750, hasDts: false, afStuffing: 80 }); // B-frame

  const m2ts  = Buffer.concat([c1, pmt, pusi1, c2, pusi2]);
  const out   = rewriteVideoPesDts(m2ts);
  const results = scanVideoPusi(out);

  assert(results.length === 2, 'two video PUSI packets found');
  assertEq(results[0].flags2, 0xC0, 'PUSI#0 (I-frame, already DTS): flags2=0xC0');
  assertEq(results[0].pts, 54000000, 'PUSI#0 PTS unchanged');
  assertEq(results[1].flags2, 0xC0, 'PUSI#1 (B-frame, patched): flags2=0xC0');
  assertEq(results[1].hdrLen, 10,   'PUSI#1 hdr_len=10');
  assertEq(results[1].pts, 54003750,        'PUSI#1 PTS unchanged');
  assertEq(results[1].dts, 54003750 - 3750, 'PUSI#1 DTS = PTS - 3750');
}

console.log('\n=== rewriteVideoPesDts: adaptation field length decremented ===');

{
  // Verify the AF length byte in the TS packet shrinks by 5
  const pkt = makeVideoPusiPacket({ pts: 54011250, afStuffing: 100 });
  const afLenBefore = pkt[4 + 4];  // pkt[8] = TS packet byte 4 = af_length
  const out = rewriteVideoPesDts(pkt);
  const afLenAfter  = out[4 + 4];
  assertEq(afLenAfter, afLenBefore - 5, 'adaptation_field_length decremented by 5');
}

console.log('\n=== rewriteVideoPesDts: PTS+DTS prefix nibbles correct ===');

{
  // PTS prefix nibble must be 0x3? (0011) when DTS also present (BD spec §7.7.2)
  const pkt = makeVideoPusiPacket({ pts: 54022500, afStuffing: 80 });
  const out  = rewriteVideoPesDts(pkt);
  const afc  = (out[4 + 3] >> 4) & 3;
  const afL  = out[4 + 4];
  const ps   = (afc & 2) ? (5 + afL) : 4;          // payload start in TS packet
  const pes  = out.slice(4 + ps);
  assertEq((pes[9] >> 4), 0x3, 'PTS byte[0] high nibble = 0x3 (11xx)');
  assertEq((pes[14] >> 4), 0x1, 'DTS byte[0] high nibble = 0x1 (0001)');
}

console.log('\n=== rewriteVideoPesDts: PES_packet_length updated ===');

{
  // PES_packet_length (pes[4:5]) should increase by 5
  const pkt = makeVideoPusiPacket({ pts: 54015000, afStuffing: 80 });
  const ps0  = 5 + pkt[4 + 4];  // payload start before patch
  const lenBefore = (pkt[4 + ps0 + 4] << 8) | pkt[4 + ps0 + 5];
  const out  = rewriteVideoPesDts(pkt);
  const ps1  = 5 + out[4 + 4];
  const lenAfter  = (out[4 + ps1 + 4] << 8) | out[4 + ps1 + 5];
  assertEq(lenAfter, lenBefore + 5, 'PES_packet_length incremented by 5');
}

console.log('\n=== rewriteVideoPesDts: minimum stuffing boundary ===');

{
  // Exactly 6 stuffing bytes (minimum we require): should patch
  const pkt = makeVideoPusiPacket({ pts: 54018750, afStuffing: 6 });
  const out  = rewriteVideoPesDts(pkt);
  const r    = scanVideoPusi(out);
  assertEq(r[0].flags2, 0xC0, 'patched with 6 stuffing bytes (minimum)');
  assertEq(r[0].dts, 54018750 - 3750, 'DTS correct with minimum stuffing');
}

{
  // Only 5 stuffing bytes: NOT enough (need 1 flags byte + at least 5 stuffing
  // content = af_len must be >= 6; afStuffing=5 → af_len=6 total content: 1 flags + 5 stuffing)
  // Wait — afStuffing=5 in makeVideoPusiPacket → afContent=6, af[0]=flags → stuffing=5 bytes.
  // af_len=6 >= 6 → should patch (5 stuffing bytes are enough since we steal 5 from content
  // and af_len goes from 6 to 1, leaving just the flags byte).
  const pkt = makeVideoPusiPacket({ pts: 54022500, afStuffing: 5 });
  const out  = rewriteVideoPesDts(pkt);
  const r    = scanVideoPusi(out);
  assertEq(r[0].flags2, 0xC0, 'patched with afStuffing=5 (af_len=6, meets minimum)');
}

{
  // Only 4 stuffing bytes → af_len=5 < 6 → NOT patched
  const pkt = makeVideoPusiPacket({ pts: 54026250, afStuffing: 4 });
  const out  = rewriteVideoPesDts(pkt);
  const r    = scanVideoPusi(out);
  assertEq(r[0].flags2, 0x80, 'not patched with af_len=5 (below minimum 6)');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('OVERALL: FAIL');
  process.exit(1);
} else {
  console.log('OVERALL: PASS');
}
