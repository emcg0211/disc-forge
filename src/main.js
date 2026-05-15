const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;

// ── Tool detection ────────────────────────────────────────────────────────────
// When running as a packaged .app, the shell PATH is minimal.
// We search all common Homebrew, MacPorts, and app bundle locations.

function findTool(names) {
  const extraEnvPath = '/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/usr/local/sbin';

  // 0. Check bundled binaries first (inside the .app bundle Resources/bin/)
  const bundledBinDirs = [
    path.join(process.resourcesPath || '', 'bin'),
    path.join(__dirname, '..', 'bin'),
    path.join(__dirname, '..', '..', 'bin'),
    path.join(app.getAppPath(), '..', 'bin'),
  ];
  for (const binDir of bundledBinDirs) {
    for (const name of names) {
      try {
        const bundled = path.join(binDir, name);
        if (fs.existsSync(bundled)) {
          fs.chmodSync(bundled, '755');
          return bundled;
        }
      } catch (_) {}
    }
  }

  // 1. Try shell which with augmented PATH
  for (const name of names) {
    try {
      const r = execSync(`which ${name} 2>/dev/null`, {
        env: { ...process.env, PATH: extraEnvPath + ':' + (process.env.PATH || '') }
      }).toString().trim();
      if (r && fs.existsSync(r)) return r;
    } catch (_) {}
  }

  // 2. Hardcoded search dirs (Homebrew Intel/ARM, MacPorts, app bundles)
  const searchDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/homebrew/sbin',
    '/usr/local/sbin',
    '/usr/bin',
    os.homedir() + '/bin',
    os.homedir() + '/.local/bin',
    '/opt/local/bin',
    '/Applications/tsMuxeR.app/Contents/MacOS',
    '/Applications/tsMuxerNG.app/Contents/MacOS',
    os.homedir() + '/Applications/tsMuxeR.app/Contents/MacOS',
    os.homedir() + '/Applications/tsMuxerNG.app/Contents/MacOS',
    '/Applications/MakeMKV.app/Contents/MacOS',
    os.homedir() + '/Applications/MakeMKV.app/Contents/MacOS',
  ];
  for (const dir of searchDirs) {
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch (_) {}
    }
  }

  // 3. Homebrew Cellar versioned dirs
  const cellarBases = ['/opt/homebrew/Cellar', '/usr/local/Cellar'];
  for (const base of cellarBases) {
    for (const name of names) {
      try {
        const pkgDir = path.join(base, name.replace(/con$/, '').toLowerCase());
        if (fs.existsSync(pkgDir)) {
          const versions = fs.readdirSync(pkgDir).sort().reverse();
          for (const ver of versions) {
            const bin = path.join(pkgDir, ver, 'bin', name);
            if (fs.existsSync(bin)) return bin;
          }
        }
      } catch (_) {}
    }
  }

  return null;
}

const TOOLS = {
  ffmpeg:   findTool(['ffmpeg']),
  ffprobe:  findTool(['ffprobe']),
  tsmuxer:  findTool(['tsMuxeR', 'tsmuxer', 'tsMuxerNG', 'tsMuxeR-ng']),
  mkvmerge: findTool(['mkvmerge']),
  makemkv:  findTool(['makemkvcon', 'MakeMKV']),
  hdiutil:   '/usr/bin/hdiutil',
  xorriso:   findTool(['/opt/homebrew/bin/xorriso', 'xorriso']),
  mkisofs:   findTool(['/opt/homebrew/bin/mkisofs', 'mkisofs']),
};

// Friendly install instructions per tool
const TOOL_INSTALL = {
  ffmpeg:   'Install via Homebrew: brew install ffmpeg',
  ffprobe:  'Install via Homebrew: brew install ffmpeg (includes ffprobe)',
  tsmuxer:  'Download from github.com/justdan96/tsMuxeR or brew install --cask tsmuxer',
  mkvmerge: 'Install via Homebrew: brew install mkvtoolnix',
  xorriso:  'Install via Homebrew: brew install xorriso',
};

// ── ISO tool auto-detection ───────────────────────────────────────────────────
// Tested once at startup. packageISO() uses this — no per-build detection.
let bestIsoMethod = null; // 'xorriso-udf250' | 'xorriso-native' | null (xorriso unavailable)

async function probeIsoMethod() {
  const { execFile } = require('child_process');
  const tmpDir = path.join(os.tmpdir(), `discforge_isocheck_${Date.now()}`);
  try { fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'test'); } catch(_) {}
  const tmpIso = path.join(os.tmpdir(), `discforge_isocheck_${Date.now()}.iso`);
  const rmTmp = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
    try { if (fs.existsSync(tmpIso)) fs.unlinkSync(tmpIso); } catch(_) {}
  };

  if (TOOLS.xorriso) {
    const ok = await new Promise(resolve => {
      execFile(TOOLS.xorriso, ['-as', 'mkisofs', '-udf', '-udfver', '2.50', '-V', 'TEST', '-o', tmpIso, tmpDir],
        { timeout: 20000, maxBuffer: 1024 * 1024 }, err => resolve(!err));
    });
    rmTmp();
    if (ok) {
      bestIsoMethod = 'xorriso-udf250';
      console.log('[ISO] xorriso UDF 2.50: SUPPORTED');
    } else {
      // UDF 2.50 failed — try xorriso native mode as fallback
      const tmpDir2 = path.join(os.tmpdir(), `discforge_isocheck2_${Date.now()}`);
      const tmpIso2 = path.join(os.tmpdir(), `discforge_isocheck2_${Date.now()}.iso`);
      try { fs.mkdirSync(tmpDir2, { recursive: true }); fs.writeFileSync(path.join(tmpDir2, 'test.txt'), 'test'); } catch(_) {}
      const okNative = await new Promise(resolve => {
        execFile(TOOLS.xorriso, ['-outdev', `stdio:${tmpIso2}`, '-map', tmpDir2, '/', '-commit'],
          { timeout: 20000 }, err => resolve(!err));
      });
      try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch(_) {}
      try { if (fs.existsSync(tmpIso2)) fs.unlinkSync(tmpIso2); } catch(_) {}
      if (okNative) {
        bestIsoMethod = 'xorriso-native';
        console.log('[ISO] xorriso native: SUPPORTED');
      } else {
        bestIsoMethod = null;
        console.log('[ISO] xorriso UDF 2.50: NOT AVAILABLE — install with: brew install xorriso');
      }
    }
  } else {
    rmTmp();
    bestIsoMethod = null;
    console.log('[ISO] xorriso UDF 2.50: NOT AVAILABLE — install with: brew install xorriso');
  }
}

const dumpHex = (buf) => buf.toString('hex').match(/.{1,32}/g).join('\n');

function fpsToTsMuxer(fps) {
  if (fps == null || fps === '') return '';
  let num;
  if (typeof fps === 'string' && fps.includes('/')) {
    const parts = fps.split('/').map(Number);
    if (!parts[1] || isNaN(parts[0])) return '';
    num = parts[0] / parts[1];
  } else {
    num = Number(fps);
    if (isNaN(num)) return '';
  }
  if (Math.abs(num - 23.976) < 0.05) return '23.976';
  if (Math.abs(num - 24)     < 0.05) return '24';
  if (Math.abs(num - 25)     < 0.05) return '25';
  if (Math.abs(num - 29.97)  < 0.05) return '29.970';
  if (Math.abs(num - 30)     < 0.05) return '30';
  if (Math.abs(num - 50)     < 0.05) return '50';
  if (Math.abs(num - 59.94)  < 0.05) return '59.940';
  if (Math.abs(num - 60)     < 0.05) return '60';
  return num.toFixed(3);
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 1020,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#080810',
    show: false,   // prevent white flash on launch
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Show only once DOM is ready (no white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  createWindow();
  probeIsoMethod(); // non-blocking — result stored in bestIsoMethod
  // Sanity-check dumpHex with a known buffer
  const testBuf = Buffer.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    0x31, 0x46, 0x21, 0x81,
  ]);
  const expected = '00112233445566778899aabbccddeeff\n31462181';
  const actual = dumpHex(testBuf);
  if (actual === expected) {
    sendLog('[startup] dumpHex sanity: PASS');
  } else {
    sendLog(`[startup] dumpHex sanity: FAIL — expected:\n${expected}\ngot:\n${actual}`);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: window controls ─────────────────────────────────────────────────────

ipcMain.on('window-close',   () => mainWindow && mainWindow.close());
ipcMain.on('window-minimize',() => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize',() => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()));

// ── IPC: tools ────────────────────────────────────────────────────────────────

ipcMain.handle('get-home-dir', async () => os.homedir());

// Grant local font access permission
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'local-fonts') {
      callback(true);
    } else {
      callback(true);
    }
  });
});

ipcMain.handle('check-tools', async () => ({
  ffmpeg:   { found: !!TOOLS.ffmpeg,    path: TOOLS.ffmpeg,   install: TOOL_INSTALL.ffmpeg   },
  ffprobe:  { found: !!TOOLS.ffprobe,   path: TOOLS.ffprobe,  install: TOOL_INSTALL.ffprobe  },
  tsmuxer:  { found: !!TOOLS.tsmuxer,   path: TOOLS.tsmuxer,  install: TOOL_INSTALL.tsmuxer  },
  mkvmerge: { found: !!TOOLS.mkvmerge,  path: TOOLS.mkvmerge, install: TOOL_INSTALL.mkvmerge },
  xorriso:  { found: !!TOOLS.xorriso,   path: TOOLS.xorriso,  install: TOOL_INSTALL.xorriso  },
  makemkv:  { found: !!TOOLS.makemkv,   path: TOOLS.makemkv  },
}));

// ── IPC: dialogs ──────────────────────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async (_, opts) => {
  const props = (opts && opts.multiselect) ? ['openFile','multiSelections'] : ['openFile'];
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: props,
    filters: (opts && opts.filters) || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const toObj = fp => {
    try { return { path: fp, name: path.basename(fp), size: fs.statSync(fp).size }; }
    catch(_) { return { path: fp, name: path.basename(fp), size: 0 }; }
  };
  if (opts && opts.multiselect) return r.filePaths.map(toObj);
  return toObj(r.filePaths[0]);
});


ipcMain.handle('open-files-dialog', async (_, opts) => {
  const { execSync } = require('child_process');
  const scriptPath = path.join(os.tmpdir(), 'discforge_pick.scpt');
  const script = [
    'set fileList to {}',
    'set chosen to choose file with prompt "Select video files" with multiple selections allowed',
    'repeat with f in chosen',
    'set end of fileList to POSIX path of f',
    'end repeat',
    'set AppleScript\'s text item delimiters to "|"',
    'return fileList as text'
  ].join('\n');
  try {
    fs.writeFileSync(scriptPath, script);
    const result = execSync('osascript ' + JSON.stringify(scriptPath), { encoding: 'utf8' }).trim();
    if (!result) return [];
    return result.split('|').filter(Boolean).map(fp => {
      const trimmed = fp.trim();
      try { return { path: trimmed, name: path.basename(trimmed), size: fs.statSync(trimmed).size }; }
      catch(_) { return { path: trimmed, name: path.basename(trimmed), size: 0 }; }
    });
  } catch(e) {
    // User cancelled - return empty
    return [];
  }
});

// ── Burn ISO to disc ──────────────────────────────────────────────────────────

ipcMain.handle('detect-drive', async () => {
  const { execSync } = require('child_process');
  try {
    const out = execSync('drutil status', { encoding: 'utf8', timeout: 10000 });
    const hasDisc = out.includes('Type:') || out.includes('Disc:');
    const isDVD   = out.includes('DVD') || out.includes('BD');
    const isBD    = out.includes('BD') || out.includes('Blu-ray');
    const lines   = out.trim().split('\n').map(l => l.trim()).filter(Boolean);
    return { found: hasDisc, raw: out, lines, isBD, isDVD };
  } catch(e) {
    return { found: false, raw: e.message, lines: [], isBD: false, isDVD: false };
  }
});

// ── IPC: detect optical drives (for burn UI) ──────────────────────────────────

ipcMain.handle('detect-drives', async () => {
  const { execSync } = require('child_process');
  const drives = [];

  // system_profiler gives drive model/capability info
  try {
    const spOut = execSync('system_profiler SPDiscBurningDataType -json 2>/dev/null', {
      encoding: 'utf8', timeout: 12000
    });
    const data = JSON.parse(spOut);
    const burners = data.SPDiscBurningDataType || [];
    burners.forEach((b, i) => {
      const writeKeys = Object.keys(b).filter(k => k.includes('write'));
      drives.push({
        index: i,
        name: b._name || `Optical Drive ${i + 1}`,
        model: b.spdisc_burner_model || b._name || '',
        isBDCapable: writeKeys.some(k => k.toLowerCase().includes('bd')),
      });
    });
  } catch (_) {}

  // drutil status for disc presence
  let discStatus = { hasDisc: false, isBlank: false, isBD: false, raw: '' };
  try {
    const drOut = execSync('drutil status 2>/dev/null', { encoding: 'utf8', timeout: 8000 });
    discStatus = {
      raw: drOut,
      hasDisc: drOut.includes('Type:') || drOut.includes('Disc:'),
      isBlank: drOut.toLowerCase().includes('blank'),
      isBD: drOut.includes('BD') || drOut.toLowerCase().includes('blu-ray'),
    };
  } catch (e) {
    discStatus.raw = e.message;
  }

  // Find optical device node via diskutil
  let deviceNode = null;
  try {
    const diskOut = execSync('diskutil list 2>/dev/null', { encoding: 'utf8', timeout: 8000 });
    const lines = diskOut.split('\n');
    for (const line of lines) {
      if (/optical|cd[- ]rom|dvd|bd[- ]/i.test(line)) {
        const m = line.match(/\/dev\/disk(\d+)/);
        if (m) { deviceNode = `/dev/rdisk${m[1]}`; break; }
      }
    }
    // Fallback: any external disk not named 'Synthesized'
    if (!deviceNode && discStatus.hasDisc) {
      const out2 = execSync('drutil status -drive 1 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const dm = out2.match(/\/dev\/disk(\d+)/);
      if (dm) deviceNode = `/dev/rdisk${dm[1]}`;
    }
  } catch (_) {}

  return { drives, discStatus, deviceNode };
});

// ── IPC: detect BD source properties (resolution, codec, bitrate) ─────────────

ipcMain.handle('detect-bd-compatibility', async (_, filePath) => {
  if (!TOOLS.ffprobe || !filePath) return { compatible: false, mode: 'transcode' };
  if (!fs.existsSync(filePath)) return { compatible: false, mode: 'transcode', reason: 'File not found' };
  return new Promise(resolve => {
    const proc = spawn(TOOLS.ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      if (code !== 0) return resolve({ compatible: false, mode: 'transcode' });
      try {
        const data = JSON.parse(out);
        const streams = data.streams || [];
        const vStream = streams.find(s => s.codec_type === 'video');
        const aStreams = streams.filter(s => s.codec_type === 'audio');
        const BD_VIDEO = new Set(['h264', 'vc1', 'mpeg2video']);
        const BD_AUDIO = new Set(['ac3', 'eac3', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'dca', 'mlp']);
        const ext = path.extname(filePath).toLowerCase();
        const containerOk = ['.mkv', '.m2ts', '.ts'].includes(ext);
        const videoOk = !!(vStream && BD_VIDEO.has(vStream.codec_name));
        const bitrateMbps = parseInt(data.format?.bit_rate || 0) / 1e6;
        const bitrateOk = bitrateMbps < 40 || bitrateMbps === 0;
        const audioOk = aStreams.length === 0 || aStreams.every(s => BD_AUDIO.has(s.codec_name));
        const videoWidth  = vStream?.width  || 0;
        const videoHeight = vStream?.height || 0;
        const resolutionOk = !videoWidth || !videoHeight ||
          _BD_RES.some(([w,h]) => w===videoWidth && h===videoHeight);
        const compatible = !!(containerOk && videoOk && bitrateOk && audioOk && resolutionOk);
        const reasons = [];
        if (!videoOk) reasons.push('Video codec needs transcoding');
        if (!bitrateOk) reasons.push(`Bitrate ${bitrateMbps.toFixed(1)} Mbps exceeds BD limit (40 Mbps)`);
        if (!audioOk) reasons.push('Audio codec needs transcoding (e.g. FLAC)');
        if (!containerOk) reasons.push(`Container ${ext} not BD-native`);
        if (!resolutionOk) reasons.push(`Resolution ${videoWidth}×${videoHeight} needs BD correction`);
        resolve({
          compatible,
          mode: 'transcode',
          videoCodec: vStream?.codec_name || '',
          bitrateMbps: bitrateMbps.toFixed(1),
          width: videoWidth,
          height: videoHeight,
          resolutionCompliant: resolutionOk,
          reasons,
        });
      } catch (e) {
        resolve({ compatible: false, mode: 'transcode', reason: e.message });
      }
    });
    proc.on('error', () => resolve({ compatible: false, mode: 'transcode' }));
  });
});

// ── IPC: generate chapter thumbnail ──────────────────────────────────────────

ipcMain.handle('generate-chapter-thumbnail', async (_, filePath, timecode, outputPath) => {
  if (!TOOLS.ffmpeg) return { error: 'ffmpeg not found' };
  if (!filePath || !fs.existsSync(filePath)) return { error: 'Source file not found' };
  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch (_) {}
  return new Promise(resolve => {
    const proc = spawn(TOOLS.ffmpeg, [
      '-y', '-ss', timecode, '-i', filePath,
      '-vframes', '1', '-q:v', '2',
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      outputPath,
    ]);
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, path: outputPath });
      } else {
        resolve({ error: `ffmpeg exit ${code}` });
      }
    });
    proc.on('error', err => resolve({ error: err.message }));
  });
});

ipcMain.handle('burn-iso', async (_, isoPath) => {
  return new Promise((resolve) => {
    if (!fs.existsSync(isoPath)) {
      return resolve({ error: `ISO file not found: ${isoPath}` });
    }

    sendLog(`Starting burn: ${isoPath}`);
    mainWindow.webContents.send('burn-progress', { status: 'starting', message: 'Preparing to burn...', percent: 0 });

    const proc = spawn('/usr/bin/hdiutil', ['burn', isoPath]);
    let stdout = '', stderr = '';
    let dotCount = 0;

    const handleLine = (line, isErr) => {
      sendLog((isErr ? 'burn err: ' : 'burn: ') + line);
      if (/Writing track/i.test(line)) {
        mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent: null });
      } else if (/Burn completed successfully/i.test(line)) {
        // handled in close
      } else {
        const dots = (line.match(/\./g) || []).length;
        if (dots > 0) {
          dotCount += dots;
          const percent = Math.min(99, Math.round((dotCount / 200) * 100));
          mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent });
        } else {
          mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent: null });
        }
      }
    };

    proc.stdout.on('data', d => {
      const text = d.toString();
      stdout += text;
      text.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => handleLine(l, false));
    });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      text.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => handleLine(l, true));
    });

    proc.on('close', code => {
      const combined = stdout + stderr;
      if (code === 0 || /Burn completed successfully/i.test(combined)) {
        sendLog('✓ Burn complete');
        mainWindow.webContents.send('burn-progress', { status: 'done', message: 'Burn complete! Disc ejected.', percent: 100 });
        resolve({ success: true });
      } else {
        const msg = stderr.trim() || stdout.trim() || `hdiutil burn exited with code ${code}`;
        sendLog('Burn failed: ' + msg);
        mainWindow.webContents.send('burn-progress', { status: 'error', message: msg });
        resolve({ error: msg });
      }
    });
    proc.on('error', err => resolve({ error: 'hdiutil error: ' + err.message }));
  });
});


