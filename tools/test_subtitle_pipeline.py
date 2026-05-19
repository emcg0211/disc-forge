#!/usr/bin/env python3
"""
Goal 1: Test v1.9.0 subtitle pipeline end-to-end.

Simulates the multi-title handler in main.js for 2 episodes with PGS subs.
Steps:
  A.  ffprobe: detect streams
  A2. ffmpeg: extract PGS .sup from source MKVs
  B.  mkvmerge: main.ts + .sup → main_bd.mkv
  C.  Write tsMuxeR meta with S_HDMV/PGS entry
  D.  tsMuxeR: produce per-episode BDMV
  2.  Merge BDMV structures (rename stream files)
  3.  Package ISO, mount, inspect

Verification:
  - ffprobe STREAM/*.m2ts for PGS stream
  - xxd MPLS STN_table: num_PG != 0
  - VLC headless: log PG decode events
"""
import subprocess, os, sys, struct, shutil, time, tempfile, json, re
from pathlib import Path

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
FFPROBE  = '/opt/homebrew/bin/ffprobe'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'
HDIUTIL  = '/usr/bin/hdiutil'
XORRISO  = '/opt/homebrew/bin/xorriso'
VLC      = '/Applications/VLC.app/Contents/MacOS/VLC'

EP1_MKV = '/Volumes/Internal SSD/test_ep1_subs.mkv'
EP2_MKV = '/Volumes/Internal SSD/test_ep2_subs.mkv'
ISO_OUT = os.path.expanduser('~/Desktop/subtitle_test.iso')
LOG_OUT = os.path.expanduser('~/Desktop/vlc_subtitle_test.log')
JOURNAL = os.path.expanduser('~/Desktop/finalization_mission_journal.md')

def log(msg):
    print(msg, flush=True)

def run(cmd, desc, timeout=600, ok_codes=(0,)):
    log(f"  [{desc}] " + ' '.join(str(c) for c in cmd[:3]) + '...')
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in ok_codes:
        log(f"  FAIL exit={r.returncode} ({elapsed:.1f}s)")
        stderr = r.stderr.decode(errors='replace')
        log(f"  STDERR: {stderr[-600:]}")
        return False, r
    log(f"  OK ({elapsed:.1f}s)")
    return True, r

def u32(b, o): return struct.unpack('>I', b[o:o+4])[0]
def u16(b, o): return struct.unpack('>H', b[o:o+2])[0]

def probe_streams(path):
    r = subprocess.run(
        [FFPROBE, '-v', 'quiet', '-print_format', 'json', '-show_streams', path],
        capture_output=True, timeout=30
    )
    return json.loads(r.stdout.decode()).get('streams', [])

def detach_all_test():
    for vol in Path('/Volumes').iterdir():
        if vol.name.startswith('TEST') or vol.name.startswith('Test') or vol.name.startswith('subtitle'):
            subprocess.run([HDIUTIL, 'detach', str(vol), '-force'], capture_output=True)

