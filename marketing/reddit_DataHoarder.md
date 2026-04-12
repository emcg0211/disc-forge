# r/DataHoarder Post

**Title:** Built a macOS Blu-ray authoring tool for people who want to archive their rips back to disc — Disc Forge

**Body:**

Fellow hoarders,

After ripping my entire Blu-ray collection to MKV with MakeMKV, I wanted a way to author proper BD-R discs from those files — complete with all the original audio tracks, subtitles, and chapter markers intact. Nothing good existed for Mac so I built it.

**Disc Forge** — Blu-ray authoring for macOS

**The workflow:**
1. Add your MKV files (multi-select, multiple titles per disc)
2. App auto-probes with ffprobe and shows every embedded stream — audio languages, subtitle tracks, codec info, stream index
3. Check/uncheck exactly which tracks you want burned
4. Set disc size (BD-25/BD-50/BD-100), hit Build
5. Burn to BD-R directly from the app

**Technical details for those who care:**
- Uses FFmpeg for muxing, tsMuxeR for BD navigation structure
- hdiutil creates proper UDF 2.5 + ISO 9660 hybrid images
- Disc capacity meter updates in real time as you add files
- Supports all audio formats: DTS-HD MA, TrueHD, PCM, DD 5.1, DTS
- Subtitle formats: SRT, ASS, PGS (native BD), VTT

It's $5. No subscription, no DRM, no cloud nonsense.

[Download link]

Happy to answer any technical questions.
