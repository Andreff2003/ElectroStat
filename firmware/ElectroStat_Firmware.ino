/*
  ================================================================
  ElectroStat_Firmware.ino
  ================================================================
  ESP32-S3 + AD5941 firmware for the ElectroStat project.

  Talks to bridge.py over WiFi (the ESP32 creates its own access
  point, matching bridge.py's default `--mode wifi --esp-ip
  192.168.4.1 --esp-port 82`) or, equivalently, over USB serial
  (matching bridge.py's `--mode serial --port ... --baud 115200`) —
  both listened to concurrently, whichever one bridge.py is actually
  using is the one that ever has anything to read. Protocol: one JSON
  object per line, both directions — this file only implements that
  transport + command dispatch; the actual JSON field names/shapes are
  exactly what bridge.py's forward_esp32_message() and ws_handler()
  already expect (see bridge.py's own header comment for the full
  contract).

  STATUS AS OF THIS FILE (read before wiring up real hardware):
    - EIS: implemented, reusing the AD5941 driver from the LinnesLab
      HELPStat library (HELPStat.cpp/.h, ad5940.c/.h, vendored
      unmodified except for one small additive callback hook — see
      the "ElectroStat addition" comments in HELPStat.h/.cpp).
      UNTESTED against real hardware — this is a first pass written
      against the library's own demo sketch and source, not verified
      on a board. The app's "Amplitude" field (cmd["amplitude"], mV) is
      now wired through to AD5940_TDD's sine generator (previously
      fixed at the library's hardcoded 200 mV regardless of request).
    - CV: implemented as NEW code (there was no CV in the original
      HELPStat library to reuse), built on a new "amperometric step"
      primitive in HELPStat.h/.cpp — see the ElectroStat addition
      comment there for exactly what it is/isn't based on. UNTESTED
      against real hardware. Known gap: the applied-potential range is
      limited to roughly +-1.1 V by the LPDAC bias path used here; a
      sweep asking for more will clip (the firmware logs a warning
      when this happens, it doesn't fail silently).
    - BioFET (start_fet): implemented as new code, on the same
      amperometric primitive as CV. Each start_fet command runs ONE
      physical sweep (real hardware can't produce a synthetic
      "baseline vs analyte" pair from one command like the simulator
      does) — the resulting curve is labelled "baseline" or "analyte"
      from the concentration already carried in the same command
      (<=0 -> baseline, >0 -> analyte). Run it once with concentration
      0 before adding the analyte, then again with the real
      concentration after — compare the two via the app's Overlay
      view, same as with simulated data. Also runs a time-response
      phase (Id vs time at a fixed readout bias) right after the
      transfer curve, paced in real elapsed time. UNTESTED against
      real hardware. Same +-1.1V range limit as CV.
    - SWV (start_swv): implemented as new code, on the same
      amperometric primitive as CV/BioFET. Applies a square wave on a
      staircase ramp — forward pulse at E_step + pulseSign*Esw, hold
      one half-period (1/(2*frequency_Hz)), sample; then the reverse
      pulse at E_step - pulseSign*Esw, hold, sample again; INet =
      IForward - IReverse. pulseSign follows the ramp direction
      (endE >= startE -> +1), matching swvDiffusionSolver.ts's
      convention. UNTESTED against real hardware — the half-period
      hold time is an approximation, not calibrated against a scope.
      Same +-1.1V (window +- pulse amplitude) range limit as CV.
    - "stop" cannot interrupt any sweep already in progress in this
      version — a running sweep must finish on its own.
    - microSD backup: NEW. Every point sent over WiFi during a run is
      also appended to a per-run .jsonl file under /backup on the SD
      card (see the "microSD backup" comment above sendLine()), so a
      dropped connection mid-sweep doesn't lose already-measured data.
      Best-effort only: if no card is present, this silently does
      nothing and the WiFi path is unaffected. UNTESTED against real
      hardware — the CS_SD pin and SPI-bus sharing with the AD5941
      follow the same pattern the original HELPStat library already
      used for its own SD writes, but that hasn't been verified either.

  REQUIRED ARDUINO LIBRARY (install via Library Manager):
    - "ArduinoJson" by Benoit Blanchon — needs v7.x specifically (this
      file uses the v7 JsonDocument API; v6's StaticJsonDocument<N> is
      not compatible with the code below as written).
  Board: "ESP32S3 Dev Module" (or your specific board's ESP32-S3
  variant) in the esp32 board package by Espressif.

  WIRING / PINS: see constants.h (vendored from HELPStat, matches
  the ESP32-S3 pinout already used by that project): SPI MOSI=35,
  MISO=37, SCK=36, CS=11, RESET=10, INT=9.
  ================================================================
*/

