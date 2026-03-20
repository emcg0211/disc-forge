// ── Constants ─────────────────────────────────────────────────────────────────
// Track which input has focus so we can restore it after re-render
let _focusedId  = null;
let _focusedPos = null;  // cursor position
let _renderTimer = null;

function scheduleRender() {
  // Batch rapid state changes into a single render
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.id) {
      _focusedId  = activeEl.id;
      _focusedPos = activeEl.selectionStart ?? null;
    }
    render();
  }, 0);
}
const LANGUAGES = ['English','French','Spanish','German','Italian','Portuguese','Japanese','Korean','Mandarin','Cantonese','Russian','Arabic','Hindi','Dutch','Swedish','Norwegian','Danish','Finnish','Polish','Czech','Hungarian','Romanian','Turkish','Greek','Hebrew','Thai','Vietnamese','Indonesian','Malay'];
const AUDIO_FORMATS  = ['DTS-HD Master Audio','Dolby TrueHD','PCM 5.1','PCM 7.1','Dolby Digital 5.1','DTS 5.1','LPCM Stereo'];
const SUBTITLE_FMTS  = ['SRT','ASS','SSA','SUB','VTT','PGS (Blu-ray Native)'];
const VIDEO_FMTS     = ['H.264 AVC','H.265 HEVC','VC-1','MPEG-2'];
const RESOLUTIONS    = ['1080p (1920×1080)','720p (1280×720)','480p (720×480)','480p (720×576) PAL','4K UHD (3840×2160)'];
const MENU_THEMES    = ['Cinematic Dark','Elegant White','Retro Film','Minimal Type','Sci-Fi Grid','Organic Nature'];
const EXTRAS_TYPES   = ['Behind the Scenes','Deleted Scenes','Interviews','Trailers','Featurette','Short Film','Other'];

const TABS = [
  { id:'project',   icon:'🎬', label:'Project'    },
  { id:'mkv',       icon:'📦', label:'Video Import' },
  { id:'audio',     icon:'🔊', label:'Audio'       },
  { id:'subtitles', icon:'💬', label:'Subtitles'   },
  { id:'chapters',  icon:'≡',  label:'Chapters'    },
  { id:'menu',      icon:'🎨', label:'Menu'        },
  { id:'extras',    icon:'🎞', label:'Extras'      },
];

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  tab: 0,
  lightMode: true,
  systemFonts: [],  // populated on boot from installed fonts
  tools: { ffmpeg:{found:false}, ffprobe:{found:false}, tsmuxer:{found:false}, makemkv:{found:false} },
  building: false, buildSteps: [], buildCurrentStep: -1,
  buildDone: false, buildError: null, builtIsoPath: null, ffmpegLog: '',
  project: {
    title: '', description: '', discLabel: '',
    resolution: RESOLUTIONS[0], videoFormat: VIDEO_FMTS[0], outputDir: '',
    mainVideo: null,
    titles: [],   // additional video titles on the disc
    discSize: 'BD-25',
    audioTracks: [], subtitleTracks: [], chapters: [], extras: [],
    menuConfig: {
      theme: MENU_THEMES[0], title: '', subtitle: '',
      primaryColor: '#dbb85a', accentColor: '#c0392b', fontStyle: 'Helvetica Neue',
      titleSize: 'large', titleAlign: 'center',
      buttonStyle: 'outline', buttonLayout: 'horizontal',
      overlayOpacity: 50, showTitle: true, showChapterMenu: true, showLanguageMenu: true,
      backgroundImage: null, backgroundVideo: null,
      customPlayText: 'PLAY', customChaptersText: 'CHAPTERS', customAudioText: 'AUDIO',
      textStroke: false, textStrokeColor: '#000000', textStrokeWidth: 2,
      showEpisodeMenu: true, showAudioMenu: true, showSubtitleMenu: true, showButtonEmojis: true,
      episodeMenuStyle: 'list',  // 'list' or 'grid'
      logoImage: null,
    },
  },
  form: {
    audio:    { lang:LANGUAGES[0], fmt:AUDIO_FORMATS[0], label:'', isDefault:false, file:null },
    subtitle: { lang:LANGUAGES[0], fmt:SUBTITLE_FMTS[0], isForced:false, isSDH:false, description:'', file:null },
    chapter:  { name:'', time:'00:00:00', thumb:null },
    extras:   { name:'', type:EXTRAS_TYPES[0], file:null },
  },
  probeData: null,
  mkv: { file:null, probing:false, probeData:null, tracks:[], imported:false },
  embeddedTracks: [],   // auto-detected tracks from added video files
  burning: false, burnStatus: null, burnMessage: '', burnDone: false, burnError: null,
  menuPreviewScreen: 'main',  // 'main', 'episodes', 'audio', 'subtitles', 'chapters'
  showWelcome: true,  // show onboarding on first launch
  showAbout: false,
};

function uid()      { return Math.random().toString(36).slice(2,9); }
function setState(p){
  Object.assign(state, p);
  // For tab switches and modal changes, render immediately
  // For text input changes, render is already batched via scheduleRender
  render();
}
function setPrj(p)  { setState({ project: { ...state.project, ...p } }); }
function setPrjText(p) {
  // Used for text inputs — saves focus before re-render
  const activeEl = document.activeElement;
  if (activeEl && activeEl.id) {
    _focusedId  = activeEl.id;
    _focusedPos = activeEl.selectionStart ?? null;
  }
  Object.assign(state, { project: { ...state.project, ...p } });
  render();
}
function setForm(t,p){ setState({ form: { ...state.form, [t]: { ...state.form[t], ...p } } }); }
function setMenu(p) { setPrj({ menuConfig: { ...state.project.menuConfig, ...p } }); }
function esc(s)     { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const tools    = await window.discForge.checkTools();
  const homeDir  = await window.discForge.getHomeDir();
  const outputDir = homeDir + '/Desktop';
  setState({ tools, project: { ...state.project, outputDir } });

  // Load installed system fonts
  try {
    if (window.queryLocalFonts) {
      const fonts = await window.queryLocalFonts();
      const unique = [...new Set(fonts.map(f => f.family))].sort();
      state.systemFonts = unique;
    }
  } catch(e) {
    // queryLocalFonts not available or permission denied - use defaults
    state.systemFonts = [];
  }
  window.discForge.onBuildProgress(handleBuildProgress);
  window.discForge.onFFmpegProgress(line => {
    state.ffmpegLog = line;
    const el = document.getElementById('ffmpeg-log');
    if (el) { el.textContent = line; }
    appendLog(line);
  });

  // Apply light mode on startup
  document.body.classList.toggle('light-mode', state.lightMode);
}

// ── File pickers ──────────────────────────────────────────────────────────────
async function pickFile(filters) {
  const r = await window.discForge.openFileDialog({ filters });
  if (!r) return null;
  // Normalize: may be string (old) or { path, name, size } (new)
  if (typeof r === 'string') return { path: r, name: r.split('/').pop(), size: 0 };
  return r;
}
async function pickMainVideo() {
  const r = await pickFile([{ name:'Video', extensions:['mkv','mp4','ts','m2ts','avi','mov','wmv','vob'] }]);
  if (!r) return;
  setPrj({ mainVideo:{ name: r.name, path: r.path, size: r.size } });
  const probe = await window.discForge.probeFile(r.path);
  if (probe.success) setState({ probeData: probe.data });
}
async function pickAudio() {
  const r = await pickFile([{ name:'Audio', extensions:['dts','ac3','eac3','wav','flac','aac','mka','truehd'] }]);
  if (r) setForm('audio', { file: r });
}
async function pickSubtitle() {
  const r = await pickFile([{ name:'Subtitle', extensions:['srt','ass','ssa','sub','vtt','sup','idx'] }]);
  if (r) setForm('subtitle', { file: r });
}
async function pickChapterThumb() {
  const r = await pickFile([{ name:'Image', extensions:['png','jpg','jpeg','webp'] }]);
  if (r) setForm('chapter', { thumb: r });
}
async function pickExtrasFile() {
  const r = await pickFile([{ name:'Video', extensions:['mkv','mp4','ts','m2ts','avi','mov'] }]);
  if (r) setForm('extras', { file: r });
}
async function pickOutputDir() {
  const d = await window.discForge.openFolderDialog();
  if (d) setPrj({ outputDir:d });
}
async function pickMenuBg(isVideo) {
  const r = await pickFile(isVideo
    ? [{ name:'Video', extensions:['mp4','mkv','mov','m2ts'] }]
    : [{ name:'Image', extensions:['png','jpg','jpeg','webp'] }]);
  if (!r) return;
  setMenu(isVideo ? { backgroundVideo: r } : { backgroundImage: r });
}

// ── Track add/remove ───────────────────────────────────────────────────────────
function addAudio() {
  const f = state.form.audio; if (!f.file) return;
  setPrj({ audioTracks:[...state.project.audioTracks, { id:uid(), language:f.lang, format:f.fmt, label:f.label||f.lang, isDefault:f.isDefault, file:f.file }] });
  setForm('audio', { file:null, label:'', isDefault:false });
}
function addSubtitle() {
  const f = state.form.subtitle; if (!f.file) return;
  setPrj({ subtitleTracks:[...state.project.subtitleTracks, { id:uid(), language:f.lang, format:f.fmt, isForced:f.isForced, isSDH:f.isSDH, description:f.description||'', file:f.file }] });
  setForm('subtitle', { file:null });
}
function addChapter() {
  const f = state.form.chapter; if (!f.name||!f.time) return;
  const chapters = [...state.project.chapters, { id:uid(), name:f.name, time:f.time, thumb:f.thumb }]
    .sort((a,b)=>a.time.localeCompare(b.time));
  setPrj({ chapters });
  setForm('chapter', { name:'', time:'00:00:00', thumb:null });
}
function addExtra() {
  const f = state.form.extras; if (!f.name||!f.file) return;
  setPrj({ extras:[...state.project.extras, { id:uid(), name:f.name, type:f.type, file:f.file }] });
  setForm('extras', { name:'', file:null });
}
function removeTrack(list, id) {
  const update = { audioTracks:'audioTracks', subtitleTracks:'subtitleTracks', chapters:'chapters', extras:'extras' };
  return id => setPrj({ [list]: state.project[list].filter(t=>t.id!==id) });
}
const rmAudio    = id => setPrj({ audioTracks:    state.project.audioTracks.filter(t=>t.id!==id) });
const rmSubtitle = id => setPrj({ subtitleTracks: state.project.subtitleTracks.filter(t=>t.id!==id) });
const rmChapter  = id => setPrj({ chapters:       state.project.chapters.filter(t=>t.id!==id) });
const rmExtra    = id => setPrj({ extras:         state.project.extras.filter(t=>t.id!==id) });

// ── MKV Import ─────────────────────────────────────────────────────────────────
async function pickMkvFile() {
  const p = await pickFile([{ name:'Video', extensions:['mkv','mp4','ts','m2ts','avi','mov'] }]);
  if (!p) return;
  setState({ mkv:{ file:{ name: p.name, path: p.path }, probing:true, probeData:null, tracks:[], imported:false } });
  const result = await window.discForge.probeFile(p.path);
  if (!result.success) { setState({ mkv:{ ...state.mkv, probing:false } }); return; }
  setState({ mkv:{ ...state.mkv, probing:false, probeData:result.data, tracks:parseMkvTracks(result.data, p.path) } });
}
function parseMkvTracks(data, filePath) {
  return (data.streams||[]).map((s,idx) => {
    const lang = streamLang(s);
    const base = { idx, codecType:s.codec_type, codecName:s.codec_name, lang, selected:true, filePath };
    if (s.codec_type==='video') return { ...base, role:'video', label:`${s.codec_name?.toUpperCase()} ${s.width}×${s.height} ${streamFps(s)}`, bdFormat:guessBDVideo(s.codec_name) };
    if (s.codec_type==='audio') { const t=s.tags?.title||''; return { ...base, role:'audio', label:`${s.codec_name?.toUpperCase()} ${s.channels||'?'}ch${t?' · '+t:''}`, bdFormat:guessBDAudio(s.codec_name), assignedLang:lang, trackLabel:t||lang, isDefault:idx===(data.streams||[]).findIndex(x=>x.codec_type==='audio') }; }
    if (s.codec_type==='subtitle') { const t=s.tags?.title||''; return { ...base, role:'subtitle', label:`${s.codec_name?.toUpperCase()} ${lang}${t?' · '+t:''}`, bdFormat:guessBDSub(s.codec_name), assignedLang:lang, isForced:!!(s.disposition?.forced), isSDH:t.toLowerCase().includes('sdh')||t.toLowerCase().includes('cc') }; }
    return { ...base, role:'other', label:`${s.codec_type}/${s.codec_name}`, selected:false };
  });
}
function streamLang(s) {
  const code = s.tags?.language||'und';
  return { eng:'English',fra:'French',fre:'French',spa:'Spanish',deu:'German',ger:'German',ita:'Italian',por:'Portuguese',jpn:'Japanese',kor:'Korean',zho:'Mandarin',chi:'Mandarin',rus:'Russian',ara:'Arabic',hin:'Hindi',nld:'Dutch',swe:'Swedish',nor:'Norwegian',dan:'Danish',fin:'Finnish',pol:'Polish',ces:'Czech',hun:'Hungarian',ron:'Romanian',tur:'Turkish',ell:'Greek',heb:'Hebrew',tha:'Thai',vie:'Vietnamese',ind:'Indonesian',msa:'Malay',und:'Unknown' }[code]||code;
}
function streamFps(s) { if (!s.r_frame_rate) return ''; const p=s.r_frame_rate.split('/'); return p.length===2?(parseFloat(p[0])/parseFloat(p[1])).toFixed(3)+'fps':''; }
function guessBDVideo(c) { return { h264:'H.264 AVC',hevc:'H.265 HEVC',vc1:'VC-1',mpeg2video:'MPEG-2' }[c]||'H.264 AVC'; }
function guessBDAudio(c) { return { dts:'DTS-HD Master Audio',truehd:'Dolby TrueHD',ac3:'Dolby Digital 5.1',eac3:'Dolby Digital 5.1',flac:'PCM 5.1',pcm_s16le:'LPCM Stereo',pcm_s24le:'PCM 5.1',aac:'Dolby Digital 5.1' }[c]||'Dolby Digital 5.1'; }
function guessBDSub(c)   { return { hdmv_pgs_subtitle:'PGS (Blu-ray Native)',subrip:'SRT',ass:'ASS',ssa:'SSA',dvd_subtitle:'SUB' }[c]||'SRT'; }
function selectAllMkvTracks(role) {
  const tracks = state.mkv.tracks.map(t => role ? (t.role===role ? {...t,selected:true} : t) : {...t,selected:true});
  setState({ mkv: { ...state.mkv, tracks } });
}
function deselectAllMkvTracks(role) {
  const tracks = state.mkv.tracks.map(t => role ? (t.role===role ? {...t,selected:false} : t) : {...t,selected:false});
  setState({ mkv: { ...state.mkv, tracks } });
}
function toggleMkvTrack(idx) { setState({ mkv:{ ...state.mkv, tracks:state.mkv.tracks.map(t=>t.idx===idx?{...t,selected:!t.selected}:t) } }); }
function updateMkvTrack(idx,patch) { setState({ mkv:{ ...state.mkv, tracks:state.mkv.tracks.map(t=>t.idx===idx?{...t,...patch}:t) } }); }
function importMkvTracks() {
  const { file, tracks, probeData } = state.mkv; if (!file||!tracks.length) return;
  const sel = tracks.filter(t=>t.selected);
  const vid = sel.find(t=>t.role==='video');
  const aud = sel.filter(t=>t.role==='audio');
  const sub = sel.filter(t=>t.role==='subtitle');
  const np  = { ...state.project };
  const title = file.name.replace(/\.mkv$/i,'').replace(/[._-]/g,' ').trim();
  if (vid) { np.mainVideo={ name:file.name, path:file.path, trackIndex:vid.idx }; np.videoFormat=vid.bdFormat; if(!np.title) np.title=title; }
  aud.forEach(t => { if (!np.audioTracks.some(a=>a.file.path===file.path&&a.trackIndex===t.idx)) np.audioTracks=[...np.audioTracks,{ id:uid(),language:t.assignedLang||t.lang,format:t.bdFormat,label:t.trackLabel||t.lang,isDefault:t.isDefault,file:{name:file.name,path:file.path},trackIndex:t.idx }]; });
  sub.forEach(t => { if (!np.subtitleTracks.some(s=>s.file.path===file.path&&s.trackIndex===t.idx)) np.subtitleTracks=[...np.subtitleTracks,{ id:uid(),language:t.assignedLang||t.lang,format:t.bdFormat,isForced:t.isForced,isSDH:t.isSDH,file:{name:file.name,path:file.path},trackIndex:t.idx }]; });
  if (probeData?.chapters?.length>0&&np.chapters.length===0) {
    np.chapters=probeData.chapters.map((ch,i)=>({ id:uid(),name:ch.tags?.title||`Chapter ${i+1}`,time:secToTc(parseFloat(ch.start_time||0)),thumb:null }));
  }
  setPrj(np);
  setState({ mkv:{ ...state.mkv, imported:true }, tab:0 });
}
function secToTc(sec) { const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60); return [h,m,s].map(v=>String(v).padStart(2,'0')).join(':'); }

