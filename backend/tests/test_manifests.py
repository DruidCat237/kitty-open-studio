"""The manifests, the workflows and the house rules stay consistent."""
import json
import re

import manifest
from conftest import BACKEND


def test_manifest_check_passes():
    assert manifest.run(sync=False) == 0


def test_every_json_file_parses():
    for path in BACKEND.rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))


def test_models_have_download_info():
    for m in json.loads((BACKEND / "models.json").read_text())["models"]:
        if m.get("auto_download"):
            continue
        assert m["url"].startswith("https://"), m["id"]
        assert m["size_bytes"] and m["size_bytes"] > 0, m["id"]
        # Hugging Face hides checksums of gated repos from anonymous requests (LTX 2.5).
        assert m["gated"] or re.fullmatch(r"[0-9a-f]{64}", m["sha256"] or ""), m["id"]
        assert "civit" + "ai" not in m["url"].lower()


def test_no_weights_in_repo():
    weights = [p for p in BACKEND.rglob("*") if p.suffix in (".safetensors", ".ckpt", ".pth", ".gguf", ".pt", ".onnx")]
    assert not weights


def test_fasth3_settings():
    api = json.loads((BACKEND / "workflows/api/fasth3-omni.json").read_text())
    by_class = {n["class_type"]: n["inputs"] for n in api.values()}
    assert by_class["BasicScheduler"]["steps"] == 8
    assert by_class["KSamplerSelect"]["sampler_name"] == "euler"
    assert by_class["MiniMaxH3SigmaShift"]["shift_video"] == 12.0
    assert by_class["MiniMaxH3SigmaShift"]["shift_audio"] == 3.0
    assert "BasicGuider" in by_class  # guidance 1.0
    assert by_class["UNETLoader"]["unet_name"].startswith("fasth3_omniref")
    light = json.loads((BACKEND / "workflows/api/fasth3-omni-lightvae.json").read_text())
    assert any(n["class_type"] == "LightVAELoader" for n in light.values())


def test_ui_workflows_have_one_orange_note_and_no_markdown():
    for path in (BACKEND / "workflows/ui").glob("*.json"):
        assert not manifest.check_ui(path), path.name


def test_sync_from_api_skips_the_seed_control_widget(monkeypatch):
    import curate_workflows as cw

    ui = {"nodes": [{"id": 5, "type": "KSampler", "widgets_values": [1, "randomize", 20, 8.0, "euler", "normal", 1.0]}]}
    api = {"5": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 8, "cfg": 1.0, "sampler_name": "euler",
                                                      "scheduler": "simple", "denoise": 0.5, "model": ["1", 0]}}}
    monkeypatch.setitem(cw.UI_SYNC_FROM_API, "t", ["5"])
    notes = []
    cw.sync_from_api("t", ui, api, notes)
    assert ui["nodes"][0]["widgets_values"] == [7, "randomize", 8, 1.0, "euler", "simple", 0.5] and notes
