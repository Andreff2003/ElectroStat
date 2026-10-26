// Host stand-in for the AD5941 driver: every call just costs virtual time.
#pragma once
#include <limits>
#include "Arduino.h"
#include "SD.h"
#define HSTIARTIA_200 1
#define HSTIARTIA_1K 2
#define HSTIARTIA_5K 3
#define HSTIARTIA_10K 4
#define HSTIARTIA_20K 5
#define HSTIARTIA_40K 6
#define HSTIARTIA_80K 7
#define HSTIARTIA_160K 8
#define CS_SD 5
struct calHSTIA { float maxFreq; uint32_t rtia; };
struct impStruct { float freq, real, imag, magnitude, phaseDeg; float dftCal, dftMag; int rtiaSel; };
typedef void (*EisPointCallback)(const impStruct &);
typedef bool (*EisAbortCheck)(void);

struct ReadLog { uint32_t atUs; float biasMv; };
extern std::vector<ReadLog> g_reads;     // when each read ended and at which potential
extern uint32_t g_spi_us;                // cost of SetBias
extern uint32_t g_read_us;               // cost of one ADC read
extern float g_biasMv;

// EIS sweep stand-in: how many points, how long each takes, which one comes
// back as NaN (-1 for none), and how many times the AFE was shut down.
extern int g_eis_points;
extern uint32_t g_eis_us_per_point;
extern int g_eis_nan_at;
extern int g_eis_low_at;   // index of a finite point with 1 DFT count (-1 for none)
extern int g_shutdowns;
// Amperometric AFE state: on after AD5940_AmperometrySetup(), off after AD5940_AmperometryShutDown().
extern bool g_afe_on;
extern int g_afe_off_calls;
extern int g_afe_misuse;       // a bias set or a read done while the AFE was off
extern uint64_t g_afe_off_at;  // virtual time of the last shutdown

// The AD5941 identification registers; the real ones come from ad5940.h.
inline void AD5940_HWReset() {}
inline void AD5940_Initialize() {}
inline uint32_t AD5940_GetADIID() { return 0x4144; }
inline uint32_t AD5940_GetChipID() { return 0x5502; }

class HELPStat {
 public:
  void setEisPointCallback(EisPointCallback cb) { _onPoint = cb; }
  void setEisAbortCheck(EisAbortCheck cb) { _abortCheck = cb; }
  bool eisSweepAborted() const { return _aborted; }
  void AD5940Start() {}
  template <typename... A> void AD5940_TDD(A...) {}
  // Follows the contract of HELPStat::runSweep() in the real library: check
  // for an abort at the start of the cycle, then after each point (the point
  // has been delivered by then), and always shut the AFE down at the end.
  // The loop itself is NOT the real code (that needs the AD5941), so the test
  // covers the firmware around it and not the library.
  void runSweep() {
    _aborted = false;
    if (_abortCheck && _abortCheck()) _aborted = true;
    for (int i = 0; i < g_eis_points && !_aborted; i++) {
      sim_advance(g_eis_us_per_point);
      float nan = std::numeric_limits<float>::quiet_NaN();
      impStruct p = (i == g_eis_nan_at)
          ? impStruct{1000.0f / (i + 1), nan, nan, std::numeric_limits<float>::infinity(), nan, 7.0f, 0.0f, HSTIARTIA_200}
          : (i == g_eis_low_at)
          ? impStruct{1000.0f / (i + 1), 80000.0f, 9980.0f, 80600.0f, 7.0f, 8.0f, 1.0f, HSTIARTIA_200}
          : impStruct{1000.0f / (i + 1), 1000.0f, -50.0f, 1001.0f, -2.9f, 8.0f, 80.0f, HSTIARTIA_200};
      if (_onPoint) _onPoint(p);
      if (_abortCheck && _abortCheck()) _aborted = true;
    }
    g_shutdowns++;
  }
  EisPointCallback _onPoint = nullptr;
  EisAbortCheck _abortCheck = nullptr;
  bool _aborted = false;
  void AD5940_AmperometrySetup(uint32_t) { sim_advance(20000); g_afe_on = true; }
  void AD5940_AmperometryShutDown() { sim_advance(300); g_afe_on = false; g_afe_off_calls++; g_afe_off_at = g_clock_us; }
  void AD5940_AmperometrySetBias(float mv) { if (!g_afe_on) g_afe_misuse++; sim_advance(g_spi_us); g_biasMv = mv; }
  float AD5940_AmperometryRead(float rtiaOhms, bool *outOfRange = nullptr) {
    if (!g_afe_on) g_afe_misuse++;
    sim_advance(g_read_us);
    g_reads.push_back({micros(), g_biasMv});
    if (outOfRange) *outOfRange = false;
    return g_biasMv / 1000.0f * 10.0f;   // any deterministic function of the bias
  }
  float AD5940_AmperometryStep(float mv, float rtia, bool *oor = nullptr, uint16_t settleMs = 5) {
    AD5940_AmperometrySetBias(mv); delay(settleMs); return AD5940_AmperometryRead(rtia, oor);
  }
};
