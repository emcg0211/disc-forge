#!/usr/bin/env python3
"""
parse_ig_segments.py — Parse IG segments from a BD m2ts file.

Usage: python3 tools/parse_ig_segments.py [m2ts_path] [pid_hex]
Defaults: /Volumes/TEST/BDMV/STREAM/00099.m2ts  0x1400
"""

import sys
import struct

M2TS_PATH = sys.argv[1] if len(sys.argv) > 1 else '/Volumes/TEST/BDMV/STREAM/00099.m2ts'
IG_PID    = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x1400

SEG_ICS = 0x18
SEG_ODS = 0x15
SEG_PDS = 0x14
SEG_WDS = 0x17
SEG_END = 0x80

# ── Step 1: Demux PES from m2ts ────────────────────────────────────────────────

def demux_pes(path, pid):
    """Extract PES byte arrays from 192-byte m2ts packets for given PID."""
    with open(path, 'rb') as f:
        data = f.read()

    pkt_size = 192
    n_pkts = len(data) // pkt_size
    pes_list = []
    current = None

    for i in range(n_pkts):
        pkt = data[i * pkt_size : i * pkt_size + pkt_size]
        # Strip 4-byte arrival timestamp to get 188-byte TS packet
        ts = pkt[4:]
        if ts[0] != 0x47:
            continue  # not a valid TS sync byte

        this_pid = ((ts[1] & 0x1F) << 8) | ts[2]
        if this_pid != pid:
            continue

        pusi = (ts[1] >> 6) & 1
        adaptation = (ts[3] >> 4) & 0x03  # 0x01=payload only, 0x03=adaptation+payload

        if adaptation == 0x00:
            continue  # no payload

        if adaptation == 0x03:
            adap_len = ts[4] + 1  # adaptation_field_length + 1 byte for the length field itself
            payload_start = 4 + adap_len
        else:
            payload_start = 4

        payload = ts[payload_start:]

        if pusi:
            if current is not None:
                pes_list.append(bytes(current))
            current = bytearray(payload)
        else:
            if current is not None:
                current.extend(payload)

    if current is not None:
        pes_list.append(bytes(current))

    return pes_list

# ── Step 2: Strip PES header to get segment data ───────────────────────────────

def strip_pes_header(pes):
    """Strip PES header and return raw segment payload bytes."""
    if len(pes) < 9:
        return None
    if pes[0] != 0x00 or pes[1] != 0x00 or pes[2] != 0x01:
        return None  # not a PES start code

    # stream_id = pes[3]
    # PES_packet_length = struct.unpack_from('>H', pes, 4)[0]
    # PES flags at pes[6], pes[7]
    hdr_data_len = pes[8]
    segment_start = 9 + hdr_data_len
    return pes[segment_start:]

# ── Step 3: Parse ICS segment ──────────────────────────────────────────────────

