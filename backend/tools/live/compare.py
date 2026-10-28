"""Compare the API prompts the ComfyUI frontend produced from our UI graphs with the shipped API JSON.

usage: python compare.py <roundtrip out dir>
Prints, per workflow: nodes only in one side, class mismatches, link differences and value differences.
"""
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1])
INDEX = json.loads((BACKEND / "workflows/index.json").read_text())["workflows"]
IGNORE_INPUTS = {"filename_prefix", "videopreview", "audioUI", "videoUI", "upload", "choose video to upload",
                 "PowerLoraLoaderHeaderWidget", "➕ Add Lora"}


def pair_renumbered(got, want):
    """The editor renumbers subgraph nodes whose ids clash with top-level ones ("79:77" -> "79:155").

    Pair those nodes by subgraph and class, then by the most matching inputs (literal values, and the
    node or class + slot a link comes from), and rename them and the links to them to the API ids.
    """
    def groups(keys, graph):
        out = {}
        for k in sorted(keys, key=lambda k: (len(k), k)):  # numeric order for ids of one length
            prefix, _, inner = k.rpartition(":")
            if prefix and inner.isdigit():
                out.setdefault((prefix, graph[k]["class_type"]), []).append(k)
        return out

    def sig(v, graph):
        if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
            src = str(v[0])
            if src in got and src in want and got[src]["class_type"] == want[src]["class_type"]:
                return ("node", src, v[1])  # a node both sides share keeps its id
            return ("link", (graph.get(src) or {}).get("class_type", src), v[1])
        return norm(v)

    def score(u, a):
        ui, api = got[u].get("inputs", {}), want[a].get("inputs", {})
        return sum(sig(ui.get(n), got) == sig(api.get(n), want) for n in set(ui) | set(api))

    ui_only, api_only = groups(set(got) - set(want), got), groups(set(want) - set(got), want)
    rename = {}
    for key, ui_ids in ui_only.items():
        candidates = sorted(((score(u, a), u, a) for u in ui_ids for a in api_only.get(key, [])), key=lambda t: -t[0])
        for _, u, a in candidates:
            if u not in rename and a not in rename.values():
                rename[u] = a
    if not rename:
        return got
    out = {}
    for k, node in got.items():
        inputs = {name: [rename.get(str(v[0]), v[0]), v[1]] if isinstance(v, list) and len(v) == 2 else v
                  for name, v in node.get("inputs", {}).items()}
        out[rename.get(k, k)] = {**node, "inputs": inputs}
    return out


def norm(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int):
        return [str(v[0]), v[1]]
    return v


def main():
    ui_to_api = {}
    for wf in INDEX:
        for ui in wf.get("ui", []):
            ui_to_api[Path(ui).stem] = wf["api"]
    for p in OUT.glob("*.prompt.json"):  # graphs not in index.json yet (e.g. fresh api_to_ui output)
        stem = p.name[: -len(".prompt.json")]
        if stem not in ui_to_api and (BACKEND / "workflows" / "api" / f"{stem}.json").exists():
            ui_to_api[stem] = f"api/{stem}.json"
    total_issues = 0
    for stem, api_rel in sorted(ui_to_api.items()):
        p = OUT / f"{stem}.prompt.json"
        if not p.exists():
            print(f"## {stem}: no frontend output")
            continue
        want = json.loads((BACKEND / "workflows" / api_rel).read_text())
        got = pair_renumbered(json.loads(p.read_text()), want)
        issues = []
        only_ui = sorted(set(got) - set(want))
        only_api = sorted(set(want) - set(got))
        if only_ui:
            issues.append("only in UI: " + ", ".join(f"{k}({got[k]['class_type']})" for k in only_ui))
        if only_api:
            issues.append("only in API: " + ", ".join(f"{k}({want[k]['class_type']})" for k in only_api))
        for k in sorted(set(got) & set(want)):
            a, b = got[k], want[k]
            if a["class_type"] != b["class_type"]:
                issues.append(f"{k}: class {a['class_type']} vs {b['class_type']}")
                continue
            ai, bi = a.get("inputs", {}), b.get("inputs", {})
            for name in sorted(set(ai) | set(bi)):
                if name in IGNORE_INPUTS:
                    continue
                va, vb = norm(ai.get(name, "<missing>")), norm(bi.get(name, "<missing>"))
                if va != vb:
                    issues.append(f"{k}.{name}: UI={str(va)[:70]!r} API={str(vb)[:70]!r}")
        total_issues += len(issues)
        print(f"## {stem} -> {api_rel}: {len(issues)} difference(s)")
        for i in issues[:25]:
            print("   ", i)
        if len(issues) > 25:
            print(f"    ... {len(issues) - 25} more")
    print(f"\nTOTAL differences: {total_issues}")


main()
