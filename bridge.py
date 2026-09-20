"""
================================================================
  HelpStat — bridge.py  (versão unificada atualizada — EIS, BioFET, CV e SWV)
================================================================
  MODOS DISPONÍVEIS:

  1. Simulação live, sem hardware:
     python bridge.py --mode simulated

     Por defeito, cada clique em Start executa UMA medição e termina.
     Para repetir automaticamente sweeps simulados, usar:
     python bridge.py --mode simulated --loop-sim

  2. ESP32 via WiFi/AP Mode:
     python bridge.py --mode wifi --esp-ip 192.168.4.1

  3. ESP32 via cabo USB/Serial:
     python bridge.py --mode serial --port COM3

  4. Dados reais de potencióstato por ficheiros Excel, atualmente EIS:
     python bridge.py --mode dados_reais
     python bridge.py --mode dados_reais --pasta "./dados_eis"

================================================================
  NOTAS IMPORTANTES DE UNIDADES
================================================================
  EIS:
    zReal, zImag, zMag em ohm.
    zImag é Im(Z) verdadeiro: normalmente NEGATIVO para comportamento capacitivo.
    O gráfico Nyquist do frontend mostra -zImag.

  BioFET:
    Vg em V.
    Id em µA.
    concentration em nM.

  CV:
    E em V vs referência.
    I em µA; anódica positiva e catódica negativa.
    concentration/cMM em mM.

  SWV:
    E em V vs referência.
    IForward, IReverse, INet em µA.
    concentration em nM.

================================================================
  PROTOCOLO CV ESPERADO PELO FRONTEND
================================================================
  O frontend HelpStat espera dados CV com:

    {
      "type": "cv_data",
      "E": 0.245,
      "I": 81.2,
      "cycle": 1,
      "t": 4.53,
      "branch": "reverse"      # forward | reverse | return
    }

  Estados opcionais:

    {"type": "cv_status", "status": "running"}
    {"type": "cv_done", "cycle": 1, "points": 1601}
    {"type": "cv_error", "message": "ADC saturated"}

================================================================
  PROTOCOLO SWV ESPERADO PELO FRONTEND
================================================================
  Frontend → bridge:

    { "command": "start_swv",
      "startE": -0.2, "endE": 0.6, "step_mV": 2, "amplitude_mV": 25,
      "frequency_Hz": 25, "quietTime_s": 2, "direction": "anodic",
      "concentration": 10 }
    { "command": "stop" }          # ou "stop_swv"

  Bridge → frontend:

    {"type": "swv_status", "status": "running"}
    {"type": "swv_data", "E": 0.245, "IForward": 2.34, "IReverse": 1.10,
     "INet": 1.24, "time": 4.53, "index": 123, "direction": "anodic"}
    {"type": "swv_done", "points": 401}
    {"type": "swv_error", "message": "step_mV must be > 0."}

  Validação: cada campo é validado individualmente (step_mV>0, frequency_Hz>0,
  amplitude_mV>0, quietTime_s>=0, startE!=endE) — nunca aceita um payload que
  produza uma stream cheia de NaN. Um stop a meio do sweep emite sempre
  swv_status:idle, mesmo dentro de CancelledError, para o frontend nunca
  ficar preso em "running".

================================================================
  FORMATO DOS FICHEIROS EXCEL (potencióstato — modo dados_reais EIS)
================================================================
    Coluna A: Frequency (Hz)
    Coluna B: |Z| (ohms)
    Coluna C: Zre (ohms)
    Coluna D: Zim (ohms)
    Coluna E: Phase of Z (deg)

  MAPEAMENTO FICHEIRO → CONCENTRAÇÃO:
    0analito_branco.xlsx  → 0     µM
    0.001analito.xlsx     → 0.001 µM
    0.01analito.xlsx      → 0.01  µM
    0.1analito.xlsx       → 0.1   µM
    1analito.xlsx         → 1     µM
    10analito.xlsx        → 10    µM
    100analito.xlsx       → 100   µM
================================================================
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import random
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import websockets
except ImportError:
    print("[ERRO] Biblioteca em falta. Corre: pip install websockets")
    sys.exit(1)

# ─── Configuração geral ───────────────────────────────────────
WS_HOST = "0.0.0.0"
WS_PORT = 81

# ─── Estado global ────────────────────────────────────────────
connected_clients = set()
active_task: Optional[asyncio.Task] = None
operation_mode = "simulated"
esp32_writer = None
serial_conn = None
loop_simulated = False

# ─── Parâmetros biossensor/simulação ─────────────────────────
KD_SIMULATED_NM = 25.0

# EIS simulation — Randles + optional Warburg tail
RS_CONSTANT = 200.0
RCT_BASELINE = 300.0
RCT_MAX = 800.0
EIS_CDL_F = 20e-6
EIS_WARBURG_AW = 18.0  # Ω·s^-1/2, intentionally modest for visible low-frequency tail

# BioFET simulation
VT_BASELINE = 0.30
VT_MAX_SHIFT = 0.40
FET_TEMP_K = 298.15
FET_THERMAL_V = 0.0256926  # V at 298 K
FET_SUBTHRESHOLD_N = 1.6
FET_ID_SCALE_UA = 1.35
FET_IOFF_UA = 0.01
FET_VG_READ = 1.0
FET_SAMPLE_TIME_S = 10.0
FET_TIME_DURATION_S = 60.0
FET_TIME_DT_S = 0.5
FET_BINDING_TAU_S = 7.5

# CV constants
CV_F = 96485.33212
CV_R = 8.314462618
CV_T_DEFAULT_K = 298.15
CV_DEFAULT_D_CM2_S = 7.26e-6
CV_E0_PRIME_DEFAULT_V = 0.22
CV_DEFAULT_CDL_UF = 2.0
# Same numbers as src/utils/cvConstants.ts: 2500 nodes put the reversible peak
# within 0.4 % of Randles-Sevcik (180 nodes under-resolve the diffusion layer).
CV_DEFAULT_SOLVER_NODES = 2500
# The semi-implicit BV update stays finite for any k, so this only guards
# overflow. A low ceiling (it was 10 cm/s) breaks Nernst equilibrium away from E0'.
CV_BV_K_MAX = 1e6  # cm/s

# SWV simulation — the default models are the same physical solvers as the
# frontend (src/utils/swvDiffusionSolver.ts): exact reversible and graded
# sub-step quasi-reversible. The empirical Langmuir-Gaussian model below is only
# the legacy fallback ("empirical" in swvModel), as in the frontend.
SWV_IMAX_UA = 1.6
SWV_KD_NM = 30.0
SWV_EPEAK_V = 0.22

# ─── Mapeamento ficheiros Excel → concentração (µM) ───────────
FICHEIROS_EXCEL = {
    "0analito_branco.xlsx": 0,
    "0.001analito.xlsx": 0.001,
    "0.01analito.xlsx": 0.01,
    "0.1analito.xlsx": 0.1,
    "1analito.xlsx": 1,
    "10analito.xlsx": 10,
    "100analito.xlsx": 100,
}

ficheiros_ordenados: List[Tuple[float, str, Optional[str], str]] = []  # (concentracao_uM, caminho, sheet, label)
ficheiro_index = 0


# ══════════════════════════════════════════════════════════════
#  UTILITÁRIOS
# ══════════════════════════════════════════════════════════════

def finite_float(value: Any) -> Optional[float]:
    try:
        val = float(value)
    except (TypeError, ValueError):
        return None
    return val if math.isfinite(val) else None


def as_float(data: Dict[str, Any], keys: Iterable[str], default: float) -> float:
    for key in keys:
        if key in data:
            val = finite_float(data[key])
            if val is not None:
                return val
    return default


def as_int(data: Dict[str, Any], keys: Iterable[str], default: int) -> int:
    for key in keys:
        if key in data:
            val = finite_float(data[key])
            if val is not None:
                return int(round(val))
    return default


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def safe_exp(x: float) -> float:
    return math.exp(clamp(x, -60.0, 60.0))


def log1p_exp(x: float) -> float:
    # Stable softplus.
    if x > 40:
        return x
    if x < -40:
        return math.exp(x)
    return math.log1p(math.exp(x))


def langmuir(concentration: float, signal_max: float, kd: float) -> float:
    if concentration <= 0:
        return 0.0
    return signal_max * concentration / (concentration + kd)


def gaussian_noise(abs_sigma: float = 0.0, rel_sigma: float = 0.0, value: float = 0.0) -> float:
    sigma = max(0.0, abs_sigma) + max(0.0, rel_sigma) * abs(value)
    return random.gauss(0.0, sigma) if sigma > 0 else 0.0


def round_or_none(value: Any, digits: int = 6) -> Any:
    val = finite_float(value)
    return round(val, digits) if val is not None else value


async def broadcast(message: dict):
    if not connected_clients:
        return
    payload = json.dumps(message, separators=(",", ":"))
    await asyncio.gather(
        *[client.send(payload) for client in list(connected_clients)],
        return_exceptions=True,
    )


async def send_to_hardware(message: dict):
    global esp32_writer, serial_conn
    payload = (json.dumps(message) + "\n").encode("utf-8")

    if operation_mode == "wifi":
        if esp32_writer is None:
            print("[WARN] ESP32 WiFi não ligado")
            return
        try:
            esp32_writer.write(payload)
            await esp32_writer.drain()
            print(f"[ESP32/WIFI] Enviado: {message}")
        except Exception as e:
            print(f"[ESP32/WIFI] Erro ao enviar: {e}")
        return

    if operation_mode == "serial":
        if serial_conn is None:
            print("[WARN] ESP32 Serial não ligado")
            return
        try:
            serial_conn.write(payload)
            print(f"[ESP32/SERIAL] Enviado: {message}")
        except Exception as e:
            print(f"[ESP32/SERIAL] Erro ao enviar: {e}")
        return

    print("[WARN] send_to_hardware chamado fora de modo wifi/serial")


async def cancel_active_task():
    global active_task
    if active_task and not active_task.done():
        active_task.cancel()
        try:
            await active_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[WARN] Tarefa terminou com erro ao cancelar: {e}")
    active_task = None


# ══════════════════════════════════════════════════════════════
#  NORMALIZAÇÃO DE MENSAGENS DO ESP32 → FRONTEND
# ══════════════════════════════════════════════════════════════

async def forward_esp32_message(data: Dict[str, Any], source: str = "ESP32"):
    """Converte formatos do ESP32 para o formato esperado pelo frontend."""
    msg_type = str(data.get("type", "") or "")
    mode = str(data.get("mode", "") or "").upper()

    # Forward known status packets unchanged.
    if msg_type in {
        "cv_status", "cv_done", "cv_error",
        "eis_status", "eis_done", "fet_status", "fet_done", "fet_error",
        "swv_status", "swv_done", "swv_error",
    }:
        await broadcast(data)
        return

    if msg_type == "swv_data" or mode == "SWV":
        E = as_float(data, ["E", "e", "potential", "potential_V"], float("nan"))
        i_fwd = as_float(data, ["IForward", "i_forward", "iForward", "forward_uA"], float("nan"))
        i_rev = as_float(data, ["IReverse", "i_reverse", "iReverse", "reverse_uA"], float("nan"))
        if not (math.isfinite(E) and math.isfinite(i_fwd) and math.isfinite(i_rev)):
            print(f"[{source}] SWV ignorado — E/IForward/IReverse inválidos: {data}")
            return
        i_net = as_float(data, ["INet", "i_net", "iNet"], i_fwd - i_rev)
        t = as_float(data, ["time", "t", "timestamp"], float("nan"))
        idx = as_int(data, ["index", "idx", "i"], 0)
        direction = str(data.get("direction", "") or "anodic").lower()
        if direction not in {"anodic", "cathodic"}:
            direction = "anodic"
        await broadcast({
            "type": "swv_data",
            "E": round(E, 6),
            "IForward": round(i_fwd, 6),
            "IReverse": round(i_rev, 6),
            "INet": round(i_net, 6),
            # Preserve NaN rather than fabricate a time axis — matches the
            # frontend's own ingest contract (see useWebSocketData.ts).
            "time": round(t, 6) if math.isfinite(t) else None,
            "index": idx,
            "direction": direction,
            # Set by ElectroStat_Firmware.ino when the HSTIA output was
            # outside the AD5941's usable ADC window for this point.
            "outOfRange": bool(data.get("outOfRange", False)),
        })
        return

    if msg_type == "cv_data" or mode == "CV":
        E = as_float(data, ["E", "e", "potential", "potential_V", "voltage"], float("nan"))
        I = as_float(data, ["I", "i", "current", "current_uA", "id_ua", "I_uA"], float("nan"))
        if not (math.isfinite(E) and math.isfinite(I)):
            print(f"[{source}] CV ignorado — E/I inválidos: {data}")
            return
        cycle = max(1, as_int(data, ["cycle", "ciclo"], 1))
        t = as_float(data, ["t", "time", "timestamp", "time_s"], 0.0)
        branch = str(data.get("branch", "") or "").lower()
        if branch not in {"forward", "reverse", "return"}:
            branch = "forward"
        await broadcast({
            "type": "cv_data",
            "E": round(E, 6),
            "I": round(I, 6),
            "cycle": cycle,
            "t": round(t, 6),
            "branch": branch,
            # Set by ElectroStat_Firmware.ino when the HSTIA output was
            # outside the AD5941's usable ADC window for this point.
            "outOfRange": bool(data.get("outOfRange", False)),
        })
        return

    if msg_type == "eis" or mode == "EIS":
        zr = as_float(data, ["zReal", "Zre", "zr"], float("nan"))
        zi_raw = as_float(data, ["zImag", "Zim", "zi", "minusZImag", "negZImag", "zImagPositiveNyquist"], float("nan"))
        freq = as_float(data, ["freqHz", "frequency", "freq"], float("nan"))
        if not (math.isfinite(zr) and math.isfinite(zi_raw) and math.isfinite(freq) and freq > 0):
            print(f"[{source}] EIS ignorado — zReal/zImag/frequency inválidos: {data}")
            return

        # Convention handling:
        # - If explicit positive-Nyquist keys are used, convert to true Im(Z) negative.
        # - If phase is provided and negative while zi_raw is positive, many instruments exported -Im(Z); convert.
        # - Otherwise keep zImag as true Im(Z), including positive values for inductive artefacts.
        phase_in = finite_float(data.get("phase"))
        if any(k in data for k in ["minusZImag", "negZImag", "zImagPositiveNyquist"]):
            zimag_true = -abs(zi_raw)
        elif phase_in is not None and phase_in < 0 and zi_raw > 0:
            zimag_true = -abs(zi_raw)
        else:
            zimag_true = zi_raw

        zmag = as_float(data, ["zMag", "modZ", "absZ"], math.sqrt(zr * zr + zimag_true * zimag_true))
        if not math.isfinite(zmag) or zmag <= 0:
            zmag = math.sqrt(zr * zr + zimag_true * zimag_true)
        phase = phase_in if phase_in is not None else (math.atan2(zimag_true, zr) * 180.0 / math.pi)

        await broadcast({
            "type": "eis",
            "zReal": round(zr, 6),
            "zImag": round(zimag_true, 6),
            "frequency": round(freq, 6),
            "zMag": round(zmag, 6),
            "phase": round(phase, 6),
        })
        return

    if msg_type == "fet_transfer" or mode == "FET":
        vg = finite_float(data.get("vg", data.get("Vg")))
        cur = finite_float(data.get("id", data.get("id_ua", data.get("I", data.get("current_uA")))))
        curve = str(data.get("curve", "") or "").lower()
        if curve not in {"baseline", "analyte"}:
            print(f"[{source}] FET transfer ignorado — curve inválida: {data}")
            return
        if vg is None or cur is None:
            print(f"[{source}] FET transfer ignorado — vg/id inválidos: {data}")
            return
        await broadcast({
            "type": "fet_transfer",
            "curve": curve,
            "vg": round(vg, 6),
            "id": round(cur, 6),
            # Set by ElectroStat_Firmware.ino when the HSTIA output was
            # outside the AD5941's usable ADC window for this point.
            "outOfRange": bool(data.get("outOfRange", False)),
        })
        return

    if msg_type == "fet_time" or mode == "FET_TIME":
        t = finite_float(data.get("time", data.get("t")))
        cur = finite_float(data.get("id", data.get("id_ua", data.get("I", data.get("current_uA")))))
        if t is None or cur is None or t < 0:
            print(f"[{source}] FET time ignorado — time/id inválidos: {data}")
            return
        await broadcast({
            "type": "fet_time",
            "time": round(t, 6),
            "id": round(cur, 6),
            "outOfRange": bool(data.get("outOfRange", False)),
        })
        return

    print(f"[{source}] Mensagem não reconhecida: {data}")


# ══════════════════════════════════════════════════════════════
#  HANDLER WEBSOCKET BROWSER
# ══════════════════════════════════════════════════════════════

async def ws_handler(websocket):
    global active_task
    connected_clients.add(websocket)
    print(f"[+] Browser ligado: {getattr(websocket, 'remote_address', 'unknown')}")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                print(f"[WS] JSON inválido ignorado: {message!r}")
                continue

            command = str(data.get("command", "") or "")
            print(f"[CMD] Recebido: {data}")

            try:
                if command == "start_eis":
                    await cancel_active_task()
                    freq_min = max(1e-6, as_float(data, ["freqMin"], 0.1))
                    freq_max = max(1e-6, as_float(data, ["freqMax"], 100000.0))
                    point_density_mode = str(data.get("pointDensityMode", "total") or "total")
                    points_per_decade = max(1, as_int(data, ["pointsPerDecade"], 10))
                    if point_density_mode == "perDecade" and freq_max > freq_min:
                        decades = math.log10(freq_max / freq_min)
                        computed_points = max(2, round(points_per_decade * decades) + 1)
                    else:
                        computed_points = max(2, as_int(data, ["points"], 60))
                    params = {
                        "freqMin": freq_min,
                        "freqMax": freq_max,
                        "points": computed_points,
                        "pointDensityMode": point_density_mode,
                        "pointsPerDecade": points_per_decade,
                        "amplitude": max(0.001, as_float(data, ["amplitude"], 10.0)),
                        # dcBias is a hardware acquisition setting (offset from OCP).
                        # It does not change the simulated Randles response — stored
                        # here only so it round-trips into logs/exports for traceability.
                        "dcBias": as_float(data, ["dcBias"], 0.0),
                        "concentration": as_float(data, ["concentration", "c", "cMM"], 0.0),
                    }
                    print(f"[EIS] pointDensityMode={point_density_mode}  pointsPerDecade={points_per_decade}  → {computed_points} pts  dcBias={params['dcBias']}V")
                    if operation_mode == "simulated":
                        active_task = asyncio.create_task(loop_eis_simulado(params))
                    elif operation_mode == "dados_reais":
                        active_task = asyncio.create_task(enviar_ficheiro_excel())
                    else:
                        await send_to_hardware({"command": "start_eis", **params})

                elif command == "start_fet":
                    await cancel_active_task()
                    params = {
                        "vgMin": as_float(data, ["vgMin"], -0.5),
                        "vgMax": as_float(data, ["vgMax"], 1.5),
                        "vgStep": max(1e-6, as_float(data, ["vgStep"], 0.04)),
                        "intervalMs": max(1, as_int(data, ["intervalMs"], 200)),
                        "concentration": as_float(data, ["concentration", "c", "cMM"], 0.0),
                        # Analyte / aptamer-specific parameters (fall back to the
                        # module defaults if the frontend doesn't send them, so
                        # older clients keep working unchanged).
                        "kd_nM": max(1e-6, as_float(data, ["kd_nM"], KD_SIMULATED_NM)),
                        "vtBaseline_V": as_float(data, ["vtBaseline_V"], VT_BASELINE),
                        "deltaVtMax_V": as_float(data, ["deltaVtMax_V"], VT_MAX_SHIFT),
                        "idMax_uA": max(1e-6, as_float(data, ["idMax_uA"], 50.0)),
                        "idealityFactor": max(0.5, as_float(data, ["idealityFactor"], FET_SUBTHRESHOLD_N)),
                        # Time-response (Id vs t) parameters.
                        "bindingRate_perS": max(1e-6, as_float(data, ["bindingRate_perS"], 1.0 / FET_BINDING_TAU_S)),
                        "readoutBias_V": as_float(data, ["readoutBias_V"], FET_VG_READ),
                        "timeDuration_s": max(1.0, as_float(data, ["timeDuration_s"], FET_TIME_DURATION_S)),
                        "timeStep_s": max(0.01, as_float(data, ["timeStep_s"], FET_TIME_DT_S)),
                        "injectionTime_s": max(0.0, as_float(data, ["injectionTime_s"], FET_SAMPLE_TIME_S)),
                        # HSTIA gain (ohms) — ignored by the simulator, forwarded to
                        # real hardware so ElectroStat_Firmware.ino's handleStartFet
                        # picks it up instead of always defaulting to 10k.
                        "rtiaOhms": max(0.0, as_float(data, ["rtiaOhms"], 10000.0)),
                    }
                    print(f"[FET] Kd={params['kd_nM']}nM  VtBase={params['vtBaseline_V']}V  "
                          f"dVtMax={params['deltaVtMax_V']}V  idMax={params['idMax_uA']}uA  n={params['idealityFactor']}")
                    if operation_mode in ("simulated", "dados_reais"):
                        active_task = asyncio.create_task(loop_fet_simulado(params))
                    else:
                        await send_to_hardware({"command": "start_fet", **params})

                elif command == "start_cv":
                    await cancel_active_task()
                    params = parse_cv_params(data)
                    if operation_mode in ("simulated", "dados_reais"):
                        active_task = asyncio.create_task(loop_cv_simulado(params))
                    else:
                        await send_to_hardware({"command": "start_cv", **params})

                elif command == "start_swv":
                    await cancel_active_task()
                    params, err = validate_swv_params(data)
                    if err is not None:
                        await broadcast({"type": "swv_error", "message": err})
                    elif operation_mode == "simulated":
                        active_task = asyncio.create_task(loop_swv_simulado(params))
                    elif operation_mode == "dados_reais":
                        # No Excel dataset defined for SWV yet — fall back to simulation
                        # so "Start" always produces a usable measurement.
                        active_task = asyncio.create_task(loop_swv_simulado(params))
                    else:
                        await send_to_hardware({"command": "start_swv", **params})

                elif command in {"stop", "stop_eis", "stop_fet", "stop_cv", "stop_swv"}:
                    await cancel_active_task()
                    print("[CMD] Parado")
                    if operation_mode not in ("simulated", "dados_reais"):
                        await send_to_hardware({"command": command})
                    if command == "stop_cv":
                        await broadcast({"type": "cv_status", "status": "idle"})
                    elif command == "stop_eis":
                        await broadcast({"type": "eis_status", "status": "idle"})
                    elif command == "stop_fet":
                        await broadcast({"type": "fet_status", "status": "idle"})
                    elif command == "stop_swv":
                        await broadcast({"type": "swv_status", "status": "idle"})
                    elif command == "stop":
                        # Generic stop — the frontend only ever sends this form
                        # (never stop_eis/stop_fet/stop_cv), so it must cover
                        # every technique itself; broadcasting idle for a
                        # technique that wasn't running is harmless.
                        await broadcast({"type": "swv_status", "status": "idle"})
                        await broadcast({"type": "cv_status", "status": "idle"})
                        await broadcast({"type": "eis_status", "status": "idle"})
                        await broadcast({"type": "fet_status", "status": "idle"})

                elif command == "ping":
                    await broadcast({"type": "bridge_status", "status": "ok", "mode": operation_mode})

                else:
                    print(f"[CMD] Ignorado/desconhecido: {command}")

            except Exception as e:
                print(f"[ERRO] Falha ao processar comando {command!r}: {e}")
                if command == "start_cv":
                    await broadcast({"type": "cv_error", "message": str(e)})
                elif command == "start_fet":
                    await broadcast({"type": "fet_error", "message": str(e)})
                elif command == "start_swv":
                    await broadcast({"type": "swv_error", "message": str(e)})

    except Exception as e:
        print(f"[WS] Erro cliente: {e}")
    finally:
        connected_clients.discard(websocket)
        print("[-] Browser desligado")


# ══════════════════════════════════════════════════════════════
#  MODO SIMULATED — EIS
# ══════════════════════════════════════════════════════════════

async def loop_eis_simulado(params: dict):
    print("[SIM] Loop EIS iniciado")
    try:
        while True:
            await sweep_eis_simulado(params)
            if not loop_simulated:
                break
            print("[SIM] EIS completo. Pausa 3s antes de repetir...")
            await asyncio.sleep(3)
    except asyncio.CancelledError:
        print("[SIM] EIS parado")
        await broadcast({"type": "eis_status", "status": "idle"})
        raise


def randles_warburg_impedance(freq_hz: float, rs: float, rct: float, cdl_f: float, aw: float) -> Tuple[float, float]:
    """Rs + [Cdl || (Rct + semi-infinite Warburg)]. Returns true Re/Im(Z)."""
    omega = 2.0 * math.pi * max(freq_hz, 1e-12)
    zw_re = aw / math.sqrt(omega)
    zw_im = -aw / math.sqrt(omega)
    zf_re = rct + zw_re
    zf_im = zw_im
    # Admittance faradaic: 1/Zf
    denom = zf_re * zf_re + zf_im * zf_im
    yf_re = zf_re / denom
    yf_im = -zf_im / denom
    # Cdl admittance: jωC
    y_re = yf_re
    y_im = yf_im + omega * cdl_f
    y_den = y_re * y_re + y_im * y_im
    zp_re = y_re / y_den
    zp_im = -y_im / y_den
    return rs + zp_re, zp_im


async def sweep_eis_simulado(params: dict):
    freq_min = min(params["freqMin"], params["freqMax"])
    freq_max = max(params["freqMin"], params["freqMax"])
    points = params["points"]
    amplitude = params["amplitude"]
    concentration = params["concentration"]

    delta_rct = langmuir(concentration, RCT_MAX - RCT_BASELINE, KD_SIMULATED_NM)
    rct = RCT_BASELINE + delta_rct
    rs = RS_CONSTANT
    cdl = EIS_CDL_F
    aw = EIS_WARBURG_AW
    noise_rel = clamp(0.0025 * (10.0 / max(amplitude, 1e-9)), 0.0005, 0.02)

    print(f"[SIM-EIS] C={concentration} nM  Rs={rs:.0f} Ω  Rct={rct:.1f} Ω  Cdl={cdl*1e6:.1f} µF")
    await broadcast({"type": "eis_status", "status": "running"})

    denom = max(1, points - 1)
    for i in range(points):
        # EIS sweeps from high to low frequency.
        log_f = math.log10(freq_max) + (math.log10(freq_min) - math.log10(freq_max)) * i / denom
        freq = 10 ** log_f
        z_real, z_imag = randles_warburg_impedance(freq, rs, rct, cdl, aw)
        z_mag_true = math.sqrt(z_real * z_real + z_imag * z_imag)
        z_real += gaussian_noise(rel_sigma=noise_rel, value=z_mag_true)
        z_imag += gaussian_noise(rel_sigma=noise_rel, value=z_mag_true)
        z_mag = math.sqrt(z_real * z_real + z_imag * z_imag)
        phase = math.atan2(z_imag, z_real) * (180.0 / math.pi)

        await broadcast({
            "type": "eis",
            "zReal": round(z_real, 4),
            "zImag": round(z_imag, 4),
            "frequency": round(freq, 6),
            "zMag": round(z_mag, 4),
            "phase": round(phase, 4),
            "concentration": concentration,
            "rct": round(rct, 4),
            "rs": round(rs, 4),
            "deltaRct": round(delta_rct, 4),
            "simulationModel": "randles_cdl_parallel_rct_warburg",
        })
        await asyncio.sleep(0.2)

    await broadcast({"type": "eis_done", "points": points})
    await broadcast({"type": "eis_status", "status": "done"})
    print("[SIM] EIS completo")


# ══════════════════════════════════════════════════════════════
#  MODO SIMULATED — FET
# ══════════════════════════════════════════════════════════════

def fet_delta_vt(concentration_nm: float, kd_nm: float, delta_vt_max: float) -> float:
    return langmuir(concentration_nm, delta_vt_max, kd_nm)


def fet_drain_current_ua(vg: float, vt: float, id_max_ua: float, ideality_n: float) -> float:
    """Smooth EKV-like educational BioFET transfer model, Id in µA.
    id_max_ua sets the saturation scale; ideality_n is the subthreshold
    slope factor (1 = ideal MOSFET, higher = more sluggish turn-on)."""
    slope_v = 2.0 * ideality_n * FET_THERMAL_V
    u = (vg - vt) / max(slope_v, 1e-12)
    return FET_IOFF_UA + id_max_ua * log1p_exp(u) ** 2


def add_fet_current_noise(id_ua: float, rel_noise: float = 0.012, abs_noise: float = 0.004) -> float:
    noisy = id_ua + gaussian_noise(abs_sigma=abs_noise, rel_sigma=rel_noise, value=id_ua)
    return max(noisy, 1e-6)


async def loop_fet_simulado(params: dict):
    print("[SIM] Loop FET iniciado")
    try:
        while True:
            await sweep_fet_simulado(params)
            if not loop_simulated:
                break
            print("[SIM] FET completo. Pausa 3s antes de repetir...")
            await asyncio.sleep(3)
    except asyncio.CancelledError:
        print("[SIM] FET parado")
        await broadcast({"type": "fet_status", "status": "idle"})
        raise


async def sweep_fet_simulado(params: dict):
    vg_min = params["vgMin"]
    vg_max = params["vgMax"]
    vg_step = params["vgStep"]
    interval_s = params["intervalMs"] / 1000.0
    concentration = params["concentration"]

    # Analyte / device parameters — fall back to the module defaults so a
    # client that doesn't send them yet keeps getting the original behaviour.
    kd_nm = params.get("kd_nM", KD_SIMULATED_NM)
    vt_baseline = params.get("vtBaseline_V", VT_BASELINE)
    delta_vt_max = params.get("deltaVtMax_V", VT_MAX_SHIFT)
    id_max_ua = params.get("idMax_uA", FET_ID_SCALE_UA)
    ideality_n = params.get("idealityFactor", FET_SUBTHRESHOLD_N)
    binding_rate_per_s = params.get("bindingRate_perS", 1.0 / max(FET_BINDING_TAU_S, 1e-9))
    binding_tau_s = 1.0 / max(binding_rate_per_s, 1e-9)
    readout_bias_v = params.get("readoutBias_V", FET_VG_READ)
    time_duration_s = params.get("timeDuration_s", FET_TIME_DURATION_S)
    time_dt_s = params.get("timeStep_s", FET_TIME_DT_S)
    injection_time_s = params.get("injectionTime_s", FET_SAMPLE_TIME_S)

    delta_vt = fet_delta_vt(concentration, kd_nm, delta_vt_max)
    vt_analyte = vt_baseline + delta_vt
    print(f"[SIM-FET] C={concentration} nM  Kd={kd_nm}nM  Vt(base)={vt_baseline:.3f} V  "
          f"Vt(analyte)={vt_analyte:.3f} V  ΔVt={delta_vt*1000:.1f} mV  idMax={id_max_ua}uA  n={ideality_n}")
    await broadcast({"type": "fet_status", "status": "running"})

    def vg_values() -> List[float]:
        vals: List[float] = []
        vg = vg_min
        # Protect against accidental infinite loops if sign mismatch.
        if vg_step <= 0:
            return [vg_min, vg_max]
        while vg <= vg_max + 1e-9 and len(vals) < 10000:
            vals.append(round(vg, 6))
            vg += vg_step
        return vals

    points_sent = 0
    for curve, vt, conc, dvt_mv in [
        ("baseline", vt_baseline, 0.0, 0.0),
        ("analyte", vt_analyte, concentration, delta_vt * 1000.0),
    ]:
        for vg in vg_values():
            id_ua = add_fet_current_noise(fet_drain_current_ua(vg, vt, id_max_ua, ideality_n))
            await broadcast({
                "type": "fet_transfer",
                "curve": curve,
                "vg": round(vg, 6),
                "id": round(id_ua, 6),
                "concentration": conc,
                "deltaVt": round(dvt_mv, 6),
                "simulationModel": "softplus_ekv_like",
            })
            points_sent += 1
            await asyncio.sleep(interval_s)
        await asyncio.sleep(0.35)

    # Time response at the configured readout bias, driven by Vt(t) from the
    # same binding model (pseudo-first-order association after injection).
    time_points = int(math.floor(time_duration_s / max(time_dt_s, 1e-9))) + 1
    for k in range(time_points):
        t = k * time_dt_s
        if t < injection_time_s:
            dvt_t = 0.0
        else:
            dvt_t = delta_vt * (1.0 - math.exp(-(t - injection_time_s) / max(binding_tau_s, 1e-9)))
        vt_t = vt_baseline + dvt_t
        id_ua = add_fet_current_noise(
            fet_drain_current_ua(readout_bias_v, vt_t, id_max_ua, ideality_n),
            rel_noise=0.01, abs_noise=0.003,
        )
        await broadcast({
            "type": "fet_time",
            "time": round(t, 3),
            "id": round(id_ua, 6),
            "concentration": concentration,
            "vgRead": readout_bias_v,
            "deltaVt": round(dvt_t * 1000.0, 6),
            "sampleAdded": t >= injection_time_s,
        })
        await asyncio.sleep(0.05)

    await broadcast({"type": "fet_done", "transferPoints": points_sent, "timePoints": time_points})
    await broadcast({"type": "fet_status", "status": "done"})
    print("[SIM] FET completo")


# ══════════════════════════════════════════════════════════════
#  MODO SIMULATED — CV
# ══════════════════════════════════════════════════════════════

def parse_cv_params(data: Dict[str, Any]) -> Dict[str, Any]:
    scan_rate = as_float(data, ["scanRate", "scanRate_mVs", "scanRateMvS"], 100.0)
    params = {
        "scanRate": max(0.001, scan_rate),
        "eStart": as_float(data, ["eStart", "EStart", "startE"], 0.6),
        "eVertex1": as_float(data, ["eVertex1", "vertex1", "EVertex1"], -0.2),
        "eVertex2": as_float(data, ["eVertex2", "vertex2", "EVertex2"], 0.6),
        "nCycles": max(1, as_int(data, ["nCycles", "cycles"], 1)),
        "cMM": max(0.0, as_float(data, ["cMM", "concentration_mM", "concentration"], 5.0)),
        "areaCm2": max(1e-9, as_float(data, ["areaCm2", "area_cm2", "area"], 0.0707)),
        "n": max(1e-9, as_float(data, ["n", "electrons", "nElectrons"], 1.0)),
        # Frontend's ParametersPanel field is named "stepPotential" — accept it
        # first so the user's chosen step size actually reaches the sweep
        # (previously fell through to the 1.0 mV default every time).
        "stepMv": max(0.1, as_float(data, ["stepPotential", "stepMv", "step_mV", "step"], 1.0)),
        "cvModel": str(data.get("cvModel", data.get("model", "reversible"))).lower(),
        "noiseEnabled": bool(data.get("noiseEnabled", True)),
        "spatialNodes": max(40, min(5000, as_int(data, ["spatialNodes"], CV_DEFAULT_SOLVER_NODES))),
        # Equilibration delay at E_start before the ramp begins. Frontend's
        # field is "quietTime" (seconds); accepted here so it round-trips to
        # real hardware (send_to_hardware) and is honoured by the simulator.
        "quietTime": max(0.0, as_float(data, ["quietTime", "quietTime_s", "quiet"], 0.0)),
        # Analyte / redox-probe parameters. diffusionCoeff/formalPotential feed
        # both CV models; k0/alpha additionally drive the Butler-Volmer rate
        # constants in the quasi-reversible model (simulate_bv_diffusion_cv),
        # matching the frontend's client-side simulator (useSimulatedCVData.ts).
        "diffusionCoeff": max(1e-9, as_float(data, ["diffusionCoeff"], CV_DEFAULT_D_CM2_S)),
        "formalPotential": as_float(data, ["formalPotential"], CV_E0_PRIME_DEFAULT_V),
        "k0": max(1e-9, as_float(data, ["k0"], 0.01)),
        "alpha": min(0.9, max(0.1, as_float(data, ["alpha"], 0.5))),
        # HSTIA gain (ohms) — ignored by the simulator, forwarded to real
        # hardware so ElectroStat_Firmware.ino's handleStartCv picks it up
        # instead of always defaulting to 10k.
        "rtiaOhms": max(0.0, as_float(data, ["rtiaOhms"], 10000.0)),
    }
    if params["cvModel"] not in {"reversible", "quasi-reversible", "quasi", "quasireversible"}:
        params["cvModel"] = "reversible"
    return params


def generate_cv_program(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Potential program, same construction as buildPotentialProgram in
    src/hooks/useSimulatedCVData.ts: each ramp has round(|dE|/step) equal steps
    and the time axis is uniform, t = index * step / scan_rate."""
    e_start = params["eStart"]
    e_v1 = params["eVertex1"]
    e_v2 = params["eVertex2"]
    n_cycles = params["nCycles"]
    step_v = max(1e-4, params["stepMv"] / 1000.0)
    scan_rate_v_s = params["scanRate"] / 1000.0
    dt = step_v / max(scan_rate_v_s, 1e-12)
    segs: List[Dict[str, Any]] = [{"E": e_start, "cycle": 1, "t": 0.0, "branch": "forward", "direction": 0}]

    def add_ramp(start: float, end: float, branch: str, cycle: int):
        n_steps = max(1, int(math.floor(abs(end - start) / step_v + 0.5)))
        direction = 1 if end >= start else -1
        for k in range(1, n_steps + 1):
            segs.append({
                "E": start + (end - start) * (k / n_steps),
                "cycle": cycle,
                "t": len(segs) * dt,
                "branch": branch,
                "direction": direction,
            })

    cur = e_start
    for c in range(1, n_cycles + 1):
        add_ramp(cur, e_v1, "forward", c)
        cur = e_v1
        add_ramp(cur, e_v2, "reverse", c)
        cur = e_v2
        if c < n_cycles and abs(cur - e_start) > 1e-9:
            add_ramp(cur, e_start, "return", c)
            cur = e_start
    if len(segs) >= 2:
        segs[0]["direction"] = segs[1]["direction"]
    return segs


