"""What bridge.py sends to the board.

Run from the repository root:  py -3 -m unittest discover -s tests -v

A start command from the app is cut by a board whose USB receive buffer is 256 bytes (the
firmware line stopped at exactly 256 bytes on one laptop). The bridge therefore sends only the
fields the firmware reads, in compact JSON; these tests check the size, and that nothing the
firmware reads is dropped (the table is compared with the cmd["..."] reads of the firmware).
"""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bridge  # noqa: E402

FIRMWARE_INO = os.path.join(ROOT, "firmware", "ElectroStat_Firmware.ino")

# What the app sends (src/components/helpstat/IndexPage.tsx, SWVMode.tsx, ParametersPanel.tsx),
# with every field filled, as the longest realistic case.
APP_CV = {
    "scanRate": 100, "eStart": 0.6, "eVertex1": -0.2, "eVertex2": 0.6, "nCycles": 3,
    "cMM": 2.5, "areaCm2": 0.0707, "n": 1, "stepPotential": 2, "cvModel": "quasi-reversible",
    "noiseEnabled": True, "spatialNodes": 200, "quietTime": 2, "diffusionCoeff": 7.6e-6,
    "formalPotential": 0.215, "k0": 0.01, "alpha": 0.5, "rtiaOhms": 10000,
}
APP_SWV = {
    "startE": -0.2, "endE": 0.6, "step_mV": 2, "amplitude_mV": 25, "frequency_Hz": 25,
    "quietTime_s": 2, "direction": "anodic", "concentration": 1000, "nElectrons": 1,
    "diffusionCoeff": 7.6e-6, "formalPotential": 0.215, "k0": 0.01, "alpha": 0.5,
    "swvModel": "quasi-reversible", "cMM": 2.5, "area_cm2": 0.0707, "rtiaOhms": 10000,
}
APP_FET = {
    "vgMin": -0.5, "vgMax": 1.5, "vgStep": 0.04, "intervalMs": 200, "concentration": 1000,
    "rtiaOhms": 10000, "kd_nM": 100, "vtBaseline_V": 0.45, "deltaVtMax_V": 0.12,
    "idMax_uA": 50, "idealityFactor": 1.4, "bindingRate_perS": 0.05, "readoutBias_V": 1.0,
    "timeDuration_s": 60, "timeStep_s": 0.5, "injectionTime_s": 10,
}
# What the EIS handler builds from the app's fields (the handler computes "points").
APP_EIS = {
    "freqMin": 0.1, "freqMax": 100000.0, "points": 61, "pointDensityMode": "perDecade",
    "pointsPerDecade": 10, "amplitude": 10.0, "dcBias": 0.0, "concentration": 1000.0,
}


def sent_by_bridge(command: str, params: dict) -> tuple[bytes, dict]:
    payload = bridge.hardware_payload({"command": command, **params})
    return payload, json.loads(payload.decode("utf-8"))


def firmware_reads() -> set:
    """Every cmd["name"] read of the firmware, apart from "command" (and the stop line's)."""
    with open(FIRMWARE_INO, encoding="utf-8", errors="replace") as f:
        text = f.read()
    return set(re.findall(r'cmd\["([A-Za-z_0-9]+)"\]\s*\|', text)) - {"command"}


