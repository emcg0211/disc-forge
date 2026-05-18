#!/usr/bin/env python3
"""
Build a minimal BD test disc:
1. Take ep1+ep2 from TEST.iso
2. Add fresh splash (testsrc2 or PNG, proper m2ts with 119 frames)
3. Apply CLPI+MPLS patches
4. Build MovieObject with PLAY_PL(0) before PLAY_PL(1)
5. Package into TESTFIX2.iso
6. Test with VLC
"""
import subprocess, os, struct, tempfile, time, shutil

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'
HDIUTIL  = '/usr/bin/hdiutil'
VLC      = '/Applications/VLC.app/Contents/MacOS/VLC'
XORRISO  = '/opt/homebrew/bin/xorriso'
SRC_ISO  = os.path.expanduser('~/Desktop/TEST.iso')
OUT_ISO  = os.path.expanduser('~/Desktop/TESTFIX2.iso')

def u32be(buf, off): return struct.unpack('>I', buf[off:off+4])[0]
def w32be(buf, off, v): struct.pack_into('>I', buf, off, v)

def detach_all():
    for v in ['TEST', 'Test', 'TESTFIX2']:
        subprocess.run([HDIUTIL, 'detach', f'/Volumes/{v}', '-force'], capture_output=True)
    for mp in ['/tmp/src_mount', '/tmp/fix2_mount']:
        subprocess.run([HDIUTIL, 'detach', mp, '-force'], capture_output=True)

def run(cmd, desc, timeout=120):
    print(f"  {desc}...")
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in (0, 1):
        print(f"  FAIL exit={r.returncode} ({elapsed:.1f}s)")
        print(f"  STDERR: {r.stderr.decode(errors='replace')[-300:]}")
        return False
    print(f"  OK ({elapsed:.1f}s)")
    return True

def build_splash_m2ts(work):
    """Build fresh splash using testsrc2 → TS → MKV → tsMuxeR."""
    ts  = os.path.join(work, 'sp.ts')
    mkv = os.path.join(work, 'sp.mkv')
    bd  = os.path.join(work, 'sp_bd')
    os.makedirs(bd)

    run([FFMPEG, '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=1920x1080:rate=24000/1001',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-bf', '0', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', '5', '-shortest', '-f', 'mpegts', ts
    ], "ffmpeg testsrc2→TS")

    run([MKVMERGE, '-o', mkv, ts], "mkvmerge TS→MKV")

    meta = os.path.join(work, 'sp.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv}", lang=und, track=2\n')

    run([TSMUXER, meta, bd], "tsMuxeR→BD")

    m2ts = os.path.join(bd, 'BDMV', 'STREAM', '00000.m2ts')
    clpi = os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi')
    mpls = os.path.join(bd, 'BDMV', 'PLAYLIST', '00000.mpls')

    size_mb = os.path.getsize(m2ts) / 1024 / 1024
    print(f"  Splash m2ts: {size_mb:.1f} MB")
    return m2ts, clpi, mpls, bd

def patch_clpi_and_mpls(clpi_path, mpls_path, duration_sec=5):
    """Patch both CLPI pres_end and MPLS out_time."""
    mpls = bytearray(open(mpls_path, 'rb').read())
    in_t = u32be(mpls, 0x52)
    out_t = in_t + duration_sec * 45000
    w32be(mpls, 0x56, out_t)
    open(mpls_path, 'wb').write(mpls)

    clpi = bytearray(open(clpi_path, 'rb').read())
    ci_addr = u32be(clpi, 0x08)
    end_off = ci_addr + 22
    w32be(clpi, end_off, out_t)
    open(clpi_path, 'wb').write(clpi)

    print(f"  Patched MPLS+CLPI: in=0x{in_t:08X} out=0x{out_t:08X} dur={duration_sec}s")