def solve_tridiagonal(a: Sequence[float], b: Sequence[float], c: Sequence[float], d: Sequence[float]) -> List[float]:
    n = len(d)
    if n == 0:
        return []
    cp = [0.0] * n
    dp = [0.0] * n
    denom = b[0]
    if abs(denom) < 1e-30:
        denom = 1e-30
    cp[0] = c[0] / denom if n > 1 else 0.0
    dp[0] = d[0] / denom
    for i in range(1, n):
        denom = b[i] - a[i] * cp[i - 1]
        if abs(denom) < 1e-30:
            denom = 1e-30
        cp[i] = c[i] / denom if i < n - 1 else 0.0
        dp[i] = (d[i] - a[i] * dp[i - 1]) / denom
    x = [0.0] * n
    x[-1] = dp[-1]
    for i in range(n - 2, -1, -1):
        x[i] = dp[i] - cp[i] * x[i + 1]
    return x


def implicit_diffusion_step(C: List[float], left: float, right: float, lam: float) -> List[float]:
    N = len(C)
    if N <= 2:
        return [left, right]
    m = N - 2
    a = [0.0] + [-lam] * (m - 1)
    b = [1.0 + 2.0 * lam] * m
    c = [-lam] * (m - 1) + [0.0]
    d = [C[i + 1] for i in range(m)]
    d[0] += lam * left
    d[-1] += lam * right
    interior = solve_tridiagonal(a, b, c, d)
    return [left] + [max(0.0, v) for v in interior] + [right]