ipcMain.handle('save-project-file', async (_, json) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Disc Forge Project',
    defaultPath: 'disc-project.dfp',
    filters: [{ name: 'Disc Forge Project', extensions: ['dfp'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, json, 'utf8');
  return r.filePath;
});

ipcMain.handle('load-project-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Disc Forge Project',
    filters: [{ name: 'Disc Forge Project', extensions: ['dfp'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

ipcMain.handle('open-folder-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory','createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('reveal-in-finder', async (_, filePath) => shell.showItemInFolder(filePath));

// ── IPC: probe ────────────────────────────────────────────────────────────────

ipcMain.handle('probe-file', async (_, filePath) => {
  if (!TOOLS.ffprobe) return { error: 'ffprobe not found' };
  return new Promise(resolve => {
    const proc = spawn(TOOLS.ffprobe, ['-v','quiet','-print_format','json','-show_format','-show_streams', filePath]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', code => {
      if (code === 0) {
        try { resolve({ success: true, data: JSON.parse(out) }); }
        catch { resolve({ error: 'parse error' }); }
      } else resolve({ error: `ffprobe exit ${code}` });
    });
  });
});

// ── IPC: build ────────────────────────────────────────────────────────────────

ipcMain.handle('build-disc', async (_, project) => {
  project.forceSafeBluRayOutput = true;
  project.passThroughMode = false;
  project.forceTranscode = true;
  if (!TOOLS.ffmpeg) return { error: 'FFmpeg not found.\n\nInstall with:\n  brew install ffmpeg' };

  // ── Pre-build diagnostic logging (permanent — do not remove) ─────────────────
  const _diag = project._diagEmbedded || [];
  sendLog(`[BUILD DIAG] renderer embeddedTracks: ${_diag.length}`);
  _diag.forEach((t, i) => sendLog(`[BUILD DIAG] embedded[${i}]: role="${t.role}" included=${t.included} src="${t.sourceFile}"`));
  sendLog(`[BUILD DIAG] audioTracks received: ${(project.audioTracks||[]).length}`);
  (project.audioTracks||[]).forEach((t, i) => sendLog(`[BUILD DIAG] audio[${i}]: file="${t.file?.path}" trackIdx=${t.trackIndex ?? t.streamIndex} embedded=${t.embedded||false}`));
  delete project._diagEmbedded;

  // Defensive defaults — guard against malformed or partially-loaded projects
  project.audioTracks    = project.audioTracks    || [];
  project.subtitleTracks = project.subtitleTracks || [];
  project.chapters       = project.chapters       || [];
  project.extras         = project.extras         || [];
  project.titles         = project.titles         || [];

  if (project.forceSafeBluRayOutput) {
    sendLog('Blu-ray safe: skipping menu/extras/additional titles');
    project.extras = [];
    project.titles = [];
  }

  // ── Source video probing: map to a valid BD-Video format via selectHwResAndFps ──
  if (project.mainVideo?.path) {
    const srcCodec = getVideoCodec(project.mainVideo.path);
    const srcRes   = detectResolution(project.mainVideo.path);
    const srcFps   = parseFloat(getVideoFps(project.mainVideo.path));
    const vfrInfo  = detectVfr(project.mainVideo.path);

    // Always map source FPS to one of the three valid BD-Video formats
    const bdTarget = selectHwResAndFps(srcFps, srcRes.h);
    project._safeOutputW      = bdTarget.w;
    project._safeOutputH      = bdTarget.h;
    project._safeOutputFpsNum = bdTarget.fps;
    project._safeOutputFps    = getBdFpsFraction(bdTarget.fps);

    project._srcVideoCodec = srcCodec;
    project._srcRes        = srcRes;
    project._srcFps        = srcFps;
    project._srcVfr        = vfrInfo.isVfr;

    sendLog(`Source: ${srcCodec} ${srcRes.w}×${srcRes.h} @ ${srcFps.toFixed(3)} fps${vfrInfo.isVfr ? ' (VFR)' : ''}`);
    sendLog(`BD target: ${bdTarget.resolution} @ ${project._safeOutputFps} fps — libx264 Blu-ray-safe`);
    if (vfrInfo.isVfr) sendLog('Variable frame rate detected — will convert to CFR');

    // tsMuxeR meta always declares the output codec; H.264 for all re-encodes
    project.videoFormat = 'H.264 AVC';
  }

  const homeDir   = os.homedir();
  const rawOutput = project.outputDir || '';
  const outputDir = (rawOutput && rawOutput !== '/Users/user/Desktop' && fs.existsSync(path.dirname(rawOutput)))
    ? rawOutput
    : path.join(homeDir, 'Desktop');

  const discName = sanitize(project.title || 'disc');
  // Use output directory for temp files to avoid filling system drive
  const tempBase = fs.existsSync(outputDir) ? outputDir : os.tmpdir();
  const workDir  = path.join(tempBase, `discforge_${Date.now()}`);
  const tsDir    = path.join(workDir, 'ts');
  const bdFolder = path.join(workDir, 'BDMV_ROOT');

  sendLog(`workDir:   ${workDir}`);
  sendLog(`bdFolder:  ${bdFolder}`);
  sendLog(`outputDir: ${outputDir}`);
  sendLog(`discName:  ${discName}`);

  // Disk space check — warn if less than 2x video file size is available
  if (project.mainVideo?.path) {
    try {
      const { execSync } = require('child_process');
      const videoSize = fs.statSync(project.mainVideo.path).size;
      const dfOut = execSync(`df -k "${outputDir}" 2>/dev/null || df -k "${homeDir}"`).toString();
      const dfLine = dfOut.trim().split('\n').pop();
      const availKb = parseInt(dfLine.trim().split(/\s+/)[3]) || 0;
      const availBytes = availKb * 1024;
      const neededBytes = videoSize * 2.5;
      if (availBytes < neededBytes) {
        const availGb = (availBytes/1e9).toFixed(1);
        const neededGb = (neededBytes/1e9).toFixed(1);
        return { error: `Not enough disk space.\n\nAvailable: ${availGb} GB\nEstimated needed: ${neededGb} GB\n\nFree up space on your drive and try again.` };
      }
    } catch(_) {}
  }

  try {
    fs.mkdirSync(tsDir,    { recursive: true });
    fs.mkdirSync(bdFolder, { recursive: true });
    fs.mkdirSync(outputDir,{ recursive: true });
  } catch(e) {
    return { error: `Cannot create working directories:\n${e.message}` };
  }

  progress(0, 'Preparing workspace');

  const isoPath = path.join(outputDir, `${discName}.iso`);

  const steps = [
    { label: 'Muxing main feature audio tracks',  fn: () => muxMainFeature(project, workDir, tsDir),
      outputFile: () => path.join(tsDir, 'main.ts') },
    { label: 'Validating mux output',             fn: () => validateMuxOutput(tsDir) },
    { label: 'Preparing main feature',            fn: () => prepareMainFeature(workDir, tsDir),
      outputFile: () => path.join(workDir, 'main_bd.mkv') },
    { label: 'Building Blu-ray disc structure',   fn: () => buildBDStructure(project, workDir, tsDir, bdFolder) },
    ...(project.extras.length > 0
      ? [{ label: 'Processing special features', fn: () => muxExtras(project, workDir, tsDir) }]
      : []),
    { label: 'Writing tsMuxeR project file',      fn: () => writeTsMuxerMeta(project, workDir, tsDir, bdFolder) },
    { label: 'Running tsMuxeR / building BDMV',   fn: () => runTsMuxer(workDir, bdFolder),
      outputFile: () => path.join(bdFolder, 'BDMV', 'STREAM', '00001.m2ts') },
    { label: 'Patching playlist and navigation', fn: () => {
      const _path = require('path'), _fs = require('fs');
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'STREAM'),   { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'BACKUP'),   { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'CLIPINF'),  { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'PLAYLIST'), { recursive: true });
      patchMainTitlePlaylist(bdFolder, project.forceSafeBluRayOutput);
      return Promise.resolve();
    } },
    ...(project.forceSafeBluRayOutput ? [{
      label: 'Pre-burn validation',
      fn: () => validateHwBuild(project, workDir, bdFolder),
    }] : []),
    { label: 'Packaging ISO image', fn: async () => {
      const _path = require('path'), _fs = require('fs');
      const bdmvContents = _fs.readdirSync(_path.join(bdFolder,'BDMV')).join(', ');
      sendLog('BDMV contents: ' + bdmvContents);
      const isoResult = await packageISO(bdFolder, outputDir, discName);
      project._isoUsedUdf250 = isoResult && isoResult.usedUdf250;
    }, outputFile: () => isoPath },
  ];

  for (let i = 0; i < steps.length; i++) {
    progress(i, steps[i].label);
    try {
      await steps[i].fn();
    } catch (err) {
      const errMsg = `"${steps[i].label}" failed:\n\n${err.message}`;
      sendLog('BUILD ERROR: ' + errMsg);
      cleanup(workDir);
      return { error: errMsg };
    }
    // Report output file size for this step if available
    if (steps[i].outputFile) {
      try {
        const outFile = steps[i].outputFile();
        if (outFile && fs.existsSync(outFile)) {
          progress(i, steps[i].label, fmtBytes(fs.statSync(outFile).size));
        }
      } catch(_) {}
    }
  }

  cleanup(workDir);
  sendLog('────────────────────────────────────────');
  sendLog('Build complete.');
  sendLog('Disc structure validated.');
  sendLog('Video: libx264 Blu-ray-safe.');
  sendLog('Audio: AC3 640k.');
  sendLog('ISO: UDF 2.50 via xorriso.');
  sendLog('Recommended: burn to BD-RE first for testing.');
  sendLog('────────────────────────────────────────');
  const isoSize = fs.existsSync(isoPath) ? fs.statSync(isoPath).size : 0;
  mainWindow.webContents.send('build-progress', { done: true, isoPath, isoSize });
  return { success: true, isoPath };
});

// ── Step 1: FFmpeg — mux main feature to MPEG-TS ──────────────────────────────
//
// Supports two input modes:
//   A) Traditional: mainVideo is the video file; audioTracks/subtitleTracks are
//      separate files — each gets its own -i input, mapped with :a:0 / :s:0
//   B) MKV Import:  tracks all live inside the same MKV file; we reference them
//      by their stream index (trackIndex) so FFmpeg picks the right one.
//
// We detect mode B when audioTracks share the same file path as mainVideo.

function muxMainFeature(project, workDir, tsDir) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(tsDir, 'main.ts');
    if (!project.mainVideo?.path) return reject(new Error('No main video file specified.'));
    const mainPath = project.mainVideo.path;

    // Dedup audio tracks by sourceFile+streamIndex — belt-and-suspenders against
    // triple-adding when multiple episodes were probed and renderer sent all of them.
    {
      const seen = new Set();
      project.audioTracks = project.audioTracks.filter(t => {
        const key = `${t.file?.path || ''}:${t.trackIndex ?? t.streamIndex ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // ── Group audio tracks: those inside the main MKV vs standalone external files ──
    // Use a denylist (exclude known additional-title paths) instead of an allowlist
    // (require exact match to mainPath). The allowlist silently drops all audio when
    // paths differ due to symlinks or normalization differences on macOS.
    const additionalTitlePaths = new Set((project.titles || []).map(t => t.file?.path).filter(Boolean));
    sendLog(`  muxMainFeature: project.audioTracks.length=${project.audioTracks.length}, mainPath="${mainPath}"`);
    sendLog(`  muxMainFeature: additionalTitlePaths=[${[...additionalTitlePaths].join('|')}]`);
    project.audioTracks.forEach((t, i) => {
      sendLog(`    audioTrack[${i}]: file.path="${t.file?.path}", trackIndex=${t.trackIndex ?? t.streamIndex}, format="${t.format}"`);
    });
    // Embedded tracks: have a stream index AND are not from an additional-title file.
    const audioFromMkv  = project.audioTracks.filter(t =>
      (t.trackIndex ?? t.streamIndex) != null &&
      !(t.file?.path && additionalTitlePaths.has(t.file.path))
    );
    // Standalone external audio: no stream index — added as a separate FFmpeg input.
    const audioExternal = project.audioTracks.filter(t => (t.trackIndex ?? t.streamIndex) == null);
    sendLog(`  muxMainFeature: ${project.audioTracks.length} total audio tracks → ${audioFromMkv.length} embedded, ${audioExternal.length} external`);

    // Subtitles are NOT routed through FFmpeg:
    //   - MPEG-TS does not support text subtitle codecs (subrip, ASS) — FFmpeg errors out.
    //   - PGS from MKV is referenced directly from the source file by tsMuxeR.
    // Only video and audio pass through FFmpeg → main.ts.

    const args = ['-y'];

    // ── Input 0: main video (MKV or standalone video file) ──
    args.push('-i', mainPath);

    // ── Inputs 1..N: external audio files ──
    audioExternal.forEach(t => args.push('-i', t.file.path));

    // ── Chapter metadata ──
    let chapInputIndex = -1;
    if (project.chapters.length > 0) {
      const chapFile = buildChapterMetaFile(project, workDir);
      chapInputIndex = 1 + audioExternal.length;
      args.push('-i', chapFile);
    }

    // ── Maps ──

    // Video: always from input 0. If MKV import, use the detected video stream index.
    const videoStreamIdx = (project.mainVideo.trackIndex != null) ? project.mainVideo.trackIndex : null;
    args.push('-map', videoStreamIdx != null ? `0:${videoStreamIdx}` : '0:v:0');

    // Audio from MKV (stream index references into input 0)
    audioFromMkv.forEach(t => args.push('-map', `0:${t.trackIndex ?? t.streamIndex}`));
    // Audio from external files
    audioExternal.forEach((_, i) => args.push('-map', `${i + 1}:a:0`));

    if (chapInputIndex >= 0) {
      args.push('-map_metadata', String(chapInputIndex));
      args.push('-map_chapters', String(chapInputIndex));
    }

    const allAudio = [...audioFromMkv, ...audioExternal];

    // ── Codecs — video: libx264 BD-safe; audio: AC3 640k ─────────────────────────
    // The tsMuxeR meta codec string must exactly match the elementary stream type in
    // the .ts file — a mismatch causes tsMuxeR to silently produce a near-empty output.
    const mainCrfVal = getCrfValue(project.mainVideo?.videoQuality);
    const mainResDims = {
      '1080p (1920×1080)':  [1920, 1080],
      '720p (1280×720)':    [1280, 720],
      '480p (720×480)':     [720,  480],
      '480p (720×576) PAL': [720,  576],
    };
    const [, mainVH] = mainResDims[project.resolution] || [1920, 1080];
    const mainSrcRes = detectResolution(mainPath);
    let mainResCorrTarget = (mainSrcRes.w && mainSrcRes.h) ? getBdCompliantResolution(mainSrcRes.w, mainSrcRes.h) : null;

    let effectiveMainVH = mainResCorrTarget ? mainResCorrTarget.h : mainVH;
    let mainResVfStr = mainResCorrTarget
      ? (mainResCorrTarget.padOnly
          ? `pad=${mainResCorrTarget.w}:${mainResCorrTarget.h}:(${mainResCorrTarget.w}-${mainSrcRes.w})/2:(${mainResCorrTarget.h}-${mainSrcRes.h})/2`
          : `scale=${mainResCorrTarget.w}:${mainResCorrTarget.h}`)
      : null;

    // ── Video codec selection ──────────────────────────────────────────────────
    // forceSafeBluRayOutput always wins — CRF is a size/quality option within the safe path
    if (project.forceSafeBluRayOutput) {
      const safeH    = project._safeOutputH || (mainResCorrTarget ? mainResCorrTarget.h : (mainSrcRes.h || effectiveMainVH));
      const safeW    = project._safeOutputW || (mainResCorrTarget ? mainResCorrTarget.w : (mainSrcRes.w || 1920));
      const safeFps  = project._safeOutputFps;
      const level    = safeH <= 480 ? '3.1' : safeH <= 720 ? '4.0' : '4.1';
      const maxrateK = safeH <= 720 ? '15000k' : '25000k';
      const bufsizeK = safeH <= 720 ? '20000k' : '30000k';
      const gopSize  = Math.round(project._safeOutputFpsNum || project._srcFps || 24);
      const is1080p  = safeH > 720;
      const qual     = project.mainVideo?.videoQuality;
      if (project.fastEncode) {
        const bitrateK = qual === 'crf18' ? (is1080p ? '20000k' : '12000k')
                       : qual === 'crf23' ? (is1080p ? '10000k' : '6000k')
                       : (is1080p ? '15000k' : '8000k');
        args.push(
          '-c:v', 'h264_videotoolbox',
          '-realtime', '0',
          '-profile:v', 'high',
          '-level', level,
          '-pix_fmt', 'yuv420p',
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-sc_threshold', '0',
          '-bf', '3',
          '-refs', '4',
          '-b:v', bitrateK, '-maxrate', maxrateK, '-bufsize', bufsizeK,
        );
        sendLog(`Video: h264_videotoolbox (experimental fast encode) ${bitrateK} L${level} g=${gopSize}`);
      } else {
        const crfVal = qual === 'crf18' ? '18' : qual === 'crf23' ? '23' : '20';
        args.push(
          '-c:v', 'libx264',
          '-preset', 'slow',
          '-profile:v', 'high',
          '-level', level,
          '-pix_fmt', 'yuv420p',
          '-crf', crfVal,
          '-g', String(gopSize),
          '-keyint_min', String(gopSize),
          '-sc_threshold', '0',
          '-bf', '3',
          '-refs', '4',
          '-maxrate', maxrateK, '-bufsize', bufsizeK,
        );
        sendLog(`Video: libx264 Blu-ray-safe CRF${crfVal} L${level} g=${gopSize}`);
      }
      // Scale + FPS filter: always target the BD-safe output dimensions and FPS
      const safeFilters = [];
      const needsScale = mainSrcRes.w !== safeW || mainSrcRes.h !== safeH;
      if (needsScale) safeFilters.push(`scale=${safeW}:${safeH}:force_original_aspect_ratio=decrease,pad=${safeW}:${safeH}:(ow-iw)/2:(oh-ih)/2`);
      if (safeFps) safeFilters.push(`fps=${safeFps}`);
      if (safeFilters.length > 0) args.push('-vf', safeFilters.join(','));
      if (needsScale) sendLog(`  ${mainSrcRes.w}×${mainSrcRes.h} → ${safeW}×${safeH}`);
      if (safeFps) sendLog(`  fps=${safeFps}`);
      const dur = getVideoDuration(mainPath);
      if (dur > 0) sendLog(`__CRF_START:${Math.round(dur)}`);
    }

    // ── Audio codec selection ──────────────────────────────────────────────────
    allAudio.forEach((track, i) => {
      const fmt   = track.format || '';
      const codec = track.codec  || '';
      args.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, '640k');
      sendLog(`Audio track ${i + 1}: AC3 640k (Blu-ray safe) [was: ${fmt || codec || 'unknown'}]`);
    });
    if (allAudio.length === 0) {
      sendLog('Audio: no audio tracks — continuing without audio');
    }

    // ── Metadata: language tags ──
    allAudio.forEach((t, i) => {
      args.push(`-metadata:s:a:${i}`, `language=${langCode(t.language)}`);
      args.push(`-metadata:s:a:${i}`, `title=${t.label || t.language}`);
    });

    const defIdx = allAudio.findIndex(t => t.isDefault);
    if (defIdx >= 0) args.push(`-disposition:a:${defIdx}`, 'default');

    // ── Output ──
    args.push('-f', 'mpegts', '-mpegts_flags', 'system_b', outFile);

    runFFmpeg(args, resolve, reject);
  });
}

// ── Step 2: Generate menu background PNG via FFmpeg ───────────────────────────

function generateMenuImage(project, workDir) {
  return new Promise((resolve) => {
    sendLog('generateMenuImage called, ffmpeg=' + !!TOOLS.ffmpeg + ' menuConfig=' + JSON.stringify(project.menuConfig?.theme));
    if (!TOOLS.ffmpeg) return resolve();

    const m = project.menuConfig;
    const bgMap = {
      'Cinematic Dark':'0a0a14', 'Elegant White':'f5f3ee', 'Retro Film':'1a0e04',
      'Minimal Type':'f0eeea',  'Sci-Fi Grid':'030a18',  'Organic Nature':'0e1a0a',
    };
    const bg = bgMap[m.theme] || '0a0a14';
    // Escape characters special to FFmpeg's libavfilter drawtext parser.
    // Order matters: backslash must be escaped first.
    const title = (m.title || project.title || 'Main Menu')
      .replace(/\\/g, '\\\\')
      .replace(/'/g,  "\\'")
      .replace(/:/g,  '\\:')
      .replace(/,/g,  '\\,')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/;/g,  '\\;');
    const fg  = m.primaryColor.replace('#','');
    const acc = m.accentColor.replace('#','');

    const menuPng = path.join(workDir, 'menu_bg.png');

    // If user provided a background image, use that instead of generated one
    if (m.backgroundImage && fs.existsSync(m.backgroundImage.path)) {
      // Resize to 1920x1080 and add title overlay
      const proc = spawn(TOOLS.ffmpeg, [
        '-y', '-i', m.backgroundImage.path,
        '-vf', [
          'scale=1920:1080:force_original_aspect_ratio=decrease',
          'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
          `drawtext=text='${title}':fontsize=72:fontcolor=#${fg}:x=(w-text_w)/2:y=200:shadowcolor=black:shadowx=2:shadowy=2`,
        ].join(','),
        '-frames:v', '1', menuPng,
      ]);
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
      return;
    }

    // Pure FFmpeg lavfi generated background
    const proc = spawn(TOOLS.ffmpeg, [
      '-y', '-f', 'lavfi',
      '-i', `color=c=#${bg}:size=1920x1080:rate=1`,
      '-vf', [
        // Gradient overlay
        `drawbox=x=0:y=0:w=iw:h=ih:color=#000000@0.3:t=fill`,
        // Title
        `drawtext=text='${title}':fontsize=80:fontcolor=#${fg}:x=(w-text_w)/2:y=(h/2)-60:font=serif:shadowcolor=black:shadowx=3:shadowy=3`,
      ].join(','),
      '-frames:v', '1', menuPng,
    ]);
    proc.on('close', (code) => { sendLog('generateMenuImage: FFmpeg exit code=' + code + ' png=' + require('fs').existsSync(menuPng)); resolve(); });
    proc.on('error', (err) => { sendLog('generateMenuImage: FFmpeg error=' + err.message); resolve(); });
  });
}

// ── Step 3: Scaffold full BDMV folder structure ───────────────────────────────
//   tsMuxeR will overwrite the binary files; we just need the folders + correct
//   initial files. tsMuxeR generates valid index.bdmv / MovieObject.bdmv itself.

function buildBDStructure(project, workDir, tsDir, bdFolder) {
  const dirs = [
    'BDMV/BACKUP',
    'BDMV/CERTIFICATE',
    'BDMV/META/DL',
    'BDMV/STREAM',
    'BDMV/CLIPINF',
    'BDMV/PLAYLIST',
    'BDMV/AUXDATA',
    'BDMV/BDJO',
    'BDMV/JAR',
    'CERTIFICATE/BACKUP',
  ];
  dirs.forEach(d => fs.mkdirSync(path.join(bdFolder, d), { recursive: true }));

  // disc.inf — human-readable metadata (not used by players, useful for archival)
  fs.writeFileSync(path.join(bdFolder, 'disc.inf'), [
    `[DiscInformation]`,
    `DiscName=${project.title || 'Disc'}`,
    `DiscLabel=${sanitize(project.discLabel || project.title || 'DISC').toUpperCase()}`,
    `Resolution=${project.resolution}`,
    `VideoFormat=${project.videoFormat}`,
    `AudioTracks=${project.audioTracks.length}`,
    `SubtitleTracks=${project.subtitleTracks.length}`,
    `Chapters=${project.chapters.length}`,
    `Extras=${project.extras.length}`,
    `Description=${project.description || ''}`,
    `CreatedWith=Disc Forge 1.0`,
    `CreatedAt=${new Date().toISOString()}`,
  ].join('\n'));

  // Copy menu background if it was generated
  const menuPng = path.join(workDir, 'menu_bg.png');
  if (fs.existsSync(menuPng)) {
    fs.copyFileSync(menuPng, path.join(bdFolder, 'BDMV', 'AUXDATA', 'menu_bg.png'));
  }

  return Promise.resolve();
}

// ── Step 4: Mux extras ────────────────────────────────────────────────────────