def build_episode_bd(ep_path, ep_num, work_dir):
    """Build a single episode BDMV with PGS subtitle. Returns path to BD folder."""
    ep_dir = os.path.join(work_dir, f'ep{ep_num}')
    os.makedirs(ep_dir, exist_ok=True)
    main_ts   = os.path.join(ep_dir, 'main.ts')
    main_mkv  = os.path.join(ep_dir, 'main_bd.mkv')
    meta_file = os.path.join(ep_dir, 'tsmuxer.meta')
    ep_bd_out = os.path.join(ep_dir, 'bd_out')
    os.makedirs(ep_bd_out, exist_ok=True)

    # Probe source
    streams = probe_streams(ep_path)
    video_streams = [s for s in streams if s['codec_type'] == 'video']
    audio_streams = [s for s in streams if s['codec_type'] == 'audio']
    sub_streams   = [s for s in streams if s['codec_type'] == 'subtitle']
    log(f"  EP{ep_num}: {len(video_streams)} video, {len(audio_streams)} audio, {len(sub_streams)} subtitle(s)")
    log(f"  EP{ep_num}: source has {len(audio_streams)} audio track(s), {len(sub_streams)} subtitle(s)")

    # Step A: ffmpeg → main.ts (video + audio, no subtitles in MPEG-TS)
    audio_idx = audio_streams[0]['index'] if audio_streams else 'a:0'
    ok, _ = run([
        FFMPEG, '-y', '-i', ep_path,
        '-map', '0:v:0', '-map', f'0:{audio_idx}',
        '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-crf', '23',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-bf', '3', '-refs', '4',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-c:a', 'ac3', '-b:a', '640k', '-ac', '2',
        '-metadata:s:a:0', 'language=jpn',
        '-f', 'mpegts', '-mpegts_flags', 'system_b', main_ts,
    ], f'EP{ep_num} ffmpeg→main.ts', ok_codes=(0,))
    if not ok:
        return None, f'EP{ep_num} ffmpeg failed'
    log(f"  EP{ep_num}: main.ts {os.path.getsize(main_ts)//1024} KB")

    # Step A2: extract PGS subtitle tracks
    pgs_subs = []
    for si, sub in enumerate(sub_streams):
        if sub.get('codec_name') in ('hdmv_pgs_subtitle', 'pgssub'):
            sup_out = os.path.join(ep_dir, f'sub_ep{ep_num}_{si}.sup')
            ok2, _ = run([
                FFMPEG, '-y', '-i', ep_path,
                '-map', f'0:{sub["index"]}', '-c:s', 'copy', sup_out,
            ], f'EP{ep_num} extract PGS sub{si}', ok_codes=(0,))
            if ok2 and os.path.exists(sup_out) and os.path.getsize(sup_out) > 100:
                lang = sub.get('tags', {}).get('language', 'und')
                if lang == 'und': lang = 'eng'
                log(f"  [MT] EP{ep_num}: PGS sub{si} ({lang}) → {os.path.basename(sup_out)}")
                pgs_subs.append({'path': sup_out, 'lang': lang, 'track': si})
            else:
                log(f"  EP{ep_num}: WARNING PGS sub{si} extraction failed")

    log(f"  EP{ep_num}: {len(pgs_subs)}/{len(sub_streams)} subtitle(s) ready for mux")

    # Step B: mkvmerge → main_bd.mkv (main.ts + .sup files)
    mkv_args = [MKVMERGE, '-o', main_mkv, main_ts]
    for sub in pgs_subs:
        mkv_args += ['--language', f'0:{sub["lang"]}', sub['path']]
    ok3, _ = run(mkv_args, f'EP{ep_num} mkvmerge+subs', ok_codes=(0, 1))
    if not ok3 or not os.path.exists(main_mkv):
        return None, f'EP{ep_num} mkvmerge failed'
    log(f"  EP{ep_num}: main_bd.mkv {os.path.getsize(main_mkv)//1024} KB")

    # Probe combined MKV to get track numbers
    combined_streams = probe_streams(main_mkv)
    log(f"  EP{ep_num}: combined MKV has {len(combined_streams)} streams:")
    for s in combined_streams:
        log(f"    track {s['index']}: {s['codec_type']} {s.get('codec_name','?')} lang={s.get('tags',{}).get('language','?')}")

    # Step C: write tsMuxeR meta
    # In MKV from mkvmerge: track 1=video, track 2=audio, track 3+=PGS subs
    audio_count = len(audio_streams) or 1
    meta_lines = [
        'MUXOPT --blu-ray --new-audio-pes',
        f'V_MPEG4/ISO/AVC, "{main_mkv}", fps=24, insertSEI, contSPS, track=1',
        f'A_AC3, "{main_mkv}", lang=jpn, track=2, default',
    ]
    sub_track_num = audio_count + 2  # subs follow audio in MKV
    for sub in pgs_subs:
        meta_lines.append(f'S_HDMV/PGS, "{main_mkv}", lang={sub["lang"]}, track={sub_track_num}')
        sub_track_num += 1

    with open(meta_file, 'w') as f:
        f.write('\n'.join(meta_lines) + '\n')
    log(f"  [MT] EP{ep_num} meta ({audio_count} audio, {len(pgs_subs)} subtitle):")
    for line in meta_lines:
        log(f"    {line}")

    # Step D: tsMuxeR → episode BDMV
    ok4, _ = run([TSMUXER, meta_file, ep_bd_out], f'EP{ep_num} tsMuxeR', ok_codes=(0,))
    if not ok4:
        return None, f'EP{ep_num} tsMuxeR failed'

    stream_dir = os.path.join(ep_bd_out, 'BDMV', 'STREAM')
    m2ts_files = [f for f in os.listdir(stream_dir) if f.endswith('.m2ts')]
    log(f"  EP{ep_num}: STREAM/ has {m2ts_files}")
    return ep_bd_out, None