def simulate_bv_diffusion_cv(program: List[Dict[str, Any]], params: Dict[str, Any]) -> List[float]:
    """Quasi-reversible CV: Butler-Volmer kinetics + semi-infinite diffusion,
    solved semi-implicitly via product-integration of the Cottrell kernel.
    This is a direct port of the frontend's client-side simulator
    (buildQuasiReversibleCV in src/hooks/useSimulatedCVData.ts), replacing the
    previous empirical dual-Gaussian peak-shape approximation so the bridge's
    simulated "quasi-reversible" CV matches the browser simulator's physics.
    Equal D for O and R; first-order mass balance CO_surf + CR_surf ~= cBulk.
    Educational approximation only — not a full finite-difference BV solver.
    Kept in step with the frontend: lag-corrected Cottrell weights and
    CV_BV_K_MAX = 1e6 (validated against Randles-Sevcik and Nicholson there).
    """
    n = params["n"]
    cMM = params["cMM"]
    area = params["areaCm2"]
    scan_rate = params["scanRate"]
    D = params.get("diffusionCoeff", CV_DEFAULT_D_CM2_S)
    E0 = params.get("formalPotential", CV_E0_PRIME_DEFAULT_V)
    k0 = params.get("k0", 0.01)
    alpha = params.get("alpha", 0.5)

    step_v = params["stepMv"] / 1000.0
    scan_v_s = scan_rate / 1000.0
    dt = step_v / max(scan_v_s, 1e-12)

    c_bulk = max(0.0, cMM) * 1e-6
    sqrt_pi_d = math.sqrt(math.pi * D)
    sqrt_dt = math.sqrt(dt)
    noise_amp = math.sqrt(max(scan_rate, 1e-9)) * 0.005

    a_fac = n * CV_F * area
    beta = (2.0 * sqrt_dt) / (a_fac * sqrt_pi_d)

    n_pts = len(program)
    # Cottrell product-integration weights 2*(sqrt(k) - sqrt(k-1)) depend only
    # on the lag k, so precompute them once. The convolution is still O(n^2)
    # since the 1/sqrt(k) kernel can't be truncated without distorting the
    # physics — fine for typical CV sweep sizes, same tradeoff as the frontend.
    cottrell_w = [0.0] * (n_pts + 2)
    for k in range(1, n_pts + 2):
        cottrell_w[k] = 2.0 * (math.sqrt(k) - math.sqrt(k - 1))

    i_amps: List[float] = [0.0] * n_pts
    out: List[float] = []
    for i, p in enumerate(program):
        eta = p["E"] - E0
        k_red = min(CV_BV_K_MAX, k0 * safe_exp(-alpha * n * CV_F * eta / (CV_R * CV_T_DEFAULT_K)))
        k_ox = min(CV_BV_K_MAX, k0 * safe_exp((1.0 - alpha) * n * CV_F * eta / (CV_R * CV_T_DEFAULT_K)))

        sum_hist = 0.0
        for j in range(i):
            # The current step already carries lag 1 (inside beta), so step j
            # sits at lag i - j + 1.
            sum_hist += i_amps[j] * cottrell_w[i - j + 1]
        conv_known = (sum_hist * sqrt_dt) / (a_fac * sqrt_pi_d)

        i_amp = 0.0
        if c_bulk > 0:
            denom = 1.0 + a_fac * beta * (k_ox + k_red)
            i_amp = -a_fac * (k_red * c_bulk + (k_ox + k_red) * conv_known) / denom

            # Mass-balance safety net: clamp surface CR to [0, cBulk]. If we
            # hit a boundary, fall back to a non-implicit step bounded by the
            # clamped CR so the reported current stays physically consistent
            # with the surface concentrations.
            cr_raw = -(conv_known + beta * i_amp)
            theta_r = clamp(cr_raw / c_bulk, 0.0, 1.0)
            cr = theta_r * c_bulk
            co = c_bulk - cr
            if theta_r <= 0.0 or theta_r >= 1.0:
                i_amp = a_fac * (k_ox * cr - k_red * co)

        i_amps[i] = i_amp
        noise = random.gauss(0.0, noise_amp) if params.get("noiseEnabled", True) else 0.0
        out.append(i_amp * 1e6 + noise)
    return out