#include <math.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include "HELPStat.h"

// ── WiFi access point ──────────────────────────────────────────
// ESP32 SoftAP always gets 192.168.4.1 as its own IP unless you
// change it with WiFi.softAPConfig — matches bridge.py's default
// --esp-ip, so no bridge.py flag changes are needed.
static const char *AP_SSID = "ElectroStat-ESP32";
static const char *AP_PASSWORD = "electrostat"; // >= 8 chars required by WiFi.softAP
static const uint16_t TCP_PORT = 82; // matches bridge.py's default --esp-port

WiFiServer tcpServer(TCP_PORT);
WiFiClient tcpClient; // one client at a time — bridge.py only ever opens one

// ── AD5941 / HELPStat driver instance ──────────────────────────
HELPStat helpstat;

// Default RTIA gain-switching table copied from the HELPStat demo
// sketch (AD594x_EIS_Demo.ino). This depends on the calibration
// resistor and electrode setup on the actual board — treat these as
// a starting point to re-tune once real hardware is available, not
// as verified values.
calHSTIA gainTable[] = {
  {0.51,     HSTIARTIA_40K},
  {1.5,      HSTIARTIA_10K},
  {20,       HSTIARTIA_5K},
  {150,      HSTIARTIA_5K},
  {400,      HSTIARTIA_1K},
  {100000,   HSTIARTIA_200},
};
const int gainTableSize = sizeof(gainTable) / sizeof(gainTable[0]);

// Maps an RTIA resistance in ohms to the AD5941's nearest discrete HSTIA
// gain selector, for the amperometric primitive used by CV/BioFET/SWV
// (handleStartCv/Fet/Swv below) — NOT the same path as gainTable above,
// which is EIS's own pre-existing ranging table from the HELPStat demo.
// The app's Parameters panel offers exactly these 8 values, so `ohms`
// should already be one of them; snapping to nearest is just a safety net
// for a stale/rounded value.
uint32_t rtiaOhmsToSel(float ohms) {
  static const struct { float ohms; uint32_t sel; } table[] = {
    {200.0f,      HSTIARTIA_200},
    {1000.0f,     HSTIARTIA_1K},
    {5000.0f,     HSTIARTIA_5K},
    {10000.0f,    HSTIARTIA_10K},
    {20000.0f,    HSTIARTIA_20K},
    {40000.0f,    HSTIARTIA_40K},
    {80000.0f,    HSTIARTIA_80K},
    {160000.0f,   HSTIARTIA_160K},
  };
  uint32_t best = HSTIARTIA_10K;
  float bestDiff = 1e30f;
  for (unsigned i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
    float diff = fabs(table[i].ohms - ohms);
    if (diff < bestDiff) { bestDiff = diff; best = table[i].sel; }
  }
  return best;
}

// Calibration resistor value in ohms — same default as the demo
// sketch. Replace with the *measured* value of the resistor actually
// populated on the board (see thesis: measure it with a DMM).
static const float RCAL_OHMS = 1000.0f;

static bool eisSweepInProgress = false;

// ── microSD backup (see constants.h: CS_SD, shares the SPI bus with the
// AD5941 on its own CS line). Every JSON line normally sent to bridge.py
// is *also* appended to a per-run file on the card while a sweep is in
// progress, so a dropped WiFi connection mid-sweep doesn't lose the data
// that was already measured — it can be recovered from the card and
// re-imported later. Purely a safety net: if the card is missing or
// fails to mount, sdAvailable stays false and everything below becomes a
// no-op, with no effect on the live WiFi/TCP path. UNTESTED against real
// hardware, like the rest of this firmware. ─────────────────────────────
static bool sdAvailable = false;
static String currentBackupFile = ""; // "" -> no run in progress / no card

String backupFilename(const char *technique) {
  // millis()-based: unique within a boot session, which is all that's
  // needed for a manually operated instrument (a collision would require
  // two runs of the same technique starting at the exact same millisecond
  // since power-on).
  return String("/backup/") + technique + "_" + String(millis()) + ".jsonl";
}

void startBackup(const char *technique) {
  if (!sdAvailable) return;
  currentBackupFile = backupFilename(technique);
  Serial.printf("[SD] Backing up this run to %s\n", currentBackupFile.c_str());
}

void stopBackup() {
  currentBackupFile = "";
}

