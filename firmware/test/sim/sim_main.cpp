// Runs the real ElectroStat_Firmware.ino on a PC against a virtual clock, with
// the AD5941 replaced by a stand-in that only costs time. It checks the control
// flow and the schedule of the CV, BioFET and SWV sweeps. It says nothing about
// the AD5941 itself: settling, the real read time and the analog behavior need
// the board (see firmware/test/README.md).
#include "Arduino.h"
#include "WiFi.h"
#include "SD.h"
#include "HELPStat.h"
#include <ArduinoJson.h>

uint64_t g_clock_us = 0;
uint32_t g_epoch_us = 0;
uint32_t g_delay_jitter_us = 0;
SerialClass Serial;
WiFiClass WiFi;
SDClass SD;
std::vector<SentLine> g_sent;
std::vector<std::string> g_logs;
uint32_t g_tcp_us_per_call = 300;
std::vector<ReadLog> g_reads;
uint32_t g_spi_us = 150;
uint32_t g_read_us = 3500;
float g_biasMv = 0;

void sim_advance(uint64_t us) { g_clock_us += us; }
void SerialClass::println(const String &str) { sim_advance((uint64_t)usPerByte * (str.length() + 2)); }
void SerialClass::printf(const char *fmt, ...) {
  char buf[400];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  std::string m(buf);
  while (!m.empty() && (m.back() == '\n' || m.back() == '\r')) m.pop_back();
  g_logs.push_back(m);
}
int SerialClass::available() { return (!incoming.empty() && incoming.front().atUs <= g_clock_us) ? 1 : 0; }
String SerialClass::readStringUntil(char) {
  String r(incoming.front().line.c_str());
  incoming.pop_front();
  return r;
}
int WiFiClient::available() { return (!incoming.empty() && incoming.front().atUs <= g_clock_us) ? 1 : 0; }
String WiFiClient::readStringUntil(char) {
  String r(incoming.front().line.c_str());
  incoming.pop_front();
  return r;
}
void WiFiClient::print(const String &str) {
  sim_advance(g_tcp_us_per_call);
  if (!str.s.empty() && str.s[0] == '{') g_sent.push_back({g_clock_us, str.s});
}
void WiFiClient::print(char) { sim_advance(g_tcp_us_per_call); }

#include "ElectroStat_Firmware_copy.cpp"

