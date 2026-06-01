# Changelog

## v1.10.18 — 2026-05-31

**Toast-template structural rewrite — IG menu matches BD-ROM Interactive Graphics
conventions observed across commercial authoring tools**

After 11 hardware iterations (v1.10.0–v1.10.17) of single-field spec fixes — none of
which produced visible buttons on the LG BP350 — this release abandons incremental
tuning and clones the full structural model that commercial BD-ROM authoring pipelines
emit for in-mux interactive menus, parameterized only by what is genuinely content-
specific to our disc (button bitmaps, positions, labels, navigation commands, playlist
references, button count). The byte-level forensic derivation is in
`docs/v11018_toast_template_spec.md`.

### Root cause of the 11-iteration failure

Every prior version used a "buttons always visible, one highlighted" state model. The
commercial convention that standalone hardware players reliably render is the opposite:

- **`normal_state` object = `0xFFFF` (invisible).** A button draws nothing in its
  resting state.
- **`page.default_selected_button_id_ref` = `0xFFFF` (no default selection).** The menu
  opens to a bare background; the first arrow-key press selects (and reveals) the
  nearest button. This is the intended UX and matches how commercial standalone-player
  menus typically behave.
- **One bitmap object per button**, used for *both* the selected and activated state
  (we previously emitted three objects per button).

### Other structural corrections (all confirmed against the reference disc)

- **Removed the WDS segment.** Segment order is now `ICS → PDS → ODS… → END`; button
  positions and object sizes fully define the rendered regions.
- **Restored ODS decode budget `ceil(w·h/90)`**, chained `ODS[0].DTS = ICS.DTS`,
  `ODS[i].DTS = ODS[i-1].PTS`. v1.10.16 had flattened this to a constant 3 ticks; the
  reference disc uses the area formula (verified: 22×22→6, 16×16→3, 16×17→4, 79×46→41).
- **ICS PTS−DTS lead corrected 11664 → 12012** (= 4 × 3003).
- **IG PES DTS leading nibble 0x1 → 0x0** (the marker convention the reference emits).
- **Two `epoch_start` display sets per menu** (composition_number 0 and 1); the
  continuity counter runs continuously across both with no demuxer discontinuity.

### Implementation

- `src/lib/ig-encoder.js`: backward-compatible parameterization — `encodeDTS(dts,
  markerHigh)`, `wrapInPES(…, dtsMarker)`, and `buildIGDisplaySet({… icsDtsLead,
  odsDecodeMode, dtsMarker, startCC})`; WDS is emitted only when windows are supplied.
  Defaults preserve prior behavior, so the existing encoder-primitive tests are
  unchanged.
- `src/lib/menu-builder.js`: `buildMenuDisplaySet` rewritten to the new state model and
  two-display-set emission (signature unchanged).

### Validation

- 208 unit tests pass (184 IG-encoder incl. new Toast-template structure suite + 24
  video-PES-DTS). The two obsolete `defaultSelectedButtonIdRef = 1` assertions from
  v1.10.17 were updated to `0xFFFF`.
- Wire-level: extracted `00099.m2ts` shows two display sets, no WDS, DTS nibble 0x0,
  ICS lead 12012, chained ODS, PMT declares IG (type 0x91 @ PID 0x1400).
- libbluray `bd_info`/`bd_list_titles` clean (2 HDMV titles; 00099.mpls declares IG:1).
- Structural diff vs the reference disc: display-set count, WDS absence, ICS lead, and
  DTS marker all match.
- ISO at `~/Desktop/v11018_test.iso` (hardware test on the LG BP350 pending).

The v1.11.0 autoplay-default code path is untouched; menus remain opt-in beta.

## v1.10.17 — 2026-05-31

**Root-cause hardware fix — button_id 1-based (BD spec §5.7.4: valid range [1, 0xEFFF])**

