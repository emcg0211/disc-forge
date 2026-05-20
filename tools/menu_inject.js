'use strict';
/**
 * menu_inject.js — standalone CLI wrapper around addMenuToDisc.
 * Usage: node menu_inject.js <bdFolder> <numEpisodes> [ffmpegPath] [tsmuxerPath]
 * Exits 0 on success, 1 on failure.
 *
 * Two-clip preload strategy (v1.10.3):
 *   00098.mpls → 1s preload clip (no IG, no still)   — initializes VLC vout before menu fires
 *   00099.mpls → 5s menu clip  (with IG, still_mode=2) — GC fires with vout ready → buttons visible
 *   MovieObject obj[2]: PLAY_PL(98) → PLAY_PL(99) → JUMP_OBJECT(2)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const bdFolder    = process.argv[2];
const numEpisodes = parseInt(process.argv[3], 10);
const ffmpegPath  = process.argv[4] || '/opt/homebrew/bin/ffmpeg';
const tsmuxerPath = process.argv[5] || '/opt/homebrew/bin/tsMuxeR';

if (!bdFolder || !numEpisodes) {
  console.error('Usage: node menu_inject.js <bdFolder> <numEpisodes> [ffmpegPath] [tsmuxerPath]');
  process.exit(1);
}

const {
  patchClpiForIG, patchMplsForIG, patchMplsClipName, patchMplsForStill,
  buildMenuDisplaySet, injectIGIntoM2ts, extractFirstVideoPTS,
} = require(path.join(__dirname, '../src/lib/menu-builder'));

function runTsMuxer(h264Path, outBdmv) {
  const metaPath = h264Path + '.meta';
  fs.writeFileSync(metaPath,
    `MUXOPT --no-pcr-on-video-pid --new-audio-pes --blu-ray\n` +
    `V_MPEG4/ISO/AVC, "${h264Path}", level=4.1, insertSEI, contSPS, lang=und, fps=24\n`
  );
  const r = spawnSync(tsmuxerPath, [metaPath, outBdmv], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`tsMuxeR failed: ${r.stderr.toString().slice(-300)}`);
  const streamDir = path.join(outBdmv, 'BDMV', 'STREAM');
  const produced  = fs.readdirSync(streamDir).filter(f => f.endsWith('.m2ts')).sort();
  if (produced.length === 0) throw new Error(`tsMuxeR produced no m2ts in ${outBdmv}`);
  const base = produced[0].replace('.m2ts', '');
  return {
    m2ts: path.join(streamDir, `${base}.m2ts`),
    clpi: path.join(outBdmv, 'BDMV', 'CLIPINF', `${base}.clpi`),
    mpls: path.join(outBdmv, 'BDMV', 'PLAYLIST', `${base}.mpls`),
  };
}

async function addMenu() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menu_inject_'));

  // ── Step 1: Generate preload clip (1s, no IG) ────────────────────────────
  // This clip plays FIRST in MovieObject so VLC initializes its vout before
  // the menu clip (00099) fires the IG overlay callbacks.
  const preH264 = path.join(workDir, 'pre_bg.h264');
  console.log('[MenuInject] Generating 1s preload video...');
  const ffPre = spawnSync(ffmpegPath, [
    '-y', '-f', 'lavfi',
    '-i', 'color=c=0x1a1a2e:size=1920x1080:rate=24',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast', '-crf', '28',
    preH264,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (ffPre.status !== 0) throw new Error(`ffmpeg preload bg failed: ${ffPre.stderr.toString().slice(-300)}`);

  // ── Step 2: Generate menu clip (5s, will receive IG injection) ───────────
  const menuH264 = path.join(workDir, 'menu_bg.h264');
  console.log('[MenuInject] Generating 5s menu background video...');
  const ffMenu = spawnSync(ffmpegPath, [
    '-y', '-f', 'lavfi',
    '-i', 'color=c=0x1a1a2e:size=1920x1080:rate=24',
    '-t', '5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast', '-crf', '28',
    menuH264,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (ffMenu.status !== 0) throw new Error(`ffmpeg menu bg failed: ${ffMenu.stderr.toString().slice(-300)}`);

  // ── Step 3: tsMuxeR for both clips ───────────────────────────────────────
  const preBdmv  = path.join(workDir, 'pre_bdmv');
  const menuBdmv = path.join(workDir, 'menu_bdmv');
  fs.mkdirSync(preBdmv,  { recursive: true });
  fs.mkdirSync(menuBdmv, { recursive: true });

  console.log('[MenuInject] Running tsMuxeR for preload clip...');
  const prePaths  = runTsMuxer(preH264,  preBdmv);

  console.log('[MenuInject] Running tsMuxeR for menu clip...');
  const menuPaths = runTsMuxer(menuH264, menuBdmv);

  // ── Step 4: Patch preload MPLS (clip rename only, NO IG, NO still) ───────
  const rawPreMpls     = fs.readFileSync(prePaths.mpls);
  const renamedPreMpls = patchMplsClipName(rawPreMpls, '00098');

  // ── Step 5: Patch menu MPLS and CLPI (IG + infinite still) ───────────────
  const rawMenuMpls     = fs.readFileSync(menuPaths.mpls);
  const renamedMenuMpls = patchMplsClipName(rawMenuMpls, '00099');
  const igMpls          = patchMplsForStill(patchMplsForIG(renamedMenuMpls));

  const rawClpi = fs.readFileSync(menuPaths.clpi);
  const igClpi  = patchClpiForIG(rawClpi);
  if (!igClpi) throw new Error('patchClpiForIG failed — unexpected CLPI structure');

  // ── Step 6: Build IG display set and inject into menu m2ts ───────────────
  const playlists = Array.from({ length: numEpisodes }, (_, i) => i + 1);
  const labels    = playlists.map((_, i) => `Play Episode ${i + 1}`);

  const videoM2ts = fs.readFileSync(menuPaths.m2ts);
  const videoPts  = extractFirstVideoPTS(videoM2ts);
  // Fire IG immediately when 00099 starts — vout is already initialized from preload.
  console.log(`[MenuInject] Video PTS: ${videoPts}`);

  const igTs    = buildMenuDisplaySet({ playlists, pts: videoPts, labels, ffmpegPath });
  const menuM2ts = injectIGIntoM2ts(videoM2ts, igTs);
  console.log(`[MenuInject] IG injected: ${igTs.length} bytes TS → m2ts ${menuM2ts.length} bytes`);

  // ── Step 7: Install 00098.* (preload) and 00099.* (menu) ─────────────────
  const destStream   = path.join(bdFolder, 'BDMV', 'STREAM');
  const destClipinf  = path.join(bdFolder, 'BDMV', 'CLIPINF');
  const destPlaylist = path.join(bdFolder, 'BDMV', 'PLAYLIST');

  fs.writeFileSync(path.join(destStream,   '00098.m2ts'), fs.readFileSync(prePaths.m2ts));
  fs.writeFileSync(path.join(destClipinf,  '00098.clpi'), fs.readFileSync(prePaths.clpi));
  fs.writeFileSync(path.join(destPlaylist, '00098.mpls'), renamedPreMpls);
  console.log('[MenuInject] Installed preload 00098.m2ts / 00098.clpi / 00098.mpls');

  fs.writeFileSync(path.join(destStream,   '00099.m2ts'), menuM2ts);
  fs.writeFileSync(path.join(destClipinf,  '00099.clpi'), igClpi);
  fs.writeFileSync(path.join(destPlaylist, '00099.mpls'), igMpls);
  console.log('[MenuInject] Installed menu 00099.m2ts / 00099.clpi / 00099.mpls');

  // ── Step 8: Patch MovieObject obj[2] → PLAY_PL(98) → PLAY_PL(99) → JUMP_OBJECT(2)
  const mobjPath = path.join(bdFolder, 'BDMV', 'MovieObject.bdmv');
  const mobjBuf  = Buffer.from(fs.readFileSync(mobjPath));

  const NUM_OBJS_OFF = 48;
  const numObjs = mobjBuf.readUInt16BE(NUM_OBJS_OFF);

  let mobjPos = NUM_OBJS_OFF + 2;
  let obj2Pos = -1;
  for (let i = 0; i < numObjs; i++) {
    const numCmds = mobjBuf.readUInt16BE(mobjPos + 2);
    if (i === 2) obj2Pos = mobjPos;
    mobjPos += 4 + numCmds * 12;
  }

  if (obj2Pos === -1) {
    console.warn('[MenuInject] WARNING: MovieObject obj[2] not found — menu will not boot correctly');
    return;
  }

  const numCmds2   = mobjBuf.readUInt16BE(obj2Pos + 2);
  const lastCmdOff = obj2Pos + 4 + (numCmds2 - 1) * 12;
  const lastOpcode = mobjBuf.readUInt32BE(lastCmdOff);

  if (lastOpcode !== 0x22800000) {
    console.warn(`[MenuInject] WARNING: obj[2] last cmd opcode 0x${lastOpcode.toString(16)} is not PLAY_PL — skipping patch`);
    return;
  }

  // Change existing PLAY_PL cmd to PLAY_PL(98) (preload)
  mobjBuf.writeUInt32BE(98, lastCmdOff + 4);

  // Build PLAY_PL(99) (menu)
  const menuPlayCmd = Buffer.allocUnsafe(12);
  menuPlayCmd.writeUInt32BE(0x22800000, 0);
  menuPlayCmd.writeUInt32BE(99,          4);
  menuPlayCmd.writeUInt32BE(0,           8);

  // Build JUMP_OBJECT(2) (safety loop)
  const loopCmd = Buffer.allocUnsafe(12);
  loopCmd.writeUInt32BE(0x21800000, 0);
  loopCmd.writeUInt32BE(2,          4);
  loopCmd.writeUInt32BE(0,          8);

  const mobjInsertAt = lastCmdOff + 12;
  const newMobjBuf   = Buffer.concat([
    mobjBuf.slice(0, mobjInsertAt),
    menuPlayCmd,
    loopCmd,
    mobjBuf.slice(mobjInsertAt),
  ]);

  newMobjBuf.writeUInt16BE(numCmds2 + 2, obj2Pos + 2);
  const prevMobjLen = mobjBuf.readUInt32BE(40);
  newMobjBuf.writeUInt32BE(prevMobjLen + 24, 40);

  fs.writeFileSync(mobjPath, newMobjBuf);
  console.log(`[MenuInject] MovieObject obj[2]: PLAY_PL(98)→PLAY_PL(99)→JUMP_OBJECT(2) (${numCmds2}→${numCmds2+2} cmds)`);

  fs.rmSync(workDir, { recursive: true, force: true });
  console.log('[MenuInject] Done.');
}

addMenu().then(() => process.exit(0)).catch(err => {
  console.error(`[MenuInject] FATAL: ${err.message}`);
  process.exit(1);
});
