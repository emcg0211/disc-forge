# Changelog

## v1.10.0 — 2026-05-19

**Interactive BD-ROM episode menu (Tier 2 IG)**

- BD-ROM Interactive Graphics (IG) episode menu at disc boot — each episode gets a labeled button rendered via ffmpeg drawtext
- Supports 2–9 episodes; buttons auto-center vertically and horizontally on the 1920×1080 frame
- Custom button labels configurable per-episode in the UI; falls back to "Play Episode N" if blank
- Palette-indexed BD bitmap encoding with white border, orange selected state, dark blue normal state
- Inter Regular font (SIL Open Font License) bundled at `src/assets/fonts/MenuFont.ttf`
- Single WDS window covers all buttons (BD spec compliant: max 2 windows per page)
- Circular up/down navigation between buttons; activation triggers PLAY_PL to the episode's playlist
- UI: Title input, background color picker, background image picker, per-button color pickers (bg/text/selected), per-episode label inputs (auto-grow as titles are added)
- Graceful fallback to plain-color buttons if ffmpeg or font is unavailable

**Bug fixes from Tier 2 development**
- Fixed IG PES PID from 0x1200 (PG/subtitle range) to 0x1400 (IG range) — libbluray routes by PID
- Fixed PES data_alignment_indicator bit for IG stream
- Fixed one-PES-per-segment discipline in IG display set builder
- Fixed palette entry 3 transparency (was T=160 ≈ 63% transparent; changed to T=0 opaque dark blue)

---

## v1.8.0 — 2026-05-18

**Splash screen support (hardware-verified)**

- Custom splash screen: solid color or custom PNG, configurable duration (3/5/8/10 seconds)
- Splash screen wired end-to-end: CLPI timestamp patch + MPLS out_time patch ensure splash plays for full selected duration
- Fixed tsMuxeR 2.6.16-dev fps bug: use integer `fps=24` to avoid timestamp compression artifact that caused splash to play for ~5 ms instead of 5 s
- Both CLPI and MPLS patched together (patching only one was insufficient)
- UI: theme color picker, duration selector, custom PNG file picker
- IG encoder foundation: 59 passing unit tests for BD-ROM Interactive Graphics stream encoding (not yet wired into builds)

**Bug fixes**
- Removed dead code and standardized internal logging (Phase 4 cleanup)
- Fixed `readClpiEndTime` byte offsets
- Fixed `patchMplsForTrickPlay`: random_access_flag is bit 7 (MSB), not bit 0
- Fixed frame_rate mask and JUMP_TITLE opcode in ig-encoder

---

## v1.7.1 — 2026-05-17

**Trick-play, multi-audio, resolution honor (LG BP350 verified)**

- Trick-play (fast-forward / rewind) unlocked on autoplayed titles — `random_access_flag` and UO mask patched in MPLS
- Multi-audio track support: all audio tracks from source MKV are preserved in the output disc
- Resolution honor: selected output resolution (1080p/720p/480p) is correctly passed through the encode pipeline; BD-compliant validation at build time
- Added 480p compatibility disclaimer in resolution dropdown

---

## v1.7.0 — 2026-05-17

**Multi-title disc authoring (LG hardware verified)**

- Multi-title mode: build 2+ episodes as separate BD titles on a single disc
- Disc autoplays Episode 1; Title button on remote cycles between episodes
- MovieObject and index.bdmv regenerated for N-title navigation
- Fixed PLAY_PL opcode: replaced incorrect JUMP_TITLE (0x21810000) with correct PLAY_PL (0x22800000)
- Fixed multi-title routing: renderer dispatches correct build path when 2+ episodes present
- Fixed localStorage persistence and per-render sync for light/dark mode toggle

---

## v1.6.0 — 2026-05-16

**First hardware-verified release — plays on consumer LG BD player**

- BD-ROM navigation pipeline verified on LG BP350 hardware
- FirstPlay/TopMenu point to correct obj[2] (bypasses tsMuxeR obj[0]/obj[1] which referenced stale playlist 0)
- FirstPlay/TopMenu set to `playback_type=interactive` matching commercial BD discs
- index.bdmv validator updated for 12-byte HDMV entry layout
- Self-test on startup verifies ffmpeg, tsMuxeR, mkvmerge, xorriso availability

---

## v1.5.2
- Video Quality Mode — per-title quality selector: Passthrough, High Quality (CRF 18), Balanced (CRF 20), Compact (CRF 23)
- CRF re-encode produces BD-compliant H.264 High Profile output
- Size estimates update per-title based on selected quality multiplier
- CRF encode progress shows fps, frame count, and estimated time remaining
- Apply-to-all quality button for quick global quality changes
- Quality badge per title: green Copy / yellow CRF N
- Fixed subtitle pipeline: FFmpeg subrip fallback when pysubs2 fails

## v1.5.1
- Accurate disc size estimation using video bitrate + AC3 audio + subtitle overhead via ffprobe
- Elapsed timer stops when build completes
- ISO file size shown prominently in success screen
- Build steps show output file size on completion
- Per-title ETA based on previous title durations
- Disc capacity warning if estimate exceeds BD-25 or BD-50
- Disc capacity fill bar added to Project tab

## v1.5.0
- Disc burning with real-time progress (growisofs + hdiutil fallback)
- Chapter thumbnails — auto-generate 160×90 previews per chapter via FFmpeg
- Passthrough mode — skip FFmpeg transcode for BD-compatible H.264/HEVC titles
- BD compatibility detection badge per title
- 6 new menu themes: Minimal, Cinema, Vintage, Neon, Grid, Sidebar
- Gradient background with direction selector
- Background image blur/brightness/contrast controls
- Font size sliders for title (24–96px) and episodes (12–36px)
- Font weight and letter spacing controls
- Text shadow with colour, blur, and X/Y offset
- Button border radius and hover effects
- Episode spacing and number toggle
- Disc title overlay with position selector
- Animated background (pan, pulse, particles)

## v1.4.0
- Full subtitle support on all episodes (ASS/SRT→PGS via pysubs2 + tsMuxeR)
- mkvmerge integration for clean multi-track MKV assembly
- Track name metadata from source MKV
- 6-step subtitle pipeline: FFmpeg → pysubs2 → tsMuxeR → FFmpeg → mkvmerge → tsMuxeR

## v1.3.0
- Fix subtitle tracks from episodes 2+ leaking into main tsMuxeR meta
- Fix missing track= parameter on embedded subtitle entries
- Multi-title navigation: regenerate index.bdmv + MovieObject.bdmv for N titles
- Path escaping for filenames containing double-quotes in tsMuxeR meta

## v1.2.0
- Burn to BD-R disc directly
- Interactive menu preview simulator
- Episode / audio / subtitle menu screens
- Persistent colour picker with presets
- Chapter auto-import from video files
- Custom button text and emoji toggle
- Text stroke/outline on menu title
- Logo/watermark image support
- Project save and load (.dfp files)
- Build progress with ETA and elapsed time
- About screen and version history