All 10 prior menu iterations (v1.10.0–v1.10.16) produced button_id=0 for the first
button. BD spec mandates button_id ∈ [1, 0xEFFF]; value 0 is reserved. LG BP350 (and
likely other hardware players) silently discard the Interactive Composition page when
defaultSelectedButtonIdRef=0 cannot resolve to a valid button, producing navy background
with no buttons visible across every test burn.

### Root cause

`buildMenuDisplaySet` in `src/lib/menu-builder.js` used 0-based loop indices directly
as button IDs (`id: i`), yielding button IDs 0 and 1 for a 2-episode disc. The first
BOG's defaultValidButtonIdRef and the page's defaultSelectedButtonIdRef were both 0,
referencing the reserved/invalid button ID.

### Fix

Seven field assignments in `src/lib/menu-builder.js` shifted from `i` to `i + 1`:
- `button_id`: `i` → `i + 1`
- `defaultValidButtonIdRef`: `i` → `i + 1`
- Neighbor refs `upper/lower/left/right`: `(i±1+N)%N` → `((i±1+N)%N) + 1`, `i` → `i + 1`
- Page `defaultSelectedButtonIdRef`: `0` → `1`

Object IDs remain 0-based (Toast reference also uses object_id=0; only button IDs are spec-constrained to ≥ 1).

### Verification

Forensic comparison vs Toast reference (My Movie.iso, confirmed working on LG BP350):
- Toast button IDs: 1, 2, 3 — our new IDs: 1, 2 ✓
- Toast defSelBtn: 0xFFFF — our new value: 1 (equivalent for 1-based layout) ✓
- Toast defValidBtn: 1 — our new BOG0 value: 1 ✓

Tests: 163 passed (151 timing + 12 new button_id assertions).
ISO: `~/Desktop/v11017_test.iso`

## v1.10.16 — 2026-05-31

**Hardware IG fix — constant ODS decode_time=3 (LG white-screen regression from v1.10.15)**

v1.10.15 introduced the correct DTS chaining structure but used `decode_time = ceil(w×h/90)`,
which produced 800 ticks per ODS for our 800×90 buttons. With 6 ODS, total ODS.PTS overshoot
above ICS.DTS was 4800 ticks (53ms) — LG BP350 rejected the disc at load time (white screen).

### Root cause

LG BP350 enforces a hardware tolerance for how far ODS.PTS may overshoot ICS.DTS. Toast's
confirmed-working discs use tiny decode_times (3–41 ticks). Our formula produced 800 ticks per
ODS because our buttons are large (800×90 px = 72,000 pixels → ceil(72000/90) = 800).

### Fix

`buildIGDisplaySet` in `src/lib/ig-encoder.js`:

Replaced `decode_time = Math.max(1, Math.ceil(w * h / 90))` with constant `decode_time = 3`:

- `3` is Toast's empirical minimum (confirmed: 16×16 ODS uses decode_time=3)
- For 6 ODS: total overshoot = 18 ticks — well inside Toast's empirical max of 41 ticks
- DTS chaining pipeline structure unchanged from v1.10.15:
  - `ODS[0].DTS = ICS.DTS`
  - `ODS[i].DTS = ODS[i-1].PTS` (chained)
  - `ODS[i].PTS = ODS[i].DTS + 3` (constant, not size-dependent)
  - `END.PTS = ODS[last].PTS = ICS.DTS + 3 × N`

### Verification

| Metric | Toast (empirical) | v1.10.15 | v1.10.16 |
|--------|-------------------|----------|----------|
| decode_time per ODS | 3–41 ticks | 800 ticks ✗ | **3 ticks ✓** |
| Total overshoot (6 ODS) | ≤ 41 ticks | 4800 ticks ✗ | **18 ticks ✓** |
| LG BP350 result | ✓ buttons | ✗ white screen | TBD (ISO ready) |

Tests: 151 passed (ig-encoder.test.js) + 24 passed (rewrite-video-pes-dts.test.js) = 175 total.
ISO: `~/Desktop/v11016_test.iso`

## v1.10.15 — 2026-05-22

