import json

import pytest
import workflow_patch as wp
from conftest import BACKEND

INDEX = {w["id"]: w for w in json.loads((BACKEND / "workflows/index.json").read_text())["workflows"]}
MODELS = json.loads((BACKEND / "models.json").read_text())["models"]


def api_of(wf_id):
    return json.loads((BACKEND / "workflows" / INDEX[wf_id]["api"]).read_text())


def build(wf_id, inputs=None, media=None, **kw):
    return wp.build_prompt(INDEX[wf_id], api_of(wf_id), inputs or {}, media or {}, models=MODELS,
                           silence=lambda s: f"silence_{int(s)}.wav", job_id="test1234", **kw)


def dummy_media(entry):
    media = {}
    for spec in wp.media_specs(entry):
        if spec.get("required", True) and spec["type"] != "image_list":
            media[spec["key"]] = f"{spec['key']}.{dict(image='png', video='mp4', audio='wav')[spec['type']]}"
    return media


@pytest.mark.parametrize("wf_id", sorted(INDEX))
def test_every_workflow_builds_with_required_inputs(wf_id):
    entry = INDEX[wf_id]
    prompt, info = build(wf_id, {"prompt": "a cat"}, dummy_media(entry))
    for nid, node in prompt.items():  # no dangling links after optional nodes were removed
        for key, val in node["inputs"].items():
            if isinstance(val, list) and len(val) == 2 and isinstance(val[1], int):
                assert str(val[0]) in prompt, f"{wf_id}: {nid}.{key} -> {val[0]}"
    for out in entry["outputs"]["nodes"]:
        assert out in prompt


def test_seed_rules():
    assert wp.resolve_seed(42) == (42, "as given")
    assert wp.resolve_seed(-1)[1] == "random"
    assert wp.resolve_seed("abc")[1].startswith("random")
    assert wp.resolve_seed(2 ** 40)[0] <= wp.SEED_MAX


def test_h3_frames_grid():
    for s in (1, 5, 7.3, 15, 60):
        n = wp.h3_frames(s)
        assert (n - 5) % 17 == 0 and 5 <= n <= wp.H3_MAX_FRAMES


def test_h3_size_keeps_aspect_and_budget():
    w, h = wp.h3_size_from_image(1080, 1920, 362)
    assert w % 32 == 0 and h % 32 == 0 and h > w
    assert w * h * 362 <= wp.H3_MAX_PIXEL_FRAMES


def test_optional_pictures_are_removed_and_slots_renumbered():
    prompt, _ = build("fasth3-omni", {"prompt": "<Picture 1>"}, {"picture1": "a.png", "more_pictures": ["b.png", "c.png"]})
    refs = {k: v for k, v in prompt["136"]["inputs"].items() if k.startswith("ref_images.")}
    assert sorted(refs) == ["ref_images.ref_image_0", "ref_images.ref_image_1", "ref_images.ref_image_2"]
    assert "139" not in prompt and "142" not in prompt and "ref_video" not in prompt
    assert not any(k.startswith("ref_audios.") or k.startswith("ref_videos.") for k in prompt["136"]["inputs"])


def test_gpu_profile_swaps_model_files():
    prompt, info = build("fasth3-omni", {"prompt": "x"}, {"picture1": "a.png"}, profile="24gb")
    assert prompt["127"]["inputs"]["unet_name"] == "fasth3_omniref_fp8_comfy.safetensors"
    assert list(info["variants"].values()) == ["fasth3_omniref_fp8_comfy.safetensors"]


def test_missing_custom_audio_uses_silence_and_flips_switch():
    prompt, _ = build("ltx25-t2v", {"prompt": "x", "duration": 6})
    assert prompt["413"]["inputs"]["audio"] == "silence_7.wav"
    assert prompt["414"]["inputs"]["value"] is False
    prompt, _ = build("ltx25-t2v", {"prompt": "x"}, {"audio": "song.wav"})
    assert prompt["413"]["inputs"]["audio"] == "song.wav"
    assert prompt["414"]["inputs"]["value"] is True


def test_required_media_and_choices_are_checked():
    with pytest.raises(wp.InputError, match="Voice"):
        build("h3-talk", {}, {"image": "a.png"})
    with pytest.raises(wp.InputError, match="aspect_ratio"):
        build("fasth3-omni", {"aspect_ratio": "7:3"}, {"picture1": "a.png"})


def test_numbers_are_clamped_and_h3_duration_becomes_frames():
    prompt, info = build("h3-talk", {"duration": 99}, {"image": "a.png", "audio": "v.wav"}, media_size={"image": (1024, 1024)})
    assert prompt["20"]["inputs"]["length"] == wp.h3_frames(15)
    assert info["size"] == [768, 768]