def parse_ics(payload):
    """Parse ICS (0x18) payload and return a structured dict."""
    if len(payload) < 9:
        return {'error': 'too short'}
    off = 0

    video_width  = struct.unpack_from('>H', payload, off)[0]; off += 2
    video_height = struct.unpack_from('>H', payload, off)[0]; off += 2
    frame_rate   = payload[off]; off += 1

    comp_number  = struct.unpack_from('>H', payload, off)[0]; off += 2
    comp_state   = (payload[off] >> 6) & 0x03; off += 1

    seq_desc     = payload[off]; off += 1
    first_in_seq = (seq_desc >> 7) & 1
    last_in_seq  = (seq_desc >> 6) & 1

    # InteractiveComposition — 3-byte data_len prefix
    if off + 3 > len(payload):
        return {'error': 'IC truncated at data_len'}
    data_len = (payload[off] << 16) | (payload[off+1] << 8) | payload[off+2]; off += 3
    ic_start = off

    if off >= len(payload):
        return {'error': 'IC empty'}

    flags_byte   = payload[off]; off += 1
    stream_model = (flags_byte >> 7) & 1
    ui_model     = (flags_byte >> 6) & 1

    composition_timeout_pts = None
    selection_timeout_pts   = None
    if stream_model == 0:
        # 7 reserved bits + 33-bit PTS = 40 bits = 5 bytes
        # 7 reserved bits + 33-bit PTS = 40 bits = 5 bytes
        comp_to_raw = payload[off:off+5]; off += 5
        sel_to_raw  = payload[off:off+5]; off += 5
        # Decode 33-bit PTS: skip high 7 bits of first byte, take remaining 1 bit
        # then next 4 bytes = 32 bits  => 1+32 = 33 bits
        composition_timeout_pts = ((comp_to_raw[0] & 0x01) << 32) | struct.unpack_from('>I', comp_to_raw, 1)[0]
        selection_timeout_pts   = ((sel_to_raw[0]  & 0x01) << 32) | struct.unpack_from('>I', sel_to_raw, 1)[0]

    user_timeout = (payload[off] << 16) | (payload[off+1] << 8) | payload[off+2]; off += 3

    num_pages = payload[off]; off += 1

    pages = []
    for page_i in range(num_pages):
        page, off = parse_page(payload, off)
        pages.append(page)

    remaining = len(payload) - off
    ic_consumed = off - ic_start
    data_len_match = (ic_consumed == data_len)

    return {
        'video_width': video_width,
        'video_height': video_height,
        'frame_rate': frame_rate,
        'comp_number': comp_number,
        'comp_state': comp_state,
        'first_in_seq': first_in_seq,
        'last_in_seq': last_in_seq,
        'data_len': data_len,
        'data_len_match': data_len_match,
        'stream_model': stream_model,
        'ui_model': ui_model,
        'composition_timeout_pts': composition_timeout_pts,
        'selection_timeout_pts': selection_timeout_pts,
        'user_timeout_duration': user_timeout,
        'num_pages': num_pages,
        'pages': pages,
        'ic_consumed': ic_consumed,
        'payload_remaining_after_parse': remaining,
    }

def parse_page(payload, off):
    page_id      = payload[off]; off += 1
    page_version = payload[off]; off += 1
    uo_mask      = payload[off:off+8]; off += 8

    # in_effects: num_windows(1) + windows + num_effects(1) + effects
    in_fx, off  = parse_effect_sequence(payload, off)
    out_fx, off = parse_effect_sequence(payload, off)

    anim_fps  = payload[off]; off += 1
    def_sel   = struct.unpack_from('>H', payload, off)[0]; off += 2
    def_act   = struct.unpack_from('>H', payload, off)[0]; off += 2
    pal_id    = payload[off]; off += 1
    num_bogs  = payload[off]; off += 1

    bogs = []
    for b in range(num_bogs):
        bog, off = parse_bog(payload, off)
        bogs.append(bog)

    return {
        'id': page_id,
        'version': page_version,
        'anim_fps': anim_fps,
        'default_selected_button_id': def_sel,
        'default_activated_button_id': def_act,
        'palette_id_ref': pal_id,
        'num_bogs': num_bogs,
        'in_effects_windows': in_fx['num_windows'],
        'in_effects_effects': in_fx['num_effects'],
        'out_effects_windows': out_fx['num_windows'],
        'out_effects_effects': out_fx['num_effects'],
        'bogs': bogs,
    }, off

def parse_effect_sequence(payload, off):
    num_windows = payload[off]; off += 1
    windows = []
    for _ in range(num_windows):
        # window_id(1) x(2) y(2) w(2) h(2) = 9 bytes
        windows.append({'id': payload[off], 'x': struct.unpack_from('>H', payload, off+1)[0],
                        'y': struct.unpack_from('>H', payload, off+3)[0],
                        'w': struct.unpack_from('>H', payload, off+5)[0],
                        'h': struct.unpack_from('>H', payload, off+7)[0]})
        off += 9
    num_effects = payload[off]; off += 1
    for _ in range(num_effects):
        duration = (payload[off] << 16) | (payload[off+1] << 8) | payload[off+2]; off += 3
        pal_id   = payload[off]; off += 1
        num_co   = payload[off]; off += 1
        for _ in range(num_co):
            # pg_decode_composition_object: object_id(2) window_id(1) flags(1) x(2) y(2)
            # plus optional crop: crop_x(2) crop_y(2) crop_w(2) crop_h(2) — flagged by bit
            flags = payload[off+3]
            off_co = 8
            if flags & 0x80:  # forced_on_flag crops
                off_co += 8
            off += off_co
    return {'num_windows': num_windows, 'num_effects': num_effects}, off