// ── Small helper: send one JSON-line message to the connected browser
// side (via bridge.py). Silently drops it if nothing is connected —
// matches bridge.py's own "no clients" no-op behaviour. Also written to
// USB serial (bridge.py's --mode serial reads the same JSON-per-line
// protocol from Serial instead of TCP) and appended to the current
// backup file, if any (see startBackup above). Debug lines elsewhere in
// this file (Serial.printf("[CMD] ...") etc.) end up interleaved with
// these JSON lines on the same Serial stream — bridge.py's run_serial()
// already tolerates that, silently skipping anything that doesn't parse
// as JSON, so this doesn't need a separate channel. ────────────────────
void sendLine(const String &line) {
  if (tcpClient && tcpClient.connected()) {
    tcpClient.print(line);
    tcpClient.print('\n');
  }
  Serial.println(line);
  if (sdAvailable && currentBackupFile.length() > 0) {
    File f = SD.open(currentBackupFile, FILE_APPEND);
    if (f) {
      f.println(line);
      f.close();
    }
    // If this fails (card removed mid-run, etc.) we deliberately don't
    // retry or error out — the live WiFi path must keep working either
    // way, the backup is best-effort only.
  }
}

void sendJson(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  sendLine(out);
}

// ── EIS point callback — called by HELPStat::AD5940_DFTMeasure() for
// every single measured point, in real time during the sweep (see the
// ElectroStat addition in HELPStat.cpp). Must match the field names
// bridge.py's forward_esp32_message() reads for msg_type == "eis". ──
void onEisPoint(const impStruct &point) {
  JsonDocument doc;
  doc["type"] = "eis";
  doc["zReal"] = point.real;
  doc["zImag"] = point.imag;
  doc["frequency"] = point.freq;
  doc["zMag"] = point.magnitude;
  doc["phase"] = point.phaseDeg;
  sendJson(doc);
}

// ── Command handlers ────────────────────────────────────────────

void handleStartEis(JsonDocument &cmd) {
  if (eisSweepInProgress) {
    JsonDocument err;
    err["type"] = "eis_status";
    err["status"] = "error";
    err["message"] = "EIS sweep already running";
    sendJson(err);
    return;
  }

  float freqMin = cmd["freqMin"] | 0.1f;
  float freqMax = cmd["freqMax"] | 100000.0f;
  int points = cmd["points"] | 60;
  // dcBias arrives from the app in volts; the AD5941 driver's biasVolt
  // parameter is in millivolts (see the +-1100 clamp inside
  // HELPStat::AD5940_TDD, sized for a +-1.1 V range around the 1.1 V
  // Vzero reference) — convert here, once, so nobody has to remember it.
  float dcBiasVolts = cmd["dcBias"] | 0.0f;
  float biasMillivolts = dcBiasVolts * 1000.0f;
  float amplitudeMv = cmd["amplitude"] | 10.0f;
  if (amplitudeMv <= 0 || amplitudeMv > 800.0f) {
    Serial.printf("[EIS] WARNING: requested amplitude %.1f mV is outside the "
                  "~0-800 mV peak-to-peak range AD5940_TDD's sine generator "
                  "supports (SinAmplitudeWord = amplitudeMv/800*2047) — the "
                  "excitation will clip or invert.\n", amplitudeMv);
  }

  if (freqMin <= 0 || freqMax <= 0 || freqMin == freqMax) {
    JsonDocument err;
    err["type"] = "eis_status";
    err["status"] = "error";
    err["message"] = "freqMin/freqMax must be positive and different";
    sendJson(err);
    return;
  }

  // HELPStat::AD5940_TDD's "numPoints" is points PER DECADE, not a
  // total point count (see AD5940ImpedanceStructInit / the SweepPoints
  // formula in HELPStat.cpp) — bridge.py always sends a flat total
  // "points" value, so convert here.
  float decades = fabs(log10(freqMax) - log10(freqMin));
  int pointsPerDecade = max(1, (int)round(points / max(decades, 0.01f)));

  Serial.printf("[EIS] freqMin=%.3f freqMax=%.3f points=%d (~%d/decade) bias=%.1fmV amplitude=%.1fmVpp\n",
                freqMin, freqMax, points, pointsPerDecade, biasMillivolts, amplitudeMv);

  eisSweepInProgress = true;
  startBackup("eis");
  {
    JsonDocument status;
    status["type"] = "eis_status";
    status["status"] = "running";
    sendJson(status);
  }

  // Sweep high -> low frequency, matching the app's own convention.
  helpstat.AD5940_TDD(
    freqMax, freqMin, pointsPerDecade,
    biasMillivolts, /*zeroVolt=*/0.0f, RCAL_OHMS,
    gainTable, gainTableSize,
    /*extGain=*/1, /*dacGain=*/1,
    amplitudeMv
  );
  helpstat.runSweep(); // blocking; streams points via onEisPoint() as it runs

  eisSweepInProgress = false;
  {
    JsonDocument done;
    done["type"] = "eis_done";
    done["points"] = points;
    sendJson(done);
  }
  {
    JsonDocument status;
    status["type"] = "eis_status";
    status["status"] = "done";
    sendJson(status);
  }
  stopBackup();
}

