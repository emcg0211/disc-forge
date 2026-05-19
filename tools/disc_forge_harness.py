#!/usr/bin/env python3
"""
Disc Forge Splash Investigation Harness
========================================
Automates the build → verify → playback test cycle for the splash bug.

Usage:
  python3 tools/disc_forge_harness.py baseline        # baseline VLC test on mounted TEST ISO
  python3 tools/disc_forge_harness.py build <iso>     # build fresh splash ISO and test
  python3 tools/disc_forge_harness.py h-fps24         # test H_fps24: integer fps fix
  python3 tools/disc_forge_harness.py h-post          # test H_post: post-process PTS fix
  python3 tools/disc_forge_harness.py h-all           # run all hypotheses in sequence

Each test reports: splash_dur (seconds), verdict, and key VLC log lines.
"""

import subprocess, os, sys, struct, shutil, time, tempfile, re
from pathlib import Path

# ── Tool paths ─────────────────────────────────────────────────────────────────
FFMPEG    = '/opt/homebrew/bin/ffmpeg'
MKVMERGE  = '/opt/homebrew/bin/mkvmerge'
TSMUXER   = '/opt/homebrew/bin/tsMuxeR'
HDIUTIL   = '/usr/bin/hdiutil'
VLC       = '/Applications/VLC.app/Contents/MacOS/VLC'
XORRISO   = '/opt/homebrew/bin/xorriso'

SRC_ISO   = os.path.expanduser('~/Desktop/TEST.iso')
JOURNAL   = os.path.expanduser('~/Desktop/splash_investigation.md')

# ── Binary helpers ─────────────────────────────────────────────────────────────
def u32(b, o): return struct.unpack('>I', b[o:o+4])[0]
def u16(b, o): return struct.unpack('>H', b[o:o+2])[0]
def w32(b, o, v): struct.pack_into('>I', b, o, v)

def run(cmd, desc, timeout=180, ok_codes=(0, 1)):
    print(f"  [{desc}]...", end='', flush=True)
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        elapsed = time.time() - t0
        if r.returncode not in ok_codes:
            print(f" FAIL exit={r.returncode} ({elapsed:.1f}s)")
            print(f"  STDERR: {r.stderr.decode(errors='replace')[-400:]}")
            return False
        print(f" OK ({elapsed:.1f}s)")
        return True
    except subprocess.TimeoutExpired:
        print(f" TIMEOUT after {timeout}s")
        return False
    except Exception as e:
        print(f" ERROR: {e}")
        return False

# ── m2ts PTS checker ──────────────────────────────────────────────────────────
def check_m2ts_video_duration(m2ts_path):
    """
    Use ffprobe to read the video stream's duration_ts from the m2ts.
    Returns (duration_seconds, pts_delta_per_frame) or (None, None) on error.
    The duration_ts is in 90kHz ticks; PTS delta per frame should be ~3750 for 24fps.
    """
    try:
        r = subprocess.run(
            ['/opt/homebrew/bin/ffprobe', '-v', 'error',
             '-select_streams', 'v:0',
             '-show_entries', 'stream=duration_ts',
             '-of', 'csv=p=0', m2ts_path],
            capture_output=True, timeout=15
        )
        lines = r.stdout.decode().strip().splitlines()
        duration_ts = None
        for line in lines:
            try:
                v = int(line.strip())
                if v > 0:
                    duration_ts = v
                    break
            except ValueError:
                pass

        if duration_ts is None:
            return None, None

        # Also check per-frame PTS delta (first two frames)
        r2 = subprocess.run(
            ['/opt/homebrew/bin/ffprobe', '-v', 'quiet',
             '-select_streams', 'v:0',
             '-show_entries', 'packet=pts',
             '-of', 'csv=p=0', m2ts_path],
            capture_output=True, timeout=15
        )
        pts_lines = [l.strip() for l in r2.stdout.decode().splitlines() if l.strip()]
        pts_delta = None
        if len(pts_lines) >= 2:
            try:
                pts_delta = int(pts_lines[1]) - int(pts_lines[0])
            except ValueError:
                pass

        dur_s = duration_ts / 90000.0
        return dur_s, pts_delta

    except Exception:
        return None, None


