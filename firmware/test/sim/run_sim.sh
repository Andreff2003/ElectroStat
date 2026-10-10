#!/bin/sh
# Builds and runs the firmware simulation on a PC (it needs a C++ compiler,
# for example `python -m pip install ziglang`, which this script uses by default).
# ArduinoJson v7 is not vendored; fetch it once:
#   curl -L -o ArduinoJson.h https://github.com/bblanchon/ArduinoJson/releases/download/v7.2.1/ArduinoJson-v7.2.1.h
set -e
cd "$(dirname "$0")"
cp ../../ElectroStat_Firmware.ino ElectroStat_Firmware_copy.cpp
CXX=${CXX:-"python -m ziglang c++"}
$CXX -std=c++17 -x c++ -I. -I../.. -DARDUINOJSON_ENABLE_ARDUINO_STRING=1 -DARDUINOJSON_ENABLE_PROGMEM=0 -DARDUINOJSON_ENABLE_ARDUINO_STREAM=0 -DARDUINOJSON_ENABLE_ARDUINO_PRINT=0 -Wno-nullability-completeness sim_main.cpp -o sim.exe
./sim.exe