static bool cvSweepInProgress = false;
// Set per-sweep in handleStartCv() from cmd["rtiaOhms"] (defaults to
// 10000, i.e. HSTIARTIA_10K, matching the app's ParametersPanel default)
// — single source of truth for both the AD5940_AmperometrySetup() gain
// selector and the ohms value AD5940_AmperometryStep() needs for its
// Ohm's-law conversion, so the two can't drift out of sync the way two
// separate constants previously could.
static float cvRtiaOhms = 10000.0f;
static int cvOutOfRangeCount = 0;

void sendCvPoint(float E, int cycle, float t, const char *branch, float current_uA, bool outOfRange) {
  JsonDocument doc;
  doc["type"] = "cv_data";
  doc["E"] = E;
  doc["I"] = current_uA;
  doc["cycle"] = cycle;
  doc["t"] = t;
  doc["branch"] = branch;
  // See AD5940_AmperometryStep's outOfRange doc in HELPStat.h — true means
  // the HSTIA output was outside the AD5941's usable ADC window for this
  // point, so `current_uA` above may not be trustworthy. Surfaced in the
  // app's Signal Quality panel; doesn't change acquisition automatically.
  doc["outOfRange"] = outOfRange;
  sendJson(doc);
}

// Steps the applied potential from `from` to `to` in increments of stepV,
// measuring current and streaming one cv_data point per step. *tRef is
// advanced by stepDelayMs (in seconds) each step, approximating the
// requested scan rate — timing has not been calibrated against real
// hardware yet (see the firmware README). Returns the final E reached.
float cvRampTo(float from, float to, const char *branch, int cycle,
               float stepV, unsigned long stepDelayMs, float *tRef) {
  float delta = to - from;
  if (fabs(delta) < 1e-9f) return from;
  int nSteps = max(1, (int)ceil(fabs(delta) / stepV));
  float E = from;
  for (int k = 1; k <= nSteps; k++) {
    float frac = (float)k / (float)nSteps;
    E = from + delta * frac;
    bool outOfRange = false;
    float current_uA = helpstat.AD5940_AmperometryStep(E * 1000.0f, cvRtiaOhms, &outOfRange);
    if (outOfRange) cvOutOfRangeCount++;
    *tRef += stepDelayMs / 1000.0f;
    sendCvPoint(E, cycle, *tRef, branch, current_uA, outOfRange);
    delay(stepDelayMs);
  }
  return E;
}

