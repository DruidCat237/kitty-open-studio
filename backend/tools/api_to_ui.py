#!/usr/bin/env python3
"""Build an editable ComfyUI workflow (litegraph JSON) from an API-format graph.

  python backend/tools/api_to_ui.py workflows/api/wan22-flf.json --object-info object_info.json -o ui.json
  python backend/tools/api_to_ui.py workflows/api/wan22-flf.json --comfy http://127.0.0.1:8188 -o ui.json
  python backend/tools/api_to_ui.py --regenerate --comfy http://127.0.0.1:8188   # every GENERATED graph

Widget order and socket types come from ComfyUI's /object_info (pass a saved copy or a running
server that has the workflow's custom nodes), so the result loads like a graph saved by the editor.
The layout is the house style: left-to-right step groups and the single orange Patreon note.

The GENERATED workflows had no editor graph, so theirs come from this tool. After changing one of
their API graphs, run --regenerate; tests/test_api_to_ui.py fails until you do. With
--save-object-info the classes those graphs use are also saved to tests/data/ for that test.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate_workflows as cw  # noqa: E402

DYNAMIC_COMBO, AUTOGROW, MATCHTYPE = "COMFY_DYNAMICCOMBO_V3", "COMFY_AUTOGROW_V3", "COMFY_MATCHTYPE_V3"
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", DYNAMIC_COMBO}
# Easy-Use loop nodes add numbered sockets as they get connected: the editor shows the used ones plus
# one free slot, not all 19 that /object_info lists. (input prefix, output prefix)
GROWING_SOCKETS = {"easy forLoopStart": ("initial_value", "value"), "easy forLoopEnd": ("initial_value", "value")}
MISSING = object()
GENERATED = ["wan22-flf", "wan22-i2v-fast", "wan21-scail2-loop", "seedvr2-image", "seedvr2-image-4k",
             "solar-render", "flux3-klein", "flux3-klein-edit"]
OBJECT_INFO_SNAPSHOT = cw.BACKEND / "tests" / "data" / "object_info_generated.json"


def load_object_info(path: str | None, url: str | None) -> dict:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    with urllib.request.urlopen(url.rstrip("/") + "/object_info", timeout=120) as r:
        return json.loads(r.read())


def input_specs(info: dict) -> list[tuple[str, object, dict, bool]]:
    """(name, type, options, optional) in the order the editor creates widgets and sockets."""
    out = []
    for section, optional in (("required", False), ("optional", True)):
        for name, spec in (info.get("input", {}).get(section) or {}).items():
            typ = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
            opts = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
            out.append((name, typ, opts, optional))
    return out


def is_widget(typ, opts: dict) -> bool:
    if opts.get("forceInput") or opts.get("rawLink"):
        return False
    return isinstance(typ, list) or typ in WIDGET_TYPES


def type_name(typ, opts: dict | None = None) -> str:
    if isinstance(typ, list):
        return "COMBO"
    if typ == MATCHTYPE:  # the editor shows the types the slot accepts
        return ((opts or {}).get("template") or {}).get("allowed_types", "*")
    return str(typ)


def is_link(value) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[1], int)


def default_of(typ, opts: dict):
    if "default" in opts:
        return opts["default"]
    if isinstance(typ, list):
        return typ[0] if typ else ""
    if typ == "COMBO":
        return (opts.get("options") or [""])[0]
    if typ == DYNAMIC_COMBO:
        return ((opts.get("options") or [{}])[0]).get("key", "")
    return {"INT": 0, "FLOAT": 0.0, "STRING": "", "BOOLEAN": False}.get(typ)


def numbered(name: str, prefix: str) -> int | None:
    """'initial_value7' -> 7 for prefix 'initial_value'."""
    rest = name[len(prefix):]
    return int(rest) if name.startswith(prefix) and rest.isdigit() else None


def autogrow_slots(name: str, opts: dict, values: dict) -> list[tuple[str, object, bool]] | None:
    """(socket name, type, required) for an autogrow input: the connected slots plus one free one.

    None when the template has several inputs per slot (then the generic handling applies).
    """
    tpl = opts.get("template") or {}
    inner = [spec for sec in ("required", "optional") for spec in ((tpl.get("input") or {}).get(sec) or {}).values()]
    if len(inner) != 1:
        return None
    typ = inner[0][0] if isinstance(inner[0], (list, tuple)) else inner[0]
    names = tpl.get("names") or [f"{tpl.get('prefix', '')}{i}" for i in range(tpl.get("max") or 64)]
    lowest = tpl.get("min") or 0
    used = [i for i, n in enumerate(names) if f"{name}.{n}" in values]
    count = min(len(names), max(lowest, max(used, default=-1) + 1) + 1)
    return [(f"{name}.{names[i]}", typ, i < lowest) for i in range(count)]


def estimate_size(n_sockets: int, n_widgets: int, multiline: int, preview: bool) -> list[float]:
    height = 46 + 22 * n_sockets + 26 * n_widgets + 90 * multiline + (300 if preview else 0)
    return [380.0 if multiline else 320.0, float(max(70, height))]


def build_node(key: str, node: dict, info: dict, nid: int, used_outputs: set, pending_links: list) -> dict:
    """One editor node; links to resolve later go to pending_links as ((src key, slot), key, input index)."""
    cls = node["class_type"]
    values = node.get("inputs", {})
    out_names = info.get("output_name") or info.get("output") or []
    vhs = cls.startswith("VHS_")
    inputs, widgets, widget_dict = [], [], {}
    multiline, preview = 0, False
    known = set()
    grow = GROWING_SOCKETS.get(cls)
    last_shown = 0
    if grow:
        used = [numbered(n, grow[0]) for n, v in values.items() if is_link(v)]
        used += [numbered(out_names[s], grow[1]) for src, s in used_outputs if src == key and s < len(out_names)]
        last_shown = max([n for n in used if n is not None], default=0) + 1

    def add(name, typ, opts, optional):
        nonlocal multiline, preview
        known.add(name)
        value = values.get(name, MISSING)
        if grow and (numbered(name, grow[0]) or 0) > last_shown:
            return
        if typ == AUTOGROW and (slots := autogrow_slots(name, opts, values)) is not None:
            for slot_name, slot_type, required in slots:
                add(slot_name, slot_type, {}, not required)
            return
        if not is_widget(typ, opts):
            slot = {"name": name, "type": type_name(typ, opts), "link": None}
            if optional:
                slot["shape"] = 7
            inputs.append(slot)
            if is_link(value):
                pending_links.append((value, key, len(inputs) - 1))
            return
        linked = is_link(value)
        shown = default_of(typ, opts) if (linked or value is MISSING) else value
        if vhs:
            widget_dict[name] = shown
        else:
            widgets.append(shown)
            # the editor gives every INT named seed / noise_seed a control widget too
            control = opts.get("control_after_generate")
            if control is None:
                control = typ == "INT" and name in ("seed", "noise_seed")
            if control:
                widgets.append(control if isinstance(control, str) else "randomize")
            if opts.get("image_upload") or opts.get("video_upload"):  # the upload button saves a value too
                widgets.append("image")
                preview = True
            if opts.get("audio_upload"):
                widgets.extend([None, None])
        if opts.get("multiline"):
            multiline += 1
        if linked:
            inputs.append({"name": name, "type": type_name(typ, opts), "widget": {"name": name}, "link": None})
            pending_links.append((value, key, len(inputs) - 1))
        if typ == DYNAMIC_COMBO:  # the chosen option's own inputs follow it ("format.codec")
            option = next((o for o in opts.get("options", []) if o.get("key") == shown), None)
            for sub, sub_typ, sub_opts, sub_optional in input_specs({"input": (option or {}).get("inputs") or {}}):
                add(f"{name}.{sub}", sub_typ, sub_opts, sub_optional)

    for name, typ, opts, optional in input_specs(info):
        add(name, typ, opts, optional)
    # other dynamic inputs (VHS format options, packs that add sockets in JavaScript)
    for name, value in values.items():
        if name in known:
            continue
        if is_link(value):
            inputs.append({"name": name, "label": name.split(".")[-1], "type": "*", "shape": 7, "link": None})
            pending_links.append((value, key, len(inputs) - 1))
        elif vhs:
            widget_dict[name] = value
    if cls.startswith(("VHS_VideoCombine", "VHS_LoadVideo")):
        widget_dict["videopreview"] = {"hidden": False, "paused": False, "params": {}}
    if cls == "VHS_LoadVideo":
        widget_dict["choose video to upload"] = "image"
        preview = True
    outputs = []
    for name, typ in zip(out_names, info.get("output") or []):
        if grow and (numbered(name, grow[1]) or 0) > last_shown:
            break  # numbered outputs come last, so the slots before keep their index
        outputs.append({"name": name, "type": "*" if typ == MATCHTYPE else type_name(typ), "links": []})
    n_widgets = len(widget_dict) if vhs else len(widgets)
    ui_node = {
        "id": nid, "type": cls, "pos": [0, 0],
        "size": estimate_size(max(len(inputs), len(outputs)), n_widgets, multiline, preview),
        "flags": {}, "order": 0, "mode": 0, "inputs": inputs, "outputs": outputs,
        "properties": {"Node name for S&R": cls},
    }
    if vhs or widgets:  # the editor leaves widgets_values out for nodes without widgets
        ui_node["widgets_values"] = widget_dict if vhs else widgets
    module = info.get("python_module", "")
    if module.startswith("custom_nodes."):
        ui_node["properties"]["aux_id"] = module.split(".", 1)[1]
    else:
        ui_node["properties"]["cnr_id"] = "comfy-core"
    title = (node.get("_meta") or {}).get("title")
    if title and title != info.get("display_name", cls):
        ui_node["title"] = cw.fix_title(title)
    return ui_node


def build(api: dict, object_info: dict, wf_id: str = "workflow") -> dict:
    ids: dict[str, int] = {}
    numeric = [int(k) for k in api if str(k).isdigit()]
    next_id = max(numeric, default=0) + 1
    for key in api:
        if str(key).isdigit():
            ids[key] = int(key)
        else:
            ids[key] = next_id
            next_id += 1

    used_outputs = {(str(v[0]), v[1]) for n in api.values() for v in n.get("inputs", {}).values() if is_link(v)}
    nodes, pending_links = [], []
    for key, node in api.items():
        info = object_info.get(node["class_type"])
        if info is None:
            raise SystemExit(f"{wf_id}: node class {node['class_type']!r} is not in object_info "
                             "(install its custom node first)")
        nodes.append(build_node(key, node, info, ids[key], used_outputs, pending_links))
        nodes[-1]["order"] = len(nodes) - 1

    by_id = {n["id"]: n for n in nodes}
    links = []
    for lid, ((src_key, slot), dst_key, input_index) in enumerate(pending_links, start=1):
        src = by_id[ids[str(src_key)]]
        dst = by_id[ids[dst_key]]
        out = src["outputs"][slot]
        typ = out["type"]
        if dst["inputs"][input_index]["type"] == "*":
            dst["inputs"][input_index]["type"] = typ
        out["links"].append(lid)
        dst["inputs"][input_index]["link"] = lid
        links.append([lid, src["id"], slot, dst["id"], input_index, typ])
    ui = {"last_node_id": max(by_id), "last_link_id": len(links), "nodes": nodes, "links": links,
          "groups": [], "config": {}, "extra": {}, "version": 0.4}
    cw.auto_layout(ui)
    cw.add_patreon_note(ui)
    cw.fit_view(ui)
    return ui


def generate(api_path: Path, info: dict, models: dict) -> dict:
    """The UI graph for one API graph, with ComfyUI's model download hints on the loaders."""
    ui = build(json.loads(api_path.read_text(encoding="utf-8")), info, api_path.stem)
    for n in ui["nodes"]:
        cw.refresh_model_hints(n, models)
    return ui


