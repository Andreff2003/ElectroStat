# ElectroStat

ElectroStat is a web dashboard and measurement pipeline for electrochemical
sensing (EIS, cyclic voltammetry, square-wave voltammetry, and a BioFET
mode), built on top of the open-source HELPStat handheld potentiostat.

**Live demo:** https://electrostat.lovable.app (simulated-data mode, no
installation needed).

## Architecture

The system is split into three layers:

1. **Firmware** ([firmware/](firmware), ESP32-S3 + AD5941) — runs on the
   HELPStat hardware, drives the AD5941 potentiostat IC and streams
   measurement data over WiFi or USB serial. Flash
   `firmware/ElectroStat_Firmware.ino` with the Arduino IDE ("ESP32S3 Dev
   Module" board, ArduinoJson v7 library). UNTESTED against real hardware —
   see [firmware/README.md](firmware/README.md) for the current status per
   technique. See [NOTICE](NOTICE) for the different licenses the vendored
   driver files carry.
2. **Bridge** ([bridge.py](bridge.py)) — a Python WebSocket server that
   relays data between the firmware (or a built-in simulator) and the web
   app.
3. **Web app** (this repository, [src/](src)) — a React 19 + TanStack Start
   dashboard for running sweeps, fitting and analyzing the resulting data,
   and exporting results.

## Running locally

### Web app

```bash
bun install
bun run dev
```

This repository is set up for [Bun](https://bun.sh) (`bun.lock`). Note that
`package.json` and `bunfig.toml` reference packages under the `@lovable.dev`
npm scope, used by this project's Lovable-connected dev tooling; installing
outside an environment with access to that registry has been reported to
fail (registry errors on the `@lovable.dev/*` packages), and this hasn't
been independently verified in a clean environment. If `bun install` fails
for that reason, that dependency is the likely cause.

### Bridge

```bash
pip install websockets
python bridge.py --mode simulated
```

The browser connects to the bridge at `ws://127.0.0.1:81`. Other modes:

```bash
python bridge.py --mode wifi --esp-ip 192.168.4.1   # real hardware over WiFi
python bridge.py --mode serial --port COM3          # real hardware over USB
python bridge.py --mode dados_reais --pasta "./dados_eis"  # replay EIS from Excel files
```

`--mode serial` additionally needs `pip install pyserial`, and
`--mode dados_reais` needs `pip install openpyxl`.

## License

MIT — see [LICENSE](LICENSE). Firmware files derived from HELPStat keep
their original copyright headers; see [NOTICE](NOTICE) for details.

## Acknowledgments

Built on [HELPStat](https://github.com/LinnesLab/HELPStat) (Bautista,
Madsen, Riegle & Linnes, Weldon School of Biomedical Engineering, Purdue
University; DOI: 10.1021/acselectrochem.4c00052), reused here without
physical hardware modification.