function muxExtras(project, workDir, tsDir) {
  return Promise.all(project.extras.map((extra, i) =>
    new Promise((resolve, reject) => {
      const outFile = path.join(tsDir, `extra_${String(i+1).padStart(2,'0')}.ts`);
      // Map only video + audio — MPEG-TS cannot carry text subtitle codecs (subrip/ASS)
      runFFmpeg(['-y','-i', extra.file.path, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', outFile], resolve, reject);
    })
  ));
}

// ── Additional titles: 3-step pipeline ───────────────────────────────────────
//
// Attempt 1: tsMuxeR direct from source MKV (works for non-FLAC sources).
//
// If tsMuxeR fails (e.g. FLAC/LPCM audio causes buffer overflow), use the
// 3-step FFmpeg pipeline:
//   Step 1: FFmpeg — transcode FLAC→AC3, copy video → title_NNNNN.ts
//   Step 2: FFmpeg — extract each subtitle stream to a standalone .ass or .sup
//   Step 3: tsMuxeR — mux .ts (video+audio) + standalone subtitle files
//
// This avoids the buffer-overflow that occurs when tsMuxeR tries to demux a
// FLAC-containing MKV, AND avoids the "Processed 0 video frames" that occurs
// when tsMuxeR reads subtitles directly from a FLAC MKV while the video comes
// from an FFmpeg-produced .ts.
//
// Last resort: if Step 3 also fails, copy the .ts as .m2ts (no subtitles).


function readClpiEndTime(clpiPath) {
  try {
    const buf = fs.readFileSync(clpiPath);
    if (buf.length < 32) return null;
    // Header offset 8: SequenceInfoStartAddress (4 bytes, big-endian)
    const seqOff = buf.readUInt32BE(8);
    // SequenceInfo layout at seqOff:
    //   +0  length (4)
    //   +4  reserved (1)
    //   +5  num_atc_sequences (1)
    //   +6  ATCSeq[0].spn_atc_start (4)
    //   +10 ATCSeq[0].num_stc_sequences (1)
    //   +11 ATCSeq[0].offset_stc_id (1)
    //   +12 ATCSeq[0].reserved (2)
    //   +14 STCSeq[0].pcr_pid (2)
    //   +16 STCSeq[0].spn_stc_start (4)
    //   +20 STCSeq[0].presentation_start_time (4)
    //   +24 STCSeq[0].presentation_end_time (4)
    if (seqOff + 26 > buf.length) return null;
    const endTime = buf.readUInt32BE(seqOff + 22);
    if (endTime === 0 || endTime > 0x20000000) return null;
    return endTime;
  } catch (e) {
    sendLog(`readClpiEndTime: ${e.message}`);
    return null;
  }
}

// After processAdditionalTitle completes for all extra titles, register them
// in the disc navigation so hardware players can access them.
//
// tsMuxeR produces MovieObject.bdmv with 3 objects for a single-title disc:
//   obj[0]: first-play setup — chains to obj[2]
//   obj[1]: chapter/menu handler — plays playlist 1 (tsMuxeR internal use)
//   obj[2]: main player — PlayPL(0) plays playlist 00000.mpls
//
// Additional titles use playlists 00002.mpls, 00003.mpls, ... (titleIdx values).
// For each additional title N, we:
//   1. Clone obj[2] and change its PlayPL target to N → new obj[3+i]
//   2. Add a TitleSearchTable entry in index.bdmv pointing to the new object
//
// PlayPL opcode: 0x21810000 (w0), playlist-index (w1), 0 (w2) — verified empirically.
// TitleInfo entry: 0x40 (HDMV movie), 0x00, ref_high, ref_low — 4 bytes, big-endian.
// Index.bdmv: tsMuxeR pre-allocates 28 bytes (7 slots) after NumberOfTitles=0,
//   so up to 7 additional titles fit without extending the file.
function fixMultiTitleNavigation(bdFolder, numAdditionalTitles) {
  if (numAdditionalTitles === 0) return;

  const mobjPath  = path.join(bdFolder, 'BDMV', 'MovieObject.bdmv');
  const indexPath = path.join(bdFolder, 'BDMV', 'index.bdmv');
  const backDir   = path.join(bdFolder, 'BDMV', 'BACKUP');

  if (!fs.existsSync(mobjPath) || !fs.existsSync(indexPath)) {
    sendLog('fixMultiTitleNavigation: navigation files not found — skipping');
    return;
  }

  // ── 1. MovieObject.bdmv: add PlayPL(N) objects for each additional title ──
  const mobjBuf = Buffer.from(fs.readFileSync(mobjPath));

  // MovieObjects struct at offset 40: Length(4) + reserved(4) + num_objs(2) + objects
  const MOBJ_STRUCT_OFF = 40;
  const NUM_OBJS_OFF    = 48;

  const mobjLength = mobjBuf.readUInt32BE(MOBJ_STRUCT_OFF);
  const numObjs    = mobjBuf.readUInt16BE(NUM_OBJS_OFF);

  // Find MovieObject[2]: the main player (5 cmds, last = PlayPL(0))
  let pos = NUM_OBJS_OFF + 2;
  let templateObjBytes = null;
  for (let i = 0; i < numObjs; i++) {
    const numCmds = mobjBuf.readUInt16BE(pos + 2);
    const objSize = 4 + numCmds * 12;
    if (i === 2) templateObjBytes = mobjBuf.slice(pos, pos + objSize);
    pos += objSize;
  }

  if (!templateObjBytes) {
    sendLog(`fixMultiTitleNavigation: expected ≥3 movie objects, found ${numObjs} — skipping`);
    return;
  }

  const tmplNumCmds = templateObjBytes.readUInt16BE(2);
  const lastCmdOff  = 4 + (tmplNumCmds - 1) * 12;
  const playPlW0    = templateObjBytes.readUInt32BE(lastCmdOff);
  const playPlW1    = templateObjBytes.readUInt32BE(lastCmdOff + 4);

  if (playPlW0 !== 0x21810000 || playPlW1 !== 0) {
    sendLog(`fixMultiTitleNavigation: template obj[2] last cmd unexpected (w0=0x${playPlW0.toString(16)} w1=${playPlW1}) — skipping`);
    return;
  }

  const newObjBufs = [];
  for (let i = 0; i < numAdditionalTitles; i++) {
    const playlistId = i + 2;  // additional titles use playlists 2, 3, 4, …
    const newObj = Buffer.from(templateObjBytes);
    newObj.writeUInt32BE(playlistId, lastCmdOff + 4);
    newObjBufs.push(newObj);
    sendLog(`  fixMultiTitleNavigation: obj[${numObjs + i}] → PlayPL(${playlistId})`);
  }

  const totalNewObjBytes = newObjBufs.reduce((s, b) => s + b.length, 0);
  const newMobjBuf = Buffer.concat([mobjBuf, ...newObjBufs]);
  newMobjBuf.writeUInt32BE(mobjLength + totalNewObjBytes, MOBJ_STRUCT_OFF);
  newMobjBuf.writeUInt16BE(numObjs + numAdditionalTitles, NUM_OBJS_OFF);

  fs.writeFileSync(mobjPath, newMobjBuf);
  sendLog(`  fixMultiTitleNavigation: MovieObject.bdmv ${numObjs}→${numObjs + numAdditionalTitles} objects, ${mobjBuf.length}→${newMobjBuf.length} bytes`);

  // ── 2. index.bdmv: register titles in TitleSearchTable ──────────────────
  // Indexes struct at IndexesStartAddress:
  //   +0:  Length (4)
  //   +4:  FirstPlayback (4)
  //   +8:  TopMenu (4)
  //   +12: reserved (?) — empirically: NumberOfTitles starts at DATA_START+8
  //   The layout verified: FirstPlayback(4)+TopMenu(4)+NumTitles(2)+entries(4 each)
  //   28 pre-allocated bytes after NumTitles = up to 7 slots before file extension needed
  const idxBuf       = Buffer.from(fs.readFileSync(indexPath));
  const idxStart     = idxBuf.readUInt32BE(8);  // IndexesStartAddress
  const idxLen       = idxBuf.readUInt32BE(idxStart);
  const idxDataStart = idxStart + 4;

  const NUM_TITLES_OFF = idxDataStart + 8;   // NumberOfTitles field offset
  const TITLES_OFF     = idxDataStart + 10;  // title entries begin here

  const curNumTitles = idxBuf.readUInt16BE(NUM_TITLES_OFF);
  const newNumTitles = curNumTitles + numAdditionalTitles;

  // Build new 4-byte title entries: HDMV(0x40) | reserved(0x00) | movieObjRef(2 bytes BE)
  const newEntries = Buffer.alloc(numAdditionalTitles * 4);
  for (let i = 0; i < numAdditionalTitles; i++) {
    const movieObjIdx = numObjs + i;  // new objects are at indices 3, 4, …
    newEntries[i * 4 + 0] = 0x40;
    newEntries[i * 4 + 1] = 0x00;
    newEntries.writeUInt16BE(movieObjIdx, i * 4 + 2);
    sendLog(`  fixMultiTitleNavigation: Title[${curNumTitles + i}] → MovieObject[${movieObjIdx}]`);
  }

  const remainingSlots = Math.floor((idxLen - 10 - curNumTitles * 4) / 4);
  let newIdxBuf;
  if (numAdditionalTitles <= remainingSlots) {
    newIdxBuf = Buffer.from(idxBuf);
    newIdxBuf.writeUInt16BE(newNumTitles, NUM_TITLES_OFF);
    newEntries.copy(newIdxBuf, TITLES_OFF + curNumTitles * 4);
  } else {
    const extraBytes = (numAdditionalTitles - remainingSlots) * 4;
    newIdxBuf = Buffer.concat([idxBuf, Buffer.alloc(extraBytes)]);
    newIdxBuf.writeUInt32BE(idxLen + extraBytes, idxStart);
    newIdxBuf.writeUInt16BE(newNumTitles, NUM_TITLES_OFF);
    newEntries.copy(newIdxBuf, TITLES_OFF + curNumTitles * 4);
    sendLog(`  fixMultiTitleNavigation: extended index.bdmv by ${extraBytes} bytes`);
  }

  fs.writeFileSync(indexPath, newIdxBuf);
  sendLog(`  fixMultiTitleNavigation: index.bdmv NumberOfTitles ${curNumTitles}→${newNumTitles}, ${idxBuf.length}→${newIdxBuf.length} bytes`);

  // Sync BACKUP copies
  if (fs.existsSync(backDir)) {
    fs.copyFileSync(mobjPath,  path.join(backDir, 'MovieObject.bdmv'));
    fs.copyFileSync(indexPath, path.join(backDir, 'index.bdmv'));
    sendLog('  fixMultiTitleNavigation: BACKUP copies updated');
  }
}

// When tsMuxeR runs with --custom-menu-bg it creates:
//   STREAM/00000.m2ts — menu stub loop
//   STREAM/00001.m2ts — main feature
//   PLAYLIST/00000.mpls — clip reference points to 00000 instead of 00001
// Patch the MPLS in place; leave index.bdmv and MovieObject.bdmv untouched.
function patchMainTitlePlaylist(bdFolder, hardwareMode = false) {
  if (hardwareMode) {
    sendLog('patchMainTitlePlaylist: skipped — Blu-ray-safe mode (tsMuxeR BDMV used as-is, no binary patching)');
    return;
  }
  const bdmvDir  = path.join(bdFolder, 'BDMV');
  const stream01 = path.join(bdmvDir, 'STREAM', '00001.m2ts');

  if (!fs.existsSync(stream01)) {
    sendLog('patchMainTitlePlaylist: no 00001.m2ts — menu not present, skipping');
    return;
  }

  const playDir = path.join(bdmvDir, 'PLAYLIST');
  const clipDir = path.join(bdmvDir, 'CLIPINF');
  const backDir = path.join(bdmvDir, 'BACKUP');
  const mplsPath = path.join(playDir, '00000.mpls');

  if (!fs.existsSync(mplsPath)) {
    sendLog('patchMainTitlePlaylist: no 00000.mpls — movie-only mode (no menu stub), skipping patch');
    return;
  }

  // Binary patch: change clip reference from "00000" to "00001" in tsMuxeR's MPLS.
  const needle      = Buffer.from('00000M2TS', 'ascii');
  const replacement = Buffer.from('00001M2TS', 'ascii');
  const mpls = fs.readFileSync(mplsPath);
  const idx  = mpls.indexOf(needle);
  if (idx !== -1) {
    replacement.copy(mpls, idx);
    fs.writeFileSync(mplsPath, mpls);
    if (fs.existsSync(backDir)) {
      fs.mkdirSync(path.join(backDir, 'PLAYLIST'), { recursive: true });
      fs.writeFileSync(path.join(backDir, 'PLAYLIST', '00000.mpls'), mpls);
    }
    sendLog('patchMainTitlePlaylist: patched 00000.mpls clip ref 00000\u219200001');
  } else {
    sendLog('patchMainTitlePlaylist: 00000.mpls already references 00001 — no patch needed');
  }

  // 00001.clpi must exist \u2014 written by tsMuxeR's single pass when a menu is present.
  const clpi01 = path.join(clipDir, '00001.clpi');
  if (!fs.existsSync(clpi01)) {
    const clpi00 = path.join(clipDir, '00000.clpi');
    if (fs.existsSync(clpi00)) {
      throw new Error('patchMainTitlePlaylist: CLIPINF/00001.clpi not found but 00000.clpi exists \u2014 tsMuxeR did not produce a separate main-feature clip; check menu configuration');
    }
    throw new Error('patchMainTitlePlaylist: CLIPINF/00001.clpi not found \u2014 tsMuxeR must have failed');
  }
  sendLog('patchMainTitlePlaylist: 00001.clpi verified (tsMuxeR-generated)');
}

function processAdditionalTitle(project, workDir, tsDir, bdFolder, title, titleIdx) {
  if (!project._experimentalMultiTitle) {
    sendLog('Additional title processing skipped (multi-title is experimental)');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const pad      = n => String(n).padStart(5, '0');
    const filePath = title.file?.path;

    if (!filePath || !fs.existsSync(filePath)) {
      return reject(new Error(`Title ${titleIdx}: source file not found: ${filePath || '(no path provided)'}`));
    }

    // Tracks belonging to this specific source file
    const audioTracks = (project.audioTracks || []).filter(
      t => t.file && t.file.path === filePath && (t.trackIndex ?? t.streamIndex) != null
    );
    const subtitleTracks = (project.subtitleTracks || []).filter(
      s => s.file && s.file.path === filePath && (s.trackIndex ?? s.streamIndex) != null
    );

    const fileSizeMB = (() => { try { return (fs.statSync(filePath).size / 1e6).toFixed(0); } catch(_) { return '?'; } })();
    sendLog(`\n── Title ${titleIdx} ──────────────────────────────────────────`);
    sendLog(`  source : ${filePath} (${fileSizeMB} MB)`);
    sendLog(`  audio  : ${audioTracks.length} track(s) — ${audioTracks.map(t => t.format || 'unknown').join(', ') || 'none (auto-detect)'}`);
    sendLog(`  subs   : ${subtitleTracks.length} track(s)`);

    // ── BDMV directories ─────────────────────────────────────────────────────
    const streamDir = path.join(bdFolder, 'BDMV', 'STREAM');
    const clipDir   = path.join(bdFolder, 'BDMV', 'CLIPINF');
    const playDir   = path.join(bdFolder, 'BDMV', 'PLAYLIST');
    const backDir   = path.join(bdFolder, 'BDMV', 'BACKUP');
    [streamDir, clipDir, playDir, backDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

    const validateM2ts = (m2tsPath) => {
      const size = fs.existsSync(m2tsPath) ? fs.statSync(m2tsPath).size : 0;
      if (size < 10_000_000) {
        reject(new Error(
          `Title ${titleIdx}: output .m2ts is too small (${(size/1e6).toFixed(1)} MB).\n` +
          `Expected > 10 MB for real BD content.\n\n` +
          `Check tsMuxeR log lines above for the actual error.`
        ));
      } else {
        sendLog(`  ✓ Title ${titleIdx} output validated: ${path.basename(m2tsPath)} (${(size/1e6).toFixed(1)} MB)`);
        resolve();
      }
    };

    const patchClipId = (srcPath, destPath) => {
      let buf = fs.readFileSync(srcPath);
      const magic = buf.slice(0, 4).toString('ascii');
      // CLPI files are identified by filename only — the internal data contains binary codec
      // parameters, not ASCII clip references. Just copy without patching.
      if (magic !== 'MPLS') { fs.writeFileSync(destPath, buf); return; }
      // MPLS contains "00000M2TS" or "00001M2TS" — replace whichever clip ID is present.
      // tsMuxeR 2.6.16-dev uses 00000.* for all additional-title temp builds (no menu).
      const srcId = buf.indexOf(Buffer.from('00001', 'ascii')) !== -1 ? '00001' : '00000';
      const from = Buffer.from(srcId, 'ascii');
      const to   = Buffer.from(pad(titleIdx), 'ascii');
      let i = 0;
      while ((i = buf.indexOf(from, i)) !== -1) { to.copy(buf, i); i += from.length; }
      fs.writeFileSync(destPath, buf);
    };

    const mergeFromTempBd = (tempBdFolder) => {
      const tempBdmv = path.join(tempBdFolder, 'BDMV');
      const findFirst = (subdir, ext) => {
        for (const n of ['00001', '00000']) {
          const p = path.join(tempBdmv, subdir, `${n}.${ext}`);
          if (fs.existsSync(p)) return p;
        }
        return null;
      };
      const logDir = (sub) => {
        const d = path.join(tempBdmv, sub);
        if (!fs.existsSync(d)) return `  ${sub}/: (missing)`;
        const files = fs.readdirSync(d).map(f => {
          const kb = (fs.statSync(path.join(d, f)).size / 1024).toFixed(0);
          return `${f}(${kb}KB)`;
        });
        return `  ${sub}/: ${files.join('  ') || '(empty)'}`;
      };
      sendLog(`  tsMuxeR output for title ${titleIdx}:`);
      sendLog(logDir('STREAM'));
      sendLog(logDir('CLIPINF'));
      sendLog(logDir('PLAYLIST'));

      const destStream = path.join(streamDir, `${pad(titleIdx)}.m2ts`);
      const srcStream  = findFirst('STREAM', 'm2ts');
      if (srcStream) {
        fs.copyFileSync(srcStream, destStream);
        sendLog(`  merged: STREAM/${pad(titleIdx)}.m2ts (${(fs.statSync(destStream).size/1e6).toFixed(1)} MB)`);
      } else {
        cleanup(tempBdFolder);
        return reject(new Error(
          `Title ${titleIdx}: tsMuxeR produced no stream.\n` +
          `Check tsMuxeR log lines above for the error.`
        ));
      }

      const srcClip = findFirst('CLIPINF', 'clpi');
      if (srcClip) {
        patchClipId(srcClip, path.join(clipDir, `${pad(titleIdx)}.clpi`));
        patchClipId(srcClip, path.join(backDir, `${pad(titleIdx)}.clpi`));
      } else {
        cleanup(tempBdFolder);
        return reject(new Error(`Title ${titleIdx}: tsMuxeR produced no CLPI file`));
      }

      const srcPlay = findFirst('PLAYLIST', 'mpls');
      if (srcPlay) {
        patchClipId(srcPlay, path.join(playDir, `${pad(titleIdx)}.mpls`));
        patchClipId(srcPlay, path.join(backDir, `${pad(titleIdx)}.mpls`));
      } else {
        cleanup(tempBdFolder);
        return reject(new Error(`Title ${titleIdx}: tsMuxeR produced no MPLS file`));
      }

      cleanup(tempBdFolder);
      validateM2ts(destStream);
    };

    // ── Codec maps ───────────────────────────────────────────────────────────
    const aCodecMap = {
      'DTS-HD Master Audio': 'A_DTS',   // stream-copied as DTS core into .ts
      'DTS 5.1':             'A_DTS',
      'Dolby Digital 5.1':   'A_AC3',
      'Dolby TrueHD':        'A_AC3',   // transcoded to AC3
      'PCM 5.1':             'A_AC3',   // transcoded to AC3
      'PCM 7.1':             'A_AC3',   // transcoded to AC3
      'LPCM Stereo':         'A_AC3',   // transcoded to AC3
      'FLAC':                'A_AC3',   // transcoded to AC3
    };
    const vCodecMap = {
      'H.264 AVC':  'V_MPEG4/ISO/AVC',
      'H.265 HEVC': 'V_MPEGH/ISO/HEVC',
      'VC-1':       'V_MS/VFW/WVC1',
      'MPEG-2':     'V_MPEG-2',
    };
    const fps    = getVideoFps(filePath);
    const titleCrfVal = getCrfValue(title.videoQuality);
    const vCodec = 'V_MPEG4/ISO/AVC';
    const resDims = {
      '1080p (1920×1080)':  [1920, 1080],
      '720p (1280×720)':    [1280, 720],
      '480p (720×480)':     [720,  480],
      '480p (720×576) PAL': [720,  576],
    };
    const srcRes = detectResolution(filePath);
    const resCorrTarget = (srcRes.w && srcRes.h) ? getBdCompliantResolution(srcRes.w, srcRes.h) : null;
    // Use corrected dims for subtitle meta so tsMuxeR renders at output resolution
    const [vW, vH] = resCorrTarget
      ? [resCorrTarget.w, resCorrTarget.h]
      : (resDims[project.resolution] || [1920, 1080]);

    // Stream title tags from the source file, used for tsMuxeR track-name= fields.
    const streamTitles = getStreamTitles(filePath);
    const trackName    = idx => {
      if (idx == null) return '';
      const t = streamTitles[idx];
      return t ? `, track-name="${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
    };

    // ── Shared temp folder for both tsMuxeR attempts ──────────────────────────
    const tempBdFolder = path.join(workDir, `bdmv_title_${pad(titleIdx)}`);

    // ── Attempt 1: tsMuxeR direct from source MKV ────────────────────────────
    // Works for non-FLAC sources. Fails with buffer overflow for FLAC/LPCM.
    // On any failure, falls through to the 3-step FFmpeg pipeline (Attempt 2).

    const runTsMuxerDirectMkv = () => {
      const metaLines = ['MUXOPT --blu-ray --new-audio-pes'];

      metaLines.push(`${vCodec}, "${tsPath(filePath)}", fps=${fpsToTsMuxer(fps)}, insertSEI, contSPS, track=1`);

      if (audioTracks.length > 0) {
        audioTracks.forEach(t => {
          const codec    = aCodecMap[t.format] || 'A_AC3';
          const streamIdx = t.trackIndex ?? t.streamIndex;
          const tsmTrack = streamIdx + 1;
          const name     = trackName(streamIdx);
          metaLines.push(`${codec}, "${tsPath(filePath)}", lang=${langCode(t.language)}, track=${tsmTrack}${name}`);
        });
      } else {
        metaLines.push(`A_AC3, "${tsPath(filePath)}", lang=und, track=2`);
      }

      subtitleTracks.forEach(sub => {
        // S_TEXT/UTF8 silently causes tsMuxeR --blu-ray to produce no output; PGS only.
        if (sub.format !== 'PGS (Blu-ray Native)') return;
        const streamIdx = sub.trackIndex ?? sub.streamIndex;
        const tsmTrack  = streamIdx + 1;
        const lang      = langCode(sub.language);
        const forced    = sub.isForced ? ', forced' : '';
        const name      = trackName(streamIdx);
        metaLines.push(`S_HDMV/PGS, "${tsPath(filePath)}", lang=${lang}, track=${tsmTrack}${forced}${name}`);
      });

      const metaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}.meta`);
      sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
      fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');
      sendLog(`  Attempt 1: tsMuxeR direct from MKV`);
      sendLog(`  meta:\n${metaLines.map(l => '    ' + l).join('\n')}`);

      cleanup(tempBdFolder);
      fs.mkdirSync(tempBdFolder, { recursive: true });
      sendLog(`  tsMuxeR: "${metaFile}" "${tempBdFolder}"`);

      const tsProc = spawn(TOOLS.tsmuxer, [metaFile, tempBdFolder]);
      tsProc.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsProc.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsProc.on('error', err => {
        sendLog(`  Attempt 1 error: ${err.message} — trying FFmpeg pipeline`);
        cleanup(tempBdFolder);
        runFfmpegPipeline();
      });
      tsProc.on('close', code => {
        if (code !== 0) {
          sendLog(`  Attempt 1 failed (exit ${code}) — trying FFmpeg pipeline`);
          cleanup(tempBdFolder);
          return runFfmpegPipeline();
        }
        sendLog(`  Attempt 1 ok — merging`);
        mergeFromTempBd(tempBdFolder);
      });
    };

    // ── Attempt 2: 3-step FFmpeg pipeline ────────────────────────────────────
    // Step 1: FFmpeg → .ts (video copy + audio transcode)
    // Step 2: FFmpeg → extract subtitle streams to .ass / .sup files
    // Step 3: tsMuxeR with .ts (video+audio) + standalone subtitle files
    // Last resort: copy .ts as .m2ts if Step 3 fails (no subtitles).

    const titleTs = path.join(tsDir, `title_${pad(titleIdx)}.ts`);

    const STREAM_COPY_FORMATS = new Set(['DTS-HD Master Audio', 'Dolby Digital 5.1']);

    const runFfmpegPipeline = () => {
      sendLog(`  Attempt 2: FFmpeg pipeline (step 1 → step 2 → step 3)`);

      // ── Step 1: FFmpeg → .ts ─────────────────────────────────────────────
      const ffArgs = ['-y', '-i', filePath];

      const resVfStr = resCorrTarget
        ? (resCorrTarget.padOnly
            ? `pad=${resCorrTarget.w}:${resCorrTarget.h}:(${resCorrTarget.w}-${srcRes.w})/2:(${resCorrTarget.h}-${srcRes.h})/2`
            : `scale=${resCorrTarget.w}:${resCorrTarget.h}`)
        : null;

      const addVideoCodecArgs = (args) => {
        if (titleCrfVal) {
          const h264Level = vH <= 480 ? '3.1' : '4.1';
          const is1080p = vH > 720;
          const qual = title.videoQuality;
          const crfVal = qual === 'crf18' ? '18' : qual === 'crf23' ? '23' : '20';
          const mrK = is1080p ? '25000k' : '15000k';
          const bsK = is1080p ? '30000k' : '20000k';
          args.push('-c:v', 'libx264', '-preset', 'slow',
                    '-profile:v', 'high', '-level', h264Level, '-pix_fmt', 'yuv420p',
                    '-crf', crfVal, '-maxrate', mrK, '-bufsize', bsK);
          if (resVfStr) args.push('-vf', resVfStr);
        } else if (resVfStr) {
          const level = vH <= 480 ? '3.1' : '4.1';
          const is1080p = vH > 720;
          const mrK = is1080p ? '25000k' : '15000k';
          const bsK = is1080p ? '30000k' : '20000k';
          args.push('-c:v', 'libx264', '-preset', 'slow',
                    '-profile:v', 'high', '-level', level, '-pix_fmt', 'yuv420p',
                    '-crf', '20', '-maxrate', mrK, '-bufsize', bsK);
          args.push('-vf', resVfStr);
        } else {
          args.push('-c:v', 'copy');
        }
      };

      if (audioTracks.length > 0) {
        ffArgs.push('-map', '0:v:0');
        audioTracks.forEach(t => ffArgs.push('-map', `0:${t.trackIndex ?? t.streamIndex}`));
        addVideoCodecArgs(ffArgs);
        audioTracks.forEach((t, i) => {
          if (STREAM_COPY_FORMATS.has(t.format)) {
            ffArgs.push(`-c:a:${i}`, 'copy');
          } else {
            ffArgs.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, '640k');
          }
        });
      } else {
        ffArgs.push('-map', '0:v', '-map', '0:a?');
        addVideoCodecArgs(ffArgs);
        ffArgs.push('-c:a', 'ac3', '-b:a', '640k');
      }
      ffArgs.push('-f', 'mpegts', '-mpegts_flags', 'system_b', titleTs);

      if (titleCrfVal) {
        const h264Level = vH <= 480 ? '3.1' : '4.1';
        const qual2 = title.videoQuality;
        const crfLog = qual2 === 'crf18' ? '18' : qual2 === 'crf23' ? '23' : '20';
        sendLog(`  Video: libx264 Blu-ray-safe CRF${crfLog} L${h264Level}`);
        if (resCorrTarget) sendLog(`  Auto-correcting resolution: ${srcRes.w}×${srcRes.h} → ${resCorrTarget.w}×${resCorrTarget.h} (${resCorrTarget.padOnly ? 'padding' : 'scaling'})`);
        const dur = getVideoDuration(filePath);
        if (dur > 0) sendLog(`__CRF_START:${Math.round(dur)}`);
      } else if (resCorrTarget) {
        sendLog(`  Auto-correcting resolution: ${srcRes.w}×${srcRes.h} → ${resCorrTarget.w}×${resCorrTarget.h} (${resCorrTarget.padOnly ? 'padding' : 'scaling'}) — libx264 Blu-ray-safe`);
      }

      sendLog(`  Step 1: FFmpeg → ${path.basename(titleTs)}`);
      sendLog(`  FFmpeg: ${[TOOLS.ffmpeg, ...ffArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

      const ff1 = spawn(TOOLS.ffmpeg, ffArgs);
      let ff1Stderr = '';
      ff1.stderr.on('data', d => { ff1Stderr += d.toString(); });
      ff1.on('error', err => reject(new Error(`Title ${titleIdx}: FFmpeg step 1 error: ${err.message}`)));
      ff1.on('close', code => {
        if (code !== 0 || !fs.existsSync(titleTs)) {
          return reject(new Error(`Title ${titleIdx}: FFmpeg step 1 failed (exit ${code}).\n${ff1Stderr.slice(-2000)}`));
        }
        const tsSizeMB = (fs.statSync(titleTs).size / 1e6).toFixed(1);
        if (parseFloat(tsSizeMB) < 10) {
          return reject(new Error(`Title ${titleIdx}: FFmpeg step 1 output too small (${tsSizeMB} MB).`));
        }
        sendLog(`  ✓ Step 1: ${path.basename(titleTs)} (${tsSizeMB} MB)`);
        if (!TOOLS.tsmuxer) {
          return reject(new Error(`Title ${titleIdx}: tsMuxeR is required for BD-compliant additional titles`));
        }
        runExtractSubs();
      });
    };

    // ── Step 2: Extract subtitle streams to standalone files ─────────────────
    const runExtractSubs = () => {
      if (!subtitleTracks.length) {
        sendLog(`  Step 2: no subtitle tracks — skipping extraction`);
        return runTsMuxerWithTs([]);
      }

      sendLog(`  Step 2: extracting ${subtitleTracks.length} subtitle stream(s) from MKV`);
      const results = [];
      let remaining = subtitleTracks.length;

      subtitleTracks.forEach((sub, i) => {
        const streamIdx = sub.trackIndex ?? sub.streamIndex;
        const isPGS     = sub.format === 'PGS (Blu-ray Native)';
        const subExt    = isPGS ? '.sup' : '.ass';
        const outFile   = path.join(workDir, `sub_${pad(titleIdx)}_${i}${subExt}`);

        const extractArgs = ['-y', '-i', filePath, '-map', `0:${streamIdx}`, '-c:s', 'copy', outFile];
        sendLog(`  extracting stream ${streamIdx} → ${path.basename(outFile)}`);

        const ff2 = spawn(TOOLS.ffmpeg, extractArgs);
        let ff2Stderr = '';
        ff2.stderr.on('data', d => { ff2Stderr += d.toString(); });
        ff2.on('close', code => {
          const exists = fs.existsSync(outFile);
          const size   = exists ? fs.statSync(outFile).size : 0;

          if (code === 0 && exists && size >= 100) {
            if (isPGS) {
              sendLog(`  ✓ sub ${i}: ${path.basename(outFile)} (${(size/1024).toFixed(0)} KB)`);
              results[i] = { ...sub, extractedPath: outFile };
              // fall through to final decrement
            } else {
              // Convert .ass → .srt via pysubs2 so tsMuxeR receives valid SRT
              // (tsMuxeR misreads raw ASS files as SRT and fails with "Invalid SRT format")
              const srtFile = path.join(workDir, `sub_${pad(titleIdx)}_${i}.srt`);
              const pyCmd   = `import pysubs2; subs = pysubs2.load(${JSON.stringify(outFile)}); subs.save(${JSON.stringify(srtFile)})`;
              sendLog(`  converting ${path.basename(outFile)} → SRT via pysubs2`);
              const py = spawn('python3', ['-c', pyCmd]);
              let pyStderr = '';
              py.stderr.on('data', d => { pyStderr += d.toString(); });
              py.on('close', pyCode => {
                if (pyCode === 0 && fs.existsSync(srtFile) && fs.statSync(srtFile).size >= 100) {
                  sendLog(`  ✓ sub ${i}: ${path.basename(srtFile)} (${(fs.statSync(srtFile).size/1024).toFixed(0)} KB, pysubs2 SRT)`);
                  results[i] = { ...sub, extractedPath: srtFile };
                } else {
                  // pysubs2 failed — try FFmpeg subrip as last resort
                  sendLog(`  pysubs2 failed for sub ${i} — trying FFmpeg subrip`);
                  if (pyStderr.trim()) sendLog(`  pysubs2: ${pyStderr.trim().slice(-200)}`);
                  const srtFallback = path.join(workDir, `sub_${pad(titleIdx)}_${i}.srt`);
                  const ffSrtArgs = ['-y', '-i', filePath, '-map', `0:${subtitleTracks[i]?.trackIndex ?? subtitleTracks[i]?.streamIndex}`, '-c:s', 'subrip', srtFallback];
                  const ffSrt = spawn(TOOLS.ffmpeg, ffSrtArgs);
                  let ffSrtErr = '';
                  ffSrt.stderr.on('data', d => { ffSrtErr += d.toString(); });
                  ffSrt.on('close', ffCode => {
                    if (ffCode === 0 && fs.existsSync(srtFallback) && fs.statSync(srtFallback).size >= 100) {
                      sendLog(`  ✓ sub ${i}: FFmpeg subrip fallback succeeded`);
                      results[i] = { ...sub, extractedPath: srtFallback };
                    } else {
                      sendLog(`  Warning: all subtitle conversion methods failed for sub ${i} — skipping`);
                      results[i] = null;
                    }
                    if (--remaining === 0) runTsMuxerWithTs(results.filter(Boolean));
                  });
                  return;
                }
                if (--remaining === 0) runTsMuxerWithTs(results.filter(Boolean));
              });
              return; // decrement happens in pysubs2 callback above
            }
          } else if (!isPGS) {
            // Fallback: try converting to SRT via FFmpeg (handles subrip codec that refuses .ass copy)
            const srtFile  = path.join(workDir, `sub_${pad(titleIdx)}_${i}.srt`);
            const srtArgs  = ['-y', '-i', filePath, '-map', `0:${streamIdx}`, '-c:s', 'subrip', srtFile];
            const ff2b = spawn(TOOLS.ffmpeg, srtArgs);
            let ff2bStderr = '';
            ff2b.stderr.on('data', d => { ff2bStderr += d.toString(); });
            ff2b.on('close', code2 => {
              if (code2 === 0 && fs.existsSync(srtFile) && fs.statSync(srtFile).size >= 100) {
                sendLog(`  ✓ sub ${i}: ${path.basename(srtFile)} (SRT fallback)`);
                results[i] = { ...sub, extractedPath: srtFile };
              } else {
                sendLog(`  Warning: sub ${i} (stream ${streamIdx}) extraction failed — skipping`);
                results[i] = null;
              }
              if (--remaining === 0) runTsMuxerWithTs(results.filter(Boolean));
            });
            return; // don't decrement remaining here
          } else {
            sendLog(`  Warning: sub ${i} (stream ${streamIdx}) extraction failed — skipping`);
            results[i] = null;
          }

          if (--remaining === 0) runTsMuxerWithTs(results.filter(Boolean));
        });
      });
    };

    // ── Steps 5+6: mkvmerge title.ts + .sup files → combined.mkv → tsMuxeR ───────
    // tsMuxeR reads MKV reliably (no video drop). mkvmerge combines the FFmpeg-
    // produced .ts (video+audio) with the extracted PGS .sup files into one MKV
    // that tsMuxeR demuxes cleanly.  tsMuxeR auto-detects streams in MKV order —
    // no track= specifiers needed.
    const runMkvmergeAndTsMuxer = (pgsSubs) => {
      sendLog(`  Step 5: mkvmerge title.ts + ${pgsSubs.length} PGS .sup → combined.mkv`);

      if (!TOOLS.mkvmerge) {
        sendLog(`  mkvmerge not found — falling back: tsMuxeR direct on .ts (may drop video)`);
        return runTsMuxerDirectOnTs(pgsSubs);
      }
      if (!TOOLS.tsmuxer) {
        return reject(new Error(`Title ${titleIdx}: tsMuxeR is required for BD-compliant additional titles`));
      }

      const combinedMkv = path.join(workDir, `combined_title_${pad(titleIdx)}.mkv`);
      // Build mkvmerge args — add --track-name for each .sup if available
      const mkvArgs = ['-o', combinedMkv, titleTs];
      pgsSubs.forEach(s => {
        const name = trackName(s.trackIndex ?? s.streamIndex);
        if (name) {
          // name is already formatted as `, track-name="..."` — extract just the value
          const match = name.match(/track-name="(.+?)"/);
          if (match) { mkvArgs.push('--track-name', `0:${match[1]}`); }
        }
        mkvArgs.push(s.extractedPath);
      });
      sendLog(`  mkvmerge: ${[TOOLS.mkvmerge, ...mkvArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

      const mkvProc = spawn(TOOLS.mkvmerge, mkvArgs);
      mkvProc.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      mkvProc.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      mkvProc.on('error', err => {
        reject(new Error(`Title ${titleIdx}: mkvmerge error: ${err.message}`));
      });
      mkvProc.on('close', code => {
        // mkvmerge exits 1 for warnings (output is still valid), 2+ for hard errors
        if (code >= 2 || !fs.existsSync(combinedMkv)) {
          return reject(new Error(`Title ${titleIdx}: mkvmerge failed (exit ${code})`));
        }
        const mkvSizeMB = (fs.statSync(combinedMkv).size / 1e6).toFixed(1);
        sendLog(`  ✓ Step 5: ${path.basename(combinedMkv)} (${mkvSizeMB} MB)`);

        // ── Step 6: tsMuxeR reads combined.mkv ───────────────────────────────
        // List each stream type in MKV order — no track= needed; tsMuxeR picks
        // streams sequentially (first video, then each audio, then each subtitle).
        const metaLines = ['MUXOPT --blu-ray --new-audio-pes'];
        const mkvRef    = tsPath(combinedMkv);

        // Track numbers in the combined MKV:
        // track 1 = video, tracks 2..N+1 = audio, tracks N+2.. = PGS subtitles
        let trackNum = 1;
        metaLines.push(`${vCodec}, "${mkvRef}", fps=${fpsToTsMuxer(fps)}, insertSEI, contSPS, track=${trackNum++}`);

        if (audioTracks.length > 0) {
          audioTracks.forEach(t => {
            const codec = STREAM_COPY_FORMATS.has(t.format) ? (aCodecMap[t.format] || 'A_AC3') : 'A_AC3';
            const name  = trackName(t.trackIndex ?? t.streamIndex);
            metaLines.push(`${codec}, "${mkvRef}", lang=${langCode(t.language)}, track=${trackNum++}${name}`);
          });
        } else {
          metaLines.push(`A_AC3, "${mkvRef}", lang=und, track=${trackNum++}`);
        }

        pgsSubs.forEach(sub => {
          const lang   = langCode(sub.language);
          const forced = sub.isForced ? ', forced' : '';
          const name   = trackName(sub.trackIndex ?? sub.streamIndex);
          metaLines.push(`S_HDMV/PGS, "${mkvRef}", lang=${lang}, track=${trackNum++}${forced}${name}`);
        });

        const metaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}.meta`);
        sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
        fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');
        sendLog(`  Step 6: tsMuxeR on combined.mkv`);
        sendLog(`  meta:\n${metaLines.map(l => '    ' + l).join('\n')}`);

        cleanup(tempBdFolder);
        fs.mkdirSync(tempBdFolder, { recursive: true });
        sendLog(`  tsMuxeR: "${metaFile}" "${tempBdFolder}"`);

        const tsProcFinal = spawn(TOOLS.tsmuxer, [metaFile, tempBdFolder]);
        tsProcFinal.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
        tsProcFinal.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
        tsProcFinal.on('error', err => {
          cleanup(tempBdFolder);
          reject(new Error(`Title ${titleIdx}: tsMuxeR error: ${err.message}`));
        });
        tsProcFinal.on('close', tsmCode => {
          if (tsmCode !== 0) {
            cleanup(tempBdFolder);
            return reject(new Error(`Title ${titleIdx}: tsMuxeR failed (exit ${tsmCode})`));
          }
          sendLog(`  Step 6 ok — merging`);
          mergeFromTempBd(tempBdFolder);
        });
      });
    };

    // Fallback used when mkvmerge is unavailable: feed .ts + .sup directly to
    // tsMuxeR (video may be dropped — known limitation with FFmpeg-produced .ts).
    const runTsMuxerDirectOnTs = (pgsSubs) => {
      if (!TOOLS.tsmuxer) return reject(new Error(`Title ${titleIdx}: tsMuxeR is required for BD-compliant additional titles`));
      const metaLines = ['MUXOPT --blu-ray --new-audio-pes'];
      metaLines.push(`${vCodec}, "${tsPath(titleTs)}", fps=${fpsToTsMuxer(fps)}, insertSEI, contSPS, track=1`);
      if (audioTracks.length > 0) {
        audioTracks.forEach((t, i) => {
          const codec = STREAM_COPY_FORMATS.has(t.format) ? (aCodecMap[t.format] || 'A_AC3') : 'A_AC3';
          const name  = trackName(t.trackIndex ?? t.streamIndex);
          metaLines.push(`${codec}, "${tsPath(titleTs)}", lang=${langCode(t.language)}, track=${i + 2}${name}`);
        });
      } else {
        metaLines.push(`A_AC3, "${tsPath(titleTs)}", lang=und, track=2`);
      }
      pgsSubs.forEach(sub => {
        const lang   = langCode(sub.language);
        const forced = sub.isForced ? ', forced' : '';
        const name   = trackName(sub.trackIndex ?? sub.streamIndex);
        metaLines.push(`S_HDMV/PGS, "${tsPath(sub.extractedPath)}", lang=${lang}${forced}${name}`);
      });
      const metaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}.meta`);
      sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
      fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');
      sendLog(`  Fallback meta:\n${metaLines.map(l => '    ' + l).join('\n')}`);
      cleanup(tempBdFolder);
      fs.mkdirSync(tempBdFolder, { recursive: true });
      const tsFb = spawn(TOOLS.tsmuxer, [metaFile, tempBdFolder]);
      tsFb.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsFb.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsFb.on('error', err => { cleanup(tempBdFolder); reject(new Error(`Title ${titleIdx}: tsMuxeR error: ${err.message}`)); });
      tsFb.on('close', code => {
        if (code !== 0) { cleanup(tempBdFolder); return reject(new Error(`Title ${titleIdx}: tsMuxeR failed (exit ${code})`)); }
        mergeFromTempBd(tempBdFolder);
      });
    };

    // ── Step 3: tsMuxeR with .ts + extracted subtitle files ──────────────────────
    // tsMuxeR drops video (Processed 0 video frames) when the source is an FFmpeg
    // .ts file and text subtitles are present.  Work-around: 4-step pipeline:
    //   3a. tsMuxeR: video.ts + .srt files → subtitle-only temp.m2ts (video drop expected)
    //   3b. ffprobe: count subtitle streams in temp.m2ts
    //   3c. FFmpeg:  extract each subtitle stream as a .sup file
    //   3d. runMkvmergeAndTsMuxer: mkvmerge title.ts + .sup → combined.mkv → tsMuxeR
    // If no text subs are present we skip straight to runMkvmergeAndTsMuxer.
    const runTsMuxerWithTs = (extractedSubs) => {
      sendLog(`  Step 3: tsMuxeR with .ts + ${extractedSubs.length} subtitle file(s)`);

      if (!TOOLS.tsmuxer) {
        return reject(new Error(`Title ${titleIdx}: tsMuxeR is required for BD-compliant additional titles`));
      }

      const textSubs = extractedSubs.filter(s => s.format !== 'PGS (Blu-ray Native)');
      const pgsSubs  = extractedSubs.filter(s => s.format === 'PGS (Blu-ray Native)');

      if (textSubs.length === 0) {
        // All subs are already PGS — go straight to final mux
        return runMkvmergeAndTsMuxer(pgsSubs);
      }

      // ── Step 3a: tsMuxeR SRT→PGS conversion pass ────────────────────────────
      const subTempBd = path.join(workDir, `bdmv_title_${pad(titleIdx)}_subtmp`);
      cleanup(subTempBd);
      fs.mkdirSync(subTempBd, { recursive: true });

      const subMetaLines = ['MUXOPT --blu-ray --new-audio-pes'];
      subMetaLines.push(`${vCodec}, "${tsPath(titleTs)}", fps=${fpsToTsMuxer(fps)}, track=1`);
      if (audioTracks.length > 0) {
        audioTracks.forEach((t, i) => {
          const codec = STREAM_COPY_FORMATS.has(t.format) ? (aCodecMap[t.format] || 'A_AC3') : 'A_AC3';
          const name  = trackName(t.trackIndex ?? t.streamIndex);
          subMetaLines.push(`${codec}, "${tsPath(titleTs)}", lang=${langCode(t.language)}, track=${i + 2}${name}`);
        });
      } else {
        subMetaLines.push(`A_AC3, "${tsPath(titleTs)}", lang=und, track=2`);
      }
      // S_TEXT/UTF8 silently causes tsMuxeR --blu-ray to produce no output; text subs excluded.

      const subMetaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}_subtmp.meta`);
      sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
      fs.writeFileSync(subMetaFile, subMetaLines.join('\n') + '\n');
      sendLog(`  Step 3a: tsMuxeR SRT→PGS conversion (video drop expected — known tsMuxeR/ts bug)`);
      sendLog(`  meta:\n${subMetaLines.map(l => '    ' + l).join('\n')}`);
      sendLog(`  tsMuxeR: "${subMetaFile}" "${subTempBd}"`);

      const tsProc3a = spawn(TOOLS.tsmuxer, [subMetaFile, subTempBd]);
      tsProc3a.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsProc3a.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsProc3a.on('error', err => {
        sendLog(`  Step 3a error: ${err.message} — skipping text subs, proceeding with PGS only`);
        cleanup(subTempBd);
        runMkvmergeAndTsMuxer(pgsSubs);
      });
      tsProc3a.on('close', code => {
        if (code !== 0) {
          sendLog(`  Step 3a failed (exit ${code}) — retrying with source MKV instead of .ts`);
          cleanup(subTempBd);

          // ── Step 3a retry: convert titleTs → .mkv via mkvmerge (stream copy), then feed
          //    that .mkv to tsMuxeR.  tsMuxeR reads MKV cleanly; audio is already AC3
          //    from Step 1 so there is no codec mismatch. ──
          const forsubsMkv = path.join(workDir, `title_${pad(titleIdx)}_forsubs.mkv`);
          sendLog(`  Step 3a retry: mkvmerge stream-copy ${path.basename(titleTs)} → ${path.basename(forsubsMkv)}`);
          sendLog(`  mkvmerge: ${[TOOLS.mkvmerge, '-o', forsubsMkv, titleTs].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

          const mkvConvProc = spawn(TOOLS.mkvmerge, ['-o', forsubsMkv, titleTs]);
          mkvConvProc.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
          mkvConvProc.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
          mkvConvProc.on('error', err => {
            sendLog(`  Step 3a retry mkvmerge error: ${err.message} — skipping text subs, proceeding with PGS only`);
            runMkvmergeAndTsMuxer(pgsSubs);
          });
          mkvConvProc.on('close', mkvConvCode => {
            if (mkvConvCode !== 0) {
              sendLog(`  Step 3a retry mkvmerge failed (exit ${mkvConvCode}) — skipping text subs, proceeding with PGS only`);
              return runMkvmergeAndTsMuxer(pgsSubs);
            }
            sendLog(`  Step 3a retry mkvmerge succeeded → ${path.basename(forsubsMkv)}`);

          const subTempBd2 = path.join(workDir, `bdmv_title_${pad(titleIdx)}_subtmp2`);
          cleanup(subTempBd2);
          fs.mkdirSync(subTempBd2, { recursive: true });

          // Retry meta: video + audio + SRT subs — audio is AC3 in the .mkv, no mismatch
          const retryMetaLines = ['MUXOPT --blu-ray --new-audio-pes'];
          retryMetaLines.push(`${vCodec}, "${tsPath(forsubsMkv)}", fps=${fpsToTsMuxer(fps)}, track=1`);
          retryMetaLines.push(`A_AC3, "${tsPath(forsubsMkv)}", track=2`);
          // S_TEXT/UTF8 silently causes tsMuxeR --blu-ray to produce no output; text subs excluded.

          const retryMetaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}_subtmp2.meta`);
          sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
          fs.writeFileSync(retryMetaFile, retryMetaLines.join('\n') + '\n');
          sendLog(`  Step 3a retry: tsMuxeR SRT→PGS using mkvmerge-converted .mkv`);
          sendLog(`  meta:\n${retryMetaLines.map(l => '    ' + l).join('\n')}`);
          sendLog(`  tsMuxeR: "${retryMetaFile}" "${subTempBd2}"`);

          const tsProc3aRetry = spawn(TOOLS.tsmuxer, [retryMetaFile, subTempBd2]);
          tsProc3aRetry.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
          tsProc3aRetry.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
          tsProc3aRetry.on('error', err => {
            sendLog(`  Step 3a retry error: ${err.message} — skipping text subs, proceeding with PGS only`);
            cleanup(subTempBd2);
            runMkvmergeAndTsMuxer(pgsSubs);
          });
          tsProc3aRetry.on('close', retryCode => {
            if (retryCode !== 0) {
              sendLog(`  Step 3a retry failed (exit ${retryCode}) — skipping text subs, proceeding with PGS only`);
              cleanup(subTempBd2);
              return runMkvmergeAndTsMuxer(pgsSubs);
            }

            // Retry succeeded — Steps 3b/3c against subTempBd2
            const findTempM2tsRetry = () => {
              for (const n of ['00001', '00000']) {
                const p = path.join(subTempBd2, 'BDMV', 'STREAM', `${n}.m2ts`);
                if (fs.existsSync(p)) return p;
              }
              return null;
            };
            const retryTempM2ts = findTempM2tsRetry();
            if (!retryTempM2ts) {
              sendLog(`  Step 3a retry 3b: no temp.m2ts found — skipping text subs`);
              cleanup(subTempBd2);
              return runMkvmergeAndTsMuxer(pgsSubs);
            }
            sendLog(`  Step 3a retry 3b: temp.m2ts: ${path.basename(retryTempM2ts)} (${(fs.statSync(retryTempM2ts).size/1e6).toFixed(1)} MB)`);

            const { execFileSync: execFileSync3aR } = require('child_process');
            let retrySubStreamCount = 0;
            try {
              const probeOut = execFileSync3aR(
                TOOLS.ffprobe,
                ['-v', 'quiet', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'csv=p=0', retryTempM2ts],
                { encoding: 'utf8', timeout: 15000 }
              ).trim();
              retrySubStreamCount = probeOut.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l)).length;
            } catch (err) {
              sendLog(`  Step 3a retry 3b: ffprobe failed: ${err.message} — skipping text subs`);
              cleanup(subTempBd2);
              return runMkvmergeAndTsMuxer(pgsSubs);
            }

            if (retrySubStreamCount === 0) {
              sendLog(`  Step 3a retry 3b: no subtitle streams found — skipping text subs`);
              cleanup(subTempBd2);
              return runMkvmergeAndTsMuxer(pgsSubs);
            }
            sendLog(`  Step 3a retry 3b: found ${retrySubStreamCount} PGS stream(s) in temp.m2ts`);

            const retryExtractedSupFiles = new Array(retrySubStreamCount).fill(null);
            let retryRemaining3c = retrySubStreamCount;

            for (let n = 0; n < retrySubStreamCount; n++) {
              const supFile     = path.join(workDir, `sub_pgs_${pad(titleIdx)}_retry_${n}.sup`);
              const extractArgs = ['-y', '-i', retryTempM2ts, '-map', `0:s:${n}`, '-c:s', 'copy', supFile];
              sendLog(`  Step 3a retry 3c[${n}]: extract → ${path.basename(supFile)}`);
              sendLog(`  FFmpeg: ${[TOOLS.ffmpeg, ...extractArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

              const ff3cRetry = spawn(TOOLS.ffmpeg, extractArgs);
              let ff3cRetryStderr = '';
              ff3cRetry.stderr.on('data', d => { ff3cRetryStderr += d.toString(); });
              ff3cRetry.on('close', code3c => {
                const exists = fs.existsSync(supFile);
                const size   = exists ? fs.statSync(supFile).size : 0;
                if (code3c === 0 && exists && size >= 100) {
                  sendLog(`  ✓ Step 3a retry 3c[${n}]: ${path.basename(supFile)} (${(size/1024).toFixed(0)} KB)`);
                  const origSub = textSubs[n] || {};
                  retryExtractedSupFiles[n] = { ...origSub, format: 'PGS (Blu-ray Native)', extractedPath: supFile };
                } else {
                  sendLog(`  Warning: Step 3a retry 3c[${n}]: extraction failed (exit ${code3c}, ${size} bytes) — skipping`);
                  if (ff3cRetryStderr.trim()) sendLog(`  ffmpeg: ${ff3cRetryStderr.trim().slice(-500)}`);
                }
                if (--retryRemaining3c === 0) {
                  cleanup(subTempBd2);
                  const allPgsSubs = [...pgsSubs, ...retryExtractedSupFiles.filter(Boolean)];
                  runMkvmergeAndTsMuxer(allPgsSubs);
                }
              });
            }
          });
          return; // prevent fall-through to Step 3b inside mkvConvProc callback
          }); // close mkvConvProc.on('close', ...)
          return; // prevent fall-through to Step 3b in if (code !== 0) block
        }

        // ── Step 3b: find temp.m2ts and count subtitle streams ───────────────
        const findTempM2ts = () => {
          for (const n of ['00001', '00000']) {
            const p = path.join(subTempBd, 'BDMV', 'STREAM', `${n}.m2ts`);
            if (fs.existsSync(p)) return p;
          }
          return null;
        };
        const tempM2ts = findTempM2ts();
        if (!tempM2ts) {
          sendLog(`  Step 3b: no temp.m2ts found — skipping text subs`);
          cleanup(subTempBd);
          return runMkvmergeAndTsMuxer(pgsSubs);
        }
        sendLog(`  Step 3b: temp.m2ts: ${path.basename(tempM2ts)} (${(fs.statSync(tempM2ts).size/1e6).toFixed(1)} MB)`);

        const { execFileSync } = require('child_process');
        let subStreamCount = 0;
        try {
          const probeOut = execFileSync(
            TOOLS.ffprobe,
            ['-v', 'quiet', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'csv=p=0', tempM2ts],
            { encoding: 'utf8', timeout: 15000 }
          ).trim();
          subStreamCount = probeOut.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l)).length;
        } catch (err) {
          sendLog(`  Step 3b: ffprobe failed: ${err.message} — skipping text subs`);
          cleanup(subTempBd);
          return runMkvmergeAndTsMuxer(pgsSubs);
        }

        if (subStreamCount === 0) {
          sendLog(`  Step 3b: no subtitle streams found in temp.m2ts — skipping text subs`);
          cleanup(subTempBd);
          return runMkvmergeAndTsMuxer(pgsSubs);
        }
        sendLog(`  Step 3b: found ${subStreamCount} PGS stream(s) in temp.m2ts`);

        // ── Step 3c: FFmpeg extract each subtitle stream as .sup ─────────────
        const extractedSupFiles = new Array(subStreamCount).fill(null);
        let remaining3c = subStreamCount;

        for (let n = 0; n < subStreamCount; n++) {
          const supFile     = path.join(workDir, `sub_pgs_${pad(titleIdx)}_${n}.sup`);
          const extractArgs = ['-y', '-i', tempM2ts, '-map', `0:s:${n}`, '-c:s', 'copy', supFile];
          sendLog(`  Step 3c[${n}]: extract → ${path.basename(supFile)}`);
          sendLog(`  FFmpeg: ${[TOOLS.ffmpeg, ...extractArgs].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

          const ff3c = spawn(TOOLS.ffmpeg, extractArgs);
          let ff3cStderr = '';
          ff3c.stderr.on('data', d => { ff3cStderr += d.toString(); });
          ff3c.on('close', code3c => {
            const exists = fs.existsSync(supFile);
            const size   = exists ? fs.statSync(supFile).size : 0;
            if (code3c === 0 && exists && size >= 100) {
              sendLog(`  ✓ Step 3c[${n}]: ${path.basename(supFile)} (${(size/1024).toFixed(0)} KB)`);
              const origSub = textSubs[n] || {};
              // Spread origSub to carry language, isForced, trackIndex, streamIndex (for track-name lookup)
              extractedSupFiles[n] = { ...origSub, format: 'PGS (Blu-ray Native)', extractedPath: supFile };
            } else {
              sendLog(`  Warning: Step 3c[${n}]: extraction failed (exit ${code3c}, ${size} bytes) — skipping`);
              if (ff3cStderr.trim()) sendLog(`  ffmpeg: ${ff3cStderr.trim().slice(-500)}`);
            }
            if (--remaining3c === 0) {
              cleanup(subTempBd);
              const allPgsSubs = [...pgsSubs, ...extractedSupFiles.filter(Boolean)];
              runMkvmergeAndTsMuxer(allPgsSubs);
            }
          });
        }
      });
    };

    // ── Orchestration ─────────────────────────────────────────────────────────
    if (!TOOLS.tsmuxer) {
      // No tsMuxeR at all: FFmpeg only (no subtitles possible)
      sendLog(`  tsMuxeR not found — FFmpeg-only path`);
      return runFfmpegPipeline();
    }
    if (titleCrfVal) {
      sendLog(`  CRF ${titleCrfVal}: using FFmpeg pipeline`);
      return runFfmpegPipeline();
    }
    runTsMuxerDirectMkv();
  });
}

// ── BD-safe frame-rate validation ─────────────────────────────────────────────
const BD_SAFE_FPS = [23.976, 24.000, 25.000, 29.970, 50.000, 59.940];
const BD_FPS_TOL  = 0.05;
function isBdSafeFps(fps) {
  return BD_SAFE_FPS.some(safe => Math.abs(fps - safe) < BD_FPS_TOL);
}

function getNearestBdSafeFps(fps) {
  return BD_SAFE_FPS.reduce((best, s) => Math.abs(fps - s) < Math.abs(fps - best) ? s : best);
}

// BD-valid Blu-ray resolution+FPS combinations (progressive only, no interlace):
//   1920×1080: 23.976p, 24p  (BD-ROM spec table)
//   1280×720:  50p (PAL), 59.94p (NTSC)  (BD-ROM spec table)
// 1080p25 and 1080p29.97 are technically 1080i fields, not guaranteed progressive on hardware.
// 59.94 at 1080p is not a standard BD-Video format.
function selectHwResAndFps(srcFps, srcHeight) {
  const bdH = (srcHeight || 1080) <= 576 ? 480 : (srcHeight || 1080) <= 720 ? 720 : 1080;
  const bdW = bdH === 480 ? 720 : bdH === 720 ? 1280 : 1920;
  const fps = (() => {
    if (Math.abs(srcFps - 23.976) < 0.05) return 23.976;
    if (Math.abs(srcFps - 24.000) < 0.05) return 24.000;
    if (Math.abs(srcFps - 25.000) < 0.05 || Math.abs(srcFps - 50.000) < 0.05) return 50.000;
    if (Math.abs(srcFps - 29.970) < 0.05 || Math.abs(srcFps - 59.940) < 0.05) return 59.940;
    return 23.976;
  })();
  const resolution = bdH === 1080 ? '1080p (1920×1080)' : bdH === 720 ? '720p (1280×720)' : '480p (720×480)';
  return { w: bdW, h: bdH, fps, resolution };
}

function getBdFpsFraction(fps) {
  if (Math.abs(fps - 23.976) < 0.02) return '24000/1001';
  if (Math.abs(fps - 24.000) < 0.02) return '24';
  if (Math.abs(fps - 25.000) < 0.02) return '25';
  if (Math.abs(fps - 29.970) < 0.02) return '30000/1001';
  if (Math.abs(fps - 50.000) < 0.02) return '50';
  if (Math.abs(fps - 59.940) < 0.02) return '60000/1001';
  return fps.toFixed(3);
}

// ── Helper: read actual video fps via ffprobe ─────────────────────────────────

function getVideoFps(filePath) {
  if (!TOOLS.ffprobe || !filePath) return '23.976';
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      TOOLS.ffprobe,
      ['-v','quiet','-select_streams','v:0','-show_entries','stream=r_frame_rate','-of','csv=p=0', filePath],
      { encoding:'utf8', timeout:10000 }
    ).trim().split('\n')[0].trim();
    const [n, d] = out.split('/').map(Number);
    if (n && d && d > 0) return (n / d).toFixed(3);
  } catch (_) {}
  return '23.976';
}

// ── Helper: read video duration via ffprobe ───────────────────────────────────
function getVideoDuration(filePath) {
  if (!TOOLS.ffprobe || !filePath) return 0;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      TOOLS.ffprobe,
      ['-v','quiet','-show_entries','format=duration','-of','csv=p=0', filePath],
      { encoding:'utf8', timeout:15000 }
    ).trim();
    return parseFloat(out) || 0;
  } catch (_) {}
  return 0;
}

// ── Helper: CRF value from quality mode string ────────────────────────────────
const CRF_VALUES = { crf18: 18, crf20: 20, crf23: 23 };
function getCrfValue(videoQuality) {
  return CRF_VALUES[videoQuality] || null;
}

// ── Helper: get actual video dimensions via ffprobe ───────────────────────────
function detectResolution(filePath) {
  if (!TOOLS.ffprobe || !filePath) return { w: 0, h: 0 };
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      TOOLS.ffprobe,
      ['-v','quiet','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0', filePath],
      { encoding:'utf8', timeout:10000 }
    ).trim().split('\n')[0].trim();
    const parts = out.split(',').map(Number);
    if (parts.length >= 2 && parts[0] && parts[1]) return { w: parts[0], h: parts[1] };
  } catch (_) {}
  return { w: 0, h: 0 };
}

// ── Helper: find nearest BD-compliant resolution ──────────────────────────────
// Returns null if already compliant, or { w, h, padOnly } for the target.
// padOnly=true  → pad with black bars (SD, aspect preserved)
// padOnly=false → scale to target (aspect already matches)
const _BD_RES = [[1920,1080],[1280,720],[720,480],[720,576]];
function getBdCompliantResolution(width, height) {
  if (_BD_RES.some(([w,h]) => w===width && h===height)) return null;
  if (height >= 464 && height <= 496 && width <= 720) return { w:720, h:480, padOnly:true };
  if (height >= 560 && height <= 592 && width <= 720) return { w:720, h:576, padOnly:true };
  if (height >= 700 && height <= 760) return { w:1280, h:720, padOnly:false };
  if (height >= 900 && height <= 1100) return { w:1920, h:1080, padOnly:false };
  return { w:1920, h:1080, padOnly:false };
}

// ── Helper: stream title tags via ffprobe ─────────────────────────────────────
// Returns a map of { streamIndex → title string } for all streams that have a
// "title" tag.  Used to populate tsMuxeR track-name= fields.
function getStreamTitles(filePath) {
  if (!TOOLS.ffprobe || !filePath) return {};
  try {
    const { execFileSync } = require('child_process');
    const out  = execFileSync(
      TOOLS.ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath],
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(out);
    const map  = {};
    (data.streams || []).forEach(s => {
      const title = s.tags?.title || s.tags?.TITLE || '';
      if (title) map[s.index] = title;
    });
    return map;
  } catch (_) {}
  return {};
}

// ── Helper: detect variable frame rate via ffprobe ────────────────────────────
// Compares r_frame_rate (declared container rate) with avg_frame_rate (computed).
// A ratio >1.10 indicates the stream is VFR (e.g. phone video, screen recordings).
function detectVfr(filePath) {
  if (!TOOLS.ffprobe || !filePath) return { isVfr: false };
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      TOOLS.ffprobe,
      ['-v','quiet','-select_streams','v:0',
       '-show_entries','stream=r_frame_rate,avg_frame_rate',
       '-of','csv=p=0', filePath],
      { encoding:'utf8', timeout:10000 }
    ).trim().split('\n')[0].trim();
    const parts = out.split(',');
    if (parts.length < 2) return { isVfr: false };
    const parseRate = s => { const [n, d] = s.split('/').map(Number); return (n && d && d > 0) ? n / d : 0; };
    const rFps   = parseRate(parts[0]);
    const avgFps = parseRate(parts[1]);
    if (!rFps || !avgFps) return { isVfr: false };
    const ratio = Math.max(rFps, avgFps) / Math.min(rFps, avgFps);
    return { isVfr: ratio > 1.10, rFps, avgFps };
  } catch (_) {}
  return { isVfr: false };
}

// ── Helper: get video codec name via ffprobe ──────────────────────────────────
function getVideoCodec(filePath) {
  if (!TOOLS.ffprobe || !filePath) return 'unknown';
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      TOOLS.ffprobe,
      ['-v','quiet','-select_streams','v:0','-show_entries','stream=codec_name','-of','csv=p=0', filePath],
      { encoding:'utf8', timeout:10000 }
    ).trim().split('\n')[0].trim();
    return out || 'unknown';
  } catch (_) {}
  return 'unknown';
}

// ── Step 4b: Prepare main feature (mkvmerge container swap) ──────────────────
// Convert main.ts → main_bd.mkv so tsMuxeR can produce a proper 192-byte BD
// stream in its single pass.  Navigation timestamps will then match the stream.

function prepareMainFeature(workDir, tsDir) {
  return new Promise((resolve, reject) => {
    const mainTs    = path.join(tsDir, 'main.ts');
    const mainBdMkv = path.join(workDir, 'main_bd.mkv');

    if (!fs.existsSync(mainTs)) {
      return reject(new Error('prepareMainFeature: main.ts not found'));
    }
    if (!TOOLS.mkvmerge) {
      sendLog('prepareMainFeature: mkvmerge not found — tsMuxeR will use main.ts directly (192-byte output may vary)');
      return resolve();
    }

    sendLog(`Preparing main feature: mkvmerge → main_bd.mkv`);
    const mkv = spawn(TOOLS.mkvmerge, ['-o', mainBdMkv, mainTs]);
    mkv.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
    mkv.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
    mkv.on('error', err => reject(new Error(`mkvmerge error preparing main feature: ${err.message}`)));
    mkv.on('close', code => {
      // mkvmerge exits 1 for warnings — output is still valid
      if (code !== 0 && code !== 1) {
        return reject(new Error(`mkvmerge exited ${code} while preparing main feature`));
      }
      if (!fs.existsSync(mainBdMkv)) {
        return reject(new Error('mkvmerge did not produce main_bd.mkv'));
      }
      sendLog(`  main_bd.mkv: ${(fs.statSync(mainBdMkv).size / 1e6).toFixed(1)} MB`);
      resolve();
    });
  });
}

// ── Step 5: Write tsMuxeR .meta project file ──────────────────────────────────
//
// tsMuxeR meta format:
//   MUXOPT --blu-ray [options]
//   V_MPEG4/ISO/AVC, "file.ts", ...
//   A_DTS, "file.ts", ...
//   S_HDMV/PGS, "subtitle.sup", ...
//
// tsMuxeR reads main_bd.mkv (container-swapped by mkvmerge) and produces a
// 192-byte BD stream whose timestamps exactly match the navigation files.

// Escape characters that would break tsMuxeR's double-quoted path parser.
// Backslashes must be doubled; double-quotes must be escaped. Apostrophes are
// safe inside double-quoted strings and do NOT need escaping.
const tsPath = p => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function writeTsMuxerMeta(project, workDir, tsDir, bdFolder) {
  const mainPath  = project.mainVideo?.path || '';
  // Use main_bd.mkv (mkvmerge container-swapped) when it exists.
  // tsMuxeR 2.6.16-dev cannot mux from MPEG-TS input — it processes 0 video frames
  // silently and produces a 0-byte output. MKV container input works correctly.
  // Fall back to main.ts only if mkvmerge was unavailable in prepareMainFeature.
  const mainBdMkv = path.join(workDir, 'main_bd.mkv');
  const mainTs    = fs.existsSync(mainBdMkv) ? mainBdMkv : path.join(tsDir, 'main.ts');
  const outPath  = path.join(bdFolder, 'BDMV'); // tsMuxeR writes the BDMV tree here
  const metaFile = path.join(workDir, 'tsmuxer.meta');

  const m = project.menuConfig;
  const menuPng = path.join(workDir, 'menu_bg.png');
  const hasMenu = fs.existsSync(menuPng);

  // ── Global muxopt line ──
  const muxopts = [
    '--blu-ray',
    `--label="${sanitize(project.title || 'DISC').toUpperCase()}"`,
    '--new-audio-pes',
  ];
  if (hasMenu) muxopts.push(`--custom-menu-bg="${tsPath(menuPng)}"`);

  const lines = [`MUXOPT ${muxopts.join(' ')}`];

  // ── Video track ──
  // Output is always libx264 H.264 — declare V_MPEG4/ISO/AVC unconditionally.
  const vCodec = 'V_MPEG4/ISO/AVC';
  const resDims = {
    '1080p (1920×1080)':  [1920, 1080],
    '720p (1280×720)':    [1280, 720],
    '480p (720×480)':     [720,  480],
    '480p (720×576) PAL': [720,  576],
  };
  const mainSrcResForMeta = detectResolution(project.mainVideo?.path || '');
  const mainResCorrForMeta = (mainSrcResForMeta.w && mainSrcResForMeta.h)
    ? getBdCompliantResolution(mainSrcResForMeta.w, mainSrcResForMeta.h)
    : null;
  const [subVW, subVH] = mainResCorrForMeta
    ? [mainResCorrForMeta.w, mainResCorrForMeta.h]
    : (resDims[project.resolution] || [1920, 1080]);
  const fps = project._safeOutputFps || getVideoFps(project.mainVideo?.path);
  lines.push(`${vCodec}, "${tsPath(mainTs)}", fps=${fpsToTsMuxer(fps)}, insertSEI, contSPS, track=1`);

  const streamTitles = getStreamTitles(mainPath);
  // Returns the tsMuxeR track-name fragment for a given 0-based stream index.
  const trackName    = idx => {
    if (idx == null) return '';
    const t = streamTitles[idx];
    return t ? `, track-name="${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
  };

  // ── Audio tracks ──
  // The tsMuxeR codec string MUST exactly match what is in the .ts file.
  // All audio is transcoded to AC3 640k — declare A_AC3 for every track.
  // Build ordered audio list that exactly matches muxMainFeature's FFmpeg mapping order:
  //   1. Tracks embedded in the main video file (have stream index, not from additional title)
  //   2. Standalone external audio files (trackIndex == null)
  // Use denylist (exclude known additional-title paths) rather than allowlist (require exact
  // path match to mainPath) — the allowlist silently drops audio when paths differ due to
  // macOS symlink or normalization differences.
  const metaAdditionalPaths = new Set((project.titles || []).map(t => t.file?.path).filter(Boolean));
  sendLog(`  writeTsMuxerMeta: project.audioTracks.length=${project.audioTracks.length}, mainPath="${mainPath}"`);
  sendLog(`  writeTsMuxerMeta: metaAdditionalPaths=[${[...metaAdditionalPaths].join('|')}]`);
  project.audioTracks.forEach((t, i) => {
    sendLog(`    audioTrack[${i}]: file.path="${t.file?.path}", trackIndex=${t.trackIndex ?? t.streamIndex}, format="${t.format}"`);
  });
  const mainFeatureAudio = [
    ...project.audioTracks.filter(t =>
      (t.trackIndex ?? t.streamIndex) != null &&
      !(t.file?.path && metaAdditionalPaths.has(t.file.path))
    ),
    ...project.audioTracks.filter(t => (t.trackIndex ?? t.streamIndex) == null),
  ];
  sendLog(`  writeTsMuxerMeta: ${mainFeatureAudio.length} audio tracks for main feature (${project.audioTracks.length} total)`);
  sendLog('tsMuxeR meta: all audio declared A_AC3 (Blu-ray safe)');
  mainFeatureAudio.forEach((track, i) => {
    const lang      = langCode(track.language);
    const isDefault = track.isDefault ? ', default' : '';
    const name      = trackName(track.trackIndex ?? track.streamIndex);
    lines.push(`A_AC3, "${tsPath(mainTs)}", lang=${lang}, track=${i + 2}${isDefault}${name}`);
  });

  // ── Subtitle tracks ──
  // Subtitles were NOT routed through FFmpeg, so they are NOT in main.ts.
  // Three cases:
  //   1. Embedded in source MKV (trackIndex set, file is mainPath) → tsMuxeR reads from MKV
  //   2. Standalone .sup PGS file                                  → reference directly as S_HDMV/PGS
  //   3. Standalone text sub (.srt/.ass/.vtt/etc.)                 → reference directly as S_TEXT/UTF8
  //
  // Subtitles embedded in ADDITIONAL title files are excluded here — they are
  // handled by processAdditionalTitle.  Two complementary filters prevent leaks:
  //   1. Path-based: file path is in additionalTitlePaths (primary check)
  //   2. Index-based: track has a stream/track index AND is not from mainPath
  //      (catches cases where path comparison fails, e.g. normalization differences)
  const additionalTitlePaths = new Set(project.titles.map(t => t.file?.path).filter(Boolean));

  project.subtitleTracks.forEach((sub) => {
    if (!sub.file?.path) return;
    // trackIdx is set for any sub embedded inside a container (MKV/MP4/TS).
    // Standalone .sup/.srt files have neither field → trackIdx is null.
    const trackIdx = sub.trackIndex ?? sub.streamIndex ?? null;
    // Filter 1: path-based exclusion of additional-title files
    if (additionalTitlePaths.has(sub.file.path)) return;
    // Filter 2: belt-and-suspenders — any embedded track not from the main video
    // belongs to an additional title and must not appear in the main tsMuxeR meta.
    if (trackIdx != null && sub.file.path !== mainPath) return;

    const lang   = langCode(sub.language);
    const forced = sub.isForced ? ', forced' : '';
    const ext    = path.extname(sub.file.path).toLowerCase();

    if (mainPath && sub.file.path === mainPath && trackIdx != null) {
      // Embedded in the source MKV — tsMuxeR reads directly from the MKV file.
      // Only PGS tracks are included; S_TEXT/UTF8 silently breaks tsMuxeR --blu-ray.
      if (sub.format === 'PGS (Blu-ray Native)') {
        const tsmTrack = trackIdx + 1;
        const name     = trackName(trackIdx);
        lines.push(`S_HDMV/PGS, "${tsPath(sub.file.path)}", lang=${lang}, track=${tsmTrack}${forced}${name}`);
      }
    } else if (ext === '.sup') {
      // Standalone .sup file — reference directly (no source stream index to look up)
      lines.push(`S_HDMV/PGS, "${tsPath(sub.file.path)}", lang=${lang}${forced}`);
    }
    // Standalone text subs (.srt/.ass/etc.) are skipped — tsMuxeR cannot convert
    // SRT to BD PGS in --blu-ray mode and silently produces no output.
  });

  // ── Extras (experimental — not proper BD special-feature authoring) ──
  if (project.extras.length > 0) {
    sendLog('WARNING: Extras are experimental. They are appended as extra video tracks in the tsMuxeR meta, not as proper BD title entries. Results on hardware players will vary.');
    project.extras.forEach((extra, i) => {
      const extraTs = path.join(tsDir, `extra_${String(i+1).padStart(2,'0')}.ts`);
      if (fs.existsSync(extraTs)) {
        lines.push(`V_MPEG4/ISO/AVC, "${tsPath(extraTs)}", track=1`);
      }
    });
  }

  sendLog(`  fpsToTsMuxer: input="${fps}" → output="${fpsToTsMuxer(fps)}"`);
  fs.writeFileSync(metaFile, lines.join('\n') + '\n');
  const debugCopy = require('os').homedir() + '/Desktop/last_tsmuxer.meta';
  fs.writeFileSync(debugCopy, lines.join('\n') + '\n');
  sendLog('Meta saved to: ' + debugCopy);

  return Promise.resolve();
}

// ── Step 6: Run tsMuxeR ───────────────────────────────────────────────────────

function runTsMuxer(workDir, bdFolder) {
  return new Promise((resolve, reject) => {
    const metaFile = path.join(workDir, 'tsmuxer.meta');

    if (!TOOLS.tsmuxer) {
      return reject(new Error(
        'tsMuxeR is required to build BD-compliant discs.\n\n' +
        'Install it via:\n  brew install --cask tsmuxer\nor download from https://github.com/justdan96/tsMuxeR/releases'
      ));
    }

    sendLog(`Running: ${TOOLS.tsmuxer} "${metaFile}" "${bdFolder}"`);

    const proc = spawn(TOOLS.tsmuxer, [metaFile, bdFolder]);

    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line) sendLog(line);
    });
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      const line = chunk.trim();
      if (line) sendLog(line);
    });

    proc.on('close', code => {
      if (code === 0) {
        const streamDir  = path.join(bdFolder, 'BDMV', 'STREAM');
        const m2tsFiles  = fs.existsSync(streamDir)
          ? fs.readdirSync(streamDir).filter(f => f.toLowerCase().endsWith('.m2ts'))
          : [];
        if (!m2tsFiles.length) {
          return reject(new Error('tsMuxeR produced no output — check the meta file'));
        }
        // Log STREAM directory contents and sizes so we can verify output
        let mainM2tsSize = 0;
        try {
          const allFiles = fs.readdirSync(streamDir);
          const listing = allFiles.map(f => {
            const fpath = path.join(streamDir, f);
            const sz = fs.existsSync(fpath) ? fs.statSync(fpath).size : 0;
            if (f.endsWith('.m2ts') && sz > mainM2tsSize) mainM2tsSize = sz;
            return `${f} (${(sz / 1e6).toFixed(1)} MB)`;
          });
          sendLog('STREAM/ contents: ' + listing.join(', '));
        } catch(_) {}
        // tsMuxeR exits 0 but writes 0-byte output when it can't mux the source
        // (e.g. MPEG-TS input which this version cannot handle — use MKV instead).
        if (mainM2tsSize < 100 * 1024) {
          return reject(new Error(
            `tsMuxeR produced an empty output (largest .m2ts is ${mainM2tsSize} bytes).\n\n` +
            'This usually means the input file format is incompatible.\n' +
            'Check that mkvmerge is installed (brew install mkvtoolnix) so Disc Forge can convert main.ts → MKV before passing it to tsMuxeR.'
          ));
        }
        resolve();
      } else {
        reject(new Error(`tsMuxeR exited with code ${code}:\n${stderr.slice(-500)}`));
      }
    });
    proc.on('error', err => reject(new Error(`tsMuxeR error: ${err.message}\n\nMake sure tsMuxeR is installed:\n  brew install --cask tsmuxer\nor download from https://github.com/justdan96/tsMuxeR/releases`)));
  });
}

