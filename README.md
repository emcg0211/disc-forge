# Disc Forge

**Free, open-source macOS app that authors Blu-ray ISOs from MKV files.**

Disc Forge turns MKV files into fully-compliant BD-ROM ISOs with proper navigation, multi-title support, trick-play, and custom splash screens — no Windows VM, no command line, no subscription.

> Built by one person, for people who care about their physical media collection.

---

## Features

**Verified working in v1.8.0 on LG BP350 hardware:**

- **Multi-episode discs** — build a full season on a single disc; disc autoplays Episode 1, Title button cycles between episodes
- **Trick-play (FF/RW)** — fast-forward and rewind work correctly on autoplayed titles
- **Custom splash screen** — solid color or custom PNG, duration 3/5/8/10 seconds
- **Multiple audio tracks** — preserves all dubs, commentary, and language options from source MKV
- **Resolution enforcement** — honors your selected output resolution (1080p/720p/480p); BD-compliant validation at build time
- **Stream copy / passthrough** — zero re-encoding for already-BD-compatible sources
- **ISO output** — mount and play in VLC, IINA, or any BD-capable software player
- **Light and dark mode**

**New in v1.10.0:**
- **Interactive episode menu** — BD-ROM IG (Interactive Graphics) menu at disc boot; each episode gets a labeled button; supports 2–9 episodes with auto-centered layout; customizable button labels; text rendered via ffmpeg drawtext with bundled Inter font (SIL OFL)

**Roadmap (not yet in a shipping release):**
- Complete subtitle pipeline (SRT/ASS/SUP/PGS conversion end-to-end)
- Multi-disc projects (BD-50)

---

## Requirements

- macOS (Apple Silicon or Intel)
- ffmpeg, mkvmerge, tsMuxeR, xorriso (see Building from Source)
- ~5 GB free disk space for build temp files

---

## Installation

Download the latest `.dmg` from [Releases](https://github.com/emcg0211/disc-forge/releases).

Since the app is unsigned, macOS may show a security warning on first launch. Run this once to clear it:

```bash
xattr -cr "/Applications/Disc Forge.app"
```

Then launch normally.

---

## Building from Source

### Prerequisites

```bash
brew install node mkvtoolnix xorriso
brew install --cask tsmuxer
```

You also need:
- [FFmpeg static build](https://evermeet.cx/ffmpeg/) — place `ffmpeg` and `ffprobe` in `bin/`
- `tsMuxeR` binary in `bin/` (from tsMuxeR releases or Homebrew cask)

### Run in development

```bash
git clone https://github.com/emcg0211/disc-forge.git
cd disc-forge
npm install
npm start
```

### Build a distributable .app

```bash
./BUILD_FOR_DISTRIBUTION.sh
# or: npm run build
```

---

## Usage — Single Title

1. Open Disc Forge
2. Drop an MKV file into "Main feature"
3. Set title, resolution, and codec
4. Click **Build Blu-ray ISO**
5. Mount the resulting ISO in VLC or burn to BD-R

---

## Usage — Multi-Episode Disc

1. Switch to multi-title mode in the UI
2. Add 2+ MKV files as episodes
3. (Optional) Enable splash screen — choose PNG or color + duration
4. Click **Build Blu-ray ISO**
5. Disc autoplays Episode 1; the **Title** button on the remote cycles between episodes

---

## Known Limitations

- Trick-play on Title 2+ depends on player firmware; tested on LG BP350
- Subtitle pipeline is partially wired; for embedded PGS in source MKV it works; SRT/ASS conversion is not yet end-to-end
- Interactive menus are in development (IG encoder foundation complete with 59 passing tests, not yet wired into builds)
- No animated disc menus yet
- Apple Silicon binary only in the pre-built DMG; Intel users must build from source

---

## Architecture

Disc Forge is an Electron + Node.js app. The build pipeline:

1. **FFmpeg** — transcodes audio (FLAC/LPCM → AC3) and optionally re-encodes video at target CRF
2. **mkvmerge** — assembles video + audio + subtitle streams into a clean MKV container
3. **tsMuxeR** — muxes the MKV into BDAV-format `.m2ts` files and generates initial BDMV structure (CLIPINF, PLAYLIST, MovieObject, index.bdmv)
4. **Custom patching** — post-processes MPLS/CLPI/MovieObject binary data to wire correct navigation, trick-play flags, and splash screen integration
5. **xorriso / hdiutil** — packages the BDMV folder into a UDF 2.50 ISO

The renderer layer is vanilla JS + HTML in `src/renderer.js`; all build orchestration lives in `src/main.js`.

---

## Verification

The investigation harness at `tools/disc_forge_harness.py` provides end-to-end disc verification. Run it against a built ISO to confirm splash, navigation, and stream structure are correct.

---

## Version History

See [CHANGELOG.md](CHANGELOG.md)

---

## License

Disc Forge is free for **personal, non-commercial use**. See [LICENSE](LICENSE) for full terms.

---

## Dependencies

- [FFmpeg](https://ffmpeg.org/) — audio/video processing
- [tsMuxeR](https://github.com/justdan96/tsMuxeR) — Blu-ray muxing
- [mkvtoolnix](https://mkvtoolnix.download/) — MKV container tools
- [xorriso](https://www.gnu.org/software/xorriso/) — ISO/UDF disc image creation
- [Electron](https://www.electronjs.org/) — app framework

---

## Contributing

Issues and pull requests welcome at [github.com/emcg0211/disc-forge](https://github.com/emcg0211/disc-forge).
