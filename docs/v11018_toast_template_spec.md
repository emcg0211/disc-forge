# v1.10.18 — Toast-Template IG Structural Spec

**Source of truth:** byte-level forensic decode of the Roxio Toast reference disc
(`STREAM/01200.m2ts`, IG PID `0x1400`), confirmed working on the LG BP350.
This document is the implementation target for v1.10.18's menu-builder rewrite.

Framing for code/comments: these are **"BD-ROM IG conventions observed across
commercial authoring tools"** — engineered by observing the byte-level output of
a commercial authoring pipeline. Document them as interop conventions, not as a
copy of any one product.

---

## 0. PES-level overview (decoded, both display sets)

IG PID = `0x1400`. 10 PES packets, two display sets:

| PES | pkt | SEG | flags2 | hdrlen | PTS | DTS | PTS−DTS | seg_len |
|----:|----:|-----|--------|-------:|------:|------:|--------:|--------:|
| 0 | 777 | ICS | 0xC0 | 10 | 120030 | 108018 | 12012 | 110 |
| 1 | 778 | PDS | 0x80 | 5 | 108018 | — | — | 1277 |
| 2 | 786 | ODS | 0xC0 | 10 | 108024 | 108018 | 6 | 247 |
| 3 | 788 | END | 0x80 | 5 | 108024 | — | — | 0 |
| 4 | 1644 | ICS | 0xC0 | 10 | 165075 | 153063 | 12012 | 234 |
| 5 | 1646 | PDS | 0x80 | 5 | 153063 | — | — | 1277 |
| 6 | 1654 | ODS | 0xC0 | 10 | 153066 | 153063 | 3 | 171 |
| 7 | 1656 | ODS | 0xC0 | 10 | 153070 | 153066 | 4 | 190 |
| 8 | 1658 | ODS | 0xC0 | 10 | 153111 | 153070 | 41 | 645 |
| 9 | 1662 | END | 0x80 | 5 | 153111 | — | — | 0 |

**Two display sets** in the clip, both `composition_state = epoch_start (2)`:
- **DS1** (comp_number 0): single-button menu. Segment order `ICS → PDS → ODS → END`.
- **DS2** (comp_number 1): three-button menu. Segment order `ICS → PDS → ODS×3 → END`.

They are separated in the clip timeline by `45045 = 15×3003` ticks (0.5s @ 29.97).
Toast authored two distinct menu screens sharing one clip; we mirror the *structure*
(two epoch_start display sets, each re-asserting the full menu) for our single menu.

**No WDS segment in either display set.**

---

## 1. Inter-segment timing model (THE decode pipeline)

Per display set, with `ICS_PTS` = composition display time:

```
ICS.DTS = ICS_PTS − 12012            (12012 = 4 × 3003; Toast's exact lead time)
ICS.PTS = ICS_PTS                    flags2=0xC0, hdrlen=10
PDS.PTS = ICS.DTS                    flags2=0x80, hdrlen=5  (no DTS)
ODS[0].DTS = ICS.DTS
ODS[i].DTS = ODS[i-1].PTS            (chained)
ODS[i].PTS = ODS[i].DTS + ceil(w*h/90)   flags2=0xC0, hdrlen=10
END.PTS    = ODS[last].PTS           flags2=0x80, hdrlen=5  (no DTS)
```

- **ICS PTS−DTS = 12012** (was 11664 in v1.10.x — that value was wrong; Toast = 12012).
- **decode_time = ceil(w·h/90)** per object, chained. Confirmed against 4 raw cases:
  - 22×22 → ceil(484/90)=6   ✓ (DS1 ODS, delta 6)
  - 16×16 → ceil(256/90)=3   ✓ (DS2 ODS0, delta 3)
  - 16×17 → ceil(272/90)=4   ✓ (DS2 ODS1, delta 4)
  - 79×46 → ceil(3634/90)=41 ✓ (DS2 ODS2, delta 41)
  - **v1.10.16's constant `decode_time=3` was a regression — restore the formula.**
- For our 800×90 buttons: ceil(72000/90)=800 ticks/object. With ≤9 buttons (≤9 objects
  under the new 1-object-per-button model) total ≤7200 < 12012 → END.PTS lands before
  ICS.PTS with margin. The v1.10.15 white-screen was caused by **3 objects per button
  (3N)** plus the broken state model, not the formula itself.

---

## 2. PES marker conventions

Raw PES headers (decoded):

```
ICS DS1:  00 00 01 bd 00 7e 84 c0 0a  31 0007a9bd  01 00074be5
                                  │  │  └PTS(0x3)   └DTS(0x0)
                                  │  └ hdrlen=10
                                  └ flags2=0xC0 (PTS+DTS)
PDS DS1:  00 00 01 bd 05 08 84 80 05  21 00074be5
ODS DS1:  00 00 01 bd 01 07 84 c0 0a  31 00074bf1  01 00074be5
END DS1:  00 00 01 bd 00 0b 84 80 05  21 00074bf1
```

- **DTS marker nibble = 0x0** (DTS byte0 = `0x01` for small DTS), NOT the spec `0x1`
  (`0x11`). Toast writes prefix `0000` where MPEG-2 specifies `0001`. The LG accepts it.
  → Our `encodeDTS` writes `0x11`; v1.10.18 must emit DTS prefix `0x0` for IG PES.