def inject_play_pl_splash(mobj_path):
    """Check if PLAY_PL(0) already patched, if not insert it before PLAY_PL(1)."""
    buf = bytearray(open(mobj_path, 'rb').read())
    MOBJ_STRUCT_OFF = 40
    NUM_OBJS_OFF    = 48
    mobjLength = u32be(buf, MOBJ_STRUCT_OFF)
    numObjs    = u32be(buf, NUM_OBJS_OFF) >> 16  # upper 16 bits

    # Actually: numObjs is uint16 at NUM_OBJS_OFF
    import struct
    numObjs = struct.unpack('>H', bytes(buf[NUM_OBJS_OFF:NUM_OBJS_OFF+2]))[0]

    pos = NUM_OBJS_OFF + 2
    obj2Start = -1; obj2Size = 0
    for i in range(numObjs):
        nc = struct.unpack('>H', bytes(buf[pos+2:pos+4]))[0]
        if i == 2:
            obj2Start = pos
            obj2Size  = 4 + nc * 12
        pos += 4 + nc * 12

    if obj2Start < 0:
        print("  WARNING: Object[2] not found in MovieObject")
        return False

    origNumCmds = struct.unpack('>H', bytes(buf[obj2Start+2:obj2Start+4]))[0]
    obj2Body = buf[obj2Start+4:obj2Start+obj2Size]
    lastCmdOpcode = u32be(obj2Body, (origNumCmds-1)*12)

    if lastCmdOpcode != 0x22800000:
        print(f"  INFO: Object[2] last cmd is 0x{lastCmdOpcode:08X}, not PLAY_PL — skipping patch")
        return False

    # Check if already patched (second-to-last cmd is also PLAY_PL(0))
    if origNumCmds >= 2:
        penultimateOpcode = u32be(obj2Body, (origNumCmds-2)*12)
        penultimateOperand = u32be(obj2Body, (origNumCmds-2)*12 + 4)
        if penultimateOpcode == 0x22800000 and penultimateOperand == 0x00000000:
            print(f"  INFO: PLAY_PL(0) already patched in Object[2]")
            return True

    PLAY_PL_0 = bytearray(12)
    struct.pack_into('>III', PLAY_PL_0, 0, 0x22800000, 0x00000000, 0x00000000)

    newNumCmds = origNumCmds + 1
    newObj2 = bytearray(4 + newNumCmds * 12)
    struct.pack_into('>H', newObj2, 0, struct.unpack('>H', bytes(buf[obj2Start:obj2Start+2]))[0])
    struct.pack_into('>H', newObj2, 2, newNumCmds)
    newObj2[4:4+(origNumCmds-1)*12] = obj2Body[:(origNumCmds-1)*12]
    newObj2[4+(origNumCmds-1)*12:4+(origNumCmds-1)*12+12] = PLAY_PL_0
    newObj2[4+origNumCmds*12:] = obj2Body[(origNumCmds-1)*12:]

    newBuf = bytes(buf[:obj2Start]) + bytes(newObj2) + bytes(buf[obj2Start+obj2Size:])
    newBuf = bytearray(newBuf)
    struct.pack_into('>I', newBuf, MOBJ_STRUCT_OFF, mobjLength + 12)

    open(mobj_path, 'wb').write(newBuf)
    print(f"  Object[2] patched: {origNumCmds}→{newNumCmds} cmds (inserted PLAY_PL(0))")
    return True