void handleStartCv(JsonDocument &cmd) {
  if (cvSweepInProgress) {
    JsonDocument err;
    err["type"] = "cv_error";
    err["message"] = "CV sweep already running";
    sendJson(err);
    return;
  }

  // Field names match what bridge.py's parse_cv_params() normalises to
  // before forwarding to hardware (send_to_hardware) — see bridge.py.
  float eStart = cmd["eStart"] | 0.6f;
  float eV1 = cmd["eVertex1"] | -0.2f;
  float eV2 = cmd["eVertex2"] | 0.6f;
  int nCycles = cmd["nCycles"] | 1;
  if (nCycles < 1) nCycles = 1;
  float stepMv = cmd["stepMv"] | 1.0f;
  float scanRate = cmd["scanRate"] | 100.0f; // mV/s
  float quietTime = cmd["quietTime"] | 0.0f;
  cvRtiaOhms = cmd["rtiaOhms"] | 10000.0f;
  cvOutOfRangeCount = 0;

  if (stepMv <= 0 || scanRate <= 0) {
    JsonDocument err;
    err["type"] = "cv_error";
    err["message"] = "stepMv and scanRate must both be > 0";
    sendJson(err);
    return;
  }
  float maxAbsE = fabs(eStart);
  if (fabs(eV1) > maxAbsE) maxAbsE = fabs(eV1);
  if (fabs(eV2) > maxAbsE) maxAbsE = fabs(eV2);
  if (maxAbsE > 1.1f) {
    Serial.printf("[CV] WARNING: requested potential up to %.2f V exceeds the "
                  "~+-1.1V LPDAC bias range this firmware supports — the "
                  "sweep will clip at the extremes.\n", maxAbsE);
  }

  cvSweepInProgress = true;
  startBackup("cv");
  {
    JsonDocument status;
    status["type"] = "cv_status";
    status["status"] = "running";
    sendJson(status);
  }

  helpstat.AD5940_AmperometrySetup(rtiaOhmsToSel(cvRtiaOhms));

  if (quietTime > 0) {
    delay((unsigned long)(min(quietTime, 2.0f) * 1000.0f));
  }

  float stepV = stepMv / 1000.0f;
  unsigned long stepDelayMs = (unsigned long)max(1.0f, (stepMv / scanRate) * 1000.0f);

  float t = 0.0f;
  float cur = eStart;
  bool firstOutOfRange = false;
  float firstCurrent = helpstat.AD5940_AmperometryStep(eStart * 1000.0f, cvRtiaOhms, &firstOutOfRange);
  if (firstOutOfRange) cvOutOfRangeCount++;
  sendCvPoint(eStart, 1, 0.0f, "forward", firstCurrent, firstOutOfRange);

  for (int c = 1; c <= nCycles; c++) {
    cur = cvRampTo(cur, eV1, "forward", c, stepV, stepDelayMs, &t);
    cur = cvRampTo(cur, eV2, "reverse", c, stepV, stepDelayMs, &t);
    if (c < nCycles && fabs(cur - eStart) > 1e-6f) {
      cur = cvRampTo(cur, eStart, "return", c, stepV, stepDelayMs, &t);
    }
  }

  cvSweepInProgress = false;
  if (cvOutOfRangeCount > 0) {
    Serial.printf("[CV] WARNING: %d point(s) had HSTIA output outside the "
                  "AD5941's 0.2-2.1V ADC window at RTIA=%.0f ohms — those "
                  "readings may be inaccurate. Try a different RTIA Gain.\n",
                  cvOutOfRangeCount, cvRtiaOhms);
  }
  {
    JsonDocument done;
    done["type"] = "cv_done";
    done["cycle"] = nCycles;
    done["outOfRangeCount"] = cvOutOfRangeCount;
    sendJson(done);
  }
  {
    JsonDocument status;
    status["type"] = "cv_status";
    status["status"] = "done";
    sendJson(status);
  }
  stopBackup();
}

static bool fetSweepInProgress = false;
// Set per-sweep in handleStartFet() from cmd["rtiaOhms"] — see cvRtiaOhms
// above for why this is one mutable variable instead of two constants.
static float fetRtiaOhms = 10000.0f;
static int fetOutOfRangeCount = 0;

void sendFetTransferPoint(const char *curve, float vg, float id_uA, float concentration, bool outOfRange) {
  JsonDocument doc;
  doc["type"] = "fet_transfer";
  doc["curve"] = curve;
  doc["vg"] = vg;
  doc["id"] = id_uA;
  doc["concentration"] = concentration;
  // See AD5940_AmperometryStep's outOfRange doc in HELPStat.h.
  doc["outOfRange"] = outOfRange;
  sendJson(doc);
}

void sendFetTimePoint(float t, float id_uA, float vgRead, bool outOfRange) {
  JsonDocument doc;
  doc["type"] = "fet_time";
  doc["time"] = t;
  doc["id"] = id_uA;
  doc["vgRead"] = vgRead;
  doc["outOfRange"] = outOfRange;
  sendJson(doc);
}

