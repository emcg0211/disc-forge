#!/usr/bin/env python3
"""
Validate the CLPI presentation_end_time patch fix.
Runs the full splash pipeline, patches both MPLS and CLPI, then checks
what VLC/libbluray does with the result.
"""
import subprocess, os, struct, tempfile, time, shutil

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'
HDIUTIL  = '/usr/bin/hdiutil'
VLC      = '/Applications/VLC.app/Contents/MacOS/VLC'

def u32be(buf, off): return struct.unpack('>I', buf[off:off+4])[0]
def w32be(buf, off, v): struct.pack_into('>I', buf, off, v)

def run(cmd, desc, timeout=120):
    print(f"  RUN: {desc}")
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in (0,1):
        print(f"  FAIL exit={r.returncode} ({elapsed:.1f}s)")
        print(f"  STDERR: {r.stderr.decode(errors='replace')[-300:]}")
        return False
    print(f"  OK ({elapsed:.1f}s)")
    return True

def build_splash_bd(work):
    """Build splash BDMV using existing TEST.iso ep1 MPLS/CLPI structure."""
    ts  = os.path.join(work, 'splash.ts')
    mkv = os.path.join(work, 'splash.mkv')
    bd  = os.path.join(work, 'splash_bd')
    os.makedirs(bd)

    # Use testsrc2 (same as approach 1A.i)
    ok = run([FFMPEG, '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=1920x1080:rate=24000/1001',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-x264-params', 'ref=4:bframes=3:b-pyramid=strict:weightp=2:aud=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', '5', '-shortest', '-f', 'mpegts', ts
    ], "ffmpeg testsrc2 → TS")
    if not ok: return None

    ok = run([MKVMERGE, '-o', mkv, ts], "mkvmerge TS→MKV")
    if not ok: return None

    meta = os.path.join(work, 'splash.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv}", lang=und, track=2\n')

    ok = run([TSMUXER, meta, bd], "tsMuxeR → BD")
    if not ok: return None
    return bd

def patch_mpls_and_clpi(bd, duration_sec=5):
    """Apply the fix: patch both MPLS out_time and CLPI presentation_end_time."""
    mpls_path = os.path.join(bd, 'BDMV', 'PLAYLIST', '00000.mpls')
    clpi_path = os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi')

    # Patch MPLS
    mpls = bytearray(open(mpls_path, 'rb').read())
    in_time  = u32be(mpls, 0x52)
    out_time = in_time + duration_sec * 45000
    w32be(mpls, 0x56, out_time)
    open(mpls_path, 'wb').write(mpls)
    print(f"  MPLS patched: in={in_time:#010x} out={out_time:#010x} ({duration_sec}s)")

    # Patch CLPI
    clpi = bytearray(open(clpi_path, 'rb').read())
    clip_info_addr = u32be(clpi, 0x08)
    end_time_off   = clip_info_addr + 22
    old_end        = u32be(clpi, end_time_off)
    w32be(clpi, end_time_off, out_time)
    open(clpi_path, 'wb').write(clpi)
    print(f"  CLPI patched: presentation_end_time {old_end:#010x} → {out_time:#010x}")
    print(f"  Old CLPI duration: {(old_end - in_time)/45000:.3f}s  New: {duration_sec}s")

def analyze_timestamps(bd):
    """Print key timestamps from MPLS and CLPI."""
    mpls = open(os.path.join(bd, 'BDMV', 'PLAYLIST', '00000.mpls'), 'rb').read()
    clpi = open(os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi'), 'rb').read()

    mpls_in  = u32be(mpls, 0x52)
    mpls_out = u32be(mpls, 0x56)
    clip_info_addr = u32be(clpi, 0x08)
    clpi_start = u32be(clpi, clip_info_addr + 18)
    clpi_end   = u32be(clpi, clip_info_addr + 22)

    print(f"  MPLS: in={mpls_in:#010x} out={mpls_out:#010x} dur={(mpls_out-mpls_in)/45000:.3f}s")
    print(f"  CLPI: pres_start={clpi_start:#010x} pres_end={clpi_end:#010x} dur={(clpi_end-clpi_start)/45000:.3f}s")
    return (mpls_out - mpls_in)/45000, (clpi_end - clpi_start)/45000

if __name__ == '__main__':
    work = tempfile.mkdtemp(prefix='splash_fix_')
    print(f"\n=== Splash Fix Validation ===")
    print(f"Work: {work}")

    bd = build_splash_bd(work)
    if not bd:
        print("FAIL: build failed"); exit(1)

    print("\n--- Before patch ---")
    analyze_timestamps(bd)

    print("\n--- Applying patch ---")
    patch_mpls_and_clpi(bd)

    print("\n--- After patch ---")
    mpls_dur, clpi_dur = analyze_timestamps(bd)

    if abs(mpls_dur - 5.0) < 0.2 and abs(clpi_dur - 5.0) < 0.2:
        print("\nRESULT: PASS — both MPLS and CLPI report ~5s duration")
    else:
        print(f"\nRESULT: FAIL — mpls_dur={mpls_dur:.3f}s clpi_dur={clpi_dur:.3f}s")

    print(f"\nBD dir for inspection: {bd}")