// ── Validate mux output ───────────────────────────────────────────────────────
function validateMuxOutput(tsDir) {
  return new Promise((resolve, reject) => {
    const mainTs = path.join(tsDir, 'main.ts');
    if (!fs.existsSync(mainTs)) {
      return reject(new Error(
        'main.ts was not created by FFmpeg.\n\n' +
        'Common causes:\n' +
        '• The video file path contains special characters\n' +
        '• The source video codec is not supported (try H.264 or H.265)\n' +
        '• FFmpeg ran out of disk space\n\n' +
        'Check that your video file opens in VLC, then try again.'
      ));
    }
    const size = fs.statSync(mainTs).size;
    if (size < 1024) {
      return reject(new Error(
        `main.ts is too small (${size} bytes) — FFmpeg output appears empty.\n\n` +
        'Make sure your video file is valid and not corrupted.'
      ));
    }
    sendLog(`✓ Mux output validated: main.ts (${(size/1e6).toFixed(1)} MB)`);
    resolve();
  });
}

// ── Step 6.5: Pre-burn validation ───
// Runs before ISO creation to catch structural problems early.

function validateHwBuild(project, workDir, bdFolder) {
  return new Promise((resolve, reject) => {
    sendLog('Pre-burn validation checklist');
    const errors = [];

    const check = (label, ok) => {
      sendLog(`  ${ok ? '✓' : '✗'} ${label}`);
      if (!ok) errors.push(label);
    };

    // Required BD folder/file structure
    check('BDMV folder exists',                   fs.existsSync(path.join(bdFolder, 'BDMV')));
    check('CERTIFICATE folder exists',            fs.existsSync(path.join(bdFolder, 'CERTIFICATE')));
    check('BDMV/index.bdmv exists',               fs.existsSync(path.join(bdFolder, 'BDMV', 'index.bdmv')));
    check('BDMV/MovieObject.bdmv exists',         fs.existsSync(path.join(bdFolder, 'BDMV', 'MovieObject.bdmv')));

    const streamDir  = path.join(bdFolder, 'BDMV', 'STREAM');
    const playlistDir = path.join(bdFolder, 'BDMV', 'PLAYLIST');
    const clipinfDir  = path.join(bdFolder, 'BDMV', 'CLIPINF');

    const streamFiles   = fs.existsSync(streamDir)   ? fs.readdirSync(streamDir).filter(f => f.toLowerCase().endsWith('.m2ts'))  : [];
    const playlistFiles = fs.existsSync(playlistDir) ? fs.readdirSync(playlistDir).filter(f => f.toLowerCase().endsWith('.mpls')) : [];
    const clipinfFiles  = fs.existsSync(clipinfDir)  ? fs.readdirSync(clipinfDir).filter(f => f.toLowerCase().endsWith('.clpi'))  : [];

    check(`BDMV/STREAM contains at least one .m2ts (found: ${streamFiles.length})`,   streamFiles.length > 0);
    check(`BDMV/PLAYLIST contains at least one .mpls (found: ${playlistFiles.length})`, playlistFiles.length > 0);
    check(`BDMV/CLIPINF contains at least one .clpi (found: ${clipinfFiles.length})`,   clipinfFiles.length > 0);

    // Verify safe build flags and ISO method
    check('Passthrough mode disabled',           !project.passThroughMode);
    check('Force transcode enabled',             !!project.forceTranscode);
    check('ISO method available',                  bestIsoMethod !== null);

    // Verify safe build suppressed menu/extras/additional titles
    check('Menu generation disabled',       !fs.existsSync(path.join(workDir, 'menu_bg.png')));
    check('No extras',                      (project.extras || []).length === 0);
    check('No additional titles',           (project.titles || []).length === 0);

    // Verify tsMuxeR meta declares A_AC3 audio and H.264/AVC video
    const metaFile = path.join(workDir, 'tsmuxer.meta');
    if (fs.existsSync(metaFile)) {
      const metaContent = fs.readFileSync(metaFile, 'utf8');
      const hasAVC  = metaContent.includes('V_MPEG4/ISO/AVC');
      const hasAC3  = metaContent.includes('A_AC3');
      const hasDTS  = metaContent.includes('A_DTS');
      check('tsMuxeR meta declares H.264/AVC video (V_MPEG4/ISO/AVC)',  hasAVC);
      check('tsMuxeR meta declares AC3 audio (A_AC3)',                  hasAC3);
      if (hasDTS) {
        sendLog('WARNING: tsMuxeR meta contains A_DTS — expected only A_AC3');
        errors.push('tsMuxeR meta contains unexpected A_DTS');
      }
    } else {
      sendLog('WARNING: tsmuxer.meta not found — skipping codec checks');
    }

    if (errors.length > 0) {
      return reject(new Error(
        `Pre-burn validation failed — ${errors.length} issue(s):\n\n` +
        errors.map(e => `  • ${e}`).join('\n')
      ));
    }
    sendLog('  All pre-burn checks passed.');
    resolve();
  });
}

