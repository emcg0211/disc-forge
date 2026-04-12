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
  hdiutil:  '/usr/bin/hdiutil',
  growisofs: findTool(['growisofs']),
};

// Friendly install instructions per tool
const TOOL_INSTALL = {
  ffmpeg:  'Install via Homebrew: brew install ffmpeg',
  ffprobe: 'Install via Homebrew: brew install ffmpeg (includes ffprobe)',
  tsmuxer: 'Download from github.com/justdan96/tsMuxeR or brew install --cask tsmuxer',
};

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

app.whenReady().then(() => {
  createWindow();
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
  ffmpeg:  { found: !!TOOLS.ffmpeg,  path: TOOLS.ffmpeg  },
  ffprobe: { found: !!TOOLS.ffprobe, path: TOOLS.ffprobe },
  tsmuxer: { found: !!TOOLS.tsmuxer, path: TOOLS.tsmuxer },
  makemkv: { found: !!TOOLS.makemkv, path: TOOLS.makemkv },
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

// ── IPC: detect BD compatibility (passthrough mode) ───────────────────────────

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
        const BD_VIDEO = new Set(['h264', 'hevc', 'vc1', 'mpeg2video']);
        const BD_AUDIO = new Set(['ac3', 'eac3', 'dts', 'truehd', 'pcm_s16le', 'pcm_s24le', 'dca', 'mlp']);
        const ext = path.extname(filePath).toLowerCase();
        const containerOk = ['.mkv', '.m2ts', '.ts'].includes(ext);
        const videoOk = !!(vStream && BD_VIDEO.has(vStream.codec_name));
        const bitrateMbps = parseInt(data.format?.bit_rate || 0) / 1e6;
        const bitrateOk = bitrateMbps < 40 || bitrateMbps === 0;
        const audioOk = aStreams.length === 0 || aStreams.every(s => BD_AUDIO.has(s.codec_name));
        const compatible = !!(containerOk && videoOk && bitrateOk && audioOk);
        const reasons = [];
        if (!videoOk) reasons.push('Video codec needs transcoding');
        if (!bitrateOk) reasons.push(`Bitrate ${bitrateMbps.toFixed(1)} Mbps exceeds BD limit (40 Mbps)`);
        if (!audioOk) reasons.push('Audio codec needs transcoding (e.g. FLAC)');
        if (!containerOk) reasons.push(`Container ${ext} not BD-native`);
        resolve({
          compatible,
          mode: compatible ? 'passthrough' : 'transcode',
          videoCodec: vStream?.codec_name || '',
          bitrateMbps: bitrateMbps.toFixed(1),
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
  return new Promise(async (resolve) => {
    if (!fs.existsSync(isoPath)) {
      return resolve({ error: `ISO file not found: ${isoPath}` });
    }

    sendLog(`Starting burn: ${isoPath}`);
    mainWindow.webContents.send('burn-progress', { status: 'starting', message: 'Preparing to burn...', percent: 0 });

    // Try growisofs first (better progress reporting), fall back to hdiutil
    if (TOOLS.growisofs) {
      // Detect device node
      let deviceNode = '/dev/rdisk2'; // fallback guess
      try {
        const { execSync } = require('child_process');
        const diskOut = execSync('diskutil list 2>/dev/null', { encoding: 'utf8', timeout: 8000 });
        const lines = diskOut.split('\n');
        for (const line of lines) {
          if (/optical|cd[- ]rom|dvd|bd[- ]/i.test(line)) {
            const m = line.match(/\/dev\/disk(\d+)/);
            if (m) { deviceNode = `/dev/rdisk${m[1]}`; break; }
          }
        }
      } catch (_) {}

      sendLog(`Burn using growisofs: ${deviceNode}`);
      mainWindow.webContents.send('burn-progress', { status: 'burning', message: `Burning to ${deviceNode}...`, percent: 1 });

      const gProc = spawn(TOOLS.growisofs, ['-dvd-compat', '-Z', `${deviceNode}=${isoPath}`]);
      let gStdout = '', gStderr = '';

      gProc.stdout.on('data', d => {
        const line = d.toString().trim();
        gStdout += line + '\n';
        sendLog('growisofs: ' + line);
        // Parse percentage: growisofs outputs "1.33% done, estimate finish..."
        const pct = line.match(/([\d.]+)%\s+done/);
        const percent = pct ? parseFloat(pct[1]) : null;
        mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent });
      });
      gProc.stderr.on('data', d => {
        const line = d.toString().trim();
        gStderr += line + '\n';
        sendLog('growisofs err: ' + line);
        const pct = line.match(/([\d.]+)%\s+done/);
        const percent = pct ? parseFloat(pct[1]) : null;
        mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent });
      });

      gProc.on('close', code => {
        if (code === 0) {
          sendLog('✓ Burn complete (growisofs)');
          mainWindow.webContents.send('burn-progress', { status: 'done', message: 'Burn complete! Disc ejected.', percent: 100 });
          resolve({ success: true });
        } else {
          sendLog(`growisofs failed (${code}), trying hdiutil fallback`);
          runHdiutilBurn(isoPath, resolve);
        }
      });
      gProc.on('error', () => {
        sendLog('growisofs spawn error — trying hdiutil fallback');
        runHdiutilBurn(isoPath, resolve);
      });
      return;
    }

    // No growisofs — use hdiutil
    runHdiutilBurn(isoPath, resolve);
  });
});

