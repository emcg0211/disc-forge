#!/usr/bin/env python3
"""
Test the splash encoding pipeline: ffmpeg -> mkvmerge -> tsMuxeR
Compare CLPI ProgramInfo sizes between splash and reference ep1.
Usage: python3 tools/test_splash_pipeline.py [--approach 1a1|1a2]
"""
import subprocess
import os
import sys
import struct
import tempfile
import shutil
import time

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'

def read_uint32be(buf, off):
    return struct.unpack('>I', buf[off:off+4])[0]

def read_uint16be(buf, off):
    return struct.unpack('>H', buf[off:off+2])[0]

def analyze_clpi(clpi_path, label):
    with open(clpi_path, 'rb') as f:
        buf = f.read()
    magic = buf[0:8].decode('ascii', errors='replace')
    prog_info_start = read_uint32be(buf, 0x10)
    cpi_start       = read_uint32be(buf, 0x14)
    prog_info_size  = cpi_start - prog_info_start
    num_src_pkts    = read_uint32be(buf, 0x34)
    print(f"  [{label}] magic={magic} prog_info_start=0x{prog_info_start:X} "
          f"cpi_start=0x{cpi_start:X} prog_info_size={prog_info_size} bytes "
          f"num_src_pkts={num_src_pkts}")

    # Print first 16 bytes of ProgramInfo for comparison
    pi = buf[prog_info_start:prog_info_start+min(32, prog_info_size)]
    print(f"  [{label}] ProgramInfo bytes: {pi.hex()}")
    return prog_info_size

def run(cmd, desc, timeout=120):
    print(f"  RUN: {desc}")
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in (0, 1):
        print(f"  FAIL (exit {r.returncode}) in {elapsed:.1f}s")
        print(f"  stderr: {r.stderr.decode(errors='replace')[-500:]}")
        return False
    print(f"  OK ({elapsed:.1f}s)")
    return True

def approach_1a1(work):
    """testsrc2 animated pattern — no PNG needed"""
    splash_ts  = os.path.join(work, 'splash.ts')
    splash_mkv = os.path.join(work, 'splash.mkv')
    splash_bd  = os.path.join(work, 'splash_bd')
    os.makedirs(splash_bd, exist_ok=True)

    ok = run([FFMPEG, '-y',
        '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=1920x1080:rate=24000/1001',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-x264-params', 'ref=4:bframes=3:b-pyramid=strict:weightp=2:aud=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', '5', '-shortest', '-f', 'mpegts', splash_ts
    ], "ffmpeg testsrc2 → TS")
    if not ok: return None

    print(f"  splash.ts size: {os.path.getsize(splash_ts)//1024} KB")

    ok = run([MKVMERGE, '-o', splash_mkv, splash_ts], "mkvmerge TS→MKV")
    if not ok: return None

    meta = os.path.join(work, 'splash.meta')
    mkv_path = splash_mkv.replace('\\', '/')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv_path}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv_path}", lang=und, track=2, default\n')

    ok = run([TSMUXER, meta, splash_bd], "tsMuxeR → BD")
    if not ok: return None

    clpi = os.path.join(splash_bd, 'BDMV', 'CLIPINF', '00000.clpi')
    if not os.path.exists(clpi):
        print("  FAIL: no CLPI produced")
        return None
    return clpi

def approach_1a2(work, splash_png):
    """PNG loop with explicit framerate and proper x264 BD params"""
    splash_ts  = os.path.join(work, 'splash.ts')
    splash_mkv = os.path.join(work, 'splash.mkv')
    splash_bd  = os.path.join(work, 'splash_bd')
    os.makedirs(splash_bd, exist_ok=True)

    if not os.path.exists(splash_png):
        print(f"  SKIP: splash_png not found at {splash_png}")
        return None

    ok = run([FFMPEG, '-y',
        '-framerate', '24000/1001', '-loop', '1', '-i', splash_png,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-x264-params', 'ref=4:bframes=3:b-pyramid=strict:weightp=2:aud=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', '5', '-shortest', '-f', 'mpegts', splash_ts
    ], "ffmpeg PNG-loop/explicit-fps → TS")
    if not ok: return None

    print(f"  splash.ts size: {os.path.getsize(splash_ts)//1024} KB")

    ok = run([MKVMERGE, '-o', splash_mkv, splash_ts], "mkvmerge TS→MKV")
    if not ok: return None

    meta = os.path.join(work, 'splash.meta')
    mkv_path = splash_mkv.replace('\\', '/')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv_path}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv_path}", lang=und, track=2, default\n')

    ok = run([TSMUXER, meta, splash_bd], "tsMuxeR → BD")
    if not ok: return None

    clpi = os.path.join(splash_bd, 'BDMV', 'CLIPINF', '00000.clpi')
    if not os.path.exists(clpi):
        print("  FAIL: no CLPI produced")
        return None
    return clpi

def main():
    approach = '1a1'
    if '--approach' in sys.argv:
        idx = sys.argv.index('--approach')
        approach = sys.argv[idx+1]

    work = tempfile.mkdtemp(prefix='splash_test_')
    print(f"\n=== Splash Pipeline Test — Approach {approach} ===")
    print(f"  Work dir: {work}")

    try:
        if approach == '1a1':
            print("\n--- Approach 1A.i: testsrc2 animated pattern ---")
            clpi = approach_1a1(work)
        elif approach == '1a2':
            splash_png = '/tmp/test_splash.png'
            if not os.path.exists(splash_png):
                # Generate a test PNG
                subprocess.run([FFMPEG, '-y', '-f', 'lavfi',
                    '-i', 'color=c=0x1a1a2e:s=1920x1080:r=1',
                    '-vframes', '1', splash_png], capture_output=True)
                print(f"  Generated test PNG at {splash_png}")
            print("\n--- Approach 1A.ii: PNG loop with explicit framerate ---")
            clpi = approach_1a2(work, splash_png)
        else:
            print(f"Unknown approach: {approach}")
            return

        print("\n--- CLPI Analysis ---")
        if clpi:
            size = analyze_clpi(clpi, f"splash-{approach}")
            print(f"\n  ProgramInfo size: {size} bytes")
            if size >= 200:
                print("  RESULT: PASS — ProgramInfo looks substantial (like real video)")
                print(f"  CLPI: {clpi}")
                # Also show MPLS
                mpls = clpi.replace('CLIPINF', 'PLAYLIST').replace('.clpi', '.mpls')
                if os.path.exists(mpls):
                    with open(mpls, 'rb') as f:
                        buf = f.read()
                    in_t  = read_uint32be(buf, 0x52)
                    out_t = read_uint32be(buf, 0x56)
                    dur   = (out_t - in_t) / 45000.0
                    print(f"  MPLS in={in_t:#010x} out={out_t:#010x} duration={dur:.3f}s")
            else:
                print(f"  RESULT: FAIL — ProgramInfo too small ({size} bytes, need ≥200)")
        else:
            print("  RESULT: FAIL — pipeline error, no CLPI produced")

    except Exception as e:
        print(f"\nException: {e}")
        import traceback; traceback.print_exc()
    finally:
        print(f"\nWork dir preserved for inspection: {work}")

if __name__ == '__main__':
    main()
