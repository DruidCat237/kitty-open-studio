#!/usr/bin/env python3
"""Build the FastH3 Omni workflows from the curated MiniMax H3 R2V graph.

FastH3 Omni (FastVideo / Nuva Lab) is an 8-step distillation of MiniMax H3
reference-to-video: text plus ordered references (<Picture N>, <Video N>,
<Audio N> in the prompt) -> video with synced 32 kHz stereo audio at 24 fps.
Settings follow the model card: 8 steps, Euler, simple schedule, guidance 1.0
(BasicGuider), shifts 12 (video) / 3 (audio) via the core ModelSamplingMiniMaxH3.

Outputs (core ComfyUI nodes only, plus the optional LightVAE decoder):
  workflows/api/fasth3-omni.json            INT8 ConvRot (GPU_PROFILE swaps FP8 / BF16)
  workflows/api/fasth3-omni-lightvae.json   same, decoded with LightVAE lite (faster decode)
  workflows/ui/fasth3-omni-int8.json        UI graph, LightVAE present but bypassed
  workflows/ui/fasth3-omni-fp8.json         UI graph for the FP8 diffusion model

Run after curate_workflows.py:  python backend/tools/build_fasth3.py
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate_workflows as cw  # noqa: E402

WF = cw.BACKEND / "workflows"
INT8 = "fasth3_omniref_8step_pruned_int8_convrot.safetensors"
FP8 = "fasth3_omniref_fp8_comfy.safetensors"
LIGHTVAE_DECODER = "lightvae-lite-h3-decoder.safetensors"

DEFAULT_PROMPT = (
    "Cinematic, warm golden-hour light, shallow depth of field. <Picture 1> is the main character: "
    "a ginger cat in a tiny green backpack. The cat walks along a sunny garden wall, stops, looks into "
    "the camera and gives a short happy meow. Soft wind in the leaves, distant birdsong, gentle "
    "acoustic guitar music. Smooth handheld camera, slight push-in."
)

# R2V node ids (see backend/workflows/api/h3-r2v.json)
SAVE, RES, VVAE, AVAE, DEC_A, DEC_V, KSEL, SCHED, SAMPLER, GUIDER = "92", "115", "119", "120", "121", "122", "123", "124", "125", "126"
UNET, CLIP, NOISE, MAKE_VIDEO, LENGTH, SECONDS, R2V, PIC1, PROMPT, PIC2, LORA, AUDIO = (
    "127", "128", "129", "130", "131", "132", "136", "137", "138", "139", "141", "142")


def build_api(light_vae: bool) -> dict:
    api = json.loads((WF / "api" / "h3-r2v.json").read_text(encoding="utf-8"))
    # drop the Power Lora loader: FastH3 Omni is a distilled model, keep it core-only
    cw.api_rewire(api, [LORA, 0], [UNET, 0])
    cw.api_rewire(api, [LORA, 1], [CLIP, 0])
    del api[LORA]
    api[UNET]["inputs"]["unet_name"] = INT8
    api[UNET]["_meta"] = {"title": "FastH3 Omni diffusion model"}
    api["sigma_shift"] = {"inputs": {"shift_video": 12.0, "shift_audio": 3.0, "model": [UNET, 0]},
                          "class_type": "MiniMaxH3SigmaShift", "_meta": {"title": "ModelSamplingMiniMaxH3 (12 / 3)"}}
    api[GUIDER]["inputs"]["model"] = ["sigma_shift", 0]
    api[SCHED]["inputs"].update({"model": ["sigma_shift", 0], "steps": 8, "scheduler": "simple", "denoise": 1})
    api[KSEL]["inputs"]["sampler_name"] = "euler"
    api[PROMPT]["inputs"]["value"] = DEFAULT_PROMPT
    api[PIC1]["_meta"] = {"title": "Picture 1"}
    api[PIC2]["_meta"] = {"title": "Picture 2 (optional)"}
    api[AUDIO]["_meta"] = {"title": "Audio 1 (optional)"}
    api["ref_video"] = {"inputs": {"file": ""}, "class_type": "LoadVideo", "_meta": {"title": "Video 1 (optional)"}}
    api["ref_video_parts"] = {"inputs": {"video": ["ref_video", 0]}, "class_type": "GetVideoComponents",
                              "_meta": {"title": "Video 1 frames + sound"}}
    api[R2V]["inputs"]["ref_videos.ref_video_0"] = ["ref_video_parts", 0]
    api[R2V]["inputs"]["ref_video_audios.ref_video_audio_0"] = ["ref_video_parts", 1]
    api[R2V]["inputs"]["ref_image_size"] = "match"
    api[SAVE]["inputs"]["filename_prefix"] = "KittyOpenStudio/fasth3-omni"
    if light_vae:
        api["light_vae"] = {"inputs": {"decoder": LIGHTVAE_DECODER, "encoder": "none", "base_vae": [VVAE, 0]},
                            "class_type": "LightVAELoader", "_meta": {"title": "LightVAE lite decoder (fast decode)"}}
        api[DEC_V]["inputs"]["vae"] = ["light_vae", 0]
    return api


class UIGraph:
    """Tiny helper for editing a top-level litegraph workflow."""

    def __init__(self, ui: dict):
        self.ui = ui
        self.by_id = {n["id"]: n for n in ui["nodes"]}

    def next_link_id(self) -> int:
        nxt = max([l[0] for l in self.ui["links"]] + [self.ui.get("last_link_id", 0)]) + 1
        self.ui["last_link_id"] = nxt
        return nxt

    def next_node_id(self) -> int:
        nxt = max([n["id"] for n in self.ui["nodes"]] + [self.ui.get("last_node_id", 0)]) + 1
        self.ui["last_node_id"] = nxt
        return nxt

    def link(self, src: int, src_slot: int, dst: int, dst_input: str) -> None:
        dn = self.by_id[dst]
        slot = next(i for i, s in enumerate(dn["inputs"]) if s["name"] == dst_input)
        old = dn["inputs"][slot].get("link")
        if old is not None:
            self.unlink(old)
        lid = self.next_link_id()
        typ = self.by_id[src]["outputs"][src_slot]["type"]
        self.ui["links"].append([lid, src, src_slot, dst, slot, typ])
        dn["inputs"][slot]["link"] = lid
        outs = self.by_id[src]["outputs"][src_slot]
        outs["links"] = (outs.get("links") or []) + [lid]

    def unlink(self, lid: int) -> None:
        for l in list(self.ui["links"]):
            if l[0] == lid:
                self.ui["links"].remove(l)
                src = self.by_id.get(l[1])
                if src:
                    out = src["outputs"][l[2]]
                    out["links"] = [x for x in (out.get("links") or []) if x != lid]
                dst = self.by_id.get(l[3])
                if dst:
                    dst["inputs"][l[4]]["link"] = None

    def consumers(self, nid: int, slot: int) -> list[tuple[int, str]]:
        res = []
        for l in self.ui["links"]:
            if l[1] == nid and l[2] == slot:
                res.append((l[3], self.by_id[l[3]]["inputs"][l[4]]["name"]))
        return res

    def remove(self, nid: int) -> None:
        for l in [l for l in self.ui["links"] if nid in (l[1], l[3])]:
            self.unlink(l[0])
        self.ui["nodes"] = [n for n in self.ui["nodes"] if n["id"] != nid]
        del self.by_id[nid]

    def add(self, node: dict) -> int:
        node = copy.deepcopy(node)
        node["id"] = self.next_node_id()
        node.setdefault("flags", {})
        node.setdefault("mode", 0)
        node["order"] = len(self.ui["nodes"])
        node.setdefault("pos", [0, 0])
        self.ui["nodes"].append(node)
        self.by_id[node["id"]] = node
        return node["id"]


def core_props(t: str) -> dict:
    return {"cnr_id": "comfy-core", "Node name for S&R": t}


def build_ui(unet_file: str) -> dict:
    ui = json.loads((cw.SOURCES / "MiniMaxH3_R2V_PowerLora_custom-audio.json").read_text(encoding="utf-8"))
    src_api = json.loads((cw.SOURCES / "MiniMaxH3_R2V_PowerLora_custom-audioAPI.json").read_text(encoding="utf-8"))
    ui = cw.map_strings(ui, cw.exact_replacer(cw.media_renames(src_api)))
    # Start from the owner's R2V graph, cleaned the same way as every other workflow.
    ui = cw.curate_ui("fasth3-omni", ui, relayout=False, models_by_file={}, notes=[])
    ui["nodes"] = [n for n in ui["nodes"] if n["type"] != "Note"]  # re-added after layout
    g = UIGraph(ui)
    i_unet, i_clip, i_lora = int(UNET), int(CLIP), int(LORA)
    for dst, name in g.consumers(i_lora, 0):
        g.link(i_unet, 0, dst, name)
    for dst, name in g.consumers(i_lora, 1):
        g.link(i_clip, 0, dst, name)
    g.remove(i_lora)
    g.by_id[i_unet]["widgets_values"] = [unet_file, "default"]
    g.by_id[i_unet]["title"] = "FastH3 Omni diffusion model"
    g.by_id[int(KSEL)]["widgets_values"] = ["euler"]
    g.by_id[int(SCHED)]["widgets_values"] = ["simple", 8, 1]
    g.by_id[int(RES)]["widgets_values"][1] = 0.98  # H3's native size; the source graph has the 0.4 MP draft size
    g.by_id[int(PROMPT)]["widgets_values"] = [DEFAULT_PROMPT]
    g.by_id[int(PROMPT)]["title"] = "Prompt - use <Picture 1>, <Video 1>, <Audio 1> tags"
    g.by_id[int(PIC1)]["title"] = "Picture 1"
    g.by_id[int(PIC2)]["title"] = "Picture 2 (optional)"
    g.by_id[int(AUDIO)]["title"] = "Audio 1 (optional)"
    g.by_id[int(SECONDS)]["title"] = "Duration in seconds"
    for n in ui["nodes"]:
        n["properties"].pop("ue_properties", None)

    shift = g.add({"type": "MiniMaxH3SigmaShift", "title": "ModelSamplingMiniMaxH3 (12 / 3)", "size": [320, 110],
                   "inputs": [{"name": "model", "type": "MODEL", "link": None}],
                   "outputs": [{"name": "MODEL", "type": "MODEL", "links": []}],
                   "properties": core_props("MiniMaxH3SigmaShift"), "widgets_values": [12, 3]})
    g.link(i_unet, 0, shift, "model")
    g.link(shift, 0, int(GUIDER), "model")
    g.link(shift, 0, int(SCHED), "model")

    vid = g.add({"type": "LoadVideo", "title": "Video 1 (optional, 24 fps, 2-15 s)", "size": [360, 280],
                 "inputs": [], "outputs": [{"name": "VIDEO", "type": "VIDEO", "links": []}],
                 "properties": core_props("LoadVideo"), "widgets_values": [""]})
    parts = g.add({"type": "GetVideoComponents", "title": "Video 1 frames + sound", "size": [330, 145],
                   "inputs": [{"name": "video", "type": "VIDEO", "link": None}],
                   "outputs": [{"name": "images", "type": "IMAGE", "links": []},
                               {"name": "audio", "type": "AUDIO", "links": []},
                               {"name": "fps", "type": "FLOAT", "links": []}],
                   "properties": core_props("GetVideoComponents"), "widgets_values": []})
    g.link(vid, 0, parts, "video")
    g.link(parts, 0, int(R2V), "ref_videos.ref_video_0")
    g.link(parts, 1, int(R2V), "ref_video_audios.ref_video_audio_0")

    lvae = g.add({"type": "LightVAELoader", "title": "LightVAE fast decode (optional: Ctrl+B to enable)", "size": [420, 110],
                  "mode": 4, "inputs": [{"name": "base_vae", "type": "VAE", "link": None}],
                  "outputs": [{"name": "VAE", "type": "VAE", "links": []}],
                  "properties": {"aux_id": "ModelTC/LightVAE", "Node name for S&R": "LightVAELoader"},
                  "widgets_values": [LIGHTVAE_DECODER, "none"]})
    g.link(int(VVAE), 0, lvae, "base_vae")
    g.link(lvae, 0, int(DEC_V), "vae")

    models = cw.load_models_by_file()
    for n in ui["nodes"]:
        cw.refresh_model_hints(n, models)
    cw.auto_layout(ui)
    cw.add_patreon_note(ui)
    cw.fit_view(ui)
    return ui


def main() -> int:
    cw.write_json(WF / "api" / "fasth3-omni.json", build_api(light_vae=False))
    cw.write_json(WF / "api" / "fasth3-omni-lightvae.json", build_api(light_vae=True))
    cw.write_json(WF / "ui" / "fasth3-omni-int8.json", build_ui(INT8))
    cw.write_json(WF / "ui" / "fasth3-omni-fp8.json", build_ui(FP8))
    print("FastH3 Omni workflows written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