// ── Build ──────────────────────────────────────────────────────────────────────
async function startBuild() {
  const p = state.project;
  if (!p.title || (!p.mainVideo && !(p.titles&&p.titles.length>0))) return;
  const additionalTitles = p.titles || [];
  const steps = [
    'Muxing main feature audio tracks', 'Validating mux output',
    'Generating menu image', 'Building disc structure',
    ...additionalTitles.map((t, i) => `Processing title ${i + 2}: ${(t.label || t.file?.name || 'Title').slice(0, 35)}`),
    ...(p.extras.length > 0 ? ['Processing special features'] : []),
    'Writing tsMuxeR project', 'Running tsMuxeR', 'Packaging ISO image',
  ];
  state.buildStartTime = Date.now();
  setState({ building:true, buildSteps:steps, buildCurrentStep:0, buildDone:false, buildError:null, builtIsoPath:null, ffmpegLog:'' });
  // Include enabled embedded tracks alongside manual tracks
  const includedEmbedded = (state.embeddedTracks||[]).filter(t => t.included !== false);
  const embeddedAudio = includedEmbedded.filter(t => t.role==='audio');
  const embeddedSubs  = includedEmbedded.filter(t => t.role==='subtitle');
  const buildProject = {
    ...p,
    audioTracks: [
      ...(p.audioTracks||[]).filter(t => !t.excluded),
      ...embeddedAudio.map(t => ({ ...t, file: { path: t.sourceFile, name: t.sourceFileName }, embedded: true })),
    ],
    subtitleTracks: [
      ...(p.subtitleTracks||[]).filter(t => !t.excluded),
      ...embeddedSubs.map(t => ({ ...t, file: { path: t.sourceFile, name: t.sourceFileName }, embedded: true })),
    ],
  };
  const result = await window.discForge.buildDisc(buildProject);
  if (result.error) setState({ buildError: result.error });
}
function appendLog(msg) {
  const el = document.getElementById('build-log-panel');
  if (el) {
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
}

function handleBuildProgress(data) {
  if (data.done) setState({ buildDone:true, builtIsoPath:data.isoPath, builtIsoSize:data.isoSize||0 });
  else if (data.step!==undefined) setState({ buildCurrentStep:data.step });
}
function closeBuildModal() {
  window.discForge.removeAllListeners('build-progress');
  window.discForge.removeAllListeners('ffmpeg-progress');
  window.discForge.onBuildProgress(handleBuildProgress);
  window.discForge.onFFmpegProgress(line => { state.ffmpegLog=line; const el=document.getElementById('ffmpeg-log'); if(el) el.textContent=line; });
  setState({ building:false, buildDone:false, buildError:null });
}
function revealISO() { if (state.builtIsoPath) window.discForge.revealInFinder(state.builtIsoPath); }

// ── Probe helper ───────────────────────────────────────────────────────────────
function probeDisplay() {
  const d = state.probeData; if (!d) return '';
  const vs = d.streams?.find(s=>s.codec_type==='video');
  const as = d.streams?.find(s=>s.codec_type==='audio');
  const dur = d.format?.duration ? `${Math.floor(d.format.duration/60)}m ${Math.floor(d.format.duration%60)}s` : '?';
  const size= d.format?.size ? `${(d.format.size/1e9).toFixed(2)} GB` : '?';
  const items = [
    ['Duration', dur], ['Size', size],
    ...(vs ? [['Video', `${vs.codec_name?.toUpperCase()} ${vs.width}×${vs.height}`]] : []),
    ...(as ? [['Audio', `${as.codec_name?.toUpperCase()} ${as.channel_layout||''}`]] : []),
    ['Bitrate', d.format?.bit_rate ? Math.round(d.format.bit_rate/1e6)+'Mbps' : '?'],
  ];
  return `<div class="probe-panel">${items.map(([k,v])=>`<div class="probe-item"><div class="probe-key">${k}</div><div class="probe-val">${esc(v)}</div></div>`).join('')}</div>`;
}

// ── Persistent Color Picker ──────────────────────────────────────────────────
const COLOR_PRESETS = [
  '#ffffff','#f0eade','#dbb85a','#c09030','#e67e22','#e74c3c','#c0392b',
  '#8e44ad','#2980b9','#27ae60','#1abc9c','#2c3e50','#7f8c8d','#000000',
  '#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff922b','#cc5de8','#339af0',
];

function colorPickerHTML(id, value, label) {
  return '<div class="field"><label class="field-label">' + label + '</label>' +
    '<div class="color-picker-wrap" id="cpw-' + id + '">' +
    '<div class="color-swatch" id="cs-' + id + '" style="background:' + value + '" data-cp-id="' + id + '"></div>' +
    '<input type="text" id="ct-' + id + '" value="' + value + '" style="flex:1;font-family:var(--font-mono);font-size:13px" />' +
    '<div class="color-popup hidden" id="cp-' + id + '">' +
    '<div class="color-hue-row">' +
    COLOR_PRESETS.map(function(col) {
      return '<div class="color-preset' + (col===value?' active':'') + '" style="background:' + col + '" data-cp-preset="' + id + '" data-color="' + col + '"></div>';
    }).join('') +
    '</div>' +
    '<input type="color" id="cc-' + id + '" value="' + value + '" />' +
    '<input type="text" id="ch-' + id + '" value="' + value + '" placeholder="#000000" />' +
    '</div>' +
    '</div></div>';
}

function attachColorPickers() {
  // Swatch click — toggle popup
  document.querySelectorAll('[data-cp-id]').forEach(function(swatch) {
    swatch.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = swatch.dataset.cpId;
      var popup = document.getElementById('cp-' + id);
      if (!popup) return;
      // Close all other popups
      document.querySelectorAll('.color-popup').forEach(function(p) {
        if (p !== popup) p.classList.add('hidden');
      });
      popup.classList.toggle('hidden');
    });
  });

  // Preset click
  document.querySelectorAll('[data-cp-preset]').forEach(function(preset) {
    preset.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = preset.dataset.cpPreset;
      var color = preset.dataset.color;
      applyColor(id, color);
    });
  });

  // Native color input
  ['menu-primary','menu-accent','menu-stroke-color'].forEach(function(id) {
    var cc = document.getElementById('cc-' + id);
    if (cc) cc.addEventListener('input', function(e) { applyColor(id, e.target.value); });
    var ch = document.getElementById('ch-' + id);
    if (ch) ch.addEventListener('input', function(e) {
      if (/^#[0-9a-f]{6}$/i.test(e.target.value)) applyColor(id, e.target.value);
    });
    var ct = document.getElementById('ct-' + id);
    if (ct) ct.addEventListener('input', function(e) {
      _focusedId = 'ct-' + id; _focusedPos = e.target.selectionStart;
      if (/^#[0-9a-f]{6}$/i.test(e.target.value)) applyColor(id, e.target.value);
    });
  });

  // Close popup on outside click
  document.addEventListener('click', function() {
    document.querySelectorAll('.color-popup').forEach(function(p) { p.classList.add('hidden'); });
  });
}

function applyColor(id, color) {
  // Update swatch
  var swatch = document.getElementById('cs-' + id);
  if (swatch) swatch.style.background = color;
  // Update text inputs
  var ct = document.getElementById('ct-' + id);
  if (ct) ct.value = color;
  var ch = document.getElementById('ch-' + id);
  if (ch) ch.value = color;
  var cc = document.getElementById('cc-' + id);
  if (cc) cc.value = color;
  // Update presets
  document.querySelectorAll('[data-cp-preset="' + id + '"]').forEach(function(p) {
    p.classList.toggle('active', p.dataset.color === color);
  });
  // Update state
  if (id === 'menu-primary') setMenu({ primaryColor: color });
  else if (id === 'menu-accent') setMenu({ accentColor: color });
  else if (id === 'menu-stroke-color') setMenu({ textStrokeColor: color });
}

// ── Menu preview HTML ──────────────────────────────────────────────────────────
function menuPreviewHTML() {
  const m = state.project.menuConfig, p = state.project;
  const screen = state.menuPreviewScreen || 'main';
  const bgMap = { 'Cinematic Dark':'#080810','Elegant White':'#f5f3ee','Retro Film':'#1a0e04','Minimal Type':'#f0eeea','Sci-Fi Grid':'#030a18','Organic Nature':'#0e1a0a' };
  const bg = bgMap[m.theme]||'#080810';
  const dark = parseInt(bg.slice(1,3),16)<100;
  const text = dark ? '#f0eade' : '#1a1a2a';
  const font = "'" + m.fontStyle + "'," + m.fontStyle;

  let bgStyle = 'background:' + bg;
  if (m.backgroundImage && m.backgroundImage.path) {
    bgStyle = "background:url('file://" + m.backgroundImage.path + "') center/cover no-repeat";
  }
  const opacity = (m.overlayOpacity !== undefined ? m.overlayOpacity : 50) / 100;
  const overlay = (m.backgroundImage || m.backgroundVideo) ? 'rgba(0,0,0,' + opacity + ')' : 'transparent';

  const titleSizeMap = { small:'18px', medium:'26px', large:'36px', xlarge:'52px' };
  const titleSize = titleSizeMap[m.titleSize||'large'] || '36px';
  const titleAlign = m.titleAlign || 'center';
  const btnStyle = m.buttonStyle || 'outline';
  const btnLayout = m.buttonLayout || 'horizontal';
  const emojis = m.showButtonEmojis !== false;
  const sw = m.textStrokeWidth || 2;
  const sc = m.textStrokeColor || '#000000';
  const strokeStyle = m.textStroke
    ? ('-webkit-text-stroke:' + sw + 'px ' + sc + ';text-shadow:' + sw + 'px 0 0 ' + sc + ',-' + sw + 'px 0 0 ' + sc + ',0 ' + sw + 'px 0 ' + sc + ',0 -' + sw + 'px 0 ' + sc + ';')
    : '';

  function getBtnCSS(accent, textCol, active) {
    var base = '';
    if (btnStyle === 'filled')    base = 'background:' + accent + ';color:#fff;border:none;padding:10px 24px;border-radius:4px';
    else if (btnStyle === 'minimal')   base = 'background:none;color:' + textCol + ';border:none;padding:8px 16px;letter-spacing:.15em';
    else if (btnStyle === 'pill')      base = 'background:' + accent + '22;color:' + textCol + ';border:1px solid ' + accent + ';padding:10px 28px;border-radius:999px';
    else if (btnStyle === 'underline') base = 'background:none;color:' + textCol + ';border:none;border-bottom:2px solid ' + accent + ';padding:6px 12px;border-radius:0';
    else base = 'background:' + accent + '18;color:' + textCol + ';border:1px solid ' + accent + '66;padding:10px 24px;border-radius:4px';
    if (active) base += ';box-shadow:0 0 0 2px ' + accent + ';filter:brightness(1.2)';
    return base + ';font-family:' + font + ';font-size:12px;letter-spacing:.08em;cursor:pointer;transition:all 0.15s';
  }

  var allTitles = [p.mainVideo, ...(p.titles||[]).map(function(t){return t.file;})].filter(Boolean);
  var hasEpisodes = allTitles.length > 1 && m.showEpisodeMenu !== false;
  var audioTracks = [...(p.audioTracks||[]), ...(state.embeddedTracks||[]).filter(function(t){return t.role==='audio';})];
  var subTracks = [...(p.subtitleTracks||[]), ...(state.embeddedTracks||[]).filter(function(t){return t.role==='subtitle';})];

  // Screen nav buttons (back arrow)
  var backBtn = '<div id="menu-sim-back" style="position:absolute;top:12px;left:12px;cursor:pointer;color:' + m.primaryColor + ';font-size:11px;z-index:10;padding:4px 8px;border:1px solid ' + m.primaryColor + '44;border-radius:4px;font-family:' + font + '">← BACK</div>';

  var content = '';

  if (screen === 'episodes') {
    content = backBtn +
      '<div style="width:100%;padding:8px 16px">' +
      '<div style="font-size:11px;color:' + m.primaryColor + ';letter-spacing:.12em;font-family:' + font + ';margin-bottom:12px;border-bottom:1px solid ' + m.primaryColor + '44;padding-bottom:8px">EPISODES</div>' +
      allTitles.map(function(ep, i) {
        var name = ep ? (ep.name||'').replace(/\.[^.]+$/, '') || ('Episode ' + (i+1)) : ('Episode ' + (i+1));
        return '<div id="menu-ep-' + i + '" style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;' + (i===0?'color:'+m.primaryColor+';':('color:'+text+';')) + 'font-family:' + font + ';font-size:11px" data-menu-action="ep-' + i + '">' +
          '<span style="color:' + m.primaryColor + ';width:20px;text-align:center;font-size:10px">' + (i===0?'▶':'') + (i+1) + '</span>' +
          '<span>' + name.slice(0, 30) + '</span>' +
        '</div>';
      }).join('') +
      '</div>';
  } else if (screen === 'audio') {
    content = backBtn +
      '<div style="width:100%;padding:8px 16px">' +
      '<div style="font-size:11px;color:' + m.primaryColor + ';letter-spacing:.12em;font-family:' + font + ';margin-bottom:12px;border-bottom:1px solid ' + m.primaryColor + '44;padding-bottom:8px">AUDIO</div>' +
      (audioTracks.length > 0 ? audioTracks.map(function(t, i) {
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer;' + (i===0?'color:'+m.primaryColor+';':('color:'+text+';')) + 'font-family:' + font + ';font-size:11px">' +
          '<span style="color:' + m.primaryColor + ';width:20px;font-size:10px">' + (i===0?'●':'○') + '</span>' +
          '<span>' + (t.label||t.language||'Track '+(i+1)) + '</span>' +
          '<span style="margin-left:auto;font-size:10px;opacity:0.6">' + (t.format||'') + '</span>' +
        '</div>';
      }).join('') : '<div style="color:' + text + '88;font-size:11px;font-family:' + font + '">No audio tracks configured</div>') +
      '</div>';
  } else if (screen === 'subtitles') {
    content = backBtn +
      '<div style="width:100%;padding:8px 16px">' +
      '<div style="font-size:11px;color:' + m.primaryColor + ';letter-spacing:.12em;font-family:' + font + ';margin-bottom:12px;border-bottom:1px solid ' + m.primaryColor + '44;padding-bottom:8px">SUBTITLES</div>' +
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.07);color:' + m.primaryColor + ';font-family:' + font + ';font-size:11px">' +
        '<span style="color:' + m.primaryColor + ';width:20px;font-size:10px">●</span><span>Off</span>' +
      '</div>' +
      (subTracks.length > 0 ? subTracks.map(function(t, i) {
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.07);color:' + text + ';font-family:' + font + ';font-size:11px">' +
          '<span style="width:20px;font-size:10px;color:' + text + '44">○</span>' +
          '<span>' + (t.description||t.language||'Track '+(i+1)) + '</span>' +
          (t.isForced ? '<span style="font-size:9px;opacity:0.6;margin-left:4px">Forced</span>' : '') +
          (t.isSDH ? '<span style="font-size:9px;opacity:0.6;margin-left:4px">SDH</span>' : '') +
        '</div>';
      }).join('') : '<div style="color:' + text + '88;font-size:11px;font-family:' + font + '">No subtitle tracks configured</div>') +
      '</div>';
  } else if (screen === 'chapters') {
    content = backBtn +
      '<div style="width:100%;padding:8px 16px">' +
      '<div style="font-size:11px;color:' + m.primaryColor + ';letter-spacing:.12em;font-family:' + font + ';margin-bottom:12px;border-bottom:1px solid ' + m.primaryColor + '44;padding-bottom:8px">CHAPTERS</div>' +
      (p.chapters.length > 0 ? p.chapters.map(function(ch, i) {
        return '<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid rgba(255,255,255,0.07);' + (i===0?'color:'+m.primaryColor+';':('color:'+text+';')) + 'font-family:' + font + ';font-size:11px;cursor:pointer">' +
          '<span style="color:' + m.primaryColor + ';width:20px;font-size:10px">' + (i+1) + '</span>' +
          '<span>' + esc(ch.name) + '</span>' +
          '<span style="margin-left:auto;font-size:10px;opacity:0.6;font-family:var(--font-mono)">' + ch.time + '</span>' +
        '</div>';
      }).join('') : '<div style="color:' + text + '88;font-size:11px;font-family:' + font + '">No chapters defined</div>') +
      '</div>';
  } else {
    // Main menu screen
    var playText = m.customPlayText || 'PLAY';
    var chapText = m.customChaptersText || 'CHAPTERS';

    var menuBtns = [
      { label: (emojis?'▶  ':'') + playText, action: 'play' },
      ...(hasEpisodes ? [{ label: (emojis?'📋  ':'') + 'EPISODES', action: 'episodes' }] : []),
      ...(p.chapters.length>0 && m.showChapterMenu ? [{ label: (emojis?'≡  ':'') + chapText, action: 'chapters' }] : []),
      ...(audioTracks.length>0 && m.showAudioMenu!==false ? [{ label: (emojis?'🔊  ':'') + 'AUDIO', action: 'audio' }] : []),
      ...(subTracks.length>0 && m.showSubtitleMenu!==false ? [{ label: (emojis?'💬  ':'') + 'SUBTITLES', action: 'subtitles' }] : []),
      ...(p.extras.length>0 ? [{ label: (emojis?'⬡  ':'') + 'EXTRAS', action: 'extras' }] : []),
    ];

    var btnFlexDir = btnLayout === 'vertical' ? 'column' : 'row';
    var btnAlign = btnLayout === 'vertical' ? 'center' : 'center';

    content = (m.showTitle!==false ? '<div style="color:' + m.primaryColor + ';font-family:' + font + ';font-size:' + titleSize + ';font-weight:700;text-align:' + titleAlign + ';letter-spacing:.05em;text-transform:uppercase;' + strokeStyle + 'margin-bottom:8px">' + esc(m.title||p.title||'DISC TITLE') + '</div>' : '') +
      (m.subtitle ? '<div style="color:' + text + 'aa;font-family:' + font + ';font-size:13px;text-align:' + titleAlign + ';letter-spacing:.08em;margin-bottom:12px">' + esc(m.subtitle) + '</div>' : '') +
      '<div style="display:flex;flex-direction:' + btnFlexDir + ';flex-wrap:wrap;gap:8px;justify-content:' + btnAlign + ';align-items:center">' +
      menuBtns.map(function(btn) {
        return '<div data-menu-action="' + btn.action + '" style="' + getBtnCSS(m.accentColor, text, false) + '">' + btn.label + '</div>';
      }).join('') +
      '</div>';
  }

  var screenLabel = { main:'Main Menu', episodes:'Episode Selection', audio:'Audio Selection', subtitles:'Subtitle Selection', chapters:'Chapter Selection' }[screen] || 'Main Menu';

  return '<div class="menu-preview-wrap">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
    '<div style="font-size:11px;color:var(--text-tertiary)">📺 ' + screenLabel + '</div>' +
    '<div style="display:flex;gap:4px">' +
    ['main','episodes','audio','subtitles','chapters'].map(function(s) {
      return '<div id="menu-nav-' + s + '" style="font-size:9px;padding:2px 8px;border-radius:4px;cursor:pointer;border:1px solid ' + (screen===s?'var(--gold)':'var(--border-dim)') + ';color:' + (screen===s?'var(--gold)':'var(--text-tertiary)') + ';background:' + (screen===s?'rgba(219,184,90,0.1)':'transparent') + '">' + s + '</div>';
    }).join('') +
    '</div></div>' +
    '<div class="menu-preview-inner" style="' + bgStyle + ';cursor:default">' +
    '<div style="position:absolute;inset:0;background:' + overlay + ';border-radius:inherit"></div>' +
    (m.theme==='Sci-Fi Grid' ? '<div class="menu-preview-grid-overlay"></div>' : '') +
    (m.logoImage && m.logoImage.path ? '<img src="file://' + m.logoImage.path + '" style="position:absolute;bottom:16px;left:16px;max-height:40px;opacity:0.8;z-index:2" />' : '') +
    '<div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:20px;text-align:center">' +
    content +
    '</div>' +
    '<div class="menu-preview-badge" style="color:' + text + '">BD-ROM 1920×1080</div>' +
    '</div></div>';
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render() {
  // Save scroll position before re-render
  const scroller = document.querySelector('.content');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  document.getElementById('app').innerHTML = buildHTML();
  attachListeners();

  // Restore scroll position after re-render
  if (scrollTop > 0) {
    const restored = document.querySelector('.content');
    if (restored) restored.scrollTop = scrollTop;
  }
}