def parse_bog(payload, off):
    def_valid_btn = struct.unpack_from('>H', payload, off)[0]; off += 2
    num_buttons   = payload[off]; off += 1

    buttons = []
    for b in range(num_buttons):
        btn, off = parse_button(payload, off)
        buttons.append(btn)

    return {
        'default_valid_button_id': def_valid_btn,
        'num_buttons': num_buttons,
        'buttons': buttons,
    }, off

def parse_button(payload, off):
    btn_id   = struct.unpack_from('>H', payload, off)[0]; off += 2
    num_sel  = struct.unpack_from('>H', payload, off)[0]; off += 2
    auto_act = payload[off]; off += 1
    x        = struct.unpack_from('>H', payload, off)[0]; off += 2
    y        = struct.unpack_from('>H', payload, off)[0]; off += 2
    upper    = struct.unpack_from('>H', payload, off)[0]; off += 2
    lower    = struct.unpack_from('>H', payload, off)[0]; off += 2
    left     = struct.unpack_from('>H', payload, off)[0]; off += 2
    right    = struct.unpack_from('>H', payload, off)[0]; off += 2
    norm_start = struct.unpack_from('>H', payload, off)[0]; off += 2
    norm_end   = struct.unpack_from('>H', payload, off)[0]; off += 2
    norm_rep   = payload[off]; off += 1
    sel_snd    = payload[off]; off += 1
    sel_start  = struct.unpack_from('>H', payload, off)[0]; off += 2
    sel_end    = struct.unpack_from('>H', payload, off)[0]; off += 2
    sel_rep    = payload[off]; off += 1
    act_snd    = payload[off]; off += 1
    act_start  = struct.unpack_from('>H', payload, off)[0]; off += 2
    act_end    = struct.unpack_from('>H', payload, off)[0]; off += 2
    num_nav    = struct.unpack_from('>H', payload, off)[0]; off += 2
    nav_cmds   = []
    for _ in range(num_nav):
        cmd = payload[off:off+12]
        nav_cmds.append(cmd.hex())
        off += 12

    return {
        'id': btn_id,
        'numeric_select_value': num_sel,
        'auto_action': auto_act,
        'x': x, 'y': y,
        'upper': upper, 'lower': lower, 'left': left, 'right': right,
        'normal_start_obj': norm_start, 'normal_end_obj': norm_end,
        'sel_start_obj': sel_start, 'sel_end_obj': sel_end,
        'act_start_obj': act_start, 'act_end_obj': act_end,
        'nav_cmds': nav_cmds,
    }, off

# ── Step 4: Parse ODS segment ──────────────────────────────────────────────────