// One start_fet command = one physical sweep = one curve. There's no way
// for the firmware to produce a "baseline" and an "analyte" curve from a
// single command against real hardware (unlike the simulator, which just
// computes both) — a baseline and an analyte reading are two separate
// measurements of the same electrode, taken before/after a manual
// reagent addition. Which one this run is gets decided from the
// concentration already carried in the same command, so no new protocol
// field is needed: concentration <= 0 -> "baseline", > 0 -> "analyte".
// Run the sweep with concentration 0 before adding analyte, then again
// with the real concentration after — the app's existing Overlay view
// is how the two get compared, matching how it's used with simulated
// data today.
void handleStartFet(JsonDocument &cmd) {
  if (fetSweepInProgress) {
    JsonDocument err;
    err["type"] = "fet_error";
    err["message"] = "BioFET sweep already running";
    sendJson(err);
    return;
  }

  // Field names match what bridge.py's start_fet handler forwards to
  // hardware. kd_nM/vtBaseline_V/deltaVtMax_V/idealityFactor/
  // bindingRate_perS are simulator-only parameters (they shape the
  // *synthetic* curve) and are intentionally not read here — real
  // hardware has no use for them, the sensor itself determines the
  // response.
  float vgMin = cmd["vgMin"] | -0.5f;
  float vgMax = cmd["vgMax"] | 1.5f;
  float vgStep = cmd["vgStep"] | 0.04f; // volts — already converted by the app before sending
  int intervalMs = cmd["intervalMs"] | 200;
  float concentration = cmd["concentration"] | 0.0f;
  float readoutBias = cmd["readoutBias_V"] | 1.0f;
  float timeDuration = cmd["timeDuration_s"] | 60.0f;
  float timeStep = cmd["timeStep_s"] | 0.5f;
  fetRtiaOhms = cmd["rtiaOhms"] | 10000.0f;
  fetOutOfRangeCount = 0;

  if (vgStep <= 0 || vgMax == vgMin) {
    JsonDocument err;
    err["type"] = "fet_error";
    err["message"] = "vgStep must be > 0 and vgMin must differ from vgMax";
    sendJson(err);
    return;
  }

  const char *curve = (concentration > 0.0f) ? "analyte" : "baseline";

  float maxAbsVg = fabs(vgMin) > fabs(vgMax) ? fabs(vgMin) : fabs(vgMax);
  if (maxAbsVg > 1.1f || fabs(readoutBias) > 1.1f) {
    Serial.printf("[FET] WARNING: requested Vg up to %.2f V (readout bias %.2f V) "
                  "exceeds the ~+-1.1V LPDAC bias range — the sweep will clip.\n",
                  maxAbsVg, readoutBias);
  }
  Serial.printf("[FET] curve=%s vgMin=%.3f vgMax=%.3f vgStep=%.3f C=%.2f\n",
                curve, vgMin, vgMax, vgStep, concentration);

  fetSweepInProgress = true;
  startBackup("fet");
  {
    JsonDocument status;
    status["type"] = "fet_status";
    status["status"] = "running";
    sendJson(status);
  }

  helpstat.AD5940_AmperometrySetup(rtiaOhmsToSel(fetRtiaOhms));

  // ── Phase 1: transfer curve (Id vs Vg) ──────────────────────────
  int direction = (vgMax >= vgMin) ? 1 : -1;
  int nSteps = max(1, (int)round(fabs(vgMax - vgMin) / vgStep));
  for (int i = 0; i <= nSteps; i++) {
    float vg = vgMin + direction * i * vgStep;
    bool outOfRange = false;
    float id_uA = helpstat.AD5940_AmperometryStep(vg * 1000.0f, fetRtiaOhms, &outOfRange);
    if (outOfRange) fetOutOfRangeCount++;
    sendFetTransferPoint(curve, vg, id_uA, concentration, outOfRange);
    delay(max(1, intervalMs));
  }

  // ── Phase 2: time response at the fixed readout bias ────────────
  // Real elapsed time, not simulator playback speed — add the analyte
  // manually whenever you're ready during this phase, the resulting
  // shift shows up in the Id-vs-time data itself.
  int timePoints = max(1, (int)(timeDuration / max(timeStep, 0.01f)) + 1);
  unsigned long stepMs = (unsigned long)max(1.0f, timeStep * 1000.0f);
  for (int i = 0; i < timePoints; i++) {
    float t = i * timeStep;
    bool outOfRange = false;
    float id_uA = helpstat.AD5940_AmperometryStep(readoutBias * 1000.0f, fetRtiaOhms, &outOfRange);
    if (outOfRange) fetOutOfRangeCount++;
    sendFetTimePoint(t, id_uA, readoutBias, outOfRange);
    delay(stepMs);
  }

  fetSweepInProgress = false;
  if (fetOutOfRangeCount > 0) {
    Serial.printf("[FET] WARNING: %d point(s) had HSTIA output outside the "
                  "AD5941's 0.2-2.1V ADC window at RTIA=%.0f ohms — those "
                  "readings may be inaccurate. Try a different RTIA Gain.\n",
                  fetOutOfRangeCount, fetRtiaOhms);
  }
  {
    JsonDocument done;
    done["type"] = "fet_done";
    done["transferPoints"] = nSteps + 1;
    done["timePoints"] = timePoints;
    done["outOfRangeCount"] = fetOutOfRangeCount;
    sendJson(done);
  }
  {
    JsonDocument status;
    status["type"] = "fet_status";
    status["status"] = "done";
    sendJson(status);
  }
  stopBackup();
}

static bool swvSweepInProgress = false;
// Set per-sweep in handleStartSwv() from cmd["rtiaOhms"] — see
// cvRtiaOhms above for why this is one mutable variable instead of a
// constant. SWV's differential (pulse-to-pulse) current is typically
// much smaller than CV's, so this may need a larger Rtia than CV/FET to
// use the ADC's range well — the app's RTIA Gain selector defaults all
// three to 10k but each can be set independently.
static float swvRtiaOhms = 10000.0f;
static int swvOutOfRangeCount = 0;

