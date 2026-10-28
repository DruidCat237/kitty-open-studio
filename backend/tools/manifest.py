#!/usr/bin/env python3
"""Keep backend/models.json and backend/workflows/index.json consistent.

  python backend/tools/manifest.py sync    # recompute the derived fields
  python backend/tools/manifest.py check   # validate everything (CI runs this)
  python backend/tools/manifest.py refresh # re-read sizes / sha256 from Hugging Face (HF_TOKEN for gated repos)
  python backend/tools/manifest.py docs    # write docs/models.md (the model and license table)

Derived fields written by `sync`:
  index.json  workflows[].models        model ids the API graph loads
              workflows[].custom_nodes  custom-node packs the API graph needs
  models.json models[].workflows        workflows that load the model
              models[].group            image | video | upscale | speed | voice | music
              models[].min_vram_gb      smallest card that runs a workflow using it

`check` fails on: broken links inside an API graph, a model file the manifest does
not know, a node class that is neither core nor in custom_nodes.json, an input map
that points at a node or input that does not exist, a UI graph that breaks the
house style (exactly one Note, the Patreon note), and forbidden words anywhere in
backend/ (abliterated encoders, CivitAI, paid APIs).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
WF_DIR = BACKEND / "workflows"
MODEL_EXT = re.compile(r"\.(safetensors|gguf|pt|pth|ckpt|bin|onnx|torchscript)$", re.I)
CATEGORY_GROUP = {"image": "image", "edit": "image", "video": "video", "vfx": "video", "talking": "video",
                  "character": "video", "instant": "speed", "upscale": "upscale", "voice": "voice", "music": "music"}
FORBIDDEN = re.compile(r"heretic|uncensored|abliterat|civitai|\bpoyo\b|seedance|\bveo\b|\bkling\b|elevenlabs|"
                       r"vertex ?ai|\bgemini\b|nano ?banan|wp-json|\bhf_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9]{20,}|\brpa_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12,}", re.I)
FORBIDDEN_SKIP = {"manifest.py", "curate_workflows.py"}  # they carry the lists of forbidden names


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def core_nodes() -> set[str]:
    return set((BACKEND / "tools" / "core_nodes.txt").read_text(encoding="utf-8").split("\n")) - {""}


def pack_index() -> dict[str, str]:
    out = {}
    for pack in load(BACKEND / "custom_nodes.json")["packs"]:
        for cls in pack["classes"]:
            out[cls] = pack["id"]
    return out


def model_index(models: list[dict]) -> dict[str, dict]:
    idx = {}
    for m in models:
        idx[m["filename"]] = m
        for v in (m.get("variants") or {}).values():
            idx.setdefault(v["filename"], m)
    return idx


def api_files_used(api: dict) -> set[str]:
    """Model files a graph loads, including nested values such as Power Lora entries ({"lora": ...})."""
    files = set()

    def walk(value) -> None:
        if isinstance(value, str) and MODEL_EXT.search(value):
            files.add(value)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list) and not (len(value) == 2 and isinstance(value[1], int)):
            for v in value:
                walk(v)

    for node in api.values():
        walk(node.get("inputs", {}))
    return files


def scan_workflow(api: dict, models_by_file: dict, packs: dict, core: set) -> tuple[list, list, list]:
    model_ids, pack_ids, problems = set(), set(), []
    for f in api_files_used(api):
        m = models_by_file.get(f)
        if m is None and f.startswith("http"):
            m = next((x for x in models_by_file.values() if x.get("url") == f), None)
        if m is None:
            problems.append(f"model file not in models.json: {f}")
        else:
            model_ids.add(m["id"])
    for nid, node in api.items():
        cls = node.get("class_type")
        if not cls:
            problems.append(f"node {nid} has no class_type")
            continue
        if cls in packs:
            pack_ids.add(packs[cls])
        elif cls not in core:
            problems.append(f"node class not core and not in custom_nodes.json: {cls}")
        for key, value in node.get("inputs", {}).items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int) and str(value[0]) not in api:
                problems.append(f"node {nid}.{key} links to missing node {value[0]}")
    return sorted(model_ids), sorted(pack_ids), problems


def check_inputs(wf: dict, api: dict) -> list[str]:
    problems = []
    for inp in wf.get("inputs", []):
        for target in inp.get("targets", []):
            node, key = str(target[0]), target[1]
            if node not in api:
                problems.append(f"input '{inp['key']}' targets missing node {node}")
            elif key not in api[node].get("inputs", {}):
                problems.append(f"input '{inp['key']}' targets missing input {node}.{key}")
        for extra in inp.get("also_set", []) + inp.get("missing_set", []):
            if str(extra[0]) not in api:
                problems.append(f"input '{inp['key']}' also_set targets missing node {extra[0]}")
        for node in inp.get("remove_nodes", []):
            if str(node) not in api:
                problems.append(f"input '{inp['key']}' removes missing node {node}")
        for key in ("clone_node", "target_node"):
            if key in inp and str(inp[key]) not in api:
                problems.append(f"input '{inp['key']}' {key} {inp[key]} missing")
        for t in wf.get("size_targets", []):
            if str(t[0]) not in api:
                problems.append(f"size target {t[0]} missing")
    for node in wf.get("outputs", {}).get("nodes", []):
        if str(node) not in api:
            problems.append(f"output node {node} missing")
    return problems


def check_ui(path: Path) -> list[str]:
    ui = load(path)
    problems = []
    nodes = list(ui.get("nodes", []))
    for sg in ui.get("definitions", {}).get("subgraphs", []):
        nodes += sg.get("nodes", [])
    notes = [n for n in nodes if n.get("type") in ("Note", "MarkdownNote", "Label (rgthree)")]
    if len(notes) != 1 or "patreon.com" not in json.dumps(notes[0].get("widgets_values")):
        problems.append(f"{path.name}: expected exactly one (Patreon) note, found {len(notes)}")
    elif notes[0].get("bgcolor") != "#CD853F":
        problems.append(f"{path.name}: the Patreon note must be orange")
    return problems


def forbidden_hits() -> list[str]:
    hits = []
    for path in BACKEND.rglob("*"):
        if not path.is_file() or path.name in FORBIDDEN_SKIP or path.suffix in (".pyc",):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for m in FORBIDDEN.finditer(text):
            hits.append(f"{path.relative_to(BACKEND)}: '{m.group(0)}'")
    return hits


def run(sync: bool) -> int:
    index = load(WF_DIR / "index.json")
    mfile = load(BACKEND / "models.json")
    models = mfile["models"]
    by_file = model_index(models)
    packs, core = pack_index(), core_nodes()
    problems: list[str] = []
    used_by: dict[str, list[str]] = {}
    listed_api = set()

    for wf in index["workflows"]:
        api_path = WF_DIR / wf["api"]
        listed_api.add(api_path.name)
        if not api_path.exists():
            problems.append(f"{wf['id']}: missing {wf['api']}")
            continue
        api = load(api_path)
        model_ids, pack_ids, probs = scan_workflow(api, by_file, packs, core)
        # models a node picks by name rather than by file (e.g. SAM3Segment's model_name)
        known_ids = {m["id"] for m in models}
        for extra in wf.get("extra_models", []):
            if extra not in known_ids:
                probs.append(f"extra_models: unknown model id {extra}")
        model_ids = sorted(set(model_ids) | (set(wf.get("extra_models", [])) & known_ids))
        problems += [f"{wf['id']}: {p}" for p in probs + check_inputs(wf, api)]
        for ui in wf.get("ui", []):
            if not (WF_DIR / ui).exists():
                problems.append(f"{wf['id']}: missing {ui}")
        for variant in (wf.get("variants") or {}).values():
            if not (WF_DIR / variant).exists():
                problems.append(f"{wf['id']}: missing variant {variant}")
        if wf.get("category") not in CATEGORY_GROUP:
            problems.append(f"{wf['id']}: unknown category {wf.get('category')}")
        if sync:
            wf["models"], wf["custom_nodes"] = model_ids, pack_ids
        elif wf.get("models") != model_ids or wf.get("custom_nodes") != pack_ids:
            problems.append(f"{wf['id']}: derived fields out of date (run manifest.py sync)")
        for mid in model_ids:
            used_by.setdefault(mid, []).append(wf["id"])

    for path in sorted((WF_DIR / "api").glob("*.json")):
        if path.name not in listed_api:
            problems.append(f"api/{path.name} is not listed in index.json")
    for path in sorted((WF_DIR / "ui").glob("*.json")):
        problems += check_ui(path)

    wf_by_id = {w["id"]: w for w in index["workflows"]}
    for m in models:
        wfs = sorted(used_by.get(m["id"], []))
        groups = Counter(CATEGORY_GROUP[wf_by_id[w]["category"]] for w in wfs)
        order = ["video", "image", "upscale", "speed", "voice", "music"]
        group = sorted(groups, key=lambda g: (-groups[g], order.index(g)))[0] if groups else m.get("group", "video")
        vram = min((wf_by_id[w]["min_vram_gb"] for w in wfs), default=m.get("min_vram_gb"))
        derived = {"workflows": wfs, "group": group, "min_vram_gb": vram}
        if sync:
            m.update(derived)
        elif any(m.get(k) != v for k, v in derived.items()):
            problems.append(f"model {m['id']}: derived fields out of date (run manifest.py sync)")
        if not wfs and not m.get("standalone"):
            problems.append(f"model {m['id']} is not used by any workflow")
        if not m.get("auto_download") and not m.get("url"):
            problems.append(f"model {m['id']} has no url")
        for key in ("filename", "folder", "license"):
            if not m.get(key):
                problems.append(f"model {m['id']} has no {key}")
    ids = [m["id"] for m in models]
    problems += [f"duplicate model id {i}" for i, n in Counter(ids).items() if n > 1]
    for pack in load(BACKEND / "custom_nodes.json")["packs"]:
        if not pack.get("license"):  # SPDX id, or "none" when the repo has no license file
            problems.append(f"node pack {pack['id']} has no license field")
    problems += [f"forbidden word in {h}" for h in forbidden_hits()]

    if sync:
        dump(WF_DIR / "index.json", index)
        dump(BACKEND / "models.json", mfile)
    for p in problems:
        print(f"  x {p}")
    total_gb = sum(m.get("size_bytes") or 0 for m in models) / 1e9
    print(f"{len(index['workflows'])} workflows, {len(models)} models ({total_gb:.0f} GB in total), {len(problems)} problem(s)")
    return 1 if problems else 0


HF_URL = re.compile(r"^https://huggingface\.co/([^/]+/[^/]+)/resolve/([^/]+)/(.+)$")


def hf_file_info(url: str, cache: dict) -> dict | None:
    """size and sha256 of a Hugging Face file from the tree API (one request per folder)."""
    import os
    import urllib.parse
    import urllib.request

    m = HF_URL.match(url or "")
    if not m:
        return None
    repo, rev, path = m.group(1), m.group(2), urllib.parse.unquote(m.group(3))
    folder = path.rsplit("/", 1)[0] if "/" in path else ""
    key = f"{repo}@{rev}:{folder}"
    if key not in cache:
        api = f"https://huggingface.co/api/models/{repo}/tree/{rev}/{urllib.parse.quote(folder)}".rstrip("/")
        headers = {"User-Agent": "kitty-open-studio-manifest"}
        if os.environ.get("HF_TOKEN"):
            headers["Authorization"] = f"Bearer {os.environ['HF_TOKEN']}"
        try:
            with urllib.request.urlopen(urllib.request.Request(api, headers=headers), timeout=60) as r:
                cache[key] = json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - report and keep going
            print(f"  ! {repo}/{folder}: {e}")
            cache[key] = []
    for f in cache[key]:
        if f.get("path") == path:
            sha = (f.get("lfs") or {}).get("oid")
            return {"size_bytes": f.get("size"), "sha256": sha if sha and re.fullmatch(r"[0-9a-f]{64}", sha) else None}
    return None


def refresh() -> int:
    mfile = load(BACKEND / "models.json")
    cache: dict = {}
    changed = 0
    for m in mfile["models"]:
        for rec in [m] + list((m.get("variants") or {}).values()):
            info = hf_file_info(rec.get("url"), cache)
            if not info:
                continue
            for k, v in info.items():
                if v and rec.get(k) != v:
                    print(f"  {rec['filename']}: {k} {rec.get(k)} -> {v}")
                    rec[k] = v
                    changed += 1
    dump(BACKEND / "models.json", mfile)
    print(f"{changed} value(s) updated")
    return 0


def docs() -> int:
    index = load(WF_DIR / "index.json")
    models = load(BACKEND / "models.json")["models"]
    titles = {w["id"]: w["title"] for w in index["workflows"]}
    lines = [
        "# Models and licenses",
        "",
        "Generated by `python backend/tools/manifest.py docs` from `backend/models.json`. Every model is an open-weights",
        "file that **you** download from its source with the installer; nothing is bundled with Kitty Open Studio.",
        "Licenses marked *non-commercial* or *community* restrict how you may use the model or its outputs: read",
        "the linked license before commercial use.",
        "",
    ]
    kinds = Counter(m.get("license_kind", "unknown") for m in models)
    lines.append("License kinds: " + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())) + ".")
    for group in ["speed", "video", "image", "upscale", "voice", "music"]:
        rows = [m for m in models if m.get("group") == group]
        if not rows:
            continue
        lines += ["", f"## {group.capitalize()}", "", "| File | Size | License | Gated | Used by |", "|---|---:|---|:-:|---|"]
        for m in sorted(rows, key=lambda x: x["filename"].lower()):
            size = f"{m['size_bytes'] / 1e9:.1f} GB" if m.get("size_bytes") else "?"
            lic = f"[{m['license']}]({m['source']})" if m.get("source") else m["license"]
            if m.get("license_kind") in ("non-commercial", "community"):
                lic += f" ({m['license_kind']})"
            used = ", ".join(titles.get(w, w) for w in m.get("workflows", []))
            lines.append(f"| `{m['filename']}` | {size} | {lic} | {'yes' if m.get('gated') else ''} | {used} |")
    out = BACKEND.parent / "docs" / "models.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out}")

    sizes = {m["id"]: m.get("size_bytes") or 0 for m in models}
    lines = [
        "# Workflows (Studio cards)",
        "",
        "Generated by `python backend/tools/manifest.py docs` from `backend/workflows/index.json`.",
        "API graphs: `backend/workflows/api/`, editable ComfyUI graphs: `backend/workflows/ui/` (drag onto ComfyUI).",
        "VRAM and GPU minutes are estimates for one default run.",
    ]
    for cat in index["categories"]:
        rows = [w for w in index["workflows"] if w["category"] == cat["id"] and not w.get("hidden")]
        if not rows:
            continue
        lines += ["", f"## {cat['title']}", "", "| Workflow | What it does | Inputs | VRAM | GPU min | Models | UI graph |",
                  "|---|---|---|---:|---:|---:|---|"]
        for w in rows:
            ins = ", ".join(i["key"] + ("" if i.get("required", i["type"] not in ("image", "video", "audio", "image_list")) else "")
                            for i in w["inputs"] if i["type"] != "seed")
            gb = sum(sizes.get(m, 0) for m in w.get("models", [])) / 1e9
            ui = ", ".join(f"[{Path(u).stem}](../backend/workflows/{u})" for u in w.get("ui", [])) or "API only"
            status = " (UI only)" if w.get("status") == "ui-only" else ""
            badge = (" ⚡" if "speed" in w.get("badges", []) else "") + \
                (" · *NVIDIA RTX*" if "nvidia-rtx" in w.get("badges", []) else "")
            lines.append(f"| **{w['title']}**{badge}{status} `{w['id']}` | {w['summary']} | {ins} | {w['min_vram_gb']} GB | "
                         f"{w['est_gpu_minutes']} | {gb:.0f} GB | {ui} |")
    out = BACKEND.parent / "docs" / "workflows.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out}")

    nodes = load(BACKEND / "custom_nodes.json")
    comfy = nodes["comfyui"]
    lines = [
        "# ComfyUI, node packs and their licenses",
        "",
        "Generated by `python backend/tools/manifest.py docs` from `backend/custom_nodes.json`. The Docker image does not",
        "bundle them: on a pod's first start `docker/setup_volume.py` clones ComfyUI and these node packs at the pinned",
        "commits onto your volume, straight from their authors' repositories. Kitty Open Studio's own code is MIT.",
        "*none* means the repository has no license file, so its author has not granted reuse rights in writing.",
        "**Proprietary** marks a pack that runs closed vendor software: NVIDIA's RTX Video Super Resolution uses",
        "`nvidia-vfx`, NVIDIA's proprietary SDK (free to use on NVIDIA RTX GPUs); `INSTALL_NVIDIA_RTX=false` leaves it out",
        "and the workflows use a lanczos resize instead.",
        "",
        "| Software | Commit | License | Used by |",
        "|---|---|---|---|",
        f"| [ComfyUI]({comfy['repo']}) {comfy.get('version', '')} | `{comfy['ref'][:7]}` | {comfy.get('license', '?')} | everything |",
    ]
    for pack in sorted(nodes["packs"], key=lambda x: x["id"]):
        used = ", ".join(titles.get(w["id"], w["id"]) for w in index["workflows"] if pack["id"] in w.get("custom_nodes", []))
        name = pack["repo"].rstrip("/").split("/")[-1]
        lic = pack["license"] if pack["license"] != "none" else "**none**"
        if pack.get("proprietary_runtime"):
            lic += f" + **proprietary** `{pack['proprietary_runtime']}`"
        if pack.get("license_note"):
            lic += f" ({pack['license_note']})"
        lines.append(f"| [{name}]({pack['repo']}) | `{pack['ref'][:7]}` | {lic} | {used or 'editor helpers'} |")
    out = BACKEND.parent / "docs" / "nodes.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Sync, validate and document the backend manifests.")
    ap.add_argument("command", choices=["sync", "check", "refresh", "docs"])
    args = ap.parse_args()
    if args.command == "refresh":
        return refresh()
    if args.command == "docs":
        return docs()
    return run(sync=args.command == "sync")


if __name__ == "__main__":
    sys.exit(main())
