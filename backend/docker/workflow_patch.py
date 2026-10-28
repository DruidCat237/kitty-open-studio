"""Turn a workflow's API JSON plus form inputs into a ready-to-queue ComfyUI prompt.

Pure functions only (no network, no files): the handler resolves media first and
passes the uploaded file names in. The input map lives in workflows/index.json;
each input has a `type` and `targets` ([node_id, input_name] pairs):

  text | int | float | bool | choice   literal values (clamped to min/max, checked against options);
                                        also_set / missing_set as for media
  seed                                  -1 / empty / invalid -> random; written to every target
  image | video | audio                 uploaded file name; when missing:
        if_missing: "remove"            drop `remove_nodes` and every input that links to them
        if_missing: "silence"           point at a silent WAV (LTX custom-audio switch)
        if_missing: "copy:<key>"        reuse another input's file
        also_set / missing_set          extra [node, input, value] writes when present / missing
  image_list                            clone `clone_node` once per picture and wire it to
                                        `target_node` as `<input_prefix><start_index + i>`

Optional per-input `transform`: "h3_frames" turns seconds into MiniMax H3 frame counts
(24 fps, 5 + 17k grid). A workflow can set `size_from` with `size_targets` to size the video from
the first input picture: "image:h3_short_edge_768", or "image:area_<side>" (the picture's aspect at
the pixel count of the workflow's side x side square); "video:area_<side>" does the same from the first video. A choice with `aspect_from: "<image key>"`
picks the option nearest the picture's aspect when the caller leaves it empty. With `size_inputs`
(e.g. ["width", "height"]) the caller's own size, when given, wins over `size_from`.
"""
from __future__ import annotations

import copy
import math
import random
from typing import Any, Callable

SEED_MAX = 2 ** 32 - 1
H3_FPS = 24
H3_MAX_FRAMES = 362  # ~15 s
H3_SHORT_EDGE = 768
H3_MAX_PIXEL_FRAMES = 1024 * 768 * 362  # measured on a 96 GB card: larger plates OOM
MEDIA_TYPES = ("image", "video", "audio")


class InputError(ValueError):
    """The request is wrong in a way the caller can fix; the message says how."""


# --------------------------------------------------------------------------- helpers
def resolve_seed(raw: Any) -> tuple[int, str]:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return random.randint(1, 10 ** 9), "random"
    try:
        value = int(float(raw)) if isinstance(raw, str) else int(raw)
    except (TypeError, ValueError):
        return random.randint(1, 10 ** 9), f"random (ignored {raw!r})"
    if value <= 0:
        return random.randint(1, 10 ** 9), "random"
    if value > SEED_MAX:
        return value % (SEED_MAX + 1) or 1, f"wrapped from {value}"
    return value, "as given"


def h3_frames(seconds: float, cap: int = H3_MAX_FRAMES) -> int:
    n = max(5, int(round(float(seconds) * H3_FPS)))
    n += (5 - (n % 17)) % 17
    return min(n, cap)


def snap32(v: float) -> int:
    return max(32, int(round(v / 32.0)) * 32)


