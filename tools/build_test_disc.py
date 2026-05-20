#!/usr/bin/env python3
"""
build_test_disc.py — Build a 2-episode test disc with IG menu.

Uses /tmp/splash_bd.mkv (EP1) and /tmp/test_with_subs.mkv (EP2).
Outputs ~/Desktop/v1103_test.iso.
Replicates the main.js build-multi-title-disc pipeline programmatically.
"""
import subprocess, os, sys, struct, shutil, time, tempfile
from pathlib import Path

FFMPEG   = '/opt/homebrew/bin/ffmpeg'
FFPROBE  = '/opt/homebrew/bin/ffprobe'
MKVMERGE = '/opt/homebrew/bin/mkvmerge'
TSMUXER  = '/opt/homebrew/bin/tsMuxeR'
HDIUTIL  = '/usr/bin/hdiutil'
XORRISO  = '/opt/homebrew/bin/xorriso'
NODE     = '/opt/homebrew/bin/node'

EP1_MKV  = '/tmp/splash_bd.mkv'
EP2_MKV  = '/tmp/test_with_subs.mkv'
ISO_OUT  = os.path.expanduser('~/Desktop/v1106_test.iso')

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
MENU_INJ  = os.path.join(TOOLS_DIR, 'menu_inject.js')


def log(msg):
    print(msg, flush=True)

def run(cmd, desc, timeout=600, ok_codes=(0,)):
    log(f"  [{desc}] " + ' '.join(str(c) for c in cmd[:4]) + '...')
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    elapsed = time.time() - t0
    if r.returncode not in ok_codes:
        log(f"  FAIL exit={r.returncode} ({elapsed:.1f}s)")
        log(f"  STDOUT: {r.stdout.decode(errors='replace')[-400:]}")
        log(f"  STDERR: {r.stderr.decode(errors='replace')[-400:]}")
        return False, r
    log(f"  OK ({elapsed:.1f}s)")
    return True, r

def u32(b, o): return struct.unpack('>I', b[o:o+4])[0]
def u16(b, o): return struct.unpack('>H', b[o:o+2])[0]

def detach_test_volumes():
    for vol in Path('/Volumes').iterdir():
        if vol.name.upper().startswith('TEST') or vol.name.upper().startswith('V1103') or vol.name.upper().startswith('V1106'):
            subprocess.run([HDIUTIL, 'detach', str(vol), '-force'], capture_output=True)

def find_prefix(ep_bd):
    for n in ['00001', '00000']:
        if os.path.exists(os.path.join(ep_bd, 'BDMV', 'STREAM', f'{n}.m2ts')):
            return n
    return None


def build_episode_bd(ep_path, ep_num, work_dir):
    """Build one episode BDMV. Returns (bd_path, error_string)."""
    ep_dir   = os.path.join(work_dir, f'ep{ep_num}')
    main_ts  = os.path.join(ep_dir, 'main.ts')
    main_mkv = os.path.join(ep_dir, 'main_bd.mkv')
    meta_f   = os.path.join(ep_dir, 'tsmuxer.meta')
    ep_bd    = os.path.join(ep_dir, 'bd_out')
    os.makedirs(ep_bd, exist_ok=True)

    # ffmpeg: re-encode to H.264/AC3 MPEG-TS (stream copy where possible)
    ok, _ = run([
        FFMPEG, '-y', '-i', ep_path,
        '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'high', '-level', '4.1',
        '-pix_fmt', 'yuv420p', '-crf', '23',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-bf', '3', '-refs', '4',
        '-maxrate', '25000k', '-bufsize', '30000k',
        '-c:a', 'ac3', '-b:a', '640k', '-ac', '2',
        '-f', 'mpegts', '-mpegts_flags', 'system_b', main_ts,
    ], f'EP{ep_num} ffmpeg→ts', timeout=300)
    if not ok:
        return None, f'EP{ep_num} ffmpeg failed'

    # mkvmerge: wrap TS for tsMuxeR
    ok, _ = run([MKVMERGE, '-o', main_mkv, main_ts], f'EP{ep_num} mkvmerge', ok_codes=(0, 1))
    if not ok or not os.path.exists(main_mkv):
        return None, f'EP{ep_num} mkvmerge failed'

    with open(meta_f, 'w') as f:
        f.write('MUXOPT --blu-ray --new-audio-pes\n')
        f.write(f'V_MPEG4/ISO/AVC, "{main_mkv}", fps=24, insertSEI, contSPS, track=1\n')
        f.write(f'A_AC3, "{main_mkv}", lang=und, track=2, default\n')

    ok, _ = run([TSMUXER, meta_f, ep_bd], f'EP{ep_num} tsMuxeR', timeout=300)
    if not ok:
        return None, f'EP{ep_num} tsMuxeR failed'

    return ep_bd, None


