// Host-side test of ElectroStat_Timing.h (no Arduino needed).
//   zig c++ -std=c++17 -I.. timing_test.cpp -o timing_test && ./timing_test
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include "ElectroStat_Timing.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL line %d: %s\n", __LINE__, #cond); failures++; } } while (0)

int main() {
  using namespace estat;

  // -- wrap-safe comparisons around the 32-bit rollover of micros() --
  CHECK(reached(100, 100));
  CHECK(!reached(99, 100));
  CHECK(!reached(0xFFFFFF00u, 0x00000100u));   // deadline is 512 us ahead, across the wrap
  CHECK(reached(0x00000100u, 0xFFFFFF00u));    // and 512 us behind once the wrap has passed
  CHECK(remainingUs(0xFFFFFF00u, 0x00000100u) == 512);
  CHECK(remainingUs(0x00000100u, 0xFFFFFF00u) == -512);

  // -- absolute deadlines do not drift under per-step overhead --
  // 100 mV/s with a 2 mV step is a 20 ms slot. Each step "costs" 7 ms of
  // work plus a variable send time; a drifting loop (work + delay(20)) would
  // be 35 % slow, deadlines computed from t0 must not be.
  {
    uint32_t period = periodFromScanRate(2.0f, 100.0f);
    CHECK(period == 20000u);
    StepClock clk; clk.begin(1234567u, period);
    uint32_t now = clk.t0Us - 1000u;                      // a moment before the first slot
    int lateSlots = 0;
    for (uint32_t k = 0; k < 800; k++) {
      uint32_t due = clk.due(k);
      if (!reached(now, due)) now = due;                  // wait for the slot
      else lateSlots++;
      uint32_t work = 7000u + (k % 5u) * 1000u;           // 7-11 ms of apply + read + send
      now += work;
      CHECK(due == clk.t0Us + k * 20000u);
    }
    CHECK(lateSlots == 0);
    CHECK(clk.due(799) - clk.t0Us == 799u * 20000u);      // 15.98 s, exactly, no accumulated error
  }

  // -- the same sweep started just before the micros() rollover --
  {
    StepClock clk; clk.begin(0xFFFFF000u, 20000u);
    uint32_t now = clk.t0Us;
    for (uint32_t k = 0; k < 100; k++) {
      uint32_t due = clk.due(k);
      if (!reached(now, due)) now = due;
      CHECK(reached(now, due));
      CHECK(remainingUs(due, clk.due(k + 1)) == 20000);
      now += 9000u;
    }
  }

  // -- slot planning: refuses what the read path cannot do --
  {
    uint32_t conv = convEstimateUs(3500u);                 // 3500 + 437 + 100 = 4037
    CHECK(conv == 4037u);
    SlotPlan fine = planSlot(periodFromScanRate(2.0f, 100.0f), 5000u, conv, 300u);
    CHECK(fine.ok);
    SlotPlan tooFast = planSlot(periodFromScanRate(2.0f, 500.0f), 5000u, conv, 300u);  // 4 ms slot
    CHECK(!tooFast.ok);
    CHECK(tooFast.minPeriodUs == 9337u);
    float maxRate = maxScanRate_mVs(2.0f, tooFast.minPeriodUs);
    CHECK(std::fabs(maxRate - 214.2f) < 0.5f);             // what the error message would quote
    // a larger step makes 500 mV/s reachable
    CHECK(planSlot(periodFromScanRate(5.0f, 500.0f), 5000u, conv, 300u).ok);
  }
  {
    uint32_t conv = convEstimateUs(3500u);
    uint32_t half25 = halfPeriodFromFrequency(25.0f);      // 20 ms
    CHECK(half25 == 20000u);
    CHECK(planSlot(half25, 5000u, conv, 300u).ok);
    CHECK(readOffsetUs(half25, conv, 300u) == 20000u - 4037u - 300u);
    uint32_t half100 = halfPeriodFromFrequency(100.0f);    // 5 ms
    CHECK(!planSlot(half100, 5000u, conv, 300u).ok);
    float fmax = maxFrequencyHz(planSlot(half100, 5000u, conv, 300u).minPeriodUs);
    CHECK(std::fabs(fmax - 53.5f) < 0.5f);
  }

  // -- the read is placed so that it ends before the slot does --
  {
    uint32_t period = 20000u, conv = 4037u, guard = 300u;
    uint32_t off = readOffsetUs(period, conv, guard);
    CHECK(off + conv + guard == period);
    CHECK(off >= 5000u);                                    // leaves the settling time
  }

  // -- EIS low signal: below kEisMinDftCounts (5) in either DFT magnitude --
  {
    CHECK(kEisMinDftCounts == 5.0f);
    CHECK(eisLowSignal(4.0f, 80.0f));        // 4 counts in the RCAL: low
    CHECK(eisLowSignal(8.0f, 4.0f));         // 4 counts in the cell: low
    CHECK(!eisLowSignal(5.0f, 5.0f));        // 5 counts is enough
    CHECK(!eisLowSignal(5.0f, 80.0f));
    CHECK(eisLowSignal(1.0f, 1.0f));         // either low is enough, both too
    CHECK(eisLowSignal(0.0f, 80.0f) && eisLowSignal(8.0f, 0.0f));
    CHECK(eisLowSignal(NAN, 80.0f) && eisLowSignal(8.0f, NAN));   // an unknown count is not trusted
    CHECK(!eisLowSignal(7.071f, 68.154f));   // the first valid point of the log
    CHECK(eisLowSignal(8.062f, 1.0f));       // the 80 kOhm point of the log, from DFT Mag = 1
  }

  // -- potential convention: E(WE vs RE) in, LPDAC bias out (the hardware gives
  //    E = Vzero - Vbias, so the bias is minus E), clamped to +-1100 mV --
  {
    CHECK(lpdacBiasMvFromE(0.0f) == 0.0f);
    CHECK(!std::signbit(lpdacBiasMvFromE(0.0f)));              // no negative zero
    CHECK(lpdacBiasMvFromE(100.0f) == -100.0f);                // a positive potential is a negative bias
    CHECK(lpdacBiasMvFromE(-500.0f) == 500.0f);
    CHECK(lpdacBiasMvFromE(1100.0f) == -1100.0f);              // the clamp is symmetric
    CHECK(lpdacBiasMvFromE(-1100.0f) == 1100.0f);
    CHECK(lpdacBiasMvFromE(1500.0f) == -1100.0f);              // beyond the range it clips, not wraps
    CHECK(lpdacBiasMvFromE(-2000.0f) == 1100.0f);
    // converting twice returns the potential (it is its own inverse inside the range)
    for (float e = -1100.0f; e <= 1100.0f; e += 37.0f) CHECK(lpdacBiasMvFromE(lpdacBiasMvFromE(e)) == e);
  }

  // -- statistics --
  {
    SweepStats st;
    uint32_t t = 100000u;
    for (int k = 0; k < 101; k++) {
      st.note(t, k == 50 ? 900 : 40, 3600u, 500);
      t += 20000u;
    }
    CHECK(st.n == 101u);
    CHECK(st.late == 1u);
    CHECK(st.maxLagUs == 900);
    CHECK(st.maxReadUs == 3600u);
    CHECK(std::fabs(st.meanPeriodS() - 0.020f) < 1e-6f);   // 100 mV/s with a 2 mV step
    SweepStats one; one.note(5u, 0, 1u, 500);
    CHECK(one.meanPeriodS() == 0.0f);
  }

  // -- degenerate inputs stay finite --
  CHECK(periodFromScanRate(2.0f, 1.0e9f) >= 1u);
  CHECK(periodFromScanRate(50.0f, 0.001f) == 2000000000u);

  // -- EIS excitation: the app asks for mV at the cell, the generator is told
  //    mV before the two attenuations (excitation buffer x0.25, HS DAC x0.2) --
  {
    auto near = [](float a, float b) { return std::fabs(a - b) < 1e-3f; };
    // the selectors the firmware passes to AD5940_TDD stand for x0.25 and x0.2
    CHECK(near(excitBufGainFactor(kEisExtGainSel), 0.25f));
    CHECK(near(hsDacGainFactor(kEisDacGainSel), 0.2f));
    CHECK(near(eisCellMaxMv(kEisExtGainSel, kEisDacGainSel), 40.0f));

    EisAmplitude a = eisAmplitude(10.0f, kEisExtGainSel, kEisDacGainSel);   // the default
    CHECK(near(a.generatorMv, 200.0f));       // the 200 mV the original HELPStat firmware used
    CHECK(near(a.cellMv, 10.0f));
    CHECK(!a.clamped);

    a = eisAmplitude(40.0f, kEisExtGainSel, kEisDacGainSel);                // the limit
    CHECK(near(a.generatorMv, 800.0f));
    CHECK(near(a.cellMv, 40.0f));
    CHECK(!a.clamped);

    a = eisAmplitude(50.0f, kEisExtGainSel, kEisDacGainSel);                // above the limit
    CHECK(a.clamped);
    CHECK(near(a.generatorMv, 800.0f));       // never above the generator's range
    CHECK(near(a.cellMv, 40.0f));             // the amplitude actually applied

    a = eisAmplitude(200.0f, kEisExtGainSel, kEisDacGainSel);               // the app's old maximum
    CHECK(a.clamped && near(a.cellMv, 40.0f));

    // changing the gains keeps the conversion right: x2 buffer and x1 DAC (selectors 0, 0)
    a = eisAmplitude(10.0f, 0, 0);
    CHECK(near(a.generatorMv, 5.0f));
    CHECK(near(eisCellMaxMv(0, 0), 1600.0f));
  }

  if (failures == 0) std::printf("timing_test: all checks passed\n");
  return failures == 0 ? 0 : 1;
}
