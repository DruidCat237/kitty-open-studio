"""api_to_ui builds editor graphs that match ComfyUI's own serialisation rules."""
import json

import api_to_ui
import curate_workflows as cw
import pytest

OBJECT_INFO = {
    "LoadImage": {"input": {"required": {"image": [["a.png", "b.png"], {"image_upload": True}]}},
                  "output": ["IMAGE", "MASK"], "output_name": ["IMAGE", "MASK"], "python_module": "nodes"},
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["m.safetensors"], {}]}},
                               "output": ["MODEL", "CLIP", "VAE"], "output_name": ["MODEL", "CLIP", "VAE"],
                               "python_module": "nodes"},
    "KSampler": {"input": {"required": {
        "model": ["MODEL", {}], "seed": ["INT", {"default": 0, "control_after_generate": True}],
        "steps": ["INT", {"default": 20}], "cfg": ["FLOAT", {"default": 8.0}],
        "sampler_name": [["euler", "dpmpp_2m"], {}], "scheduler": [["simple", "karras"], {}],
        "positive": ["CONDITIONING", {}], "negative": ["CONDITIONING", {}], "latent_image": ["LATENT", {}],
        "denoise": ["FLOAT", {"default": 1.0}]}},
        "output": ["LATENT"], "output_name": ["LATENT"], "python_module": "nodes"},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}], "clip": ["CLIP", {}]}},
                       "output": ["CONDITIONING"], "output_name": ["CONDITIONING"], "python_module": "nodes"},
    "PrimitiveInt": {"input": {"required": {"value": ["INT", {"default": 0}]}}, "output": ["INT"], "output_name": ["INT"],
                     "python_module": "comfy_extras.nodes_primitive"},
    "EmptyLatentImage": {"input": {"required": {"width": ["INT", {"default": 512}], "height": ["INT", {"default": 512}],
                                                "batch_size": ["INT", {"default": 1}]}},
                         "output": ["LATENT"], "output_name": ["LATENT"], "python_module": "nodes"},
    "ComfyMathExpression": {"input": {"required": {"expression": ["STRING", {"default": "a"}]}},
                            "output": ["FLOAT", "INT"], "output_name": ["FLOAT", "INT"], "python_module": "comfy_extras.nodes_math"},
    "VHS_VideoCombine": {"input": {"required": {"images": ["IMAGE", {}], "frame_rate": ["FLOAT", {"default": 8}],
                                                "filename_prefix": ["STRING", {"default": "x"}]}},
                         "output": ["VHS_FILENAMES"], "output_name": ["Filenames"],
                         "python_module": "custom_nodes.ComfyUI-VideoHelperSuite"},
}

API = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["1", 1]}, "_meta": {"title": "Positive"}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
    "4": {"class_type": "PrimitiveInt", "inputs": {"value": 768}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": ["4", 0], "height": 512, "batch_size": 1}},
    "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": 42, "steps": 8, "cfg": 1.0, "sampler_name": "euler",
                                               "scheduler": "simple", "positive": ["2", 0], "negative": ["3", 0],
                                               "latent_image": ["5", 0], "denoise": 1.0}},
    "img": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
    "math": {"class_type": "ComfyMathExpression", "inputs": {"expression": "a*2", "values.a": ["4", 0]}},
    "9": {"class_type": "VHS_VideoCombine", "inputs": {"images": ["img", 0], "frame_rate": 24, "filename_prefix": "out",
                                                       "crf": 19}},
}


def build():
    return api_to_ui.build(API, OBJECT_INFO, "test")


def node(ui, nid):
    return next(n for n in ui["nodes"] if n["id"] == nid)


def test_widget_order_and_seed_control():
    ui = build()
    assert node(ui, 6)["widgets_values"] == [42, "randomize", 8, 1.0, "euler", "simple", 1.0]
    assert [i["name"] for i in node(ui, 6)["inputs"]] == ["model", "positive", "negative", "latent_image"]


def test_upload_and_linked_widget():
    ui = build()
    img = next(n for n in ui["nodes"] if n["type"] == "LoadImage")
    assert img["widgets_values"] == ["a.png", "image"]
    latent = node(ui, 5)
    assert latent["widgets_values"] == [512, 512, 1]  # linked width keeps the default as its widget value
    width = next(i for i in latent["inputs"] if i["name"] == "width")
    assert width["widget"] == {"name": "width"} and width["link"] is not None


def test_links_are_consistent():
    ui = build()
    by_id = {n["id"]: n for n in ui["nodes"]}
    for lid, src, slot, dst, dslot, typ in ui["links"]:
        assert lid in by_id[src]["outputs"][slot]["links"]
        assert by_id[dst]["inputs"][dslot]["link"] == lid
        assert typ == by_id[src]["outputs"][slot]["type"]


def test_non_numeric_ids_dynamic_inputs_and_vhs():
    ui = build()
    ids = [n["id"] for n in ui["nodes"]]
    assert len(ids) == len(set(ids)) and all(isinstance(i, int) for i in ids)
    math = next(n for n in ui["nodes"] if n["type"] == "ComfyMathExpression")
    assert math["inputs"][0]["name"] == "values.a" and math["inputs"][0]["type"] == "INT"
    vhs = next(n for n in ui["nodes"] if n["type"] == "VHS_VideoCombine")
    assert vhs["widgets_values"]["crf"] == 19 and vhs["widgets_values"]["frame_rate"] == 24
    assert "videopreview" in vhs["widgets_values"]
    assert vhs["properties"]["aux_id"] == "ComfyUI-VideoHelperSuite"