def patch_nav(bd_folder, N):
    """
    Port of main.js fixMultiTitleNavigationForEpisodes:
    - MovieObject obj[2]: replace JUMP_TITLE(0) → PLAY_PL(1), add objs for EP2..EPN
    - index.bdmv: rebuild with N title entries
    """
    mobj_path  = os.path.join(bd_folder, 'BDMV', 'MovieObject.bdmv')
    index_path = os.path.join(bd_folder, 'BDMV', 'index.bdmv')
    back_dir   = os.path.join(bd_folder, 'BDMV', 'BACKUP')

    if not os.path.exists(mobj_path):
        log('  Nav: no MovieObject.bdmv — skipping'); return

    buf      = bytearray(open(mobj_path, 'rb').read())
    num_objs = u16(buf, 48)
    pos      = 50
    tmpl_bytes = None
    obj2_pos   = 0
    for i in range(num_objs):
        nc = u16(buf, pos + 2)
        if i == 2:
            tmpl_bytes = bytes(buf[pos:pos + 4 + nc * 12])
            obj2_pos   = pos
        pos += 4 + nc * 12

    if tmpl_bytes is None:
        log(f'  Nav: only {num_objs} objects — cannot patch'); return

    tmpl_nc       = u16(tmpl_bytes, 2)
    last_cmd_off  = 4 + (tmpl_nc - 1) * 12
    w0 = u32(tmpl_bytes, last_cmd_off)
    log(f'  Nav: obj[2] last cmd = 0x{w0:08x}')

    # Patch obj[2] last cmd: JUMP_TITLE(0) → PLAY_PL(1)
    struct.pack_into('>III', buf, obj2_pos + last_cmd_off, 0x22800000, 1, 0)
    log('  Nav: patched obj[2] → PLAY_PL(1)')

    # Append N-1 new objects
    new_obj_bufs = []
    for i in range(N - 1):
        pl = i + 2
        new_obj = bytearray(tmpl_bytes)
        struct.pack_into('>III', new_obj, last_cmd_off, 0x22800000, pl, 0)
        new_obj_bufs.append(bytes(new_obj))
        log(f'  Nav: appended obj[{num_objs+i}] → PLAY_PL({pl})')

    total_new = sum(len(b) for b in new_obj_bufs)
    mobj_len  = u32(buf, 40)
    new_buf   = bytearray(bytes(buf) + b''.join(new_obj_bufs))
    struct.pack_into('>I', new_buf, 40, mobj_len + total_new)
    struct.pack_into('>H', new_buf, 48, num_objs + (N - 1))
    open(mobj_path, 'wb').write(new_buf)
    log(f'  Nav: MovieObject written ({len(buf)}→{len(new_buf)} bytes)')

    # Rebuild index.bdmv
    if not os.path.exists(index_path):
        log('  Nav: no index.bdmv — skipping index rebuild'); return

    idx_buf   = bytearray(open(index_path, 'rb').read())
    idx_start = u32(idx_buf, 8)
    ENTRY_SZ  = 12

    def hdmv_entry(id_ref, playback_type):
        e = bytearray(ENTRY_SZ)
        e[0] = 0x40
        e[4] = (playback_type & 0x03) << 6
        struct.pack_into('>H', e, 6, id_ref)
        return bytes(e)

    new_data_len = 26 + ENTRY_SZ * N
    new_indexes  = bytearray(4 + new_data_len)
    struct.pack_into('>I', new_indexes, 0, new_data_len)
    new_indexes[4:16]  = hdmv_entry(2, 1)   # FirstPlay → obj[2]
    new_indexes[16:28] = hdmv_entry(2, 1)   # TopMenu   → obj[2]
    struct.pack_into('>H', new_indexes, 28, N)
    for i in range(N):
        id_ref = 2 if i == 0 else (num_objs + i - 1)
        new_indexes[30 + i*ENTRY_SZ:30 + (i+1)*ENTRY_SZ] = hdmv_entry(id_ref, 0)
        log(f'  Nav: index Title[{i}] → obj[{id_ref}]')

    new_idx = bytes(idx_buf[:idx_start]) + bytes(new_indexes)
    open(index_path, 'wb').write(new_idx)
    log(f'  Nav: index.bdmv rebuilt')

    if os.path.exists(back_dir):
        for fname, src in [('MovieObject.bdmv', mobj_path), ('index.bdmv', index_path)]:
            shutil.copy2(src, os.path.join(back_dir, fname))