- PTS-with-DTS marker nibble = **0x3** (byte0 = `0x31`) — matches our encoder.
- PTS-only marker nibble = **0x2** (byte0 = `0x21`) — matches our encoder.
- PES flags1 = `0x84` (marker `10`, data_alignment_indicator=1) — matches our encoder.
- CC is **continuous** across every IG PES in the stream (wraps mod 16), spanning both DS.

---

## 3. ICS structural fields (both DS)

```
video: 1920×1080, frame_rate code 0x4 (29.97; ours stays 0x2/24fps — content)
composition_state = 2 (epoch_start)        ← both DS
composition_number = 0 (DS1), 1 (DS2)
sequence_descriptor = 0xC0 (first_in_seq=1, last_in_seq=1)
stream_model = 0 (IN_MUX)     ui_model = 0 (POPUP)
composition_timeout_pts = 0   selection_timeout_pts = 0   user_timeout = 0
num_pages = 1
  page.id=0 version=0 uo_mask=0  in_effects=(0,0) out_effects=(0,0) anim_fr=0
  page.default_selected_button_id_ref  = 0xFFFF   ← NO default selection
  page.default_activated_button_id_ref = 0xFFFF
  page.palette_id_ref = 0
  num_bogs = N  (one BOG per button)
```

### Per-button (the critical state model)

```
BOG k (k=1..N):
  default_valid_button_id_ref = k
  num_buttons = 1
  button:
    id = k                         ← 1-based (v1.10.17 fix retained)
    numeric_select_value = k
    auto_action_flag = 0
    x,y = button position (content)
    neighbor (non-wrapping, ends self-reference):
      upper = max(1, k-1)
      lower = min(N, k+1)
      left  = upper
      right = lower
    normal_state:    start_obj = 0xFFFF, end_obj = 0xFFFF, repeat=0   ← INVISIBLE
    selected_state:  sound=0xFF, start_obj = (k-1), end_obj = (k-1), repeat=0  ← bitmap
    activated_state: sound=0xFF, start_obj = (k-1), end_obj = (k-1)            ← SAME bitmap
    nav_cmds: [content-specific]
```

Toast DS2 neighbor table (confirms the formula):
- btn1: upper=1 lower=2 left=1 right=2
- btn2: upper=1 lower=3 left=1 right=3
- btn3: upper=2 lower=3 left=2 right=3

**Object model: ONE ODS object per button** (object_id = k−1), used for BOTH the
selected and activated states. Normal state is `0xFFFF` (transparent/invisible).
This is the headline change vs. v1.10.0–v1.10.17 which used 3 objects/button and a
visible normal state. Result on hardware: navy background, no buttons visible, until
the user presses an arrow → nearest button's selected bitmap appears.

---

## 4. Navigation commands

Toast uses `SET` + `JUMP_TITLE`, two 12-byte HDMV commands per button:
```
DS2 btn1: 50 40 00 01 00000001 00000001   (SET reg)
          21 80 00 00 00000003 00000000   (JUMP_TITLE 3)
DS2 btn2: 50 40 00 01 00000001 00000002 ; 21 80 ... title 3
DS2 btn3: 50 40 00 01 00000002 00000001 ; 21 80 ... title 1
```
Our disc is **playlist-structured**, not title-structured, so the nav command is
genuinely content-specific. We retain `PLAY_PL(playlistId)` (`0x22800000`). The
structural invariants we match are state model + timing + ordering + markers, not the
nav opcode (which depends on whether the disc routes by title or playlist).

---

## 5. PDS / palette

Toast: 255 entries, palette_id 0, version 0, PTS = ICS.DTS, PTS-only PES.
Ours: 4 entries (transparent / white / orange-selected / blue). Palette content is
design-specific — we keep our 4-entry palette. Only the PES timing (PTS=ICS.DTS) and
segment ordering matter structurally.

---

## 6. ODS sequence flags

All Toast ODS: `sequence_descriptor = 0xC0` (first_in_seq=1 AND last_in_seq=1) —
single-segment objects (small bitmaps fit in one segment). Our 800×90 buttons RLE-
compress to well under the 16-bit segment_length limit, so they also stay single-
segment with seq=0xC0. No fragmented ODS needed.

---

## 7. Implementation delta (what v1.10.18 changes vs v1.10.17)

| Area | v1.10.17 (broken) | v1.10.18 (Toast-template) |
|------|-------------------|---------------------------|
| normal_state obj | visible (obj 3k) | **0xFFFF (invisible)** |
| objects per button | 3 (norm/sel/act) | **1 (sel=act, id=k−1)** |
| defaultSelectedButtonIdRef | 1 | **0xFFFF** |
| WDS segment | present | **absent** |
| neighbor model | circular wrap | **non-wrap, ends self-ref** |
| left/right | self | **left=upper, right=lower** |
| ODS decode_time | constant 3 | **ceil(w·h/90), chained** |
| ICS PTS−DTS | 11664 | **12012** |
| DTS marker nibble | 0x1 (0x11) | **0x0 (0x01)** |
| display sets | 1 | **2 (both epoch_start, comp# 0,1)** |
| END.PTS | last ODS PTS | last ODS PTS (unchanged) |
| segment order | ICS PDS WDS ODS END | **ICS PDS ODS… END** |

Content-specific (parameterized, unchanged): button bitmaps, positions, labels,
nav commands (PLAY_PL), playlist refs, button count, palette entries.
