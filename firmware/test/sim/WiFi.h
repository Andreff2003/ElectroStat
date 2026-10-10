#pragma once
#include "Arduino.h"
// One JSON line as the bridge would receive it.
struct SentLine { uint64_t atUs; std::string line; };
extern std::vector<SentLine> g_sent;
extern std::vector<std::string> g_logs;
extern uint32_t g_tcp_us_per_call;
class WiFiClient {
 public:
  std::deque<Incoming> incoming;
  explicit operator bool() const { return true; }
  bool connected() { return true; }
  int available();
  String readStringUntil(char);
  void print(const String &str);
  void print(char c);
};
class WiFiServer {
 public:
  explicit WiFiServer(uint16_t) {}
  void begin() {}
  WiFiClient available() { return WiFiClient(); }
};
#define WIFI_AP 1
class WiFiClass {
 public:
  void mode(int) {}
  void softAP(const char *, const char *) {}
  IPAddress softAPIP() { return IPAddress(); }
};
extern WiFiClass WiFi;
inline void print_ip_stub() {}