**Hardware IG fix — ODS DTS decode pipeline + END timing (confirmed vs Toast hardware reference)**

Root cause of LG BP350 and Xbox showing no buttons on IG menus across all v1.10.x versions.
The ODS segments lacked DTS, preventing hardware T-STD schedulers from timing object decodes.

### Root cause

BD-ROM hardware IG controllers use ODS.DTS to schedule when each object is decoded into the
object plane buffer. Without DTS (flags2=0x80, PTS-only), the hardware cannot schedule the
decode and silently skips object rendering — producing the "navy background, no buttons" symptom
observed on LG BP350 and Xbox since v1.10.0.

Software players (libbluray) do not implement T-STD object timing — they decode all available
objects into a cache regardless of DTS. This explains why buttons rendered in software but not
on hardware across all eight prior fix iterations (v1.10.7–v1.10.14).

### Fix

`buildIGDisplaySet` in `src/lib/ig-encoder.js`:

1. **ODS DTS chained pipeline** (confirmed from Toast raw bytes, proven on LG BP350):
   - `ODS[0].DTS = ICS.DTS` (= `ics_pts − 11664`)
   - `ODS[i].DTS = ODS[i-1].PTS` (chained)
   - `ODS[i].PTS = ODS[i].DTS + ceil(w × h / 90)` (decode_time at 90kHz)
   - `ODS flags2 = 0xC0` (PTS+DTS, 10-byte header)

2. **END.PTS = last ODS PTS** (was `ICS.PTS` in v1.10.14, which was wrong):
   - `END.PTS = last ODS PTS` (= `ICS.DTS + sum(decode_times)`)
   - Toast confirmed: `END.PTS − last_ODS.PTS = 0`

3. **CC tracking updated**: `pesHdrSize = 19` for ODS (PTS+DTS); result: 0 CC issues.

### Verification

Toast hardware reference (proven on LG BP350) vs our v1.10.14 vs v1.10.15:

| Segment | Toast | v1.10.14 | v1.10.15 |
|---------|-------|----------|----------|
| ICS flags2 | 0xC0 | 0xC0 ✓ | 0xC0 ✓ |
| ICS DTS | ICS_DTS | ICS_DTS ✓ | ICS_DTS ✓ |
| PDS PTS | ICS_DTS | ICS_DTS ✓ | ICS_DTS ✓ |
| ODS flags2 | **0xC0** | **0x80 ✗** | **0xC0 ✓ fixed** |
| ODS[0] DTS | ICS_DTS | None ✗ | ICS_DTS ✓ fixed |
| ODS[i] DTS | ODS[i-1].PTS | None ✗ | ODS[i-1].PTS ✓ fixed |
| END.PTS | last ODS PTS | ICS.PTS ✗ | last ODS PTS ✓ fixed |

decode_time formula `ceil(w×h/90)` verified against 4 Toast ODS cases:
22×22→6 ✓, 16×16→3 ✓, 16×17→4 ✓, 79×46→41 ✓

Tests: 149 passed (ig-encoder.test.js) + 24 passed (rewrite-video-pes-dts.test.js).
ISO: `~/Desktop/v11015_test.iso`

## v1.10.14 — 2026-05-21

**Hardware IG fix — PDS/WDS/ODS PES PTS = ICS DTS (presentation clock gating)**

Root cause of LG BP350 and Xbox showing no buttons on IG menus while software
(libbluray/VLC) rendered correctly.

### Root cause

BD-ROM hardware IG controllers are PTS-gated: they only decode a segment when
the player's presentation clock reaches that segment's PTS. The ICS composition
phase fires at `ICS.DTS` (decode deadline, ~130ms before `ICS.PTS`). Supporting
segments (PDS/WDS/ODS) must have `PTS ≤ ICS.DTS` so palette and objects are
decoded before composition begins.

Our v1.10.13 disc had `PDS/WDS/ODS PTS = ICS.PTS = 54000000`. Hardware started
composing at `ICS.DTS = 53988336` and found no decoded objects — silently
discarded the display set. Clannad reference: `PDS PTS = 53988336 = ICS.DTS`.