void sendSwvPoint(float E, float iForward_uA, float iReverse_uA, float t,
                   int index, const char *direction, bool outOfRange) {
  JsonDocument doc;
  doc["type"] = "swv_data";
  doc["E"] = E;
  doc["IForward"] = iForward_uA;
  doc["IReverse"] = iReverse_uA;
  doc["INet"] = iForward_uA - iReverse_uA;
  doc["time"] = t;
  doc["index"] = index;
  doc["direction"] = direction;
  // True if EITHER the forward or reverse pulse reading (see
  // AD5940_AmperometryStep's outOfRange doc in HELPStat.h) was out of
  // range — INet above draws on both, so either one can make it suspect.
  doc["outOfRange"] = outOfRange;
  sendJson(doc);
}

// SWV: a square wave riding on a staircase potential ramp. At every
// staircase step, apply E_step + pulseSign*Esw ("forward" pulse), hold
// for one half-period, sample the current; then apply E_step -
// pulseSign*Esw ("reverse" pulse), hold, sample again. INet = IForward -
// IReverse. pulseSign follows the ramp direction (endE >= startE ->
// +1), matching the convention documented in the app's own
// swvDiffusionSolver.ts ("IForward at the end of the forward pulse").
// Built on the same AD5940_AmperometryStep primitive as CV/BioFET — see
// the ElectroStat addition comment in HELPStat.h for what that is (and
// isn't) based on. UNTESTED against real hardware; timing in particular
// (the half-period hold before sampling) is an approximation — see the
// firmware README.
void handleStartSwv(JsonDocument &cmd) {
  if (swvSweepInProgress) {
    JsonDocument err;
    err["type"] = "swv_error";
    err["message"] = "SWV sweep already running";
    sendJson(err);
    return;
  }

  // Field names match bridge.py's validate_swv_params() output, which is
  // what gets forwarded to hardware.
  float startE = cmd["startE"] | -0.2f;
  float endE = cmd["endE"] | 0.6f;
  float stepMv = cmd["step_mV"] | 2.0f;
  float amplitudeMv = cmd["amplitude_mV"] | 25.0f;
  float frequencyHz = cmd["frequency_Hz"] | 25.0f;
  float quietTimeS = cmd["quietTime_s"] | 2.0f;
  const char *direction = cmd["direction"] | "anodic";
  swvRtiaOhms = cmd["rtiaOhms"] | 10000.0f;
  swvOutOfRangeCount = 0;

  if (stepMv <= 0 || frequencyHz <= 0 || amplitudeMv <= 0 || startE == endE) {
    JsonDocument err;
    err["type"] = "swv_error";
    err["message"] = "step_mV, amplitude_mV and frequency_Hz must all be > 0, and startE must differ from endE";
    sendJson(err);
    return;
  }

  float esw = amplitudeMv / 1000.0f;
  float maxAbsE = fabs(startE) > fabs(endE) ? fabs(startE) : fabs(endE);
  if (maxAbsE + esw > 1.1f) {
    Serial.printf("[SWV] WARNING: requested window (up to %.2f V +- %.3f V pulse) "
                  "exceeds the ~+-1.1V LPDAC bias range — the sweep will clip.\n",
                  maxAbsE, esw);
  }

  swvSweepInProgress = true;
  startBackup("swv");
  {
    JsonDocument status;
    status["type"] = "swv_status";
    status["status"] = "running";
    sendJson(status);
  }

  helpstat.AD5940_AmperometrySetup(rtiaOhmsToSel(swvRtiaOhms));

  if (quietTimeS > 0) {
    delay((unsigned long)(min(quietTimeS, 2.0f) * 1000.0f));
  }

  float stepV = stepMv / 1000.0f;
  int pulseSign = (endE >= startE) ? 1 : -1;
  int nSteps = (int)floor(fabs(endE - startE) / stepV + 1e-6f) + 1;
  unsigned long halfPeriodMs = (unsigned long)max(1.0f, 1000.0f / (2.0f * frequencyHz));
  float period = 1.0f / frequencyHz;

  for (int i = 0; i < nSteps; i++) {
    float eStep = startE + pulseSign * i * stepV;
    float eForward = eStep + pulseSign * esw;
    float eReverse = eStep - pulseSign * esw;

    bool fwdOutOfRange = false;
    float iForward = helpstat.AD5940_AmperometryStep(eForward * 1000.0f, swvRtiaOhms, &fwdOutOfRange);
    delay(halfPeriodMs);
    bool revOutOfRange = false;
    float iReverse = helpstat.AD5940_AmperometryStep(eReverse * 1000.0f, swvRtiaOhms, &revOutOfRange);
    delay(halfPeriodMs);
    bool outOfRange = fwdOutOfRange || revOutOfRange;
    if (outOfRange) swvOutOfRangeCount++;

    float t = quietTimeS + i * period;
    sendSwvPoint(eStep, iForward, iReverse, t, i, direction, outOfRange);
  }

  swvSweepInProgress = false;
  if (swvOutOfRangeCount > 0) {
    Serial.printf("[SWV] WARNING: %d point(s) had HSTIA output outside the "
                  "AD5941's 0.2-2.1V ADC window at RTIA=%.0f ohms — those "
                  "readings may be inaccurate. Try a different RTIA Gain.\n",
                  swvOutOfRangeCount, swvRtiaOhms);
  }
  {
    JsonDocument done;
    done["type"] = "swv_done";
    done["points"] = nSteps;
    done["outOfRangeCount"] = swvOutOfRangeCount;
    sendJson(done);
  }
  {
    JsonDocument status;
    status["type"] = "swv_status";
    status["status"] = "done";
    sendJson(status);
  }
  stopBackup();
}

