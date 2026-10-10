// Minimal host stand-ins for the Arduino API, just enough to compile and run
// ElectroStat_Firmware.ino on a PC against a virtual clock (see sim_main.cpp).
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include <deque>
#include <algorithm>

// ---- virtual time ---------------------------------------------------------
extern uint64_t g_clock_us;   // advances only when the firmware waits or "works"
extern uint32_t g_epoch_us;   // micros() = g_epoch_us + g_clock_us (lets a test cross the 32-bit rollover)
extern uint32_t g_delay_jitter_us;  // extra time a delay() overshoots by (FreeRTOS tick)
inline uint32_t micros() { return (uint32_t)(g_epoch_us + g_clock_us); }
inline unsigned long millis() { return (unsigned long)(micros() / 1000u); }
void sim_advance(uint64_t us);
inline void delay(unsigned long ms) { sim_advance((uint64_t)ms * 1000u + (ms ? g_delay_jitter_us : 0)); }
inline void delayMicroseconds(unsigned int us) { sim_advance(us); }

#define max(a, b) (((a) > (b)) ? (a) : (b))
#define min(a, b) (((a) < (b)) ? (a) : (b))

class String {
 public:
  std::string s;
  String() {}
  String(const char *c) : s(c ? c : "") {}
  String(const std::string &x) : s(x) {}
  String(unsigned long v) : s(std::to_string(v)) {}
  String &operator=(const char *c) { s = c ? c : ""; return *this; }
  bool concat(const char *c) { if (c) s += c; return true; }
  unsigned int length() const { return (unsigned)s.size(); }
  const char *c_str() const { return s.c_str(); }
  void trim() {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    s = (a == std::string::npos) ? "" : s.substr(a, b - a + 1);
  }
  String operator+(const String &o) const { return String(s + o.s); }
  String operator+(const char *o) const { return String(s + o); }
  friend String operator+(const char *a, const String &b) { return String(std::string(a) + b.s); }
};

// Lines scripted to arrive on a channel at a virtual time.
struct Incoming { uint64_t atUs; std::string line; };

class IPAddress { public: IPAddress() {} };
class SerialClass {
 public:
  std::deque<Incoming> incoming;
  uint32_t usPerByte = 0;   // 87 models a 115200-baud UART; 0 a native USB CDC
  void begin(unsigned long) {}
  void println(const char *c) { std::printf("  [serial] %s\n", c); }
  void println(const String &str);
  void println(const std::string &str) { println(str.c_str()); }
  void println(const IPAddress &) {}
  void print(const IPAddress &) {}
  void print(const char *c) { std::printf("%s", c); }
  void print(const String &str) { std::printf("%s", str.c_str()); }
  void print(float v) { std::printf("%g", v); }
  void print(unsigned v) { std::printf("%u", v); }
  void printf(const char *fmt, ...) __attribute__((format(printf, 2, 3)));
  int available();
  String readStringUntil(char);
};
extern SerialClass Serial;
inline void sim_unused() {}