function runHdiutilBurn(isoPath, resolve) {
  sendLog(`Burning with hdiutil: ${isoPath}`);
  mainWindow.webContents.send('burn-progress', { status: 'burning', message: 'Burning with hdiutil...', percent: 5 });

  const proc = spawn('/usr/bin/hdiutil', ['burn', isoPath, '-eject']);
  let stdout = '', stderr = '';

  proc.stdout.on('data', d => {
    const line = d.toString().trim();
    stdout += line + '\n';
    sendLog('burn: ' + line);
    mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent: null });
  });
  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    stderr += line + '\n';
    sendLog('burn err: ' + line);
    mainWindow.webContents.send('burn-progress', { status: 'burning', message: line, percent: null });
  });

  proc.on('close', code => {
    if (code === 0) {
      sendLog('✓ Burn complete (hdiutil)');
      mainWindow.webContents.send('burn-progress', { status: 'done', message: 'Burn complete! Disc ejected.', percent: 100 });
      resolve({ success: true });
    } else {
      const msg = stderr || stdout || `hdiutil burn exited with code ${code}`;
      sendLog('Burn failed: ' + msg);
      mainWindow.webContents.send('burn-progress', { status: 'error', message: msg });
      resolve({ error: msg });
    }
  });
  proc.on('error', err => resolve({ error: 'hdiutil error: ' + err.message }));
}


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
  if (!TOOLS.ffmpeg) return { error: 'FFmpeg not found.\n\nInstall with:\n  brew install ffmpeg' };

  // Defensive defaults — guard against malformed or partially-loaded projects
  project.audioTracks    = project.audioTracks    || [];
  project.subtitleTracks = project.subtitleTracks || [];
  project.chapters       = project.chapters       || [];
  project.extras         = project.extras         || [];
  project.titles         = project.titles         || [];

  // ── Passthrough mode: skip FFmpeg mux when source is already BD-compatible ──
  const isPassthrough = project.passThroughMode === true && project.forceTranscode !== true;

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

  const additionalTitleSteps = (project.titles || []).map((title, i) => ({
    label: `Processing title ${i + 2}: ${(title.label || title.file?.name || 'Title').slice(0, 40)}`,
    fn:    () => processAdditionalTitle(project, workDir, tsDir, bdFolder, title, i + 2),
    outputFile: () => path.join(bdFolder, 'BDMV', 'STREAM', String(i + 2).padStart(5, '0') + '.m2ts'),
  }));

  const isoPath = path.join(outputDir, `${discName}.iso`);

  const steps = [
    ...(isPassthrough ? [
      { label: 'Passthrough mode — skipping FFmpeg mux (BD-compatible source)',
        fn: () => { sendLog('Passthrough: skipping FFmpeg mux step'); return Promise.resolve(); } },
    ] : [
      { label: 'Muxing main feature audio tracks',  fn: () => muxMainFeature(project, workDir, tsDir),
        outputFile: () => path.join(tsDir, 'main.ts') },
      { label: 'Validating mux output',             fn: () => validateMuxOutput(tsDir) },
    ]),
    { label: 'Generating menu image',             fn: () => generateMenuImage(project, workDir) },
    { label: 'Building Blu-ray disc structure',   fn: () => buildBDStructure(project, workDir, tsDir, bdFolder) },
    ...(project.extras.length > 0
      ? [{ label: 'Processing special features', fn: () => muxExtras(project, workDir, tsDir) }]
      : []),
    { label: 'Writing tsMuxeR project file',      fn: () => writeTsMuxerMeta(project, workDir, tsDir, bdFolder, isPassthrough) },
    { label: 'Running tsMuxeR / building BDMV',   fn: () => runTsMuxer(workDir, bdFolder),
      outputFile: () => path.join(bdFolder, 'BDMV', 'STREAM', '00001.m2ts') },
    // Additional titles run AFTER runTsMuxer so tsMuxeR cannot overwrite their
    // 00002.m2ts / 00002.clpi / 00002.mpls files when it writes the main title.
    ...additionalTitleSteps,
    ...(project.titles.length > 0 ? [{
      label: 'Updating disc navigation for all titles',
      fn: () => { fixMultiTitleNavigation(bdFolder, 1 + project.titles.length); return Promise.resolve(); }
    }] : []),
    { label: 'Packaging ISO image', fn: () => {
      const _path = require('path'), _fs = require('fs');
      // Force-create BDMV/STREAM and copy main.ts if needed
      const streamDir = _path.join(bdFolder, 'BDMV', 'STREAM');
      _fs.mkdirSync(streamDir, { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'BACKUP'),  { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'CLIPINF'), { recursive: true });
      _fs.mkdirSync(_path.join(bdFolder, 'BDMV', 'PLAYLIST'),{ recursive: true });
      const mainTs = _path.join(tsDir, 'main.ts');
      const m2ts   = _path.join(streamDir, '00001.m2ts');
      if (_fs.existsSync(mainTs) && !_fs.existsSync(m2ts)) {
        _fs.copyFileSync(mainTs, m2ts);
        sendLog('Copied main.ts → STREAM/00001.m2ts (' + (_fs.statSync(m2ts).size/1e6).toFixed(1) + ' MB)');
      }
      const bdmvContents = _fs.readdirSync(_path.join(bdFolder,'BDMV')).join(', ');
      sendLog('BDMV contents: ' + bdmvContents);
      return packageISO(bdFolder, outputDir, discName);
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

    // ── Group audio tracks: those inside the main MKV vs standalone external files ──
    // Tracks with trackIndex != null and file.path !== mainPath are embedded in OTHER
    // title files (additional episodes). They must NOT be included here — they are
    // processed by processAdditionalTitle for their own MPEG-TS file.
    const audioFromMkv  = project.audioTracks.filter(t => t.file?.path === mainPath && (t.trackIndex ?? t.streamIndex) != null);
    const audioExternal = project.audioTracks.filter(t => (t.trackIndex ?? t.streamIndex) == null);

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

    // ── Codecs — video: stream-copy or CRF re-encode; audio: stream-copy or AC3 ──
    // MPEG-TS stream-copy:  DTS / DTS-HD (core extracted by FFmpeg), AC3
    // Transcode to AC3:     FLAC, LPCM, TrueHD, AAC — not natively MPEG-TS compatible
    // The tsMuxeR meta codec string must exactly match the elementary stream type in
    // the .ts file — a mismatch causes tsMuxeR to silently produce a near-empty output.
    const mainCrfVal = getCrfValue(project.mainVideo?.videoQuality);
    if (mainCrfVal) {
      const level = (project.resolution || '').includes('480p') ? '3.1' : '4.1';
      args.push('-c:v', 'libx264', '-crf', String(mainCrfVal), '-preset', 'slow',
                '-profile:v', 'high', '-level', level, '-pix_fmt', 'yuv420p');
      sendLog(`  Video: CRF ${mainCrfVal} (H.264 High Profile, Level ${level})`);
      const dur = getVideoDuration(mainPath);
      if (dur > 0) sendLog(`__CRF_START:${Math.round(dur)}`);
    } else {
      args.push('-c:v', 'copy');
    }

    const MAIN_STREAM_COPY_FORMATS = new Set(['DTS-HD Master Audio', 'Dolby Digital 5.1']);
    allAudio.forEach((track, i) => {
      if (MAIN_STREAM_COPY_FORMATS.has(track.format)) {
        args.push(`-c:a:${i}`, 'copy');                       // DTS/AC3 → stream-copy
      } else {
        args.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, '640k');  // FLAC/LPCM/TrueHD/AAC → AC3
      }
    });

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
          `drawtext=text='▶ PLAY    CHAPTERS    AUDIO    SUBTITLES':fontsize=30:fontcolor=#${acc}:x=(w-text_w)/2:y=320`,
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
        `drawtext=text='${title}':fontsize=80:fontcolor=#${fg}:x=(w-text_w)/2:y=(h/2)-120:font=serif:shadowcolor=black:shadowx=3:shadowy=3`,
        // Divider line
        `drawbox=x=(iw/2-300):y=(ih/2):w=600:h=2:color=#${acc}@0.8:t=fill`,
        // Menu items
        `drawtext=text='▶  PLAY':fontsize=32:fontcolor=#${acc}:x=(w/2)-300:y=(h/2)+30`,
        `drawtext=text='≡  CHAPTERS':fontsize=32:fontcolor=#${acc}:x=(w/2)-80:y=(h/2)+30`,
        `drawtext=text='🔊  AUDIO':fontsize=32:fontcolor=#${acc}:x=(w/2)+160:y=(h/2)+30`,
      ].join(','),
      '-frames:v', '1', menuPng,
    ]);
    proc.on('close', () => resolve()); // non-fatal if this fails
    proc.on('error', () => resolve());
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