### Fix

- `PDS/WDS/ODS PES PTS` changed from `ics_pts` → `ics_dts` in `buildIGDisplaySet`
- `ICS PES`: unchanged — `PTS = ics_pts`, `DTS = ics_dts`
- `END PES PTS`: unchanged — kept at `ics_pts` (Clannad's END > ics_pts; ours at
  ics_pts is correct for our smaller ODS pipeline)
- `ics_dts = max(0, ics_pts − 11664)` — 11664 ticks ≈ 129.6ms (existing formula)

### Verification

Confirmed against Clannad 00005.m2ts per-segment PTS/DTS extraction:

| Segment | Clannad PTS  | Our v1.10.13 PTS | Our v1.10.14 PTS | Correct |
|---------|-------------|-----------------|-----------------|---------|
| ICS     | 54000000    | 54000000        | 54000000        | ✓       |
| PDS     | 53988336    | **54000000**    | 53988336        | ✓ fixed |
| WDS     | (absent)    | **54000000**    | 53988336        | ✓ fixed |
| ODS     | 53989053+   | **54000000**    | 53988336        | ✓ fixed |
| END     | 54014013    | 54000000        | 54000000        | ✓       |

138 ig-encoder tests + 24 video-PES-DTS tests pass (162 total).
New test: section 14 asserts PDS/WDS/ODS PTS = ics_dts, END PTS = ics_pts.

---

## v1.11.0 — 2026-05-21

**Autoplay-only default; menus promoted to beta opt-in**

Discs now build without menus by default for maximum hardware compatibility.
Menus are available as an opt-in beta, gated by a new toggle in Project Settings.

### Changes

- **Autoplay-only is the new default**: menus are OFF by default. Discs build as
  clean autoplay titles that work reliably across all tested hardware players.
- **Menus available as beta opt-in**: enable "Menus (Beta — may not work on all players)"
  in Project Settings → Video Format to access the full menu builder (Menu tab) and
  the interactive episode menu (IG) option. Known compatibility issues on some hardware
  remain; use for testing only until further notice.
- **All v1.10.x menu fixes preserved**: the complete IG encoder fix history
  (v1.10.2–v1.10.11) is intact on the beta menu path — nothing was removed.
- **Menu tab hidden when menus are disabled**: re-enable the toggle to restore access
  to theme, typography, and preview controls.
- **`menusEnabled` flag added to build pipeline** (`build-multi-title-disc` IPC handler):
  `addMenuToDisc()` is now gated by both `useIGMenu` and `menusEnabled`.
- **v1.10.12 CC session** will continue menu fix work in parallel on the beta path.

---

## v1.10.11 — 2026-05-21

**Toast reference disc audit — three m2ts arrival timestamp / sound ID bugs fixed**

Ground truth: Toast-authored 2-button BD-ROM menu confirmed to render on consumer hardware.
Field-by-field comparison logged to `/tmp/v11010_audit_findings.md`. All ICS/ODS/PDS/WDS
structure fields matched; bugs were in the m2ts encapsulation layer.

### BUG-1 — CRITICAL: Non-monotonic IG arrival timestamps (T-STD violation)

- **Symptom**: LG BP350 discards all IG packets (timestamps appear to be "in the past").
  Despite correct ICS/ODS/PDS structure, no buttons rendered on hardware.
- **Root cause**: `injectIGIntoM2ts` called `convertTsBdFormat(igTs188)` with the default
  `baseTimestamp=0`. Video packets surrounding the IG block have arrival timestamps of ~80M
  (27MHz ticks). Injecting IG with arrivals 0→11,700 into that context violates the
  BD T-STD requirement for monotonically increasing arrival timestamps.
- **Fix**: `injectIGIntoM2ts` now reads the arrival timestamp of the last video packet before
  the insertion point and passes `beforeArr + 300` as `baseTimestamp` to `convertTsBdFormat`.
  IG packets now arrive in the range `(beforeArr+300) … (beforeArr + N×300)`, seamlessly
  interleaved between surrounding video packets.

