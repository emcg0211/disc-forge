# 💿 Disc Forge

**Professional Blu-ray Authoring Studio for macOS**

Disc Forge turns your MKV files into fully-compliant Blu-ray ISOs — complete with animated menus, multiple audio tracks, PGS subtitles, and proper BD navigation structure. No Windows VM. No command line. No subscription.

> Built by one person, for people who care about their physical media collection.

![Disc Forge Screenshot](docs/screenshot-main.png)

---

## ✨ Features

- **Multi-episode discs** — build a full season box set on a single disc
- **Multiple audio tracks** — preserve all dubs, commentary tracks, and language options
- **PGS subtitle support** — converts ASS/SRT subtitles to proper Blu-ray PGS format
- **Animated disc menus** — 12 built-in themes with full customization
- **Video quality modes** — Passthrough (stream copy) or CRF re-encode (CRF 18/20/23) to fit more episodes per disc
- **Direct BD-R burning** — burn to disc without a separate app
- **Chapter markers** — auto-import from source MKV with thumbnail previews
- **Passthrough mode** — zero re-encoding for BD-compatible sources
- **Accurate disc size estimation** — estimates based on actual video bitrate, not source file size
- **ISO output** — mount and play in IINA, VLC, or any software player
- **Light and dark mode**

---

## 📋 Requirements

- macOS 12 or later
- Apple Silicon (M1/M2/M3/M4)
- No additional installs required — all dependencies are bundled

---

## 📥 Installation

1. Download the latest `Disc Forge-x.x.x-arm64.dmg` from [Releases](https://github.com/emcg0211/disc-forge/releases)
2. Open the DMG and drag Disc Forge to your Applications folder
3. On first launch, macOS may show a security warning since the app is unsigned

**To bypass the security warning, run this in Terminal:**
```bash
xattr -cr "/Applications/Disc Forge.app"
```
Then launch the app normally.

---

## 🛠 Building from Source

### Prerequisites

```bash
brew install node mkvtoolnix
```

You'll also need:
- [FFmpeg static build](https://evermeet.cx/ffmpeg/) — place `ffmpeg` and `ffprobe` in `bin/`
- [tsMuxeR](https://github.com/justdan96/tsMuxeR/releases) — place `tsMuxeR` in `bin/`
- Python 3 + pysubs2: `pip3 install pysubs2`

### Build

```bash
git clone https://github.com/emcg0211/disc-forge.git
cd disc-forge
npm install
npm start          # run in development
npm run build      # build DMG for distribution
```

---

## 🎬 How It Works

Disc Forge runs a multi-step pipeline under the hood:

1. **FFmpeg** — transcodes FLAC/LPCM audio to AC3, extracts subtitle streams
2. **pysubs2** — converts ASS/SSA subtitles to SRT format
3. **tsMuxeR** — converts SRT → PGS Blu-ray subtitles
4. **FFmpeg** — extracts PGS streams as `.sup` files
5. **mkvmerge** — combines video + audio + subtitles into a clean MKV
6. **tsMuxeR** — muxes the final BD structure (BDMV, CLIPINF, PLAYLIST)
7. **hdiutil** — packages everything into a UDF/ISO 9660 hybrid `.iso`

---

## 📊 Video Quality Modes

| Mode | Method | Size | Quality |
|------|--------|------|---------|
| Passthrough | Stream copy | 100% | Lossless |
| High Quality | CRF 18 | ~75% | Visually lossless |
| Balanced | CRF 20 | ~55% | Excellent |
| Compact | CRF 23 | ~40% | Good |

At CRF 20, a typical 24-minute episode shrinks from ~3.5 GB to ~900 MB — fitting a full 26-episode season on a single BD-50.

---

## 🎨 Menu Themes

Classic Dark · Elegant White · Retro Film · Minimal Type · Sci-Fi Grid · Organic Nature · Minimal · Cinema · Vintage · Neon · Grid · Sidebar

Full customization including gradient backgrounds, text shadows, animated effects, font controls, and a real-time live preview.

---

## 📝 Version History

See [CHANGELOG.md](CHANGELOG.md)

---

## ☕ Support Development

Disc Forge is free and open source. If it's useful to you, consider supporting development:

- [Buy Me a Coffee](https://buymeacoffee.com/emcg0211)
- [GitHub Sponsors](https://github.com/sponsors/emcg0211)

---

## 📄 License

Disc Forge is free for **personal, non-commercial use**. See [LICENSE](LICENSE) for full terms.

---

## 🙏 Dependencies

- [FFmpeg](https://ffmpeg.org/) — audio/video processing
- [tsMuxeR](https://github.com/justdan96/tsMuxeR) — Blu-ray muxing
- [mkvtoolnix](https://mkvtoolnix.download/) — MKV container tools
- [pysubs2](https://github.com/tkarabela/pysubs2) — subtitle conversion
- [Electron](https://www.electronjs.org/) — app framework
