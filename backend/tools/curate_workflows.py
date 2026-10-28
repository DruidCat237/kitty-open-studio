#!/usr/bin/env python3
"""Curate the staged ComfyUI workflows into backend/workflows/{api,ui}/.

One-time migration tool for Phase 1. It reads the owner's staged copies in
sources/workflows/ (the owner's staged copies, not in the repository) and writes the curated, open-weights,
SFW versions that ship with Kitty Open Studio. Running it again is safe: it
always rebuilds the outputs from the staged sources.

What it does, per workflow:
  * swaps "heretic"/fine-tuned text encoders and VAEs for the official files
  * removes CivitAI / unknown-source LoRAs (API: node removed and rewired;
    UI: node bypassed and its file name cleared, so it stays an optional slot)
  * replaces nodes that are proprietary or from unneeded packs with core nodes
  * cleans default prompts and node titles
  * UI only: removes every text note, adds the single orange Patreon note,
    recolors groups with one scheme and lays out ungrouped workflows left to right
  * fills ComfyUI's per-loader "models" download hints from backend/models.json

Usage:  python backend/tools/curate_workflows.py [--sources sources/workflows]
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
OUT_API = BACKEND / "workflows" / "api"
OUT_UI = BACKEND / "workflows" / "ui"

# ---------------------------------------------------------------------------
# Workflow list: id -> (staged base name, auto-layout the UI graph?)
# Workflows that already have hand-made groups keep their positions; the newer,
# ungrouped ones are re-laid out into clean left-to-right step columns.
# ---------------------------------------------------------------------------
WORKFLOWS: dict[str, tuple[str, bool]] = {
    "qwen-image-t2i": ("qwen_image_2_1_t2i", True),
    "qwen-image-edit": ("qwen_image_2_1_image_edit", True),
    "qwen-image-inpaint": ("Qwen_Image_2_1_Inpainting", True),
    "firered-edit": ("FireRed_Image_Edit11", True),
    "qwen-camera-angle": ("Qwen2511 - Camera_Multi_Angle_Single", True),
    "qwen-camera-multi-angle": ("Qwen2511 - Camera_Multi_Angle_Multi", False),
    "ltx25-t2v": ("LTX2.5_T2V_custom-audio", True),
    "ltx25-i2v": ("LTX2.5_I2V_custom-audio", True),
    "ltx25-flf": ("LTX2.5_FLF2V_custom-audio", True),
    "ltx25-v2v-upscale": ("LTX25_v2v_Upscaler_distilled-quality", True),
    "h3-i2v": ("Minimax_h3_i2v", True),
    "h3-talk": ("H3S_talk_fast", True),
    "h3-character-swap": ("H3_CharacterSwap_Ultimate_v2", False),
    "h3-r2v": ("MiniMaxH3_R2V_PowerLora_custom-audio", True),
    "infinitetalk": ("infinitetalk-v3-1", True),
    "infinitetalk-v2v": ("InfiniteTalk-V2V", False),
    "wan22-flf": ("Wan 2.2 - First and Last Frame", True),
    "wan22-i2v-fast": ("Wan 2.2 - Image to Video fast", True),
    "wan21-scail2-loop": ("Wan21_SCAIL2_Loopable", True),
    "frame-interpolation": ("Frame_Interpolation 16 to 30", True),
    "seedvr2-image": ("SeedVR2_simple_image_upscale", True),
    "seedvr2-image-4k": ("SeedVR2_4K_image_upscale", True),
    "seedvr2-video": ("SeedVR2_HD_video_upscale", True),
    "simple-upscale": ("Simple_Upscale", True),
    "qwen-upscale": ("Qwen - Upscale", True),
    "flashvsr-restore": ("video_upscale_with_restore", True),
    "rtx-image-upscale": ("rtx_image_upscale", True),
    "rtx-video-upscale": ("rtx_video_upscale", True),
}

# ---------------------------------------------------------------------------
# Model file swaps (applied to every string in both formats)
# ---------------------------------------------------------------------------
# Model file swaps and dropped LoRAs: the original file names of the staged workflows are not published.
# They live next to the staged workflows in sources/curation-private.json (not in the repository):
#   {"file_renames": {"<staged file>": "<official file>", ...}, "banned_files": ["<LoRA file>", ...],
#    "text_replacements": {"<staged default prompt>": "<neutral SFW prompt>", ...}}
# Without that file the tool still runs; it then only applies the public rules below.
def _private_lists() -> tuple[dict, set]:
    path = Path(__file__).resolve().parents[2] / "sources" / "curation-private.json"
    if not path.exists():
        return {}, set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return dict(data.get("file_renames", {})), set(data.get("banned_files", []))


FILE_RENAMES, BANNED_FILES = _private_lists()


def _private_text_replacements() -> dict[str, str]:
    path = Path(__file__).resolve().parents[2] / "sources" / "curation-private.json"
    if not path.exists():
        return {}
    return dict(json.loads(path.read_text(encoding="utf-8")).get("text_replacements", {}))

LORA_CLASSES = {"LoraLoaderModelOnly": ["model"], "LoraLoader": ["model", "clip"]}
UI_NOTE_TYPES = {"Note", "MarkdownNote", "Label (rgthree)"}

# Required inputs that newer versions of a node pack added after the graphs were saved
# (found by validating against the current packs, see tools/live/validate.py).
# API: missing inputs get these values. UI: (saved widget count, how to upgrade the list).
NODE_UPGRADES = {
    "RIFE VFI": {"dtype": "float32", "torch_compile": False, "batch_size": 1},
    "SAM3Segment": {"model_name": "sam3.1_multiplex_fp16"},
    "RTXVideoSuperResolution": {"strength": 1.0, "image_encoding": "8-bit RGB"},
}
# UI graphs saved with other settings than the tested API export: these nodes take the API values
# (InfiniteTalk's UI loaded a 720p model the manifest does not install and a private character prompt).
UI_SYNC_FROM_API = {
    "infinitetalk": ["122", "246", "270", "312", "313"],
    "h3-talk": ["20", "21"],  # the UI was saved at 20 s / 379 frames, past H3's trained 15 s
}
# Subgraph links lost in a staged UI graph after its API export was made (the editor could not queue it):
# workflow -> [(subgraph name, source node id or subgraph input name, source slot, target node id, target input)]
UI_SUBGRAPH_RELINK: dict[str, list[tuple]] = {}
# Subgraph inputs that lead nowhere (the outer node showed a socket that did nothing).
UI_SUBGRAPH_DROP_INPUTS: dict[str, list[tuple[str, str]]] = {}
CONTROL_MODES = {"fixed", "increment", "decrement", "randomize"}
UI_WIDGET_UPGRADES = {
    "RIFE VFI": ((6,), lambda wv: wv + ["float32", False, 1]),  # new widgets come last
    "SAM3Segment": ((12,), lambda wv: ["sam3.1_multiplex_fp16"] + wv),  # new widget comes first
    # resize_type, its 1 (scale) or 2 (width, height) sub-widgets, quality; strength and encoding are new
    "RTXVideoSuperResolution": ((3, 4), lambda wv: wv + [1.0, "8-bit RGB"]),
}
# Per-workflow values: API {node: {input: value}}, UI {node: {widget index: value}}.
# H3 character swap was saved with its text encoder on "gpu:0", an option ComfyUI lists only with several GPUs.
# Wan FLF's upper image loader fed the end frame and the lower one the start frame.
API_SETTINGS = {"h3-character-swap": {"text_device": {"device": "default"}},
                "wan22-flf": {"67": {"start_image": ["62", 0], "end_image": ["68", 0]}},
                # H3 is trained at a 768 px short edge (~0.98 MP); the saved 0.4 MP is ComfyUI's draft size and
                # looked pixelated (hair) on a 5090 test. FastH3 Omni is built from h3-r2v and inherits it.
                "h3-i2v": {"115": {"megapixels": 0.98}}, "h3-r2v": {"115": {"megapixels": 0.98}},
                # KJ's sage_attention "auto" still imports sageattention; with ATTENTION=sage ComfyUI's own
                # --use-sage-attention covers these models anyway
                "wan21-scail2-loop": {"74": {"sage_attention": "disabled"}},
                # its "comfy" attention broke the audio cross-attention at sizes other than 1024 x 768
                "infinitetalk": {"122": {"attention_mode": "sdpa"}}}
API_TITLES = {"wan22-flf": {"62": "First frame", "68": "Last frame"}}
# Text edits inside strings, API and UI alike: workflow id -> [(old, new)].
STRING_EDITS: dict[str, list[tuple[str, str]]] = {}


def apply_string_edits(wf_id: str, graph):
    def edit(text: str) -> str:
        for old, new in STRING_EDITS.get(wf_id, []):
            text = text.replace(old, new)
        return text
    return map_strings(graph, edit)
UI_SETTINGS = {"h3-character-swap": {"text_device": {0: "default"}},
               "h3-i2v": {"115": {1: 0.98}}, "h3-r2v": {"115": {1: 0.98}},
               "wan21-scail2-loop": {"74": {4: "disabled"}},
               "infinitetalk": {"122": {4: "sdpa"}}}
# Fill-Nodes' only node in the curated set; the pack pulls closed-API SDKs on import,
# which the venv recipe keeps out of the venv. ComfyUI's own converter does the same (float -> int).
FLOAT_TO_INT = "FL_FloatToInt"

PATREON_TEXT = (
    "Support Druid Cat on Patreon: https://www.patreon.com/c/AiDruid\n"
    "Tutorials, workflows & exclusive content.\n\n"
    "Workflow by AI Druid Cat · Kitty Open Studio (MIT)"
)

# Default prompts that are replaced with neutral, SFW examples.
PROMPT_REPLACEMENTS: dict[str, dict[str, str]] = {}
TEXT_REPLACEMENTS = _private_text_replacements()  # staged default prompt -> a neutral SFW example
NEGATIVE_QWEN_CAMERA = (
    "yellowish, AI-like, artificial, unrealistic, ugly, greasy skin, plastic skin, waxy skin, bad anatomy, "
    "abnormal limbs, disproportionate limbs, extra fingers, missing fingers, deformed hands, asymmetrical face, "
    "crossed eyes, uncanny valley, low quality, blurry, overprocessed, flat lighting"
)
TITLE_FIXES = [
    (re.compile(r"\s*\(?heretic int8 - full vision tower\)?", re.I), " (official int8, full vision tower)"),
    (re.compile(r"uncensored[ _-]*heretic", re.I), "official"),
    (re.compile(r"heretic", re.I), "official"),
]
# Node titles / labels that were not in English
TRANSLATIONS = {
    "Audio do pliku: wlasne albo wygenerowane": "Audio for the file: yours or generated",
    "\u662f\u5426\u4f7f\u7528\u52a0\u901fLoRA": "Use the speed-up LoRA?",
    "\u968f\u673a\u79cd": "Random seed",
    "\u5bbd\u5ea6": "Width",
    "\u9ad8\u5ea6": "Height",
    "\u5bbd\u9ad8\u6bd4": "Aspect ratio",
    "\u5207\u6362\u5bbd\u9ad8": "Swap width/height",
    "\u653e\u5927\u7cfb\u6570": "Upscale factor",
    "\u6279\u6b21\u5927\u5c0f": "Batch size",
}
GROUP_TITLE_FIXES = {
    "模型加载": "Load Models",  # Chinese: model loading
    "输入端": "Inputs",  # Chinese: input side
}

# ---------------------------------------------------------------------------
# One visual style: group colors by role (from the owner's style reference)
# ---------------------------------------------------------------------------
STAGES = [
    ("Load Models", "#88A"),
    ("Your Inputs", "#8A8"),
    ("Prepare & Condition", "#a1309b"),
    ("Generate", "#8AA"),
    ("Decode & Save", "#3f789e"),
]
GROUP_COLOR_RULES = [
    (r"model|load|safetensor|lora", "#88A"),
    (r"audio|voice|sound|vocal", "#b58b2a"),
    (r"upscal|interpol|restore", "#3d6630"),
    (r"decod|output|save|result|preview|assembl|video out", "#3f789e"),
    (r"sampl|generat|\bsec\b|second|denois", "#8AA"),
    (r"encod|condition|guide|mask|sam\b|segment|crop|stitch|embed|process|window|plan|latent|nag|mem", "#a1309b"),
    (r"prompt|input|pic|image|reference|user|size|resolution|control|setting|steps|cfg|switch", "#8A8"),
]


def group_color(title: str) -> str:
    t = title.lower()
    for pattern, color in GROUP_COLOR_RULES:
        if re.search(pattern, t):
            return color
    return "#8AA"


# ---------------------------------------------------------------------------
# Generic JSON helpers
# ---------------------------------------------------------------------------
def map_strings(obj, fn):
    """Return obj with fn applied to every string value (dict keys untouched)."""
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [map_strings(v, fn) for v in obj]
    if isinstance(obj, dict):
        return {k: map_strings(v, fn) for k, v in obj.items()}
    return obj


def exact_replacer(mapping: dict[str, str]):
    def fn(s: str) -> str:
        return mapping.get(s, s)
    return fn


def fix_title(title: str) -> str:
    title = TRANSLATIONS.get(title, title)
    for pattern, repl in TITLE_FIXES:
        title = pattern.sub(repl, title)
    return title.strip()


# ---------------------------------------------------------------------------
# API format
# ---------------------------------------------------------------------------
def api_rewire(api: dict, old_ref: list, new_ref) -> None:
    for node in api.values():
        for key, value in list(node.get("inputs", {}).items()):
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(old_ref[0]) and value[1] == old_ref[1]:
                node["inputs"][key] = copy.deepcopy(new_ref)


MEDIA_LOADERS = {"LoadImage": ("image", "example_image{n}.png"), "LoadImageMask": ("image", "example_image{n}.png"),
                 "LoadVideo": ("file", "example_video{n}.mp4"), "VHS_LoadVideo": ("video", "example_video{n}.mp4"),
                 "LoadAudio": ("audio", "example_audio{n}.wav"), "VHS_LoadAudioUpload": ("audio", "example_audio{n}.wav")}


def media_renames(api: dict) -> dict[str, str]:
    """Neutral names for the sample input files the graphs were saved with (private file names)."""
    out: dict[str, str] = {}
    counters: dict[str, int] = {}
    for node in api.values():
        spec = MEDIA_LOADERS.get(node.get("class_type"))
        if not spec:
            continue
        old = node.get("inputs", {}).get(spec[0])
        if isinstance(old, str) and old and old not in out:
            n = counters[spec[1]] = counters.get(spec[1], 0) + 1
            out[old] = spec[1].format(n="" if n == 1 else n)
    return out


def curate_api(wf_id: str, api: dict, notes: list[str], models_by_file: dict | None = None) -> dict:
    api = map_strings(api, exact_replacer(FILE_RENAMES))
    api = map_strings(api, exact_replacer(media_renames(api)))
    api = scrub_media(api)
    api = map_strings(api, exact_replacer(TEXT_REPLACEMENTS))
    api = apply_string_edits(wf_id, api)

    for nid, node in list(api.items()):
        if not isinstance(node, dict) or "class_type" not in node:
            # A pack exported a node without its class; the only case is KayTool's "Text".
            text = (node or {}).get("inputs", {}).get("UNKNOWN")
            if isinstance(text, str):
                api[nid] = {"inputs": {"value": text}, "class_type": "PrimitiveStringMultiline",
                            "_meta": {"title": "Edit Instructions"}}
                notes.append(f"node {nid}: KayTool Text -> core PrimitiveStringMultiline")
                continue
            raise SystemExit(f"{wf_id}: node {nid} has no class_type")

    for nid, node in list(api.items()):
        ctype = node["class_type"]
        inputs = node.get("inputs", {})
        # 1. banned LoRAs: drop the loader and pass its inputs straight through
        if ctype in LORA_CLASSES and inputs.get("lora_name") in BANNED_FILES:
            for slot, key in enumerate(LORA_CLASSES[ctype]):
                api_rewire(api, [nid, slot], inputs[key])
            del api[nid]
            notes.append(f"removed LoRA node {nid} ({inputs.get('lora_name')})")
            continue
        if ctype == "Power Lora Loader (rgthree)":
            # entries are switched off by default, but a LoRA the manifest cannot install must not ship at all
            def unshippable(lora):
                return lora in BANNED_FILES or bool(models_by_file) and lora not in models_by_file
            for key in [k for k, v in inputs.items() if isinstance(v, dict) and "lora" in v and unshippable(v["lora"])]:
                notes.append(f"Power Lora {nid}: removed entry {inputs[key]['lora']}")
                del inputs[key]
        for key, value in NODE_UPGRADES.get(ctype, {}).items():
            if key not in inputs:
                inputs[key] = value
                notes.append(f"node {nid} ({ctype}): added new required input {key}={value!r}")
        for key, value in API_SETTINGS.get(wf_id, {}).get(nid, {}).items():
            inputs[key] = value
            notes.append(f"node {nid} ({ctype}): {key}={value!r}")
        if nid in API_TITLES.get(wf_id, {}):
            node.setdefault("_meta", {})["title"] = API_TITLES[wf_id][nid]
        # 2. Fill-Nodes float -> int becomes ComfyUI's own converter (its INT is output 1, not 0)
        if ctype == FLOAT_TO_INT:
            api[nid] = {"inputs": {"value": inputs["float_value"]}, "class_type": "ComfyNumberConvert",
                        "_meta": {"title": "Number Convert"}}
            api_rewire(api, [nid, 0], [nid, 1])
            notes.append(f"node {nid}: {FLOAT_TO_INT} -> core ComfyNumberConvert")
        # 3. default prompts
        for key, text in PROMPT_REPLACEMENTS.get(wf_id, {}).items():
            if key == nid:
                field = "text" if "text" in node["inputs"] else "prompt"
                node["inputs"][field] = text
        if wf_id == "qwen-camera-angle" and isinstance(inputs.get("prompt"), str) and inputs["prompt"].startswith("Jasne"):
            inputs["prompt"] = NEGATIVE_QWEN_CAMERA
        # 4. titles
        meta = node.get("_meta")
        if meta and "title" in meta:
            meta["title"] = fix_title(meta["title"])
        # 5. a workflow without any Save node keeps its result in temp/: save it instead
        if ctype == "PreviewImage" and not any(n.get("class_type", "").startswith("Save") for n in api.values()):
            node["class_type"] = "SaveImage"
            inputs["filename_prefix"] = f"KittyOpenStudio/{wf_id}"
            node["_meta"] = {"title": "Save Image"}
            notes.append(f"node {nid}: PreviewImage -> SaveImage (no other output)")
        # 6. predictable output names when the workflow is run by hand
        if ctype in ("SaveImage", "SaveVideo", "VHS_VideoCombine") and isinstance(inputs.get("filename_prefix"), str):
            inputs["filename_prefix"] = f"KittyOpenStudio/{wf_id}"
    return api


# ---------------------------------------------------------------------------
# UI (litegraph) format
# ---------------------------------------------------------------------------
def iter_graphs(ui: dict):
    yield ui
    for sg in ui.get("definitions", {}).get("subgraphs", []):
        yield sg


def link_ids_of(graph: dict, node_id) -> set:
    ids = set()
    for link in graph.get("links", []):
        if isinstance(link, dict):
            if link["origin_id"] == node_id or link["target_id"] == node_id:
                ids.add(link["id"])
        elif link[1] == node_id or link[3] == node_id:
            ids.add(link[0])
    return ids


def subgraph_named(ui: dict, name: str) -> dict:
    return next(s for s in (ui.get("definitions") or {}).get("subgraphs", []) if s.get("name") == name)


def ui_node(ui: dict, nid: str) -> dict | None:
    """A UI node by API id: "12" at the top level, "79:77" for node 77 inside subgraph node 79."""
    outer, _, inner = nid.partition(":")
    node = next((n for n in ui["nodes"] if str(n["id"]) == outer), None)
    if node is None or not inner:
        return node
    sg = next((s for s in (ui.get("definitions") or {}).get("subgraphs", []) if s["id"] == node["type"]), None)
    return next((n for n in (sg or {}).get("nodes", []) if str(n["id"]) == inner), None)


def sync_from_api(wf_id: str, ui: dict, api: dict, notes: list[str]) -> None:
    """Copy the tested API values into UI nodes that were saved with other settings.

    Only for nodes whose saved widgets line up one-to-one with the API's literal inputs
    (a seed's control widget, which the API graph does not have, is skipped).
    """
    for nid in UI_SYNC_FROM_API.get(wf_id, []):
        node = ui_node(ui, nid)
        values = [v for v in api[nid]["inputs"].values() if not (isinstance(v, list) and len(v) == 2)]
        wv = node.get("widgets_values") if node else None
        slots = [i for i, v in enumerate(wv or []) if not (v in CONTROL_MODES and i and isinstance(wv[i - 1], int))]
        if not isinstance(wv, list) or len(slots) != len(values):
            raise SystemExit(f"{wf_id}: cannot sync UI node {nid} from the API graph (widgets do not line up)")
        if [wv[i] for i in slots] != values:
            for i, v in zip(slots, values):
                wv[i] = v
            notes.append(f"UI node {nid} ({node['type']}): widget values synced from the API graph")


def repair_subgraphs(wf_id: str, ui: dict, notes: list[str]) -> None:
    """Restore lost subgraph links and drop subgraph inputs that lead nowhere."""
    for sg_name, src, src_slot, dst, dst_input in UI_SUBGRAPH_RELINK.get(wf_id, []):
        sg = subgraph_named(ui, sg_name)
        nodes = {n["id"]: n for n in sg["nodes"]}
        slot = next(i for i, s in enumerate(nodes[dst]["inputs"]) if s["name"] == dst_input)
        if nodes[dst]["inputs"][slot].get("link") is not None:
            continue
        lid = max([sg["state"].get("lastLinkId", 0)] + [lk["id"] for lk in sg["links"]]) + 1
        sg["state"]["lastLinkId"] = lid
        if isinstance(src, str):  # from one of the subgraph's own inputs
            index = next(i for i, s in enumerate(sg["inputs"]) if s["name"] == src)
            sg["inputs"][index]["linkIds"].append(lid)
            origin, origin_slot, typ = -10, index, sg["inputs"][index]["type"]
        else:
            out = nodes[src]["outputs"][src_slot]
            out["links"] = (out.get("links") or []) + [lid]
            origin, origin_slot, typ = src, src_slot, out["type"]
        sg["links"].append({"id": lid, "origin_id": origin, "origin_slot": origin_slot, "target_id": dst,
                            "target_slot": slot, "type": typ})
        nodes[dst]["inputs"][slot]["link"] = lid
        notes.append(f"UI subgraph {sg_name!r}: reconnected {src} -> {dst}.{dst_input}")
    for sg_name, name in UI_SUBGRAPH_DROP_INPUTS.get(wf_id, []):
        sg = subgraph_named(ui, sg_name)
        index = next(i for i, s in enumerate(sg["inputs"]) if s["name"] == name)
        if sg["inputs"][index]["linkIds"] or index != len(sg["inputs"]) - 1:
            raise SystemExit(f"{wf_id}: subgraph input {name!r} is used or not the last one; drop it by hand")
        del sg["inputs"][index]
        for n in ui["nodes"]:
            if n.get("type") == sg["id"]:
                if n["inputs"][index].get("link") is not None:
                    raise SystemExit(f"{wf_id}: subgraph input {name!r} is connected on node {n['id']}")
                del n["inputs"][index]
        notes.append(f"UI subgraph {sg_name!r}: removed the unused input {name!r}")


def curate_ui(wf_id: str, ui: dict, relayout: bool, models_by_file: dict, notes: list[str],
              api: dict | None = None) -> dict:
    ui = copy.deepcopy(ui)
    banned_hits = set()
    has_save = any(n.get("type", "").startswith("Save") for g in iter_graphs(ui) for n in g.get("nodes", []))
    for graph in iter_graphs(ui):
        # remove every text note / label
        drop = [n for n in graph.get("nodes", []) if n.get("type") in UI_NOTE_TYPES]
        for n in drop:
            dead = link_ids_of(graph, n["id"])
            graph["links"] = [l for l in graph.get("links", []) if (l["id"] if isinstance(l, dict) else l[0]) not in dead]
        graph["nodes"] = [n for n in graph.get("nodes", []) if n.get("type") not in UI_NOTE_TYPES]
        for n in graph["nodes"]:
            wv = n.get("widgets_values")
            # banned LoRA loaders become optional, bypassed slots
            if n.get("type") in LORA_CLASSES and isinstance(wv, list) and wv and wv[0] in BANNED_FILES:
                banned_hits.add(wv[0])
                n["mode"] = 4
                n["title"] = "Optional LoRA slot (Ctrl+B to enable)"
            if n.get("type") == "Power Lora Loader (rgthree)" and isinstance(wv, list) and models_by_file:
                # same rule as the API graphs: only LoRAs the installer can download stay in the list
                kept = [w for w in wv if not (isinstance(w, dict) and "lora" in w and w["lora"] not in models_by_file)]
                if len(kept) != len(wv):
                    notes.append(f"UI Power Lora {n['id']}: removed {len(wv) - len(kept)} LoRA entries without a public source")
                    n["widgets_values"] = wv = kept
            upgrade = UI_WIDGET_UPGRADES.get(n.get("type"))
            if upgrade and isinstance(wv, list) and len(wv) in upgrade[0]:
                n["widgets_values"] = wv = upgrade[1](wv)
            if n.get("type") == FLOAT_TO_INT:
                out_links = n["outputs"][0].get("links") or []
                n["type"] = "ComfyNumberConvert"
                n["inputs"] = [{"name": "value", "type": "INT,FLOAT,STRING,BOOLEAN", "link": n["inputs"][0].get("link")}]
                n["outputs"] = [{"name": "FLOAT", "type": "FLOAT", "links": []},
                                {"name": "INT", "type": "INT", "links": out_links}]
                n["widgets_values"] = []
                n["properties"] = {"cnr_id": "comfy-core", "Node name for S&R": "ComfyNumberConvert"}
                for link in graph.get("links", []):  # the INT moved from output 0 to output 1
                    if (link["id"] if isinstance(link, dict) else link[0]) in out_links:
                        if isinstance(link, dict):
                            link["origin_slot"] = 1
                        else:
                            link[2] = 1
            if n.get("type") == "Text" and (n.get("properties", {}).get("aux_id") == "kk8bit/KayTool"):
                n["type"] = "PrimitiveStringMultiline"
                n["properties"] = {"cnr_id": "comfy-core", "Node name for S&R": "PrimitiveStringMultiline"}
                out = n["outputs"][0]
                n["outputs"] = [{"name": "STRING", "type": "STRING", "links": out.get("links")}]
            if n.get("type") == "PreviewImage" and not has_save:
                n["type"] = "SaveImage"
                n["properties"] = {"cnr_id": "comfy-core", "Node name for S&R": "SaveImage"}
                n["widgets_values"] = wv = [f"KittyOpenStudio/{wf_id}"]
            if "title" in n and isinstance(n["title"], str):
                n["title"] = fix_title(n["title"])
            for slot in n.get("inputs", []) + n.get("outputs", []):
                if isinstance(slot.get("label"), str):
                    slot["label"] = TRANSLATIONS.get(slot["label"], slot["label"])
            if n.get("type") in ("SaveImage", "SaveVideo") and isinstance(wv, list) and wv and isinstance(wv[0], str):
                wv[0] = f"KittyOpenStudio/{wf_id}"
            if n.get("type") == "VHS_VideoCombine" and isinstance(wv, dict) and "filename_prefix" in wv:
                wv["filename_prefix"] = f"KittyOpenStudio/{wf_id}"
                if not isinstance(wv.get("save_output", True), bool):  # a shifted widget saved a number here
                    wv["save_output"] = True
            refresh_model_hints(n, models_by_file)
        for g in graph.get("groups", []):
            g["title"] = GROUP_TITLE_FIXES.get(g.get("title", ""), g.get("title", ""))
            if g["title"].startswith("WLASNE AUDIO"):
                g["title"] = "Your audio (select the group + Ctrl+B to let the model make the sound)"
            g["color"] = group_color(g["title"])
    # Promoted subgraph widgets that still carry a banned file name: clear them.
    ui = map_strings(ui, lambda s: "" if s in BANNED_FILES else s)
    ui = map_strings(ui, exact_replacer(FILE_RENAMES))
    ui = map_strings(ui, exact_replacer(TEXT_REPLACEMENTS))
    ui = apply_string_edits(wf_id, ui)
    if wf_id == "qwen-camera-angle":
        ui = map_strings(ui, lambda s: NEGATIVE_QWEN_CAMERA if s.startswith("Jasne —") else s)
    if banned_hits:
        notes.append("UI: bypassed optional LoRA slots that pointed at " + ", ".join(sorted(banned_hits)))
    if api is not None:
        sync_from_api(wf_id, ui, api, notes)
    for nid, widgets in UI_SETTINGS.get(wf_id, {}).items():
        for i, value in widgets.items():
            ui_node(ui, nid)["widgets_values"][i] = value
    repair_subgraphs(wf_id, ui, notes)

    ui = scrub_media(ui)
    if relayout:
        auto_layout(ui)
    add_patreon_note(ui)
    fit_view(ui)
    return ui


MEDIA_EXT = re.compile(r"\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv|mp3|wav|flac|ogg|m4a)$", re.I)


def _neutral_media(s: str) -> str:
    if s.startswith("example_") or not MEDIA_EXT.search(s):
        return s
    if "://" in s or "/output/" in s or s.startswith("/"):
        return ""
    ext = s.rsplit(".", 1)[1].lower()
    if ext in ("png", "jpg", "jpeg", "webp", "gif"):
        return "example_image.png"
    return "example_video.mp4" if ext in ("mp4", "mov", "webm", "mkv") else "example_audio.wav"


def _scrub(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "videopreview":
                out[k] = {"hidden": False, "paused": False, "params": {}}
            elif k == "rgthree_comparer":
                out[k] = {"images": []}
            else:
                out[k] = _scrub(v)
        return out
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return _neutral_media(obj) if isinstance(obj, str) else obj


def scrub_media(graph_json: dict) -> dict:
    """Drop saved previews and sample file names (they point at the author's own files and outputs)."""
    if "nodes" not in graph_json:  # API format
        return {nid: {**n, "inputs": _scrub(n.get("inputs", {}))} for nid, n in graph_json.items()}
    for graph in iter_graphs(graph_json):
        for n in graph.get("nodes", []):
            if n.get("type") == "Image Comparer (rgthree)":
                n["widgets_values"] = []
            if "widgets_values" in n:
                n["widgets_values"] = _scrub(n["widgets_values"])
            # A duplicate of widgets_values written by a frontend extension; ComfyUI ignores it and it
            # would keep stale values (old prompts, file names) after the real widgets are cleaned.
            n.pop("widgets_values_named", None)
    return graph_json


def refresh_model_hints(node: dict, models_by_file: dict) -> None:
    """ComfyUI offers a download for missing models from properties.models."""
    wv = node.get("widgets_values")
    props = node.setdefault("properties", {})
    values = wv if isinstance(wv, list) else []
    hints = []
    for v in values:
        if isinstance(v, str) and v in models_by_file:
            m = models_by_file[v]
            hints.append({"name": m["filename"], "url": m["url"], "directory": m["folder"]})
    if hints:
        props["models"] = hints
    elif "models" in props:
        props["models"] = [h for h in props["models"] if h.get("name") in models_by_file]
        if not props["models"]:
            del props["models"]


# --- layout -----------------------------------------------------------------
LOADER_RE = re.compile(r"(Loader|LoadModel|DownloadAndLoad|ModelLoader|LoadWanVideoT5|LoadDiTModel|LoadVAEModel)", re.I)
INPUT_RE = re.compile(r"^(LoadImage|LoadImageMask|LoadVideo|VHS_LoadVideo|VHS_LoadAudioUpload|LoadAudio|Primitive|ResolutionSelector|CR Seed|Seed|INTConstant|FloatConstant|Int$|Float$|Text$|Text Prompt|CR Prompt Text|StringConcatenate$|CR SDXL Aspect Ratio)", re.I)
SAMPLE_RE = re.compile(r"(Sampler|Guider|Scheduler|RandomNoise|SigmaShift|ModelSampling|ManualSigmas|Upscaler$)", re.I)
OUTPUT_RE = re.compile(r"(Save|Preview|VideoCombine|CreateVideo|VAEDecode|Decode|Comparer|showAnything|RIFE)", re.I)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-")


def seed_stage(node: dict) -> int | None:
    t = node.get("type", "")
    if UUID_RE.match(t):
        return 3  # a subgraph holds the whole pipeline
    if LOADER_RE.search(t) and not t.startswith(("LoadImage", "LoadVideo", "LoadAudio", "VHS_Load")):
        return 0
    if SAMPLE_RE.search(t):
        return 3
    if OUTPUT_RE.search(t):
        return 4
    if INPUT_RE.search(t) or not node.get("inputs"):
        return 1
    return None


def auto_layout(ui: dict) -> None:
    nodes = ui["nodes"]
    by_id = {n["id"]: n for n in nodes}
    edges = []  # (src, dst)
    for l in ui.get("links", []):
        src, dst = (l["origin_id"], l["target_id"]) if isinstance(l, dict) else (l[1], l[3])
        if src in by_id and dst in by_id:
            edges.append((src, dst))
    preds = {n["id"]: [] for n in nodes}
    succs = {n["id"]: [] for n in nodes}
    for s, d in edges:
        preds[d].append(s)
        succs[s].append(d)
    # topological order (graphs are DAGs; fall back to id order on cycles)
    order, indeg = [], {k: len(v) for k, v in preds.items()}
    ready = sorted([k for k, v in indeg.items() if v == 0], key=lambda k: by_id[k]["pos"][1])
    while ready:
        k = ready.pop(0)
        order.append(k)
        for d in succs[k]:
            indeg[d] -= 1
            if indeg[d] == 0:
                ready.append(d)
    order += [k for k in by_id if k not in order]

    stage = {}
    for k in order:
        seeded = seed_stage(by_id[k])
        from_preds = max([stage[p] for p in preds[k] if p in stage], default=0)
        if seeded is None:
            stage[k] = max(2, from_preds)
        elif seeded >= 2:
            stage[k] = max(seeded, min(from_preds, 4))
        else:
            stage[k] = seeded
    # Loaders and inputs that only feed late stages still sit in their own column.

    # depth inside each stage (longest path among same-stage nodes)
    depth = {}
    for k in order:
        same = [depth[p] + 1 for p in preds[k] if p in depth and stage[p] == stage[k]]
        depth[k] = max(same, default=0)

    x = 0.0
    groups = []
    step_no = 0
    for s, (title, color) in enumerate(STAGES):
        members = [k for k in order if stage[k] == s]
        if not members:
            continue
        step_no += 1
        cols = sorted({depth[k] for k in members})
        gx = x
        col_x = x + 20
        max_bottom = 0.0
        for c in cols:
            col_nodes = [k for k in members if depth[k] == c]
            # keep the original top-to-bottom order inside a column
            col_nodes.sort(key=lambda k: (by_id[k]["pos"][1], by_id[k]["pos"][0]))
            y = 70.0
            width = 0.0
            for k in col_nodes:
                n = by_id[k]
                w, h = size_of(n)
                n["pos"] = [round(col_x, 1), round(y, 1)]
                y += h + 50
                width = max(width, w)
            max_bottom = max(max_bottom, y)
            col_x += width + 40
        gw = col_x - gx - 20 + 20
        groups.append({"id": step_no, "title": f"Step {step_no} - {title}", "bounding": [round(gx, 1), 0, round(gw, 1), round(max_bottom + 10, 1)],
                       "color": color, "font_size": 28, "flags": {}})
        x = gx + gw + 10
    ui["groups"] = groups


def size_of(node: dict) -> tuple[float, float]:
    size = node.get("size") or [300, 100]
    if isinstance(size, dict):
        size = [size.get("0", 300), size.get("1", 100)]
    w = max(float(size[0]), 220.0)
    h = max(float(size[1]), 60.0)
    if node.get("flags", {}).get("collapsed"):
        h = 30.0
    return w, h


def bbox(ui: dict):
    xs, ys = [], []
    for n in ui["nodes"]:
        w, h = size_of(n)
        xs += [n["pos"][0], n["pos"][0] + w]
        ys += [n["pos"][1], n["pos"][1] + h]
    for g in ui.get("groups", []):
        b = g["bounding"]
        xs += [b[0], b[0] + b[2]]
        ys += [b[1], b[1] + b[3]]
    return min(xs), min(ys), max(xs), max(ys)


def add_patreon_note(ui: dict) -> None:
    x0, y0, _, _ = bbox(ui)
    nid = max([n["id"] for n in ui["nodes"] if isinstance(n["id"], int)], default=0) + 1
    ui["nodes"].append({
        "id": nid, "type": "Note", "pos": [round(x0, 1), round(y0 - 170, 1)], "size": [420, 130],
        "flags": {}, "order": len(ui["nodes"]), "mode": 0, "inputs": [], "outputs": [],
        "properties": {}, "widgets_values": [PATREON_TEXT], "color": "#8B4513", "bgcolor": "#CD853F",
    })
    ui["last_node_id"] = max(ui.get("last_node_id", 0) or 0, nid)


def fit_view(ui: dict) -> None:
    x0, y0, _, _ = bbox(ui)
    extra = ui.setdefault("extra", {})
    extra["ds"] = {"scale": 0.55, "offset": [round(-x0 + 60, 1), round(-y0 + 60, 1)]}
    for key in ("ue_links", "links_added_by_ue"):
        extra.pop(key, None)


# ---------------------------------------------------------------------------
def load_models_by_file() -> dict:
    path = BACKEND / "models.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for m in data["models"]:
        out[m["filename"]] = m
        for v in (m.get("variants") or {}).values():
            out.setdefault(v["filename"], {**m, **v})
    return out


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


SOURCES = ROOT / "sources" / "workflows"


def main() -> int:
    global SOURCES
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sources", type=Path, default=SOURCES)
    ap.add_argument("--only", nargs="*", help="workflow ids to rebuild")
    args = ap.parse_args()
    SOURCES = args.sources
    if not SOURCES.is_dir():
        print(f"staged workflows not found: {SOURCES}", file=sys.stderr)
        return 1
    OUT_API.mkdir(parents=True, exist_ok=True)
    OUT_UI.mkdir(parents=True, exist_ok=True)
    models_by_file = load_models_by_file()
    report = {}
    for wf_id, (base, relayout) in WORKFLOWS.items():
        if args.only and wf_id not in args.only:
            continue
        notes: list[str] = []
        api = json.loads((SOURCES / f"{base}API.json").read_text(encoding="utf-8"))
        curated = curate_api(wf_id, api, notes, models_by_file)
        write_json(OUT_API / f"{wf_id}.json", curated)
        ui_path = SOURCES / f"{base}.json"
        if ui_path.exists():
            ui = json.loads(ui_path.read_text(encoding="utf-8"))
            ui = map_strings(ui, exact_replacer(media_renames(api)))
            write_json(OUT_UI / f"{wf_id}.json", curate_ui(wf_id, ui, relayout, models_by_file, notes, curated))
        else:
            notes.append("no UI graph staged (API only)")
        report[wf_id] = notes
    for wf_id, notes in report.items():
        print(f"{wf_id}:")
        for n in notes:
            print(f"   - {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
