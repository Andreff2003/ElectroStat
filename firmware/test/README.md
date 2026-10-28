# Firmware tests (run on a PC, no board needed)

These check the timing logic and the control flow of the real-time sweeps. They do
not check the AD5941, its settling, its real read time or any analog behavior;
that needs the board (see "First bring-up with the board" in `../README.md`).

- `timing_test.cpp` tests `ElectroStat_Timing.h` (deadlines without drift, the
  micros() rollover, slot planning, the statistics, and the conversion of the EIS
  amplitude from mV at the cell to the generator amplitude, with its 40 mV limit).
  `python -m ziglang c++ -std=c++17 -I.. timing_test.cpp -o timing_test && ./timing_test`
- `sim/` compiles the real `ElectroStat_Firmware.ino` against stand-ins for the
  Arduino API and the AD5941 driver that only cost virtual time, and runs CV, SWV
  and BioFET sweeps, a stop, a refused scan rate, the rollover of `micros()` and an
  overloaded link. For EIS it checks the firmware around the library: a stop between
  points (and a new sweep right after it), an ignored command, a point that comes back
  as NaN, and the amplitude clamp. The EIS loop in the stand-in follows the contract of
  `HELPStat::runSweep()` but is not the real code, which needs the AD5941. `sh sim/run_sim.sh` (needs `sim/ArduinoJson.h`, see the script).

The commands the bridge sends to the board are checked by `tests/test_bridge_payload.py` (from the repository root: `py -3 -m unittest discover -s tests`): every start command from the app is shorter than 240 bytes and keeps every field this firmware reads.