function buildHTML() {
  const { tools, project:p, tab, building } = state;
  const canBuild = !!(p.title && (p.mainVideo || (p.titles && p.titles.length > 0)));

  return `
    ${titlebarHTML(tools)}
    <div class="layout">
      ${sidebarHTML(p, canBuild)}
      <div class="main">
        ${tabbarHTML(p, tab)}
        <div class="content">
          ${tab===0 ? pageProject(p) : ''}
          ${tab===1 ? pageMkvImport(state.mkv) : ''}
          ${tab===2 ? pageAudio(p, state.form.audio) : ''}
          ${tab===3 ? pageSubtitles(p, state.form.subtitle) : ''}
          ${tab===4 ? pageChapters(p, state.form.chapter) : ''}
          ${tab===5 ? pageMenu(p) : ''}
          ${tab===6 ? pageExtras(p, state.form.extras) : ''}
        </div>
      </div>
    </div>
    ${building ? buildModalHTML() : ''}
    ${state.burning ? burnModalHTML() : ''}
    ${state.showWelcome ? welcomeModalHTML() : ''}
    ${state.showAbout ? aboutModalHTML() : ''}
  `;
}

// ── Titlebar ───────────────────────────────────────────────────────────────────
function titlebarHTML(tools) {
  const pill = (name, ok) => `<div class="tool-pill ${ok?'ok':'err'}"><div class="tool-dot ${ok?'ok':'err'}"></div>${name}</div>`;
  return `<div class="titlebar">
    <div style="width:72px;-webkit-app-region:no-drag"></div>
    <div class="titlebar-brand">
      <div class="titlebar-logo">💿</div>
      <span class="titlebar-name">Disc Forge</span>
      <span class="titlebar-version">1.2</span>
    </div>
    <div class="titlebar-spacer"></div>
    <div class="titlebar-tools">
      <button class="btn btn-ghost btn-sm" id="toggle-theme" title="Toggle light/dark mode" style="font-size:14px;padding:4px 8px">${state.lightMode ? '🌙' : '☀️'}</button>
      <button class="btn btn-ghost btn-sm" id="about-btn" style="font-size:12px;padding:4px 8px">About</button>
      ${pill('FFmpeg',  tools.ffmpeg.found)}
      ${tools.tsmuxer.found ? pill('tsMuxeR', true) : '<div class="tool-pill warn"><div class="tool-dot warn"></div>tsMuxeR (optional)</div>'}
      ${pill('ffprobe', tools.ffprobe.found)}
    </div>
  </div>`;
}




// ── Sidebar ────────────────────────────────────────────────────────────────────
function discMeterHTML(p) {
  const DISC_SIZES = [
    { label: 'DVD-5',  gb: 4.7,  bytes: 4.7e9  },
    { label: 'BD-25',  gb: 25,   bytes: 25e9   },
    { label: 'BD-50',  gb: 50,   bytes: 50e9   },
    { label: 'BD-100', gb: 100,  bytes: 100e9  },
  ];

  // If we have a built ISO, use its actual size for accuracy
  // Otherwise estimate from source files with a 0.6 compression factor
  // (source MKVs are typically 40-60% larger than the muxed output)
  let usedBytes = 0;
  let usingActual = false;

  if (state.builtIsoPath && state.builtIsoSize) {
    usedBytes = state.builtIsoSize;
    usingActual = true;
  } else {
    let rawBytes = 0;
    if (p.mainVideo?.size) rawBytes += p.mainVideo.size;
    (p.titles||[]).forEach(t => { if (t.file?.size) rawBytes += t.file.size; });
    (p.audioTracks||[]).forEach(t => { if (t.file?.size) rawBytes += t.file.size; });
    (p.subtitleTracks||[]).forEach(t => { if (t.file?.size) rawBytes += t.file.size; });
    (p.extras||[]).forEach(t => { if (t.file?.size) rawBytes += t.file.size; });
    // Apply compression estimate — muxed output is typically ~60% of source size
    usedBytes = Math.round(rawBytes * 0.6);
  }

  const selectedDisc = p.discSize || 'BD-25';
  const currentDisc = DISC_SIZES.find(d => d.label === selectedDisc) || DISC_SIZES[1];

  const pct = Math.min(100, (usedBytes / currentDisc.bytes) * 100);
  const usedGb = (usedBytes / 1e9).toFixed(2);
  const freeGb = Math.max(0, (currentDisc.bytes - usedBytes) / 1e9).toFixed(2);
  const barColor = pct > 90 ? '#e74c3c' : pct > 75 ? '#e67e22' : 'var(--gold)';
  const overFill = usedBytes > currentDisc.bytes;
  const label = usingActual ? usedGb + ' GB (actual ISO)' : '~' + usedGb + ' GB (estimated)';

  return `
    <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${label}</span>
      <select id="disc-size-select" style="font-size:10px;padding:2px 6px;height:22px;width:auto">
        ${DISC_SIZES.map(d => `<option ${selectedDisc===d.label?'selected':''}>${d.label}</option>`).join('')}
      </select>
    </div>
    <div style="background:var(--bg-input);border-radius:6px;height:10px;overflow:hidden;margin-bottom:6px;border:1px solid var(--border-dim)">
      <div style="height:100%;width:${pct.toFixed(1)}%;background:${overFill?'#e74c3c':barColor};border-radius:6px;transition:width 0.3s ease"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-tertiary)">
      <span style="color:${overFill?'#e74c3c':'inherit'}">${pct.toFixed(0)}% full${overFill?' ⚠ Over capacity!':''}</span>
      <span>Space remaining: ${freeGb} GB</span>
    </div>
    ${usingActual ? '' : '<div style="font-size:9px;color:var(--text-tertiary);margin-top:4px;opacity:0.7">Estimate based on source files — actual output is usually smaller</div>'}
  `;
}

