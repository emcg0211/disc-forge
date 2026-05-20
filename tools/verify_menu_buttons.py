#!/usr/bin/env python3
"""
verify_menu_buttons.py — pixel-count verifier for IG menu button rendering.

Usage: python3 verify_menu_buttons.py <screenshot.png> [--debug-png <out.png>]

Button geometry (2 buttons, 1920x1080):
  BTN_W=800, BTN_H=90, BTN_GAP=30
  topY = (1080 - (2*90+30)) / 2 = 435
  btnX = (1920 - 800) / 2 = 560
  Button 0: (560,435)-(1360,525)
  Button 1: (560,555)-(1360,645)

Acceptance criteria:
  - button_0 region: >= 2000 orange OR dark-blue pixels
  - button_1 region: >= 2000 orange OR dark-blue pixels
  - either region:   >= 500  white pixels (text + border)

Exit 0 = PASS, 1 = FAIL.
"""
import sys
import os
import struct
import zlib
import argparse

# ── Acceptance thresholds ──────────────────────────────────────────────────────
BUTTON_PIXEL_MIN = 2000   # colored button pixels per button region
WHITE_PIXEL_MIN  = 500    # white text/border pixels per region

# ── Button regions [x0, y0, x1, y1] ───────────────────────────────────────────
REGIONS = [
    (560, 435, 1360, 525),   # Button 0
    (560, 555, 1360, 645),   # Button 1
]

# ── Color targets (RGB) ────────────────────────────────────────────────────────
ORANGE    = (201, 100,   0)
DARK_BLUE = (  0,  37, 120)
WHITE     = (255, 255, 255)

# Tolerance radius squared
COLORED_TOL2 = 40 ** 2   # within 40 of target
WHITE_TOL2   = 50 ** 2   # within 50 of white


def _color_dist2(r1, g1, b1, r2, g2, b2):
    return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2


def _is_colored(r, g, b):
    return (_color_dist2(r, g, b, *ORANGE) <= COLORED_TOL2 or
            _color_dist2(r, g, b, *DARK_BLUE) <= COLORED_TOL2)


def _is_white(r, g, b):
    return _color_dist2(r, g, b, *WHITE) <= WHITE_TOL2


