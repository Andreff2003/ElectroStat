/*
  ElectroStat_Timing.h
  ================================================================
  The timing arithmetic of the real-time sweeps, kept free of any
  Arduino or AD5941 call so it can be compiled and tested on a PC
  (firmware/test/timing_test.cpp). Everything that touches hardware is
  in ElectroStat_Firmware.ino and is NOT covered by that test.

  The idea. A sweep is a train of slots of equal length. Slot k starts at
      t0 + k * periodUs
  computed from the start of the sweep, never from "when the previous
  step finished", so the time spent measuring and sending a point cannot
  accumulate into a slower scan. The potential is applied at the start of
  the slot and the current is read so that the ADC conversion ends at the
  end of the slot (guardUs before it), when the charging current has
  decayed. A slot too short for settle + conversion + guard is refused
  up front instead of silently running slower than asked.

  All times are micros() values. micros() wraps every 71 minutes, so
  comparisons go through a signed 32-bit difference, which stays correct
  across the wrap as long as the two instants are within 35 minutes.
  ================================================================
*/
#pragma once

#include <stdint.h>
#include <math.h>

namespace estat {

// True once `nowUs` has reached `deadlineUs` (wrap-safe).
inline bool reached(uint32_t nowUs, uint32_t deadlineUs) {
  return (int32_t)(nowUs - deadlineUs) >= 0;
}

// Microseconds left until `deadlineUs` (negative once it has passed).
inline int32_t remainingUs(uint32_t nowUs, uint32_t deadlineUs) {
  return (int32_t)(deadlineUs - nowUs);
}

// Slot k starts at t0 + k * period, with t0 fixed for the whole sweep.
struct StepClock {
  uint32_t t0Us = 0;
  uint32_t periodUs = 0;
  void begin(uint32_t startUs, uint32_t period) { t0Us = startUs; periodUs = period; }
  uint32_t due(uint32_t k) const { return t0Us + k * periodUs; }  // modular, wrap-safe
};

// Slot length for a staircase: one potential step every stepMv / scanRate seconds.
inline uint32_t periodFromScanRate(float stepMv, float scanRate_mVs) {
  float us = 1.0e6f * stepMv / scanRate_mVs;
  if (!(us > 1.0f)) return 1;
  if (us > 2.0e9f) return 2000000000u;
  return (uint32_t)lroundf(us);
}

// Half-period of a square wave of the given frequency.
inline uint32_t halfPeriodFromFrequency(float frequencyHz) {
  float us = 0.5e6f / frequencyHz;
  if (!(us > 1.0f)) return 1;
  if (us > 2.0e9f) return 2000000000u;
  return (uint32_t)lroundf(us);
}

// Conversion time to plan with: the slowest of the calibration reads plus 12.5 % and 100 us.
inline uint32_t convEstimateUs(uint32_t slowestReadUs) {
  return slowestReadUs + slowestReadUs / 8u + 100u;
}

// A slot must hold settling, the conversion and a guard before the next edge.
struct SlotPlan {
  bool ok;
  uint32_t periodUs;
  uint32_t minPeriodUs;
};
inline SlotPlan planSlot(uint32_t periodUs, uint32_t settleUs, uint32_t convUs, uint32_t guardUs) {
  uint32_t minP = settleUs + convUs + guardUs;
  return SlotPlan{periodUs >= minP, periodUs, minP};
}

// Offset inside the slot at which the read must start so that it ends guardUs before the slot does.
inline uint32_t readOffsetUs(uint32_t periodUs, uint32_t convUs, uint32_t guardUs) {
  return periodUs - convUs - guardUs;
}

// Fastest scan rate / square-wave frequency a slot of minimum length allows.
inline float maxScanRate_mVs(float stepMv, uint32_t minPeriodUs) {
  return stepMv / (minPeriodUs * 1.0e-6f);
}
inline float maxFrequencyHz(uint32_t minHalfPeriodUs) {
  return 1.0e6f / (2.0f * (float)minHalfPeriodUs);
}

// What a sweep reports about its own timing.
struct SweepStats {
  uint32_t n = 0;           // points measured
  uint32_t late = 0;        // slots that started later than the tolerance
  int32_t maxLagUs = 0;     // worst start delay of any slot
  uint32_t firstUs = 0;     // micros() at the end of the first read
  uint32_t lastUs = 0;      // micros() at the end of the latest read
  uint32_t maxReadUs = 0;   // slowest single read

