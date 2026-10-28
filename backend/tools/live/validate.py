"""Validate every Kitty workflow against a running ComfyUI through its real /prompt validation.

usage: python validate.py <comfy url> <ComfyUI dir> [--fixtures] [--prompts <roundtrip out dir>]
  --fixtures  create empty placeholder model files and sample inputs in <ComfyUI dir> first
              (only on a throwaway install: the placeholders shadow real downloads)
  --prompts   also validate the prompts the editor made from the UI graphs (roundtrip.js output)

Run ComfyUI with validate_only_ext.py in custom_nodes/ so valid prompts are not executed.
Checks: every node class exists and comes from the pack custom_nodes.json names, and every
workflow validates as shipped, with only required inputs, with all inputs, and per GPU profile.
"""
import io
import json
import struct
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND / "docker"))
from workflow_patch import build_prompt, media_specs  # noqa: E402

URL, COMFY = sys.argv[1], Path(sys.argv[2])
INDEX = {w["id"]: w for w in json.loads((BACKEND / "workflows/index.json").read_text())["workflows"]}
MODELS = json.loads((BACKEND / "models.json").read_text())["models"]
PACKS = json.loads((BACKEND / "custom_nodes.json").read_text())["packs"]
MEDIA = {"image": "example_image.png", "video": "example_video.mp4", "audio": "example_audio.wav"}


def http(path, data=None):
    req = urllib.request.Request(URL + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def fixtures():
    made = 0
    for m in MODELS:
        recs = [m] + list((m.get("variants") or {}).values())
        for r in recs:
            folder = m["folder"]
            if folder.startswith("custom_nodes/") or folder == "nlf":
                continue
            p = COMFY / "models" / folder / r.get("filename", m["filename"])
            p.parent.mkdir(parents=True, exist_ok=True)
            if not p.exists():
                p.write_bytes(b"")
                made += 1
    inp = COMFY / "input"
    inp.mkdir(exist_ok=True)
    from PIL import Image
    for name in ("example_image.png", "example_image2.png", "example_image3.png"):
        Image.new("RGBA", (64, 64), (200, 120, 40, 255)).save(inp / name)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<h", 0) * 16000)
    (inp / "example_audio.wav").write_bytes(buf.getvalue())
    import av
    import numpy as np
    with av.open(str(inp / "example_video.mp4"), "w") as c:
        s = c.add_stream("libx264", rate=24)
        s.width = s.height = 64
        s.pix_fmt = "yuv420p"
        for i in range(24):
            f = av.VideoFrame.from_ndarray(np.full((64, 64, 3), i * 10, np.uint8), format="rgb24")
            for pkt in s.encode(f):
                c.mux(pkt)
        for pkt in s.encode():
            c.mux(pkt)
    print(f"fixtures: {made} placeholder model files, sample image/audio/video in {inp}")


def module_to_pack(module: str):
    if module in ("nodes",) or module.startswith("comfy_extras") or module.startswith("comfy_api_nodes"):
        return "core"
    return module.split(".", 1)[1] if module.startswith("custom_nodes.") else module


def main():
    if "--fixtures" in sys.argv:
        fixtures()
    status, info = http("/object_info")
    assert status == 200, status
    print(f"object_info: {len(info)} node classes")
    # --- 1. every class exists, and comes from the pack custom_nodes.json says
    expected = {}
    for p in PACKS:
        dirname = p.get("dir") or p["repo"].rstrip("/").split("/")[-1]
        for c in p["classes"]:
            expected[c] = (p["id"], dirname)
    used = {}
    for wf_id, wf in INDEX.items():
        api = json.loads((BACKEND / "workflows" / wf["api"]).read_text())
        for n in api.values():
            used.setdefault(n["class_type"], set()).add(wf_id)
    missing, wrong_pack = [], []
    for cls, wfs in sorted(used.items()):
        if cls not in info:
            missing.append(f"{cls}  (used by {', '.join(sorted(wfs))}; expected pack {expected.get(cls, ('core?',))[0]})")
            continue
        actual = module_to_pack(info[cls].get("python_module", ""))
        exp = expected.get(cls)
        if exp is None and actual != "core":
            wrong_pack.append(f"{cls}: comes from {actual}, not listed in custom_nodes.json")
        elif exp is not None and actual == "core":
            wrong_pack.append(f"{cls}: listed under {exp[0]} but is core")
        elif exp is not None and actual.lower() != exp[1].lower():
            wrong_pack.append(f"{cls}: listed under {exp[0]} ({exp[1]}), loaded from {actual}")
    print(f"\n== classes: {len(used)} used, {len(missing)} missing, {len(wrong_pack)} pack mismatches")
    for m in missing:
        print("  MISSING", m)
    for w in wrong_pack:
        print("  PACK   ", w)

    # --- 2. validation through /prompt
    def check(label, prompt):
        status, body = http("/prompt", {"prompt": prompt, "client_id": "kitty-harness"})
        if status == 200 and not (body or {}).get("node_errors"):
            return None
        lines = []
        err = (body or {}).get("error") or {}
        for nid, ne in ((body or {}).get("node_errors") or {}).items():
            for d in ne.get("errors", []):
                ex = d.get("extra_info") or {}
                lines.append(f"{nid} {ne.get('class_type', '')}: {d.get('type')} {ex.get('input_name', '')} "
                             f"{str(ex.get('received_value', ''))[:60]} {d.get('details', '')[:120]}".rstrip())
        if not lines:
            lines.append(f"{err.get('type')}: {err.get('message')} {str(err.get('details', ''))[:200]}")
        return f"{label}: " + " | ".join(lines)

    failures = []
    for wf_id, wf in INDEX.items():
        api = json.loads((BACKEND / "workflows" / wf["api"]).read_text())
        req_media = {s["key"]: MEDIA[s["type"]] for s in media_specs(wf) if s.get("required", True) and s["type"] in MEDIA}
        all_media = {s["key"]: MEDIA[s["type"]] for s in media_specs(wf) if s["type"] in MEDIA}
        for s in media_specs(wf):
            if s["type"] == "image_list":
                all_media[s["key"]] = ["example_image2.png", "example_image3.png"]
        sizes = {k: (64, 64) for k in all_media}
        runs = [("shipped", api)]
        for label, media, profile in (("required-only", req_media, None), ("all-inputs", all_media, None),
                                      ("24gb", req_media, "24gb"), ("80gb", req_media, "80gb")):
            p, _ = build_prompt(wf, api, {"prompt": "a ginger cat", "seed": 7}, media, models=MODELS, profile=profile,
                                job_id="harness", media_size=sizes, silence=lambda s: "example_audio.wav")
            runs.append((label, p))
        for label, p in runs:
            res = check(f"{wf_id} [{label}]", p)
            if res:
                failures.append(res)
    print(f"\n== validation: {len(INDEX)} workflows x 5 variants, {len(failures)} failure(s)")
    for f in failures:
        print("  FAIL", f)
    if "--prompts" in sys.argv:
        files = sorted(Path(sys.argv[sys.argv.index("--prompts") + 1]).glob("*.prompt.json"))
        ui_failures = [r for p in files if (r := check(f"ui:{p.name[:-len('.prompt.json')]}", json.loads(p.read_text())))]
        print(f"\n== editor prompts: {len(files)} UI graphs, {len(ui_failures)} failure(s)")
        for f in ui_failures:
            print("  FAIL", f)
        failures += ui_failures
    time.sleep(1)
    Path("validate_report.json").write_text(json.dumps({"missing": missing, "pack": wrong_pack, "failures": failures}, indent=1))


main()