### BUG-2 — CRITICAL: copy_permission_indicator = 2 ("copy once") on all IG packets

- **Symptom**: Some hardware enforces BD copy protection at the IG overlay output stage;
  "copy once" packets may be blocked from display. Video packets have copy_permission=0.
- **Root cause**: `convertTsBdFormat` wrote `((ts & 0x3FFFFFFF) | 0x80000000) >>> 0`.
  The `| 0x80000000` unconditionally sets bits[31:30] of the BD 4-byte header to `10`
  ("copy once"). Toast reference packets all have bits[31:30] = `00` (no restriction).
- **Fix**: `(ts & 0x3FFFFFFF) >>> 0` — bits[31:30] are now always 0.

### BUG-3 — POSSIBLE: selectedSoundId/activatedSoundId = 0x00 with no Sound.bdmv

- **Symptom**: Hardware may attempt to load Sound.bdmv for sound ID 0, fail, and
  invalidate the button or skip rendering it. Toast reference uses 0xFF (no sound) on
  all buttons; Clannad reference also uses 0xFF.
- **Root cause**: `buildMenuDisplaySet` set `selectedSoundId: 0, activatedSoundId: 0`.
  `encodeButton` defaulted missing fields to `|| 0` (falsy coercion) instead of `?? 0xFF`.
- **Fix**: `buildMenuDisplaySet` now passes `0xFF`; `encodeButton` uses `?? 0xFF` for both
  sound ID fields. Explicit `0` is still respected when passed intentionally.

107 unit tests pass (was 97, +10 new tests for all three fixes).

---

## v1.10.10 — 2026-05-20

**Clannad reference disc audit — three PES/ICS encoder bugs fixed**

Ground truth: unencrypted HDMV InMux reference disc (Clannad Standard Edition)
byte-compared against our encoder output. Reference: `reference_clannad/ig_extract.bin` (939KB,
1 ICS + 14 PDS + 205 ODS). Audit findings logged to `/tmp/clannad_audit_findings.md`.

### BUG-2 — CRITICAL: ICS PES missing DTS (flags 0x80 → 0xC0, hdr_len 5 → 10)

- **Symptom**: No IG buttons rendered on hardware. Hardware IG controllers require a DTS in the
  ICS PES to schedule pre-buffered loading of ODS/PDS before the composition display time.
  Without DTS the controller likely skips the composition entirely.
- **Root cause**: `wrapInPES()` always wrote `flags2=0x80` (PTS only) for every segment including
  ICS. Clannad reference shows ICS PES has `flags2=0xC0` (PTS+DTS, hdr_len=10) while PDS/ODS
  use `flags2=0x80` (PTS only, hdr_len=5).
- **Fix**: `wrapInPES(segData, pid, pts, startCC, dts=null)` — pass `dts` for ICS only.
  `buildIGDisplaySet` computes `icsDts = max(0, pts - 11664)` (matching Clannad's 130ms
  buffering window). All other segments remain PTS-only.

### BUG-1 — HIGH: Wrong frame_rate_code in ICS VideoDescriptor (0x40 → 0x20)

- **Symptom**: ICS declared 29.97fps for a 24fps clip. Hardware players validating
  VideoDescriptor against the actual clip attributes may silently reject the ICS.
- **Root cause**: `buildMenuDisplaySet` passed `frameRate: 0x40`. The high nibble of the
  VideoDescriptor frame-rate byte is the BD frame_rate_code; 0x40 → code 4 → 29.97fps.
  For our 24fps video (tsMuxeR `fps=24`) the correct value is code 2 → byte 0x20.
  The JSDoc comment also had the mapping backwards.
- **Fix**: `frameRate: 0x40` → `frameRate: 0x20` in `buildMenuDisplaySet`. Updated comment.

### BUG-3 — MEDIUM: Wrong PTS leading nibble for PTS-only PES encoding (0x31 → 0x21)

