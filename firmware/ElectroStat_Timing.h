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
