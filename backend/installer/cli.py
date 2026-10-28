#!/usr/bin/env python3
"""Kitty Open Studio model installer, command line.

Examples:
  python installer/cli.py --list
  python installer/cli.py --estimate --preset starter
  python installer/cli.py --estimate --preset video --json        # for an AI assistant
  python installer/cli.py --preset starter                       # download (only missing files)
  python installer/cli.py --workflows fasth3-omni --gpu-profile 24gb
  python installer/cli.py --models ltx-2-5-video-vae-bf16 --models-dir /runpod-volume/ComfyUI/models

HF_TOKEN is read from the environment, and only for gated Hugging Face models.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core  # noqa: E402


def split(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for v in values or []:
        out += [x.strip() for x in v.split(",") if x.strip()]
    return out


def print_list(catalog: core.Catalog, as_json: bool) -> None:
    if as_json:
        print(json.dumps({
            "presets": [{"id": p["id"], "title": p["title"], "workflows": p["workflows"]} for p in catalog.presets],
            "workflows": [{"id": w["id"], "title": w["title"], "category": w["category"], "models": w["models"]}
                          for w in catalog.workflows],
            "models": [{k: m.get(k) for k in ("id", "filename", "folder", "size_bytes", "license", "group", "gated")}
                       for m in catalog.models],
        }, indent=2))
        return
    print("Presets:")
    for p in catalog.presets:
        ids = catalog.resolve(preset=p["id"])
        gb = sum(catalog.by_id[i].get("size_bytes") or 0 for i in ids) / 1e9
        print(f"  {p['id']:12} {p['title']:24} {gb:7.1f} GB  {p['summary']}")
    print("\nWorkflows:")
    for w in catalog.workflows:
        gb = sum(catalog.by_id[i].get("size_bytes") or 0 for i in w["models"]) / 1e9
        print(f"  {w['id']:24} {w['category']:9} {gb:6.1f} GB  {w['title']}")
    print("\nModels:")
    for m in catalog.models:
        print(f"  {m['id']:60} {(m.get('size_bytes') or 0) / 1e9:6.1f} GB  {m['group']:7}  {m['license']}")


def progress_printer(job: core.Job, stop: threading.Event) -> None:
    while not stop.wait(2):
        d = job.as_dict()
        cur = next((f for f in d["files"] if f["status"] in ("downloading", "verifying")), None)
        if cur:
            pct = 100 * cur["done"] / cur["total"] if cur["total"] else 0
            total_pct = 100 * d["done"] / d["total"] if d["total"] else 0
            speed = cur["speed"] / 1e6
            print(f"\r  {cur['filename'][:48]:48} {pct:5.1f}%  {speed:6.1f} MB/s  | all {total_pct:5.1f}%   ", end="", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Download the models Kitty Open Studio workflows need.")
    ap.add_argument("--list", action="store_true", help="list presets, workflows and models")
    ap.add_argument("--preset", help="starter | instant | video | talking-h3 | everything")
    ap.add_argument("--workflows", action="append", help="workflow ids (comma separated)")
    ap.add_argument("--models", action="append", help="model ids (comma separated)")
    ap.add_argument("--estimate", action="store_true", help="only print size, volume size and monthly cost")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--models-dir", default=core.DEFAULT_MODELS_DIR, help="ComfyUI models folder (default: $MODELS_DIR)")
    ap.add_argument("--gpu-profile", default=os.environ.get("GPU_PROFILE") or "48gb", choices=core.GPU_PROFILES)
    ap.add_argument("--all-files", action="store_true", help="re-download files that are already installed")
    ap.add_argument("--no-verify", action="store_true", help="skip the sha256 check")
    args = ap.parse_args(argv)

    try:
        catalog = core.Catalog.load()
        if args.list:
            print_list(catalog, args.json)
            return 0
        ids = catalog.resolve(models=split(args.models), preset=args.preset, workflows=split(args.workflows))
        if not ids:
            ap.error("choose --preset, --workflows or --models (see --list)")
        est = core.estimate(catalog, ids, args.gpu_profile, args.models_dir)
        if args.estimate:
            print(json.dumps(est, indent=2) if args.json else core.format_estimate(est))
            return 0
        if not args.json:
            print(core.format_estimate(est), "\n")
        job = core.Job()
        stop = threading.Event()
        if not args.json:
            threading.Thread(target=progress_printer, args=(job, stop), daemon=True).start()
        try:
            core.run_install(catalog, ids, args.models_dir, args.gpu_profile, only_missing=not args.all_files,
                             verify=not args.no_verify, job=job)
        except KeyboardInterrupt:
            job.cancel.set()
            print("\ncancelled; the partial file is kept, run the same command again to resume")
            return 130
        finally:
            stop.set()
            time.sleep(0.1)
        result = job.as_dict()
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print()
            for f in result["files"]:
                print(f"  {f['status']:9} {f['filename']}  {f['message']}")
            print(f"\n{result['state']}: {result['message']}")
        return 0 if result["state"] == "done" else 1
    except core.InstallError as e:
        print(json.dumps({"error": str(e)}) if args.json else f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