def reversible_cv_faradaic_ua(program: List[Dict[str, Any]], params: Dict[str, Any]) -> List[float]:
    """Faradaic current (uA) of the reversible CV: a port of
    simulateReversibleDiffusionCV (src/utils/cvDiffusionSolver.ts).

    1-D semi-infinite diffusion, L = 6*sqrt(D*tMax), Nernst surface with local
    mass conservation, backward Euler. The tridiagonal matrix is constant, so
    its Thomas factors are computed once and each step only does the two
    substitution sweeps (O and R together).
    """
    c_bulk = max(0.0, params["cMM"]) * 1e-6
    if c_bulk <= 0 or not program:
        return [0.0] * len(program)
    D = params.get("diffusionCoeff", CV_DEFAULT_D_CM2_S)
    n_e = params["n"]
    area = params["areaCm2"]
    e0 = params.get("formalPotential", CV_E0_PRIME_DEFAULT_V)
    T = CV_T_DEFAULT_K
    dt = max(1e-4, params["stepMv"] / 1000.0) / (params["scanRate"] / 1000.0)
    t_max = max((len(program) - 1) * dt, dt)

    N = max(20, int(params.get("spatialNodes", CV_DEFAULT_SOLVER_NODES)))
    dx = 6.0 * math.sqrt(D * t_max) / (N - 1)
    lam = D * dt / (dx * dx)
    M = N - 2

    # Thomas factors for a = c = -lam, b = 1 + 2 lam (a[0] and c[M-1] unused).
    b = 1.0 + 2.0 * lam
    inv_m = [0.0] * M
    cp = [0.0] * M
    inv_m[0] = 1.0 / b
    cp[0] = -lam * inv_m[0]
    for i in range(1, M):
        inv_m[i] = 1.0 / (b + lam * cp[i - 1])
        cp[i] = (-lam * inv_m[i]) if i < M - 1 else 0.0

    CO = [c_bulk] * N
    CR = [0.0] * N
    nf = n_e * CV_F / (CV_R * T)
    out: List[float] = []

    for k, p in enumerate(program):
        theta = safe_exp(nf * (p["E"] - e0))
        surf = c_bulk if k == 0 else clamp(CO[1] + CR[1], 0.0, c_bulk)
        CO[0] = surf * theta / (1.0 + theta)
        CR[0] = surf / (1.0 + theta)

        if M >= 1:
            dpO = [0.0] * M
            dpR = [0.0] * M
            prevO = prevR = 0.0
            for i in range(M):
                dO = CO[i + 1]
                dR = CR[i + 1]
                if i == 0:
                    dO += lam * CO[0]
                    dR += lam * CR[0]
                if i == M - 1:
                    dO += lam * c_bulk
                # sub-diagonal a is -lam for i >= 1 and unused for i = 0
                if i > 0:
                    dO += lam * prevO
                    dR += lam * prevR
                prevO = dO * inv_m[i]
                prevR = dR * inv_m[i]
                dpO[i] = prevO
                dpR[i] = prevR
            xO = dpO[M - 1]
            xR = dpR[M - 1]
            CO[M] = xO if xO > 0.0 else 0.0
            CR[M] = xR if xR > 0.0 else 0.0
            for i in range(M - 2, -1, -1):
                xO = dpO[i] - cp[i] * xO
                xR = dpR[i] - cp[i] * xR
                CO[i + 1] = xO if xO > 0.0 else 0.0
                CR[i + 1] = xR if xR > 0.0 else 0.0
        CO[N - 1] = c_bulk
        CR[N - 1] = 0.0

        surf = clamp(CO[1] + CR[1], 0.0, c_bulk)
        CO[0] = surf * theta / (1.0 + theta)
        CR[0] = surf / (1.0 + theta)

        j_o = -D * (CO[1] - CO[0]) / dx
        out.append(n_e * CV_F * area * j_o * 1e6)
    return out


