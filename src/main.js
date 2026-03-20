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
  makemkv:  findTool(['makemkvcon', 'MakeMKV']),
  hdiutil:  '/usr/bin/hdiutil',
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

ipcMain.handle('burn-iso', async (_, isoPath) => {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    if (!fs.existsSync(isoPath)) {
      return resolve({ error: `ISO file not found: ${isoPath}` });
    }

    sendLog(`Starting burn: ${isoPath}`);
    mainWindow.webContents.send('burn-progress', { status: 'starting', message: 'Preparing to burn...' });

    // hdiutil burn is macOS built-in and handles BD-R natively
    const proc = spawn('/usr/bin/hdiutil', ['burn', isoPath, '-eject']);

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      stdout += line + '\n';
      sendLog('burn: ' + line);
      mainWindow.webContents.send('burn-progress', { status: 'burning', message: line });
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      stderr += line + '\n';
      sendLog('burn err: ' + line);
      mainWindow.webContents.send('burn-progress', { status: 'burning', message: line });
    });

    proc.on('close', code => {
      if (code === 0) {
        sendLog('✓ Burn complete');
        mainWindow.webContents.send('burn-progress', { status: 'done', message: 'Burn complete! Disc ejected.' });
        resolve({ success: true });
      } else {
        const msg = stderr || stdout || `hdiutil burn exited with code ${code}`;
        sendLog('Burn failed: ' + msg);
        mainWindow.webContents.send('burn-progress', { status: 'error', message: msg });
        resolve({ error: msg });
      }
    });
    proc.on('error', err => {
      resolve({ error: 'hdiutil not found: ' + err.message });
    });
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
  if (!TOOLS.ffmpeg) return { error: 'FFmpeg not found.\n\nInstall with:\n  brew install ffmpeg' };

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
  }));

  const steps = [
    { label: 'Muxing main feature audio tracks',  fn: () => muxMainFeature(project, workDir, tsDir) },
    { label: 'Validating mux output',             fn: () => validateMuxOutput(tsDir) },
    { label: 'Generating menu image',             fn: () => generateMenuImage(project, workDir) },
    { label: 'Building Blu-ray disc structure',   fn: () => buildBDStructure(project, workDir, tsDir, bdFolder) },
    ...additionalTitleSteps,
    ...(project.extras.length > 0
      ? [{ label: 'Processing special features', fn: () => muxExtras(project, workDir, tsDir) }]
      : []),
    { label: 'Writing tsMuxeR project file',      fn: () => writeTsMuxerMeta(project, workDir, tsDir, bdFolder) },
    { label: 'Running tsMuxeR / building BDMV',   fn: () => runTsMuxer(workDir, bdFolder) },
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
    }},
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
  }

  const isoPath = path.join(outputDir, `${discName}.iso`);
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

    // ── Group audio tracks: those inside the MKV vs separate audio files ──
    const audioFromMkv  = project.audioTracks.filter(t => t.file.path === mainPath && t.trackIndex != null);
    const audioExternal = project.audioTracks.filter(t => t.file.path !== mainPath || t.trackIndex == null);

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
    audioFromMkv.forEach(t => args.push('-map', `0:${t.trackIndex}`));
    // Audio from external files
    audioExternal.forEach((_, i) => args.push('-map', `${i + 1}:a:0`));

    if (chapInputIndex >= 0) {
      args.push('-map_metadata', String(chapInputIndex));
      args.push('-map_chapters', String(chapInputIndex));
    }

    const allAudio = [...audioFromMkv, ...audioExternal];

    // ── Codecs — video always copied, audio copied if lossless else → AC3 ──
    args.push('-c:v', 'copy');

    const losslessFormats = ['DTS-HD Master Audio','Dolby TrueHD','PCM 5.1','PCM 7.1','LPCM Stereo'];
    allAudio.forEach((track, i) => {
      if (losslessFormats.includes(track.format)) {
        args.push(`-c:a:${i}`, 'copy');
      } else {
        args.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, '640k');
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
    const title = (m.title || project.title || 'Main Menu').replace(/'/g, "\\'").replace(/:/g, '\\:');
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
      runFFmpeg(['-y','-i', extra.file.path, '-c','copy','-f','mpegts', outFile], resolve, reject);
    })
  ));
}

// ── Additional titles: FFmpeg mux + tsMuxeR run + BDMV merge ─────────────────
//
// Each entry in project.titles gets its own MPEG-TS file, then its own tsMuxeR
// run into a temp BDMV folder. The resulting .m2ts / .clpi / .mpls files are
// merged into the main bdFolder with incrementing numbers (00002, 00003, …).