def check_stntable_pg(mpls_path):
    """Parse MPLS STN_table and return num_PG."""
    with open(mpls_path, 'rb') as f:
        data = f.read()

    # MPLS structure: magic (4) + version (4) + PlayList_start_address (4) + ...
    # PlayList_start_address is at offset 8
    pl_addr = u32(data, 8)  # PlayListMark_start_address? No, offset 8 = PlayList_start_address

    # Actually per BD spec:
    # Offsets 0-3: "MPLS" signature
    # Offsets 4-7: "0200" or "0300" version
    # Offsets 8-11: PlayList_start_address
    # Offsets 12-15: PlayListMark_start_address
    # Offsets 16-19: ExtensionData_start_address

    # PlayList starts at pl_addr
    # PlayList: length(4) + reserved(2) + num_PlayItems(2) + num_SubPaths(2)
    # Then PlayItems...

    if len(data) < pl_addr + 10:
        return None, "MPLS too short"

    num_play_items = u16(data, pl_addr + 6)
    log(f"  MPLS: PlayList at 0x{pl_addr:x}, {num_play_items} PlayItem(s)")

    # First PlayItem starts at pl_addr + 10
    pi_off = pl_addr + 10
    if len(data) < pi_off + 2:
        return None, "PlayItem offset out of bounds"
    pi_len = u16(data, pi_off)
    log(f"  MPLS: PlayItem[0] length={pi_len}, at 0x{pi_off:x}")

    # PlayItem layout:
    # length (2) + clip_info_id (5 chars + reserved) + connection_condition (1) + ...
    # STN_table is within PlayItem — at a fixed offset from PlayItem start
    # Per BD spec: STN_table starts after the PlayItem header fields
    # PlayItem: length(2) + ClipInfoFileName(5) + ClipCodecIdentifier(4) +
    #           reserved(11 bits) + is_multi_angle(1 bit) + connection_condition(4 bits) +
    #           ref_to_STC_id(1) + IN_time(4) + OUT_time(4) + UO_mask_table(8) +
    #           play_item_random_access_flag(1) + still_mode(1) + still_time(2) +
    #           ... then STN_table

    # From reference: STN_table offset within PlayItem is at byte 12 from PlayItem start
    # (after length(2) + name(5+4) + flags + ref + IN_time(4) + OUT_time(4))
    # Actually from the BD spec and empirical observation from harness:
    # The harness uses MPLS[0x38] == 0xC0 for random_access_flag

    # Let's search for STN_table by looking at known PlayItem structure
    # PlayItem header: 2+5+4+2+1+4+4+8+1+1+2 = 34 bytes
    # But this doesn't match. Let's use the actual known offsets.

    # From tsMuxeR analysis and the harness code:
    # 00000.mpls typical structure found at 0x52 (IN_time) and 0x56 (OUT_time)
    # This is specific to single-title. For multi-title, let me parse it properly.

    # Alternative: look for the STN_table signature pattern
    # STN_table starts with its length (2 bytes) + reserved (2 bytes) + stream counts
    # Within a PlayItem, STN_table is at a fixed relative offset.

    # Let me just scan from pi_off+2 (skip length) looking for where it could be
    # The known PlayItem structure (from BD spec):
    # +0: length (2)
    # +2: ClipInformationFileName (5 bytes, e.g. "00000")
    # +7: ClipCodecIdentifier (4 bytes, e.g. "M2TS")
    # +11: reserved(11) + is_multi_angle(1) + connection_condition(4) = 2 bytes
    # +13: ref_to_STC_id (1)
    # +14: IN_time (4)
    # +18: OUT_time (4)
    # +22: UO_mask_table (8)
    # +30: play_item_random_access_flag (1)
    # +31: still_mode (1)
    # +32: still_time (2, only if still_mode == 1) -- skip for 0
    # +32 or +34: STN_table (if still_mode == 0, it's at +34; actually still_time is always present as 2 bytes)
    # Actually: +34 typically for STN_table start when no multi-angle

    # is_multi_angle: let's check
    is_multi_angle = (data[pi_off + 12] >> 4) & 1
    if is_multi_angle:
        # Additional multi-angle data follows after still_time
        # Skip for now -- assume single angle
        pass

    # STN_table offset from PlayItem start: 34 bytes (when is_multi_angle=0, still_mode=0)
    stn_off = pi_off + 34

    # STN_table: length(2) + reserved(2) + num_primary_video(1) + num_primary_audio(1) +
    #            num_PG(1) + num_IG(1) + num_secondary_audio(1) + num_secondary_video(1) +
    #            num_PIP_PG(1) + reserved(5)
    if len(data) < stn_off + 14:
        return None, f"STN_table offset 0x{stn_off:x} out of bounds (file len={len(data)})"

    stn_len  = u16(data, stn_off)
    num_vid  = data[stn_off + 4]
    num_aud  = data[stn_off + 5]
    num_pg   = data[stn_off + 6]
    num_ig   = data[stn_off + 7]

    log(f"  STN_table at 0x{stn_off:x}: len={stn_len} vid={num_vid} aud={num_aud} pg={num_pg} ig={num_ig}")
    return num_pg, None