def parse_ods(payload):
    if len(payload) < 7:
        return {'error': 'too short'}
    obj_id  = struct.unpack_from('>H', payload, 0)[0]
    version = payload[2]
    seq     = payload[3]
    first   = (seq >> 7) & 1
    last    = (seq >> 6) & 1
    if first:
        data_len = (payload[4] << 16) | (payload[5] << 8) | payload[6]
        width  = struct.unpack_from('>H', payload, 7)[0]
        height = struct.unpack_from('>H', payload, 9)[0]
        rle_len = len(payload) - 11
        return {'object_id': obj_id, 'version': version, 'first': first, 'last': last,
                'data_len': data_len, 'width': width, 'height': height, 'rle_bytes': rle_len}
    else:
        return {'object_id': obj_id, 'version': version, 'first': first, 'last': last,
                'continuation_bytes': len(payload) - 4}

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print(f"Parsing: {M2TS_PATH}  PID=0x{IG_PID:04X}")
    pes_packets = demux_pes(M2TS_PATH, IG_PID)
    print(f"Found {len(pes_packets)} PES packets for PID 0x{IG_PID:04X}")

    ics_found = 0
    ods_found = []
    seg_counts = {}

    for pes_i, pes in enumerate(pes_packets):
        seg_data = strip_pes_header(pes)
        if seg_data is None or len(seg_data) < 3:
            print(f"  PES[{pes_i}]: bad header or too short ({len(pes)} bytes)")
            continue

        seg_type   = seg_data[0]
        seg_len    = struct.unpack_from('>H', seg_data, 1)[0]
        seg_payload = seg_data[3:3+seg_len]
        seg_counts[seg_type] = seg_counts.get(seg_type, 0) + 1

        if seg_type == SEG_ICS:
            ics_found += 1
            print(f"\n{'='*60}")
            print(f"ICS segment (PES[{pes_i}]) — payload {seg_len} bytes")
            print(f"{'='*60}")
            ics = parse_ics(seg_payload)
            if 'error' in ics:
                print(f"  PARSE ERROR: {ics['error']}")
                print(f"  Raw hex: {seg_payload[:64].hex()}")
                continue

            print(f"  Video: {ics['video_width']}x{ics['video_height']} frame_rate=0x{ics['frame_rate']:02X}")
            print(f"  Composition: number={ics['comp_number']} state={ics['comp_state']} first={ics['first_in_seq']} last={ics['last_in_seq']}")
            print(f"  IC data_len={ics['data_len']} ic_consumed={ics['ic_consumed']} data_len_match={ics['data_len_match']}")
            print(f"  stream_model={ics['stream_model']} ui_model={ics['ui_model']}")
            if ics['composition_timeout_pts'] is not None:
                print(f"  comp_timeout_pts={ics['composition_timeout_pts']}  sel_timeout_pts={ics['selection_timeout_pts']}")
            print(f"  user_timeout_duration={ics['user_timeout_duration']}")
            print(f"  num_pages={ics['num_pages']}")

            for pi, page in enumerate(ics['pages']):
                print(f"\n  Page[{pi}]: id={page['id']} version={page['version']}")
                print(f"    default_selected_button_id={page['default_selected_button_id']}")
                print(f"    default_activated_button_id={page['default_activated_button_id']}")
                print(f"    palette_id_ref={page['palette_id_ref']}")
                print(f"    anim_fps={page['anim_fps']}")
                print(f"    in_effects: windows={page['in_effects_windows']} effects={page['in_effects_effects']}")
                print(f"    out_effects: windows={page['out_effects_windows']} effects={page['out_effects_effects']}")
                print(f"    num_bogs={page['num_bogs']}")

                for bi, bog in enumerate(page['bogs']):
                    print(f"\n    BOG[{bi}]: default_valid_btn={bog['default_valid_button_id']} num_buttons={bog['num_buttons']}")
                    for bti, btn in enumerate(bog['buttons']):
                        print(f"      Button[{bti}]:")
                        print(f"        id={btn['id']}  numeric_select={btn['numeric_select_value']}  auto={btn['auto_action']}")
                        print(f"        pos=({btn['x']}, {btn['y']})")
                        print(f"        nav: upper={btn['upper']} lower={btn['lower']} left={btn['left']} right={btn['right']}")
                        print(f"        normal:  obj {btn['normal_start_obj']}–{btn['normal_end_obj']}")
                        print(f"        selected: obj {btn['sel_start_obj']}–{btn['sel_end_obj']}")
                        print(f"        activated: obj {btn['act_start_obj']}–{btn['act_end_obj']}")
                        print(f"        nav_cmds ({len(btn['nav_cmds'])}): {btn['nav_cmds']}")

        elif seg_type == SEG_ODS:
            ods = parse_ods(seg_payload)
            ods_found.append(ods)

        elif seg_type == SEG_END:
            pass  # expected

    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"Segment type counts: { {hex(k): v for k, v in sorted(seg_counts.items())} }")
    print(f"ICS segments found: {ics_found}")
    print(f"\nODS segments ({len(ods_found)} total):")
    for ods in ods_found:
        if 'error' in ods:
            print(f"  ODS ERROR: {ods['error']}")
        elif ods.get('first'):
            print(f"  ODS id={ods['object_id']} ver={ods['version']} {ods['width']}x{ods['height']} rle={ods['rle_bytes']} bytes  data_len={ods['data_len']}")
        else:
            print(f"  ODS id={ods['object_id']} (continuation) {ods['continuation_bytes']} bytes")

if __name__ == '__main__':
    main()