function sidebarHTML(p, canBuild) {
  const items = [
    ['🎬','Video', (() => {
      const total = (p.mainVideo?1:0) + (p.titles||[]).length;
      return total > 0 ? `✓ ${total} video${total!==1?'s':''}` : 'None';
    })(), !!(p.mainVideo || (p.titles&&p.titles.length>0))],
    ['🔊','Audio',    `${p.audioTracks.length} track${p.audioTracks.length!==1?'s':''}`,  p.audioTracks.length>0],
    ['💬','Subtitles',`${p.subtitleTracks.length} track${p.subtitleTracks.length!==1?'s':''}`, p.subtitleTracks.length>0],
    ['≡', 'Chapters', `${p.chapters.length} marker${p.chapters.length!==1?'s':''}`,       p.chapters.length>0],
    ['🎞','Extras',   `${p.extras.length} item${p.extras.length!==1?'s':''}`,              p.extras.length>0],
  ];
  return `<div class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-project-title">${esc(p.title) || 'Untitled Project'}</div>
      <div class="sidebar-project-hint">${p.mainVideo ? esc(p.mainVideo.name) : 'No video selected'}</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Disc Contents</div>
      ${items.map(([icon,k,v,has])=>`
        <div class="summary-item">
          <div class="summary-icon ${has?'has-data':''}">${icon}</div>
          <div class="summary-text">
            <div class="summary-key">${k}</div>
            <div class="summary-val ${has?'has-data':''}">${v}</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="sidebar-output">
      <div class="sidebar-label">Output</div>
      <div class="output-path">${esc(p.outputDir) || 'Not set'}</div>
      <button class="btn btn-ghost btn-sm btn-full" id="pick-output">📂 Change folder</button>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn btn-ghost btn-sm" style="flex:1" id="save-project-btn">💾 Save</button>
        <button class="btn btn-ghost btn-sm" style="flex:1" id="load-project-btn">📂 Load</button>
      </div>
    </div>
    <div class="sidebar-disc-meter">
      <div class="sidebar-label">Disc Capacity</div>
      ${discMeterHTML(p)}
    </div>
    <div class="sidebar-spacer"></div>
    <div class="sidebar-build">
      <button class="btn-build" id="build-btn" ${!canBuild?'disabled':''}>
        <span class="btn-build-icon">🔨</span> Build Disc Image
      </button>
      ${!canBuild?'<p style="color:var(--text-tertiary);font-size:11px;text-align:center;margin-top:8px;line-height:1.5">Add a disc title and<br>at least one video to get started</p>':''}
      ${state.builtIsoPath ? `
        <button class="btn btn-ghost btn-full" id="burn-btn" style="margin-top:10px;border-color:rgba(220,80,80,0.4);color:#e05050">
          💿 Burn to Disc
        </button>` : ''}
    </div>
  </div>`;
}

// ── Tab Bar ────────────────────────────────────────────────────────────────────
function tabbarHTML(p, activeTab) {
  const counts = [0, 0, p.audioTracks.length, p.subtitleTracks.length, p.chapters.length, 0, p.extras.length];
  return `<div class="tabbar">
    ${TABS.map((t,i)=>`
      <button class="tab-btn ${i===activeTab?'active':''}" data-tab="${i}">
        <span class="tab-icon">${t.icon}</span>
        ${t.label}
        ${counts[i]>0?`<span class="tab-count">${counts[i]}</span>`:''}
      </button>`).join('')}
  </div>`;
}

// ── Page: Project ─────────────────────────────────────────────────────────────
function pageProject(p) {
  const t = state.tools;

  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Project Settings</div>
        <div class="page-subtitle">Configure disc metadata, source video, and output format</div>
      </div>
    </div>



    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">📋</div>
        <div><div class="card-title">Disc Metadata</div><div class="card-subtitle">Title and description shown in disc menus</div></div>
      </div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Disc Title</label>
            <input type="text" id="proj-title" value="${esc(p.title)}" placeholder="My Feature Film" />
          </div>
          <div class="field">
            <label class="field-label">Disc Label</label>
            <input type="text" id="proj-label" value="${esc(p.discLabel)}" placeholder="MY_FILM_2024" />
          </div>
        </div>
        <div class="field">
          <label class="field-label">Description</label>
          <textarea id="proj-desc" placeholder="Brief description of disc content…">${esc(p.description)}</textarea>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">⚙️</div>
        <div><div class="card-title">Video Format</div><div class="card-subtitle">Target resolution and codec for the disc</div></div>
      </div>
      <div class="card-body">
        <div class="grid-2">
          <div class="field">
            <label class="field-label">Resolution</label>
            <select id="proj-res">${RESOLUTIONS.map(r=>`<option ${p.resolution===r?'selected':''}>${r}</option>`).join('')}</select>
          </div>
          <div class="field">
            <label class="field-label">Video Codec</label>
            <select id="proj-vcodec">${VIDEO_FMTS.map(r=>`<option ${p.videoFormat===r?'selected':''}>${r}</option>`).join('')}</select>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-icon">🎬</div>
        <div><div class="card-title">Video Titles</div><div class="card-subtitle">Add one or more video files — each becomes a separate title on the disc</div></div>
      </div>
      <div class="card-body">
        <button class="btn btn-primary btn-sm" id="add-title-btn" style="margin-bottom:16px">+ Add Videos</button>
        ${(() => {
          const allTitles = [
            ...(p.mainVideo ? [{ id:'__main__', file: p.mainVideo, label: p.mainVideo.name.replace(/\.[^.]+$/, '') }] : []),
            ...(p.titles || [])
          ];
          if (allTitles.length === 0) return `
            <div class="empty-state">
              <div class="empty-state-icon">🎬</div>
              <div class="empty-state-text">No videos added yet — click + Add Videos to get started</div>
            </div>`;
          return `<div class="track-list">${allTitles.map((t, i) => `
            <div class="track-card" style="flex-direction:column;align-items:stretch;gap:8px">
              <div style="display:flex;align-items:center;gap:10px">
                <span class="track-num">${i + 1}</span>
                <div class="track-icon-wrap">🎬</div>
                <div class="track-body">
                  <div class="track-detail" style="font-size:11px">${esc(t.file.name)}</div>
                </div>
                <div class="track-actions">
                  ${i === 0 && p.mainVideo ? '<span class="badge badge-gold">Main</span>' : ''}
                  <button class="btn btn-danger" data-rm-title="${t.id}">✕</button>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;padding-left:60px">
                <label style="font-size:11px;color:var(--text-tertiary);white-space:nowrap">Menu name:</label>
                <input type="text" class="title-label-input" id="tl-${t.id}" data-title-id="${t.id}" value="${esc(t.label || t.file.name.replace(/\.[^.]+$/, ''))}" placeholder="Episode name shown in menu" style="flex:1;font-size:12px;padding:4px 8px" />
              </div>
            </div>`).join('')}</div>`;
        })()}
        ${probeDisplay()}
        <div style="margin-top:12px">
          <div class="info-panel gold">
            <div class="info-panel-title">💡 Encoding pipeline</div>
            <ul>
              <li>First video becomes the main feature; additional videos become separate titles</li>
              <li>Video is stream-copied when the codec is already BD-compatible (no re-encode)</li>
              <li>tsMuxeR compiles the BD navigation — required for hardware player compatibility</li>
              <li>macOS hdiutil packages the final UDF 2.5 + ISO 9660 hybrid disc image</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    ${(state.embeddedTracks.length > 0 || p.audioTracks.length > 0 || p.subtitleTracks.length > 0 || p.chapters.length > 0) ? `
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="card-icon">📋</div>
        <div><div class="card-title">Track Summary</div><div class="card-subtitle">Select which tracks to burn to disc — uncheck to exclude</div></div>
      </div>
      <div class="card-body">
        ${state.embeddedTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">📹 Embedded Tracks (from video files)</div>
            ${(() => {
              const audio = state.embeddedTracks.filter(t => t.role === 'audio');
              const subs  = state.embeddedTracks.filter(t => t.role === 'subtitle');
              return [
                audio.length > 0 ? `<div style="margin-bottom:10px">
                  <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px;font-weight:600">🔊 Audio</div>
                  ${audio.map(t => `
                    <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:4px">
                      <input type="checkbox" ${t.included!==false?'checked':''} data-toggle-embedded="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                      <div style="flex:1;min-width:0">
                        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t.label||t.language)}</div>
                        <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.codec} · Stream #${t.streamIndex} · ${esc(t.sourceFileName)}</div>
                      </div>
                      <div style="display:flex;gap:4px">
                        <span class="badge badge-blue">${t.language}</span>
                        <span class="badge badge-green">${t.format}</span>
                        ${t.isDefault?'<span class="badge badge-gold">Default</span>':''}
                      </div>
                    </div>`).join('')}
                </div>` : '',
                subs.length > 0 ? `<div>
                  <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px;font-weight:600">💬 Subtitles</div>
                  ${subs.map(t => `
                    <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:4px">
                      <input type="checkbox" ${t.included!==false?'checked':''} data-toggle-embedded="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                      <div style="flex:1;min-width:0">
                        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t.description||t.language)}</div>
                        <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.codec} · Stream #${t.streamIndex}${t.isForced?' · Forced':''}${t.isSDH?' · SDH':''} · ${esc(t.sourceFileName)}</div>
                      </div>
                      <div style="display:flex;gap:4px">
                        <span class="badge badge-blue">${t.language}</span>
                        ${t.isForced?'<span class="badge badge-gold">Forced</span>':''}
                        ${t.isSDH?'<span class="badge badge-purple">SDH</span>':''}
                      </div>
                    </div>`).join('')}
                </div>` : ''
              ].filter(Boolean).join('');
            })()}
          </div>` : ''}
        ${p.audioTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">🔊 Audio Tracks</div>
            ${p.audioTracks.map((t,i) => `
              <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:6px">
                <input type="checkbox" ${t.excluded?'':'checked'} data-toggle-audio="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                <span class="track-num" style="min-width:24px">${i+1}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:2px">${esc(t.label)||t.language}</div>
                  <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.format}${t.isDefault?' · <strong>Default</strong>':''}${t.file?(' · '+esc(t.file.name)):''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="badge badge-blue">${t.language}</span>
                  <span class="badge badge-green">${t.format}</span>
                  ${t.isDefault?'<span class="badge badge-gold">Default</span>':''}
                </div>
              </div>`).join('')}
          </div>` : ''}
        ${p.subtitleTracks.length > 0 ? `
          <div style="margin-bottom:16px">
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">💬 Subtitle Tracks</div>
            ${p.subtitleTracks.map((t,i) => `
              <div class="track-card" style="padding:10px 12px;display:flex;align-items:center;gap:12px;margin-bottom:6px">
                <input type="checkbox" ${t.excluded?'':'checked'} data-toggle-sub="${t.id}" style="width:16px;height:16px;cursor:pointer;accent-color:var(--gold)" />
                <span class="track-num" style="min-width:24px">${i+1}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:2px">${esc(t.description)||t.language}</div>
                  <div style="font-size:11px;color:var(--text-tertiary)">${t.language} · ${t.format}${t.isForced?' · Forced':''}${t.isSDH?' · SDH':''}${t.file?(' · '+esc(t.file.name)):''}</div>
                </div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
                  <span class="badge badge-blue">${t.language}</span>
                  ${t.isForced?'<span class="badge badge-gold">Forced</span>':''}
                  ${t.isSDH?'<span class="badge badge-purple">SDH</span>':''}
                </div>
              </div>`).join('')}
          </div>` : ''}
        ${p.chapters.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--text-tertiary);text-transform:uppercase;margin-bottom:8px">≡ Chapters</div>
            ${p.chapters.map((ch,i) => `
              <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-dim)">
                <span style="color:var(--gold);font-size:11px;font-weight:700;width:20px">${i+1}</span>
                <div style="flex:1;font-size:13px;color:var(--text-primary)">${esc(ch.name)}</div>
                <span style="font-size:11px;color:var(--text-tertiary)">${ch.time}</span>
              </div>`).join('')}
          </div>` : ''}
      </div>
    </div>` : ''}`;
}

// ── Page: MKV Import ───────────────────────────────────────────────────────────
function pageMkvImport(mkv) {
  const dur  = mkv.probeData?.format?.duration ? `${Math.floor(mkv.probeData.format.duration/60)}m ${Math.floor(mkv.probeData.format.duration%60)}s` : null;
  const size = mkv.probeData?.format?.size ? `${(mkv.probeData.format.size/1e9).toFixed(2)} GB` : null;
  const chapCount = mkv.probeData?.chapters?.length||0;
  const roleIcon  = { video:'🎬', audio:'🔊', subtitle:'💬', other:'⚙️' };
  const roleBadge = { video:'badge-blue', audio:'badge-green', subtitle:'badge-purple', other:'badge-gold' };

  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Video Import</div>
        <div class="page-subtitle">Import video files and automatically detect all embedded tracks</div>
      </div>
    </div>

    <div class="drop-zone ${mkv.file?'has-file':''}" id="pick-mkv-file" style="margin-bottom:20px">
      <div class="dz-icon" style="font-size:22px">📦</div>
      <div class="dz-text">
        <div class="dz-label ${mkv.file?'active':''}">${mkv.file ? esc(mkv.file.name) : 'Click to select video file (MKV, MP4, M2TS, TS…)'}</div>
        <div class="dz-hint">All embedded audio, subtitle and chapter tracks are detected automatically</div>
      </div>
    </div>

    ${mkv.probing ? `<div style="text-align:center;padding:40px 0;color:var(--text-secondary)">
      <div style="font-size:36px;margin-bottom:12px;animation:spin 1.5s linear infinite;display:inline-block">🔍</div>
      <div style="font-size:14px;font-weight:500">Probing file with ffprobe…</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">Detecting streams, languages and chapters</div>
    </div>
    <style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>` : ''}

    ${mkv.probeData && !mkv.probing ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        ${dur  ? `<span class="badge badge-blue">⏱ ${dur}</span>` : ''}
        ${size ? `<span class="badge badge-gold">💾 ${size}</span>` : ''}
        ${chapCount ? `<span class="badge badge-green">≡ ${chapCount} chapter${chapCount!==1?'s':''}</span>` : ''}
        <span class="badge badge-purple">${mkv.tracks.length} streams</span>
      </div>

      <div class="section-divider">
        <div class="section-divider-bar"></div>
        <span class="section-divider-title">Select tracks to import</span>
        <div class="section-divider-line"></div>
        <span style="font-size:11px;color:var(--text-tertiary)">${mkv.tracks.filter(t=>t.selected).length} of ${mkv.tracks.length} selected</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        <button class="btn btn-ghost btn-sm" id="mkv-select-all">☑ Select All</button>
        <button class="btn btn-ghost btn-sm" id="mkv-deselect-all">☐ Deselect All</button>
        <div style="width:1px;background:var(--border-dim);margin:0 4px"></div>
        <button class="btn btn-ghost btn-sm" id="mkv-select-audio">🔊 All Audio</button>
        <button class="btn btn-ghost btn-sm" id="mkv-select-subs">💬 All Subtitles</button>
        <button class="btn btn-ghost btn-sm" id="mkv-deselect-subs">💬 No Subtitles</button>
      </div>

      <div class="track-list" style="margin-bottom:20px">
        ${mkv.tracks.map(t=>`
          <div class="mkv-track-card ${t.selected?'selected':''}">
            <input type="checkbox" ${t.selected?'checked':''} data-mkv-toggle="${t.idx}" style="margin-top:3px" />
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span style="font-size:16px">${roleIcon[t.role]||'⚙️'}</span>
                <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(t.label)}</span>
                <span class="badge ${roleBadge[t.role]||'badge-gold'}">${t.role}</span>
              </div>
              <div style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono);margin-bottom:6px">Stream #${t.idx} · ${t.codecName}</div>
              ${t.role==='audio'||t.role==='subtitle' ? `
                <div class="mkv-track-controls">
                  <select data-mkv-lang="${t.idx}" style="width:auto">
                    ${LANGUAGES.map(l=>`<option ${(t.assignedLang||t.lang)===l?'selected':''}>${l}</option>`).join('')}
                  </select>
                  ${t.role==='audio' ? `
                    <select data-mkv-afmt="${t.idx}" style="width:auto">
                      ${AUDIO_FORMATS.map(f=>`<option ${t.bdFormat===f?'selected':''}>${f}</option>`).join('')}
                    </select>` : ''}
                  ${t.role==='subtitle' ? `
                    <label class="check-label" style="font-size:11px"><input type="checkbox" data-mkv-forced="${t.idx}" ${t.isForced?'checked':''} /> Forced</label>
                    <label class="check-label" style="font-size:11px"><input type="checkbox" data-mkv-sdh="${t.idx}" ${t.isSDH?'checked':''} /> SDH</label>` : ''}
                </div>` : ''}
            </div>
          </div>`).join('')}
      </div>

      ${chapCount > 0 ? `<div class="info-panel green" style="margin-bottom:16px">
        <div class="info-panel-title">✓ ${chapCount} chapter${chapCount!==1?'s':''} detected</div>
        <p style="font-size:12px;color:var(--text-secondary)">Chapter names and timecodes will be imported automatically.</p>
      </div>` : ''}

      ${mkv.imported ? `<div class="info-panel gold" style="margin-bottom:16px">
        <div class="info-panel-title">✓ Import complete</div>
        <p style="font-size:12px;color:var(--text-secondary)">Tracks added to your project. Switch to the <strong>Project</strong> tab to review and build.</p>
      </div>` : ''}

      <button class="btn btn-primary btn-lg" id="import-mkv-btn">⬇ Import Selected Tracks</button>
    ` : ''}

    ${!mkv.file && !mkv.probing ? `<div class="info-panel gold" style="margin-top:4px">
      <div class="info-panel-title">💡 What this does</div>
      <ul>
        <li>Probes the file with ffprobe to detect all embedded streams</li>
        <li>Auto-detects audio and subtitle languages from metadata tags</li>
        <li>Imports chapter markers with names and exact timecodes</li>
        <li>Maps codecs to Blu-ray compatible formats automatically</li>
        <li>You can import multiple files — tracks are merged into the project</li>
      </ul>
    </div>` : ''}`;
}

// ── Page: Audio ────────────────────────────────────────────────────────────────
function pageAudio(p, f) {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Audio Tracks</div>
        <div class="page-subtitle">Add multiple language audio streams — supports all lossless formats</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div class="card-icon">➕</div>
        <div><div class="card-title">Add Track</div></div>
      </div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Language</label>
            <select id="a-lang">${LANGUAGES.map(l=>`<option ${f.lang===l?'selected':''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label class="field-label">Format</label>
            <select id="a-fmt">${AUDIO_FORMATS.map(l=>`<option ${f.fmt===l?'selected':''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="field" style="margin-bottom:14px"><label class="field-label">Track Label (optional)</label>
          <input type="text" id="a-label" value="${esc(f.label)}" placeholder='e.g. "Director Commentary"' /></div>
        <div class="drop-zone compact ${f.file?'has-file':''}" id="pick-audio-file" style="margin-bottom:14px">
          <div class="dz-icon" style="width:32px;height:32px;font-size:16px">🔊</div>
          <div class="dz-text"><div class="dz-label ${f.file?'active':''}">${f.file?esc(f.file.name):'Click to select audio file'}</div>
            <div class="dz-hint">.dts · .truehd · .ac3 · .wav · .flac · .aac</div></div>
        </div>
        <div class="field-row">
          <label class="check-label"><input type="checkbox" id="a-default" ${f.isDefault?'checked':''} /> Set as default track</label>
          <button class="btn btn-primary btn-sm" id="add-audio" ${!f.file?'disabled':''}>+ Add Track</button>
        </div>
      </div>
    </div>
    ${p.audioTracks.length===0
      ? `<div class="empty-state"><div class="empty-state-icon">🔊</div><div class="empty-state-text">No audio tracks added yet</div></div>`
      : `<div class="track-list">${p.audioTracks.map((t,i)=>`
          <div class="track-card">
            <span class="track-num">${i+1}</span>
            <div class="track-icon-wrap">🔊</div>
            <div class="track-body">
              <div class="track-name">${esc(t.label)}</div>
              <div class="track-detail">${esc(t.file.name)}</div>
            </div>
            <div class="track-actions">
              <span class="badge badge-blue">${t.language}</span>
              <span class="badge badge-green">${t.format}</span>
              ${t.isDefault?'<span class="badge badge-gold">DEFAULT</span>':''}
              <button class="btn btn-danger" data-rm-audio="${t.id}">✕</button>
            </div>
          </div>`).join('')}</div>`}`;
}

// ── Page: Subtitles ────────────────────────────────────────────────────────────
function pageSubtitles(p, f) {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Subtitle Tracks</div>
        <div class="page-subtitle">Multi-language subtitles — SRT is auto-converted to PGS by tsMuxeR</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">➕</div><div><div class="card-title">Add Subtitles</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Language</label>
            <select id="s-lang">${LANGUAGES.map(l=>`<option ${f.lang===l?'selected':''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label class="field-label">Format</label>
            <select id="s-fmt">${SUBTITLE_FMTS.map(l=>`<option ${f.fmt===l?'selected':''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="drop-zone compact ${f.file?'has-file':''}" id="pick-sub-file" style="margin-bottom:14px">
          <div class="dz-icon" style="width:32px;height:32px;font-size:16px">💬</div>
          <div class="dz-text"><div class="dz-label ${f.file?'active':''}">${f.file?esc(f.file.name):'Click to select subtitle file'}</div>
            <div class="dz-hint">.srt · .ass · .vtt · .sup (PGS)</div></div>
        </div>
        <div class="field" style="margin-bottom:10px">
          <label class="field-label">Description <span style="color:var(--text-tertiary);font-weight:400">(optional)</span></label>
          <input type="text" id="s-desc" value="${esc(f.description)}" placeholder="e.g. English SDH for the hearing impaired" />
        </div>
        <div class="field-row">
          <label class="check-label"><input type="checkbox" id="s-forced" ${f.isForced?'checked':''} /> Forced subtitles</label>
          <label class="check-label"><input type="checkbox" id="s-sdh" ${f.isSDH?'checked':''} /> SDH / CC</label>
          <button class="btn btn-primary btn-sm" id="add-sub" ${!f.file?'disabled':''}>+ Add</button>
        </div>
      </div>
    </div>
    ${p.subtitleTracks.length===0
      ? `<div class="empty-state"><div class="empty-state-icon">💬</div><div class="empty-state-text">No subtitle tracks added yet</div></div>`
      : `<div class="track-list">${p.subtitleTracks.map((t,i)=>`
          <div class="track-card">
            <span class="track-num">${i+1}</span>
            <div class="track-icon-wrap">💬</div>
            <div class="track-body">
              <div class="track-name">${esc(t.description) || t.language}</div>
              <div class="track-detail">${t.language} · ${esc(t.file.name)}</div>
            </div>
            <div class="track-actions">
              <span class="badge badge-blue">${t.language}</span>
              <span class="badge badge-purple">${t.format}</span>
              ${t.isForced?'<span class="badge badge-orange">FORCED</span>':''}
              ${t.isSDH?'<span class="badge badge-green">SDH</span>':''}
              <button class="btn btn-danger" data-rm-sub="${t.id}">✕</button>
            </div>
          </div>`).join('')}</div>`}`;
}

// ── Page: Chapters ─────────────────────────────────────────────────────────────
function pageChapters(p, f) {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Chapters</div>
        <div class="page-subtitle">Define navigation markers — embedded as FFMETADATA in the stream</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-ghost btn-sm" id="import-chapters-btn">📥 Import from Video</button>
        ${p.chapters.length > 0 ? '<button class="btn btn-ghost btn-sm" id="clear-chapters-btn" style="color:#e05050">🗑 Clear All</button>' : ''}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">➕</div><div><div class="card-title">Add Chapter</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Chapter Name</label>
            <input type="text" id="ch-name" value="${esc(f.name)}" placeholder="Opening Scene" /></div>
          <div class="field"><label class="field-label">Timecode HH:MM:SS</label>
            <input type="text" id="ch-time" value="${esc(f.time)}" placeholder="00:00:00" style="font-family:var(--font-mono)" /></div>
        </div>
        <div class="drop-zone compact ${f.thumb?'has-file':''}" id="pick-ch-thumb" style="margin-bottom:14px">
          <div class="dz-icon" style="width:32px;height:32px;font-size:16px">🖼</div>
          <div class="dz-text"><div class="dz-label ${f.thumb?'active':''}">${f.thumb?esc(f.thumb.name):'Chapter thumbnail (optional)'}</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="add-chapter" ${!f.name||!f.time?'disabled':''}>+ Add Chapter</button>
      </div>
    </div>
    ${p.chapters.length===0
      ? `<div class="empty-state"><div class="empty-state-icon">≡</div><div class="empty-state-text">No chapters defined yet</div></div>`
      : `<div class="track-list">${p.chapters.map((c,i)=>`
          <div class="track-card">
            <span class="track-num">${i+1}</span>
            <div class="track-icon-wrap">≡</div>
            <div class="track-body"><div class="track-name">${esc(c.name)}</div></div>
            <div class="track-actions">
              <code style="font-family:var(--font-mono);font-size:12px;color:var(--gold);background:rgba(219,184,90,0.1);padding:3px 8px;border-radius:5px;border:1px solid rgba(219,184,90,0.2)">${c.time}</code>
              ${c.thumb?'<span class="badge badge-green">🖼 Thumb</span>':''}
              <button class="btn btn-danger" data-rm-chapter="${c.id}">✕</button>
            </div>
          </div>`).join('')}</div>`}`;
}

// ── Page: Menu ─────────────────────────────────────────────────────────────────
function pageMenu(p) {
  const m = p.menuConfig;
  const themeBg = { 'Cinematic Dark':'#080810','Elegant White':'#f5f3ee','Retro Film':'#1a0e04','Minimal Type':'#f0eeea','Sci-Fi Grid':'#030a18','Organic Nature':'#0e1a0a' };
  const themeFg = { 'Cinematic Dark':'#dbb85a','Elegant White':'#1a1a2a','Retro Film':'#f5d080','Minimal Type':'#222','Sci-Fi Grid':'#00e5ff','Organic Nature':'#7fc47a' };
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Menu Design</div>
        <div class="page-subtitle">Customize the disc navigation menu — rendered via FFmpeg drawtext</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">🎨</div><div><div class="card-title">Theme</div></div></div>
      <div class="card-body">
        <div class="theme-grid">
          ${MENU_THEMES.map(t=>{
            const bg=themeBg[t]||'#111', fg=themeFg[t]||'#fff';
            return `<button class="theme-card ${m.theme===t?'active':''}" data-theme="${t}" style="background:${bg}">
              <div class="theme-card-name" style="color:${fg}">${t}</div>
              <div class="theme-card-bars">
                ${[fg,fg+'99',fg+'55'].map(c=>`<div class="theme-card-bar" style="background:${c}"></div>`).join('')}
              </div>
            </button>`;
          }).join('')}
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">⚙️</div><div><div class="card-title">Text & Typography</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Menu Title</label>
            <input type="text" id="menu-title" value="${esc(m.title)}" placeholder="Title shown on main menu" /></div>
          <div class="field"><label class="field-label">Subtitle / Tagline</label>
            <input type="text" id="menu-subtitle" value="${esc(m.subtitle||'')}" placeholder="Optional subtitle text" /></div>
        </div>
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Font</label>
            <select id="menu-font">
              <optgroup label="Generic">
                ${['serif','sans-serif','monospace','cursive','fantasy'].map(f=>`<option ${m.fontStyle===f?'selected':''}>${f}</option>`).join('')}
              </optgroup>
              ${state.systemFonts.length > 0 ? `
              <optgroup label="Installed Fonts (${state.systemFonts.length})">
                ${state.systemFonts.map(f=>`<option ${m.fontStyle===f?'selected':''}>${f}</option>`).join('')}
              </optgroup>` : `
              <optgroup label="Common Fonts">
                ${['Helvetica Neue','Helvetica Compressed','Arial','Arial Narrow','Georgia','Times New Roman','Futura','Gill Sans','Optima','Palatino','Baskerville','Didot','Bodoni 72','American Typewriter','Courier New','Monaco','Menlo','Impact','Trebuchet MS'].map(f=>`<option ${m.fontStyle===f?'selected':''}>${f}</option>`).join('')}
              </optgroup>`}
            </select></div>
          <div class="field"><label class="field-label">Title Size</label>
            <select id="menu-title-size">
              ${['small','medium','large','xlarge'].map(s=>`<option ${(m.titleSize||'large')===s?'selected':''}>${s}</option>`).join('')}
            </select></div>
        </div>
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Title Alignment</label>
            <select id="menu-title-align">
              ${['left','center','right'].map(s=>`<option ${(m.titleAlign||'center')===s?'selected':''}>${s}</option>`).join('')}
            </select></div>
          <div class="field" style="display:flex;flex-direction:column;gap:10px;padding-top:22px">
            <label class="check-label"><input type="checkbox" id="menu-show-title" ${m.showTitle!==false?'checked':''} /> Show disc title</label>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">🎨</div><div><div class="card-title">Colours & Buttons</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          ${colorPickerHTML('menu-primary', m.primaryColor, 'Primary Colour')}
          ${colorPickerHTML('menu-accent', m.accentColor, 'Accent Colour')}
        </div>
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Button Style</label>
            <select id="menu-btn-style">
              ${['outline','filled','minimal','pill','underline'].map(s=>`<option ${(m.buttonStyle||'outline')===s?'selected':''}>${s}</option>`).join('')}
            </select></div>
          <div class="field"><label class="field-label">Button Layout</label>
            <select id="menu-btn-layout">
              ${['horizontal','vertical','grid'].map(s=>`<option ${(m.buttonLayout||'horizontal')===s?'selected':''}>${s}</option>`).join('')}
            </select></div>
        </div>
        <div style="margin-bottom:14px">
          <label class="field-label" style="margin-bottom:8px;display:block">Overlay Opacity: ${m.overlayOpacity||50}%</label>
          <input type="range" id="menu-overlay-opacity" min="0" max="90" value="${m.overlayOpacity||50}" style="width:100%;accent-color:var(--gold)" />
        </div>
        <div style="margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
            <label class="check-label"><input type="checkbox" id="menu-text-stroke" ${m.textStroke?'checked':''} /> Text Outline/Stroke</label>
          </div>
          ${m.textStroke ? `<div class="grid-2">
            ${colorPickerHTML('menu-stroke-color', m.textStrokeColor||'#000000', 'Stroke Colour')}
            <div class="field"><label class="field-label">Stroke Width: ${m.textStrokeWidth||2}px</label>
              <input type="range" id="menu-stroke-width" min="1" max="10" value="${m.textStrokeWidth||2}" style="width:100%;accent-color:var(--gold)" />
            </div>
          </div>` : ''}
        </div>
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Play Button Text</label>
            <input type="text" id="menu-play-text" value="${esc(m.customPlayText||'PLAY')}" placeholder="PLAY" /></div>
          <div class="field"><label class="field-label">Chapters Button Text</label>
            <input type="text" id="menu-chapters-text" value="${esc(m.customChaptersText||'CHAPTERS')}" placeholder="CHAPTERS" /></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label class="check-label"><input type="checkbox" id="menu-chapters" ${m.showChapterMenu?'checked':''} /> Show chapters button</label>
          <label class="check-label"><input type="checkbox" id="menu-language" ${m.showLanguageMenu?'checked':''} /> Show language/audio button</label>
          <label class="check-label"><input type="checkbox" id="menu-show-emojis" ${m.showButtonEmojis!==false?'checked':''} /> Show emojis on buttons</label>
          <label class="check-label"><input type="checkbox" id="menu-episode-menu" ${m.showEpisodeMenu!==false?'checked':''} /> Show episode selection menu</label>
          <label class="check-label"><input type="checkbox" id="menu-audio-menu" ${m.showAudioMenu!==false?'checked':''} /> Show audio track selection</label>
          <label class="check-label"><input type="checkbox" id="menu-subtitle-menu" ${m.showSubtitleMenu!==false?'checked':''} /> Show subtitle track selection</label>
        </div>
        ${(state.project.titles||[]).length > 0 ? `
        <div class="field" style="margin-top:12px"><label class="field-label">Episode Menu Style</label>
          <select id="menu-episode-style">
            <option ${(m.episodeMenuStyle||'list')==='list'?'selected':''}>list</option>
            <option ${m.episodeMenuStyle==='grid'?'selected':''}>grid</option>
          </select>
        </div>` : ''}
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">🖼</div><div><div class="card-title">Background & Logo</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Background Image</label>
            <div class="drop-zone compact ${m.backgroundImage?'has-file':''}" id="pick-menu-bg-img">
              <div class="dz-icon" style="width:28px;height:28px;font-size:14px">🌅</div>
              <div class="dz-label ${m.backgroundImage?'active':''}" style="font-size:12px">${m.backgroundImage?esc(m.backgroundImage.name):'Select image'}</div>
            </div></div>
          <div class="field"><label class="field-label">Background Video</label>
            <div class="drop-zone compact ${m.backgroundVideo?'has-file':''}" id="pick-menu-bg-vid">
              <div class="dz-icon" style="width:28px;height:28px;font-size:14px">🎬</div>
              <div class="dz-label ${m.backgroundVideo?'active':''}" style="font-size:12px">${m.backgroundVideo?esc(m.backgroundVideo.name):'Select video loop'}</div>
            </div></div>
        </div>
        <div class="field">
          <label class="field-label">Logo / Watermark Image</label>
          <div class="drop-zone compact ${m.logoImage?'has-file':''}" id="pick-menu-logo">
            <div class="dz-icon" style="width:28px;height:28px;font-size:14px">🏷</div>
            <div class="dz-label ${m.logoImage?'active':''}" style="font-size:12px">${m.logoImage?esc(m.logoImage.name):'Select logo image (PNG with transparency)'}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-icon">👁</div><div><div class="card-title">Live Preview</div><div class="card-subtitle">Approximate representation of the generated menu</div></div></div>
      <div class="card-body">${menuPreviewHTML()}</div>
    </div>`;
}

// ── Page: Extras ───────────────────────────────────────────────────────────────
function pageExtras(p, f) {
  return `
    <div class="page-header">
      <div class="page-header-left">
        <div class="page-title">Special Features</div>
        <div class="page-subtitle">Bonus content — each extra becomes a separate stream on disc</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-icon">➕</div><div><div class="card-title">Add Feature</div></div></div>
      <div class="card-body">
        <div class="grid-2" style="margin-bottom:14px">
          <div class="field"><label class="field-label">Feature Name</label>
            <input type="text" id="ex-name" value="${esc(f.name)}" placeholder="Making Of Documentary" /></div>
          <div class="field"><label class="field-label">Type</label>
            <select id="ex-type">${EXTRAS_TYPES.map(t=>`<option ${f.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
        </div>
        <div class="drop-zone compact ${f.file?'has-file':''}" id="pick-extra-file" style="margin-bottom:14px">
          <div class="dz-icon" style="width:32px;height:32px;font-size:16px">🎞</div>
          <div class="dz-text"><div class="dz-label ${f.file?'active':''}">${f.file?esc(f.file.name):'Click to select video file'}</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="add-extra" ${!f.name||!f.file?'disabled':''}>+ Add Feature</button>
      </div>
    </div>
    ${p.extras.length===0
      ? `<div class="empty-state"><div class="empty-state-icon">🎞</div><div class="empty-state-text">No special features added yet</div></div>`
      : `<div class="track-list">${p.extras.map((e,i)=>`
          <div class="track-card">
            <span class="track-num">${i+1}</span>
            <div class="track-icon-wrap">🎞</div>
            <div class="track-body"><div class="track-name">${esc(e.name)}</div><div class="track-detail">${esc(e.file.name)}</div></div>
            <div class="track-actions">
              <span class="badge badge-purple">${e.type}</span>
              <button class="btn btn-danger" data-rm-extra="${e.id}">✕</button>
            </div>
          </div>`).join('')}</div>`}`;
}

// ── Build Modal ────────────────────────────────────────────────────────────────
function buildModalHTML() {
  const { buildSteps:steps, buildCurrentStep:cur, buildDone, buildError, builtIsoPath, project:p } = state;
  const pct = steps.length ? Math.round((cur/steps.length)*100) : 0;

  // ETA calculation
  const now = Date.now();
  if (!state.buildStartTime && !buildDone && !buildError) state.buildStartTime = now;
  const elapsed = state.buildStartTime ? Math.floor((now - state.buildStartTime)/1000) : 0;
  const elapsedStr = elapsed > 0 ? Math.floor(elapsed/60) + 'm ' + (elapsed%60) + 's' : '';
  let etaStr = '';
  if (pct > 5 && pct < 100 && elapsed > 5) {
    const totalEst = Math.round(elapsed / (pct/100));
    const remaining = Math.max(0, totalEst - elapsed);
    etaStr = remaining > 0 ? '~' + Math.floor(remaining/60) + 'm ' + (remaining%60) + 's remaining' : 'Almost done...';
  }

  if (buildError) {
    // Map raw errors to friendly messages
    var friendlyError = buildError;
    var hint = '';
    if (buildError.includes('ffmpeg') && buildError.includes('not found')) {
      friendlyError = 'FFmpeg is not installed or could not be found.';
      hint = 'Install FFmpeg via Homebrew: brew install ffmpeg';
    } else if (buildError.includes('tsMuxeR') || buildError.includes('tsmuxer')) {
      friendlyError = 'tsMuxeR could not be found.';
      hint = 'Download tsMuxeR from github.com/justdan96/tsMuxeR or install via Homebrew.';
    } else if (buildError.includes('No such file') || buildError.includes('ENOENT')) {
      friendlyError = 'A required file could not be found.';
      hint = 'Make sure your video files are still accessible and try again.';
    } else if (buildError.includes('Permission denied')) {
      friendlyError = 'Permission denied writing to the output folder.';
      hint = 'Try changing the output folder to your Desktop or Downloads.';
    } else if (buildError.includes('No space left') || buildError.includes('ENOSPC')) {
      friendlyError = 'Not enough disk space to build the disc image.';
      hint = 'Free up disk space and try again. BD-25 images require ~25GB.';
    } else if (buildError.includes('Invalid data') || buildError.includes('moov atom')) {
      friendlyError = 'The video file appears to be corrupted or incomplete.';
      hint = 'Try re-encoding the file with FFmpeg or use a different source.';
    }
    return '<div class="modal-backdrop"><div class="modal-box">' +
      '<div class="modal-disc-icon" style="background:var(--red-dim);border-color:rgba(192,57,43,0.4)">❌</div>' +
      '<div class="modal-title">Build Failed</div>' +
      '<div style="font-size:13px;color:#e08080;margin-bottom:10px;font-weight:500">' + esc(friendlyError) + '</div>' +
      (hint ? '<div style="font-size:12px;color:var(--text-secondary);background:rgba(255,255,255,0.05);border-radius:6px;padding:8px 12px;margin-bottom:10px">' + esc(hint) + '</div>' : '') +
      '<details style="margin-bottom:12px"><summary style="font-size:11px;color:var(--text-tertiary);cursor:pointer">Show technical details</summary>' +
      '<pre style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:6px;padding:10px;font-size:10px;color:#e08080;text-align:left;max-height:140px;overflow-y:auto;font-family:var(--font-mono);white-space:pre-wrap;margin-top:6px">' + esc(buildError) + '</pre></details>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="close-modal">Close</button></div>' +
      '</div></div>';
  }

  if (buildDone) return '<div class="modal-backdrop"><div class="modal-box">' +
    '<div class="modal-success-ring">✅</div>' +
    '<div class="modal-title" style="color:var(--gold-bright)">Build Complete!</div>' +
    '<div class="modal-sub">' + p.audioTracks.length + ' audio · ' + p.subtitleTracks.length + ' subtitles · ' + p.chapters.length + ' chapters · ' + p.extras.length + ' extras</div>' +
    (elapsedStr ? '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:8px">Completed in ' + elapsedStr + '</div>' : '') +
    '<div class="iso-path">' + esc(builtIsoPath||'') + '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-ghost" id="close-modal">Close</button>' +
    '<button class="btn btn-primary" id="reveal-iso">Show in Finder</button>' +
    '</div></div></div>';

  const stepsHTML = steps.map(function(s,i) {
    const cls = i<cur?'done':i===cur?'active':'wait';
    return '<div class="build-step"><div class="step-indicator ' + cls + '">' + (i<cur?'✓':i+1) + '</div><span class="step-text ' + cls + '">' + s + '</span></div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box">' +
    '<div class="modal-disc-icon">💿</div>' +
    '<div class="modal-title">Building Disc Image</div>' +
    '<div class="modal-sub"><strong style="color:var(--text-primary)">' + esc(p.title||'Untitled') + '</strong></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary);margin-bottom:6px">' +
    '<span>' + pct + '% complete' + (elapsedStr ? ' · ' + elapsedStr + ' elapsed' : '') + '</span>' +
    '<span>' + etaStr + '</span></div>' +
    '<div class="progress-bar-wrap" style="margin-bottom:16px"><div class="progress-bar-fill" style="width:' + pct + '%;transition:width 0.5s ease"></div></div>' +
    '<div class="build-steps">' + stepsHTML + '</div>' +
    '<div class="ffmpeg-log" id="ffmpeg-log">' + esc(state.ffmpegLog||'Starting...') + '</div>' +
    '</div></div>';
}

function burnModalHTML() {
  const { burnStatus, burnMessage, burnDone, burnError } = state;

  if (burnError) return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-disc-icon" style="background:var(--red-dim);border-color:rgba(192,57,43,0.4)">❌</div>
    <div class="modal-title">Burn Failed</div>
    <pre style="background:var(--bg-sunken);border:1px solid var(--border-dim);border-radius:var(--radius-md);padding:12px;font-size:11px;color:#e08080;text-align:left;max-height:160px;overflow-y:auto;font-family:var(--font-mono);white-space:pre-wrap;margin-bottom:16px">${esc(burnError)}</pre>
    <div class="modal-actions"><button class="btn btn-ghost" id="close-burn-modal">Close</button></div>
  </div></div>`;

  if (burnDone) return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-success-ring">💿</div>
    <div class="modal-title" style="color:var(--gold-bright)">Burn Complete!</div>
    <div class="modal-sub">Your disc has been burned and ejected.</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="close-burn-modal">Done</button></div>
  </div></div>`;

  return `<div class="modal-backdrop"><div class="modal-box">
    <div class="modal-disc-icon" style="animation:spin 2s linear infinite;display:inline-flex">💿</div>
    <div class="modal-title">Burning Disc</div>
    <div class="modal-sub">Do not eject the disc or close the app.</div>
    <div class="progress-bar-wrap" style="margin:16px 0">
      <div class="progress-bar-fill" style="width:${burnStatus==='done'?100:burnStatus==='burning'?60:20}%;transition:width 1s"></div>
    </div>
    <div class="ffmpeg-log" style="text-align:left">${esc(burnMessage||'Preparing...')}</div>
  </div></div>`;
}

// ── Welcome / Onboarding Modal ────────────────────────────────────────────────
function welcomeModalHTML() {
  const steps = [
    { icon:'🎬', title:'Add your videos', desc:'Go to the Project tab and click "Add Videos" to add one or more MKV, MP4, or M2TS files. Each file becomes a title on the disc.' },
    { icon:'🔊', title:'Choose your tracks', desc:'The app auto-detects all embedded audio and subtitle tracks. Check or uncheck exactly what you want included.' },
    { icon:'🎨', title:'Design your menu', desc:'Head to the Menu tab to set a background image, colours, fonts, and button style. The live preview updates instantly.' },
    { icon:'🔨', title:'Build & burn', desc:'Click "Build Disc Image" to create your ISO. Once done, insert a blank BD-R and click "Burn to Disc".' },
  ];

  const stepsHTML = steps.map(function(s) {
    return '<div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px">' +
      '<div style="width:36px;height:36px;border-radius:10px;background:rgba(219,184,90,0.15);border:1px solid rgba(219,184,90,0.4);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">' + s.icon + '</div>' +
      '<div>' +
      '<div style="font-size:13px;font-weight:700;color:#f0e8d0;margin-bottom:3px">' + s.title + '</div>' +
      '<div style="font-size:12px;color:#b0aec0;line-height:1.6">' + s.desc + '</div>' +
      '</div></div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box" style="max-width:480px">' +
    '<div style="text-align:center;margin-bottom:20px">' +
    '<div style="font-size:48px;margin-bottom:8px">💿</div>' +
    '<div style="font-size:22px;font-weight:700;color:#f0e8d0;margin-bottom:6px">Welcome to Disc Forge</div>' +
    '<div style="font-size:13px;color:#9090a8">Professional Blu-ray authoring for macOS</div>' +
    '</div>' +
    stepsHTML +
    '<div style="background:rgba(219,184,90,0.1);border:1px solid rgba(219,184,90,0.3);border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
    '<div style="font-size:12px;color:#dbb85a;font-weight:700;margin-bottom:4px">💡 Quick tip</div>' +
    '<div style="font-size:12px;color:#c0b890;line-height:1.5">Use the Menu tab interactive preview to click around your disc menu before burning. Navigate between the main menu, episodes, audio and subtitle screens.</div>' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-primary" id="close-welcome" style="width:100%;font-size:15px;padding:12px">Get Started →</button>' +
    '</div>' +
    '</div></div>';
}

// ── About Modal ───────────────────────────────────────────────────────────────
function aboutModalHTML() {
  const versions = [
    { v:'1.2', notes:['Burn to BD-R disc directly', 'Interactive menu preview simulator', 'Episode / audio / subtitle menu screens', 'Persistent colour picker with presets', 'Chapter auto-import from video files', 'Custom button text & emoji toggle', 'Text stroke/outline on menu title', 'Logo/watermark image support', 'Project save & load (.dfp files)', 'Build progress with ETA & elapsed time', 'About screen & version history'] },
    { v:'1.1', notes:['Light mode default with dark toggle', 'Multiple video titles per disc', 'Disc capacity meter (DVD-5/BD-25/BD-50/BD-100)', 'Subtitle descriptions per track', 'System font picker', 'Scroll position preserved on re-render', 'Multi-file video selection'] },
    { v:'1.0', notes:['Initial release', 'FFmpeg mux → tsMuxeR BDMV → hdiutil ISO', 'MKV import with ffprobe track detection', '7-tab interface', 'Dark studio theme'] },
  ];
  const vHTML = versions.map(function(ver) {
    return '<div style="margin-bottom:14px;text-align:left">' +
      '<div style="font-size:12px;font-weight:700;color:var(--gold);margin-bottom:4px">v' + ver.v + '</div>' +
      ver.notes.map(function(n) {
        return '<div style="font-size:11px;color:var(--text-secondary);padding:1px 0;padding-left:10px">· ' + n + '</div>';
      }).join('') +
    '</div>';
  }).join('');

  return '<div class="modal-backdrop"><div class="modal-box" style="max-width:440px">' +
    '<div style="text-align:center;margin-bottom:16px">' +
    '<div style="font-size:40px;margin-bottom:6px">💿</div>' +
    '<div class="modal-title" style="font-size:20px">Disc Forge</div>' +
    '<div style="font-size:12px;color:var(--gold);font-weight:600;margin-bottom:4px">Version 1.2.0</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary)">Professional Blu-ray authoring for macOS</div>' +
    '</div>' +
    '<div style="max-height:320px;overflow-y:auto;border-top:1px solid var(--border-dim);border-bottom:1px solid var(--border-dim);padding:12px 0;margin-bottom:14px">' +
    '<div style="font-size:10px;letter-spacing:.1em;color:var(--text-tertiary);margin-bottom:10px;text-align:center">VERSION HISTORY</div>' +
    vHTML +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:6px">Powered by FFmpeg · tsMuxeR · hdiutil</div>' +
    '<div style="font-size:11px;color:var(--text-tertiary);text-align:center;margin-bottom:14px">Copyright © 2026 ETHM</div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" id="close-about">Close</button></div>' +
    '</div></div>';
}

// ── Project Save/Load ──────────────────────────────────────────────────────────
async function saveProject() {
  const proj = {
    version: '1.2',
    title: state.project.title,
    description: state.project.description,
    discLabel: state.project.discLabel,
    resolution: state.project.resolution,
    videoFormat: state.project.videoFormat,
    outputDir: state.project.outputDir,
    discSize: state.project.discSize,
    mainVideo: state.project.mainVideo,
    titles: state.project.titles || [],
    audioTracks: state.project.audioTracks,
    subtitleTracks: state.project.subtitleTracks,
    chapters: state.project.chapters,
    extras: state.project.extras,
    menuConfig: state.project.menuConfig,
    embeddedTracks: state.embeddedTracks || [],
  };
  const json = JSON.stringify(proj, null, 2);
  const savePath = await window.discForge.saveProjectFile(json);
  if (savePath) {
    alert('Project saved to: ' + savePath);
  }
}

async function loadProject() {
  const json = await window.discForge.loadProjectFile();
  if (!json) return;
  try {
    const proj = JSON.parse(json);
    state.embeddedTracks = proj.embeddedTracks || [];
    // Match resolution to known values (exact string match required for <select>)
    const loadedRes = RESOLUTIONS.find(r => r === proj.resolution) || RESOLUTIONS[0];
    const loadedFmt = VIDEO_FMTS.find(f => f === proj.videoFormat) || VIDEO_FMTS[0];
    setPrj({
      title: proj.title || '',
      description: proj.description || '',
      discLabel: proj.discLabel || '',
      resolution: loadedRes,
      videoFormat: loadedFmt,
      outputDir: proj.outputDir || '',
      discSize: proj.discSize || 'BD-25',
      mainVideo: proj.mainVideo || null,
      titles: proj.titles || [],
      audioTracks: proj.audioTracks || [],
      subtitleTracks: proj.subtitleTracks || [],
      chapters: proj.chapters || [],
      extras: proj.extras || [],
      menuConfig: { ...state.project.menuConfig, ...(proj.menuConfig || {}) },
    });
  } catch(e) {
    alert('Failed to load project: ' + e.message);
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────────
function attachListeners() {
  // Restore focus to previously focused input after re-render
  if (_focusedId) {
    // Check for title-label-input by data-title-id
    let el = document.getElementById(_focusedId);
    if (!el) {
      el = document.querySelector('[data-title-id="' + _focusedId + '"]');
    }
    if (el) {
      el.focus();
      if (_focusedPos !== null && el.setSelectionRange) {
        try { el.setSelectionRange(_focusedPos, _focusedPos); } catch(_) {}
      }
    }
    _focusedId  = null;
    _focusedPos = null;
  }
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(el => el.addEventListener('click', () => setState({ tab:parseInt(el.dataset.tab) })));

  // Sidebar
  document.getElementById('build-btn')?.addEventListener('click', startBuild);
  document.getElementById('pick-output')?.addEventListener('click', pickOutputDir);

  // Project
  document.getElementById('proj-title')?.addEventListener('input',  e => setPrjText({ title: e.target.value }));
  document.getElementById('proj-label')?.addEventListener('input',  e => setPrjText({ discLabel: e.target.value }));
  document.getElementById('proj-desc')?.addEventListener('input',   e => setPrjText({ description: e.target.value }));
  document.getElementById('proj-res')?.addEventListener('change',   e => setPrj({ resolution: e.target.value }));
  document.getElementById('proj-vcodec')?.addEventListener('change',e => setPrj({ videoFormat: e.target.value }));
  document.getElementById('pick-main-video')?.addEventListener('click', pickMainVideo);

  // MKV
  document.getElementById('pick-mkv-file')?.addEventListener('click', pickMkvFile);
  // Light mode toggle
  document.getElementById('toggle-theme')?.addEventListener('click', () => {
    state.lightMode = !state.lightMode;
    document.body.classList.toggle('light-mode', state.lightMode);
    render();
  });

  // Subtitle description
  document.getElementById('s-desc')?.addEventListener('input', e => {
    _focusedId = 's-desc'; _focusedPos = e.target.selectionStart;
    Object.assign(state, { form: { ...state.form, subtitle: { ...state.form.subtitle, description: e.target.value } } });
    render();
  });

  // Add additional titles - multi-file picker
  document.getElementById('add-title-btn')?.addEventListener('click', async () => {
    const files = await window.discForge.openFilesDialog({
      filters:[{ name:'Video', extensions:['mkv','mp4','ts','m2ts','avi','mov','wmv','vob'] }]
    });
    if (!files || !files.length) return;
    let mainVideo = state.project.mainVideo;
    let existingTitles = [...(state.project.titles||[])];
    const toAdd = [...files];
    if (!mainVideo && toAdd.length > 0) {
      mainVideo = toAdd.shift();
    }
    const newTitles = toAdd.map(f => ({ id:uid(), file:f, label:f.name.replace(/\.[^.]+$/, '') }));
    setPrj({ mainVideo, titles: [...existingTitles, ...newTitles] });

    // Auto-probe all added files to detect embedded tracks
    const allFiles = mainVideo && !state.project.mainVideo ? [mainVideo, ...toAdd] : [...files];
    const existingEmbedded = state.embeddedTracks || [];
    for (const f of allFiles) {
      const filePath = f.path || f.name;
      if (!filePath) continue;
      // Skip if already probed
      if (existingEmbedded.some(t => t.sourceFile === filePath)) continue;
      const probe = await window.discForge.probeFile(filePath);
      if (!probe.success || !probe.data) continue;
      const streams = probe.data.streams || [];
      const detected = streams
        .filter(s => s.codec_type === 'audio' || s.codec_type === 'subtitle')
        .map(s => {
          const lang = (s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase();
          const langMap = {eng:'English',fre:'French',fra:'French',spa:'Spanish',deu:'German',ger:'German',
            ita:'Italian',por:'Portuguese',jpn:'Japanese',kor:'Korean',zho:'Mandarin',chi:'Mandarin',
            rus:'Russian',ara:'Arabic',hin:'Hindi',nld:'Dutch',swe:'Swedish',nor:'Norwegian',
            dan:'Danish',fin:'Finnish',pol:'Polish',ces:'Czech',hun:'Hungarian',ron:'Romanian',
            tur:'Turkish',ell:'Greek',heb:'Hebrew',tha:'Thai',vie:'Vietnamese',ind:'Indonesian',
            msa:'Malay'};
          const language = langMap[lang] || 'English';
          const codec = s.codec_name || '';
          const fmtMap = {'dts':'DTS-HD Master Audio','truehd':'Dolby TrueHD','ac3':'Dolby Digital 5.1',
            'eac3':'Dolby Digital 5.1','aac':'Dolby Digital 5.1','flac':'PCM 5.1','pcm_s24le':'PCM 5.1',
            'pcm_s16le':'LPCM Stereo','subrip':'SRT','srt':'SRT','ass':'ASS','pgs':'PGS (Blu-ray Native)',
            'hdmv_pgs_subtitle':'PGS (Blu-ray Native)','vtt':'VTT','dvd_subtitle':'SRT'};
          const format = fmtMap[codec] || (s.codec_type === 'audio' ? 'DTS-HD Master Audio' : 'SRT');
          const title = s.tags?.title || s.tags?.TITLE || '';
          const isDefault = s.disposition?.default === 1;
          const isForced = s.disposition?.forced === 1;
          const isSDH = title.toLowerCase().includes('sdh') || title.toLowerCase().includes('cc');
          return {
            id: uid(),
            sourceFile: filePath,
            sourceFileName: f.name,
            streamIndex: s.index,
            codec: codec,
            role: s.codec_type,
            language,
            format,
            label: title || language,
            description: title || '',
            isDefault,
            isForced,
            isSDH,
            included: true,  // checked by default
            trackIndex: s.index,
          };
        });
      state.embeddedTracks = [...(state.embeddedTracks||[]), ...detected];

      // Auto-import chapters if none exist yet
      const chapters = probe.data.chapters || [];
      if (chapters.length > 0 && state.project.chapters.length === 0) {
        const newChapters = chapters.map((ch, idx) => {
          const startSec = parseFloat(ch.start_time || 0);
          const h = Math.floor(startSec / 3600);
          const m2 = Math.floor((startSec % 3600) / 60);
          const s = Math.floor(startSec % 60);
          const time = String(h).padStart(2,'0') + ':' + String(m2).padStart(2,'0') + ':' + String(s).padStart(2,'0');
          const name = (ch.tags && (ch.tags.title || ch.tags.TITLE)) || ('Chapter ' + (idx+1));
          return { id: uid(), name, time };
        });
        state.project = { ...state.project, chapters: newChapters };
        sendLog && sendLog('Auto-imported ' + newChapters.length + ' chapters');
      }
    }
  render();
});

  document.querySelectorAll('.title-label-input').forEach(input => {
    // Save on every keystroke directly into state — no render() so focus is never lost
    input.addEventListener('input', e => {
      const id = input.dataset.titleId;
      const val = e.target.value;
      state.project = {
        ...state.project,
        titles: (state.project.titles||[]).map(t =>
          t.id === id ? { ...t, label: val } : t
        )
      };
    });
    // No render on blur — value is already in state
    input.addEventListener('keydown', e => {
      e.stopPropagation();
    });
  });

  // Remove title
  document.querySelectorAll('[data-rm-title]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.rmTitle;
      if (id === '__main__') {
        // Promote first additional title to main, or clear mainVideo
        const titles = [...(state.project.titles||[])];
        if (titles.length > 0) {
          const newMain = titles.shift();
          setPrj({ mainVideo: newMain.file, titles });
        } else {
          setPrj({ mainVideo: null });
        }
      } else {
        setPrj({ titles: (state.project.titles||[]).filter(t => t.id !== id) });
      }
    });
  });

  // Embedded track toggles
  document.querySelectorAll('[data-toggle-embedded]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleEmbedded;
      state.embeddedTracks = state.embeddedTracks.map(t => t.id===id ? {...t, included: el.checked} : t);
      render();
    });
  });

  // Track inclusion toggles on Project tab
  document.querySelectorAll('[data-toggle-audio]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleAudio;
      setPrj({ audioTracks: state.project.audioTracks.map(t => t.id===id ? {...t, excluded: !el.checked} : t) });
    });
  });
  document.querySelectorAll('[data-toggle-sub]').forEach(el => {
    el.addEventListener('change', () => {
      const id = el.dataset.toggleSub;
      setPrj({ subtitleTracks: state.project.subtitleTracks.map(t => t.id===id ? {...t, excluded: !el.checked} : t) });
    });
  });

  document.getElementById('mkv-select-all')?.addEventListener('click', () => selectAllMkvTracks());
  document.getElementById('mkv-deselect-all')?.addEventListener('click', () => deselectAllMkvTracks());
  document.getElementById('mkv-select-audio')?.addEventListener('click', () => selectAllMkvTracks('audio'));
  document.getElementById('mkv-select-subs')?.addEventListener('click', () => selectAllMkvTracks('subtitle'));
  document.getElementById('mkv-deselect-subs')?.addEventListener('click', () => deselectAllMkvTracks('subtitle'));
  document.getElementById('import-mkv-btn')?.addEventListener('click', importMkvTracks);
  document.querySelectorAll('[data-mkv-toggle]').forEach(el => el.addEventListener('change', () => toggleMkvTrack(parseInt(el.dataset.mkvToggle))));
  document.querySelectorAll('[data-mkv-lang]').forEach(el => el.addEventListener('change', () => updateMkvTrack(parseInt(el.dataset.mkvLang), { assignedLang:el.value })));
  document.querySelectorAll('[data-mkv-afmt]').forEach(el => el.addEventListener('change', () => updateMkvTrack(parseInt(el.dataset.mkvAfmt), { bdFormat:el.value })));
  document.querySelectorAll('[data-mkv-forced]').forEach(el => el.addEventListener('change', () => updateMkvTrack(parseInt(el.dataset.mkvForced), { isForced:el.checked })));
  document.querySelectorAll('[data-mkv-sdh]').forEach(el => el.addEventListener('change', () => updateMkvTrack(parseInt(el.dataset.mkvSdh), { isSDH:el.checked })));

  // Audio
  document.getElementById('a-lang')?.addEventListener('change', e => setForm('audio', { lang:e.target.value }));
  document.getElementById('a-fmt')?.addEventListener('change',  e => setForm('audio', { fmt:e.target.value }));
  document.getElementById('a-label')?.addEventListener('input', e => { _focusedId='a-label'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,audio:{...state.form.audio,label:e.target.value}}}); render(); });
  document.getElementById('a-default')?.addEventListener('change',e => setForm('audio', { isDefault:e.target.checked }));
  document.getElementById('pick-audio-file')?.addEventListener('click', pickAudio);
  document.getElementById('add-audio')?.addEventListener('click', addAudio);
  document.querySelectorAll('[data-rm-audio]').forEach(el => el.addEventListener('click', () => rmAudio(el.dataset.rmAudio)));

  // Subtitles
  document.getElementById('s-lang')?.addEventListener('change', e => setForm('subtitle', { lang:e.target.value }));
  document.getElementById('s-fmt')?.addEventListener('change',  e => setForm('subtitle', { fmt:e.target.value }));
  document.getElementById('s-forced')?.addEventListener('change',e => setForm('subtitle', { isForced:e.target.checked }));
  document.getElementById('s-sdh')?.addEventListener('change',  e => setForm('subtitle', { isSDH:e.target.checked }));
  document.getElementById('pick-sub-file')?.addEventListener('click', pickSubtitle);
  document.getElementById('add-sub')?.addEventListener('click', addSubtitle);
  document.querySelectorAll('[data-rm-sub]').forEach(el => el.addEventListener('click', () => rmSubtitle(el.dataset.rmSub)));

  // Chapters
  document.getElementById('ch-name')?.addEventListener('input', e => { _focusedId='ch-name'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,chapter:{...state.form.chapter,name:e.target.value}}}); render(); });
  document.getElementById('ch-time')?.addEventListener('input', e => { _focusedId='ch-time'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,chapter:{...state.form.chapter,time:e.target.value}}}); render(); });
  document.getElementById('pick-ch-thumb')?.addEventListener('click', pickChapterThumb);
  document.getElementById('add-chapter')?.addEventListener('click', addChapter);
  document.querySelectorAll('[data-rm-chapter]').forEach(el => el.addEventListener('click', () => rmChapter(el.dataset.rmChapter)));

  // Menu
  document.querySelectorAll('[data-theme]').forEach(el => el.addEventListener('click', () => setMenu({ theme:el.dataset.theme })));
  document.getElementById('menu-title')?.addEventListener('input', e => { const activeEl=document.activeElement; if(activeEl&&activeEl.id){_focusedId=activeEl.id;_focusedPos=activeEl.selectionStart??null;} Object.assign(state,{project:{...state.project,menuConfig:{...state.project.menuConfig,title:e.target.value}}}); render(); });
  document.getElementById('menu-primary-picker')?.addEventListener('input', e => setMenu({ primaryColor:e.target.value }));
  document.getElementById('menu-primary-text')?.addEventListener('input',   e => setMenu({ primaryColor:e.target.value }));
  document.getElementById('menu-accent-picker')?.addEventListener('input',  e => setMenu({ accentColor:e.target.value }));
  document.getElementById('menu-accent-text')?.addEventListener('input',    e => setMenu({ accentColor:e.target.value }));
  document.getElementById('menu-font')?.addEventListener('change', e => setMenu({ fontStyle:e.target.value }));
  attachColorPickers();

  // Menu preview navigation
  ['main','episodes','audio','subtitles','chapters'].forEach(function(s) {
    document.getElementById('menu-nav-' + s)?.addEventListener('click', function() {
      state.menuPreviewScreen = s;
      render();
    });
  });
  document.getElementById('menu-sim-back')?.addEventListener('click', function() {
    state.menuPreviewScreen = 'main';
    render();
  });

  // Clickable buttons in main menu preview
  document.querySelectorAll('[data-menu-action]').forEach(function(el) {
    el.addEventListener('click', function() {
      var action = el.dataset.menuAction;
      if (action === 'play') { /* play - stays on main */ }
      else if (action === 'episodes' || action === 'audio' || action === 'subtitles' || action === 'chapters') {
        state.menuPreviewScreen = action;
        render();
      }
    });
    // Hover effect
    el.addEventListener('mouseenter', function() { el.style.filter = 'brightness(1.3)'; el.style.transform = 'scale(1.05)'; });
    el.addEventListener('mouseleave', function() { el.style.filter = ''; el.style.transform = ''; });
  });
  document.getElementById('menu-show-title')?.addEventListener('change', e => setMenu({ showTitle:e.target.checked }));
  document.getElementById('menu-subtitle')?.addEventListener('input', e => { _focusedId='menu-subtitle'; _focusedPos=e.target.selectionStart; setMenu({ subtitle:e.target.value }); });
  document.getElementById('menu-title-size')?.addEventListener('change', e => setMenu({ titleSize:e.target.value }));
  document.getElementById('menu-title-align')?.addEventListener('change', e => setMenu({ titleAlign:e.target.value }));
  document.getElementById('menu-btn-style')?.addEventListener('change', e => setMenu({ buttonStyle:e.target.value }));
  document.getElementById('menu-btn-layout')?.addEventListener('change', e => setMenu({ buttonLayout:e.target.value }));
  document.getElementById('menu-overlay-opacity')?.addEventListener('input', e => setMenu({ overlayOpacity:parseInt(e.target.value) }));
  document.getElementById('menu-text-stroke')?.addEventListener('change', e => setMenu({ textStroke:e.target.checked }));

  document.getElementById('menu-stroke-width')?.addEventListener('input', e => setMenu({ textStrokeWidth:parseInt(e.target.value) }));
  document.getElementById('menu-show-emojis')?.addEventListener('change', e => setMenu({ showButtonEmojis:e.target.checked }));
  document.getElementById('menu-episode-menu')?.addEventListener('change', e => setMenu({ showEpisodeMenu:e.target.checked }));
  document.getElementById('menu-audio-menu')?.addEventListener('change', e => setMenu({ showAudioMenu:e.target.checked }));
  document.getElementById('menu-subtitle-menu')?.addEventListener('change', e => setMenu({ showSubtitleMenu:e.target.checked }));
  document.getElementById('menu-episode-style')?.addEventListener('change', e => setMenu({ episodeMenuStyle:e.target.value }));
  document.getElementById('menu-play-text')?.addEventListener('input', e => { _focusedId='menu-play-text'; _focusedPos=e.target.selectionStart; setMenu({ customPlayText:e.target.value }); });
  document.getElementById('menu-chapters-text')?.addEventListener('input', e => { _focusedId='menu-chapters-text'; _focusedPos=e.target.selectionStart; setMenu({ customChaptersText:e.target.value }); });
  document.getElementById('pick-menu-logo')?.addEventListener('click', async () => {
    const r = await window.discForge.openFileDialog({ filters:[{ name:'Image', extensions:['png','jpg','jpeg','webp'] }] });
    if (r) setMenu({ logoImage: typeof r === 'string' ? { path:r, name:r.split('/').pop() } : r });
  });
  document.getElementById('menu-chapters')?.addEventListener('change', e => setMenu({ showChapterMenu:e.target.checked }));
  document.getElementById('menu-language')?.addEventListener('change', e => setMenu({ showLanguageMenu:e.target.checked }));
  document.getElementById('pick-menu-bg-img')?.addEventListener('click', () => pickMenuBg(false));
  document.getElementById('pick-menu-bg-vid')?.addEventListener('click', () => pickMenuBg(true));

  // Extras
  document.getElementById('ex-name')?.addEventListener('input',  e => { _focusedId='ex-name'; _focusedPos=e.target.selectionStart; Object.assign(state,{form:{...state.form,extras:{...state.form.extras,name:e.target.value}}}); render(); });
  document.getElementById('ex-type')?.addEventListener('change', e => setForm('extras', { type:e.target.value }));
  document.getElementById('pick-extra-file')?.addEventListener('click', pickExtrasFile);
  document.getElementById('add-extra')?.addEventListener('click', addExtra);
  document.querySelectorAll('[data-rm-extra]').forEach(el => el.addEventListener('click', () => rmExtra(el.dataset.rmExtra)));

  // Modal
  // Import chapters from video file
  document.getElementById('import-chapters-btn')?.addEventListener('click', async () => {
    const p = state.project;
    const videoPath = p.mainVideo?.path || (p.titles&&p.titles[0]?.file?.path);
    if (!videoPath) { alert('Please add a video file first.'); return; }
    const probe = await window.discForge.probeFile(videoPath);
    if (!probe.success || !probe.data) { alert('Could not probe video file.'); return; }
    const chapters = probe.data.chapters || [];
    if (chapters.length === 0) { alert('No chapter markers found in this video file.'); return; }
    const newChapters = chapters.map((ch, idx) => {
      const startSec = parseFloat(ch.start_time || 0);
      const h = Math.floor(startSec / 3600);
      const m2 = Math.floor((startSec % 3600) / 60);
      const s = Math.floor(startSec % 60);
      const time = String(h).padStart(2,'0') + ':' + String(m2).padStart(2,'0') + ':' + String(s).padStart(2,'0');
      const name = (ch.tags && (ch.tags.title || ch.tags.TITLE)) || ('Chapter ' + (idx+1));
      return { id: uid(), name, time };
    });
    setPrj({ chapters: newChapters });
    alert('Imported ' + newChapters.length + ' chapters!');
  });
  document.getElementById('clear-chapters-btn')?.addEventListener('click', () => {
    if (confirm('Clear all chapters?')) setPrj({ chapters: [] });
  });

  // Interactive menu preview navigation
  document.querySelectorAll('[data-menu-nav]').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      var screen = el.dataset.menuNav;
      if (screen) setState({ menuPreviewScreen: screen });
    });
  });

  document.getElementById('close-modal')?.addEventListener('click', closeBuildModal);
  document.getElementById('about-btn')?.addEventListener('click', () => setState({ showAbout: true }));

  // Menu preview navigation
  document.querySelectorAll('[data-menu-nav]').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      var screen = el.dataset.menuNav;
      if (screen) setState({ menuPreviewScreen: screen });
    });
  });
  document.getElementById('close-about')?.addEventListener('click', () => setState({ showAbout: false }));
  document.getElementById('close-welcome')?.addEventListener('click', () => setState({ showWelcome: false }));
  document.getElementById('save-project-btn')?.addEventListener('click', saveProject);
  document.getElementById('load-project-btn')?.addEventListener('click', loadProject);

  // Burn to disc
  document.getElementById('burn-btn')?.addEventListener('click', async () => {
    if (!state.builtIsoPath) return;
    window.discForge.removeAllListeners('burn-progress');
    setState({ burning: true, burnStatus: 'checking', burnMessage: 'Checking for disc...', burnDone: false, burnError: null });
    window.discForge.onBurnProgress(data => {
      if (data.status === 'done') setState({ burnDone: true, burnStatus: 'done', burnMessage: data.message });
      else if (data.status === 'error') setState({ burning: true, burnError: data.message });
      else setState({ burnStatus: data.status, burnMessage: data.message });
    });
    const result = await window.discForge.burnISO(state.builtIsoPath);
    if (result.error) setState({ burning: true, burnError: result.error });
  });
  document.getElementById('close-burn-modal')?.addEventListener('click', () => {
    window.discForge.removeAllListeners('burn-progress');
    setState({ burning: false, burnDone: false, burnError: null, burnStatus: null, burnMessage: '' });
  });
  document.getElementById('reveal-iso')?.addEventListener('click', revealISO);


}

// ── Start ──────────────────────────────────────────────────────────────────────
render();
boot();
