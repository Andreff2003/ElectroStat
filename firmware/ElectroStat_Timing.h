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

}  // namespace estat