// ── Minimal BDMV navigation file writers ─────────────────────────────────────
// Used by processAdditionalTitle and fixMultiTitleNavigation to ensure every
// title has a valid .mpls and .clpi.

function writeBdMpls(playDir, backDir, id) {
  const mpls = Buffer.alloc(96, 0);
  mpls.write('MPLS', 0, 'ascii');
  mpls.write('0200', 4, 'ascii');
  mpls.writeUInt32BE(96, 8);
  mpls.writeUInt32BE(58, 12);        // PlayList offset
  mpls.writeUInt32BE(82, 16);        // PlayListMark offset
  mpls.writeUInt16BE(1, 58);         // num_PlayItems = 1
  mpls.writeUInt16BE(0, 60);         // num_SubPaths = 0
  mpls.write(id, 62, 'ascii');       // clip_Information_file_name (e.g. "00002")
  mpls.write('M2TS', 67, 'ascii');   // clip_codec_identifier
  mpls.writeUInt32BE(0, 73);         // IN_time
  mpls.writeUInt32BE(0xFFFFFF, 77);  // OUT_time
  const dest = path.join(playDir, `${id}.mpls`);
  fs.writeFileSync(dest, mpls);
  if (backDir) fs.copyFileSync(dest, path.join(backDir, `${id}.mpls`));
}

function writeBdClpi(clipDir, backDir, id) {
  const clpi = Buffer.alloc(88, 0);
  clpi.write('HDMV', 0, 'ascii');
  clpi.write('0200', 4, 'ascii');
  clpi.writeUInt32BE(88, 8);
  const dest = path.join(clipDir, `${id}.clpi`);
  fs.writeFileSync(dest, clpi);
  if (backDir) fs.copyFileSync(dest, path.join(backDir, `${id}.clpi`));
}