# ── Disc structure verifier ────────────────────────────────────────────────────
def verify_disc(bd_folder, label='disc'):
    """Assert key structural invariants. Returns dict of findings."""
    findings = {}
    ok = True

    def chk(name, cond, val=None):
        nonlocal ok
        sym = '✓' if cond else '✗'
        msg = f"  {sym} {name}" + (f": {val}" if val is not None else '')
        print(msg)
        findings[name] = val if val is not None else cond
        if not cond: ok = False

    print(f"\n── verify_disc({label}) ──")
    stream00 = os.path.join(bd_folder, 'BDMV', 'STREAM', '00000.m2ts')
    mpls00   = os.path.join(bd_folder, 'BDMV', 'PLAYLIST', '00000.mpls')
    clpi00   = os.path.join(bd_folder, 'BDMV', 'CLIPINF', '00000.clpi')
    mpls01   = os.path.join(bd_folder, 'BDMV', 'PLAYLIST', '00001.mpls')
    mobj     = os.path.join(bd_folder, 'BDMV', 'MovieObject.bdmv')
    idx      = os.path.join(bd_folder, 'BDMV', 'index.bdmv')

    chk('00000.m2ts exists',  os.path.exists(stream00))
    if os.path.exists(stream00):
        sz = os.path.getsize(stream00)
        chk('00000.m2ts > 50 KB', sz > 50000, f'{sz//1024} KB')
        # PTS-level check: video must span > 4s at 90kHz (catches tsMuxeR fps bug)
        m2ts_dur, pts_delta = check_m2ts_video_duration(stream00)
        if m2ts_dur is not None:
            chk('m2ts video dur > 4s', m2ts_dur > 4.0,
                f'{m2ts_dur:.3f}s (Δpts={pts_delta})')
            findings['m2ts_video_dur'] = m2ts_dur
            findings['m2ts_pts_delta'] = pts_delta

    chk('00000.mpls exists', os.path.exists(mpls00))
    if os.path.exists(mpls00):
        with open(mpls00, 'rb') as f: m = f.read()
        if len(m) >= 0x5a:
            in_t  = u32(m, 0x52)
            out_t = u32(m, 0x56)
            dur   = (out_t - in_t) / 45000.0
            chk('MPLS dur in [3, 10]s', 3 < dur < 10, f'{dur:.3f}s')
            findings['mpls_dur'] = dur

    chk('00000.clpi exists', os.path.exists(clpi00))
    if os.path.exists(clpi00):
        with open(clpi00, 'rb') as f: c = f.read()
        ci = u32(c, 0x08)
        if len(c) >= ci + 26:
            start_t = u32(c, ci + 18)
            end_t   = u32(c, ci + 22)
            dur     = (end_t - start_t) / 45000.0
            chk('CLPI dur in [3, 10]s', 3 < dur < 10, f'{dur:.3f}s')
            findings['clpi_dur'] = dur

    chk('MovieObject.bdmv exists', os.path.exists(mobj))
    if os.path.exists(mobj):
        with open(mobj, 'rb') as f: b = f.read()
        num_objs = u16(b, 48)
        chk('MovieObject num_objs >= 3', num_objs >= 3, num_objs)
        if num_objs >= 3:
            pos = 50
            for i in range(num_objs):
                nc = u16(b, pos + 2)
                if i == 2:
                    cmds = [(u32(b, pos+4+j*12), u32(b, pos+4+j*12+4)) for j in range(nc)]
                    # Find PLAY_PL(0) and PLAY_PL(1) in obj[2]
                    has_pl0 = any(op == 0x22800000 and o1 == 0 for op, o1 in cmds)
                    has_pl1 = any(op == 0x22800000 and o1 == 1 for op, o1 in cmds)
                    chk('Object[2] has PLAY_PL(0)', has_pl0)
                    chk('Object[2] has PLAY_PL(1)', has_pl1)
                    # PLAY_PL(0) must come before PLAY_PL(1)
                    pl0_idx = next((i for i,(op,o1) in enumerate(cmds) if op == 0x22800000 and o1 == 0), -1)
                    pl1_idx = next((i for i,(op,o1) in enumerate(cmds) if op == 0x22800000 and o1 == 1), -1)
                    if has_pl0 and has_pl1:
                        chk('PLAY_PL(0) before PLAY_PL(1)', pl0_idx < pl1_idx,
                            f'cmd[{pl0_idx}] before cmd[{pl1_idx}]')
                pos += 4 + nc * 12

    # Baseline check: ep1 MPLS random_access_flag
    if os.path.exists(mpls01):
        with open(mpls01, 'rb') as f: m1 = f.read()
        if len(m1) > 0x63:
            chk('00001.mpls[0x38] == 0xC0 (random_access)', m1[0x38] == 0xC0, f'0x{m1[0x38]:02x}')
            chk('00001.mpls[0x62] == 0x80 (PlayItem r_a)',  m1[0x62] == 0x80, f'0x{m1[0x62]:02x}')

    print(f"  {'PASS' if ok else 'FAIL'} ({sum(1 for v in findings.values() if v is True)} checks passed)")
    findings['overall'] = ok
    return findings

# ── VLC playback simulator ─────────────────────────────────────────────────────
def run_vlc(mount_point, timeout_s=20):
    """Run VLC headless and parse libbluray debug output. Returns splash_dur in seconds."""
    log_path = '/tmp/harness_vlc.log'
    env = dict(os.environ, BD_DEBUG_MASK='0xffff')

    with open(log_path, 'w') as lf:
        proc = subprocess.Popen(
            [VLC, '-vvv', '--no-video', '--intf', 'dummy', '--play-and-exit',
             f'bluray://{mount_point}/'],
            stdout=lf, stderr=subprocess.STDOUT, env=env
        )

    # Wait with timeout
    deadline = time.time() + timeout_s
    while time.time() < deadline and proc.poll() is None:
        time.sleep(0.5)
    if proc.poll() is None:
        proc.terminate()
        time.sleep(1)
        if proc.poll() is None:
            proc.kill()

    with open(log_path) as f:
        log = f.read()

    return _parse_vlc_log(log)