  void note(uint32_t readEndUs, int32_t startLagUs, uint32_t readUs, int32_t lateToleranceUs) {
    if (n == 0) firstUs = readEndUs;
    lastUs = readEndUs;
    n++;
    if (startLagUs > lateToleranceUs) late++;
    if (startLagUs > maxLagUs) maxLagUs = startLagUs;
    if (readUs > maxReadUs) maxReadUs = readUs;
  }
  // Mean time between consecutive reads, in seconds (0 for fewer than two points).
  float meanPeriodS() const {
    return n > 1 ? (float)(uint32_t)(lastUs - firstUs) / 1.0e6f / (float)(n - 1) : 0.0f;
  }
};

// ── Potential convention ─────────────────────────────────────────
// Everywhere in this firmware, and in the JSON it sends, E is the potential of
// the working electrode (SE0) versus the reference electrode (RE0), and a
// positive current is anodic (it leaves WE), as in IUPAC.
//
// The hardware does not apply it that way round. The LPDAC drives RE0 to Vbias
// while the HSTIA holds SE0 at Vzero, so E(WE) - E(RE) = Vzero - Vbias, which is
// minus the "bias" that AD5940_AmperometrySetBias() and AD5940_TDD() take (the
// AD5940 convention is SensorBias = VRE0 - VSE0). lpdacBiasMvFromE() is the one
// place that converts, and it keeps the +-1100 mV range of the 12-bit code
// around Vzero.
constexpr float kLpdacBiasLimitMv = 1100.0f;

inline float lpdacBiasMvFromE(float eMv) {
  float c = eMv;
  if (c < -kLpdacBiasLimitMv) c = -kLpdacBiasLimitMv;
  if (c >  kLpdacBiasLimitMv) c =  kLpdacBiasLimitMv;
  return c == 0.0f ? 0.0f : -c;   // no negative zero
}

// ── Calibration of the amperometric path (CV, SWV, BioFET) ───────
// The current of CV, SWV and BioFET is the voltage across the HSTIA's RTIA
// divided by RTIA, and the AD5941 gives neither exactly: the internal RTIA is off
// by 10 to 20 % from its nominal value, the ADC has an offset and a gain error, the
// HSTIA and the leakage of the input add a current when none flows, and the LPDAC
// does not give exactly the potential that its code says. A dummy cell showed it:
// a constant offset of about -2.7 uA, currents 10 to 20 % too high, and a potential
// offset of 40 to 50 mV. At the start of every run the firmware measures these and
// corrects for them, and falls back to the nominal values, with a warning, when it
// cannot. Everything that is arithmetic is here, so that it is tested on a PC.

/** What the calibration at the start of a CV, SWV or BioFET run found. */
struct AmperometryCalResult {
  bool attempted = false;        // the calibration was asked for (the app can switch it off)
  bool pgaCalibrated = false;    // ADC PGA offset and gain calibration for PGA 1 succeeded
  bool rtiaCalibrated = false;   // RTIA measured against RCAL, and within kRtiaMaxDeviation of nominal
  float rtiaNominalOhms = 0.0f;
  float rtiaOhms = 0.0f;         // what to convert with: calibrated, or nominal when it is not
  bool zeroMeasured = false;     // the reading with the cell disconnected was measured
  float zeroVolt = 0.0f;         // that reading (HSTIA output minus its zero), subtracted from every reading
  float currentOffsetUa = 0.0f;  // the same, as a current at rtiaOhms, for the report
  bool lpdacCalibrated = false;  // the LPDAC code to voltage transfer functions were measured
  float vzeroV = 1.3f;           // real Vzero: measured, or the nominal 1.3 V
  bool potentialMeasured = false;
  float biasOffsetMv = 0.0f;     // V(RE0) - V(SE0) measured, minus the bias that was programmed, at the start bias
  float potentialOffsetMv = 0.0f;// the same as an offset of E(WE) vs RE (minus biasOffsetMv), for CV and SWV
  char note[160] = {0};          // what failed or was skipped, one line (empty when everything worked)
};

constexpr float kRtiaMaxDeviation = 0.30f;       // beyond this from nominal, a calibrated RTIA is not believed
constexpr float kPotentialOffsetMaxMv = 150.0f;  // beyond this, the measured potential offset is not believed
constexpr float kVzeroNominalV = 1.3f;           // 0.2 V + 32 * 34.375 mV, the 6-bit code the firmware programs
constexpr float kVzeroMaxDeviationV = 0.15f;     // a measured Vzero further than this from nominal is not believed
constexpr float kHstiaOutMinV = 0.2f;            // usable window of the HSTIA output for the ADC
constexpr float kHstiaOutMaxV = 2.1f;

inline bool rtiaPlausible(float measuredOhms, float nominalOhms) {
  if (!(measuredOhms > 0.0f) || !(nominalOhms > 0.0f) || !isfinite(measuredOhms)) return false;
  return fabsf(measuredOhms - nominalOhms) <= kRtiaMaxDeviation * nominalOhms;
}

// The current of a reading, in uA: the HSTIA output (relative to Vzero) minus the
// reading with the cell disconnected, over the RTIA.
inline float amperometryCurrentUa(float diffVolt, float zeroVolt, float rtiaOhms) {
  return ((diffVolt - zeroVolt) / rtiaOhms) * 1.0e6f;
}

// The window check used for the "out of range" flag: the HSTIA output sits at
// Vzero + diffVolt, and has to stay inside the 0.2 to 2.1 V of the ADC. It used to
// assume Vzero = 1.1 V, but the 6-bit code the firmware programs gives 1.3 V.
inline bool hstiaOutOfWindow(float vzeroV, float diffVolt) {
  const float out = vzeroV + diffVolt;
  return out < kHstiaOutMinV || out > kHstiaOutMaxV;
}

inline float vzeroFromTransferV(float bC2V_mV, float kC2V_mV, int code6) {
  return (bC2V_mV + kC2V_mV * (float)code6) / 1000.0f;
}

// The 12-bit LPDAC code that gives Vbias = Vzero + biasMv, from the measured
// transfer function V(mV) = k * code + b, clamped to the 12-bit range.
inline int lpdacCode12(float vzeroV, float biasMv, float kC2V_mV, float bC2V_mV) {
  const float targetMv = vzeroV * 1000.0f + biasMv;
  const float code = (targetMv - bC2V_mV) / kC2V_mV;
  if (!(code > 0.0f)) return 0;
  if (code > 4095.0f) return 4095;
  return (int)(code + 0.5f);
}

// Measured potential offset: what V(RE0) - V(SE0) read, minus the bias that was
// programmed. The bias that is applied afterwards is the requested one minus this.
inline float biasOffsetMvFrom(float vre0V, float vse0V, float programmedBiasMv) {
  return (vre0V - vse0V) * 1000.0f - programmedBiasMv;
}
inline bool potentialOffsetPlausible(float offsetMv) {
  return isfinite(offsetMv) && fabsf(offsetMv) <= kPotentialOffsetMaxMv;
}
inline float correctedBiasMv(float biasMv, float biasOffsetMv) {
  float b = biasMv - biasOffsetMv;
  if (b < -kLpdacBiasLimitMv) b = -kLpdacBiasLimitMv;
  if (b >  kLpdacBiasLimitMv) b =  kLpdacBiasLimitMv;
  return b;
}

// ── EIS low-signal check ─────────────────────────────────────────
// HELPStat computes Rz = (DFT Cal / DFT Mag) * RCAL, where the two magnitudes
// are DFT results in counts. With 1 or 2 counts in either one the quantization
// alone is 50 to 100 % of the value, so the impedance means nothing: a cell of
// 1 kOhm gave about 80 kOhm from DFT Mag = 1, and once a point of 4.7 MOhm. At 5
// counts the quantization is at most 20 %, and the points that carry a real
// signal in the logs had 5 counts or more (DFT Cal 5.0 at the lowest, DFT Mag 48
// or more), so 5 separates the two. A point below it is flagged, not removed.
constexpr float kEisMinDftCounts = 5.0f;

inline bool eisLowSignal(float dftCal, float dftMag) {
  // written as a negation so that a NaN counts as low signal
  return !(dftCal >= kEisMinDftCounts && dftMag >= kEisMinDftCounts);
}

// ── EIS excitation amplitude ─────────────────────────────────────
// The sine that AD5940_TDD is told to generate is attenuated twice before it
// reaches the cell: by the excitation buffer and by the HS DAC. AD5940_TDD takes
// the two gains as the selector values of ad5940.h, where
//   EXCITBUFGAIN_2 = 0 (x2)     EXCITBUFGAIN_0P25 = 1 (x0.25)
//   HSDACGAIN_1    = 0 (x1)     HSDACGAIN_0P2     = 1 (x0.2)
// so with selectors 1 and 1 the cell sees generator * 0.25 * 0.2 = generator / 20.
// The app asks for the amplitude AT THE CELL, so the generator amplitude is that
// divided by both gains. The generator itself tops out at 800 mV
// (SinAmplitudeWord = amplitude / 800 * 2047).
constexpr int   kEisExtGainSel = 1;        // EXCITBUFGAIN_0P25
constexpr int   kEisDacGainSel = 1;        // HSDACGAIN_0P2
constexpr float kEisGeneratorMaxMv = 800.0f;

inline float excitBufGainFactor(int sel) { return sel == 1 ? 0.25f : 2.0f; }
inline float hsDacGainFactor(int sel)    { return sel == 1 ? 0.2f : 1.0f; }

struct EisAmplitude {
  float generatorMv;   // what to give AD5940_TDD as amplitudeMv
  float cellMv;        // what the cell receives (the requested value, unless clamped)
  float extGain;       // factors actually applied, for logging
  float dacGain;
  bool clamped;        // the request exceeded what the generator can deliver
};

// Largest amplitude the cell can receive with the given gain selectors.
inline float eisCellMaxMv(int extGainSel, int dacGainSel) {
  return kEisGeneratorMaxMv * excitBufGainFactor(extGainSel) * hsDacGainFactor(dacGainSel);
}

// `requestedCellMv` must be > 0 (callers reject anything else). A request above
// eisCellMaxMv() is clamped to it.
inline EisAmplitude eisAmplitude(float requestedCellMv, int extGainSel, int dacGainSel) {
  EisAmplitude a;
  a.extGain = excitBufGainFactor(extGainSel);
  a.dacGain = hsDacGainFactor(dacGainSel);
  const float attenuation = a.extGain * a.dacGain;
  a.generatorMv = requestedCellMv / attenuation;
  a.clamped = a.generatorMv > kEisGeneratorMaxMv;
  if (a.clamped) a.generatorMv = kEisGeneratorMaxMv;
  a.cellMv = a.generatorMv * attenuation;
  return a;
}

}  // namespace estat

// A sweep point waiting in the outbox (see ElectroStat_Firmware.ino). Declared
// here, not in the .ino, because functions that take it need the type before
// the IDE's auto-generated prototypes.
enum PointKind : uint8_t { PK_CV, PK_SWV, PK_FET_TRANSFER, PK_FET_TIME };
struct PendingPoint {
  uint8_t kind;
  float a, b, c, d;   // payload, see sendPending()
  int32_t i0;
  bool oor;
  const char *s;      // branch / direction / curve; valid until the handler returns
};