function processAdditionalTitle(project, workDir, tsDir, bdFolder, title, titleIdx) {
  return new Promise((resolve) => {   // non-fatal — never reject, just log warnings
    const pad      = n => String(n).padStart(5, '0');
    const filePath = title.file?.path;

    if (!filePath || !fs.existsSync(filePath)) {
      sendLog(`Warning: title ${titleIdx} file not found: ${filePath}`);
      return resolve();
    }

    const titleTs = path.join(tsDir, `title_${pad(titleIdx)}.ts`);

    // Tracks belonging to this specific source file
    const audioTracks = (project.audioTracks || []).filter(
      t => t.file && t.file.path === filePath && t.trackIndex != null
    );
    const subtitleTracks = (project.subtitleTracks || []).filter(
      s => s.file && s.file.path === filePath && s.trackIndex != null
    );

    // ── A: FFmpeg — mux video + audio into MPEG-TS ──
    const lossless = ['DTS-HD Master Audio','Dolby TrueHD','PCM 5.1','PCM 7.1','LPCM Stereo'];
    const ffArgs   = ['-y', '-i', filePath];

    if (audioTracks.length > 0) {
      ffArgs.push('-map', '0:v:0');
      audioTracks.forEach(t => ffArgs.push('-map', `0:${t.trackIndex}`));
      ffArgs.push('-c:v', 'copy');
      audioTracks.forEach((t, i) => {
        if (lossless.includes(t.format)) ffArgs.push(`-c:a:${i}`, 'copy');
        else                             ffArgs.push(`-c:a:${i}`, 'ac3', `-b:a:${i}`, '640k');
      });
    } else {
      // No explicit tracks — stream-copy everything
      ffArgs.push('-map', '0:v', '-map', '0:a?', '-c', 'copy');
    }
    ffArgs.push('-f', 'mpegts', '-mpegts_flags', 'system_b', titleTs);

    sendLog(`Title ${titleIdx}: FFmpeg mux → ${path.basename(titleTs)}`);

    const ffProc = spawn(TOOLS.ffmpeg, ffArgs);
    let ffStderr = '';
    ffProc.stderr.on('data', d => {
      const chunk = d.toString();
      ffStderr += chunk;
      if (chunk.includes('time=') || chunk.includes('frame=')) sendLog(chunk.trim());
    });
    ffProc.on('error', err => {
      sendLog(`Warning: FFmpeg error for title ${titleIdx}: ${err.message}`);
      resolve();
    });
    ffProc.on('close', code => {
      if (code !== 0 || !fs.existsSync(titleTs)) {
        sendLog(`Warning: FFmpeg exited ${code} for title ${titleIdx}:\n${ffStderr.slice(-400)}`);
        return resolve();
      }
      sendLog(`Title ${titleIdx}: mux ok (${(fs.statSync(titleTs).size / 1e6).toFixed(1)} MB)`);

      // ── B: tsMuxeR meta for this title ──
      const aCodecMap = {
        'DTS-HD Master Audio':'A_DTS','Dolby TrueHD':'A_TRUEHD',
        'PCM 5.1':'A_LPCM','PCM 7.1':'A_LPCM','LPCM Stereo':'A_LPCM',
        'Dolby Digital 5.1':'A_AC3','DTS 5.1':'A_DTS',
      };
      const fps       = getVideoFps(filePath);
      const metaLines = ['MUXOPT --blu-ray --no-pcr-on-video-pid --new-audio-pes'];
      metaLines.push(`V_MPEG4/ISO/AVC, "${titleTs}", fps=${fps}, insertSEI, contSPS, track=1`);

      if (audioTracks.length > 0) {
        audioTracks.forEach((t, i) => {
          const codec = aCodecMap[t.format] || 'A_AC3';
          metaLines.push(`${codec}, "${titleTs}", lang=${langCode(t.language)}, track=${i + 2}`);
        });
      } else {
        metaLines.push(`A_AC3, "${titleTs}", lang=und, track=2`);
      }

      subtitleTracks.forEach(sub => {
        const lang   = langCode(sub.language);
        const forced = sub.isForced ? ', forced' : '';
        const tsmTrack = sub.trackIndex + 1;
        if (sub.format === 'PGS (Blu-ray Native)') {
          metaLines.push(`S_HDMV/PGS, "${filePath}", lang=${lang}, track=${tsmTrack}${forced}`);
        } else {
          metaLines.push(`S_TEXT/UTF8, "${filePath}", lang=${lang}, track=${tsmTrack}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}`);
        }
      });

      const metaFile = path.join(workDir, `tsmuxer_title_${pad(titleIdx)}.meta`);
      fs.writeFileSync(metaFile, metaLines.join('\n') + '\n');

      // ── C: Run tsMuxeR (or fall back to direct .ts → .m2ts copy) ──
      const streamDir = path.join(bdFolder, 'BDMV', 'STREAM');
      const clipDir   = path.join(bdFolder, 'BDMV', 'CLIPINF');
      const playDir   = path.join(bdFolder, 'BDMV', 'PLAYLIST');
      const backDir   = path.join(bdFolder, 'BDMV', 'BACKUP');
      [streamDir, clipDir, playDir, backDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

      const directCopyFallback = () => {
        fs.copyFileSync(titleTs, path.join(streamDir, `${pad(titleIdx)}.m2ts`));
        sendLog(`Title ${titleIdx}: direct copy fallback → STREAM/${pad(titleIdx)}.m2ts`);
        resolve();
      };

      const mergeFromTempBd = (tempBdFolder) => {
        const src = (sub) => path.join(tempBdFolder, 'BDMV', sub, '00001.' + sub.toLowerCase().replace('stream','m2ts').replace('clipinf','clpi').replace('playlist','mpls'));
        const srcStream = path.join(tempBdFolder, 'BDMV', 'STREAM',   '00001.m2ts');
        const srcClip   = path.join(tempBdFolder, 'BDMV', 'CLIPINF',  '00001.clpi');
        const srcPlay   = path.join(tempBdFolder, 'BDMV', 'PLAYLIST', '00001.mpls');

        if (fs.existsSync(srcStream)) {
          fs.copyFileSync(srcStream, path.join(streamDir, `${pad(titleIdx)}.m2ts`));
          sendLog(`Merged title ${titleIdx}: STREAM/${pad(titleIdx)}.m2ts`);
        } else {
          // tsMuxeR didn't produce expected .m2ts — fall back
          if (fs.existsSync(titleTs)) {
            fs.copyFileSync(titleTs, path.join(streamDir, `${pad(titleIdx)}.m2ts`));
          }
        }
        if (fs.existsSync(srcClip)) {
          fs.copyFileSync(srcClip, path.join(clipDir,  `${pad(titleIdx)}.clpi`));
          fs.copyFileSync(srcClip, path.join(backDir,  `${pad(titleIdx)}.clpi`));
        }
        if (fs.existsSync(srcPlay)) {
          fs.copyFileSync(srcPlay, path.join(playDir,  `${pad(titleIdx)}.mpls`));
          fs.copyFileSync(srcPlay, path.join(backDir,  `${pad(titleIdx)}.mpls`));
        }
        cleanup(tempBdFolder);
        resolve();
      };

      if (!TOOLS.tsmuxer) return directCopyFallback();

      const tempBdFolder = path.join(workDir, `bdmv_title_${pad(titleIdx)}`);
      fs.mkdirSync(tempBdFolder, { recursive: true });
      sendLog(`Title ${titleIdx}: running tsMuxeR`);

      const tsProc = spawn(TOOLS.tsmuxer, [metaFile, tempBdFolder]);
      let tsStderr = '';
      tsProc.stdout.on('data', d => { const l = d.toString().trim(); if (l) sendLog(l); });
      tsProc.stderr.on('data', d => { const chunk = d.toString(); tsStderr += chunk; const l = chunk.trim(); if (l) sendLog(l); });
      tsProc.on('error', err => {
        sendLog(`Warning: tsMuxeR error for title ${titleIdx}: ${err.message}`);
        cleanup(tempBdFolder);
        directCopyFallback();
      });
      tsProc.on('close', code => {
        if (code !== 0) {
          sendLog(`Warning: tsMuxeR exited ${code} for title ${titleIdx} — using direct copy`);
          cleanup(tempBdFolder);
          return directCopyFallback();
        }
        mergeFromTempBd(tempBdFolder);
      });
    });
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

// ── Step 5: Write tsMuxeR .meta project file ──────────────────────────────────
//
// tsMuxeR meta format:
//   MUXOPT --blu-ray [options]
//   V_MPEG4/ISO/AVC, "file.ts", ...
//   A_DTS, "file.ts", ...
//   S_HDMV/PGS, "subtitle.sup", ...
//
// tsMuxeR reads the .ts produced by FFmpeg and splits out the individual tracks.

function writeTsMuxerMeta(project, workDir, tsDir, bdFolder) {
  const mainTs   = path.join(tsDir, 'main.ts');
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
  if (hasMenu) muxopts.push(`--custom-menu-bg="${menuPng}"`);

  const lines = [`MUXOPT ${muxopts.join(' ')}`];

  // ── Video track ──
  // Determine codec string for tsMuxeR
  const vCodecMap = {
    'H.264 AVC':  'V_MPEG4/ISO/AVC',
    'H.265 HEVC': 'V_MPEGH/ISO/HEVC',
    'VC-1':       'V_MS/VFW/WVC1',
    'MPEG-2':     'V_MPEG-2',
  };
  const vCodec = vCodecMap[project.videoFormat] || 'V_MPEG4/ISO/AVC';
  const resMap = {
    '1080p (1920×1080)':      '1080p',
    '720p (1280×720)':        '720p',
    '480p (720×480)':         '480p',
    '480p (720×576) PAL':     '576p',
    '4K UHD (3840×2160)':     '2160p',
  };
  const fps = getVideoFps(project.mainVideo?.path);
  lines.push(`${vCodec}, "${mainTs}", fps=${fps}, insertSEI, contSPS, track=1`);

  // ── Audio tracks ──
  const aCodecMap = {
    'DTS-HD Master Audio': 'A_DTS',
    'Dolby TrueHD':        'A_TRUEHD',
    'PCM 5.1':             'A_LPCM',
    'PCM 7.1':             'A_LPCM',
    'LPCM Stereo':         'A_LPCM',
    'Dolby Digital 5.1':   'A_AC3',
    'DTS 5.1':             'A_DTS',
  };
  project.audioTracks.forEach((track, i) => {
    const codec = aCodecMap[track.format] || 'A_AC3';
    const lang  = langCode(track.language);
    const isDefault = track.isDefault ? ', default' : '';
    // Track index in the muxed .ts (track 2 = first audio, etc.)
    lines.push(`${codec}, "${mainTs}", lang=${lang}, track=${i + 2}${isDefault}`);
  });

  // ── Subtitle tracks ──
  // Subtitles were NOT routed through FFmpeg, so they are NOT in main.ts.
  // Three cases:
  //   1. Embedded in source MKV (trackIndex set)  → tsMuxeR reads directly from MKV by track number
  //   2. Standalone .sup PGS file                 → reference directly as S_HDMV/PGS
  //   3. Standalone text sub (.srt/.ass/.vtt/etc.) → reference directly as S_TEXT/UTF8
  const mainPath = project.mainVideo?.path || '';

  project.subtitleTracks.forEach((sub) => {
    const lang   = langCode(sub.language);
    const forced = sub.isForced ? ', forced' : '';
    const ext    = path.extname(sub.file.path).toLowerCase();

    if (mainPath && sub.file.path === mainPath && sub.trackIndex != null) {
      // Embedded in the source MKV — tsMuxeR reads directly from the MKV file.
      // tsMuxeR uses 1-based track numbering; ffprobe index is 0-based.
      const tsmTrack = sub.trackIndex + 1;
      if (sub.format === 'PGS (Blu-ray Native)') {
        lines.push(`S_HDMV/PGS, "${sub.file.path}", lang=${lang}, track=${tsmTrack}${forced}`);
      } else {
        lines.push(`S_TEXT/UTF8, "${sub.file.path}", lang=${lang}, track=${tsmTrack}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}`);
      }
    } else if (ext === '.sup') {
      // Standalone .sup file — reference directly
      lines.push(`S_HDMV/PGS, "${sub.file.path}", lang=${lang}${forced}`);
    } else {
      // Standalone text sub file — tsMuxeR converts SRT/ASS→PGS on the fly
      lines.push(`S_TEXT/UTF8, "${sub.file.path}", lang=${lang}, font-name=Arial, font-size=48, font-color=0xFFFFFF, bottom-offset=24${forced}`);
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
    lines.push(`CHAPTERS, "${chapFile}"`);
  }

  // ── Extras ──
  project.extras.forEach((extra, i) => {
    const extraTs = path.join(tsDir, `extra_${String(i+1).padStart(2,'0')}.ts`);
    if (fs.existsSync(extraTs)) {
      lines.push(`V_MPEG4/ISO/AVC, "${extraTs}", track=1`);
    }
  });

  fs.writeFileSync(metaFile, lines.join('\n') + '\n');

  // Store paths for next step
  project._metaFile  = metaFile;
  project._bdFolder  = bdFolder;

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
  // CommandTable: 1 command → PLAY_PL(0) = play playlist 0
  mobjBuf.writeUInt16BE(0, 56);     // resume_intention_flag etc.
  mobjBuf.writeUInt16BE(1, 58);     // num_navigation_commands = 1
  mobjBuf.writeUInt32BE(0x50000000, 60); // cmd: PlayPL playlist=0
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
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-progress', msg);
    }
  } catch(_) {}
}

function progress(step, label) {
  mainWindow?.webContents.send('build-progress', { step, label });
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