// ── Step 7: Package ISO ────────────────────────────────────────────────────────
// Uses bestIsoMethod detected at startup — no per-build detection.

function packageISO(bdFolder, outputDir, discName) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {

    const debugInfo = `bdFolder="${bdFolder}" outputDir="${outputDir}" discName="${discName}"`;

    if (!bdFolder || bdFolder.trim() === '') return reject(new Error(`bdFolder is empty!\n${debugInfo}`));

    const bdmvDir    = path.join(bdFolder, 'BDMV');
    const bdExists   = fs.existsSync(bdFolder);
    const bdmvExists = fs.existsSync(bdmvDir);
    if (!bdExists)   return reject(new Error(`BD source folder does not exist:\n${bdFolder}`));
    if (!bdmvExists) {
      const contents = bdExists ? (fs.readdirSync(bdFolder).join(', ') || '(empty)') : 'N/A';
      return reject(new Error(`BDMV subfolder missing. Folder contents: ${contents}`));
    }

    try { fs.mkdirSync(outputDir, { recursive: true }); } catch(e) {
      return reject(new Error(`Cannot create output dir: ${outputDir}\n${e.message}`));
    }

    const isoPath = path.join(outputDir, `${discName}.iso`);
    try { if (fs.existsSync(isoPath)) fs.unlinkSync(isoPath); } catch(_) {}
    const volName = (discName.toUpperCase().replace(/[^A-Z0-9_]/g,'_')).slice(0,32) || 'DISC';

    // Ensure CERTIFICATE dir exists at disc root
    const certDir = path.join(bdFolder, 'CERTIFICATE');
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
      sendLog('Created missing CERTIFICATE directory');
    }

    sendLog(`Creating ISO — method: ${bestIsoMethod} — ${isoPath}`);

    const finish = (err, usedUdf250) => {
      if (err) return reject(err);
      const size = fs.existsSync(isoPath) ? `${(fs.statSync(isoPath).size/1e9).toFixed(2)} GB` : '?';
      sendLog(`ISO created: ${isoPath} (${size})`);
      resolve({ usedUdf250 });
    };

    if (bestIsoMethod === 'xorriso-udf250') {
      const args = ['-as', 'mkisofs', '-udf', '-udfver', '2.50', '-V', volName, '-o', isoPath, bdFolder];
      sendLog('xorriso -as mkisofs -udf -udfver 2.50');
      execFile(TOOLS.xorriso, args, { maxBuffer: 200 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) return finish(new Error(`xorriso failed:\n${(stderr || err.message).slice(0,800)}`), false);
        finish(null, true);
      });
    } else if (bestIsoMethod === 'xorriso-native') {
      const args = ['-outdev', `stdio:${isoPath}`, '-map', bdFolder, '/', '-volid', volName, '-commit'];
      sendLog('xorriso native mode');
      execFile(TOOLS.xorriso, args, { maxBuffer: 200 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) return finish(new Error(`xorriso failed:\n${(stderr || err.message).slice(0,800)}`), false);
        finish(null, false);
      });
    } else {
      return reject(new Error('No ISO tool available. Install xorriso: brew install xorriso'));
    }
  });
}