function processAdditionalTitle(project, workDir, tsDir, bdFolder, title, titleIdx) {
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
      if (magic !== 'MPLS' && magic !== 'CLPI') { fs.writeFileSync(destPath, buf); return; }
      const from = Buffer.from('00001', 'ascii');
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
        writeBdClpi(clipDir, backDir, pad(titleIdx));
      }

      const srcPlay = findFirst('PLAYLIST', 'mpls');
      if (srcPlay) {
        patchClipId(srcPlay, path.join(playDir, `${pad(titleIdx)}.mpls`));
        patchClipId(srcPlay, path.join(backDir, `${pad(titleIdx)}.mpls`));
      } else {
        sendLog(`Warning: no playlist found in tsMuxeR output for title ${titleIdx} — writing minimal MPLS`);
        writeBdMpls(playDir, backDir, pad(titleIdx));
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
    // CRF re-encode always outputs H.264; override codec string for tsMuxeR meta.
    const titleCrfVal = getCrfValue(title.videoQuality);
    const vCodec = titleCrfVal ? 'V_MPEG4/ISO/AVC' : (vCodecMap[project.videoFormat] || 'V_MPEG4/ISO/AVC');
    const resDims = {
      '1080p (1920×1080)':  [1920, 1080],
      '720p (1280×720)':    [1280, 720],
      '480p (720×480)':     [720,  480],
      '480p (720×576) PAL': [720,  576],
      '4K UHD (3840×2160)': [3840, 2160],
    };
    const [vW, vH] = resDims[project.resolution] || [1920, 1080];

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
      const metaLines = ['MUXOPT --blu-ray --no-pcr-on-video-pid --new-audio-pes'];

      metaLines.push(`${vCodec}, "${tsPath(filePath)}", fps=${fps}, insertSEI, contSPS, track=1`);

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
        const streamIdx = sub.trackIndex ?? sub.streamIndex;
        const tsmTrack  = streamIdx + 1;
        const lang      = langCode(sub.language);
        const forced    = sub.isForced ? ', forced' : '';
        const name      = trackName(streamIdx);
        if (sub.format === 'PGS (Blu-ray Native)') {
          metaLines.push(`S_HDMV/PGS, "${tsPath(filePath)}", lang=${lang}, track=${tsmTrack}${forced}${name}`);
        } else {
          metaLines.push(`S_TEXT/UTF8, "${tsPath(filePath)}", lang=${lang}, track=${tsmTrack}, video-width=${vW}, video-height=${vH}, fps=${fps}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}${name}`);
        }
      });

      const metaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}.meta`);
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

      // Build video codec args: CRF re-encode or stream-copy
      const h264Level = vH <= 480 ? '3.1' : '4.1';
      const addVideoCodecArgs = (args) => {
        if (titleCrfVal) {
          args.push('-c:v', 'libx264', '-crf', String(titleCrfVal), '-preset', 'slow',
                    '-profile:v', 'high', '-level', h264Level, '-pix_fmt', 'yuv420p');
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
        sendLog(`  Video: CRF ${titleCrfVal} (H.264 High Profile, Level ${h264Level})`);
        const dur = getVideoDuration(filePath);
        if (dur > 0) sendLog(`__CRF_START:${Math.round(dur)}`);
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
          // tsMuxeR unavailable — no point extracting subs, just copy the .ts
          return copyTsLastResort();
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
        sendLog(`  tsMuxeR not found — last resort copy (no subs)`);
        return copyTsLastResort();
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
        sendLog(`  Step 5 mkvmerge error: ${err.message} — last resort copy`);
        copyTsLastResort();
      });
      mkvProc.on('close', code => {
        // mkvmerge exits 1 for warnings (output is still valid), 2+ for hard errors
        if (code >= 2 || !fs.existsSync(combinedMkv)) {
          sendLog(`  Step 5 mkvmerge failed (exit ${code}) — last resort copy`);
          return copyTsLastResort();
        }
        const mkvSizeMB = (fs.statSync(combinedMkv).size / 1e6).toFixed(1);
        sendLog(`  ✓ Step 5: ${path.basename(combinedMkv)} (${mkvSizeMB} MB)`);

        // ── Step 6: tsMuxeR reads combined.mkv ───────────────────────────────
        // List each stream type in MKV order — no track= needed; tsMuxeR picks
        // streams sequentially (first video, then each audio, then each subtitle).
        const metaLines = ['MUXOPT --blu-ray --no-pcr-on-video-pid --new-audio-pes'];
        const mkvRef    = tsPath(combinedMkv);

        // Track numbers in the combined MKV:
        // track 1 = video, tracks 2..N+1 = audio, tracks N+2.. = PGS subtitles
        let trackNum = 1;
        metaLines.push(`${vCodec}, "${mkvRef}", fps=${fps}, insertSEI, contSPS, track=${trackNum++}`);

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
          sendLog(`  Step 6 tsMuxeR error: ${err.message} — last resort copy`);
          cleanup(tempBdFolder);
          copyTsLastResort();
        });
        tsProcFinal.on('close', tsmCode => {
          if (tsmCode !== 0) {
            sendLog(`  Step 6 tsMuxeR failed (exit ${tsmCode}) — last resort copy`);
            cleanup(tempBdFolder);
            return copyTsLastResort();
          }
          sendLog(`  Step 6 ok — merging`);
          mergeFromTempBd(tempBdFolder);
        });
      });
    };

    // Fallback used when mkvmerge is unavailable: feed .ts + .sup directly to
    // tsMuxeR (video may be dropped — known limitation with FFmpeg-produced .ts).
    const runTsMuxerDirectOnTs = (pgsSubs) => {
      if (!TOOLS.tsmuxer) return copyTsLastResort();
      const metaLines = ['MUXOPT --blu-ray --no-pcr-on-video-pid --new-audio-pes'];
      metaLines.push(`${vCodec}, "${tsPath(titleTs)}", fps=${fps}, insertSEI, contSPS, track=1`);
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
      fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');
      sendLog(`  Fallback meta:\n${metaLines.map(l => '    ' + l).join('\n')}`);
      cleanup(tempBdFolder);
      fs.mkdirSync(tempBdFolder, { recursive: true });
      const tsFb = spawn(TOOLS.tsmuxer, [metaFile, tempBdFolder]);
      tsFb.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsFb.stderr.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsFb.on('error', () => { cleanup(tempBdFolder); copyTsLastResort(); });
      tsFb.on('close', code => {
        if (code !== 0) { cleanup(tempBdFolder); return copyTsLastResort(); }
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
        sendLog(`  tsMuxeR not found — last resort copy (no subs)`);
        return copyTsLastResort();
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

      const subMetaLines = ['MUXOPT --blu-ray --no-pcr-on-video-pid --new-audio-pes'];
      subMetaLines.push(`${vCodec}, "${tsPath(titleTs)}", fps=${fps}, track=1`);
      if (audioTracks.length > 0) {
        audioTracks.forEach((t, i) => {
          const codec = STREAM_COPY_FORMATS.has(t.format) ? (aCodecMap[t.format] || 'A_AC3') : 'A_AC3';
          const name  = trackName(t.trackIndex ?? t.streamIndex);
          subMetaLines.push(`${codec}, "${tsPath(titleTs)}", lang=${langCode(t.language)}, track=${i + 2}${name}`);
        });
      } else {
        subMetaLines.push(`A_AC3, "${tsPath(titleTs)}", lang=und, track=2`);
      }
      textSubs.forEach(sub => {
        const lang   = langCode(sub.language);
        const forced = sub.isForced ? ', forced' : '';
        subMetaLines.push(`S_TEXT/UTF8, "${tsPath(sub.extractedPath)}", lang=${lang}, video-width=${vW}, video-height=${vH}, fps=${fps}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}`);
      });

      const subMetaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}_subtmp.meta`);
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
          sendLog(`  Step 3a failed (exit ${code}) — skipping text subs, proceeding with PGS only`);
          cleanup(subTempBd);
          return runMkvmergeAndTsMuxer(pgsSubs);
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

    // ── Last resort: copy .ts as .m2ts without subtitles ─────────────────────
    const copyTsLastResort = () => {
      const dest = path.join(streamDir, `${pad(titleIdx)}.m2ts`);
      sendLog(`  Last resort: ${path.basename(titleTs)} → ${path.basename(dest)} (no subtitles)`);
      try {
        fs.copyFileSync(titleTs, dest);
      } catch (err) {
        return reject(new Error(`Title ${titleIdx}: last resort copy failed: ${err.message}`));
      }
      writeBdClpi(clipDir, backDir, pad(titleIdx));
      writeBdMpls(playDir, backDir, pad(titleIdx));
      validateM2ts(dest);
    };

    // ── Orchestration ─────────────────────────────────────────────────────────
    if (!TOOLS.tsmuxer) {
      // No tsMuxeR at all: FFmpeg only (no subtitles possible)
      sendLog(`  tsMuxeR not found — FFmpeg-only path`);
      return runFfmpegPipeline();
    }
    if (titleCrfVal) {
      // CRF re-encode: must go through FFmpeg — tsMuxeR direct cannot re-encode
      sendLog(`  CRF ${title.videoQuality}: skipping tsMuxeR direct → FFmpeg pipeline`);
      return runFfmpegPipeline();
    }
    runTsMuxerDirectMkv();
  });
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