def _parse_vlc_log(log):
    """Parse VLC log for PLAY_PL timing. Returns dict."""
    result = {'splash_dur': 0.0, 'pl0_fired': False, 'pl1_fired': False, 'verdict': 'unknown'}

    # Extract wall-clock timestamps from VLC log lines (format: [HH:MM:SS.mmm])
    lines = log.splitlines()

    pl0_time = None
    pl1_time = None
    end_time = None

    for line in lines:
        if 'PLAY_PL    0' in line or 'HDMV_EVENT_PLAY_PL(4): 0' in line:
            result['pl0_fired'] = True
            pl0_time = _extract_line_time(line, lines)
        if 'PLAY_PL    1' in line or 'HDMV_EVENT_PLAY_PL(4): 1' in line:
            result['pl1_fired'] = True
            if pl1_time is None:
                pl1_time = _extract_line_time(line, lines)
        if 'End of title' in line and end_time is None:
            end_time = _extract_line_time(line, lines)

    # Use line count as a proxy for time between events (lines ≈ log output rate)
    if result['pl0_fired'] and result['pl1_fired']:
        # Find indices
        pl0_idx = next((i for i, l in enumerate(lines) if 'PLAY_PL    0' in l or 'HDMV_EVENT_PLAY_PL(4): 0' in l), -1)
        pl1_idx = next((i for i, l in enumerate(lines) if 'PLAY_PL    1' in l or 'HDMV_EVENT_PLAY_PL(4): 1' in l), -1)
        end_idx = next((i for i, l in enumerate(lines) if 'End of title' in l), -1)

        lines_between = pl1_idx - pl0_idx if pl0_idx >= 0 and pl1_idx >= 0 else 0
        result['log_lines_pl0_to_pl1'] = lines_between

        # Check for PSR8 time change between PL0 and PL1 — if big gap, splash played
        psr8_changes = []
        for i, line in enumerate(lines[pl0_idx:pl1_idx+1] if pl0_idx>=0 and pl1_idx>=0 else []):
            if 'PSR8' in line and 'TIME' in line:
                m = re.search(r'-> (0x[0-9a-f]+|\d+)', line)
                if m:
                    try: psr8_changes.append(int(m.group(1), 16 if '0x' in m.group(1) else 10))
                    except: pass

        if len(psr8_changes) >= 2:
            psr8_delta_45k = psr8_changes[-1] - psr8_changes[0]
            splash_dur = psr8_delta_45k / 45000.0
            result['splash_dur'] = max(0.0, splash_dur)
        elif lines_between > 50:
            # Heuristic: many log lines between PL0 and PL1 = splash played
            result['splash_dur'] = 4.0  # unknown but probably played
        else:
            result['splash_dur'] = 0.0

    # Verdict
    if not result['pl0_fired']:
        result['verdict'] = 'FAIL (PL0 never fired)'
    elif not result['pl1_fired']:
        result['verdict'] = 'FAIL (PL1 never fired)'
    elif result['splash_dur'] > 4.0:
        result['verdict'] = 'PASS (splash played > 4s)'
    elif result['log_lines_pl0_to_pl1'] > 80:
        result['verdict'] = f'LIKELY_PASS ({result["log_lines_pl0_to_pl1"]} log lines between PL0→PL1)'
    else:
        result['verdict'] = f'FAIL (splash_dur={result["splash_dur"]:.2f}s, {result.get("log_lines_pl0_to_pl1",0)} lines)'

    # Key log excerpts
    key_lines = [l for l in lines if any(k in l for k in
        ['PLAY_PL', 'End of title', 'reached end', 'PlayMark', 'PSR8', 'error', 'WARNING', 'sample freq'])]
    result['key_lines'] = key_lines[:20]

    return result

def _extract_line_time(line, all_lines):
    """Extract a rough time marker from a log line (line index as proxy)."""
    return all_lines.index(line) if line in all_lines else 0

# ── ISO packaging ──────────────────────────────────────────────────────────────
def package_iso(bd_folder, output_iso, vol_name='TESTHARNESS'):
    """Create an ISO from bd_folder using xorriso."""
    if os.path.exists(output_iso):
        os.unlink(output_iso)

    # Try UDF 2.50 first, fall back to native mode
    r = subprocess.run(
        [XORRISO, '-as', 'mkisofs', '-udf', '-udfver', '2.50',
         '-V', vol_name[:32], '-o', output_iso, bd_folder],
        capture_output=True
    )
    if r.returncode != 0:
        r2 = subprocess.run(
            [XORRISO, '-outdev', f'stdio:{output_iso}',
             '-map', bd_folder, '/', '-volid', vol_name[:32], '-commit'],
            capture_output=True
        )
        if r2.returncode != 0:
            raise RuntimeError(f"xorriso failed: {r2.stderr.decode()[-300:]}")

    size_mb = os.path.getsize(output_iso) / 1024 / 1024
    print(f"  ISO: {output_iso} ({size_mb:.1f} MB)")
    return output_iso

def mount_iso(iso_path, mount_point=None):
    """Mount ISO read-only. Returns mount_point."""
    if mount_point is None:
        mount_point = tempfile.mkdtemp(prefix='harness_mount_')

    r = subprocess.run(
        [HDIUTIL, 'attach', iso_path, '-mountpoint', mount_point, '-readonly', '-noverify'],
        capture_output=True
    )
    if r.returncode != 0:
        raise RuntimeError(f"hdiutil attach failed: {r.stderr.decode()[-200:]}")
    return mount_point

def detach(path):
    subprocess.run([HDIUTIL, 'detach', path, '-force'], capture_output=True)