void handleStop() {
  // Cannot interrupt a running sweep in this version — see file
  // header. If nothing is running this is a harmless no-op, matching
  // bridge.py's own "stop" semantics (broadcasts idle regardless).
  JsonDocument s1; s1["type"] = "eis_status";  s1["status"] = "idle"; sendJson(s1);
  JsonDocument s2; s2["type"] = "cv_status";   s2["status"] = "idle"; sendJson(s2);
  JsonDocument s3; s3["type"] = "fet_status";  s3["status"] = "idle"; sendJson(s3);
  JsonDocument s4; s4["type"] = "swv_status";  s4["status"] = "idle"; sendJson(s4);
  stopBackup();
}

void dispatchCommand(const String &line) {
  JsonDocument cmd;
  DeserializationError err = deserializeJson(cmd, line);
  if (err) {
    Serial.printf("[CMD] Invalid JSON ignored: %s\n", line.c_str());
    return;
  }
  const char *command = cmd["command"] | "";
  Serial.printf("[CMD] %s\n", command);

  if (strcmp(command, "start_eis") == 0) {
    handleStartEis(cmd);
  } else if (strcmp(command, "start_cv") == 0) {
    handleStartCv(cmd);
  } else if (strcmp(command, "start_fet") == 0) {
    handleStartFet(cmd);
  } else if (strcmp(command, "start_swv") == 0) {
    handleStartSwv(cmd);
  } else if (strncmp(command, "stop", 4) == 0) {
    handleStop();
  } else {
    Serial.printf("[CMD] Unrecognised command: %s\n", command);
  }
}

// ── Arduino entry points ────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("ElectroStat firmware starting...");
  helpstat.setEisPointCallback(onEisPoint);
  helpstat.AD5940Start(); // AD5941 SPI/GPIO bring-up (from constants.h pins)

  // microSD backup (see the "microSD backup" comment above sendLine()).
  // CS_SD is defined in constants.h; the card shares the SPI bus with the
  // AD5941 on its own chip-select line. Missing/failed card is not an
  // error — it just means sdAvailable stays false and no backup happens.
  if (SD.begin(CS_SD)) {
    if (!SD.exists("/backup")) {
      SD.mkdir("/backup");
    }
    sdAvailable = true;
    Serial.println("[SD] Card mounted, backups enabled at /backup");
  } else {
    Serial.println("[SD] No card found (or mount failed) — continuing without backup, WiFi path unaffected");
  }

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  IPAddress apIp = WiFi.softAPIP();
  Serial.print("AP started. SSID=");
  Serial.print(AP_SSID);
  Serial.print("  IP=");
  Serial.println(apIp);

  tcpServer.begin();
  Serial.printf("TCP server listening on port %u\n", TCP_PORT);
  Serial.println("Run: python bridge.py --mode wifi --esp-ip 192.168.4.1 --esp-port 82");
}

void loop() {
  // Accept a new client if we don't already have one connected.
  if (!tcpClient || !tcpClient.connected()) {
    WiFiClient incoming = tcpServer.available();
    if (incoming) {
      tcpClient = incoming;
      Serial.println("[TCP] bridge.py connected");
    }
  }

  if (tcpClient && tcpClient.connected() && tcpClient.available()) {
    String line = tcpClient.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) {
      dispatchCommand(line);
    }
  }

  // USB serial: bridge.py's --mode serial talks the same JSON-per-line
  // protocol over Serial instead of TCP. Listened to concurrently with
  // WiFi rather than picking one at compile time — bridge.py only ever
  // runs in one mode at a time, so only one of these two branches will
  // actually receive anything in practice.
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) {
      dispatchCommand(line);
    }
  }

  delay(2);
}