def test_house_style():
    ui = build()
    notes = [n for n in ui["nodes"] if n["type"] == "Note"]
    assert len(notes) == 1 and "patreon.com" in notes[0]["widgets_values"][0]
    assert [g["title"].split(" - ")[1] for g in ui["groups"]][:2] == ["Load Models", "Your Inputs"]
    assert node(ui, 2)["title"] == "Positive"


V3_INFO = {
    "Upscaler": {"input": {"required": {"image": ["IMAGE", {}], "seed": ["INT", {"default": 42}],
                                        "batch": ["INT", {"default": 5}]},
                           "optional": {"noise_seed": ["INT", {"control_after_generate": False}]}},
                 "output": ["IMAGE"], "output_name": ["IMAGE"], "python_module": "custom_nodes.seedvr2"},
    "ColorTransfer": {"input": {"required": {
        "image": ["IMAGE", {}], "method": [["reinhard_lab", "mkl_lab"], {}],
        "source_stats": ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "per_frame", "inputs": {"required": {}}},
            {"key": "target_frame", "inputs": {"required": {"target_index": ["INT", {"default": 0}]}}}]}],
        "strength": ["FLOAT", {"default": 1.0}]}},
        "output": ["IMAGE"], "output_name": ["image"], "python_module": "comfy_extras.nodes_color"},
    "BatchImagesNode": {"input": {"required": {"images": ["COMFY_AUTOGROW_V3", {"template": {
        "input": {"required": {"image": ["IMAGE", {}]}}, "prefix": "image", "min": 1, "max": 50}}]}},
        "output": ["IMAGE"], "output_name": ["IMAGE"], "python_module": "comfy_extras.nodes_images"},
    "Concat": {"input": {"required": {"image_1": ["COMFY_MATCHTYPE_V3", {"template": {"allowed_types": "IMAGE,MASK"}}]}},
               "output": ["COMFY_MATCHTYPE_V3"], "output_name": ["output"], "python_module": "custom_nodes.kj"},
    "easy forLoopStart": {"input": {"required": {"total": ["INT", {"default": 1}]},
                                    "optional": {f"initial_value{i}": ["*", {}] for i in range(1, 20)}},
                          "output": ["FLOW_CONTROL", "INT"] + ["*"] * 19,
                          "output_name": ["flow", "index"] + [f"value{i}" for i in range(1, 20)],
                          "python_module": "custom_nodes.ComfyUI-Easy-Use"},
}
V3_API = {
    "1": {"class_type": "Upscaler", "inputs": {"image": ["2", 0], "seed": 7, "batch": 1, "noise_seed": 3}},
    "2": {"class_type": "ColorTransfer", "inputs": {"image": ["3", 0], "method": "mkl_lab",
                                                    "source_stats": "target_frame", "source_stats.target_index": 4,
                                                    "strength": 0.5}},
    "3": {"class_type": "BatchImagesNode", "inputs": {"images.image0": ["4", 0], "images.image1": ["4", 0]}},
    "4": {"class_type": "Concat", "inputs": {"image_1": ["5", 2]}},
    "5": {"class_type": "easy forLoopStart", "inputs": {"total": 2, "initial_value1": ["6", 0]}},
    "6": {"class_type": "Concat", "inputs": {}},
}


def test_v3_widgets_follow_the_editor():
    ui = api_to_ui.build(V3_API, V3_INFO, "v3")
    # an INT named seed gets the editor's control widget even without control_after_generate
    assert node(ui, 1)["widgets_values"] == [7, "randomize", 1, 3]
    # a dynamic combo is followed by the inputs of the chosen option
    assert node(ui, 2)["widgets_values"] == ["mkl_lab", "target_frame", 4, 0.5]
    # autogrow: the connected slots plus one free one, typed from the template; no socket for the group
    batch = node(ui, 3)
    assert [(i["name"], i["type"], i.get("shape")) for i in batch["inputs"]] == [
        ("images.image0", "IMAGE", None), ("images.image1", "IMAGE", 7), ("images.image2", "IMAGE", 7)]
    assert "widgets_values" not in batch
    concat = node(ui, 4)
    assert concat["inputs"][0]["type"] == "IMAGE,MASK" and concat["outputs"][0]["type"] == "*"
    # loop sockets: the used ones plus one free slot, outputs to match
    loop = node(ui, 5)
    assert [i["name"] for i in loop["inputs"] if not i.get("widget")] == ["initial_value1", "initial_value2"]
    assert [o["name"] for o in loop["outputs"]] == ["flow", "index", "value1", "value2"]


@pytest.mark.parametrize("wf_id", api_to_ui.GENERATED)
def test_generated_ui_graphs_are_up_to_date(wf_id):
    """Fails after an API graph changes until `api_to_ui.py --regenerate` has been run."""
    info = json.loads(api_to_ui.OBJECT_INFO_SNAPSHOT.read_text(encoding="utf-8"))
    ui = api_to_ui.generate(cw.OUT_API / f"{wf_id}.json", info, cw.load_models_by_file())
    assert ui == json.loads((cw.OUT_UI / f"{wf_id}.json").read_text(encoding="utf-8"))