class StartCommandSize(unittest.TestCase):
    def check_small(self, command, params, expected_fields):
        payload, sent = sent_by_bridge(command, params)
        self.assertLess(len(payload), bridge.HARDWARE_LINE_WARN_BYTES, f"{command}: {len(payload)} bytes")
        self.assertTrue(payload.endswith(b"\n") and payload.count(b"\n") == 1)
        self.assertNotIn(b" ", payload.replace(b"anodic", b""), "compact separators")
        self.assertTrue(payload.startswith(b'{"command":"' + command.encode() + b'"'), "command first")
        for field in expected_fields:
            self.assertIn(field, sent, f"{command}: {field} was dropped")
        return sent

    def test_start_cv_from_the_app(self):
        sent = self.check_small("start_cv", bridge.parse_cv_params(APP_CV),
                                ["scanRate", "eStart", "eVertex1", "eVertex2", "nCycles", "stepMv", "quietTime", "rtiaOhms"])
        self.assertEqual(sent["stepMv"], 2)           # "stepPotential" of the app arrives as stepMv
        self.assertEqual(sent["nCycles"], 3)
        for gone in ("cMM", "areaCm2", "n", "cvModel", "noiseEnabled", "spatialNodes",
                     "diffusionCoeff", "formalPotential", "k0", "alpha"):
            self.assertNotIn(gone, sent)

    def test_start_swv_from_the_app(self):
        params, err = bridge.validate_swv_params(APP_SWV)
        self.assertIsNone(err)
        sent = self.check_small("start_swv", params,
                                ["startE", "endE", "step_mV", "amplitude_mV", "frequency_Hz", "quietTime_s", "direction", "rtiaOhms"])
        for gone in ("swvModel", "area_cm2", "cMM", "nElectrons", "diffusionCoeff", "formalPotential", "k0", "alpha"):
            self.assertNotIn(gone, sent)

    def test_start_fet_from_the_app(self):
        sent = self.check_small("start_fet", bridge.parse_fet_params(APP_FET),
                                ["vgMin", "vgMax", "vgStep", "intervalMs", "concentration", "readoutBias_V",
                                 "timeDuration_s", "timeStep_s", "rtiaOhms"])
        for gone in ("kd_nM", "vtBaseline_V", "deltaVtMax_V", "idMax_uA", "idealityFactor",
                     "bindingRate_perS", "injectionTime_s"):
            self.assertNotIn(gone, sent)

    def test_start_eis_from_the_app(self):
        sent = self.check_small("start_eis", APP_EIS, ["freqMin", "freqMax", "points", "amplitude", "dcBias"])
        self.assertEqual(sent["points"], 61)

    def test_values_are_not_changed(self):
        _, sent = sent_by_bridge("start_cv", bridge.parse_cv_params(APP_CV))
        self.assertEqual(sent, {"command": "start_cv", "scanRate": 100.0, "eStart": 0.6, "eVertex1": -0.2,
                                "eVertex2": 0.6, "nCycles": 3, "stepMv": 2.0, "quietTime": 2.0, "rtiaOhms": 10000.0})

    def test_the_calibration_switch_is_kept_when_the_app_sends_it(self):
        payload, sent = sent_by_bridge("start_cv", {**bridge.parse_cv_params(APP_CV), "calibrate": False})
        self.assertIs(sent["calibrate"], False)
        self.assertLess(len(payload), bridge.HARDWARE_LINE_WARN_BYTES)

    def test_other_commands_are_left_alone(self):
        payload = bridge.hardware_payload({"command": "stop"})
        self.assertEqual(payload, b'{"command":"stop"}\n')
        self.assertEqual(json.loads(bridge.hardware_payload({"command": "stop_cv", "x": 1})), {"command": "stop_cv", "x": 1})

    def test_the_size_is_described_and_a_long_line_warned_about(self):
        self.assertEqual(bridge.describe_hardware_payload(b"x" * 100), "100 bytes")
        self.assertIn("WARNING", bridge.describe_hardware_payload(b"x" * 300))
        self.assertNotIn("WARNING", bridge.describe_hardware_payload(b"x" * 240))


class NothingTheFirmwareReadsIsDropped(unittest.TestCase):
    def test_every_field_the_firmware_reads_is_in_the_table(self):
        in_table = {f for fields in bridge.FIRMWARE_FIELDS.values() for f in fields}
        missing = firmware_reads() - in_table
        # "step_mV"/"stepMv" and "amplitude"/"amplitude_mV" are each read by a different command.
        self.assertEqual(missing, set(), f"the firmware reads these but the bridge drops them: {sorted(missing)}")

    def test_the_table_holds_only_fields_the_firmware_reads(self):
        in_table = {f for fields in bridge.FIRMWARE_FIELDS.values() for f in fields}
        extra = in_table - firmware_reads()
        self.assertEqual(extra, set(), f"the bridge sends these but the firmware never reads them: {sorted(extra)}")

    def test_each_command_keeps_what_its_own_handler_reads(self):
        with open(FIRMWARE_INO, encoding="utf-8", errors="replace") as f:
            text = f.read()
        for command, handler in (("start_eis", "handleStartEis"), ("start_cv", "handleStartCv"),
                                 ("start_fet", "handleStartFet"), ("start_swv", "handleStartSwv")):
            start = text.index(f"void {handler}(JsonDocument &cmd)")
            end = text.find("\nvoid ", start + 10)
            body = text[start:end if end > 0 else len(text)]
            code = re.sub(r"//[^\n]*", "", body)   # comments mention cmd["..."] too
            reads = set(re.findall(r'cmd\["([A-Za-z_0-9]+)"\]', code))
            # startAmperometry() (shared) reads "calibrate" for the three amperometric commands.
            if command != "start_eis":
                reads.add("calibrate")
            self.assertEqual(reads - set(bridge.FIRMWARE_FIELDS[command]), set(), f"{command} drops {sorted(reads - set(bridge.FIRMWARE_FIELDS[command]))}")


if __name__ == "__main__":
    unittest.main()