// ── Step 5: Write tsMuxeR .meta project file ──────────────────────────────────
//
// tsMuxeR meta format:
//   MUXOPT --blu-ray [options]
//   V_MPEG4/ISO/AVC, "file.ts", ...
//   A_DTS, "file.ts", ...
//   S_HDMV/PGS, "subtitle.sup", ...
//
// tsMuxeR reads the .ts produced by FFmpeg and splits out the individual tracks.

// Escape characters that would break tsMuxeR's double-quoted path parser.
// Backslashes must be doubled; double-quotes must be escaped. Apostrophes are
// safe inside double-quoted strings and do NOT need escaping.
const tsPath = p => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function writeTsMuxerMeta(project, workDir, tsDir, bdFolder, isPassthrough) {
  const mainPath  = project.mainVideo?.path || '';
  // Passthrough: reference original MKV directly; otherwise use the muxed .ts
  const mainTs   = isPassthrough ? mainPath : path.join(tsDir, 'main.ts');
  const outPath  = path.join(bdFolder, 'BDMV'); // tsMuxeR writes the BDMV tree here
  const metaFile = path.join(workDir, 'tsmuxer.meta');

  const m = project.menuConfig;
  const menuPng = path.join(workDir, 'menu_bg.png');
  const hasMenu = fs.existsSync(menuPng);

  // ── Global muxopt line ──
  const muxopts = [
    '--blu-ray',
    `--label="${sanitize(project.title || 'DISC').toUpperCase()}"`,
    '--no-pcr-on-video-pid',
    '--new-audio-pes',
  ];
  if (hasMenu) muxopts.push(`--custom-menu-bg="${tsPath(menuPng)}"`);

  const lines = [`MUXOPT ${muxopts.join(' ')}`];

  // ── Video track ──
  // Determine codec string for tsMuxeR.
  // When the main feature was CRF-encoded, the .ts always contains H.264.
  const vCodecMap = {
    'H.264 AVC':  'V_MPEG4/ISO/AVC',
    'H.265 HEVC': 'V_MPEGH/ISO/HEVC',
    'VC-1':       'V_MS/VFW/WVC1',
    'MPEG-2':     'V_MPEG-2',
  };
  const mainCrfForMeta = getCrfValue(project.mainVideo?.videoQuality);
  const vCodec = mainCrfForMeta ? 'V_MPEG4/ISO/AVC' : (vCodecMap[project.videoFormat] || 'V_MPEG4/ISO/AVC');
  const resDims = {
    '1080p (1920×1080)':  [1920, 1080],
    '720p (1280×720)':    [1280, 720],
    '480p (720×480)':     [720,  480],
    '480p (720×576) PAL': [720,  576],
    '4K UHD (3840×2160)': [3840, 2160],
  };
  const [subVW, subVH] = resDims[project.resolution] || [1920, 1080];
  const fps = getVideoFps(project.mainVideo?.path);
  lines.push(`${vCodec}, "${tsPath(mainTs)}", fps=${fps}, insertSEI, contSPS, track=1`);

  // mainPath is used for audio/subtitle sections (defined above for passthrough)
  const streamTitles = getStreamTitles(mainPath);
  // Returns the tsMuxeR track-name fragment for a given 0-based stream index.
  const trackName    = idx => {
    if (idx == null) return '';
    const t = streamTitles[idx];
    return t ? `, track-name="${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
  };

  // ── Audio tracks ──
  // The tsMuxeR codec string MUST match what is actually in the .ts file.
  // muxMainFeature only stream-copies DTS-HD (as DTS core); everything else —
  // including LPCM and TrueHD — was transcoded to AC3.
  const aCodecMap = {
    'DTS-HD Master Audio': 'A_DTS',  // stream-copied as DTS core
    'Dolby TrueHD':        'A_AC3',  // transcoded to AC3
    'PCM 5.1':             'A_AC3',  // transcoded to AC3
    'PCM 7.1':             'A_AC3',  // transcoded to AC3
    'LPCM Stereo':         'A_AC3',  // transcoded to AC3
    'Dolby Digital 5.1':   'A_AC3',
    'DTS 5.1':             'A_DTS',
  };
  // Build ordered audio list that exactly matches muxMainFeature's FFmpeg mapping order:
  //   1. Tracks embedded in the main video file (audioFromMkv)
  //   2. Standalone external audio files (trackIndex == null)
  // Tracks embedded in OTHER title files (trackIndex != null, file.path !== mainPath)
  // are excluded — they live in their own title MPEG-TS, not in main.ts.
  const mainFeatureAudio = [
    ...project.audioTracks.filter(t => t.file?.path === mainPath && (t.trackIndex ?? t.streamIndex) != null),
    ...project.audioTracks.filter(t => (t.trackIndex ?? t.streamIndex) == null),
  ];
  // In passthrough mode, audio track codec in tsMuxeR meta should match the
  // native codec in the MKV — use a broader codec map that preserves all BD codecs.
  const passthroughACodecMap = {
    'DTS-HD Master Audio': 'A_DTS',
    'Dolby TrueHD':        'A_TRUEHD',
    'PCM 5.1':             'A_LPCM',
    'PCM 7.1':             'A_LPCM',
    'LPCM Stereo':         'A_LPCM',
    'Dolby Digital 5.1':   'A_AC3',
    'DTS 5.1':             'A_DTS',
  };
  mainFeatureAudio.forEach((track, i) => {
    const codec      = isPassthrough
      ? (passthroughACodecMap[track.format] || 'A_AC3')
      : (aCodecMap[track.format] || 'A_AC3');
    const lang       = langCode(track.language);
    const isDefault  = track.isDefault ? ', default' : '';
    const name       = trackName(track.trackIndex ?? track.streamIndex);
    // In passthrough mode mainTs is the original MKV; audio track= is still needed
    lines.push(`${codec}, "${tsPath(mainTs)}", lang=${lang}, track=${i + 2}${isDefault}${name}`);
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
      // tsMuxeR uses 1-based track numbering; ffprobe index is 0-based.
      const tsmTrack = trackIdx + 1;
      const name     = trackName(trackIdx);
      if (sub.format === 'PGS (Blu-ray Native)') {
        lines.push(`S_HDMV/PGS, "${tsPath(sub.file.path)}", lang=${lang}, track=${tsmTrack}${forced}${name}`);
      } else {
        lines.push(`S_TEXT/UTF8, "${tsPath(sub.file.path)}", lang=${lang}, track=${tsmTrack}, video-width=${subVW}, video-height=${subVH}, fps=${fps}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}${name}`);
      }
    } else if (ext === '.sup') {
      // Standalone .sup file — reference directly (no source stream index to look up)
      lines.push(`S_HDMV/PGS, "${tsPath(sub.file.path)}", lang=${lang}${forced}`);
    } else {
      // Standalone text sub file — tsMuxeR converts SRT/ASS→PGS on the fly
      lines.push(`S_TEXT/UTF8, "${tsPath(sub.file.path)}", lang=${lang}, video-width=${subVW}, video-height=${subVH}, fps=${fps}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}`);
    }
  });

  // ── Chapter markers ──
  if (project.chapters.length > 0) {
    const chapFile = path.join(workDir, 'chapters_tsmuxer.txt');
    // tsMuxeR chapter format: CHAPTER01=HH:MM:SS.mmm
    const chapLines = project.chapters.flatMap((c, i) => {
      const n = String(i + 1).padStart(2, '0');
      return [
        `CHAPTER${n}=${c.time}.000`,
        `CHAPTER${n}NAME=${c.name}`,
      ];
    });
    fs.writeFileSync(chapFile, chapLines.join('\n'));
    lines.push(`CHAPTERS, "${tsPath(chapFile)}"`);
  }

  // ── Extras ──
  project.extras.forEach((extra, i) => {
    const extraTs = path.join(tsDir, `extra_${String(i+1).padStart(2,'0')}.ts`);
    if (fs.existsSync(extraTs)) {
      lines.push(`V_MPEG4/ISO/AVC, "${tsPath(extraTs)}", track=1`);
    }
  });

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
      sendLog('tsMuxeR not found — using fallback BDMV writer');
      sendLog(`workDir=${workDir} bdFolder=${bdFolder}`);
      writeFallbackBDMV(workDir, bdFolder)
        .then(() => {
          // Verify BDMV was actually created
          const bdmvCheck = path.join(bdFolder, 'BDMV');
          sendLog(`After fallback, BDMV exists: ${require('fs').existsSync(bdmvCheck)}`);
          if (!require('fs').existsSync(bdmvCheck)) {
            reject(new Error(`writeFallbackBDMV completed but BDMV dir not found at ${bdmvCheck}`));
          } else {
            resolve();
          }
        })
        .catch(err => {
          sendLog('writeFallbackBDMV ERROR: ' + err.message);
          reject(err);
        });
      return;
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
      if (code === 0) resolve();
      else reject(new Error(`tsMuxeR exited with code ${code}:\n${stderr.slice(-500)}`));
    });
    proc.on('error', err => reject(new Error(`tsMuxeR error: ${err.message}\n\nMake sure tsMuxeR is installed:\n  brew install --cask tsmuxer\nor download from https://github.com/justdan96/tsMuxeR/releases`)));
  });
}

