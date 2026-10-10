#pragma once
#include "Arduino.h"
#define FILE_APPEND "a"
class File {
 public:
  explicit operator bool() const { return false; }
  void println(const String &) {}
  void flush() {}
  void close() {}
};
class SDClass {
 public:
  bool begin(int) { return false; }   // no card: the backup path is a no-op in these tests
  bool exists(const char *) { return false; }
  bool mkdir(const char *) { return false; }
  File open(const String &, const char *) { return File(); }
};
extern SDClass SD;