def build_test_disc():
    log("\n" + "="*60)
    log("GOAL 1: v1.9.0 Subtitle Pipeline End-to-End Test")
    log("="*60)
    t_start = time.time()

    work = tempfile.mkdtemp(prefix='subtitle_test_')
    log(f"Work dir: {work}")

    try:
        # Build each episode
        ep_bd_folders = []
        for i, ep_path in enumerate([EP1_MKV, EP2_MKV]):
            ep_num = i + 1
            log(f"\n── Episode {ep_num}: {os.path.basename(ep_path)} ──")
            if not os.path.exists(ep_path):
                log(f"  ERROR: {ep_path} not found")
                return None, f"Episode {ep_num} source MKV not found"
            bd_path, err = build_episode_bd(ep_path, ep_num, work)
            if err:
                log(f"  ERROR: {err}")
                return None, err
            ep_bd_folders.append(bd_path)

        # Step 2: Merge episode BD folders into combined BDMV
        log(f"\n── Step 2: Merge BDMV structures ──")
        bd_folder = os.path.join(work, 'final_bd')
        for d in ['BDMV/STREAM', 'BDMV/CLIPINF', 'BDMV/PLAYLIST', 'BDMV/BACKUP']:
            os.makedirs(os.path.join(bd_folder, d), exist_ok=True)

        # tsMuxeR names its output 00001.m2ts sometimes, 00000.m2ts other times
        def find_prefix(ep_bd):
            for n in ['00001', '00000']:
                if os.path.exists(os.path.join(ep_bd, 'BDMV', 'STREAM', f'{n}.m2ts')):
                    return n
            return None

        for i, ep_bd in enumerate(ep_bd_folders):
            ep_num = i + 1
            dest_name = f'{i:05d}'
            prefix = find_prefix(ep_bd)
            if not prefix:
                return None, f"Episode {ep_num}: no .m2ts found in {ep_bd}/BDMV/STREAM"

            for subdir, src_name, dst_name in [
                ('BDMV/STREAM',  f'{prefix}.m2ts', f'{dest_name}.m2ts'),
                ('BDMV/CLIPINF', f'{prefix}.clpi', f'{dest_name}.clpi'),
                ('BDMV/PLAYLIST', f'{prefix}.mpls', f'{dest_name}.mpls'),
            ]:
                src = os.path.join(ep_bd, subdir, src_name)
                dst = os.path.join(bd_folder, subdir, dst_name)
                if os.path.exists(src):
                    shutil.copy2(src, dst)
                    log(f"  {subdir}/{src_name} → {dst_name}")

            # BACKUP copies
            for subdir, src_name, dst_name in [
                ('BDMV/BACKUP',  f'{prefix}.clpi', f'{dest_name}.clpi'),
            ]:
                src = os.path.join(ep_bd, subdir, src_name)
                dst = os.path.join(bd_folder, subdir, dst_name)
                if os.path.exists(src):
                    shutil.copy2(src, dst)

        # Copy MovieObject + index from ep1
        for fname in ['MovieObject.bdmv', 'index.bdmv']:
            src = os.path.join(ep_bd_folders[0], 'BDMV', fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(bd_folder, 'BDMV', fname))

        # Apply navigation patch (port from main.js fixNav)
        log("\n── Step 3: Apply navigation patch ──")
        _patch_nav(bd_folder, len(ep_bd_folders))

        # Package ISO
        log("\n── Step 4: Package ISO ──")
        detach_all_test()
        if os.path.exists(ISO_OUT):
            os.unlink(ISO_OUT)
        ok, _ = run([
            XORRISO, '-as', 'mkisofs', '-udf', '-udfver', '2.50',
            '-V', 'SUBTITLE_TEST', '-o', ISO_OUT, bd_folder
        ], 'xorriso pack ISO', ok_codes=(0, 1))
        if not ok or not os.path.exists(ISO_OUT):
            # Try native xorriso mode
            run([XORRISO, '-outdev', f'stdio:{ISO_OUT}',
                 '-map', bd_folder, '/', '-volid', 'SUBTITLE_TEST', '-commit'],
                'xorriso native pack ISO')
        log(f"  ISO: {ISO_OUT} ({os.path.getsize(ISO_OUT)//1024//1024} MB)")

        # Mount ISO
        log("\n── Step 5: Mount and inspect ──")
        # Let hdiutil pick the mount point, then grep it from output
        r = subprocess.run(
            [HDIUTIL, 'attach', ISO_OUT, '-readonly', '-noverify'],
            capture_output=True, timeout=30
        )
        if r.returncode != 0:
            return None, f"hdiutil mount failed: {r.stderr.decode()[-200:]}"
        # Parse mount point from hdiutil output (last line, last field)
        hdi_out = r.stdout.decode()
        mount_pt = hdi_out.strip().split('\n')[-1].split('\t')[-1].strip()
        log(f"  Mounted at: {mount_pt}")

        try:
            # Inspect m2ts files for PGS streams
            log("\n── Inspecting m2ts for PGS streams ──")
            stream_dir = os.path.join(mount_pt, 'BDMV', 'STREAM')
            m2ts_results = {}
            for m2ts_file in sorted(os.listdir(stream_dir)):
                if not m2ts_file.endswith('.m2ts'):
                    continue
                m2ts_path = os.path.join(stream_dir, m2ts_file)
                streams = probe_streams(m2ts_path)
                subs = [s for s in streams if s['codec_type'] == 'subtitle']
                log(f"  {m2ts_file}: {len(streams)} streams, {len(subs)} subtitle(s)")
                for s in subs:
                    log(f"    sub: {s.get('codec_name','?')} pid={s.get('id','?')} lang={s.get('tags',{}).get('language','?')}")
                m2ts_results[m2ts_file] = subs

            # Inspect MPLS STN_table
            log("\n── Inspecting MPLS STN_table ──")
            stn_results = {}
            playlist_dir = os.path.join(mount_pt, 'BDMV', 'PLAYLIST')
            for mpls_file in sorted(os.listdir(playlist_dir)):
                if not mpls_file.endswith('.mpls'):
                    continue
                mpls_path = os.path.join(playlist_dir, mpls_file)
                num_pg, err = check_stntable_pg(mpls_path)
                stn_results[mpls_file] = num_pg
                if err:
                    log(f"  {mpls_file}: STN_table parse error: {err}")

            # Run VLC headless
            log("\n── VLC headless test ──")
            env = dict(os.environ, BD_DEBUG_MASK='0xffff')
            with open(LOG_OUT, 'w') as lf:
                proc = subprocess.Popen(
                    [VLC, '-vvv', '--no-video', '--intf', 'dummy',
                     '--play-and-exit', '--stop-time', '15',
                     f'bluray://{mount_pt}/'],
                    stdout=lf, stderr=subprocess.STDOUT, env=env
                )
            deadline = time.time() + 30
            while time.time() < deadline and proc.poll() is None:
                time.sleep(0.5)
            if proc.poll() is None:
                proc.terminate(); time.sleep(1)
                if proc.poll() is None: proc.kill()

            with open(LOG_OUT) as f:
                vlc_log = f.read()

            pg_lines = [l for l in vlc_log.splitlines() if
                        any(k in l for k in ['PG', 'subtitle', 'sub stream', 'decode_segments', 'PGS', 'PGS_DECODE'])]
            log(f"  VLC log: {len(vlc_log.splitlines())} lines total")
            log(f"  PG-related lines: {len(pg_lines)}")
            for l in pg_lines[:15]:
                log(f"    {l.strip()[-120:]}")

            # Verdict
            log("\n── VERDICT ──")
            all_m2ts_ok = all(len(subs) > 0 for subs in m2ts_results.values())
            any_pg_in_stn = any(v and v > 0 for v in stn_results.values())
            any_pg_in_vlc = len(pg_lines) > 0

            log(f"  m2ts PGS present: {all_m2ts_ok} — {dict((k, len(v)) for k,v in m2ts_results.items())}")
            log(f"  STN_table num_PG: {stn_results}")
            log(f"  VLC PG log lines: {any_pg_in_vlc} ({len(pg_lines)} lines)")

            if all_m2ts_ok and any_pg_in_stn:
                verdict = 'PASS'
            elif all_m2ts_ok and not any_pg_in_stn:
                verdict = 'PARTIAL — PGS in m2ts but STN_table num_PG=0'
            else:
                verdict = 'FAIL — PGS not present in m2ts'

            log(f"\n  OVERALL: {verdict}")
            elapsed = time.time() - t_start
            log(f"  Elapsed: {elapsed:.0f}s")

            return {
                'verdict': verdict,
                'm2ts_results': {k: len(v) for k,v in m2ts_results.items()},
                'stn_results': stn_results,
                'pg_vlc_lines': len(pg_lines),
                'vlc_log': LOG_OUT,
                'iso': ISO_OUT,
                'elapsed': elapsed,
            }, None

        finally:
            subprocess.run([HDIUTIL, 'detach', mount_pt, '-force'], capture_output=True)

    finally:
        shutil.rmtree(work, ignore_errors=True)