// ── Fallback BDMV (when tsMuxeR is absent) ───────────────────────────────────
// Writes valid-enough binary navigation files for software player compatibility.

function writeFallbackBDMV(workDir, bdFolder) {
  sendLog(`writeFallbackBDMV: workDir=${workDir} bdFolder=${bdFolder}`);

  const tsDir     = path.join(workDir, 'ts');
  const mainTs    = path.join(tsDir, 'main.ts');
  const bdmvDir   = path.join(bdFolder, 'BDMV');
  const streamDir = path.join(bdmvDir, 'STREAM');
  const clipDir   = path.join(bdmvDir, 'CLIPINF');
  const playDir   = path.join(bdmvDir, 'PLAYLIST');

  // Ensure all directories exist
  for (const d of [bdFolder, bdmvDir, streamDir, clipDir, playDir]) {
    fs.mkdirSync(d, { recursive: true });
    sendLog(`Created dir: ${d}`);
  }

  // Copy main.ts → 00001.m2ts
  if (fs.existsSync(mainTs)) {
    const dest = path.join(streamDir, '00001.m2ts');
    fs.copyFileSync(mainTs, dest);
    sendLog(`Copied main.ts → ${dest} (${(fs.statSync(dest).size/1e6).toFixed(1)} MB)`);
  } else {
    sendLog(`WARNING: main.ts not found at ${mainTs}`);
  }

  // Minimal valid index.bdmv (INDX0100)
  // Structure: TypeIndicator(8) + version(4) + AppInfoBDMV offset(4) + IndexTable offset(4)
  const indexBuf = Buffer.alloc(112, 0);
  indexBuf.write('INDX', 0, 'ascii');
  indexBuf.write('0100', 4, 'ascii');
  indexBuf.writeUInt32BE(112, 8);   // size
  indexBuf.writeUInt32BE(56, 12);   // AppInfoBDMV offset
  indexBuf.writeUInt32BE(96, 16);   // IndexTable offset
  // FirstPlayback object ref (type=1=HDMV, id_ref=0)
  indexBuf[56] = 0x01;              // type = HDMV
  indexBuf[57] = 0x00;
  indexBuf.writeUInt16BE(0x0000, 58); // id_ref = 0
  fs.writeFileSync(path.join(bdFolder, 'BDMV', 'index.bdmv'), indexBuf);

  // Minimal MovieObject.bdmv (MOBJ0100)
  const mobjBuf = Buffer.alloc(96, 0);
  mobjBuf.write('MOBJ', 0, 'ascii');
  mobjBuf.write('0200', 4, 'ascii');
  mobjBuf.writeUInt32BE(96, 8);
  mobjBuf.writeUInt32BE(40, 12);    // ExtensionData offset (none)
  mobjBuf.writeUInt32BE(56, 16);    // MovieObjects start
  mobjBuf.writeUInt32BE(1,  20);    // number of MovieObjects = 1
  // MovieObject[0]: resume_intention=0, menu_call=0, title_search=0
  // CommandTable: 1 command → PlayPL(1) = play 00001.mpls
  mobjBuf.writeUInt16BE(0, 56);     // resume_intention_flag etc.
  mobjBuf.writeUInt16BE(1, 58);     // num_navigation_commands = 1
  mobjBuf.writeUInt32BE(0x50000001, 60); // cmd: PlayPL(1) → 00001.mpls
  mobjBuf.writeUInt32BE(0x00000000, 64);
  mobjBuf.writeUInt32BE(0x00000000, 68);
  fs.writeFileSync(path.join(bdFolder, 'BDMV', 'MovieObject.bdmv'), mobjBuf);

  // Minimal CLPI (clip info) for 00001
  const clpi = Buffer.alloc(88, 0);
  clpi.write('HDMV', 0, 'ascii');
  clpi.write('0200', 4, 'ascii');
  clpi.writeUInt32BE(88, 8);
  fs.writeFileSync(path.join(clipDir, '00001.clpi'), clpi);

  // Minimal MPLS (playlist) 00001
  const mpls = Buffer.alloc(96, 0);
  mpls.write('MPLS', 0, 'ascii');
  mpls.write('0200', 4, 'ascii');
  mpls.writeUInt32BE(96, 8);
  mpls.writeUInt32BE(58, 12);       // PlayList start
  mpls.writeUInt32BE(82, 16);       // PlayListMark start
  // PlayList: 1 PlayItem
  mpls.writeUInt16BE(1, 58);        // num_PlayItems
  mpls.writeUInt16BE(0, 60);        // num_SubPaths
  // PlayItem[0] — clip 00001, IN=0, OUT=0xFFFFFF
  mpls.write('00001', 62, 'ascii');
  mpls.write('M2TS', 67, 'ascii');
  mpls.writeUInt32BE(0, 73);        // IN_time
  mpls.writeUInt32BE(0xFFFFFF, 77); // OUT_time
  fs.writeFileSync(path.join(playDir, '00001.mpls'), mpls);

  // BACKUP copies
  const backupDir = path.join(bdFolder, 'BDMV', 'BACKUP');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(path.join(bdFolder,'BDMV','index.bdmv'),       path.join(backupDir,'index.bdmv'));
  fs.copyFileSync(path.join(bdFolder,'BDMV','MovieObject.bdmv'),  path.join(backupDir,'MovieObject.bdmv'));

  return Promise.resolve();
}