def simulate_reversible_diffusion_cv(program: List[Dict[str, Any]], params: Dict[str, Any]) -> List[float]:
    """Reversible CV for the bridge simulated mode: the physical solver above
    plus the bridge's small capacitive step and optional noise."""
    scan_v_s = params["scanRate"] / 1000.0
    faradaic = reversible_cv_faradaic_ua(program, params)
    out: List[float] = []
    for p, i_ua in zip(program, faradaic):
        cap = CV_DEFAULT_CDL_UF * scan_v_s * (1 if p["direction"] > 0 else -1 if p["direction"] < 0 else 0)
        if params.get("noiseEnabled", True):
            noise = random.gauss(0.0, 0.015 + 0.0005 * abs(i_ua)) if params["cMM"] > 0 else random.gauss(0, 0.002)
        else:
            noise = 0.0
        out.append(i_ua + cap + noise)
    return out


async def loop_cv_simulado(params: Dict[str, Any]):
    print("[SIM] CV iniciado")
    await broadcast({"type": "cv_status", "status": "running"})
    try:
        # Equilibration delay at E_start, same intent as the SWV quiet-time
        # wait below. Capped so "Start" never feels stuck for a bridge
        # simulation, even if a long quiet time was configured for real
        # hardware equilibration.
        quiet_time = params.get("quietTime", 0.0)
        if quiet_time > 0:
            await asyncio.sleep(min(quiet_time, 2.0))
        program = generate_cv_program(params)
        model = params["cvModel"]
        print(f"[SIM-CV] model={model} C={params['cMM']} mM v={params['scanRate']} mV/s cycles={params['nCycles']} points={len(program)}")
        # Solvers are CPU-bound; run them off the event loop so WebSocket
        # traffic (ping, stop) stays responsive while they compute.
        if model == "reversible":
            currents = await asyncio.to_thread(simulate_reversible_diffusion_cv, program, params)
            simulation_model = "reversible-diffusion-nernst"
        else:
            currents = await asyncio.to_thread(simulate_bv_diffusion_cv, program, params)
            simulation_model = "quasi-reversible-butler-volmer-cottrell"

        for p, I in zip(program, currents):
            await broadcast({
                "type": "cv_data",
                "E": round(p["E"], 6),
                "I": round(I, 6),
                "cycle": int(p["cycle"]),
                "t": round(p["t"], 6),
                "branch": p["branch"],
                "simulationModel": simulation_model,
            })
            await asyncio.sleep(0.005)

        await broadcast({"type": "cv_done", "cycle": params["nCycles"], "points": len(program)})
        await broadcast({"type": "cv_status", "status": "done"})
        print("[SIM] CV completo")
    except asyncio.CancelledError:
        await broadcast({"type": "cv_status", "status": "idle"})
        print("[SIM] CV parado")
        raise
    except Exception as e:
        await broadcast({"type": "cv_error", "message": str(e)})
        await broadcast({"type": "cv_status", "status": "error"})
        print(f"[SIM] CV erro: {e}")


# ══════════════════════════════════════════════════════════════
#  MODO SIMULATED — SWV
# ══════════════════════════════════════════════════════════════

