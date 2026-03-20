# 💿 Disc Forge

**Professional Blu-ray Authoring Studio for macOS**

Multi-language audio · PGS subtitles · Chapter navigation · Custom menus · Special features

---

## Install & Run

### Step 1 — Install dependencies (one-time)

```bash
# Node.js (if not installed)
brew install node

# Required for hardware BD-player compatible ISOs
brew install --cask tsmuxer

# Required for video muxing
brew install ffmpeg
```

### Step 2 — Build the .app

```bash
cd disc-forge
chmod +x build.sh
./build.sh
```

Takes 2–5 minutes. Outputs `dist/Disc Forge-1.0.0.dmg`.

### Step 3 — Install

Open the `.dmg`, drag **Disc Forge** to Applications, launch it.

> If macOS says "unidentified developer": **System Settings → Privacy & Security → Open Anyway**

---

## Quick Start — MKV Import

The fastest way to get going:

1. Click the **MKV Import** tab
2. Select your `.mkv` file
3. The app detects all embedded audio, subtitle and chapter tracks automatically
4. Toggle tracks on/off, adjust languages, click **Import**
5. Hit **Build Disc Image** in the sidebar

---

## Pipeline

```
MKV / MP4 / M2TS
      │
      ▼
  FFmpeg          muxes video + audio + subtitles into MPEG-TS
                  with language tags, chapter metadata
      │
      ▼
  tsMuxeR         compiles BDMV navigation bytecode:
                  index.bdmv, MovieObject.bdmv, CLIPINF,
                  PLAYLIST, STREAM; SRT→PGS conversion
      │
      ▼
  hdiutil         packages UDF 2.5 + ISO 9660 hybrid .iso
  (built-in macOS)
      │
      ▼
  YourDisc.iso    ✅  hardware BD players, PS4/PS5, VLC, Kodi
```

---

## Run Without Building (Dev Mode)

```bash
npm install
npm start
```