// ── Multi-title navigation fix ────────────────────────────────────────────────
// After processAdditionalTitle merges 00002.mpls, 00003.mpls, etc. into the
// PLAYLIST directory, the index.bdmv and MovieObject.bdmv written by the main
// tsMuxeR run still reference only 1 title.  This function regenerates both
// files so that hardware BD players can navigate all N titles.
//
// Binary layout is derived from the existing writeFallbackBDMV structure and
// scaled to N objects.  PlayPL(1) → 00001.mpls, PlayPL(2) → 00002.mpls, etc.

function fixMultiTitleNavigation(bdFolder, titleCount) {
  if (titleCount <= 1) return; // single title — tsMuxeR's files are already correct

  const bdmvDir = path.join(bdFolder, 'BDMV');
  const backDir = path.join(bdmvDir,  'BACKUP');
  fs.mkdirSync(backDir, { recursive: true });

  // Ensure every title has a standalone playlist file.
  // When tsMuxeR runs with --custom-menu-bg it only writes 00000.mpls (the menu
  // playlist); it does NOT create 00001.mpls for the main title.  Additional
  // titles may also be missing their .mpls if tsMuxeR exited before producing
  // one.  We create minimal-but-valid fallback playlists here so that the
  // PlayPL(i) commands written below can always resolve to a real file.
  const playDir = path.join(bdmvDir, 'PLAYLIST');
  fs.mkdirSync(playDir, { recursive: true });
  for (let i = 1; i <= titleCount; i++) {
    const id = String(i).padStart(5, '0');
    if (!fs.existsSync(path.join(playDir, `${id}.mpls`))) {
      writeBdMpls(playDir, backDir, id);
      sendLog(`fixMultiTitleNavigation: created missing playlist ${id}.mpls`);
    }
  }

  // ── MovieObject.bdmv ───────────────────────────────────────────────────────
  // Header: 56 bytes  (type + version + length + ext_start + obj_start + count + padding)
  // Per object: 16 bytes  (2B flags + 2B num_cmds + 12B command)
  const mobjSize = 56 + titleCount * 16;
  const mobj = Buffer.alloc(mobjSize, 0);
  mobj.write('MOBJ', 0, 'ascii');
  mobj.write('0200', 4, 'ascii');
  mobj.writeUInt32BE(mobjSize, 8);
  mobj.writeUInt32BE(0,          12); // no ExtensionData
  mobj.writeUInt32BE(56,         16); // MovieObjects_start
  mobj.writeUInt32BE(titleCount, 20); // number_of_movie_objects
  for (let i = 0; i < titleCount; i++) {
    const off = 56 + i * 16;
    mobj.writeUInt16BE(0x4000, off);                   // flags: menu_call_mask set (popup menu enabled)
    mobj.writeUInt16BE(1, off + 2);                    // num_navigation_commands = 1
    mobj.writeUInt32BE(0x50000001 + i, off + 4);       // PlayPL(i+1): plays 0000(i+1).mpls
    mobj.writeUInt32BE(0, off + 8);                    // destination word
    mobj.writeUInt32BE(0, off + 12);                   // source word
  }
  const mobjPath = path.join(bdmvDir, 'MovieObject.bdmv');
  fs.writeFileSync(mobjPath, mobj);
  fs.copyFileSync(mobjPath, path.join(backDir, 'MovieObject.bdmv'));

  // ── index.bdmv ────────────────────────────────────────────────────────────
  // Header (56 bytes) + AppInfoBDMV (40 bytes, at offset 56) +
  // IndexTable (at offset 96): 2B num_titles + N × 4B entries
  const indexSize = 98 + titleCount * 4;
  const idx = Buffer.alloc(indexSize, 0);
  idx.write('INDX', 0, 'ascii');
  idx.write('0100', 4, 'ascii');
  idx.writeUInt32BE(indexSize, 8);
  idx.writeUInt32BE(56, 12); // AppInfoBDMV_start
  idx.writeUInt32BE(96, 16); // IndexTable_start
  // AppInfoBDMV: FirstPlayback → Object 0
  idx[56] = 0x01;            // object_type = HDMV
  idx[57] = 0x00;
  idx.writeUInt16BE(0, 58);  // hdmv_id_ref = 0 (first object)
  // TopMenu: none (bytes 60–95 remain zero)
  // IndexTable
  idx.writeUInt16BE(titleCount, 96); // number_of_titles
  for (let i = 0; i < titleCount; i++) {
    const off = 98 + i * 4;
    idx.writeUInt16BE(0x8000, off);  // title_type = HDMV movie
    idx.writeUInt16BE(i, off + 2);   // hdmv_id_ref = object i
  }
  const idxPath = path.join(bdmvDir, 'index.bdmv');
  fs.writeFileSync(idxPath, idx);
  fs.copyFileSync(idxPath, path.join(backDir, 'index.bdmv'));

  sendLog(`Multi-title navigation updated: ${titleCount} titles in index.bdmv + MovieObject.bdmv`);
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

// ── Step 7: Package ISO with hdiutil ──────────────────────────────────────────

function packageISO(bdFolder, outputDir, discName) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {

    // Always show paths in error for debugging
    const debugInfo = `bdFolder="${bdFolder}" outputDir="${outputDir}" discName="${discName}"`;
    sendLog('packageISO: ' + debugInfo);

    if (!bdFolder || bdFolder.trim() === '') {
      return reject(new Error(`bdFolder is empty!\n${debugInfo}`));
    }

    const bdmvDir = path.join(bdFolder, 'BDMV');
    const bdExists   = fs.existsSync(bdFolder);
    const bdmvExists = fs.existsSync(bdmvDir);
    let contents = 'N/A';
    if (bdExists) {
      try { contents = fs.readdirSync(bdFolder).join(', ') || '(empty)'; } catch(e) { contents = e.message; }
    }

    sendLog(`bdFolder exists: ${bdExists}, contents: ${contents}`);
    sendLog(`BDMV exists: ${bdmvExists}`);

    if (!bdExists) {
      return reject(new Error(`BD source folder does not exist:\n${bdFolder}\n\n${debugInfo}`));
    }
    if (!bdmvExists) {
      return reject(new Error(`BDMV subfolder missing.\nFolder contents: ${contents}\n\n${debugInfo}`));
    }

    try { fs.mkdirSync(outputDir, { recursive: true }); } catch(e) {
      return reject(new Error(`Cannot create output dir: ${outputDir}\n${e.message}`));
    }

    const isoPath = path.join(outputDir, `${discName}.iso`);
    try { if (fs.existsSync(isoPath)) fs.unlinkSync(isoPath); } catch(_) {}

    const volName = (discName.toUpperCase().replace(/[^A-Z0-9]/g,'_')).slice(0,32) || 'DISC';
    sendLog(`ISO path: ${isoPath}  volName: ${volName}`);

    const hdiArgs = ['makehybrid', '-o', isoPath, '-udf', '-udf-volume-name', volName, '-joliet', '-iso', bdFolder];
    sendLog('Running: hdiutil ' + hdiArgs.join(' '));

    execFile('/usr/bin/hdiutil', hdiArgs, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(
          `hdiutil failed (code ${err.code}):\n${(stderr||stdout||err.message).slice(0,1000)}\n\n${debugInfo}`
        ));
      } else {
        const size = fs.existsSync(isoPath) ? `${(fs.statSync(isoPath).size/1e9).toFixed(2)} GB` : '?';
        sendLog(`✓ ISO created: ${isoPath} (${size})`);
        resolve();
      }
    });
  });
}

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