def h3_size_from_image(width: int, height: int, frames: int) -> tuple[int, int]:
    """Keep the picture's aspect with a 768 px short edge, then fit the memory budget."""
    if width <= 0 or height <= 0:
        return H3_SHORT_EDGE, H3_SHORT_EDGE
    if width <= height:
        w, h = H3_SHORT_EDGE, height * H3_SHORT_EDGE / width
    else:
        w, h = width * H3_SHORT_EDGE / height, H3_SHORT_EDGE
    w, h = snap32(w), snap32(h)
    if frames > 243 and max(w, h) > 1024:
        ratio = max(w, h) / min(w, h)
        short = max(256, int((1024 / ratio) // 32) * 32)
        w, h = (short, 1024) if h > w else (1024, short)
    if w * h * frames <= H3_MAX_PIXEL_FRAMES:
        return w, h
    portrait = h > w
    short, long_ = (w, h) if portrait else (h, w)
    ratio = long_ / short
    s = short
    while s > 256:
        s -= 32
        l = snap32(s * ratio)
        if s * l * frames <= H3_MAX_PIXEL_FRAMES:
            return (s, l) if portrait else (l, s)
    l = snap32(256 * ratio)
    return (256, l) if portrait else (l, 256)


def size_by_area(width: int, height: int, side: int, multiple: int = 16) -> tuple[int, int]:
    """The picture's aspect at the pixel count of a side x side square (the workflow's own budget)."""
    if width <= 0 or height <= 0:
        return side, side
    scale = math.sqrt(side * side / (width * height))
    return (max(multiple, int(round(width * scale / multiple)) * multiple),
            max(multiple, int(round(height * scale / multiple)) * multiple))


def closest_aspect(options: list[str], width: int, height: int) -> str | None:
    """The option ("9:16 (Portrait Widescreen)", ...) whose ratio is nearest the picture's."""
    best, best_diff = None, None
    for option in options:
        try:
            w, h = (float(x) for x in option.split()[0].split(":"))
        except ValueError:
            continue
        diff = abs(math.log((w / h) / (width / height)))
        if best_diff is None or diff < best_diff:
            best, best_diff = option, diff
    return best


def coerce(spec: dict, value: Any) -> Any:
    kind = spec["type"]
    key = spec["key"]
    try:
        if kind == "int":
            value = int(round(float(value)))
        elif kind == "float":
            value = float(value)
        elif kind == "bool":
            value = value if isinstance(value, bool) else str(value).strip().lower() in ("1", "true", "yes", "on")
        elif kind in ("text", "choice"):
            value = str(value)
    except (TypeError, ValueError) as e:
        raise InputError(f"'{key}' must be a {kind}, got {value!r}") from e
    if kind in ("int", "float"):
        if "min" in spec:
            value = max(spec["min"], value)
        if "max" in spec:
            value = min(spec["max"], value)
    if kind == "choice" and value not in spec.get("options", [value]):
        raise InputError(f"'{key}' must be one of {spec['options']}, got {value!r}")
    if kind == "text" and len(value) > 20000:
        raise InputError(f"'{key}' is too long (max 20000 characters)")
    return value


def set_targets(prompt: dict, targets: list, value: Any) -> None:
    for node_id, name, *rest in targets:
        node = prompt.get(str(node_id))
        if node is None:
            raise InputError(f"workflow is missing node {node_id} (manifest out of date?)")
        node.setdefault("inputs", {})[name] = rest[0] if rest else value


def remove_nodes(prompt: dict, node_ids: list) -> None:
    """Delete nodes and every input of another node that links to them."""
    gone = {str(n) for n in node_ids}
    for nid in gone:
        prompt.pop(nid, None)
    for node in prompt.values():
        for key, val in list(node.get("inputs", {}).items()):
            if isinstance(val, list) and len(val) == 2 and str(val[0]) in gone:
                del node["inputs"][key]


def swap_variants(prompt: dict, models: list[dict], profile: str | None) -> dict[str, str]:
    """Rename model files to the GPU profile's variant (e.g. INT8 -> FP8 on 24 GB cards)."""
    mapping = {}
    for m in models:
        v = (m.get("variants") or {}).get(profile or "")
        if v and v.get("filename"):
            mapping[m["filename"]] = v["filename"]
    applied = {}
    for node in prompt.values():
        for key, val in node.get("inputs", {}).items():
            if isinstance(val, str) and val in mapping:
                node["inputs"][key] = applied[val] = mapping[val]
    return applied


RTX_VSR = "RTXVideoSuperResolution"


def replace_rtx_upscale(prompt: dict) -> list[str]:
    """NVIDIA's RTX Video Super Resolution -> ComfyUI's lanczos resize, with the same output size.

    For the "100% open weights" profile, and on a ComfyUI without nvidia-vfx (no RTX GPU, or the SDK did not install).
    Denoise / deblur modes keep the size, so they become a plain pass-through resize.
    """
    replaced = []
    for nid, node in prompt.items():
        if node.get("class_type") != RTX_VSR:
            continue
        i = node.get("inputs", {})
        if i.get("resize_type") == "target dimensions":
            prompt[nid] = {"class_type": "ImageScale", "_meta": {"title": "Upscale Image (lanczos)"},
                           "inputs": {"image": i.get("images"), "upscale_method": "lanczos", "crop": "disabled",
                                      "width": i.get("resize_type.width", 1920), "height": i.get("resize_type.height", 1080)}}
        else:
            scale = 1.0 if str(i.get("quality", "")).startswith(("DENOISE_", "DEBLUR_")) else i.get("resize_type.scale", 2.0)
            prompt[nid] = {"class_type": "ImageScaleBy", "_meta": {"title": "Upscale Image By (lanczos)"},
                           "inputs": {"image": i.get("images"), "upscale_method": "lanczos", "scale_by": scale}}
        replaced.append(nid)
    return replaced


def compact_slots(inputs: dict, prefix: str) -> None:
    slots = sorted((int(k[len(prefix):]), k) for k in inputs if k.startswith(prefix) and k[len(prefix):].isdigit())
    values = [inputs.pop(k) for _, k in slots]
    for i, v in enumerate(values):
        inputs[f"{prefix}{i}"] = v


def unique_prefixes(prompt: dict, prefix: str) -> None:
    for node in prompt.values():
        inputs = node.get("inputs", {})
        if node.get("class_type") in ("SaveImage", "SaveImageAdvanced", "SaveVideo", "SaveAudio", "SaveAnimatedWEBP",
                                      "VHS_VideoCombine") and "filename_prefix" in inputs:
            inputs["filename_prefix"] = prefix


# --------------------------------------------------------------------------- main entry
def build_prompt(entry: dict, api: dict, inputs: dict, media: dict[str, Any] | None = None, *,
                 models: list[dict] | None = None, profile: str | None = None, job_id: str = "job",
                 media_size: dict[str, tuple[int, int]] | None = None,
                 silence: Callable[[float], str] | None = None) -> tuple[dict, dict]:
    """Return (prompt, info). `media` maps input keys to uploaded file names (lists for image_list)."""
    prompt = copy.deepcopy(api)
    media = media or {}
    inputs = dict(inputs or {})
    specs = entry.get("inputs", [])
    known = {s["key"] for s in specs}
    unknown = sorted(set(inputs) - known)
    info: dict[str, Any] = {"workflow": entry["id"], "warnings": []}
    if unknown:
        info["warnings"].append(f"ignored unknown inputs: {', '.join(unknown)}")
    info["variants"] = swap_variants(prompt, models or [], profile)

    def value_of(key: str, default: Any = None) -> Any:
        spec = next((s for s in specs if s["key"] == key), {})
        v = inputs.get(key)
        return spec.get("default", default) if v in (None, "") else v

    to_remove: list[str] = []
    frames_for_size = None
    for spec in specs:
        key, kind = spec["key"], spec["type"]
        if kind in MEDIA_TYPES:
            name = media.get(key)
            policy = spec.get("if_missing", "")
            if name:
                set_targets(prompt, spec["targets"], name)
                for extra in spec.get("also_set", []):
                    set_targets(prompt, [extra], None)
            elif policy == "remove":
                to_remove += [str(n) for n in spec.get("remove_nodes", [])]
            elif policy == "silence":
                if silence is None:
                    raise InputError(f"'{key}' is optional but no silence file is available")
                seconds = float(value_of("duration", 10) or 10)
                set_targets(prompt, spec["targets"], silence(seconds + 1))
                for extra in spec.get("missing_set", []):
                    set_targets(prompt, [extra], None)
            elif policy.startswith("copy:") and media.get(policy[5:]):
                set_targets(prompt, spec["targets"], media[policy[5:]])
            elif spec.get("required", True):
                article = "an" if kind[0] in "aeiou" else "a"
                raise InputError(f"'{spec.get('label', key)}' is required: upload {article} {kind} file")
            continue
        if kind == "image_list":
            names = media.get(key) or []
            if isinstance(names, str):
                names = [names]
            if len(names) > spec.get("max", 9):
                raise InputError(f"'{key}' takes at most {spec.get('max')} files")
            template = prompt.get(str(spec["clone_node"])) or api.get(str(spec["clone_node"]))
            target = prompt.get(str(spec["target_node"]))
            if names and (template is None or target is None):
                raise InputError(f"'{key}' cannot be used with this workflow version")
            for i, name in enumerate(names):
                nid = f"{spec['clone_node']}_extra{i}"
                clone = copy.deepcopy(template)
                clone["inputs"]["image"] = name
                clone.setdefault("_meta", {})["title"] = f"Picture {spec.get('start_index', 0) + i + 1}"
                prompt[nid] = clone
                target["inputs"][f"{spec['input_prefix']}{spec.get('start_index', 0) + i}"] = [nid, 0]
            continue
        raw = inputs.get(key)
        if kind == "choice" and raw in (None, "") and spec.get("aspect_from") in (media_size or {}):
            raw = closest_aspect(spec.get("options", []), *media_size[spec["aspect_from"]])
            info["aspect_ratio"] = raw
        if kind == "seed":
            seed, note = resolve_seed(raw)
            set_targets(prompt, spec["targets"], seed)
            info["seed"], info["seed_note"] = seed, note
            continue
        if raw is None or raw == "":
            if spec.get("required") and "default" not in spec:
                raise InputError(f"'{spec.get('label', key)}' is required")
            if spec.get("transform") == "h3_frames":
                raw = spec.get("default")
            else:
                for extra in spec.get("missing_set", []):
                    set_targets(prompt, [extra], None)
                continue  # keep the workflow's own value
        for extra in spec.get("also_set", []):
            set_targets(prompt, [extra], None)
        value = coerce(spec, raw)
        if spec.get("transform") == "h3_frames":
            value = h3_frames(value)
            frames_for_size = value
        set_targets(prompt, spec["targets"], value)

    sized_by_caller = any(inputs.get(k) not in (None, "") for k in entry.get("size_inputs", []))
    source, _, mode = entry.get("size_from", "").partition(":")
    if source in ("image", "video") and not sized_by_caller:
        key = next((s["key"] for s in specs if s["type"] == source), None)
        size = (media_size or {}).get(key or "")
        if size:
            if mode.startswith("area_"):
                w, h = size_by_area(size[0], size[1], int(mode[5:]))
            else:
                w, h = h3_size_from_image(size[0], size[1], frames_for_size or H3_MAX_FRAMES)
            for (node_id, name), val in zip(entry.get("size_targets", []), (w, h)):
                set_targets(prompt, [[node_id, name]], val)
            info["size"] = [w, h]

    if to_remove:
        remove_nodes(prompt, to_remove)
    # Autogrow slots must stay contiguous so <Picture N> follows the order of the pictures given.
    for spec in specs:
        if spec["type"] == "image_list" and str(spec["target_node"]) in prompt:
            compact_slots(prompt[str(spec["target_node"])]["inputs"], spec["input_prefix"])
    unique_prefixes(prompt, f"kitty/{job_id[:12]}_{entry['id']}")
    return prompt, info


def media_specs(entry: dict) -> list[dict]:
    return [s for s in entry.get("inputs", []) if s["type"] in MEDIA_TYPES + ("image_list",)]


def estimate_seconds(entry: dict, inputs: dict) -> float:
    """Rough GPU time (s) for logs and progress: the card's estimate scaled by duration."""
    base = float(entry.get("est_gpu_minutes") or 1) * 60
    dur = inputs.get("duration")
    if dur:
        try:
            base *= max(0.2, float(dur) / 5.0)
        except (TypeError, ValueError):
            pass
    return math.ceil(base)