def _patch_nav(bd_folder, N):
    """
    Port of main.js fixNav for multi-title:
    1. MovieObject obj[2]: replace JUMP_TITLE(0) → PLAY_PL(1); append N-1 objs for EP2..EPN
    2. index.bdmv: rebuild Indexes section with FirstPlay/TopMenu→obj[2], N title entries
    """
    mobj_path  = os.path.join(bd_folder, 'BDMV', 'MovieObject.bdmv')
    index_path = os.path.join(bd_folder, 'BDMV', 'index.bdmv')
    back_dir   = os.path.join(bd_folder, 'BDMV', 'BACKUP')

    if not os.path.exists(mobj_path):
        log("  Nav: no MovieObject.bdmv — skipping")
        return

    buf = bytearray(open(mobj_path, 'rb').read())
    mobj_len = u32(buf, 40)
    num_objs = u16(buf, 48)
    pos = 50

    tmpl_bytes = None
    obj2_pos   = 0
    for i in range(num_objs):
        nc = u16(buf, pos + 2)
        obj_sz = 4 + nc * 12
        if i == 2:
            tmpl_bytes = bytes(buf[pos:pos+obj_sz])
            obj2_pos   = pos
        pos += obj_sz

    if tmpl_bytes is None:
        log(f"  Nav: only {num_objs} objects — skipping")
        return

    tmpl_nc     = u16(tmpl_bytes, 2)
    last_cmd_off = 4 + (tmpl_nc - 1) * 12
    w0 = u32(tmpl_bytes, last_cmd_off)
    w1 = u32(tmpl_bytes, last_cmd_off + 4)
    log(f"  Nav: obj[2] has {tmpl_nc} cmds, last=0x{w0:08x} w1={w1}")

    if w0 != 0x21810000 or w1 != 0:
        log(f"  Nav: last cmd not JUMP_TITLE(0) (got 0x{w0:08x}/{w1}) — skipping fixNav")
        # Still try to add PLAY_PL commands if needed
        return

    # Replace obj[2] JUMP_TITLE(0) → PLAY_PL(1)
    struct.pack_into('>III', buf, obj2_pos + last_cmd_off, 0x22800000, 1, 0)
    log("  Nav: replaced obj[2] JUMP_TITLE(0) → PLAY_PL(1)")

    # Append N-1 new objects PLAY_PL(2)..PLAY_PL(N)
    new_obj_bufs = []
    for i in range(N - 1):
        playlist_id = i + 2
        new_obj = bytearray(tmpl_bytes)
        struct.pack_into('>III', new_obj, last_cmd_off, 0x22800000, playlist_id, 0)
        new_obj_bufs.append(bytes(new_obj))
        log(f"  Nav: appended obj[{num_objs+i}] → PLAY_PL({playlist_id})")

    total_new = sum(len(b) for b in new_obj_bufs)
    new_buf = bytes(buf) + b''.join(new_obj_bufs)
    new_buf = bytearray(new_buf)
    struct.pack_into('>I', new_buf, 40, mobj_len + total_new)
    struct.pack_into('>H', new_buf, 48, num_objs + (N - 1))
    open(mobj_path, 'wb').write(new_buf)
    log(f"  Nav: MovieObject {num_objs}→{num_objs+(N-1)} objs, {len(buf)}→{len(new_buf)} bytes")

    # Rebuild index.bdmv
    if not os.path.exists(index_path):
        log("  Nav: no index.bdmv — skipping index rebuild")
        return

    idx_buf  = bytearray(open(index_path, 'rb').read())
    idx_start = u32(idx_buf, 8)

    ENTRY_SIZE = 12
    total_titles = N
    new_data_len = 26 + ENTRY_SIZE * total_titles
    new_indexes = bytearray(4 + new_data_len)
    struct.pack_into('>I', new_indexes, 0, new_data_len)

    def hdmv_entry(id_ref, playback_type):
        e = bytearray(ENTRY_SIZE)
        e[0] = 0x40
        e[4] = (playback_type & 0x03) << 6
        struct.pack_into('>H', e, 6, id_ref)
        return bytes(e)

    # FirstPlay → obj[2]; TopMenu → obj[2]
    new_indexes[4:16]  = hdmv_entry(2, 1)
    new_indexes[16:28] = hdmv_entry(2, 1)
    struct.pack_into('>H', new_indexes, 28, total_titles)
    for i in range(total_titles):
        id_ref = 2 if i == 0 else (num_objs + i - 1)
        new_indexes[30 + i*ENTRY_SIZE:30 + (i+1)*ENTRY_SIZE] = hdmv_entry(id_ref, 0)
        log(f"  Nav: index Title[{i}] → obj[{id_ref}]")

    new_idx = bytes(idx_buf[:idx_start]) + bytes(new_indexes)
    open(index_path, 'wb').write(new_idx)
    log(f"  Nav: index.bdmv rebuilt {len(idx_buf)}→{len(new_idx)} bytes")

    # BACKUP copies
    if os.path.exists(back_dir):
        for fname, src in [('MovieObject.bdmv', mobj_path), ('index.bdmv', index_path)]:
            shutil.copy2(src, os.path.join(back_dir, fname))


