// afterPack.js - Makes bundled binaries executable after electron-builder packs the app
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const binDir = path.join(context.appOutDir, 'Disc Forge.app', 'Contents', 'Resources', 'bin');
  
  if (!fs.existsSync(binDir)) {
    console.log('afterPack: bin/ directory not found, skipping chmod');
    return;
  }

  const binaries = ['ffmpeg', 'ffprobe', 'tsMuxeR'];
  for (const bin of binaries) {
    const binPath = path.join(binDir, bin);
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, '755');
      console.log(`afterPack: chmod 755 ${bin}`);
    }
  }
};