def main():
    detach_all()
    work = tempfile.mkdtemp(prefix='testfix2_')
    print(f"Work: {work}")

    # Mount source ISO (which has ep1+ep2 structure, possibly with old splash)
    mp_src = '/tmp/src_mount'
    os.makedirs(mp_src, exist_ok=True)
    subprocess.run([HDIUTIL, 'attach', SRC_ISO, '-mountpoint', mp_src, '-readonly'],
                   capture_output=True, check=True)

    # Copy BDMV (ep1+ep2 structure)
    bdmv_src = os.path.join(mp_src, 'BDMV')
    bdmv_dst = os.path.join(work, 'BDMV')
    shutil.copytree(bdmv_src, bdmv_dst)
    subprocess.run([HDIUTIL, 'detach', mp_src, '-force'], capture_output=True)
    print("Copied BDMV from TEST.iso")

    # Build fresh splash
    print("\nBuilding fresh splash m2ts...")
    m2ts, clpi, mpls, sp_bd = build_splash_m2ts(work)

    # Patch CLPI + MPLS
    patch_clpi_and_mpls(clpi, mpls, duration_sec=5)

    # Copy splash files into BDMV
    shutil.copy2(m2ts, os.path.join(bdmv_dst, 'STREAM', '00000.m2ts'))
    shutil.copy2(clpi, os.path.join(bdmv_dst, 'CLIPINF', '00000.clpi'))
    shutil.copy2(mpls, os.path.join(bdmv_dst, 'PLAYLIST', '00000.mpls'))
    bk = os.path.join(bdmv_dst, 'BACKUP')
    if os.path.exists(bk):
        shutil.copy2(clpi, os.path.join(bk, '00000.clpi'))
        os.makedirs(os.path.join(bk, 'PLAYLIST'), exist_ok=True)
        shutil.copy2(mpls, os.path.join(bk, 'PLAYLIST', '00000.mpls'))
    print("Splash files copied into BDMV")

    # Patch MovieObject (add PLAY_PL(0) before PLAY_PL(1))
    mobj = os.path.join(bdmv_dst, 'MovieObject.bdmv')
    inject_play_pl_splash(mobj)
    bk_mobj = os.path.join(bk, 'MovieObject.bdmv') if os.path.exists(bk) else None
    if bk_mobj: shutil.copy2(mobj, bk_mobj)

    # Package ISO
    if os.path.exists(OUT_ISO): os.remove(OUT_ISO)
    print(f"\nPackaging {OUT_ISO}...")
    r = subprocess.run([XORRISO, '-as', 'mkisofs', '-udf', '-udfver', '2.50',
                       '-V', 'TESTFIX2', '-o', OUT_ISO, work],
                      capture_output=True)
    if r.returncode != 0:
        r2 = subprocess.run([XORRISO, '-outdev', f'stdio:{OUT_ISO}',
                            '-map', work, '/', '-commit'], capture_output=True)
    print(f"ISO: {OUT_ISO} ({os.path.getsize(OUT_ISO)//1024//1024} MB)")
    shutil.rmtree(work, ignore_errors=True)

    # Mount and test with VLC
    mp_fix = '/tmp/fix2_mount'
    os.makedirs(mp_fix, exist_ok=True)
    subprocess.run([HDIUTIL, 'attach', OUT_ISO, '-mountpoint', mp_fix, '-readonly'],
                   capture_output=True, check=True)

    log_path = os.path.expanduser('~/Desktop/vlc_testfix2.log')
    print(f"\nRunning VLC → {log_path}")
    with open(log_path, 'w') as lf:
        vlc_proc = subprocess.Popen(
            [VLC, '-vvv', '--no-video', '--intf', 'dummy', '--play-and-exit',
             f'bluray://{mp_fix}/'],
            stdout=lf, stderr=subprocess.STDOUT,
            env={**os.environ, 'BD_DEBUG_MASK': '0xffff'}
        )
        time.sleep(20)
        vlc_proc.terminate()

    subprocess.run([HDIUTIL, 'detach', mp_fix, '-force'], capture_output=True)

    print("\n--- VLC log analysis ---")
    with open(log_path) as f:
        log = f.read()

    key_lines = [l for l in log.splitlines() if any(k in l for k in
        ['PLAY_PL', 'End of title', 'reached end', 'PlayMark', 'PSR8', 'JUMP', 'error', 'WARNING'])]
    for l in key_lines[:40]:
        print(f"  {l.strip()[-120:]}")

    print("\n--- Summary ---")
    if 'PLAY_PL(4): 0' in log and 'PLAY_PL(4): 1' in log:
        # Check time between PL0 and PL1
        idx0 = log.index('PLAY_PL(4): 0')
        idx1 = log.index('PLAY_PL(4): 1')
        between = log[idx0:idx1]
        lines_between = between.count('\n')
        print(f"  PLAY_PL(0) → PLAY_PL(1): {lines_between} log lines between")
        if 'End of title' in between:
            end_idx = between.index('End of title')
            print(f"  End of title after {end_idx} chars from PLAY_PL(0)")
            print("  STATUS: FAIL — splash ended too quickly")
        else:
            print("  STATUS: UNKNOWN — need more analysis")
    if 'PLAY_PL(4): 2' in log:
        print("  PLAY_PL(2) reached → Ep2 plays")
        print("  STATUS: FULL SUCCESS")

if __name__ == '__main__':
    main()
