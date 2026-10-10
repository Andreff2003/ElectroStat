# ElectroStat_Firmware

ESP32-S3 + AD5941 firmware that talks to `bridge.py` (in `--mode wifi`)
so ElectroStat can run against real HELPStat hardware instead of only
the simulator.

## Status (honest, as of this file)

| Technique | Status |
|---|---|
| EIS | Implemented. Reuses the AD5941 driver from the LinnesLab HELPStat library. **Not yet tested against real hardware** — written against that library's own demo sketch and source, not verified on a board. |
| CV | Implemented as new code — HELPStat had no CV to reuse. **Not yet tested against real hardware.** Applied-potential range limited to roughly ±1.1 V (see Known gaps). |
| BioFET (`start_fet`) | Implemented, on the same amperometric primitive as CV. **Not yet tested against real hardware.** See "BioFET on real hardware" below for how baseline vs analyte is decided. |
| SWV (`start_swv`) | Implemented, on the same primitive — square wave on a staircase ramp, forward and reverse pulse each sampled at the end of its half-period. **Not yet tested against real hardware**; the settling time assumed after each potential step (`kSettleUs`) is a guess, to be set with a scope. |

All four techniques are now implemented. **None of them have been run
against real hardware yet** — do not treat any of this as validated
just because it's written. The first real test with hardware in hand
will very likely surface bugs (wrong gain-table thresholds, timing
issues, wiring assumptions). That is normal for a first pass with no
hardware to test against, not a sign anything here is broken.

## Where the AD5941 driver code came from

`ad5940.c`, `ad5940.h`, `Impedance.c`, `Impedance.h`, `ad594x.cpp`,
`lma.cpp`, `lma.h`, `constants.h`, `HELPStat.cpp`, `HELPStat.h` are
vendored **unmodified** from the original HELPStat project:
https://github.com/LinnesLab/HELPStat (MIT licensed) — this is the
same hardware/library the ElectroStat thesis describes as the
starting point.

The changes made to that code are in `HELPStat.h`/`HELPStat.cpp`,
clearly marked with `ElectroStat addition` comments. Everything else in
those two files is untouched — if you ever want to diff against
upstream, only these additions were made:
- `setEisPointCallback()` — a small optional callback so each EIS point
  can be streamed out as soon as it's measured, instead of only being
  readable from the library's internal array after the whole sweep
  finishes.
