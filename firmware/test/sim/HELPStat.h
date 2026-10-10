// Host stand-in for the AD5941 driver: every call just costs virtual time.
#pragma once
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
struct impStruct { float freq, real, imag, magnitude, phaseDeg; };
typedef void (*EisPointCallback)(const impStruct &);

struct ReadLog { uint32_t atUs; float biasMv; };
extern std::vector<ReadLog> g_reads;     // when each read ended and at which potential
extern uint32_t g_spi_us;                // cost of SetBias
extern uint32_t g_read_us;               // cost of one ADC read
extern float g_biasMv;

class HELPStat {
 public:
  void setEisPointCallback(EisPointCallback) {}
  void AD5940Start() {}
  template <typename... A> void AD5940_TDD(A...) {}
  void runSweep() {}
  void AD5940_AmperometrySetup(uint32_t) { sim_advance(20000); }
  void AD5940_AmperometrySetBias(float mv) { sim_advance(g_spi_us); g_biasMv = mv; }
  float AD5940_AmperometryRead(float rtiaOhms, bool *outOfRange = nullptr) {
    sim_advance(g_read_us);
    g_reads.push_back({micros(), g_biasMv});
    if (outOfRange) *outOfRange = false;
    return g_biasMv / 1000.0f * 10.0f;   // any deterministic function of the bias
  }
  float AD5940_AmperometryStep(float mv, float rtia, bool *oor = nullptr, uint16_t settleMs = 5) {
    AD5940_AmperometrySetBias(mv); delay(settleMs); return AD5940_AmperometryRead(rtia, oor);
  }
};