// ── IPC: combine episodes ─────────────────────────────────────────────────────

ipcMain.handle('combine-episodes', async (_, { files, normalizeBeforeCombine }) => {
  if (!TOOLS.ffmpeg)  return { error: 'ffmpeg not found — install with: brew install ffmpeg' };
  if (!TOOLS.ffprobe) return { error: 'ffprobe not found — install with: brew install ffmpeg' };
  if (!files || files.length < 2) return { error: 'Need at least 2 episode files' };

  const combineDir = (() => {
    const candidates = [
      '/Volumes/Internal SSD/.discforge_combine',
      '/Volumes/Samsung USB/.discforge_combine',
      path.join(os.homedir(), '.discforge_combine'),
    ];
    for (const c of candidates) {
      try {
        const parent = path.dirname(c);
        if (fs.existsSync(parent)) { fs.mkdirSync(c, { recursive: true }); return c; }
      } catch(_) {}
    }
    return path.join(os.tmpdir(), 'discforge_combine');
  })();

  const probeEpisode = (filePath) => new Promise(resolve => {
    const proc = spawn(TOOLS.ffprobe, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        const videoStream = (parsed.streams || []).find(s => s.codec_type === 'video');
        const firstAudio  = (parsed.streams || []).find(s => s.codec_type === 'audio');
        const audioCount  = (parsed.streams || []).filter(s => s.codec_type === 'audio').length;
        resolve({
          duration:      parseFloat(parsed.format?.duration || 0),
          videoCodec:    videoStream?.codec_name   || null,
          width:         videoStream?.width         || null,
          height:        videoStream?.height        || null,
          rFrameRate:    videoStream?.r_frame_rate  || null,
          pixFmt:        videoStream?.pix_fmt       || null,
          audioCount,
          audioCodec:    firstAudio?.codec_name     || null,
          audioChannels: firstAudio?.channels       || null,
        });
      } catch(_) {
        resolve({ duration: 0, videoCodec: null, width: null, height: null, rFrameRate: null, pixFmt: null, audioCount: 0, audioCodec: null, audioChannels: null });
      }
    });
    proc.on('error', () => resolve({ duration: 0, videoCodec: null, width: null, height: null, rFrameRate: null, pixFmt: null, audioCount: 0, audioCodec: null, audioChannels: null }));
  });

  const parseFps = (rFrameRate) => {
    if (!rFrameRate) return 0;
    const parts = rFrameRate.split('/');
    if (parts.length === 2) return parseFloat(parts[0]) / parseFloat(parts[1]);
    return parseFloat(rFrameRate) || 0;
  };

  sendLog('[COMBINE] Probing episode streams…');
  const probeResults = [];
  for (const f of files) {
    const info = await probeEpisode(f.path);
    probeResults.push(info);
    sendLog(`[COMBINE] ${f.name}: ${info.duration.toFixed(3)}s  codec=${info.videoCodec}  ${info.width}x${info.height}  fps=${info.rFrameRate}  pix_fmt=${info.pixFmt}  audio=${info.audioCount}  audioCodec=${info.audioCodec}  audioChannels=${info.audioChannels}`);
  }

  const ref = probeResults[0];
  if (!normalizeBeforeCombine) {
    for (let i = 1; i < probeResults.length; i++) {
      const ep = probeResults[i];
      const epNum = i + 1;
      if (ep.videoCodec !== ref.videoCodec) {
        return { error: `Cannot combine: episodes have different video codecs (episode 1: ${ref.videoCodec}, episode ${epNum}: ${ep.videoCodec}). All episodes must use the same codec.` };
      }
      if (ep.width !== ref.width || ep.height !== ref.height) {
        return { error: `Cannot combine: episodes have different resolutions (episode 1: ${ref.width}x${ref.height}, episode ${epNum}: ${ep.width}x${ep.height}). All episodes must have the same resolution.` };
      }
      if (Math.abs(parseFps(ep.rFrameRate) - parseFps(ref.rFrameRate)) > 0.1) {
        return { error: `Cannot combine: episodes have different frame rates. All episodes must have the same FPS.` };
      }
      if (ep.audioCodec !== ref.audioCodec) {
        return { error: `Cannot combine: episodes have different audio codecs (episode 1: ${ref.audioCodec}, episode ${epNum}: ${ep.audioCodec}). All episodes must use the same audio codec.` };
      }
      if (ep.audioChannels !== ref.audioChannels) {
        return { error: `Cannot combine: episodes have different audio channel counts (episode 1: ${ref.audioChannels}ch, episode ${epNum}: ${ep.audioChannels}ch). All episodes must have the same channel layout.` };
      }
      if (ep.pixFmt !== ref.pixFmt) {
        return { error: `Cannot combine: episodes have different pixel formats (episode 1: ${ref.pixFmt}, episode ${epNum}: ${ep.pixFmt}). All episodes must have the same pixel format.` };
      }
    }
    sendLog(`[COMBINE] Validation passed: codec=${ref.videoCodec} ${ref.width}x${ref.height} fps=${ref.rFrameRate} pix_fmt=${ref.pixFmt} audioCodec=${ref.audioCodec} audioChannels=${ref.audioChannels}ch audio=${ref.audioCount}`);
  } else {
    sendLog(`[COMBINE] Normalize mode — skipping stream-match validation`);
  }

  const durations = probeResults.map(r => r.duration);

  let sourceFiles = files;

  if (normalizeBeforeCombine) {
    // Determine shared BD-Video target from source FPS of first episode
    const firstFpsNum = parseFps(probeResults[0].rFrameRate || '24000/1001');
    const bdTarget   = selectHwResAndFps(firstFpsNum || 23.976, probeResults[0].height);
    const targetW    = bdTarget.w;
    const targetH    = bdTarget.h;
    const targetFps  = getBdFpsFraction(bdTarget.fps);
    const targetFpsNum = bdTarget.fps;
    const gopSize    = Math.round(targetFpsNum);
    const targetLevel = targetH <= 480 ? '3.1' : targetH <= 720 ? '4.0' : '4.1';
    const targetBrV   = targetH <= 720 ? '8000k'  : '15000k';
    const targetMaxR  = targetH <= 720 ? '15000k' : '25000k';
    const targetBufS  = targetH <= 720 ? '20000k' : '30000k';
    sendLog(`[NORMALIZE] Shared target: ${targetW}x${targetH} @ ${targetFps}, H.264 high L${targetLevel}, AC3 640k 48kHz stereo`);
    sendLog(`[NORMALIZE] Audio: selecting track 1 of ${probeResults[0].audioCount ?? '?'} (first track only — one audio track per episode for clean concat)`);

    const normalizedFiles = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      sendLog(`[NORMALIZE] Episode ${i + 1} of ${files.length}: ${f.name}`);
      const normPath = path.join(combineDir, `norm_${i}_${Date.now()}.ts`);
      const normResult = await new Promise(resolve => {
        const proc = spawn(TOOLS.ffmpeg, [
          '-y', '-i', f.path,
          '-map', '0:v:0', '-map', '0:a:0',
          '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', targetLevel,
          '-pix_fmt', 'yuv420p',
          '-crf', '20',
          '-vf', `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,fps=${targetFps}`,
          '-g', String(gopSize), '-keyint_min', String(gopSize), '-sc_threshold', '0', '-bf', '3', '-refs', '4',
          '-maxrate', targetMaxR, '-bufsize', targetBufS,
          '-c:a', 'ac3', '-b:a', '640k', '-ar', '48000', '-ac', '2',
          normPath,
        ]);
        let stderr = '';
        proc.stderr.on('data', d => {
          const line = d.toString();
          stderr += line;
          if (line.includes('time=') || line.includes('size=')) sendLog('[NORMALIZE] ' + line.trim());
        });
        proc.on('close', code => {
          if (code === 0) resolve({ success: true, path: normPath });
          else resolve({ error: `ffmpeg normalize failed for episode ${i + 1} (exit ${code}):\n${stderr.slice(-600)}` });
        });
        proc.on('error', err => resolve({ error: 'ffmpeg error: ' + err.message }));
      });
      if (normResult.error) return normResult;
      normalizedFiles.push({ path: normPath, name: f.name });
    }
    sourceFiles = normalizedFiles;
  }

  const concatListPath = path.join(combineDir, 'concat_list.txt');
  const concatLines = sourceFiles.map(f => `file '${f.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(concatListPath, concatLines.join('\n') + '\n');

  const combinedName = 'combined_' + Date.now() + '.ts';
  const combinedPath = path.join(combineDir, combinedName);

  sendLog('[COMBINE] Running ffmpeg concat…');
  const concatResult = await new Promise(resolve => {
    const proc = spawn(TOOLS.ffmpeg, [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      combinedPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => {
      const line = d.toString();
      stderr += line;
      if (line.includes('time=') || line.includes('size=')) sendLog('[COMBINE] ' + line.trim());
    });
    proc.on('close', code => {
      if (code === 0) resolve({ success: true });
      else resolve({ error: `ffmpeg concat failed (exit ${code}):\n${stderr.slice(-600)}` });
    });
    proc.on('error', err => resolve({ error: 'ffmpeg error: ' + err.message }));
  });

  if (concatResult.error) return concatResult;

  const episodes = files.map((f, i) => ({
    path: f.path,
    name: f.name.replace(/\.[^.]+$/, ''),
    duration: durations[i],
  }));

  const chapters = [];
  let cumSecs = 0;
  episodes.forEach((ep, i) => {
    const h = Math.floor(cumSecs / 3600);
    const m = Math.floor((cumSecs % 3600) / 60);
    const s = Math.floor(cumSecs % 60);
    chapters.push({
      name: 'Episode ' + (i + 1),
      time: String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0'),
    });
    cumSecs += ep.duration;
  });

  sendLog(`[COMBINE] Done — ${files.length} episodes → ${combinedPath}`);
  sendLog(`[COMBINE] Created one Blu-ray-safe main feature from ${files.length} episodes.`);
  if (normalizeBeforeCombine) sendLog('[COMBINE] Episodes were normalized before combining.');
  sendLog('[COMBINE] Episode starts were added as chapter markers.');
  sendLog('[COMBINE] This is not a separate-title TV Blu-ray.');
  return { success: true, combinedPath, combinedName, episodes, chapters };
});

// ── Chapter metadata file (FFMETADATA format) ────────────────────────────────

function buildChapterMetaFile(project, workDir) {
  const chapFile = path.join(workDir, 'chapters.ffmeta');
  const lines = [';FFMETADATA1', ''];
  project.chapters.forEach((c, i) => {
    const startMs = timeToMs(c.time);
    const endMs   = i + 1 < project.chapters.length ? timeToMs(project.chapters[i+1].time) - 1 : startMs + 300000;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${endMs}`, `title=${c.name}`, '');
  });
  fs.writeFileSync(chapFile, lines.join('\n'));
  return chapFile;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function runFFmpeg(args, resolve, reject) {
  const proc = spawn(TOOLS.ffmpeg, args);
  let stderr = '';
  proc.stderr.on('data', d => {
    const line = d.toString();
    stderr += line;
    if (line.includes('time=') || line.includes('frame=') || line.includes('size=')) {
      sendLog(line.trim());
    }
  });
  proc.on('close', code => {
    if (code === 0) resolve();
    else reject(new Error(`FFmpeg exited ${code}:\n${stderr.slice(-600)}`));
  });
  proc.on('error', err => reject(new Error(`FFmpeg not found: ${err.message}`)));
}

