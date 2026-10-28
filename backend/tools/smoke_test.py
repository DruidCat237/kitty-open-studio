"""Render test jobs on a running pod, one card after another, and write a report with time, peak VRAM and errors.

Runs next to ComfyUI (a pod terminal or Jupyter), through the same handler the serverless worker uses:

    python3 smoke_test.py                         # images, then edits, then video, then upscalers
    python3 smoke_test.py --phase image edit      # only some phases
    python3 smoke_test.py --only flux3-klein      # single cards (an edit or video card reuses earlier images)
    python3 smoke_test.py --list                  # what would run
    python3 smoke_test.py --warm                  # also time a second run with the models loaded
    COMFY_URL=https://<pod id>-3020.proxy.runpod.net python3 smoke_test.py --out ./smoke   # from another machine

Results go to /workspace/kitty/smoke/<time>/ (one file per output, report.md, report.json) and smoke-<time>.zip
next to it, to download from Jupyter. Between cards ComfyUI unloads its models, so every card shows its own load
time and peak VRAM. Test content stays SFW.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
for cand in (HERE.parent / "docker", Path("/opt/kitty/backend/docker")):
    if (cand / "handler.py").is_file():
        sys.path.insert(0, str(cand))
        break
os.environ.setdefault("OUTPUT_MODE", "base64")
import handler  # noqa: E402

WOMAN = ("a beautiful red-haired woman in her twenties, long wavy copper hair, light freckles, green eyes, "
         "wearing an elegant modern black dress")
NEG = "blurry, low quality, deformed hands, extra fingers, watermark, text, logo"
CAT = "a black cat with bright green eyes"

# (phase, card, inputs, label). Image inputs name an earlier label ("@portrait") and use its first output.
TESTS = [
    ("image", "qwen-image-t2i", {"prompt": f"Fashion influencer photo of {WOMAN}, standing on a rooftop terrace in "
                                           "Paris at golden hour, Eiffel Tower in the soft background, holding a phone, "
                                           "natural skin, 85mm lens, shallow depth of field",
                                 "aspect_ratio": "2:3 (Portrait Photo)", "seed": 1001}, "portrait"),
    ("image", "flux3-klein", {"prompt": f"Candid street style photo of {WOMAN}, walking across a rainy Tokyo crosswalk "
                                        "at night, neon reflections on wet asphalt, clear umbrella, cinematic",
                              "aspect_ratio": "2:3 (Portrait Photo)", "seed": 1002}, "tokyo"),
    ("image", "qwen-image-t2i", {"prompt": f"Instagram photo of {WOMAN}, sitting in a sunlit minimalist cafe with "
                                           "a latte and a laptop, warm morning light, lifestyle photography",
                                 "aspect_ratio": "9:16 (Portrait Widescreen)", "seed": 1003}, "cafe"),
    ("image", "qwen-image-t2i", {"prompt": f"Editorial photo of {WOMAN}, on a yacht deck on the Amalfi coast, "
                                             "turquoise sea, wind in her hair, sunglasses in hand, summer luxury",
                                   "seed": 1004}, "yacht"),
    ("image", "qwen-image-t2i", {"prompt": f"Red carpet photo of {WOMAN}, at a film premiere, camera flashes, "
                                                  "velvet rope, confident pose, high fashion",
                                        "seed": 1005}, "premiere"),
    ("image", "flux3-klein", {"prompt": f"Studio beauty portrait of {WOMAN}, close-up, soft box lighting, "
                                         "neutral grey backdrop, magazine cover look",
                              "aspect_ratio": "3:4 (Portrait Standard)", "seed": 1006}, "studio"),
    ("image", "qwen-image-t2i", {"prompt": "Anime illustration of a young woman with long wavy red hair, green eyes and "
                                           "an elegant black modern dress on a city rooftop at sunset, wind, smiling",
                                 "aspect_ratio": "3:4 (Portrait Standard)", "seed": 1007}, "anime"),
    ("edit", "qwen-image-edit", {"prompt": f"Add {CAT} sitting on the terrace railing next to the woman, looking at "
                                           "the camera. Keep everything else unchanged.",
                                 "image1": "@portrait", "aspect_ratio": "2:3 (Portrait Photo)", "seed": 2001}, "edit-qwen"),
    ("edit", "flux3-klein-edit", {"image1": "@portrait",
                                  "prompt": "The same woman on the rooftop now holds a small fluffy black kitten in her "
                                            "arms, its whole body covered in thick black fur, belly included; big green "
                                            "eyes with wide, round pupils, looking at the camera. Keep "
                                            "her face, hair, dress, background and light unchanged.",
                                  "seed": 2033}, "edit-flux"),
    ("edit", "firered-edit", {"image": "@cafe", "prompt": f"Add {CAT} sitting on the cafe table next to the latte, "
                                                          "photorealistic, matching light", "seed": 2003}, "edit-firered"),
    ("edit", "qwen-image-inpaint", {"image": "@yacht#0.62,0.6,0.97,0.97", "prompt": f"{CAT} lying on the deck",
                                    "seed": 2004}, "edit-inpaint"),
    ("edit", "qwen-image-inpaint", {"image": "@tokyo#0.02,0.68,0.42,0.97",
                                    "prompt": f"{CAT} sitting on the wet crosswalk", "seed": 2005}, "edit-tokyo-inpaint"),
    ("edit", "qwen-camera-angle", {"image": "@studio", "seed": 2006}, "angle"),
    ("video", "ltx25-t2v", {"prompt": f"{WOMAN}, walks toward the camera along a sunny beach promenade, turns her head "
                                      "and smiles, waves gently, seagulls and waves in the background, cinematic "
                                      "tracking shot, natural ambient sound of the sea",
                            "duration": 5, "seed": 3001}, "v-ltx-t2v"),
    ("video", "ltx25-i2v", {"image": "@portrait", "prompt": "She lifts the phone, takes a selfie and laughs, the wind "
                                                            "moves her hair, warm golden light, ambient city sound",
                            "duration": 5, "aspect_ratio": "9:16 (Portrait Widescreen)", "seed": 3002}, "v-ltx-i2v"),
    ("video", "ltx25-flf", {"first": "@portrait", "last": "@edit-qwen",
                            "prompt": "A black cat jumps onto the railing and sits next to her, she smiles at it",
                            "duration": 5, "width": 720, "height": 1280, "seed": 3003}, "v-ltx-flf"),
    ("video", "h3-i2v", {"image": "@cafe", "prompt": "She sips the latte, looks up from the laptop and smiles at "
                                                     "the camera", "duration": 5, "seed": 3004}, "v-h3-i2v"),
    ("video", "wan22-i2v-fast", {"image": "@yacht", "prompt": "The yacht sails slowly, her hair and dress move in the "
                                                              "sea breeze, she puts on sunglasses", "negative": NEG,
                                 "seed": 3005}, "v-wan-i2v"),
    ("video", "wan22-flf", {"first": "@tokyo", "last": "@edit-tokyo-inpaint",
                            "prompt": "A black cat walks across the wet crosswalk and sits at her feet", "seed": 3006},
     "v-wan-flf"),
    ("video", "fasth3-omni", {"prompt": f"{WOMAN}, dances lightly in a modern loft with big windows, soft daylight",
                              "duration": 5, "seed": 3007}, "v-fasth3"),
    ("video", "fasth3-omni-lightvae", {"prompt": "She turns to the camera and says: hi everyone, welcome back to my "
                                                 "channel", "picture1": "@studio", "duration": 5, "seed": 3008},
     "v-fasth3-light"),
    ("video", "h3-r2v", {"picture1": "@portrait", "picture2": "@edit-flux",
                         "prompt": "The woman from picture 1 strolls through a park in autumn with the black cat from "
                                   "picture 2 walking beside her", "duration": 5, "seed": 3009}, "v-h3-r2v"),
    ("more", "h3-talk", {"image": "@studio", "audio": "@speech", "prompt": "She talks warmly to the camera",
                         "duration": 5, "seed": 5001}, "t-h3-talk"),
    ("more", "infinitetalk", {"image": "@portrait", "audio": "@speech", "prompt": "a woman talking to the camera"},
     "t-infinitetalk"),
    ("more", "infinitetalk-v2v", {"video": "@v-h3-i2v", "audio": "@speech", "prompt": "a woman talking"},
     "t-infinitetalk-v2v"),
    ("more", "h3-character-swap", {"video": "@v-fasth3", "character": "@portrait", "prompt": "a woman dancing",
                                   "seed": 5002}, "c-swap"),
    ("more", "h3-character-swap", {"video": "@v-fasth3", "character": "@anime", "prompt": "an anime girl dancing",
                                   "seed": 5006}, "c-swap-anime"),
    ("more", "wan21-scail2-loop", {"image": "@yacht", "video": "@v-fasth3", "prompt": "a woman dancing", "seconds": 5},
     "c-scail-loop"),
    ("more", "solar-render", {"structure": "@graybox", "structure_type": "scene_graybox", "seed": 5007,
                              "summary": "A red-haired woman in a black dress walks along a city street at dusk while "
                                         "the camera trucks slowly to the right past the buildings.",
                              "prompt": "Cinematic dusk in a modern European city, warm street lamps switching on, "
                                        "glass and stone facades with lit windows, wet pavement reflecting the lights. "
                                        "The grey blocks are buildings and shop fronts; the light figure is a "
                                        "red-haired woman in her twenties in an elegant black dress, walking calmly "
                                        "toward the right with a small handbag. The camera trucks right at walking "
                                        "pace, steady, at eye level, a 35mm lens, shallow depth of field, soft film "
                                        "grain, natural colors, light evening breeze in her hair, distant traffic "
                                        "and footsteps in the sound."}, "c-solar"),
    ("more", "qwen-camera-multi-angle", {"image": "@studio", "seed": 5005}, "multi-angle"),
    ("more", "seedvr2-image-4k", {"image": "@portrait"}, "up-seedvr2-4k"),
    ("upscale", "simple-upscale", {"image": "@studio"}, "up-simple"),
    ("upscale", "rtx-image-upscale", {"image": "@portrait", "scale": 2.0}, "up-rtx"),
    ("upscale", "seedvr2-image", {"image": "@cafe"}, "up-seedvr2"),
    ("upscale", "qwen-upscale", {"image": "@anime"}, "up-qwen"),
    ("upscale", "rtx-video-upscale", {"video": "@v-fasth3", "scale": 2.0}, "up-rtx-video"),
    ("upscale", "frame-interpolation", {"video": "@v-wan-i2v", "fps": 50}, "up-interp"),
    ("upscale", "seedvr2-video", {"video": "@v-h3-i2v", "resolution": 1080}, "up-seedvr2-video"),
    ("upscale", "flashvsr-restore", {"video": "@v-fasth3"}, "up-flashvsr"),
    ("upscale", "ltx25-v2v-upscale", {"video": "@v-ltx-t2v", "prompt": "a woman on a sunny beach promenade",
                                      "seed": 4001}, "up-ltx-v2v"),
]


class VramPeak:
    """Polls ComfyUI's /system_stats once a second while a card renders (works from another machine too)."""

    def __init__(self):
        self.peak, self._stop = 0, threading.Event()

    def __enter__(self):
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()
        return self

    def _run(self):
        while not self._stop.is_set():
            try:
                dev = handler.requests.get(f"{handler.COMFY_URL}/system_stats", timeout=10).json()["devices"][0]
                self.peak = max(self.peak, (dev["vram_total"] - dev["vram_free"]) >> 20)
            except (handler.requests.RequestException, ValueError, KeyError, IndexError):
                pass
            self._stop.wait(1)

    def __exit__(self, *exc):
        self._stop.set()
        self._t.join(timeout=5)