- `AD5940_AmperometrySetup()` / `AD5940_AmperometryStep()` — a "apply a
  DC bias, read the resulting current" primitive used by both CV and
  BioFET. This is **new** code, not a reuse of an existing proven HELPStat
  function like the EIS path is: the library's own DC-reading helpers
  (`pollADC`/`getADCVolt`) turned out to be incomplete upstream
  (`getADCVolt` never returns its computed value; `pollADC` reads a
  different ADC filter stage than the one it configures an interrupt
  for) — so these were written fresh, modelled on the one DC-reading
  sequence in the library that *is* internally consistent
  (`ADCNoiseTest()`'s ADC-read loop), not on the broken helpers.

`ElectroStat_Firmware.ino` is new — it did not exist anywhere before
this. It adds:
- WiFi access-point mode (ESP32 creates its own network, so `bridge.py`
  connects to it — no router/existing WiFi needed).
- A plain TCP server on port 82, speaking the same JSON-per-line
  protocol `bridge.py` already expects (see the big comment block at
  the top of `bridge.py`).
- Command handling for `start_eis` / `start_cv` / `start_fet` /
  `start_swv` / `stop`.

## Setup

1. Arduino IDE, board package **esp32 by Espressif Systems** installed,
   board set to your specific ESP32-S3 variant.
2. Library Manager → install **ArduinoJson** by Benoit Blanchon,
   **version 7.x** specifically (the code uses the v7 `JsonDocument`
   API; v6 needs different syntax and won't compile as-is).
3. Open `ElectroStat_Firmware.ino` (all the other files in this folder
   compile automatically alongside it — that's how Arduino sketch
   folders work, no separate library install needed for them).
4. Flash it. Open the Serial Monitor at 115200 baud — it prints the AP
   SSID/IP and confirms the TCP server started.
5. On your computer, connect to the WiFi network `ElectroStat-ESP32`
   (password `electrostat` — change both in the `.ino` if you want).
6. Run:
   ```
   python bridge.py --mode wifi --esp-ip 192.168.4.1 --esp-port 82
   ```
7. Open the ElectroStat web app, set Data Source to Live, and try an
   EIS sweep.

## BioFET on real hardware — how baseline vs analyte is decided

The app's `start_fet` protocol expects `fet_transfer` points labelled
`"baseline"` or `"analyte"`. The simulator produces both from one
command because it's just math; real hardware can't — a baseline and
an analyte reading are two separate sweeps of the same electrode,
before/after a manual reagent addition, with a real wait in between.

**Decision**: no new protocol field. Each `start_fet` command runs one
sweep, and the firmware labels it from the `concentration` value
already carried in that same command — `<= 0` → `"baseline"`, `> 0` →
`"analyte"`. Workflow: run once with concentration 0 before adding the
analyte, add it, change the concentration field in the app to the real
value, run again. Compare the two resulting logbook entries with the
app's existing **Overlay** view — same as how simulated baseline/
analyte curves are already compared today, no app changes needed.

The one accepted trade-off: this produces two separate logbook entries
per real measurement (one baseline-only, one analyte-only) instead of
the single combined entry a simulated run produces. That's fine per
our discussion — Overlay is how you'd compare them either way.

## Known gaps / next steps

- **CV's applied-potential range is limited to roughly ±1.1 V**, set by
  the LPDAC bias path `AD5940_AmperometryStep()` uses (same range the
  original library's own bias code supports). A CV sweep asking for
  more than that will clip at the extremes; the firmware logs a
  warning to Serial when a sweep's vertices exceed it, it doesn't fail
  silently.
- **Real-time sweeps (CV, BioFET, SWV).** Each potential step owns a
  slot that starts at `t0 + k * period`, computed from the start of the
  sweep, so the time spent measuring and sending cannot make the scan
  slower. The potential is applied when the slot opens and the current
  is read so that the ADC conversion ends at the end of the slot (SWV:
  at the end of each half-pulse). Points are queued and sent while the
  loop waits for the next slot, never inside it. Timestamps (`t`,
  `time`) are real, not nominal. Before a sweep the firmware reads the
  ADC three times to measure how long a read takes on this board, and
  **refuses** a scan rate, SWV frequency or `intervalMs` that cannot fit
  (`cv_error` / `swv_error` / `fet_error`, naming the limit) instead of
  running slower than asked. With the guessed 5 ms settling and an ADC
  read of a few milliseconds, this is roughly 200 mV/s at a 2 mV step
  and roughly 50 Hz for SWV; both limits move when the read time and
  `kSettleUs` are measured. Each `*_done` message
  reports `lateCount`, `maxLagUs` and the achieved scan rate or
  frequency, so a sweep that could not keep its schedule says so. The
  arithmetic is in `ElectroStat_Timing.h` and is tested on a PC
  (`firmware/test`), which does not replace measuring on the board.
- **`stop` interrupts CV, BioFET and SWV between points** (it is
  checked every 2 ms while waiting) and the sweep reports idle after
  delivering the points already measured. It still cannot interrupt EIS,
  which runs inside the HELPStat library; an EIS sweep finishes on its
  own.
- **The quiet time is held at the start potential and is no longer
  capped at 2 s** (the app accepts 0 to 60 s).
- **Bluetooth Low Energy and the microSD card interface are present on
  the ESP32-S3/HELPStat hardware but only microSD is used by this
  firmware.** The vendored `HELPStat.h`/`.cpp` still carry the original
  library's full `BLE_setup()` (a per-parameter `BLECharacteristic`
  protocol from the old Android app) but `ElectroStat_Firmware.ino`
  never calls it — all communication goes over WiFi/TCP. The microSD
  card, by contrast, is now used as a backup: every point sent over
  WiFi during a run is also appended to a per-run `.jsonl` file under
  `/backup` on the card (see the `startBackup`/`sendLine` code in the
  `.ino`), so a dropped connection mid-sweep doesn't lose data that was
  already measured. This is new and, like everything else here,
  untested against real hardware — if no card is present it silently
  does nothing and doesn't affect the WiFi path.
- **RTIA gain**: EIS still uses `gainTable` (copied from the HELPStat
  demo sketch) unmodified — this depends on the calibration resistor and
  electrode setup on the actual board, re-tune once you have hardware to
  test against. CV/BioFET/SWV no longer hardcode `HSTIARTIA_10K`: the
  app's Parameters panel has an "RTIA Gain" selector (the AD5941's 8
  discrete steps, 200Ω-160kΩ) sent as `rtiaOhms` in each start command,
  read into `cvRtiaOhms`/`fetRtiaOhms`/`swvRtiaOhms` and mapped to the
  driver's selector via `rtiaOhmsToSel()`; 10k stays the default if the
  field is omitted. This is manual gain selection, not auto-ranging —
  the operator still has to pick a value and re-run if it's wrong.
  `AD5940_AmperometryStep()` (HELPStat.cpp) now also flags, per point,
  when the HSTIA output fell outside the AD5941's usable 0.2-2.1V ADC
  window (the same window HELPStat's own paper names as the target for
  real auto-ranging — DOI: 10.1021/acselectrochem.4c00052) — the
  point's `outOfRange` field surfaces in the app's Signal Quality panel
  as an "HSTIA Range" row, and the firmware logs a one-line summary
  count over Serial at the end of the sweep. It does NOT correct the
  gain automatically; that requires sampling and adjusting mid-sweep,
  which needs real hardware to tune safely (see "Next step" below).
  UNTESTED against real hardware — in particular, the assumption that
  HSTIA_N sits at the fixed ~1.1V Vzero bias (so the absolute HSTIA
  output voltage can be recovered as Vzero + the measured differential
  reading) should be the first thing checked with a meter once a board
  is available.
- **Next step once hardware arrives**: work through the four
  techniques in the order they were implemented (EIS, then CV, then
  BioFET, then SWV) rather than testing all four at once — EIS and CV
  are the ones with the least uncertainty (EIS reuses proven code, CV
  is the first thing the new amperometric primitive was built and
  checked against), so getting those solid first makes it much easier
  to tell whether a BioFET/SWV problem is the shared primitive or
  something specific to that technique.

## First bring-up with the board

Do these in order and stop at the first step that fails.

1. **Power and bus, no electrode.** Flash, open the Serial Monitor at
   115200, check that the AP starts and that `AD5940Start` reports no
   SPI error. Measure the calibration resistor with a multimeter and
   put the value in `RCAL_OHMS`.
2. **Dummy cell, EIS first.** A known resistor-capacitor network as
   the cell. Run the app's dummy-cell check (Rs, Rct, Cdl). If it is
   not green, fix this before anything else, every other technique
   shares the front-end.
3. **Check the ADC window.** Put a known resistor as the cell and read
   the HSTIA output with a multimeter at a known bias. This confirms the
   assumption that HSTIA_N sits at the fixed ~1.1 V Vzero (the basis of
   the `outOfRange` flag).
4. **Measure the read time and the settling time.** Put a scope on the
   working electrode (or the LPDAC output). Run a CV and read the
   `readUs` field of `cv_done`, which is the slowest ADC read. On the
   scope, apply a 2 mV step and see how long the potential takes to
   settle. Then lower `kSettleUs` in the `.ino` to what you measured
   (plus margin), which raises the fastest scan rate and SWV frequency
   the board accepts.
5. **CV on a dummy cell, then on ferricyanide.** Resistor as the cell:
   the current must be a straight line against E, with slope 1/R. Then
   5 mM ferri/ferrocyanide on a screen-printed electrode at 100 mV/s
   and a 2 mV step: ΔEp near 60 to 70 mV and ipc near the
   Randles-Ševčík value. Check `lateCount` is 0 and
   `achievedScanRate_mVs` is within 1 % of the request. Repeat at 50 and
   200 mV/s.
6. **Compare with the reference potentiostat.** The same cell, the same
   settings, overlay the two voltammograms. This is the test that turns
   the simulated validation into a measured one.
7. **SWV, then BioFET.** SWV on the same probe at 25 Hz: the peak at
   E0′, and `achievedFrequency_Hz` near 25. BioFET last, since it needs
   the transistor, and only after the CV/SWV timing is trusted.
8. **Stop and recovery.** Press Stop during a CV and during an SWV,
   check the app returns to idle and the next run starts normally.
   Unplug the WiFi mid-sweep and check the microSD backup holds the
   points.
9. **USB serial, attached and detached.** Run a sweep with the USB
   cable connected to a computer with no serial monitor open, and with
   it unplugged (battery). If the timing worsens when nothing reads the
   USB port, the `Serial.println` echo in `sendLine()` is blocking and
   must be disabled for sweeps.