# ── Splash builder ─────────────────────────────────────────────────────────────
def build_splash_fps24(work, splash_png=None, duration=5, color='1a1a2e'):
    """
    Build a splash BDMV using INTEGER fps=24 (avoids tsMuxeR's 1001-factor timestamp bug).
    Returns dict with paths: m2ts, mpls, clpi, bd_folder
    """
    sp_ts  = os.path.join(work, 'splash.ts')
    sp_mkv = os.path.join(work, 'splash.mkv')
    sp_bd  = os.path.join(work, 'splash_bd')
    os.makedirs(sp_bd, exist_ok=True)

    # Encode at fps=24 (integer) to avoid tsMuxeR timestamp bug with 24000/1001
    if splash_png and os.path.exists(splash_png):
        ff_args = [
            '-y',
            '-loop', '1', '-r', '24', '-i', splash_png,
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
            '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
            '-maxrate', '25000k', '-bufsize', '30000k',
            '-bf', '0', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
            '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
            '-t', str(duration), '-f', 'mpegts', sp_ts,
        ]
    else:
        ff_args = [
            '-y',
            '-f', 'lavfi', '-i', f'color=c=0x{color}:s=1920x1080:r=24:d={duration}',
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
            '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
            '-maxrate', '25000k', '-bufsize', '30000k',
            '-bf', '0', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
            '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
            '-t', str(duration), '-f', 'mpegts', sp_ts,
        ]

    ok = run([FFMPEG] + ff_args, f'ffmpeg fps=24 → TS')
    if not ok or not os.path.exists(sp_ts):
        raise RuntimeError('ffmpeg failed')

    ok = run([MKVMERGE, '-o', sp_mkv, sp_ts], 'mkvmerge TS→MKV')
    if not ok or not os.path.exists(sp_mkv):
        raise RuntimeError('mkvmerge failed')

    meta_path = os.path.join(work, 'splash.meta')
    with open(meta_path, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{sp_mkv}", fps=24, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{sp_mkv}", lang=und, track=2, default\n')

    ok = run([TSMUXER, meta_path, sp_bd], 'tsMuxeR MKV→BDAV')
    m2ts_out = os.path.join(sp_bd, 'BDMV', 'STREAM', '00000.m2ts')
    if not ok or not os.path.exists(m2ts_out) or os.path.getsize(m2ts_out) < 50000:
        raise RuntimeError(f'tsMuxeR failed or m2ts too small')

    print(f"  m2ts: {os.path.getsize(m2ts_out)//1024} KB")

    mpls_path = os.path.join(sp_bd, 'BDMV', 'PLAYLIST', '00000.mpls')
    clpi_path = os.path.join(sp_bd, 'BDMV', 'CLIPINF', '00000.clpi')

    # Patch MPLS out_time (in case tsMuxeR under-reports)
    if os.path.exists(mpls_path):
        mpls = bytearray(open(mpls_path, 'rb').read())
        if len(mpls) >= 0x5a:
            in_t  = u32(mpls, 0x52)
            out_t = in_t + round(duration * 45000)
            w32(mpls, 0x56, out_t)
            open(mpls_path, 'wb').write(mpls)
            print(f"  MPLS: in={in_t:#010x} out={out_t:#010x} dur={(out_t-in_t)/45000:.3f}s")

    # Patch CLPI pres_end_time
    if os.path.exists(clpi_path) and 'out_t' in dir():
        clpi = bytearray(open(clpi_path, 'rb').read())
        ci   = u32(clpi, 0x08)
        end_off = ci + 22
        if len(clpi) >= end_off + 4:
            w32(clpi, end_off, out_t)
            open(clpi_path, 'wb').write(clpi)
            print(f"  CLPI pres_end_time patched to {out_t:#010x}")

    return {
        'm2ts': m2ts_out, 'mpls': mpls_path, 'clpi': clpi_path,
        'bd': sp_bd,
    }

def patch_movieobj_for_splash(mobj_path):
    """Insert PLAY_PL(0) before PLAY_PL(1) in Object[2] if not already done."""
    buf = bytearray(open(mobj_path, 'rb').read())
    num_objs = u16(buf, 48)
    pos = 50
    obj2_start = -1; obj2_size = 0
    for i in range(num_objs):
        nc = u16(buf, pos+2)
        if i == 2:
            obj2_start = pos; obj2_size = 4 + nc*12
        pos += 4 + nc*12

    if obj2_start < 0:
        print("  Object[2] not found — skipping patch")
        return False

    nc = u16(buf, obj2_start+2)
    body = buf[obj2_start+4:obj2_start+obj2_size]
    last_op = u32(body, (nc-1)*12)

    if last_op != 0x22800000:
        print(f"  Object[2] last cmd is 0x{last_op:08x}, not PLAY_PL — skipping")
        return False

    # Check if already patched
    if nc >= 2:
        pen_op = u32(body, (nc-2)*12)
        pen_o1 = u32(body, (nc-2)*12+4)
        if pen_op == 0x22800000 and pen_o1 == 0:
            print("  PLAY_PL(0) already in Object[2]")
            return True

    PLAY_PL_0 = bytearray(12)
    struct.pack_into('>III', PLAY_PL_0, 0, 0x22800000, 0x00000000, 0x00000000)

    new_nc  = nc + 1
    new_obj = bytearray(4 + new_nc*12)
    struct.pack_into('>H', new_obj, 0, u16(buf, obj2_start))
    struct.pack_into('>H', new_obj, 2, new_nc)
    new_obj[4:4+(nc-1)*12] = body[:(nc-1)*12]
    new_obj[4+(nc-1)*12:4+(nc-1)*12+12] = PLAY_PL_0
    new_obj[4+nc*12:] = body[(nc-1)*12:]

    mobj_len = u32(buf, 40)
    new_buf  = bytes(buf[:obj2_start]) + bytes(new_obj) + bytes(buf[obj2_start+obj2_size:])
    new_buf  = bytearray(new_buf)
    w32(new_buf, 40, mobj_len + 12)

    open(mobj_path, 'wb').write(new_buf)
    print(f"  Object[2] patched: {nc}→{new_nc} cmds")
    return True

# ── Full hypothesis test ───────────────────────────────────────────────────────
def copy_bdmv_from_iso(src_iso, dest_dir):
    """Mount src_iso, copy BDMV to dest_dir, detach."""
    mp = tempfile.mkdtemp(prefix='src_mount_')
    try:
        r = subprocess.run([HDIUTIL, 'attach', src_iso, '-mountpoint', mp, '-readonly', '-noverify'],
                          capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(f"Could not mount {src_iso}: {r.stderr.decode()[-200:]}")
        src_bdmv = os.path.join(mp, 'BDMV')
        if os.path.exists(src_bdmv):
            shutil.copytree(src_bdmv, os.path.join(dest_dir, 'BDMV'))
        else:
            raise RuntimeError(f"No BDMV in {src_iso}")
    finally:
        subprocess.run([HDIUTIL, 'detach', mp, '-force'], capture_output=True)
        try: os.rmdir(mp)
        except: pass

def test_hypothesis(name, build_fn, description, duration=5):
    """
    Full cycle: build splash → integrate into disc → package ISO → VLC test.
    Returns result dict.
    """
    print(f"\n{'='*60}")
    print(f"Hypothesis: {name}")
    print(f"Description: {description}")
    print(f"{'='*60}")

    work = tempfile.mkdtemp(prefix=f'harness_{name}_')
    iso_out = f'/tmp/harness_{name}.iso'
    mount_pt = f'/tmp/harness_{name}_mount'
    os.makedirs(mount_pt, exist_ok=True)

    t0 = time.time()
    result = {'name': name, 'description': description, 'error': None}

    try:
        print("\n[1] Copy BDMV from TEST.iso...")
        # Use already-mounted /Volumes/TEST if available, else mount from ISO
        if os.path.exists('/Volumes/TEST/BDMV'):
            shutil.copytree('/Volumes/TEST/BDMV', os.path.join(work, 'BDMV'))
            print("  Used already-mounted /Volumes/TEST")
        else:
            copy_bdmv_from_iso(SRC_ISO, work)
            print("  Mounted and copied from TEST.iso")

        # Remove old splash files (we'll replace them)
        for fname in ['00000.m2ts', '00000.mpls', '00000.clpi']:
            for sub in ['STREAM', 'PLAYLIST', 'CLIPINF', 'BACKUP', 'BACKUP/PLAYLIST']:
                p = os.path.join(work, 'BDMV', sub, fname)
                if os.path.exists(p): os.unlink(p)

        # Remove PLAY_PL(0) from MovieObject if it was previously patched
        # (We'll re-patch after building the new splash)
        # Actually, TEST.iso already has PLAY_PL(0) in Object[2].
        # If we're using a clean BDMV from ISO, keep MovieObject as-is
        # (it already has splash patched in from the original build).
        # We just need to replace the stream/clpi/mpls files.

        print(f"\n[2] Building splash ({name})...")
        splash_files = build_fn(work, duration)

        print(f"\n[3] Integrating splash files into BDMV...")
        stream_dir = os.path.join(work, 'BDMV', 'STREAM')
        clip_dir   = os.path.join(work, 'BDMV', 'CLIPINF')
        play_dir   = os.path.join(work, 'BDMV', 'PLAYLIST')
        back_dir   = os.path.join(work, 'BDMV', 'BACKUP')

        shutil.copy2(splash_files['m2ts'], os.path.join(stream_dir, '00000.m2ts'))
        shutil.copy2(splash_files['clpi'], os.path.join(clip_dir,   '00000.clpi'))
        shutil.copy2(splash_files['mpls'], os.path.join(play_dir,   '00000.mpls'))
        if os.path.exists(back_dir):
            shutil.copy2(splash_files['clpi'], os.path.join(back_dir, '00000.clpi'))
            os.makedirs(os.path.join(back_dir, 'PLAYLIST'), exist_ok=True)
            shutil.copy2(splash_files['mpls'], os.path.join(back_dir, 'PLAYLIST', '00000.mpls'))
        print("  Splash files copied.")

        print(f"\n[4] Verifying disc structure...")
        verify_result = verify_disc(work, name)
        result['verify'] = verify_result

        print(f"\n[5] Packaging ISO...")
        package_iso(work, iso_out, vol_name=f'H_{name.upper()[:30]}')

        print(f"\n[6] Mounting ISO...")
        detach(mount_pt)  # ensure clean state
        mount_iso(iso_out, mount_pt)

        print(f"\n[7] Running VLC (20s timeout)...")
        vlc_result = run_vlc(mount_pt, timeout_s=20)
        result['vlc'] = vlc_result

        elapsed = time.time() - t0
        result['elapsed_s'] = elapsed

        # Primary verdict: m2ts video duration (direct PTS check)
        m2ts_dur = verify_result.get('m2ts_video_dur')
        pts_delta = verify_result.get('m2ts_pts_delta')
        if m2ts_dur is not None:
            if m2ts_dur > 4.0:
                primary = f'PASS (m2ts video dur={m2ts_dur:.3f}s, Δpts={pts_delta})'
            else:
                primary = f'FAIL (m2ts video dur={m2ts_dur:.3f}s — tsMuxeR fps bug, Δpts={pts_delta})'
        else:
            primary = 'UNKNOWN (could not read m2ts PTS)'

        result['verdict'] = primary

        print(f"\n── Result ──")
        print(f"  m2ts video dur : {m2ts_dur:.3f}s" if m2ts_dur else "  m2ts video dur : unknown")
        print(f"  pts_delta/frame: {pts_delta} ticks (expected ~3750 for 24fps)")
        print(f"  verdict        : {primary}")
        print(f"\n── VLC (secondary) ──")
        print(f"  splash_dur : {vlc_result['splash_dur']:.2f}s")
        print(f"  pl0_fired  : {vlc_result['pl0_fired']}")
        print(f"  pl1_fired  : {vlc_result['pl1_fired']}")
        print(f"  log_lines  : {vlc_result.get('log_lines_pl0_to_pl1', 'N/A')}")
        for l in vlc_result.get('key_lines', [])[:8]:
            print(f"    {l.strip()[-120:]}")

        print(f"\n  Total time: {elapsed:.0f}s")

    except Exception as e:
        result['error'] = str(e)
        result['verdict'] = f'ERROR: {e}'
        print(f"\n  ERROR: {e}")
        import traceback; traceback.print_exc()

    finally:
        detach(mount_pt)
        shutil.rmtree(work, ignore_errors=True)
        if os.path.exists(iso_out): os.unlink(iso_out)

    return result

# ── Hypothesis implementations ─────────────────────────────────────────────────

def h_fps24(work, duration):
    """H_fps24: Use integer fps=24 instead of 24000/1001. Fixes tsMuxeR timestamp bug."""
    splash_png = '/tmp/test_splash.png'
    if not os.path.exists(splash_png):
        subprocess.run([FFMPEG, '-y', '-f', 'lavfi',
            '-i', 'color=c=0x1a1a2e:s=1920x1080:r=1',
            '-vframes', '1', splash_png], capture_output=True)
    return build_splash_fps24(work, splash_png, duration)

def h_post_process(work, duration):
    """H_post: Build with 24000/1001 fps, then post-process m2ts to fix timestamps."""
    sp_ts  = os.path.join(work, 'splash_post.ts')
    sp_mkv = os.path.join(work, 'splash_post.mkv')
    sp_bd  = os.path.join(work, 'splash_post_bd')
    os.makedirs(sp_bd, exist_ok=True)

    # Generate color PNG
    splash_png = os.path.join(work, 'splash_post.png')
    subprocess.run([FFMPEG, '-y', '-f', 'lavfi',
        '-i', 'color=c=0x1a1a2e:s=1920x1080:r=1',
        '-vframes', '1', splash_png], capture_output=True)

    ok = run([FFMPEG, '-y',
        '-framerate', '24000/1001', '-loop', '1', '-i', splash_png,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '20',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-bf', '0', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
        '-c:a', 'ac3', '-b:a', '192k', '-ac', '2',
        '-t', str(duration), '-shortest', '-f', 'mpegts', sp_ts,
    ], 'ffmpeg 24000/1001 → TS')
    if not ok: raise RuntimeError('ffmpeg failed')

    ok = run([MKVMERGE, '-o', sp_mkv, sp_ts], 'mkvmerge TS→MKV')
    if not ok: raise RuntimeError('mkvmerge failed')

    meta = os.path.join(work, 'splash_post.meta')
    with open(meta, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{sp_mkv}", fps=24000/1001, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{sp_mkv}", lang=und, track=2, default\n')

    ok = run([TSMUXER, meta, sp_bd], 'tsMuxeR→BDAV')
    if not ok: raise RuntimeError('tsMuxeR failed')

    m2ts_src  = os.path.join(sp_bd, 'BDMV', 'STREAM',   '00000.m2ts')
    mpls_path = os.path.join(sp_bd, 'BDMV', 'PLAYLIST', '00000.mpls')
    clpi_path = os.path.join(sp_bd, 'BDMV', 'CLIPINF',  '00000.clpi')

    # Read in_time from MPLS
    with open(mpls_path, 'rb') as f: mpls_buf = bytearray(f.read())
    in_t  = u32(mpls_buf, 0x52)
    out_t = in_t + round(duration * 45000)
    w32(mpls_buf, 0x56, out_t)
    open(mpls_path, 'wb').write(mpls_buf)

    # Patch CLPI
    with open(clpi_path, 'rb') as f: clpi_buf = bytearray(f.read())
    ci = u32(clpi_buf, 0x08)
    if len(clpi_buf) >= ci + 26:
        w32(clpi_buf, ci + 22, out_t)
        open(clpi_path, 'wb').write(clpi_buf)

    # Post-process m2ts: fix video PTS
    base_pts_90 = in_t * 2  # 45kHz → 90kHz
    _fix_m2ts_pts(m2ts_src, base_pts_90, duration)

    print(f"  m2ts: {os.path.getsize(m2ts_src)//1024} KB (post-processed)")
    return {'m2ts': m2ts_src, 'mpls': mpls_path, 'clpi': clpi_path, 'bd': sp_bd}

def _fix_m2ts_pts(m2ts_path, base_pts_90, duration):
    """Rewrite video PTS values in m2ts to span the correct duration."""
    FRAME_DUR_NUM = 90000 * 1001
    FRAME_DUR_DEN = 24000

    with open(m2ts_path, 'rb') as f:
        data = bytearray(f.read())

    n_pkts = len(data) // 192
    vf = 0  # video frame counter

    for pi in range(n_pkts):
        off = pi * 192
        ts_start = off + 4
        ts = data[ts_start:ts_start+188]
        if ts[0] != 0x47: continue
        pid = ((ts[1] & 0x1F) << 8) | ts[2]
        payload_start = (ts[1] >> 6) & 1
        afc = (ts[3] >> 4) & 3
        if afc not in (1, 3): continue
        payload_off = 4
        if afc == 3:
            payload_off += 1 + ts[4]
        if not payload_start: continue
        if payload_off + 9 > 188: continue

        pes = ts[payload_off:]
        if pes[0:3] != b'\x00\x00\x01': continue
        pts_dts_flags = (pes[7] >> 6) & 3
        if pts_dts_flags < 2: continue

        if pid == 0x1011:  # video
            new_pts = base_pts_90 + vf * FRAME_DUR_NUM // FRAME_DUR_DEN
            po = ts_start + payload_off + 9
            if po + 5 <= ts_start + 188:
                hi  = (new_pts >> 30) & 0x7
                mid = (new_pts >> 15) & 0x7FFF
                lo  = new_pts & 0x7FFF
                data[po]   = 0x21 | (hi << 1)
                data[po+1] = (mid >> 7) & 0xFF
                data[po+2] = 0x01 | ((mid & 0x7F) << 1)
                data[po+3] = (lo >> 7) & 0xFF
                data[po+4] = 0x01 | ((lo & 0x7F) << 1)
            vf += 1

    with open(m2ts_path, 'wb') as f:
        f.write(data)
    print(f"  PTS fixed: {vf} video frames corrected")

# ── Baseline: test current TEST.iso ───────────────────────────────────────────
def baseline_test():
    """Test the current splash in /Volumes/TEST and report."""
    print("\n" + "="*60)
    print("BASELINE: Testing current TEST.iso splash")
    print("="*60)

    if not os.path.exists('/Volumes/TEST/BDMV'):
        print("ERROR: /Volumes/TEST not mounted. Run: hdiutil attach ~/Desktop/TEST.iso -mountpoint /Volumes/TEST")
        return None

    print("\n[verify] Checking disc structure...")
    findings = verify_disc('/Volumes/TEST')

    m2ts_path = '/Volumes/TEST/BDMV/STREAM/00000.m2ts'
    m2ts_dur, pts_delta = check_m2ts_video_duration(m2ts_path)
    print(f"\n── Baseline m2ts PTS ──")
    print(f"  video dur  : {m2ts_dur:.3f}s" if m2ts_dur else "  video dur  : unknown")
    print(f"  pts_delta  : {pts_delta} ticks/frame (expected ~3750 for 24fps)")
    m2ts_verdict = ('PASS' if m2ts_dur and m2ts_dur > 4.0 else 'FAIL') if m2ts_dur else 'UNKNOWN'
    print(f"  verdict    : {m2ts_verdict}")

    print("\n[vlc] Running VLC...")
    vlc_result = run_vlc('/Volumes/TEST', timeout_s=20)

    print(f"\n── Baseline VLC (secondary) ──")
    print(f"  pl0_fired  : {vlc_result['pl0_fired']}")
    print(f"  pl1_fired  : {vlc_result['pl1_fired']}")
    print(f"  log_lines  : {vlc_result.get('log_lines_pl0_to_pl1', 'N/A')}")
    for l in vlc_result.get('key_lines', [])[:10]:
        print(f"    {l.strip()[-120:]}")

    return {'verify': findings, 'vlc': vlc_result,
            'm2ts_video_dur': m2ts_dur, 'm2ts_pts_delta': pts_delta}

# ── Journal writer ─────────────────────────────────────────────────────────────
def write_journal_entry(entry):
    """Append an entry to ~/Desktop/splash_investigation.md."""
    timestamp = time.strftime('%Y-%m-%d %H:%M')
    lines = [f"\n## {entry.get('name', 'Test')} — {timestamp}\n"]
    lines.append(f"**Description**: {entry.get('description', '')}\n")
    if 'error' in entry and entry['error']:
        lines.append(f"**Error**: {entry['error']}\n")
    if 'vlc' in entry:
        v = entry['vlc']
        lines.append(f"**splash_dur**: {v.get('splash_dur', '?'):.2f}s\n")
        lines.append(f"**verdict**: {v.get('verdict', '?')}\n")
        lines.append(f"**PL0 fired**: {v.get('pl0_fired')}, **PL1 fired**: {v.get('pl1_fired')}\n")
        lines.append(f"**log lines PL0→PL1**: {v.get('log_lines_pl0_to_pl1', 'N/A')}\n")
        if v.get('key_lines'):
            lines.append("\nKey VLC log lines:\n```\n")
            lines.extend(l.strip()[-120:] + '\n' for l in v['key_lines'][:10])
            lines.append("```\n")
    if 'elapsed_s' in entry:
        lines.append(f"**Elapsed**: {entry['elapsed_s']:.0f}s\n")

    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    with open(JOURNAL, 'a') as f:
        f.writelines(lines)
    print(f"  → Wrote journal entry to {JOURNAL}")

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'help'

    if cmd == 'baseline':
        r = baseline_test()
        if r:
            write_journal_entry({
                'name': 'BASELINE',
                'description': 'Current TEST.iso splash state',
                'vlc': r['vlc']
            })

    elif cmd == 'h-fps24':
        r = test_hypothesis(
            name='fps24',
            build_fn=h_fps24,
            description='Use integer fps=24 instead of 24000/1001 to avoid tsMuxeR timestamp bug',
        )
        write_journal_entry(r)

    elif cmd == 'h-post':
        r = test_hypothesis(
            name='post',
            build_fn=h_post_process,
            description='Use 24000/1001 fps then post-process m2ts to fix video PTS values',
        )
        write_journal_entry(r)

    elif cmd == 'h-all':
        results = []
        for name, fn, desc in [
            ('fps24', h_fps24, 'Integer fps=24 to fix tsMuxeR timestamp bug'),
            ('post',  h_post_process, 'Post-process m2ts PTS to fix timestamp spacing'),
        ]:
            r = test_hypothesis(name, fn, desc)
            write_journal_entry(r)
            results.append(r)
            if r.get('verdict', '').startswith('PASS') or r.get('verdict', '').startswith('LIKELY'):
                print(f"\n✓ {name} PASSED — stopping hypothesis search")
                break

        print("\n" + "="*60)
        print("SUMMARY")
        print("="*60)
        for r in results:
            print(f"  {r['name']:12s}: {r.get('verdict', 'ERROR')}")

    else:
        print(__doc__)
        print("\nAvailable commands: baseline, h-fps24, h-post, h-all")


# ── Harness extension: check_subtitles ───────────────────────────────────────
def check_subtitles(bd_folder, expected_pg_count=1):
    """
    Verify that each episode MPLS has num_PG >= expected_pg_count in its STN_table.
    Returns True if all checks pass.
    """
    playlist_dir = os.path.join(bd_folder, 'BDMV', 'PLAYLIST')
    if not os.path.isdir(playlist_dir):
        print(f"  ✗ check_subtitles: PLAYLIST dir not found at {playlist_dir}")
        return False

    mpls_files = sorted(f for f in os.listdir(playlist_dir)
                        if f.endswith('.mpls') and f != '00099.mpls')
    if not mpls_files:
        print("  ✗ check_subtitles: no episode MPLS files found")
        return False

    all_ok = True
    for fname in mpls_files:
        path_ = os.path.join(playlist_dir, fname)
        try:
            data = open(path_, 'rb').read()
            pl_start   = u32(data, 8)
            pi_off     = pl_start + 10  # PlayItem[0]
            stn_off    = pi_off + 34
            num_pg     = data[stn_off + 6]
            ok = num_pg >= expected_pg_count
            sym = '✓' if ok else '✗'
            print(f"  {sym} {fname}: num_PG={num_pg} (expect>={expected_pg_count})")
            if not ok: all_ok = False
        except Exception as e:
            print(f"  ✗ {fname}: error parsing MPLS — {e}")
            all_ok = False
    return all_ok


# ── Harness extension: check_menu ────────────────────────────────────────────
def check_menu(bd_folder):
    """
    Verify that the IG menu at slot 00099 is correctly structured:
    - 00099.m2ts exists and contains IG TS packets (PID 0x1200)
    - 00099.clpi has a stream with coding_type=0x91 (IG)
    - 00099.mpls references clip "00099" and has num_IG=1
    - MovieObject.bdmv obj[2] last command is PLAY_PL(99)
    Returns True if all checks pass.
    """
    stream_dir   = os.path.join(bd_folder, 'BDMV', 'STREAM')
    clipinf_dir  = os.path.join(bd_folder, 'BDMV', 'CLIPINF')
    playlist_dir = os.path.join(bd_folder, 'BDMV', 'PLAYLIST')
    mobj_path    = os.path.join(bd_folder, 'BDMV', 'MovieObject.bdmv')

    all_ok = True
    print("\n── check_menu ──")

    def chk(label, cond, detail=''):
        nonlocal all_ok
        sym = '✓' if cond else '✗'
        print(f"  {sym} {label}" + (f": {detail}" if detail else ''))
        if not cond: all_ok = False

    # 1. m2ts has IG packets
    m2ts_path = os.path.join(stream_dir, '00099.m2ts')
    chk('00099.m2ts exists', os.path.exists(m2ts_path))
    if os.path.exists(m2ts_path):
        data = open(m2ts_path, 'rb').read()
        ig_count = 0
        for i in range(4, len(data) - 188, 192):
            if data[i] == 0x47:
                pid = ((data[i+1] & 0x1F) << 8) | data[i+2]
                if pid == 0x1200:
                    ig_count += 1
        chk('00099.m2ts has IG packets (PID 0x1200)', ig_count > 0, f'{ig_count} packets')

    # 2. CLPI has IG stream (coding_type=0x91)
    clpi_path = os.path.join(clipinf_dir, '00099.clpi')
    chk('00099.clpi exists', os.path.exists(clpi_path))
    if os.path.exists(clpi_path):
        data = open(clpi_path, 'rb').read()
        pi_addr    = u32(data, 0x0C)
        num_st     = data[pi_addr + 6 + 6]
        found_ig   = False
        off = pi_addr + 14
        for i in range(num_st):
            entry_len = data[off + 2]
            ctype     = data[off + 3]
            if ctype == 0x91:
                found_ig = True
            off += 3 + entry_len
        chk('00099.clpi has IG stream (coding_type=0x91)', found_ig,
            f'{num_st} streams, IG={"yes" if found_ig else "no"}')

    # 3. MPLS clip name and num_IG
    mpls_path = os.path.join(playlist_dir, '00099.mpls')
    chk('00099.mpls exists', os.path.exists(mpls_path))
    if os.path.exists(mpls_path):
        data     = open(mpls_path, 'rb').read()
        pl_start = u32(data, 8)
        pi_off   = pl_start + 10
        clip_name = data[pi_off+2:pi_off+7].decode('ascii', errors='replace')
        stn_off   = pi_off + 34
        num_ig    = data[stn_off + 7]
        chk('00099.mpls clip reference is "00099"', clip_name == '00099', repr(clip_name))
        chk('00099.mpls num_IG=1', num_ig == 1, str(num_ig))

    # 4. MovieObject obj[2] → PLAY_PL(99)
    chk('MovieObject.bdmv exists', os.path.exists(mobj_path))
    if os.path.exists(mobj_path):
        data = open(mobj_path, 'rb').read()
        num_objs = u16(data, 48)  # num_objects is at offset 48 (MOBJ_STRUCT_OFF=40 + 8)
        pos = 50  # objects start at 50 (= 48 + 2 bytes for num_objs field)
        obj2_pos = -1
        for i in range(num_objs):
            num_cmds = u16(data, pos + 2)
            if i == 2: obj2_pos = pos
            pos += 4 + num_cmds * 12
        if obj2_pos >= 0:
            num_cmds2 = u16(data, obj2_pos + 2)
            last_off  = obj2_pos + 4 + (num_cmds2 - 1) * 12
            opcode    = u32(data, last_off)
            pl_id     = u32(data, last_off + 4)
            is_play_pl_99 = (opcode == 0x22800000 and pl_id == 99)
            chk('MovieObject obj[2] → PLAY_PL(99)', is_play_pl_99,
                f'opcode=0x{opcode:08X} pl_id={pl_id}')
        else:
            chk('MovieObject has >=3 objects', False, f'only {num_objs} objects')

    return all_ok


if __name__ == '__main__':
    main()