- **Symptom**: All PES used 0x31 (marker '0011' = PTS+DTS-present), even PTS-only segments.
  Strict hardware parsers may reject PES with inconsistent PTS_DTS_flags vs marker byte.
- **Root cause**: `encodePTS()` always used base `0x31`. MPEG-2 spec: PTS-only PES requires
  '0010' (0x21), PTS-with-DTS requires '0011' (0x31), DTS field requires '0001' (0x11).
  Clannad confirmed: PDS PES byte[0]=0x21, ICS PES PTS byte[0]=0x31, DTS byte[0]=0x11.
- **Fix**: `encodePTS(pts, withDts=false)` — default produces 0x21 prefix. New `encodeDTS(dts)`
  produces 0x11 prefix. Both exported.

Phase A (PCR PID): No action — our `--no-pcr-on-video-pid` tsMuxeR flag already produces
a dedicated PCR PID (0x1001) matching Clannad. `patchPmtForIG` preserves it.

Phase C/D (PDS/ODS): No bugs found. Encoding matches reference format exactly.

97 unit tests pass (was 81, +16 new tests for all three fixes).

---

## v1.10.9 — 2026-05-20 *(SUPERSEDED — v1.10.10 contains further fixes)*

## v1.10.8 — 2026-05-20

**Full IG byte audit via libbluray source validation — two critical ICS encoder bugs found and fixed**

Ground truth: libbluray `src/libbluray/decoders/ig_decode.c` + `pg_decode.c` compared byte-for-byte
against binary extracted from v1.10.7 disc (PID 0x1400 from 00099.m2ts). Both bugs independently
confirmed in the binary. 81 unit tests pass (up from 72).

### Bug 1 — CRITICAL: Spurious byte causes `num_pages = 0` (all buttons silently lost)

- **Symptom**: LG + Xbox — navy background renders, zero IG buttons, direction keys ignored.
- **Root cause**: `encodeICS()` inserted a spurious `0x00` byte between `user_timeout_duration`
  and `num_pages`, labeled "number_of_composition_objects". This field does NOT exist at the
  `interactive_composition()` level in the BD spec or in libbluray `_decode_interactive_composition`
  (ig_decode.c lines 296–308). The function reads `user_timeout_duration(3)` then DIRECTLY
  `num_pages(1)`. The spurious byte was read as `num_pages = 0` → zero pages → zero buttons.
  `number_of_composition_objects` is a field inside `effect_info()` (inside `in_effects`/`out_effects`
  per page), NOT inside `interactive_composition()` directly.
- **Binary proof**: v1.10.7 ICS bytes [19]=0x00 (spurious), [20]=0x01 (actual pages.length, never read).
- **Fix**: Removed the `icParts.push(Buffer.from([0x00]))` line from `encodeICS()`.

### Bug 2 — CRITICAL: stream_model = 1 (OutMux) for an in-mux disc

- **Symptom**: Hardware looks for IG composition objects in a SubPath that does not exist.
- **Root cause**: `menu-builder.js` called `encodeICS()` with `streamModel: true`, which writes
  interaction_model byte bit7=1 (stream_model=1 = Non-Multiplexed / OutMux). Our disc has the IG
  stream at PID 0x1400 embedded IN the main clip (00099.m2ts) — that is Multiplexed (InMux). For
  OutMux, hardware expects IG composition objects in a separate SubPath clip; ours has none.
  v1.10.6 introduced this by looking at the Beach Boys reference disc (which uses a SubPath) and
  copying its stream_model=1 without realising that disc uses OutMux architecture.
- **Fix**: Changed to `streamModel: false` → bit=0 → stream_model=0 (Multiplexed/InMux).
- **Related fix**: With stream_model=0 (InMux), the ICS 10-byte timeout block is written.
  `composition_timeout_pts` now receives the actual video PTS (from `extractFirstVideoPTS`),
  ensuring hardware doesn't discard the composition as expired (pts=0 < video PTS ≈ 54,000,000).