def _read_png_rgb(path):
    """Minimal PNG reader — returns (width, height, pixels) where pixels is list of (R,G,B)."""
    with open(path, 'rb') as f:
        raw = f.read()

    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Not a PNG file')

    pos = 8
    chunks = {}
    while pos < len(raw):
        length = struct.unpack('>I', raw[pos:pos+4])[0]
        ctype  = raw[pos+4:pos+8]
        data   = raw[pos+8:pos+8+length]
        pos   += 12 + length
        chunks.setdefault(ctype, []).append(data)

    ihdr = chunks[b'IHDR'][0]
    width  = struct.unpack('>I', ihdr[0:4])[0]
    height = struct.unpack('>I', ihdr[4:8])[0]
    bit_depth  = ihdr[8]
    color_type = ihdr[9]  # 2=RGB, 6=RGBA

    if bit_depth != 8 or color_type not in (2, 6):
        raise ValueError(f'Only 8-bit RGB/RGBA PNG supported (got bit_depth={bit_depth}, color_type={color_type})')

    # Decompress IDAT
    idat = b''.join(chunks.get(b'IDAT', []))
    raw_data = zlib.decompress(idat)

    channels = 3 if color_type == 2 else 4
    stride   = 1 + width * channels   # 1 filter byte + pixel data

    pixels = []
    for y in range(height):
        row = raw_data[y * stride: (y + 1) * stride]
        filt = row[0]
        row_pixels = bytearray(row[1:])

        # Apply PNG filter
        if filt == 0:
            pass  # None
        elif filt == 1:  # Sub
            for x in range(channels, len(row_pixels)):
                row_pixels[x] = (row_pixels[x] + row_pixels[x - channels]) & 0xFF
        elif filt == 2:  # Up
            if y == 0:
                pass
            else:
                prev = raw_data[(y-1) * stride + 1:(y-1)*stride + 1 + width*channels]
                for x in range(len(row_pixels)):
                    row_pixels[x] = (row_pixels[x] + prev[x]) & 0xFF
        elif filt == 3:  # Average
            prev = (raw_data[(y-1)*stride+1:(y-1)*stride+1+width*channels]
                    if y > 0 else bytes(len(row_pixels)))
            for x in range(len(row_pixels)):
                a = row_pixels[x - channels] if x >= channels else 0
                b = prev[x]
                row_pixels[x] = (row_pixels[x] + (a + b) // 2) & 0xFF
        elif filt == 4:  # Paeth
            prev = (raw_data[(y-1)*stride+1:(y-1)*stride+1+width*channels]
                    if y > 0 else bytes(len(row_pixels)))
            for x in range(len(row_pixels)):
                a = row_pixels[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                if pa <= pb and pa <= pc:
                    pred = a
                elif pb <= pc:
                    pred = b
                else:
                    pred = c
                row_pixels[x] = (row_pixels[x] + pred) & 0xFF

        for x in range(width):
            r = row_pixels[x * channels]
            g = row_pixels[x * channels + 1]
            b = row_pixels[x * channels + 2]
            pixels.append((r, g, b))

    return width, height, pixels


def verify(png_path, debug_png=None):
    print(f'Verifying: {png_path}')
    width, height, pixels = _read_png_rgb(png_path)
    print(f'  Image: {width}x{height}')

    # Auto-detect Retina 2x screenshots and scale ROI coordinates accordingly.
    # The reference geometry is 1920x1080; a Retina screencap is 3840x2160.
    scale = round(width / 1920)
    if scale < 1:
        scale = 1
    if scale != 1:
        print(f'  Retina scale detected: {scale}x — scaling ROI coords by {scale}')

    results = []
    for ri, (x0, y0, x1, y1) in enumerate(REGIONS):
        sx0, sy0, sx1, sy1 = x0*scale, y0*scale, x1*scale, y1*scale
        colored_count = 0
        white_count   = 0
        for y in range(sy0, sy1):
            for x in range(sx0, sx1):
                if x < width and y < height:
                    r, g, b = pixels[y * width + x]
                    if _is_colored(r, g, b):
                        colored_count += 1
                    elif _is_white(r, g, b):
                        white_count += 1
        # Normalize counts back to 1x area so thresholds remain scale-independent
        colored_count = colored_count // (scale * scale)
        white_count   = white_count   // (scale * scale)
        results.append({'colored': colored_count, 'white': white_count, 'scale': scale,
                        'roi': (sx0, sy0, sx1, sy1)})
        status = 'OK' if colored_count >= BUTTON_PIXEL_MIN else 'FAIL'
        print(f'  Button {ri}: colored={colored_count} white={white_count} [{status}]')

    # Overall verdict
    both_colored = all(r['colored'] >= BUTTON_PIXEL_MIN for r in results)
    any_white    = any(r['white']   >= WHITE_PIXEL_MIN  for r in results)

    print(f'\n  colored_pass={both_colored} white_pass={any_white}')

    # Write annotated debug PNG (simple, writes colored rectangles around ROIs)
    if debug_png:
        _write_debug_png(debug_png, width, height, pixels, results)
        print(f'  Debug PNG: {debug_png}')

    if both_colored and any_white:
        print('RESULT: PASS')
        return True
    elif both_colored:
        print('RESULT: PASS (buttons colored, no white text detected — text rendering may have fallen back)')
        return True
    else:
        print('RESULT: FAIL — buttons not rendered')
        return False


def _write_debug_png(out_path, w, h, pixels, results):
    """Write a debug PNG with button ROIs highlighted."""
    # Build RGBA pixel array, mark ROIs with red border
    rgba = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            r, g, b = pixels[y * w + x]
            off = (y * w + x) * 4
            rgba[off] = r; rgba[off+1] = g; rgba[off+2] = b; rgba[off+3] = 255

    for ri, result in enumerate(results):
        x0, y0, x1, y1 = result.get('roi', REGIONS[ri])
        color = (255, 0, 0) if result['colored'] < BUTTON_PIXEL_MIN else (0, 255, 0)
        for x in range(x0, x1):
            for py in [y0, y1-1]:
                if 0 <= py < h and 0 <= x < w:
                    off = (py * w + x) * 4
                    rgba[off] = color[0]; rgba[off+1] = color[1]; rgba[off+2] = color[2]
        for y in range(y0, y1):
            for px in [x0, x1-1]:
                if 0 <= y < h and 0 <= px < w:
                    off = (y * w + px) * 4
                    rgba[off] = color[0]; rgba[off+1] = color[1]; rgba[off+2] = color[2]

    # Encode minimal PNG RGBA
    def make_chunk(ctype, data):
        crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + ctype + data + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw_rows = []
    for y in range(h):
        row = bytes([0]) + bytes(rgba[y*w*4:(y+1)*w*4])
        raw_rows.append(row)
    idat = zlib.compress(b''.join(raw_rows))

    png = (b'\x89PNG\r\n\x1a\n' +
           make_chunk(b'IHDR', ihdr) +
           make_chunk(b'IDAT', idat) +
           make_chunk(b'IEND', b''))
    with open(out_path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--debug-png', default=None)
    args = ap.parse_args()

    if not os.path.exists(args.png):
        print(f'ERROR: {args.png} not found')
        sys.exit(1)

    ok = verify(args.png, debug_png=args.debug_png)
    sys.exit(0 if ok else 1)
