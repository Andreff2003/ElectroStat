# Firmware tests (run on a PC, no board needed)

These check the timing logic and the control flow of the real-time sweeps. They do
not check the AD5941, its settling, its real read time or any analog behavior;
that needs the board (see "First bring-up with the board" in `../README.md`).

- `timing_test.cpp` tests `ElectroStat_Timing.h` (deadlines without drift, the
  micros() rollover, slot planning, the statistics).
  `python -m ziglang c++ -std=c++17 -I.. timing_test.cpp -o timing_test && ./timing_test`
- `sim/` compiles the real `ElectroStat_Firmware.ino` against stand-ins for the
  Arduino API and the AD5941 driver that only cost virtual time, and runs CV, SWV
  and BioFET sweeps, a stop, a refused scan rate, the rollover of `micros()` and an
  overloaded link. `sh sim/run_sim.sh` (needs `sim/ArduinoJson.h`, see the script).