def test_save_nodes_get_unique_prefix():
    prompt, _ = build("simple-upscale", {}, {"image": "a.png"})
    assert prompt["9"]["inputs"]["filename_prefix"].startswith("kitty/test1234")


def test_rtx_upscale_becomes_lanczos_with_the_same_size():
    prompt = {"1": {"class_type": "RTXVideoSuperResolution", "inputs": {
        "resize_type": "target dimensions", "resize_type.width": 1920, "resize_type.height": 1088, "quality": "ULTRA",
        "images": ["7", 0], "strength": 1.0, "image_encoding": "8-bit RGB"}},
        "2": {"class_type": "RTXVideoSuperResolution", "inputs": {
            "resize_type": "scale by multiplier", "resize_type.scale": 2.5, "quality": "HIGH", "images": ["1", 0]}},
        "3": {"class_type": "RTXVideoSuperResolution", "inputs": {
            "resize_type": "scale by multiplier", "resize_type.scale": 2, "quality": "DENOISE_HIGH", "images": ["2", 0]}}}
    assert wp.replace_rtx_upscale(prompt) == ["1", "2", "3"]
    assert prompt["1"] == {"class_type": "ImageScale", "_meta": {"title": "Upscale Image (lanczos)"}, "inputs": {
        "image": ["7", 0], "upscale_method": "lanczos", "crop": "disabled", "width": 1920, "height": 1088}}
    assert prompt["2"]["class_type"] == "ImageScaleBy" and prompt["2"]["inputs"]["scale_by"] == 2.5
    assert prompt["3"]["inputs"]["scale_by"] == 1.0  # denoise keeps the size


def test_optional_audio_switches_the_graph_with_also_set_and_missing_set():
    prompt, _ = build("ltx25-t2v", {"prompt": "waves"}, {})
    assert prompt["414"]["inputs"]["value"] is False
    prompt, _ = build("ltx25-t2v", {"prompt": "waves"}, {"audio": "a.wav"})
    assert prompt["414"]["inputs"]["value"] is True


def test_wan_flf_first_frame_is_the_start_and_size_follows_the_picture():
    prompt, info = build("wan22-flf", {"prompt": "x"}, {"first": "a.png", "last": "b.png"},
                         media_size={"first": (840, 1256)})
    flf = prompt["67"]["inputs"]
    assert prompt[flf["start_image"][0]]["inputs"]["image"] == "a.png"
    assert prompt[flf["end_image"][0]]["inputs"]["image"] == "b.png"
    assert info["size"] == [flf["width"], flf["height"]] == [784, 1168]  # portrait at Wan 2.2's 720p pixel count


def test_aspect_ratio_follows_the_picture_unless_given():
    _, info = build("ltx25-i2v", {"prompt": "x"}, {"image": "a.png"}, media_size={"image": (720, 1280)})
    assert info["aspect_ratio"] == "9:16 (Portrait Widescreen)"
    prompt, info = build("ltx25-i2v", {"prompt": "x", "aspect_ratio": "1:1 (Square)"}, {"image": "a.png"},
                         media_size={"image": (720, 1280)})
    assert "aspect_ratio" not in info
    assert wp.closest_aspect(["1:1 (Square)", "4:3 (Standard)", "16:9 (Widescreen)"], 1000, 760) == "4:3 (Standard)"


def test_talking_size_follows_the_picture_unless_the_caller_sets_it():
    prompt, info = build("infinitetalk", {"prompt": "x"}, {"image": "a.png", "audio": "a.wav"},
                         media_size={"image": (832, 1248)})
    assert info["size"] == [prompt["245"]["inputs"]["value"], prompt["246"]["inputs"]["value"]] == [736, 1104]
    prompt, info = build("infinitetalk", {"prompt": "x", "width": 1024, "height": 768},
                         {"image": "a.png", "audio": "a.wav"}, media_size={"image": (832, 1248)})
    assert "size" not in info and prompt["245"]["inputs"]["value"] == 1024


def test_video_to_video_size_follows_the_video():
    _, info = build("infinitetalk-v2v", {"prompt": "x"}, {"video": "a.mp4", "audio": "a.wav"},
                    media_size={"video": (768, 1344)})
    assert info["size"] == [480, 848]


def test_flux3_edit_drops_the_missing_references_and_sets_the_reference_size():
    prompt, _ = build("flux3-klein-edit", {"prompt": "make it a watercolor", "megapixels": 2.0}, {"image1": "a.png"})
    assert prompt["11"]["inputs"]["image"] == "a.png"
    assert not {"12", "14", "15"} & set(prompt)
    ref = prompt["17"]["inputs"]
    assert ref["images.image0"] == ["11", 0] and "images.image1" not in ref
    assert ref["resolution.megapixels"] == 2.0