### Tests
- Phase 5 rewritten: tests Multiplexed vs Non-Multiplexed bit, composition_timeout_pts encoding.
- Phase 6 rewritten: asserts num_pages immediately follows user_timeout_duration at correct offsets.

---

## v1.10.7 — 2026-05-20 *(SUPERSEDED — v1.10.8 reverts and corrects the ICS byte change)*

**ICS number_of_composition_objects field fix (missing byte caused zero-button parse on hardware)**

### Bug — CRITICAL: missing number_of_composition_objects byte in InteractiveComposition

- **Symptom**: hardware BD player — IG menu not rendered, zero buttons, direction keys ignored.
  Menu background may load but no interactive elements appear.
- **Root cause**: `encodeICS()` in `src/lib/ig-encoder.js` was missing the 1-byte
  `number_of_composition_objects` field that the BD spec requires between `user_timeout_duration`
  and `number_of_pages` in the InteractiveComposition structure (per `ig_decode.c`).
  Decoders read the missing byte as `num_composition_objects`, then consumed 8 bytes of page
  data as a fake composition_object descriptor. The next byte read was `uo_mask[6] = 0x00`,
  which was interpreted as `num_pages = 0`. Zero pages → zero buttons → invisible menu.
- **Fix**: added `icParts.push(Buffer.from([0x00]))` between `user_timeout_duration` and
  `num_pages` in `encodeICS()`. Value 0x00 means no composition objects (the standard case).
- **ICS byte delta**: ICS segments are now 1 byte longer (142 bytes, was 141).
- **Verified**: mounted v1107_test.iso, parsed 00099.m2ts — ICS[19]=0x00 (num_composition_objects),
  ICS[20]=0x01 (num_pages=1), total ICS=142 bytes. All 72 unit tests pass.

## v1.10.6 — 2026-05-20

**ICS InMux stream_model fix + MPLS still_mode fix (confirmed against hardware-verified reference disc)**

Root cause methodology: byte-level structural comparison of v1.10.5 ISO against Beach Boys 50 Live
(2012, Eagle Rock Entertainment) — a hardware-verified HDMV IG disc confirmed working on LG BD player.

### Bug 1 — CRITICAL: ICS stream_model=OutOfMux with composition_timeout_pts=0

- **Symptom**: hardware BD player (LG tested) — menu background visible, IG buttons not rendered,
  direction keys silently ignored. Identical to v1.10.5 symptom (which fixed PMT; this fixes ICS).
- **Root cause**: `encodeICS()` was called with `streamModel: false` (OutOfMux mode). In OutOfMux
  mode the ICS interaction_model byte has bit7=0, and the encoder appends 10 zero bytes for
  `composition_timeout_pts` (5 bytes) and `selection_timeout_pts` (5 bytes). Both timeouts = 0
  means the composition expired at PTS=0. Since video PTS starts at 54,000,000 ticks (600 s at
  90 kHz), the hardware treats the composition as already expired on first decode and silently
  discards the entire IG overlay.
- **Fix**: `buildMenuDisplaySet()` now calls `encodeICS()` with `streamModel: true` (InMux).
  In InMux mode bit7=1, the 10 timeout bytes are absent, and timing is derived from PES PTS alone.
- **Reference disc**: Beach Boys 50 Live 00003.m2ts ICS — interaction_model byte bit7=1 (InMux).
- **Byte delta**: ICS segments are now 10 bytes shorter (no timeout fields). `patchPmtForIG` and
  `patchClpiForIG` are unaffected (stream_type/PID unchanged).

### Bug 2 — LIKELY: MPLS still_mode=0x00 (no-still) instead of 0x01 (infinite-still)