def build_disc():
    log('\n' + '='*60)
    log('build_test_disc.py — 2-episode IG menu test disc')
    log('='*60)
    t0 = time.time()

    for ep in [EP1_MKV, EP2_MKV]:
        if not os.path.exists(ep):
            log(f'ERROR: missing input: {ep}')
            return None, f'Missing input: {ep}'

    work = tempfile.mkdtemp(prefix='v1106_build_')
    log(f'Work dir: {work}')

    try:
        # Build per-episode BD
        ep_dirs = []
        for i, ep_path in enumerate([EP1_MKV, EP2_MKV]):
            log(f'\n── Episode {i+1}: {os.path.basename(ep_path)} ──')
            bd, err = build_episode_bd(ep_path, i + 1, work)
            if err:
                return None, err
            ep_dirs.append(bd)

        # Merge BDMV structures
        log('\n── Merge BDMV structures ──')
        bd_folder = os.path.join(work, 'final_bd')
        for d in ['BDMV/STREAM', 'BDMV/CLIPINF', 'BDMV/PLAYLIST', 'BDMV/BACKUP']:
            os.makedirs(os.path.join(bd_folder, d), exist_ok=True)

        for i, ep_bd in enumerate(ep_dirs):
            prefix   = find_prefix(ep_bd)
            dest_name = f'{i:05d}'
            if not prefix:
                return None, f'EP{i+1}: no m2ts in {ep_bd}'
            for subdir, src_n, dst_n in [
                ('BDMV/STREAM',   f'{prefix}.m2ts', f'{dest_name}.m2ts'),
                ('BDMV/CLIPINF',  f'{prefix}.clpi', f'{dest_name}.clpi'),
                ('BDMV/PLAYLIST', f'{prefix}.mpls', f'{dest_name}.mpls'),
            ]:
                src = os.path.join(ep_bd, subdir, src_n)
                dst = os.path.join(bd_folder, subdir, dst_n)
                if os.path.exists(src):
                    shutil.copy2(src, dst)
                    log(f'  {subdir}/{src_n} → {dst_n}')
            for src_n, dst_n in [(f'{prefix}.clpi', f'{dest_name}.clpi')]:
                src = os.path.join(ep_bd, 'BDMV/BACKUP', src_n)
                dst = os.path.join(bd_folder, 'BDMV/BACKUP', dst_n)
                if os.path.exists(src):
                    shutil.copy2(src, dst)

        # Copy MovieObject + index from ep1
        for fname in ['MovieObject.bdmv', 'index.bdmv']:
            src = os.path.join(ep_dirs[0], 'BDMV', fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(bd_folder, 'BDMV', fname))

        # Navigation patch (N=2 titles)
        log('\n── Navigation patch ──')
        patch_nav(bd_folder, 2)

        # IG Menu injection via Node.js
        log('\n── IG Menu injection ──')
        ok, r = run([NODE, MENU_INJ, bd_folder, '2', FFMPEG, TSMUXER],
                    'node menu_inject.js', timeout=120)
        if not ok:
            return None, 'menu_inject.js failed'

        # Package ISO
        log('\n── Package ISO ──')
        detach_test_volumes()
        if os.path.exists(ISO_OUT):
            os.unlink(ISO_OUT)

        ok, _ = run([
            XORRISO, '-as', 'mkisofs', '-udf', '-udfver', '2.50',
            '-V', 'V1106TEST', '-o', ISO_OUT, bd_folder,
        ], 'xorriso pack ISO', ok_codes=(0, 1))

        if not ok or not os.path.exists(ISO_OUT):
            ok, _ = run([
                XORRISO, '-outdev', f'stdio:{ISO_OUT}',
                '-map', bd_folder, '/', '-volid', 'V1106TEST', '-commit',
            ], 'xorriso native ISO')

        if not os.path.exists(ISO_OUT):
            return None, 'ISO not created'

        iso_mb = os.path.getsize(ISO_OUT) // 1024 // 1024
        elapsed = time.time() - t0
        log(f'\nISO: {ISO_OUT} ({iso_mb} MB) — built in {elapsed:.0f}s')
        return ISO_OUT, None

    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    iso, err = build_disc()
    if err:
        log(f'\nFATAL: {err}')
        sys.exit(1)
    log(f'\nSUCCESS: {iso}')
