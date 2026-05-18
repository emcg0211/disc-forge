#!/usr/bin/env python3
"""
Patch the splash CLPI in TEST.iso to fix the presentation_end_time.
Copies TEST.iso → TESTFIX.iso, replaces 4 bytes in the CLPI.
Then verifies with VLC.
"""
import subprocess, os, struct, tempfile, time, shutil

HDIUTIL = '/usr/bin/hdiutil'
VLC     = '/Applications/VLC.app/Contents/MacOS/VLC'
XORRISO = '/opt/homebrew/bin/xorriso'
SRC_ISO = os.path.expanduser('~/Desktop/TEST.iso')
OUT_ISO = os.path.expanduser('~/Desktop/TESTFIX.iso')

def u32be(buf, off): return struct.unpack('>I', buf[off:off+4])[0]
def w32be(buf, off, v): struct.pack_into('>I', buf, off, v)

def detach_all():
    for v in ['TEST', 'Test', 'TEST 1', 'Test 1', 'TESTFIX']:
        subprocess.run([HDIUTIL, 'detach', f'/Volumes/{v}', '-force'],
                      capture_output=True)

def main():
    detach_all()

    # Mount source ISO
    mp_src = '/tmp/iso_src'
    os.makedirs(mp_src, exist_ok=True)
    r = subprocess.run([HDIUTIL, 'attach', SRC_ISO, '-mountpoint', mp_src, '-readonly'],
                      capture_output=True)
    if r.returncode != 0:
        print(f"FAIL: cannot mount {SRC_ISO}: {r.stderr.decode()}")
        return

    # Copy BDMV to writable temp dir
    work = tempfile.mkdtemp(prefix='iso_patch_')
    bdmv_src = os.path.join(mp_src, 'BDMV')
    bdmv_dst = os.path.join(work, 'BDMV')
    print(f"Copying BDMV to {work}...")
    shutil.copytree(bdmv_src, bdmv_dst)

    # Also copy CERTIFICATE if present
    cert_src = os.path.join(mp_src, 'CERTIFICATE')
    if os.path.exists(cert_src):
        shutil.copytree(cert_src, os.path.join(work, 'CERTIFICATE'))

    subprocess.run([HDIUTIL, 'detach', mp_src, '-force'], capture_output=True)

    # Apply CLPI fix
    clpi_path = os.path.join(bdmv_dst, 'CLIPINF', '00000.clpi')
    clpi = bytearray(open(clpi_path, 'rb').read())

    clip_info_addr = u32be(clpi, 0x08)
    end_time_off   = clip_info_addr + 22
    old_end        = u32be(clpi, end_time_off)
    pres_start     = u32be(clpi, clip_info_addr + 18)
    new_end        = pres_start + 5 * 45000

    print(f"\nCLPI fix:")
    print(f"  clip_info_addr = 0x{clip_info_addr:X}")
    print(f"  pres_start     = 0x{pres_start:08X}")
    print(f"  old pres_end   = 0x{old_end:08X} ({(old_end - pres_start)/45000:.3f}s)")
    print(f"  new pres_end   = 0x{new_end:08X} ({(new_end - pres_start)/45000:.3f}s)")

    w32be(clpi, end_time_off, new_end)
    open(clpi_path, 'wb').write(clpi)
    print(f"  Patched {clpi_path}")

    # Also patch BACKUP clpi if it exists
    backup_clpi = os.path.join(bdmv_dst, 'BACKUP', '00000.clpi')
    if os.path.exists(backup_clpi):
        shutil.copy2(clpi_path, backup_clpi)
        print(f"  Patched {backup_clpi}")

    # Verify MPLS timing too
    mpls_path = os.path.join(bdmv_dst, 'PLAYLIST', '00000.mpls')
    mpls = open(mpls_path, 'rb').read()
    mpls_in  = u32be(mpls, 0x52)
    mpls_out = u32be(mpls, 0x56)
    print(f"\nMPLS timing: in=0x{mpls_in:08X} out=0x{mpls_out:08X} ({(mpls_out-mpls_in)/45000:.3f}s)")

    # Package into new ISO
    if os.path.exists(OUT_ISO):
        os.remove(OUT_ISO)

    print(f"\nPackaging {OUT_ISO}...")
    r = subprocess.run([XORRISO, '-as', 'mkisofs', '-udf', '-udfver', '2.50',
                       '-V', 'TESTFIX', '-o', OUT_ISO, work],
                      capture_output=True)
    if r.returncode != 0:
        # Try xorriso native mode
        r2 = subprocess.run([XORRISO, '-outdev', f'stdio:{OUT_ISO}',
                            '-map', work, '/', '-commit'],
                           capture_output=True)
        if r2.returncode != 0:
            print(f"FAIL: xorriso error: {r.stderr.decode()[-300:]}")
            return

    print(f"ISO created: {OUT_ISO} ({os.path.getsize(OUT_ISO)//1024//1024} MB)")
    shutil.rmtree(work)

    # Mount and test with VLC
    print("\nMounting TESTFIX.iso...")
    mp_fix = '/tmp/testfix_mount'
    os.makedirs(mp_fix, exist_ok=True)
    r = subprocess.run([HDIUTIL, 'attach', OUT_ISO, '-mountpoint', mp_fix, '-readonly'],
                      capture_output=True)
    if r.returncode != 0:
        print(f"FAIL: cannot mount {OUT_ISO}: {r.stderr.decode()}")
        return

    log_path = os.path.expanduser('~/Desktop/vlc_testfix.log')
    print(f"Running VLC (BD debug) → {log_path}")

    with open(log_path, 'w') as lf:
        vlc_proc = subprocess.Popen(
            [VLC, '-vvv', '--no-video', '--intf', 'dummy', '--play-and-exit',
             f'bluray://{mp_fix}/'],
            stdout=lf, stderr=subprocess.STDOUT,
            env={**os.environ, 'BD_DEBUG_MASK': '0xffff'}
        )
        time.sleep(15)
        vlc_proc.terminate()

    subprocess.run([HDIUTIL, 'detach', mp_fix, '-force'], capture_output=True)

    # Parse the log
    print("\n--- VLC log analysis ---")
    with open(log_path) as f:
        log = f.read()

    lines = [l for l in log.splitlines() if any(k in l for k in
        ['PLAY_PL', 'End of title', 'reached end', 'PlayMark', 'PlayList', 'PSR8'])]

    for l in lines[:30]:
        print(f"  {l.strip()[-120:]}")

    if 'PLAY_PL(4): 0' in log and 'PLAY_PL(4): 1' in log:
        # Check timing between PL0 end and PL1 start
        play_pl0_idx = log.index('PLAY_PL(4): 0')
        rest = log[play_pl0_idx:]
        if 'PLAY_PL(4): 1' in rest:
            gap_text = rest[:rest.index('PLAY_PL(4): 1')]
            if 'End of title' in gap_text:
                # How much of the log between PL0 and PL1?
                # Look at PlayMark timestamps
                print("\n  → PLAY_PL(0) reached and transitioned to PLAY_PL(1)")
            else:
                print("\n  → PLAY_PL(0) ran then PLAY_PL(1)")

    if 'PLAY_PL(4): 2' in log:
        print("  → PLAY_PL(2) also reached (Ep2 plays)")
        print("\n=== OVERALL: SUCCESS — splash + ep1 + ep2 all played ===")
    elif 'PLAY_PL(4): 1' in log:
        print("\n=== PARTIAL SUCCESS — splash + ep1 played (ep2 unknown) ===")
    else:
        print("\n=== FAIL — did not reach ep1 ===")

if __name__ == '__main__':
    main()