def strip_tooltips(value):
    if isinstance(value, dict):
        return {k: strip_tooltips(v) for k, v in value.items() if k not in ("tooltip", "description")}
    if isinstance(value, list):
        return [strip_tooltips(v) for v in value]
    return value


def save_snapshot(info: dict, api_paths: list[Path]) -> None:
    classes = sorted({n["class_type"] for p in api_paths for n in json.loads(p.read_text(encoding="utf-8")).values()})
    OBJECT_INFO_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    OBJECT_INFO_SNAPSHOT.write_text(json.dumps({c: strip_tooltips(info[c]) for c in classes if c in info},
                                               separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OBJECT_INFO_SNAPSHOT} ({len(classes)} node classes)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("api", type=Path, nargs="*", help="API graphs to convert")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--object-info")
    src.add_argument("--comfy", help="URL of a running ComfyUI with the needed custom nodes")
    ap.add_argument("-o", "--out", type=Path, help="output file, or a directory for several graphs")
    ap.add_argument("--regenerate", action="store_true", help="rebuild workflows/ui/ for every GENERATED workflow")
    ap.add_argument("--save-object-info", action="store_true", help=f"also write {OBJECT_INFO_SNAPSHOT.name}")
    args = ap.parse_args()
    if args.regenerate:
        jobs = [(cw.OUT_API / f"{w}.json", cw.OUT_UI / f"{w}.json") for w in GENERATED]
    elif args.api and args.out and (len(args.api) == 1 or args.out.is_dir()):
        jobs = [(p, args.out / f"{p.stem}.json" if args.out.is_dir() else args.out) for p in args.api]
    else:
        ap.error("give API graphs and -o (a directory for several graphs), or --regenerate")
    info = load_object_info(args.object_info, args.comfy)
    if args.save_object_info:
        save_snapshot(info, [api for api, _ in jobs])
    models = cw.load_models_by_file()
    for api_path, out in jobs:
        ui = generate(api_path, info, models)
        cw.write_json(out, ui)
        print(f"wrote {out} ({len(ui['nodes'])} nodes, {len(ui['links'])} links)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
