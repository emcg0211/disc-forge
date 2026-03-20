const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('discForge', {
  // Core
  getHomeDir:       ()        => ipcRenderer.invoke('get-home-dir'),
  checkTools:       ()        => ipcRenderer.invoke('check-tools'),
  openFileDialog:   (opts)    => ipcRenderer.invoke('open-file-dialog', opts),
  openFilesDialog:  (opts)    => ipcRenderer.invoke('open-files-dialog', opts),
  detectDrive:      ()        => ipcRenderer.invoke('detect-drive'),
  burnISO:          (iso)     => ipcRenderer.invoke('burn-iso', iso),
  onBurnProgress:   (cb)      => ipcRenderer.on('burn-progress', (_, d) => cb(d)),
  saveProjectFile:  (json)    => ipcRenderer.invoke('save-project-file', json),
  loadProjectFile:  ()        => ipcRenderer.invoke('load-project-file'),
  openFolderDialog: ()        => ipcRenderer.invoke('open-folder-dialog'),
  probeFile:        (filePath)=> ipcRenderer.invoke('probe-file', filePath),
  buildDisc:        (project) => ipcRenderer.invoke('build-disc', project),
  revealInFinder:   (filePath)=> ipcRenderer.invoke('reveal-in-finder', filePath),

  // Build events
  onBuildProgress:    (cb) => ipcRenderer.on('build-progress',  (_, d) => cb(d)),
  onFFmpegProgress:   (cb) => ipcRenderer.on('ffmpeg-progress', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // Window controls (for custom traffic-light buttons)
  windowClose:    () => ipcRenderer.send('window-close'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
});