def append_journal(goal, timestamp, subject, attempted, tools_used, result, evidence, decision):
    entry = f"""
## [{goal}] — {timestamp} — {subject}
- Attempted: {attempted}
- Tools used: {tools_used}
- Result: {result}
- Evidence: {evidence}
- Decision: {decision}

"""
    with open(JOURNAL, 'a') as f:
        f.write(entry)
    log(f"Journal updated: {JOURNAL}")


if __name__ == '__main__':
    result, err = build_test_disc()
    ts = time.strftime('%Y-%m-%d %H:%M')
    if err:
        log(f"\nFATAL: {err}")
        append_journal('1.c', ts, 'PGS Subtitle Pipeline Build',
                       'Build multi-title disc with PGS subs from test MKVs',
                       'ffmpeg, mkvmerge, tsMuxeR, xorriso, hdiutil',
                       f'FAIL — {err}', 'N/A', 'Investigate error')
        sys.exit(1)
    else:
        verdict = result['verdict']
        stn = result['stn_results']
        append_journal('1.c-1.f', ts, 'PGS Subtitle Pipeline End-to-End',
                       'Build 2-ep multi-title disc with PGS subs, mount, inspect STN_table, VLC test',
                       'ffmpeg, mkvmerge, tsMuxeR, xorriso, hdiutil, ffprobe, VLC',
                       verdict,
                       f"ISO: {result['iso']}, VLC log: {result['vlc_log']}, STN: {stn}, m2ts PGS: {result['m2ts_results']}, VLC PG lines: {result['pg_vlc_lines']}",
                       'Continue to Goal 2' if 'PASS' in verdict else 'Fix STN_table if PARTIAL')
        log(f"\n{'='*60}")
        log(f"Goal 1 complete: {verdict}")
        log(f"VLC log: {result['vlc_log']}")