def free_vram():
    try:
        handler.requests.post(f"{handler.COMFY_URL}/free", json={"unload_models": True, "free_memory": True}, timeout=30)
        time.sleep(3)
    except handler.requests.RequestException:
        pass


def transparent_box(path: Path, box: list[float]) -> bytes:
    """The picture as a PNG whose box (x0, y0, x1, y1 as fractions) is transparent: the inpaint mask."""
    import io

    from PIL import Image, ImageDraw

    im = Image.open(path).convert("RGBA")
    alpha = Image.new("L", im.size, 255)
    w, h = im.size
    ImageDraw.Draw(alpha).rectangle([box[0] * w, box[1] * h, box[2] * w, box[3] * h], fill=0)
    im.putalpha(alpha)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def check_choices(index: dict) -> list[str]:
    """Card choices and saved combo values that this ComfyUI's nodes no longer accept (renamed options)."""
    info = handler.requests.get(f"{handler.COMFY_URL}/object_info", timeout=120).json()

    def options(cls, name):
        spec = {**info.get(cls, {}).get("input", {}).get("required", {}),
                **info.get(cls, {}).get("input", {}).get("optional", {})}.get(name)
        if spec and isinstance(spec[0], list):
            return spec[0]
        return spec[1].get("options") if spec and spec[0] == "COMBO" and len(spec) > 1 else None

    problems = []
    for entry in index.values():
        api = handler.load_api(entry)
        for spec in entry.get("inputs", []):
            for nid, name, *_ in spec.get("targets", []) if spec["type"] == "choice" else []:
                allowed = options(api[str(nid)]["class_type"], name)
                bad = [o for o in spec.get("options", []) if allowed and o not in allowed]
                if bad:
                    problems.append(f"{entry['id']}: {spec['key']} options {bad} not in {api[str(nid)]['class_type']}")
        for nid, node in api.items():
            if node["class_type"] not in info:
                problems.append(f"{entry['id']}: node {nid} {node['class_type']} is not installed")
                continue
            for name, value in node["inputs"].items():
                allowed = options(node["class_type"], name)
                if isinstance(value, str) and value and allowed and value not in allowed \
                        and not Path(value).suffix:  # file names depend on what is installed
                    problems.append(f"{entry['id']}: node {nid} {node['class_type']}.{name}={value!r} not offered")
    return problems