// ------------------------------------------------------------------ helpers
static int failures = 0, checks = 0;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; std::printf("  FAIL line %d: %s  ", __LINE__, #cond); std::printf("" __VA_ARGS__); std::printf("\n"); } } while (0)

static void reset(uint32_t epoch = 0, uint32_t serialUsPerByte = 0, uint32_t jitter = 0) {
  g_clock_us = 0;
  g_epoch_us = epoch;
  g_delay_jitter_us = jitter;
  Serial.usPerByte = serialUsPerByte;
  Serial.incoming.clear();
  tcpClient.incoming.clear();
  g_sent.clear();
  g_logs.clear();
  g_reads.clear();
  outboxHead = outboxCount = 0;
  abortRequested = false;
  sweepActive = false;
}

struct Msg {
  std::string type;
  JsonDocument doc;
  uint64_t atUs;
};
static std::vector<Msg> parse(const char *typePrefix = "") {
  std::vector<Msg> out;
  for (auto &l : g_sent) {
    Msg m;
    m.atUs = l.atUs;
    if (deserializeJson(m.doc, l.line)) continue;
    m.type = (const char *)(m.doc["type"] | "");
    if (m.type.rfind(typePrefix, 0) == 0) out.push_back(std::move(m));
  }
  return out;
}
static const Msg *findType(const std::vector<Msg> &v, const char *t) {
  for (auto &m : v) if (m.type == t) return &m;
  return nullptr;
}
static std::string lastStatus(const std::vector<Msg> &v, const char *t) {
  std::string s;
  for (auto &m : v) if (m.type == t) s = (const char *)(m.doc["status"] | "");
  return s;
}
static void run(const char *json) {
  String line(json);
  dispatchCommand(line);
}

static const char *CV_DEFAULT = "{\"command\":\"start_cv\",\"eStart\":0.6,\"eVertex1\":-0.2,\"eVertex2\":0.6,\"nCycles\":1,\"stepMv\":2,\"scanRate\":100,\"quietTime\":0,\"rtiaOhms\":10000}";
static const char *SWV_DEFAULT = "{\"command\":\"start_swv\",\"startE\":-0.2,\"endE\":0.6,\"step_mV\":2,\"amplitude_mV\":25,\"frequency_Hz\":25,\"quietTime_s\":2,\"direction\":\"anodic\",\"rtiaOhms\":10000}";
static const char *FET_DEFAULT = "{\"command\":\"start_fet\",\"vgMin\":-0.5,\"vgMax\":1.5,\"vgStep\":0.04,\"intervalMs\":200,\"concentration\":0,\"readoutBias_V\":1.0,\"timeDuration_s\":60,\"timeStep_s\":0.5,\"rtiaOhms\":10000}";

// A CV run that kept its schedule: N points, constant spacing, no late slot.
static void checkCvOnSchedule(double expectScanRate, int expectPoints) {
  auto msgs = parse();
  auto data = parse("cv_data");
  CHECK((int)data.size() == expectPoints, "got %d points, expected %d", (int)data.size(), expectPoints);
  auto *done = findType(msgs, "cv_done");
  CHECK(done != nullptr);
  if (!done) return;
  CHECK(done->doc["lateCount"].as<int>() == 0, "lateCount=%d", done->doc["lateCount"].as<int>());
  double rate = done->doc["achievedScanRate_mVs"].as<double>();
  CHECK(std::fabs(rate - expectScanRate) < 0.002 * expectScanRate, "achieved %.3f mV/s", rate);
  double worst = 0;
  for (size_t i = 1; i < data.size(); i++) {
    double dt = data[i].doc["t"].as<double>() - data[i - 1].doc["t"].as<double>();
    worst = (std::max)(worst, std::fabs(dt - 2.0 / expectScanRate));
  }
  CHECK(worst < 1e-4, "worst spacing error %.6f s", worst);
  CHECK(lastStatus(msgs, "cv_status") == "done");
}

int main() {
  setup();

  std::printf("T1  CV 100 mV/s, 2 mV step, native USB serial\n");
  reset();
  run(CV_DEFAULT);
  checkCvOnSchedule(100.0, 801);
  CHECK(!sweepActive && !cvSweepInProgress);
  CHECK(g_reads.size() >= 801 + 3);   // 3 calibration reads precede the sweep

  std::printf("T2  same CV with a 115200-baud UART echo and 0.9 ms of delay() overshoot\n");
  reset(0, 87, 900);
  run(CV_DEFAULT);
  checkCvOnSchedule(100.0, 801);

  std::printf("T3  CV across the 71-minute micros() rollover\n");
  reset(0xFFFFFFFFu - 5000000u);
  run(CV_DEFAULT);
  checkCvOnSchedule(100.0, 801);

  std::printf("T4  CV too fast for the read path is refused, naming the limit\n");
  reset();
  run("{\"command\":\"start_cv\",\"eStart\":0.6,\"eVertex1\":-0.2,\"eVertex2\":0.6,\"nCycles\":1,\"stepMv\":2,\"scanRate\":500,\"quietTime\":0,\"rtiaOhms\":10000}");
  {
    auto msgs = parse();
    auto *err = findType(msgs, "cv_error");
    CHECK(err != nullptr);
    if (err) std::printf("      message: %s\n", err->doc["message"].as<const char *>());
    CHECK(parse("cv_data").empty());
    CHECK(findType(msgs, "cv_status") == nullptr);   // never announced "running"
    CHECK(!cvSweepInProgress && !sweepActive);
  }
  std::printf("    ...and a valid sweep still runs afterwards\n");
  reset();
  run(CV_DEFAULT);
  checkCvOnSchedule(100.0, 801);

  std::printf("T5  stop received over WiFi 3 s into a CV\n");
  reset();
  tcpClient.incoming.push_back({3000000u, "{\"command\":\"stop\"}"});
  run(CV_DEFAULT);
  {
    auto msgs = parse();
    auto data = parse("cv_data");
    CHECK(findType(msgs, "cv_done") == nullptr);
    CHECK(lastStatus(msgs, "cv_status") == "idle");
    CHECK(data.size() > 100 && data.size() < 200, "delivered %d points", (int)data.size());
    CHECK(!sweepActive && !abortRequested && !cvSweepInProgress);
    double stopLatency = (double)g_clock_us / 1e6 - 3.0;
    CHECK(stopLatency < 0.2, "stopped %.3f s after the command (the sweep started ~0.1 s in)", stopLatency);
  }
  std::printf("    ...stop over USB serial, and a later sweep is unaffected\n");
  reset();
  Serial.incoming.push_back({1000000u, "{\"command\":\"stop\"}"});
  run(CV_DEFAULT);
  CHECK(findType(parse(), "cv_done") == nullptr);
  reset();
  run(CV_DEFAULT);
  checkCvOnSchedule(100.0, 801);

  std::printf("T6  SWV 25 Hz, 2 mV step, 2 s quiet time\n");
  reset();
  run(SWV_DEFAULT);
  {
    auto msgs = parse();
    auto data = parse("swv_data");
    auto *done = findType(msgs, "swv_done");
    CHECK(data.size() == 401, "got %d points", (int)data.size());
    CHECK(done != nullptr);
    if (done) {
      CHECK(done->doc["lateCount"].as<int>() == 0);
      double f = done->doc["achievedFrequency_Hz"].as<double>();
      CHECK(std::fabs(f - 25.0) < 0.05, "achieved %.3f Hz", f);
    }
    double worst = 0;
    for (size_t i = 1; i < data.size(); i++)
      worst = (std::max)(worst, std::fabs(data[i].doc["time"].as<double>() - data[i - 1].doc["time"].as<double>() - 0.04));
    CHECK(worst < 1e-4, "worst step spacing error %.6f s", worst);
    CHECK(std::fabs(data[0].doc["time"].as<double>() - 2.0) < 0.1, "first point at %.3f s", data[0].doc["time"].as<double>());
    CHECK(data[10].doc["INet"].as<double>() != 0.0);
  }

  std::printf("T7  SWV at 100 Hz is refused (a half-pulse of 5 ms cannot hold the read)\n");
  reset();
  run("{\"command\":\"start_swv\",\"startE\":-0.2,\"endE\":0.6,\"step_mV\":2,\"amplitude_mV\":25,\"frequency_Hz\":100,\"quietTime_s\":0,\"direction\":\"anodic\",\"rtiaOhms\":10000}");
  {
    auto msgs = parse();
    auto *err = findType(msgs, "swv_error");
    CHECK(err != nullptr);
    if (err) std::printf("      message: %s\n", err->doc["message"].as<const char *>());
    CHECK(parse("swv_data").empty());
  }

  std::printf("T8  BioFET: 51 transfer points at 200 ms, 121 time points at 0.5 s\n");
  reset();
  run(FET_DEFAULT);
  {
    auto msgs = parse();
    auto tr = parse("fet_transfer");
    auto tm = parse("fet_time");
    auto *done = findType(msgs, "fet_done");
    CHECK(tr.size() == 51, "transfer %d", (int)tr.size());
    CHECK(tm.size() == 121, "time %d", (int)tm.size());
    CHECK(done != nullptr);
    if (done) CHECK(done->doc["lateCount"].as<int>() == 0);
    double worst = 0;
    for (size_t i = 1; i < tm.size(); i++)
      worst = (std::max)(worst, std::fabs(tm[i].doc["time"].as<double>() - tm[i - 1].doc["time"].as<double>() - 0.5));
    CHECK(worst < 1e-3, "worst time-step error %.6f s", worst);
    CHECK(std::fabs((double)g_clock_us / 1e6 - (0.02 + 51 * 0.2 + 60.0)) < 1.0, "run lasted %.2f s", (double)g_clock_us / 1e6);
  }

  std::printf("T9  overload: 10 ms slots with a 12 ms send cost, late slots are counted and nothing is lost\n");
  reset(0, 87, 0);
  run("{\"command\":\"start_cv\",\"eStart\":0.6,\"eVertex1\":-0.2,\"eVertex2\":0.6,\"nCycles\":1,\"stepMv\":5,\"scanRate\":500,\"quietTime\":0,\"rtiaOhms\":10000}");
  {
    auto msgs = parse();
    auto data = parse("cv_data");
    auto *done = findType(msgs, "cv_done");
    CHECK(done != nullptr);
    CHECK(data.size() == 321, "delivered %d of 321", (int)data.size());
    if (done) {
      CHECK(done->doc["lateCount"].as<int>() > 0, "the overload should be reported");
      std::printf("      lateCount=%d maxLagUs=%d achieved=%.0f mV/s\n", done->doc["lateCount"].as<int>(),
                  done->doc["maxLagUs"].as<int>(), done->doc["achievedScanRate_mVs"].as<double>());
    }
  }

  std::printf("\n%d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