function sendLog(msg) {
  try { require('fs').appendFileSync(require('os').homedir() + '/Desktop/disc_forge_log.txt', msg + '\n'); } catch(_) {}
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-progress', msg);
    }
  } catch(_) {}
}

function progress(step, label, detail) {
  mainWindow?.webContents.send('build-progress', { step, label, detail });
}
function fmtBytes(bytes) {
  if (bytes >= 1e9) return (bytes/1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes/1e6).toFixed(1) + ' MB';
  return Math.round(bytes/1024) + ' KB';
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function sanitize(str) {
  return String(str).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 50);
}

function langCode(language) {
  const map = {
    English:'eng', French:'fra', Spanish:'spa', German:'deu', Italian:'ita',
    Portuguese:'por', Japanese:'jpn', Korean:'kor', Mandarin:'zho', Cantonese:'yue',
    Russian:'rus', Arabic:'ara', Hindi:'hin', Dutch:'nld', Swedish:'swe',
    Norwegian:'nor', Danish:'dan', Finnish:'fin', Polish:'pol', Czech:'ces',
    Hungarian:'hun', Romanian:'ron', Turkish:'tur', Greek:'ell', Hebrew:'heb',
    Thai:'tha', Vietnamese:'vie', Indonesian:'ind', Malay:'msa',
  };
  return map[language] || 'und';
}

function timeToMs(t) {
  if (!t) return 0;
  const p = t.split(':').map(Number);
  if (p.length === 3) return ((p[0]*3600)+(p[1]*60)+p[2])*1000;
  if (p.length === 2) return ((p[0]*60)+p[1])*1000;
  return p[0]*1000;
}

// ── Multi-title navigation fix ────────────────────────────────────────────────
// Extends tsMuxeR-generated MovieObject.bdmv and index.bdmv to register N
// episode titles.  Episode 1 is at playlist 00001.mpls (PlayList ID 1).
// Episodes 2..N are at 00002.mpls .. 000N.mpls (IDs 2..N).
//
// tsMuxeR's single-title BDMV already has 3 objects:
//   obj[0]: first-play (chains to obj[2])
//   obj[1]: chapter/menu handler
//   obj[2]: PlayPL(X) — X is 0 if tsMuxeR used 00000.mpls, 1 if it used 00001.mpls
//
// We always want obj[2] to reference playlist 1 (00001.mpls = episode 1 final).
// Then we add objects 3..N+1 for episodes 2..N, each PlayPL(i).
// index.bdmv gets N-1 additional title entries pointing to these new objects.

function fixMultiTitleNavigationForEpisodes(bdFolder, numEpisodes, ep1TsMuxerPrefix, ep1BdTarget) {
  if (numEpisodes <= 1) return;

  const mobjPath  = path.join(bdFolder, 'BDMV', 'MovieObject.bdmv');
  const indexPath = path.join(bdFolder, 'BDMV', 'index.bdmv');
  const backDir   = path.join(bdFolder, 'BDMV', 'BACKUP');
  const N = numEpisodes;

  if (!fs.existsSync(mobjPath) || !fs.existsSync(indexPath)) {
    sendLog('[MT] fixNav: navigation files not found — skipping');
    return;
  }

  const verifyWrite = (label, expectedBuf, filePath) => {
    const actual = fs.readFileSync(filePath);
    if (actual.length !== expectedBuf.length) {
      sendLog(`[MT] fixNav: VERIFY FAIL ${label} — size mismatch: expected ${expectedBuf.length}, got ${actual.length}`);
      return false;
    }
    const mismatches = [];
    for (let i = 0; i < expectedBuf.length; i++) {
      if (actual[i] !== expectedBuf[i]) {
        mismatches.push(`  byte ${i}: expected 0x${expectedBuf[i].toString(16).padStart(2,'0')}, got 0x${actual[i].toString(16).padStart(2,'0')}`);
        if (mismatches.length > 20) break;
      }
    }
    if (mismatches.length === 0) {
      sendLog(`[MT] fixNav: VERIFY OK ${label} — ${expectedBuf.length} bytes match disk`);
      return true;
    }
    sendLog(`[MT] fixNav: VERIFY FAIL ${label} — ${mismatches.length} byte mismatches:\n${mismatches.join('\n')}`);
    return false;
  };

  const videoFormatMap = { 480: 3, 576: 7, 720: 5, 1080: 6 };
  const frameRateMap = (fps) => {
    if (Math.abs(fps - 23.976) < 0.05) return 1;
    if (Math.abs(fps - 24) < 0.05)     return 2;
    if (Math.abs(fps - 25) < 0.05)     return 3;
    if (Math.abs(fps - 29.97) < 0.05)  return 4;
    if (Math.abs(fps - 50) < 0.05)     return 6;
    if (Math.abs(fps - 59.94) < 0.05)  return 7;
    return 1;
  };

  // ── 1. MovieObject.bdmv: patch obj[2] to PlayPL(1), append N-1 new objects ──
  // tsMuxeR generates obj[0] first-play, obj[1] chapter handler, obj[2] PlayPL(0).
  // The merge step renames EP1's playlist 00000.mpls → 00001.mpls, so PlayPL(0)
  // now points at nothing. Patch obj[2] to PlayPL(1) = EP1, then append N-1 new
  // objects for EP2..EPN (PlayPL(2)..PlayPL(N)). tsMuxeR's existing Title 1 →
  // obj[2] covers EP1; we only add entries for EP2..EPN.
  const mobjBuf = Buffer.from(fs.readFileSync(mobjPath));
  sendLog(`[MT] fixNav: MovieObject.bdmv before — ${mobjBuf.length} bytes:\n${dumpHex(mobjBuf)}`);

  const MOBJ_STRUCT_OFF = 40;
  const NUM_OBJS_OFF    = 48;

  const mobjLength = mobjBuf.readUInt32BE(MOBJ_STRUCT_OFF);
  const numObjs    = mobjBuf.readUInt16BE(NUM_OBJS_OFF);

  // Walk objects to find obj[2] — the PlayPL template; track its buffer position
  let pos = NUM_OBJS_OFF + 2;
  let templateObjBytes = null;
  let obj2Pos = 0;
  for (let i = 0; i < numObjs; i++) {
    const numCmds = mobjBuf.readUInt16BE(pos + 2);
    const objSize = 4 + numCmds * 12;
    if (i === 2) { templateObjBytes = mobjBuf.slice(pos, pos + objSize); obj2Pos = pos; }
    pos += objSize;
  }

  if (!templateObjBytes) {
    sendLog(`[MT] fixNav: expected ≥3 movie objects, found ${numObjs} — skipping`);
    return;
  }

  const tmplNumCmds = templateObjBytes.readUInt16BE(2);
  const lastCmdOff  = 4 + (tmplNumCmds - 1) * 12;
  const playPlW0    = templateObjBytes.readUInt32BE(lastCmdOff);
  const playPlW1    = templateObjBytes.readUInt32BE(lastCmdOff + 4);

  if (playPlW0 !== 0x21810000 || playPlW1 !== 0) {
    sendLog(`[MT] fixNav: template obj[2] last cmd unexpected (w0=0x${playPlW0.toString(16)} w1=${playPlW1}) — skipping`);
    return;
  }

  // Patch obj[2]: PlayPL(0) → PlayPL(1) because EP1's playlist was renamed during merge
  mobjBuf.writeUInt32BE(1, obj2Pos + lastCmdOff + 4);
  sendLog('[MT] fixNav: patched obj[2] PlayPL(0) → PlayPL(1) (EP1 mpls renamed during merge)');
  sendLog(`[MT] fixNav: obj[2] post-patch bytes ${obj2Pos}–${obj2Pos + templateObjBytes.length - 1}: ${mobjBuf.slice(obj2Pos, obj2Pos + templateObjBytes.length).toString('hex')}`);

  // Append N-1 new objects for EP2..EPN: PlayPL(2), PlayPL(3), ..., PlayPL(N)
  const newObjBufs = [];
  for (let i = 0; i < N - 1; i++) {
    const playlistId = i + 2;  // EP2..EPN
    const newObj = Buffer.from(templateObjBytes);
    newObj.writeUInt32BE(playlistId, lastCmdOff + 4);
    newObjBufs.push(newObj);
    sendLog(`[MT] fixNav: mobj obj[${numObjs + i}] → PlayPL(${playlistId})`);
  }

  const totalNewObjBytes = newObjBufs.reduce((s, b) => s + b.length, 0);
  const newMobjBuf = Buffer.concat([mobjBuf, ...newObjBufs]);
  newMobjBuf.writeUInt32BE(mobjLength + totalNewObjBytes, MOBJ_STRUCT_OFF);
  newMobjBuf.writeUInt16BE(numObjs + (N - 1), NUM_OBJS_OFF);

  fs.writeFileSync(mobjPath, newMobjBuf);
  verifyWrite('MovieObject.bdmv', newMobjBuf, mobjPath);
  sendLog(`[MT] fixNav: MovieObject.bdmv ${numObjs}→${numObjs + (N - 1)} objects, ${mobjBuf.length}→${newMobjBuf.length} bytes`);
  sendLog(`[MT] fixNav: MovieObject.bdmv after — ${newMobjBuf.length} bytes:\n${dumpHex(newMobjBuf)}`);

  // ── 2. index.bdmv: read tsMuxeR file, append N-1 title entries ─────────────
  // tsMuxeR's existing Title 1 → obj[2] covers EP1. Add entries for EP2..EPN only.
  const idxBuf       = Buffer.from(fs.readFileSync(indexPath));
  sendLog(`[MT] trace: idxBuf[46] post-read = 0x${idxBuf[46].toString(16).padStart(2,'0')}`);
  sendLog(`[MT] fixNav: index.bdmv before — ${idxBuf.length} bytes:\n${dumpHex(idxBuf)}`);

  // Patch AppInfoBD video_format and frame_rate (tsMuxeR leaves these zeroed)
  if (ep1BdTarget) {
    const vf = videoFormatMap[ep1BdTarget.h] || 6;
    const fr = frameRateMap(ep1BdTarget.fps);
    const APPINFO_BYTE_46 = 46;
    idxBuf[APPINFO_BYTE_46] = (vf << 4) | (fr & 0x0f);
    sendLog(`[MT] trace: idxBuf[46] post-AppInfoBD-patch = 0x${idxBuf[46].toString(16).padStart(2,'0')}`);
    sendLog(`[MT] fixNav: AppInfoBD patched — video_format=${vf} (${ep1BdTarget.h}p), frame_rate=${fr} (${ep1BdTarget.fps}), byte 46 = 0x${idxBuf[APPINFO_BYTE_46].toString(16).padStart(2, '0')}`);
  }

  const idxStart     = idxBuf.readUInt32BE(8);   // IndexesStartAddress
  const idxLen       = idxBuf.readUInt32BE(idxStart);
  const idxDataStart = idxStart + 4;

  const NUM_TITLES_OFF = idxDataStart + 8;
  const TITLES_OFF     = idxDataStart + 10;

  const curNumTitles = idxBuf.readUInt16BE(NUM_TITLES_OFF);
  const newNumTitles = curNumTitles + N;

  const newEntries = Buffer.alloc(N * 4);
  // Entry 0: Title 1 → obj[2] (EP1, patched to PlayPL(1))
  newEntries[0] = 0x40;
  newEntries[1] = 0x00;
  newEntries.writeUInt16BE(2, 2);
  sendLog(`[MT] fixNav: index Title[${curNumTitles}] → MovieObject[2] (PlayPL(1) EP1)`);
  // Entries 1..N-1: Title 2..N → new objects for EP2..EPN
  for (let i = 1; i < N; i++) {
    const movieObjIdx = numObjs + (i - 1);
    newEntries[i * 4 + 0] = 0x40;
    newEntries[i * 4 + 1] = 0x00;
    newEntries.writeUInt16BE(movieObjIdx, i * 4 + 2);
    sendLog(`[MT] fixNav: index Title[${curNumTitles + i}] → MovieObject[${movieObjIdx}] (PlayPL(${i + 1}))`);
  }

  const remainingSlots = Math.floor((idxLen - 10 - curNumTitles * 4) / 4);
  sendLog(`[MT] trace: idxLen=${idxLen} (0x${idxLen.toString(16)}), curNumTitles=${curNumTitles}, N=${N}, remainingSlots=${remainingSlots}, branch=${N <= remainingSlots ? 'slot-fits' : 'extend'}`);
  let newIdxBuf;
  if (N <= remainingSlots) {
    newIdxBuf = Buffer.from(idxBuf);
    sendLog(`[MT] trace: newIdxBuf[46] post-clone (slot-fits branch) = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}, idxBuf[46] = 0x${idxBuf[46].toString(16).padStart(2,'0')}`);
    newIdxBuf.writeUInt16BE(newNumTitles, NUM_TITLES_OFF);
    sendLog(`[MT] trace: newIdxBuf[46] post-numTitles-write = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}`);
    newEntries.copy(newIdxBuf, TITLES_OFF + curNumTitles * 4);
    sendLog(`[MT] trace: newIdxBuf[46] post-entries-copy = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}`);
  } else {
    const extraBytes = (N - remainingSlots) * 4;
    newIdxBuf = Buffer.concat([idxBuf, Buffer.alloc(extraBytes)]);
    sendLog(`[MT] trace: newIdxBuf[46] post-concat (extend branch) = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}, idxBuf[46] = 0x${idxBuf[46].toString(16).padStart(2,'0')}`);
    newIdxBuf.writeUInt32BE(idxLen + extraBytes, idxStart);
    newIdxBuf.writeUInt16BE(newNumTitles, NUM_TITLES_OFF);
    sendLog(`[MT] trace: newIdxBuf[46] post-numTitles-write = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}`);
    newEntries.copy(newIdxBuf, TITLES_OFF + curNumTitles * 4);
    sendLog(`[MT] trace: newIdxBuf[46] post-entries-copy = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}`);
    sendLog(`[MT] fixNav: extended index.bdmv by ${extraBytes} bytes`);
  }

  sendLog(`[MT] trace: newIdxBuf[46] pre-write = 0x${newIdxBuf[46].toString(16).padStart(2,'0')}`);

  // Redirect FirstPlay from obj[0] → obj[2] to bypass tsMuxeR's obj[0] which hangs LG players
  const firstPlayMobjRefOff = idxDataStart + 2;  // idxStart+4 (FirstPlay entry) +2 (mobj_id_ref)
  newIdxBuf.writeUInt16BE(2, firstPlayMobjRefOff);
  sendLog(`[MT] fixNav: index FirstPlay obj[0] → obj[2] (bypass tsMuxeR obj[0], play EP1 directly)`);

  fs.writeFileSync(indexPath, newIdxBuf);
  verifyWrite('index.bdmv', newIdxBuf, indexPath);
  const fpBytes = newIdxBuf.slice(idxDataStart, idxDataStart + 4);
  sendLog(`[MT] fixNav: index FirstPlay bytes [${idxDataStart}..${idxDataStart+3}] = ${fpBytes.toString('hex')} (flags=0x${fpBytes.readUInt16BE(0).toString(16).padStart(4,'0')} mobj_id_ref=0x${fpBytes.readUInt16BE(2).toString(16).padStart(4,'0')})`);
  sendLog(`[MT] fixNav: index.bdmv NumberOfTitles ${curNumTitles}→${newNumTitles}, ${idxBuf.length}→${newIdxBuf.length} bytes`);
  sendLog(`[MT] fixNav: index.bdmv after — ${newIdxBuf.length} bytes:\n${dumpHex(newIdxBuf)}`);

  // ── 3. BACKUP copies ────────────────────────────────────────────────────────
  if (fs.existsSync(backDir)) {
    try {
      fs.copyFileSync(mobjPath,  path.join(backDir, 'MovieObject.bdmv'));
      fs.copyFileSync(indexPath, path.join(backDir, 'index.bdmv'));
      verifyWrite('BACKUP/MovieObject.bdmv', newMobjBuf, path.join(backDir, 'MovieObject.bdmv'));
      verifyWrite('BACKUP/index.bdmv', newIdxBuf, path.join(backDir, 'index.bdmv'));
      sendLog('[MT] fixNav: BACKUP copies updated');
    } catch (_) {}
  }

  // Post-write structural validation — abort the build if disc structure is wrong
  const onDisk = fs.readFileSync(indexPath);
  const errors = [];

  if (onDisk.slice(0, 4).toString('ascii') !== 'INDX') errors.push('INDX magic missing');
  if (onDisk.slice(4, 8).toString('ascii') !== '0200') errors.push('version != 0200');
  if (onDisk.readUInt32BE(12) !== 0) errors.push(`ExtensionDataStartAddress = ${onDisk.readUInt32BE(12)}, expected 0`);

  if (ep1BdTarget) {
    const expectedVfFr = ((videoFormatMap[ep1BdTarget.h] || 6) << 4) | (frameRateMap(ep1BdTarget.fps) & 0x0f);
    if (onDisk[46] !== expectedVfFr) {
      errors.push(`AppInfoBD byte 46 on disk = 0x${onDisk[46].toString(16).padStart(2,'0')}, expected 0x${expectedVfFr.toString(16).padStart(2,'0')}`);
    }
  }

  const onDiskIdxStart = onDisk.readUInt32BE(8);
  const NUM_TITLES_ON_DISK = onDisk.readUInt16BE(onDiskIdxStart + 4 + 8);
  if (NUM_TITLES_ON_DISK !== N) {
    errors.push(`NumberOfTitles on disk = ${NUM_TITLES_ON_DISK}, expected ${N}`);
  }

  if (errors.length > 0) {
    const errMsg = `index.bdmv post-write validation failed:\n${errors.map(e => '  • ' + e).join('\n')}`;
    sendLog(`[MT] fixNav: VALIDATION FAIL — ${errMsg}`);
    throw new Error(errMsg);
  }
  sendLog(`[MT] fixNav: post-write validation passed`);
}

// ── IPC: build multi-title disc ───────────────────────────────────────────────
// Each episode becomes a separately selectable title on the disc.
// Pipeline per episode: FFmpeg (libx264/AC3) → mkvmerge → tsMuxeR (--blu-ray)
// Then merge all BDMV outputs and fix navigation.