- **Root cause**: `patchMplsForStill()` in v1.10.4 wrote `(0x02 << 5)` into bits 6-5 of byte
  `piOff+30`. The BD-ROM spec PlayItem layout is:
  - `[30]`: `random_access_flag`(bit7) + reserved(bits6-0)
  - `[31]`: `still_mode` — 0x00=no-still, 0x01=infinite-still, 0x02=timed-still
  - `[32-33]`: `still_time` (only meaningful for still_mode=0x02)
  The v1.10.4 code wrote to reserved bits of byte[30] (0x40 observed in v1.10.5 MPLS) and left
  byte[31]=0x00 (no-still). With no-still, the menu clip plays once and ends; it does not hold
  the last frame for user interaction.
- **Fix**: `patchMplsForStill()` now writes:
  - `byte[30]`: `newBuf[piOff+30] & 0x80` — preserves only RAF bit, clears reserved bits
  - `byte[31]`: `0x01` — infinite-still
  - `byte[32-33]`: `0x0000` — still_time=0 (N/A for infinite-still)
- **Reference disc**: Beach Boys 50 Live 00001.mpls PlayItem byte[31]=0x01 (infinite-still).

### Test coverage

- 8 new unit tests added in `tests/ig-encoder.test.js` (Phase 5a: 5 tests, Phase 5b: 3 tests).
- Total: 67/67 tests passing.
- Phase 5a verifies ICS byte[15] bit7=1 for InMux, =0 for OutOfMux, and that InMux ICS is exactly
  10 bytes shorter than OutOfMux ICS.
- Phase 5b verifies patchMplsForStill writes byte[31]=0x01, byte[32-33]=0x0000, byte[30] reserved
  bits=0.

---

## v1.10.5 — 2026-05-20

**PMT IG stream declaration fix (hardware demuxer routing)**

- Hardware BD players (LG tested): disc loaded, navy menu background played, but IG buttons were
  not rendered and direction/Menu keys had no effect — root cause: the in-stream PMT declared only
  the video stream (PID 0x1011). Hardware demuxers use the PMT, not CLPI/MPLS, to route PES
  packets to the IG decoder; without the PMT entry the IG packets were silently dropped.
- Added `patchPmtForIG(m2tsBuf)` in `src/lib/menu-builder.js`: parses PAT to find the PMT PID,
  locates the PMT packet, appends a 5-byte ES entry `stream_type=0x91 PID=0x1400`, updates
  `section_length`, and rewrites the MPEG-2 CRC_32 (polynomial 0x04C11DB7). Idempotent.
- Applied in `addMenuToDisc` after `injectIGIntoM2ts`, before writing 00099.m2ts to disc.
- Safety: throws if patched section_length + 4 > 184 (would not fit in one TS packet payload).
- PMT before: `stream_type=0x1B PID=0x1011` (H.264 video only)
- PMT after:  `stream_type=0x1B PID=0x1011` + `stream_type=0x91 PID=0x1400` (HDMV IG added)
- CRC_32 verified: 0xd5bcec80 (computed and stored match)

---

## v1.10.4 — 2026-05-20

**patchMplsForStill off-by-one fix**

- `still_mode` field (bits 6-5) was written to byte `piOff+31` instead of the correct `piOff+30`
- Fixed: `newBuf[piOff + 30] = (newBuf[piOff + 30] & 0x9F) | (0x02 << 5)`
- Also: Retina 2x scale support in `verify_menu_buttons.py` (ROI coords scaled, pixel counts
  normalised back to 1x area so thresholds remain scale-independent)

---

## v1.10.3 — 2026-05-19

**Two-clip preload strategy for IG menu (VLC vout timing fix)**

- 00098.mpls: 1s preload clip (no IG) — plays first to initialize VLC vout before menu fires
- 00099.mpls: 5s menu clip (with IG, still_mode=2) — GC fires with vout already ready, buttons visible
- MovieObject obj[2] now chains: PLAY_PL(98) → PLAY_PL(99) → JUMP_OBJECT(2)
- still_mode=2 on 00099 provides persistent menu on hardware BD players
- Root cause identified: VLC macOS calls `blurayReleaseVout` during every clip transition via BD_EVENT_PLAYITEM_CHANGE; disc structure and IG rendering confirmed correct via libbluray GC debug log

---

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
