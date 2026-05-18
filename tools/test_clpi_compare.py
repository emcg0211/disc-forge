#!/usr/bin/env python3
"""Compare tsMuxeR CLPI output for splash vs episode input."""
import subprocess, os, struct, tempfile, time, shutil

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'
EP1      = '/Volumes/Internal SSD/test_ep1_60s.mkv'

def read_uint32be(buf, off):
    return struct.unpack('>I', buf[off:off+4])[0]

def analyze_clpi(path, label):
    with open(path, 'rb') as f:
        buf = f.read()
    prog_start = read_uint32be(buf, 0x10)
    cpi_start  = read_uint32be(buf, 0x14)
    pi_size    = cpi_start - prog_start
    print(f"  [{label}] ProgramInfo: {pi_size} bytes (0x{prog_start:X}–0x{cpi_start:X})")
    pi = buf[prog_start:prog_start+min(64, pi_size)]
    print(f"  [{label}] PI hex: {pi.hex()}")
    if pi_size >= 8:
        num_seq  = pi[5]
        if pi_size >= 16:
            num_streams = pi[14]
            num_groups  = pi[15]
            print(f"  [{label}] num_sequences={num_seq} num_streams_in_ps={num_streams} num_groups={num_groups}")
    return pi_size

def run(cmd, desc, timeout=180):
    print(f"  RUN: {desc}")
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in (0, 1):
        print(f"  FAIL exit={r.returncode} in {elapsed:.1f}s")
        print(f"  STDERR: {r.stderr.decode(errors='replace')[-400:]}")
        return False
    print(f"  OK ({elapsed:.1f}s)")
    return True

def test_episode(work):
    """Run tsMuxeR on the real episode mkv."""
    bd = os.path.join(work, 'ep1_bd')
    os.makedirs(bd)
    meta = os.path.join(work, 'ep1.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{EP1}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{EP1}", lang=und, track=2\n')
    if not run([TSMUXER, meta, bd], "tsMuxeR on ep1 mkv (same meta format as splash)"):
        return
    clpi = os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi')
    if os.path.exists(clpi):
        analyze_clpi(clpi, 'ep1-direct')

def test_splash_ts_to_mkv_to_ts(work):
    """Encode 5s testsrc to .ts then mkvmerge to .mkv then tsMuxeR."""
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
        '-x264-params', 'ref=4:bframes=3:b-pyramid=strict:weightp=2:aud=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', '5', '-shortest', '-f', 'mpegts', ts
    ], "ffmpeg testsrc2 → TS")

    run([MKVMERGE, '-o', mkv, ts], "mkvmerge TS→MKV")

    meta = os.path.join(work, 'sp.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv}", lang=und, track=2\n')

    run([TSMUXER, meta, bd], "tsMuxeR on splash mkv")
    clpi = os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi')
    if os.path.exists(clpi):
        analyze_clpi(clpi, 'splash-ts-mkv')

def test_episode_mkv_remux(work):
    """Re-mkvmerge the episode through TS first then check CLPI."""
    ts  = os.path.join(work, 'ep1r.ts')
    mkv = os.path.join(work, 'ep1r.mkv')
    bd  = os.path.join(work, 'ep1r_bd')
    os.makedirs(bd)

    # Extract to TS then remux to MKV (mimicking the normal episode pipeline)
    run([FFMPEG, '-y', '-i', EP1,
        '-c:v', 'copy', '-c:a', 'copy',
        '-f', 'mpegts', ts
    ], "episode: copy to TS")

    run([MKVMERGE, '-o', mkv, ts], "episode: TS→MKV")

    meta = os.path.join(work, 'ep1r.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{mkv}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{mkv}", lang=und, track=2\n')

    run([TSMUXER, meta, bd], "tsMuxeR on remuxed episode")
    clpi = os.path.join(bd, 'BDMV', 'CLIPINF', '00000.clpi')
    if os.path.exists(clpi):
        analyze_clpi(clpi, 'ep1-remuxed')

if __name__ == '__main__':
    work = tempfile.mkdtemp(prefix='clpi_compare_')
    print(f"Work: {work}")

    print("\n=== Test 1: Episode direct (original mkv, same meta as splash) ===")
    test_episode(work)

    print("\n=== Test 2: Splash (testsrc2 → TS → MKV → tsMuxeR) ===")
    test_splash_ts_to_mkv_to_ts(work)

    print("\n=== Test 3: Episode remuxed through TS (copy-to-TS → MKV → tsMuxeR) ===")
    test_episode_mkv_remux(work)

    print(f"\nWork dir: {work}")