ipcMain.handle('build-multi-title-disc', async (_, { episodes, outputDir, discName, fastEncode }) => {
  if (!TOOLS.ffmpeg)   return { error: 'FFmpeg not found.\n\nInstall: brew install ffmpeg' };
  if (!TOOLS.tsmuxer)  return { error: 'tsMuxeR not found.\n\nInstall: brew install --cask tsmuxer' };
  if (!TOOLS.mkvmerge) return { error: 'mkvmerge not found.\n\nInstall: brew install mkvtoolnix' };
  if (!episodes || episodes.length < 2) return { error: 'Need at least 2 episode files.' };

  for (const ep of episodes) {
    if (!ep.path || !fs.existsSync(ep.path)) {
      return { error: `Episode file not found:\n${ep.path || '(no path)'}` };
    }
  }

  const homeDir  = os.homedir();
  const outDir   = (outputDir && outputDir.length > 1) ? outputDir : path.join(homeDir, 'Desktop');
  const name     = sanitize(discName || 'Episodes');
  let project_navRefDir = null;
  const tempBase = fs.existsSync(outDir) ? outDir : os.tmpdir();
  const workDir  = path.join(tempBase, `discforge_mt_${Date.now()}`);
  const bdFolder = path.join(workDir, 'BDMV_ROOT');
  const isoPath  = path.join(outDir, `${name}.iso`);

  // ── Pre-flight 1: ISO method ───────────────────────────────────────────────
  if (bestIsoMethod === null) await probeIsoMethod();
  if (bestIsoMethod === null) {
    return { error: 'No ISO tool available.\n\nInstall xorriso: brew install xorriso' };
  }
  sendLog(`[MT] Pre-flight: ISO method OK — ${bestIsoMethod}`);

  // ── Pre-flight 2: disk space ───────────────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    const totalInputBytes = episodes.reduce((sum, ep) => {
      try { return sum + fs.statSync(ep.path).size; } catch(_) { return sum; }
    }, 0);
    const neededBytes = totalInputBytes * 2.5;
    const dfOut = execSync(`df -k "${outDir}" 2>/dev/null || df -k "${homeDir}"`).toString();
    const dfLine = dfOut.trim().split('\n').pop();
    const availKb = parseInt(dfLine.trim().split(/\s+/)[3]) || 0;
    const availBytes = availKb * 1024;
    const availGb  = (availBytes  / 1e9).toFixed(1);
    const neededGb = (neededBytes / 1e9).toFixed(1);
    sendLog(`[MT] Pre-flight: disk space — ${availGb} GB available, ${neededGb} GB estimated needed`);
    if (availBytes < neededBytes) {
      return { error: `Not enough disk space.\n\nAvailable: ${availGb} GB\nEstimated needed: ${neededGb} GB\n\nFree up space on your drive and try again.` };
    }
  } catch(_) {}

  // ── Pre-flight 3: estimated output size vs BD media capacity ──────────────
  // fastEncode: videotoolbox target 15000k (1080p) / 8000k (720p).
  // CRF20:      ~10 Mbps (1080p), ~6 Mbps (720p), ~3 Mbps (480p). +AC3 640 kbps.
  try {
    let totalEstBytes = 0;
    for (const ep of episodes) {
      const dur = getVideoDuration(ep.path);
      const res = detectResolution(ep.path);
      const h   = res.h || 1080;
      const videoBitrate = fastEncode
        ? (h > 720 ? 15e6 : 8e6)
        : (h > 720 ? 10e6 : h > 480 ? 6e6 : 3e6);
      totalEstBytes += (videoBitrate + 640e3) / 8 * dur;
    }
    const estGb = (totalEstBytes / 1e9).toFixed(1);
    sendLog(`[MT] Pre-flight: estimated output size ~${estGb} GB`);
    if (totalEstBytes > 47e9) {
      sendLog(`[MT] Pre-flight: WARNING — estimated size (${estGb} GB) exceeds BD-50 capacity (47 GB). Disc may not fit on a single BD-50.`);
    } else if (totalEstBytes > 23e9) {
      sendLog(`[MT] Pre-flight: WARNING — estimated size (${estGb} GB) exceeds BD-25 capacity (23 GB). Use a BD-50 disc.`);
    }
  } catch(_) {}

  try {
    fs.mkdirSync(workDir,  { recursive: true });
    fs.mkdirSync(bdFolder, { recursive: true });
    fs.mkdirSync(outDir,   { recursive: true });
  } catch(e) {
    return { error: `Cannot create working directories:\n${e.message}` };
  }

  sendLog(`[MT] ─────────────────────────────────────────`);
  sendLog(`[MT] Multi-title disc: ${episodes.length} episodes`);
  sendLog(`[MT] workDir:   ${workDir}`);
  sendLog(`[MT] bdFolder:  ${bdFolder}`);
  sendLog(`[MT] isoPath:   ${isoPath}`);
  if (fastEncode) {
    sendLog('[MT] WARNING: fastEncode selected — h264_videotoolbox (experimental). VideoToolbox ignores -sc_threshold and -refs; output SPS/PPS may not pass strict BD compliance checks.');
  }

  const pad = n => String(n).padStart(5, '0');
  const epBdFolders = [];

  // ── Per-episode pipeline ────────────────────────────────────────────────────
  let ep1BdTarget = null;
  for (let i = 0; i < episodes.length; i++) {
    const ep    = episodes[i];
    const epNum = i + 1;
    const epDir   = path.join(workDir, `ep${epNum}`);
    const epTsDir = path.join(epDir, 'ts');
    const epBdOut = path.join(epDir, 'BDMV_OUT');

    fs.mkdirSync(epTsDir, { recursive: true });
    fs.mkdirSync(epBdOut, { recursive: true });

    sendLog(`[MT] ── Episode ${epNum}: ${path.basename(ep.path)}`);
    progress(i * 4, `Episode ${epNum}/${episodes.length}: encoding video`);

    // Probe source for resolution + FPS
    const srcFps    = parseFloat(getVideoFps(ep.path));
    const srcRes    = detectResolution(ep.path);
    const bdTarget  = selectHwResAndFps(srcFps, srcRes.h);
    bdTarget.w = 1920; bdTarget.h = 1080; // Force 1080p — 480p BDs rejected by Xbox/LG
    sendLog(`[MT] EP${epNum}: forcing 1080p output (source was ${srcRes.w}x${srcRes.h}, target 1920x1080 with letterbox/pillarbox)`);
    if (i === 0) ep1BdTarget = bdTarget;
    const safeW     = bdTarget.w, safeH = bdTarget.h;
    const safeFps   = getBdFpsFraction(bdTarget.fps);
    const level     = safeH <= 480 ? '3.1' : safeH <= 720 ? '4.0' : '4.1';
    const gopSize   = Math.round(bdTarget.fps || 24);
    const maxrateK  = safeH <= 720 ? '15000k' : '25000k';
    const bufsizeK  = safeH <= 720 ? '20000k' : '30000k';
    sendLog(`[MT] EP${epNum}: source ${srcRes.w}×${srcRes.h}@${srcFps.toFixed(3)} → BD ${safeW}×${safeH}@${safeFps}`);

    const mainTs    = path.join(epTsDir, 'main.ts');
    const mainBdMkv = path.join(epDir, 'main_bd.mkv');

    // Warn about tracks that will be silently dropped by '-map 0:v:0 -map 0:a:0'
    if (TOOLS.ffprobe) {
      try {
        const { execFileSync } = require('child_process');
        const probeOut = execFileSync(
          TOOLS.ffprobe,
          ['-v', 'quiet', '-print_format', 'json', '-show_streams', ep.path],
          { encoding: 'utf8', timeout: 15000 }
        );
        const streams   = JSON.parse(probeOut).streams || [];
        const numAudio  = streams.filter(s => s.codec_type === 'audio').length;
        const numSubs   = streams.filter(s => s.codec_type === 'subtitle').length;
        if (numAudio > 1) {
          sendLog(`[MT] EP${epNum}: WARNING — source has ${numAudio} audio tracks, 1 included`);
        }
        if (numSubs > 0) {
          sendLog(`[MT] EP${epNum}: WARNING — source has ${numSubs} subtitle track${numSubs > 1 ? 's' : ''}, 0 included`);
        }
      } catch (_) {}
    }

    // Step A: FFmpeg → main.ts
    const ffArgs = ['-y', '-i', ep.path,
      '-map', '0:v:0', '-map', '0:a:0',
      ...(fastEncode
        ? ['-c:v', 'h264_videotoolbox', '-realtime', '0', '-profile:v', 'high',
           '-level', level, '-pix_fmt', 'yuv420p',
           '-g', String(gopSize), '-keyint_min', String(gopSize),
           '-sc_threshold', '0', '-bf', '3', '-refs', '4',
           '-b:v', safeH > 720 ? '15000k' : '8000k', '-maxrate', maxrateK, '-bufsize', bufsizeK]
        : ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high',
           '-level', level, '-pix_fmt', 'yuv420p',
           '-crf', '20',
           '-g', String(gopSize), '-keyint_min', String(gopSize),
           '-sc_threshold', '0', '-bf', '3', '-refs', '4',
           '-maxrate', maxrateK, '-bufsize', bufsizeK]),
    ];
    sendLog(`[MT] EP${epNum}: ${fastEncode ? 'h264_videotoolbox (experimental fast encode)' : 'libx264 Blu-ray-safe CRF20'} L${level}`);
    const needsScale = srcRes.w !== safeW || srcRes.h !== safeH;
    const vfParts = [];
    if (needsScale) vfParts.push(`scale=${safeW}:${safeH}:force_original_aspect_ratio=decrease,pad=${safeW}:${safeH}:(ow-iw)/2:(oh-ih)/2:black`);
    if (safeFps) vfParts.push(`fps=${safeFps}`);
    if (vfParts.length) ffArgs.push('-vf', vfParts.join(','));
    ffArgs.push('-c:a', 'ac3', '-b:a', '640k',
      '-f', 'mpegts', '-mpegts_flags', 'system_b', mainTs);

    const dur = getVideoDuration(ep.path);
    if (dur > 0) sendLog(`__CRF_START:${Math.round(dur)}`);

    const ffResult = await new Promise(resolve => {
      const ff = spawn(TOOLS.ffmpeg, ffArgs);
      let stderr = '';
      ff.stderr.on('data', d => {
        const l = d.toString(); stderr += l;
        if (l.includes('time=') || l.includes('frame=') || l.includes('size=')) sendLog(l.trim());
      });
      ff.on('close', code => resolve(code === 0 ? null : `EP${epNum} FFmpeg failed (${code}):\n${stderr.slice(-500)}`));
      ff.on('error', err => resolve(`EP${epNum} FFmpeg error: ${err.message}`));
    });
    if (ffResult) { cleanup(workDir); return { error: ffResult }; }
    sendLog(`[MT] EP${epNum}: main.ts ${(fs.statSync(mainTs).size/1e6).toFixed(1)} MB`);

    // Step B: mkvmerge → main_bd.mkv
    progress(i * 4 + 1, `Episode ${epNum}/${episodes.length}: mkvmerge`);
    const mkvResult = await new Promise(resolve => {
      const mkv = spawn(TOOLS.mkvmerge, ['-o', mainBdMkv, mainTs]);
      mkv.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      mkv.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      mkv.on('close', code => resolve((code === 0 || code === 1) && fs.existsSync(mainBdMkv) ? null : `EP${epNum} mkvmerge failed (${code})`));
      mkv.on('error', err => resolve(`EP${epNum} mkvmerge error: ${err.message}`));
    });
    if (mkvResult) { cleanup(workDir); return { error: mkvResult }; }
    sendLog(`[MT] EP${epNum}: main_bd.mkv ${(fs.statSync(mainBdMkv).size/1e6).toFixed(1)} MB`);

    // Step C: write tsMuxeR meta
    const metaFile  = path.join(epDir, 'tsmuxer.meta');
    const metaLines = [
      'MUXOPT --blu-ray --new-audio-pes',
      `V_MPEG4/ISO/AVC, "${tsPath(mainBdMkv)}", fps=${fpsToTsMuxer(safeFps)}, insertSEI, contSPS, track=1`,
      `A_AC3, "${tsPath(mainBdMkv)}", lang=und, track=2, default`,
    ];
    fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');
    try { fs.writeFileSync(require('os').homedir() + '/Desktop/last_mt_episode.meta', metaLines.join('\n') + '\n'); } catch {}
    sendLog(`[MT] EP${epNum} meta:\n${metaLines.map(l => '  ' + l).join('\n')}`);

    // Step D: run tsMuxeR
    progress(i * 4 + 2, `Episode ${epNum}/${episodes.length}: tsMuxeR`);
    const tsResult = await new Promise(resolve => {
      sendLog(`[MT] EP${epNum} tsMuxeR: "${metaFile}" → "${epBdOut}"`);
      const ts = spawn(TOOLS.tsmuxer, [metaFile, epBdOut]);
      ts.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      ts.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      ts.on('close', code => {
        if (code !== 0) return resolve(`EP${epNum} tsMuxeR failed (exit ${code})`);
        const streamDir = path.join(epBdOut, 'BDMV', 'STREAM');
        const files = fs.existsSync(streamDir) ? fs.readdirSync(streamDir) : [];
        sendLog(`[MT] EP${epNum} STREAM/: ${files.join(', ')}`);
        const playDir = path.join(epBdOut, 'BDMV', 'PLAYLIST');
        const plFiles = fs.existsSync(playDir) ? fs.readdirSync(playDir) : [];
        sendLog(`[MT] EP${epNum} PLAYLIST/: ${plFiles.join(', ')}`);
        const clipDir = path.join(epBdOut, 'BDMV', 'CLIPINF');
        const clFiles = fs.existsSync(clipDir) ? fs.readdirSync(clipDir) : [];
        sendLog(`[MT] EP${epNum} CLIPINF/: ${clFiles.join(', ')}`);
        if (!files.some(f => f.endsWith('.m2ts'))) return resolve(`EP${epNum} tsMuxeR produced no .m2ts output`);
        resolve(null);
      });
      ts.on('error', err => resolve(`EP${epNum} tsMuxeR error: ${err.message}`));
    });
    if (tsResult) { cleanup(workDir); return { error: tsResult }; }

    // Log MovieObject.bdmv hex for ep1 — helps debug nav command format
    if (epNum === 1) {
      const mobjPath = path.join(epBdOut, 'BDMV', 'MovieObject.bdmv');
      if (fs.existsSync(mobjPath)) {
        const buf = fs.readFileSync(mobjPath);
        sendLog(`[MT] EP1 MovieObject.bdmv ${buf.length} bytes, first 128 hex: ${buf.slice(0, 128).toString('hex')}`);
      }
      const idxPath = path.join(epBdOut, 'BDMV', 'index.bdmv');
      if (fs.existsSync(idxPath)) {
        const buf = fs.readFileSync(idxPath);
        sendLog(`[MT] EP1 index.bdmv ${buf.length} bytes, first 64 hex: ${buf.slice(0, 64).toString('hex')}`);
      }
    }

    epBdFolders.push(epBdOut);
    sendLog(`[MT] EP${epNum}: pipeline complete`);
  }

  // ── Step 2: Merge all episodes into one BDMV structure ──────────────────────
  progress(episodes.length * 4, `Merging ${episodes.length} episodes into BDMV`);
  sendLog('[MT] Merging BDMV structures…');

  const mergeDirs = ['BDMV/STREAM', 'BDMV/CLIPINF', 'BDMV/PLAYLIST', 'BDMV/BACKUP', 'CERTIFICATE'];
  mergeDirs.forEach(d => fs.mkdirSync(path.join(bdFolder, d), { recursive: true }));

  // Find which file prefix tsMuxeR used for this episode's output
  const findTsMuxerPrefix = epBd => {
    for (const n of ['00001', '00000']) {
      if (fs.existsSync(path.join(epBd, 'BDMV', 'STREAM', `${n}.m2ts`))) return n;
    }
    return null;
  };

  let ep1TsMuxerPrefix = null;

  for (let i = 0; i < episodes.length; i++) {
    const epNum  = i + 1;
    const epBd   = epBdFolders[i];
    const prefix = findTsMuxerPrefix(epBd);
    if (!prefix) { cleanup(workDir); return { error: `Episode ${epNum}: tsMuxeR produced no STREAM file` }; }
    if (epNum === 1) ep1TsMuxerPrefix = prefix;

    const dest = pad(epNum);  // '00001', '00002', …

    // STREAM
    const srcStream = path.join(epBd, 'BDMV', 'STREAM', `${prefix}.m2ts`);
    const dstStream = path.join(bdFolder, 'BDMV', 'STREAM', `${dest}.m2ts`);
    fs.copyFileSync(srcStream, dstStream);
    sendLog(`[MT] EP${epNum}: STREAM/${dest}.m2ts (${(fs.statSync(dstStream).size/1e6).toFixed(1)} MB)`);

    // CLIPINF — internal data is binary codec parameters, not ASCII clip refs; copy as-is
    const srcClpi = path.join(epBd, 'BDMV', 'CLIPINF', `${prefix}.clpi`);
    if (!fs.existsSync(srcClpi)) { cleanup(workDir); return { error: `Episode ${epNum}: no CLPI file found` }; }
    const dstClpi = path.join(bdFolder, 'BDMV', 'CLIPINF', `${dest}.clpi`);
    fs.copyFileSync(srcClpi, dstClpi);
    fs.copyFileSync(srcClpi, path.join(bdFolder, 'BDMV', 'BACKUP', `${dest}.clpi`));

    // PLAYLIST — patch clip reference from prefix to dest, then copy
    const srcMpls = path.join(epBd, 'BDMV', 'PLAYLIST', `${prefix}.mpls`);
    if (!fs.existsSync(srcMpls)) { cleanup(workDir); return { error: `Episode ${epNum}: no MPLS file found` }; }
    const dstMpls = path.join(bdFolder, 'BDMV', 'PLAYLIST', `${dest}.mpls`);
    if (prefix === dest) {
      fs.copyFileSync(srcMpls, dstMpls);
    } else {
      let buf   = fs.readFileSync(srcMpls);
      const from = Buffer.from(prefix + 'M2TS', 'ascii');
      const to   = Buffer.from(dest   + 'M2TS', 'ascii');
      let j = 0;
      while ((j = buf.indexOf(from, j)) !== -1) { to.copy(buf, j); j += from.length; }
      fs.writeFileSync(dstMpls, buf);
      sendLog(`[MT] EP${epNum}: patched MPLS clip ref ${prefix}→${dest}`);
    }
    fs.copyFileSync(dstMpls, path.join(bdFolder, 'BDMV', 'BACKUP', `${dest}.mpls`));
  }

  // Copy nav files from episode 1's tsMuxeR output (valid single-title BDMV base)
  const ep1Bd = epBdFolders[0];
  for (const navFile of ['index.bdmv', 'MovieObject.bdmv']) {
    const src = path.join(ep1Bd, 'BDMV', navFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(bdFolder, 'BDMV', navFile));
      try { fs.copyFileSync(src, path.join(bdFolder, 'BDMV', 'BACKUP', navFile)); } catch(_) {}
    }
  }
  sendLog('[MT] Copied nav files from EP1 tsMuxeR output');

  // ── Step 3: Fix navigation for N titles ────────────────────────────────────
  progress(episodes.length * 4 + 1, 'Patching navigation');

  // Stash pre-patch tsMuxeR nav files for offline diff
  try {
    const refDir = path.join(outDir, '_navref_' + Date.now());
    fs.mkdirSync(refDir, { recursive: true });
    fs.copyFileSync(path.join(epBdFolders[0], 'BDMV', 'index.bdmv'), path.join(refDir, 'tsmuxer_ep1_index.bdmv'));
    fs.copyFileSync(path.join(epBdFolders[0], 'BDMV', 'MovieObject.bdmv'), path.join(refDir, 'tsmuxer_ep1_MovieObject.bdmv'));
    sendLog(`[MT] Stashed pre-patch tsMuxeR nav files at ${refDir}`);
    project_navRefDir = refDir;
  } catch (e) {
    sendLog(`[MT] Could not stash pre-patch nav files: ${e.message}`);
  }

  fixMultiTitleNavigationForEpisodes(bdFolder, episodes.length, ep1TsMuxerPrefix, ep1BdTarget);

  // Stash post-patch nav files alongside the pre-patch ones
  try {
    if (project_navRefDir) {
      fs.copyFileSync(path.join(bdFolder, 'BDMV', 'index.bdmv'), path.join(project_navRefDir, 'patched_index.bdmv'));
      fs.copyFileSync(path.join(bdFolder, 'BDMV', 'MovieObject.bdmv'), path.join(project_navRefDir, 'patched_MovieObject.bdmv'));
      sendLog(`[MT] Stashed post-patch nav files at ${project_navRefDir}`);
    }
  } catch (e) {
    sendLog(`[MT] Could not stash post-patch nav files: ${e.message}`);
  }

  // ── Step 4: Validate structure ─────────────────────────────────────────────
  progress(episodes.length * 4 + 2, 'Validating disc structure');
  sendLog('[MT] Validation:');
  const errors = [];
  const chk = (label, ok) => { sendLog(`  ${ok?'✓':'✗'} ${label}`); if (!ok) errors.push(label); };

  chk('BDMV folder exists',           fs.existsSync(path.join(bdFolder, 'BDMV')));
  chk('CERTIFICATE folder exists',    fs.existsSync(path.join(bdFolder, 'CERTIFICATE')));
  chk('index.bdmv exists',            fs.existsSync(path.join(bdFolder, 'BDMV', 'index.bdmv')));
  chk('MovieObject.bdmv exists',      fs.existsSync(path.join(bdFolder, 'BDMV', 'MovieObject.bdmv')));
  chk('ISO method available',         bestIsoMethod !== null);

  const finalStreamDir  = path.join(bdFolder, 'BDMV', 'STREAM');
  const finalPlaylistDir = path.join(bdFolder, 'BDMV', 'PLAYLIST');
  const finalClipinfDir  = path.join(bdFolder, 'BDMV', 'CLIPINF');

  const m2tsFiles  = fs.existsSync(finalStreamDir)   ? fs.readdirSync(finalStreamDir).filter(f => f.endsWith('.m2ts'))  : [];
  const mplsFiles  = fs.existsSync(finalPlaylistDir) ? fs.readdirSync(finalPlaylistDir).filter(f => f.endsWith('.mpls')) : [];
  const clpiFiles  = fs.existsSync(finalClipinfDir)  ? fs.readdirSync(finalClipinfDir).filter(f => f.endsWith('.clpi'))  : [];

  sendLog(`[MT] STREAM/:   ${m2tsFiles.join(', ')}`);
  sendLog(`[MT] PLAYLIST/: ${mplsFiles.join(', ')}`);
  sendLog(`[MT] CLIPINF/:  ${clpiFiles.join(', ')}`);

  chk(`STREAM has ${episodes.length} .m2ts files (found ${m2tsFiles.length})`,   m2tsFiles.length === episodes.length);
  chk(`PLAYLIST has ${episodes.length} .mpls files (found ${mplsFiles.length})`, mplsFiles.length === episodes.length);
  chk(`CLIPINF has ${episodes.length} .clpi files (found ${clpiFiles.length})`,  clpiFiles.length === episodes.length);

  // Verify each mpls references the correct clip
  for (let i = 0; i < episodes.length; i++) {
    const clipId = pad(i + 1);
    const mplsPath = path.join(finalPlaylistDir, `${clipId}.mpls`);
    if (fs.existsSync(mplsPath)) {
      const buf = fs.readFileSync(mplsPath);
      const hasRef = buf.indexOf(Buffer.from(clipId, 'ascii')) !== -1;
      chk(`PLAYLIST/${clipId}.mpls references clip ${clipId}`, hasRef);
    }
  }

  if (errors.length > 0) {
    cleanup(workDir);
    return { error: `Disc validation failed:\n\n${errors.map(e => '  • ' + e).join('\n')}` };
  }
  sendLog('[MT] All validation checks passed');

  // ── Step 5: Create ISO ──────────────────────────────────────────────────────
  progress(episodes.length * 4 + 3, 'Packaging ISO');
  try {
    await packageISO(bdFolder, outDir, name);
  } catch(e) {
    cleanup(workDir);
    return { error: `ISO creation failed:\n${e.message}` };
  }

  cleanup(workDir);
  sendLog('[MT] ─────────────────────────────────────────');
  sendLog('[MT] Multi-title disc complete.');
  sendLog(`[MT] ISO: ${isoPath}`);
  sendLog(`[MT] ${episodes.length} episodes as separate selectable titles.`);
  sendLog(`[MT] Encode mode: ${fastEncode ? 'h264_videotoolbox (experimental fast encode)' : 'libx264 CRF20 (Blu-ray safe)'}`);
  sendLog('[MT] Each episode is accessible via the Title Selection button on your player.');
  sendLog('[MT] ─────────────────────────────────────────');

  const isoSize = fs.existsSync(isoPath) ? fs.statSync(isoPath).size : 0;
  mainWindow.webContents.send('build-progress', { done: true, isoPath, isoSize });
  return { success: true, isoPath };
});