def validate_swv_params(data: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Valida cada campo do start_swv individualmente. Devolve (params, None)
    em sucesso, ou (None, mensagem) na primeira regra violada — nunca aceita
    um payload que produza uma stream cheia de NaN."""
    start_e = as_float(data, ["startE", "start_e", "startE_V"], -0.2)
    end_e = as_float(data, ["endE", "end_e", "endE_V"], 0.6)
    step_mv = as_float(data, ["step_mV", "stepMv", "step"], 2.0)
    amp_mv = as_float(data, ["amplitude_mV", "amplitudeMv", "amp_mV"], 25.0)
    freq_hz = as_float(data, ["frequency_Hz", "frequencyHz", "freq"], 25.0)
    quiet_s = as_float(data, ["quietTime_s", "quietTimeS", "quiet"], 2.0)
    direction = str(data.get("direction", "") or "anodic").lower()
    # concentration is in nM (concentration_nM in the frontend); cMM (mM), when
    # sent, takes precedence for the physical solvers exactly as in resolveParams
    # of src/utils/swvDiffusionSolver.ts.
    concentration = as_float(data, ["concentration", "c"], 0.0)

    if not (step_mv > 0):
        return None, "step_mV must be > 0."
    if not (freq_hz > 0):
        return None, "frequency_Hz must be > 0."
    if not (amp_mv > 0):
        return None, "amplitude_mV must be > 0."
    if quiet_s < 0:
        return None, "quietTime_s must be >= 0."
    if start_e == end_e:
        return None, "startE must differ from endE."
    if direction not in {"anodic", "cathodic"}:
        direction = "anodic"

    swv_model = str(data.get("swvModel", "reversible")).lower()
    if swv_model not in {"reversible", "quasi-reversible", "empirical"}:
        swv_model = "reversible"
    extra: Dict[str, Any] = {"swvModel": swv_model}
    c_mm = finite_float(data.get("cMM"))
    if c_mm is not None:
        extra["cMM"] = max(0.0, c_mm)
    area = finite_float(data.get("area_cm2", data.get("areaCm2")))
    if area is not None and area > 0:
        extra["area_cm2"] = area

    return {
        **extra,
        "startE": start_e,
        "endE": end_e,
        "step_mV": step_mv,
        "amplitude_mV": amp_mv,
        "frequency_Hz": freq_hz,
        "quietTime_s": quiet_s,
        "direction": direction,
        "concentration": concentration,
        # Analyte / redox-probe parameters: they drive the physical solvers
        # (formalPotential = E0', nElectrons, diffusionCoeff; k0/alpha for the
        # quasi-reversible model), as in the frontend simulator.
        "nElectrons": max(1, as_int(data, ["nElectrons"], 1)),
        "diffusionCoeff": max(1e-9, as_float(data, ["diffusionCoeff"], CV_DEFAULT_D_CM2_S)),
        "formalPotential": as_float(data, ["formalPotential"], SWV_EPEAK_V),
        "k0": max(1e-9, as_float(data, ["k0"], 0.01)),
        "alpha": min(0.9, max(0.1, as_float(data, ["alpha"], 0.5))),
        # HSTIA gain (ohms) — ignored by the simulator, forwarded to real
        # hardware so ElectroStat_Firmware.ino's handleStartSwv picks it up
        # instead of always defaulting to 10k.
        "rtiaOhms": max(0.0, as_float(data, ["rtiaOhms"], 10000.0)),
    }, None


def swv_peak_current_ua(concentration_nm: float) -> float:
    return langmuir(concentration_nm, SWV_IMAX_UA, SWV_KD_NM)


def generate_swv_program(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Staircase program, same as generateSWVProgram in src/utils/swvMetrics.ts."""
    step_v = params["step_mV"] / 1000.0
    n = int(math.floor(abs(params["endE"] - params["startE"]) / step_v + 1e-9)) + 1
    ramp = 1 if params["endE"] >= params["startE"] else -1
    period = 1.0 / params["frequency_Hz"]
    return [
        {
            "index": i,
            "E": params["startE"] + ramp * i * step_v,
            "time": params["quietTime_s"] + i * period,
            "direction": params["direction"],
        }
        for i in range(n)
    ]


def _swv_resolve(params: Dict[str, Any]) -> Dict[str, Any]:
    c_mm = params.get("cMM")
    if c_mm is None:
        c_mm = params["concentration"] * 1e-6  # nM -> mM
    f = params["frequency_Hz"]
    return {
        "D": params.get("diffusionCoeff", CV_DEFAULT_D_CM2_S),
        "E0": params.get("formalPotential", CV_E0_PRIME_DEFAULT_V),
        "T": CV_T_DEFAULT_K,
        "n": params.get("nElectrons", 1),
        "A": params.get("area_cm2", 0.0707),
        "c_bulk": max(0.0, c_mm) * 1e-6,  # mol/cm^3
        "esw": max(0.0, params["amplitude_mV"]) / 1000.0,
        "dt_half": 1.0 / (2.0 * f),
        "pulse_sign": 1 if params["endE"] >= params["startE"] else -1,
        "k0": params.get("k0", 0.01),
        "alpha": params.get("alpha", 0.5),
    }


def swv_reversible_exact(params: Dict[str, Any], prog: List[Dict[str, Any]]) -> List[Tuple[float, float]]:
    """Exact reversible SWV (port of simulateReversibleDiffusionSWV).

    With a Nernstian surface, the surface fraction of R is piecewise constant in
    time, so every potential jump da_k at t_k adds a Cottrell response:
        I(t) = -nFA C* sqrt(D/pi) * sum_k da_k / sqrt(t - t_k)
    No mesh and no time stepping. Returns (IForward, IReverse) in uA per step."""
    r = _swv_resolve(params)
    if r["c_bulk"] <= 0:
        return [(0.0, 0.0)] * len(prog)
    nf = r["n"] * CV_F / (CV_R * r["T"])
    surface_r = lambda E: 1.0 / (1.0 + safe_exp(nf * (E - r["E0"])))
    jump_t: List[float] = []
    jump_da: List[float] = []
    state = {"a": 0.0}

    def jump(t: float, a: float):
        jump_t.append(t)
        jump_da.append(a - state["a"])
        state["a"] = a

    if params["quietTime_s"] > 0:
        jump(0.0, surface_r(prog[0]["E"]))
    prefactor = -r["n"] * CV_F * r["A"] * r["c_bulk"] * math.sqrt(r["D"] / math.pi) * 1e6

    def current_at(t: float) -> float:
        return prefactor * sum(da / math.sqrt(t - tk) for tk, da in zip(jump_t, jump_da))

    out: List[Tuple[float, float]] = []
    for s in prog:
        t_fwd = s["time"]
        jump(t_fwd, surface_r(s["E"] + r["pulse_sign"] * r["esw"]))
        i_fwd = current_at(t_fwd + r["dt_half"])
        jump(t_fwd + r["dt_half"], surface_r(s["E"] - r["pulse_sign"] * r["esw"]))
        i_rev = current_at(t_fwd + 2 * r["dt_half"])
        out.append((i_fwd, i_rev))
    return out


# Same sub-step budget as the frontend, so both give identical currents (checked
# to ~1e-13). The history convolution is O(n^2) in the sub-steps: ~5 s in pure
# Python for the default 2 mV / 0.8 V program, which is why the solve runs in a
# worker thread before the points are streamed.
SWV_QUASI_SUBSTEP_BUDGET = 10000
SWV_QUASI_MAX_SUBSTEPS = 24
SWV_QUASI_MIN_SUBSTEPS = 4


def swv_quasi_reversible(params: Dict[str, Any], prog: List[Dict[str, Any]]) -> List[Tuple[float, float]]:
    """Quasi-reversible SWV (port of simulateQuasiReversibleSWV): Butler-Volmer
    kinetics + Cottrell-kernel convolution with each half-pulse split into K
    Chebyshev-graded sub-steps (dense right after the jump and at the sampling
    instant, where the 1/sqrt(t) transient is steep)."""
    r = _swv_resolve(params)
    if r["c_bulk"] <= 0:
        return [(0.0, 0.0)] * len(prog)
    D, T, n, A = r["D"], r["T"], r["n"], r["A"]
    c_bulk, dt_half, esw, sign = r["c_bulk"], r["dt_half"], r["esw"], r["pulse_sign"]
    k0, alpha, e0 = r["k0"], r["alpha"], r["E0"]

    quiet = params["quietTime_s"]
    half_pulses = 2 * len(prog) + (1 if quiet > 0 else 0)
    K = int(clamp(SWV_QUASI_SUBSTEP_BUDGET // half_pulses, SWV_QUASI_MIN_SUBSTEPS, SWV_QUASI_MAX_SUBSTEPS))
    grid = [0.5 * (1 - math.cos(math.pi * j / K)) for j in range(K + 1)]

    tb: List[float] = [0.0]
    epot: List[float] = []

    def add_half_pulse(t0: float, duration: float, E: float) -> int:
        for j in range(1, K + 1):
            tb.append(t0 + duration * grid[j])
            epot.append(E)
        return len(epot) - 1

    if quiet > 0:
        add_half_pulse(0.0, quiet, prog[0]["E"])
    fwd_end: List[int] = []
    rev_end: List[int] = []
    for s in prog:
        fwd_end.append(add_half_pulse(s["time"], dt_half, s["E"] + sign * esw))
        rev_end.append(add_half_pulse(s["time"] + dt_half, dt_half, s["E"] - sign * esw))

    afac = n * CV_F * A
    pref = 1.0 / (afac * math.sqrt(math.pi * D))
    f_rt = n * CV_F / (CV_R * T)
    sqrt = math.sqrt

    n_sub = len(epot)
    cur = [0.0] * n_sub
    for i in range(n_sub):
        t_end = tb[i + 1]
        S = [sqrt(t_end - t) for t in tb[: i + 1]]
        # hist = 2*pref * sum_{m<i} I_m (S_m - S_{m+1})
        hist = 0.0
        for m in range(i):
            hist += cur[m] * (S[m] - S[m + 1])
        hist *= 2.0 * pref
        beta = 2.0 * S[i] * pref

        eta = epot[i] - e0
        k_red = min(CV_BV_K_MAX, k0 * safe_exp(-alpha * f_rt * eta))
        k_ox = min(CV_BV_K_MAX, k0 * safe_exp((1.0 - alpha) * f_rt * eta))
        denom = 1.0 + afac * beta * (k_ox + k_red)
        i_amp = -afac * (k_red * c_bulk + (k_ox + k_red) * hist) / denom

        # Mass-balance clamp, same fallback as buildQuasiReversibleCV.
        theta_r = clamp(-(hist + beta * i_amp) / c_bulk, 0.0, 1.0)
        c_r = theta_r * c_bulk
        c_o = c_bulk - c_r
        if theta_r <= 0.0 or theta_r >= 1.0:
            i_amp = afac * (k_ox * c_r - k_red * c_o)
        cur[i] = i_amp

    return [(cur[f_i] * 1e6, cur[r_i] * 1e6) for f_i, r_i in zip(fwd_end, rev_end)]


def swv_empirical(params: Dict[str, Any], prog: List[Dict[str, Any]]) -> List[Tuple[float, float]]:
    """Legacy empirical Langmuir-Gaussian fallback (swvModel = "empirical")."""
    ipk = swv_peak_current_ua(params["concentration"])
    e_peak = params.get("formalPotential", SWV_EPEAK_V)
    sigma = max(0.02, 0.03 + params["amplitude_mV"] / 4000.0)
    out: List[Tuple[float, float]] = []
    for s in prog:
        E = s["E"]
        base = 0.05 + 0.02 * E
        i_net = ipk * math.exp(-0.5 * ((E - e_peak) / sigma) ** 2) + base
        i_net += gaussian_noise(abs_sigma=0.01)
        cbg = 0.05 + 0.01 * E
        out.append((
            cbg + 0.5 * (i_net - base) + gaussian_noise(abs_sigma=0.01),
            cbg - 0.5 * (i_net - base) + gaussian_noise(abs_sigma=0.01),
        ))
    return out


SWV_MODEL_IDS = {
    "reversible": "reversible_diffusion_approx",
    "quasi-reversible": "quasi_reversible_approx",
    "empirical": "empirical_swv_peak_langmuir",
}


def simulate_swv(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    prog = generate_swv_program(params)
    model = params.get("swvModel", "reversible")
    if model == "quasi-reversible":
        currents = swv_quasi_reversible(params, prog)
    elif model == "empirical":
        currents = swv_empirical(params, prog)
    else:
        currents = swv_reversible_exact(params, prog)
    return [
        {**s, "IForward": i_f, "IReverse": i_r, "INet": i_f - i_r}
        for s, (i_f, i_r) in zip(prog, currents)
    ]


async def loop_swv_simulado(params: Dict[str, Any]):
    print("[SIM] Loop SWV iniciado")
    try:
        while True:
            await sweep_swv_simulado(params)
            if not loop_simulated:
                break
            print("[SIM] SWV completo. Pausa 3s antes de repetir...")
            await asyncio.sleep(3)
    except asyncio.CancelledError:
        # Covers both an explicit stop_swv and a generic stop/cancel_active_task
        # mid-sweep — the frontend must never get stuck in "running".
        print("[SIM] SWV parado")
        await broadcast({"type": "swv_status", "status": "idle"})
        raise


async def sweep_swv_simulado(params: Dict[str, Any]):
    freq = params["frequency_Hz"]
    quiet = params["quietTime_s"]
    direction = params["direction"]
    concentration = params["concentration"]
    model = params.get("swvModel", "reversible")
    period = 1.0 / freq

    await broadcast({"type": "swv_status", "status": "running"})
    try:
        # CPU-bound solve runs off the event loop (stop/ping stay responsive).
        points = await asyncio.to_thread(simulate_swv, params)
        print(f"[SIM-SWV] model={model} C={concentration} nM  n={len(points)} pontos  dir={direction}")
        await asyncio.sleep(min(quiet, 0.5))
        for p in points:
            await broadcast({
                "type": "swv_data",
                "E": round(p["E"], 6),
                "IForward": round(p["IForward"], 6),
                "IReverse": round(p["IReverse"], 6),
                "INet": round(p["INet"], 6),
                "time": round(p["time"], 6),
                "index": p["index"],
                "direction": direction,
                "concentration": concentration,
                "simulationModel": SWV_MODEL_IDS[model],
            })
            await asyncio.sleep(max(0.005, period))

        await broadcast({"type": "swv_done", "points": len(points)})
        await broadcast({"type": "swv_status", "status": "done"})
        print("[SIM] SWV completo")
    except asyncio.CancelledError:
        await broadcast({"type": "swv_status", "status": "idle"})
        print("[SIM] SWV parado a meio")
        raise
    except Exception as e:
        await broadcast({"type": "swv_error", "message": str(e)})
        await broadcast({"type": "swv_status", "status": "error"})
        print(f"[SIM] SWV erro: {e}")


# ══════════════════════════════════════════════════════════════
#  MODO DADOS_REAIS
# ══════════════════════════════════════════════════════════════

MANIFEST_FILENAME = "manifest.csv"


def _ler_manifest(pasta: str) -> Optional[List[Tuple[float, str, Optional[str], str]]]:
    """Reads <pasta>/manifest.csv if present. Columns (header row required):
    filename, sheet, concentration_uM, label
    - filename: the .xlsx file, relative to <pasta>.
    - sheet: worksheet name inside that file, or blank to auto-detect.
    - concentration_uM: analyte concentration in micromolar (convert your
      own units before writing the manifest — e.g. for cortisol,
      uM = (ng/mL) / 362.46, its molar mass in g/mol).
    - label: free-text description, only used for the console log.
    One row per measurement — a multi-sheet file (one sheet per electrode/
    condition) needs one manifest row per sheet. Returns None if no manifest
    file exists, so callers can fall back to the legacy FICHEIROS_EXCEL dict.
    """
    caminho_manifest = os.path.join(pasta, MANIFEST_FILENAME)
    if not os.path.exists(caminho_manifest):
        return None
    entradas = []
    with open(caminho_manifest, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            nome = (row.get("filename") or "").strip()
            if not nome:
                continue
            sheet = (row.get("sheet") or "").strip() or None
            label = (row.get("label") or "").strip() or nome
            try:
                conc = float(row.get("concentration_uM", ""))
            except (TypeError, ValueError):
                print(f"[AVISO] Linha do manifest ignorada (concentration_uM inválida): {row}")
                continue
            caminho = os.path.join(pasta, nome)
            if not os.path.exists(caminho):
                print(f"[AVISO] Não encontrado: {caminho}")
                continue
            entradas.append((conc, caminho, sheet, label))
    return entradas


def carregar_ficheiros_excel(pasta: str):
    global ficheiros_ordenados
    from_manifest = _ler_manifest(pasta)
    if from_manifest is not None:
        encontrados = from_manifest
        origem = MANIFEST_FILENAME
    else:
        # Legacy fixed filename -> concentration mapping (still the default
        # when a folder has no manifest.csv, for backward compatibility).
        encontrados = []
        for nome, conc in FICHEIROS_EXCEL.items():
            caminho = os.path.join(pasta, nome)
            if os.path.exists(caminho):
                encontrados.append((conc, caminho, None, nome))
            else:
                print(f"[AVISO] Não encontrado: {caminho}")
        origem = "FICHEIROS_EXCEL (mapeamento fixo, sem manifest.csv na pasta)"
    ficheiros_ordenados = sorted(encontrados, key=lambda x: x[0])
    print(f"\n[EXCEL] {len(ficheiros_ordenados)} ficheiros encontrados (origem: {origem}):")
    for conc, caminho, sheet, label in ficheiros_ordenados:
        alvo = f"{os.path.basename(caminho)}:{sheet}" if sheet else os.path.basename(caminho)
        print(f"  {conc:10.6f} µM  →  {alvo}  ({label})")
    print()


# Header keywords used to auto-detect EIS columns regardless of which lab
# exported the file. Matched against normalized header text: lowercased,
# with any non-alphanumeric character (|, /, \, (, ), *, ...) replaced by a
# space and split into whole tokens — so "|Z|", "/Z/", "Z*" and "Z (ohm)"
# all normalize to a token list containing "z", and "Frequência (Hz)"
# tokenizes to ["frequência", "hz"] (Python treats accented letters as
# alphanumeric, so "frequência" stays one token — it still matches the
# "freq" substring rule, same as "Frequency" or "frequencia" would).
# Two kinds of rule per field: a substring match (kw in token) for
# multi-letter keywords, and an exact-token match (kw == token) for
# single-/two-letter symbols like "z", "re", "im", which would false-match
# all over the place as substrings (e.g. "z" inside "Hz").
# "dft"-containing columns are excluded from zMag/zReal/zImag/phase
# candidacy because raw DFT-bin values (e.g. "DFT Mag", "DFT Cal") are
# pre-calibration intermediates, not the final impedance in ohms.
_EIS_COL_SUBSTR = {
    "freq": ["freq"],
    "zImag": ["imag", "imaginario", "imaginário"],
    "zReal": ["real"],
    "zMag": ["mag", "impedan"],
    "phase": ["phase", "fase"],
}
_EIS_COL_EXACT_TOKEN = {
    "freq": ["f", "hz"],
    "zImag": ["zi", "im"],
    "zReal": ["zr", "re"],
    "zMag": ["z", "rz", "zmag"],
    "phase": ["phi", "ph"],
}


def _normalizar_header(text: str) -> List[str]:
    lowered = text.strip().lower()
    limpo = "".join(ch if ch.isalnum() else " " for ch in lowered)
    return [tok for tok in limpo.split(" ") if tok]


def _detectar_colunas(header_row) -> Optional[Dict[str, int]]:
    """Given one row of cell values, try to map freq/zReal/zImag/zMag/phase
    to column indices by matching header text. Returns None if freq plus at
    least one of (zReal, zMag) can't be found — i.e. this isn't a header row."""
    norm = []
    for i, cell in enumerate(header_row):
        raw = str(cell).strip().lower() if cell is not None else ""
        tokens = _normalizar_header(str(cell)) if cell is not None else []
        norm.append((i, raw, tokens))
    cols: Dict[str, int] = {}
    for field in _EIS_COL_SUBSTR:
        substrs = _EIS_COL_SUBSTR[field]
        exacts = _EIS_COL_EXACT_TOKEN[field]
        for i, raw, tokens in norm:
            if not raw or "dft" in raw or "index" in raw:
                continue
            if i in cols.values():
                continue  # a column already claimed by another field
            hit = any(kw in tok for tok in tokens for kw in substrs) or any(tok in exacts for tok in tokens)
            if hit:
                cols[field] = i
                break
    if "freq" in cols and ("zReal" in cols or "zMag" in cols):
        return cols
    return None


def _localizar_header(ws) -> Tuple[Optional[Dict[str, int]], int]:
    """Scan the first few rows of a worksheet for a header row with
    recognizable EIS column names. Returns (column map, header row index)
    or (None, -1) if this sheet doesn't look like EIS data at all."""
    for i, row in enumerate(ws.iter_rows(values_only=True, max_row=6)):
        cols = _detectar_colunas(row)
        if cols:
            return cols, i
    return None, -1


def ler_excel(caminho: str, sheet: Optional[str] = None) -> list:
    try:
        import openpyxl
    except ImportError:
        print("[ERRO] pip install openpyxl")
        sys.exit(1)
    wb = openpyxl.load_workbook(caminho, data_only=True)

    if sheet:
        ws = wb[sheet]
        cols, header_idx = _localizar_header(ws)
        if cols is None:
            raise ValueError(f"folha '{sheet}' não parece ter colunas de EIS reconhecíveis")
    else:
        # wb.active is whatever sheet was selected when the file was last
        # saved — often not the data sheet in a multi-sheet export — so scan
        # every sheet and use the first one with a recognizable EIS header.
        ws = cols = None
        header_idx = -1
        for name in wb.sheetnames:
            candidate = wb[name]
            found_cols, found_idx = _localizar_header(candidate)
            if found_cols:
                ws, cols, header_idx = candidate, found_cols, found_idx
                break
        if ws is None:
            raise ValueError("nenhuma folha com colunas de EIS reconhecíveis (freq + zReal/zMag)")

    rows = list(ws.iter_rows(values_only=True))[header_idx + 1:]

    # Phase-unit auto-detection: EIS phase is always in (-180, 180] degrees;
    # if every non-null value in the phase column fits in (-pi, pi], the
    # column is in radians and needs converting.
    phase_col = cols.get("phase")
    phase_is_radians = False
    if phase_col is not None:
        vals = [row[phase_col] for row in rows if len(row) > phase_col and row[phase_col] is not None]
        if vals and all(-math.pi - 1e-6 <= float(v) <= math.pi + 1e-6 for v in vals):
            phase_is_radians = True

    pontos = []
    for row in rows:
        get = lambda key: row[cols[key]] if key in cols and len(row) > cols[key] else None
        freq, zReal, zImag, zMag, phase = get("freq"), get("zReal"), get("zImag"), get("zMag"), get("phase")
        if freq is None or (zReal is None and zMag is None):
            continue
        zreal = float(zReal) if zReal is not None else None
        zimag = float(zImag) if zImag is not None else 0.0
        phase_val = float(phase) if phase is not None else None
        if phase_val is not None and phase_is_radians:
            phase_val = phase_val * 180.0 / math.pi
        # Many potentiostats export Zim already negative. If positive with negative phase, convert.
        if phase_val is not None and phase_val < 0 and zimag > 0:
            zimag = -abs(zimag)
        zmag_val = float(zMag) if zMag is not None else math.sqrt((zreal or 0.0) ** 2 + zimag ** 2)
        if zreal is None:
            # Only |Z| and phase were available — recover Zre/Zim from polar form.
            phase_rad = (phase_val or 0.0) * math.pi / 180.0
            zreal = zmag_val * math.cos(phase_rad)
            zimag = zmag_val * math.sin(phase_rad)
        pontos.append({
            "freq": float(freq),
            "zReal": zreal,
            "zImag": zimag,
            "zMag": zmag_val,
            "phase": phase_val if phase_val is not None else math.atan2(zimag, zreal) * 180.0 / math.pi,
        })
    return pontos


async def enviar_ficheiro_excel():
    global ficheiro_index
    if not ficheiros_ordenados:
        print("[ERRO] Nenhum ficheiro Excel encontrado!")
        return

    conc, caminho, sheet, nome = ficheiros_ordenados[ficheiro_index]
    alvo = f"{nome} [{sheet}]" if sheet else nome
    print(f"\n[EXCEL] A enviar: {alvo}  ({conc} µM)")

    try:
        pontos = ler_excel(caminho, sheet)
    except Exception as e:
        print(f"[ERRO] Não foi possível ler {alvo}: {e}")
        return

    if not pontos:
        print(f"[ERRO] Ficheiro sem pontos válidos: {nome}")
        return

    print(f"[EXCEL] {len(pontos)} pontos | Zre: {min(p['zReal'] for p in pontos):.1f}-{max(p['zReal'] for p in pontos):.1f} Ω")
    try:
        await broadcast({"type": "eis_status", "status": "running"})
        for i, pt in enumerate(pontos):
            await broadcast({
                "type": "eis",
                "zReal": round(pt["zReal"], 3),
                "zImag": round(pt["zImag"], 3),
                "frequency": round(pt["freq"], 6),
                "zMag": round(pt["zMag"], 3),
                "phase": round(pt["phase"], 3),
                "concentration": conc,
                "pointIndex": i,
                "totalPoints": len(pontos),
                "filename": nome,
            })
            await asyncio.sleep(0.15)
        await broadcast({"type": "eis_done", "points": len(pontos), "filename": nome})
        await broadcast({"type": "eis_status", "status": "done"})
        ficheiro_index = (ficheiro_index + 1) % len(ficheiros_ordenados)
        prox = ficheiros_ordenados[ficheiro_index]
        prox_alvo = f"{prox[3]} [{prox[2]}]" if prox[2] else prox[3]
        print(f"\n[EXCEL] Envio completo! Próximo → {prox[0]} µM  ({prox_alvo})")
    except asyncio.CancelledError:
        print("[EXCEL] Envio cancelado")
        await broadcast({"type": "eis_status", "status": "idle"})
        raise


# ══════════════════════════════════════════════════════════════
#  MODO WIFI / SERIAL
# ══════════════════════════════════════════════════════════════

async def run_wifi(esp_ip: str, esp_port: int):
    global esp32_writer
    print(f"[WIFI] A ligar ao ESP32 em {esp_ip}:{esp_port}...")
    while True:
        try:
            reader, writer = await asyncio.open_connection(esp_ip, esp_port)
            esp32_writer = writer
            print("[WIFI] Ligado!")
            while True:
                line = await reader.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="ignore").strip()
                if not text:
                    continue
                try:
                    data = json.loads(text)
                    await forward_esp32_message(data, "WIFI")
                except json.JSONDecodeError:
                    print(f"[WIFI] Ignorado: {text}")
        except (ConnectionRefusedError, OSError) as e:
            esp32_writer = None
            print(f"[WIFI] Sem ligação. Retry em 5s... ({e})")
            await asyncio.sleep(5)
        except Exception as e:
            esp32_writer = None
            print(f"[WIFI] Erro: {e}. Retry em 5s...")
            await asyncio.sleep(5)


async def run_serial(port: str, baud: int):
    global serial_conn
    try:
        import serial
    except ImportError:
        print("[ERRO] pip install pyserial")
        sys.exit(1)
    try:
        serial_conn = serial.Serial(port, baud, timeout=1)
    except Exception as e:
        print(f"[ERRO] Porta serial: {e}")
        sys.exit(1)
    print(f"[SERIAL] Ligado em {port}")
    loop = asyncio.get_event_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, serial_conn.readline)
            if not line:
                continue
            text = line.decode("utf-8", errors="ignore").strip()
            if not text:
                continue
            try:
                data = json.loads(text)
                await forward_esp32_message(data, "SERIAL")
            except json.JSONDecodeError:
                print(f"[SERIAL] JSON ignorado: {text}")
        except Exception as e:
            print(f"[SERIAL] Erro: {e}")
            await asyncio.sleep(0.1)


# ══════════════════════════════════════════════════════════════
#  ARRANQUE
# ══════════════════════════════════════════════════════════════

async def main(args):
    global operation_mode, loop_simulated
    operation_mode = args.mode
    loop_simulated = bool(args.loop_sim)

    print("=" * 64)
    print("  HelpStat — Bridge Unificado Atualizado")
    print("=" * 64)
    print(f"  Modo:      {operation_mode}")
    print(f"  WebSocket: ws://127.0.0.1:{WS_PORT}")

    if operation_mode == "simulated":
        print(f"  Sim loop:  {'ON' if loop_simulated else 'OFF'}")
        print(f"  EIS:       Randles + Cdl || (Rct + Warburg), high→low frequency")
        print(f"  BioFET:    softplus/EKV-like transfer, 60 s time response, VgRead={FET_VG_READ} V")
        print(f"  CV:        reversible diffusion/Nernst (2500 nodes); quasi-reversible Butler-Volmer")
        print(f"  SWV:       exact reversible / graded sub-step quasi-reversible, mirrors frontend solvers")
        print(f"  Kd={KD_SIMULATED_NM} nM | Rct {RCT_BASELINE:.0f}-{RCT_MAX:.0f} Ω | Vt shift max {VT_MAX_SHIFT*1000:.0f} mV")

    elif operation_mode == "dados_reais":
        print(f"  Pasta: {os.path.abspath(args.pasta)}")
        carregar_ficheiros_excel(args.pasta)
        if not ficheiros_ordenados:
            print("[ERRO] Nenhum ficheiro Excel encontrado!")
            sys.exit(1)
        print("[INFO] Cada 'Start EIS' envia a próxima concentração:")
        for i, (conc, _, sheet, nome) in enumerate(ficheiros_ordenados):
            alvo = f"{nome} [{sheet}]" if sheet else nome
            print(f"  Clique {i + 1}: {conc} µM  ({alvo})")
        print("[INFO] Start CV em dados_reais usa simulação CV; ficheiros Excel continuam a ser EIS.")

    elif operation_mode == "wifi":
        print(f"  ESP32: {args.esp_ip}:{args.esp_port}")

    elif operation_mode == "serial":
        print(f"  Porta: {args.port} @ {args.baud} baud")

    print("=" * 64)

    ws_server = websockets.serve(ws_handler, WS_HOST, WS_PORT)
    if operation_mode in ("simulated", "dados_reais"):
        await ws_server
        await asyncio.Future()
    elif operation_mode == "wifi":
        await asyncio.gather(ws_server, run_wifi(args.esp_ip, args.esp_port))
    elif operation_mode == "serial":
        await asyncio.gather(ws_server, run_serial(args.port, args.baud))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="HelpStat — Bridge unificado atualizado",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""
Exemplos:
  python bridge.py --mode simulated
  python bridge.py --mode simulated --loop-sim
  python bridge.py --mode wifi --esp-ip 192.168.4.1
  python bridge.py --mode serial --port COM3
  python bridge.py --mode dados_reais
  python bridge.py --mode dados_reais --pasta "./dados_eis"
        """,
    )
    parser.add_argument("--mode", choices=["simulated", "wifi", "serial", "dados_reais"], default="simulated", help="Modo de operação")
    parser.add_argument("--esp-ip", default="192.168.4.1")
    parser.add_argument("--esp-port", type=int, default=82)
    parser.add_argument("--port", default="COM3")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--pasta", default=".", help="Pasta com ficheiros Excel (modo dados_reais)")
    parser.add_argument("--loop-sim", action="store_true", help="Repete medições simuladas automaticamente até Stop/Ctrl+C")
    args = parser.parse_args()

    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\n[WS] Encerrado.")
