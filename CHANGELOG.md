# Changelog

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