def resolve(inputs: dict, files: dict[str, Path]) -> tuple[dict, list[str]]:
    out, missing = {}, []
    for key, value in inputs.items():
        if isinstance(value, str) and value.startswith("@"):
            label, _, box = value[1:].partition("#")
            path = files.get(label)
            if path is None:
                missing.append(label)
                continue
            data = path.read_bytes() if not box else transparent_box(path, [float(v) for v in box.split(",")])
            out[key] = {"base64": base64.b64encode(data).decode(), "filename": path.stem + ".png" if box else path.name}
        else:
            out[key] = value
    return out, missing


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", nargs="*", choices=["image", "edit", "video", "upscale", "more"])
    ap.add_argument("--only", nargs="*", help="card ids")
    ap.add_argument("--skip", nargs="*", default=[], help="card ids")
    ap.add_argument("--labels", nargs="*", help="test labels (the output names), for one case of a card")
    ap.add_argument("--out", default="/workspace/kitty/smoke")
    ap.add_argument("--from-run", help="an earlier run folder whose outputs feed the @inputs")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--warm", action="store_true", help="run each card that worked once more, models still loaded")
    args = ap.parse_args()

    index = handler.load_index()
    tests = [t for t in TESTS if (not args.phase or t[0] in args.phase) and (not args.only or t[1] in args.only)
             and t[1] not in args.skip and (not args.labels or t[3] in args.labels)]
    if args.list:
        for phase, card, _inputs, label in tests:
            print(f"{phase:8} {card:24} -> {label}{'' if card in index else '   (not in this index)'}")
        return 0

    run = Path(args.out) / time.strftime("%Y%m%d-%H%M%S")
    run.mkdir(parents=True)
    files: dict[str, Path] = {}
    if args.from_run:
        for p in sorted(Path(args.from_run).iterdir()):
            if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".wav") and "__" in p.stem:
                files.setdefault(p.stem.split("__")[0], p)
    stats = handler.Comfy().wait_ready(timeout=120)
    gpu = (stats.get("devices") or [{}])[0].get("name")
    print(f"ComfyUI {stats.get('system', {}).get('comfyui_version')} on {gpu}; results in {run}", flush=True)
    problems = check_choices(index)
    (run / "schema.txt").write_text("\n".join(problems) + "\n")
    for p in problems:
        print(f"[schema] {p}", flush=True)

    rows = []
    for phase, card, inputs, label in tests:
        row = {"phase": phase, "card": card, "label": label, "est_min": index.get(card, {}).get("est_gpu_minutes")}
        rows.append(row)
        if card not in index:
            row.update(status="skipped", error="not in this image's index")
            continue
        job_inputs, missing = resolve(inputs, files)
        if missing:
            row.update(status="skipped", error=f"needs the output of {', '.join(missing)}")
            print(f"[skip] {card}: {row['error']}", flush=True)
            continue
        free_vram()
        print(f"[run ] {card} ({label}) ...", flush=True)
        t0 = time.time()
        with VramPeak() as vram:
            try:
                result = handler.run_job({"workflow": card, "inputs": job_inputs}, f"{int(time.time()) % 10**6}-{label}")
                error = None
            except Exception as e:  # noqa: BLE001 - report and carry on with the next card
                result, error = {}, f"{type(e).__name__}: {e}"
        row.update(wall_s=round(time.time() - t0, 1), vram_peak_gb=round(vram.peak / 1024, 1),
                   timing=result.get("timing"), seed=result.get("seed"), warnings=result.get("warnings"))
        if error:
            row.update(status="error", error=error)
            print(f"[FAIL] {card}: {error}", flush=True)
            continue
        saved = []
        for i, out in enumerate(result.get("outputs", [])):
            dest = run / f"{label}__{i}{Path(out['filename']).suffix}"
            dest.write_bytes(base64.b64decode(out["base64"]))
            saved.append(dest.name)
        if saved:
            files[label] = run / saved[0]
        row.update(status="ok", files=saved)
        print(f"[ ok ] {card}: {row['wall_s']} s, peak VRAM {row['vram_peak_gb']} GB, {', '.join(saved)}", flush=True)
        if args.warm:  # another seed, or a new upload name: ComfyUI cannot answer from its cache
            again = {**job_inputs, "seed": inputs["seed"] + 1} if "seed" in inputs else job_inputs
            t1 = time.time()
            try:
                handler.run_job({"workflow": card, "inputs": again}, f"{int(time.time()) % 10**6}-w{label}")
                row["warm_s"] = round(time.time() - t1, 1)
                print(f"[warm] {card}: {row['warm_s']} s", flush=True)
            except Exception as e:  # noqa: BLE001
                row["warm_error"] = f"{type(e).__name__}: {e}"
        write_report(run, gpu, rows)
    write_report(run, gpu, rows)
    archive = shutil.make_archive(str(run.parent / f"smoke-{run.name}"), "zip", run)
    print(f"\nreport: {run / 'report.md'}\nzip:    {archive}")
    return 0 if all(r["status"] != "error" for r in rows) else 1


def write_report(run: Path, gpu: str, rows: list[dict]) -> None:
    (run / "report.json").write_text(json.dumps({"gpu": gpu, "results": rows}, indent=2))
    lines = [f"# Smoke test on {gpu}", "",
             "| phase | card | status | wall s | ComfyUI s | warm s | est min | peak VRAM GB | note |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        t = r.get("timing") or {}
        note = r.get("error") or "; ".join(r.get("warnings") or []) or ", ".join(r.get("files") or [])
        lines.append(f"| {r['phase']} | {r['card']} | {r.get('status', '')} | {r.get('wall_s', '')} | "
                     f"{t.get('comfyui_s', '')} | {r.get('warm_s', '')} | {r.get('est_min', '')} | "
                     f"{r.get('vram_peak_gb', '')} | "
                     f"{str(note).replace('|', '/')[:300]} |")
    (run / "report.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    sys.exit(main())
