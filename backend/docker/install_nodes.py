#!/usr/bin/env python3
"""Install ComfyUI custom-node packs from backend/custom_nodes.json (and CUSTOM_NODES).

  python install_nodes.py --comfy /workspace/ComfyUI            # every pack in custom_nodes.json
  python install_nodes.py --comfy /workspace/ComfyUI --packs comfyui-kjnodes,rgthree-comfy
  python install_nodes.py --comfy /workspace/ComfyUI --extra "https://github.com/a/b@v1.2 https://github.com/c/d"

Run it with the Python that runs ComfyUI (the volume's venv): requirements go into sys.executable.
A pack that is already there is moved to its pinned ref (and its requirements reinstalled) or left alone.

The Python rules are the owner's proven ones from production Runpod pods:
  1. Before the first pack, freeze the fragile core (transformers, tokenizers, torch*, numpy, huggingface-hub,
     safetensors, accelerate, diffusers) and install every pack's requirements under that freeze plus the version
     windows in venv-constraints.txt. A pack that insists on other versions is reported and its requirements are
     skipped; the constraint is never dropped.
  2. protobuf < 6.
  3. Packages the curated set does not need (closed API SDKs, training tools, web UIs, ...) are left out of the
     packs' requirements; NOT_CARRIED_OVER lists them, a pack's "allow" brings one back.
  4. Packages that compile against torch (sam2, groundingdino) build with --no-build-isolation.
  5. onnxruntime-gpu 1.20.2 instead of the CPU onnxruntime, one opencv version for every opencv package.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND = Path(os.environ.get("KITTY_BACKEND_DIR") or Path(__file__).resolve().parents[1])
WINDOWS = Path(__file__).resolve().parent / "venv-constraints.txt"
PROTECTED = ("transformers", "tokenizers", "torch", "torchvision", "torchaudio",
             "numpy", "huggingface-hub", "safetensors", "accelerate", "diffusers")
NOT_CARRIED_OVER = {
    # paid / closed API SDKs
    "google-genai", "google-cloud-storage", "fal-client", "runwayml", "openai", "ollama", "anthropic",
    "claude-agent-sdk", "openai-codex",
    # training and experiment tooling
    "deepspeed", "fairscale", "pytorch-lightning", "wandb", "tensorboardx", "datasets", "webdataset",
    "mosaicml-streaming", "swissarmytransformer",
    # web UIs and services
    "gradio", "streamlit", "psycopg2-binary", "redis", "redislite",
    # unused by the curated workflows
    "reportlab", "pypdf2", "pdf2image", "pymupdf", "glitch-this", "pyopengl", "glfw", "sounddevice", "mss", "gdown",
    "llama-cpp-python", "moondream", "clip-interrogator", "taichi", "insightface", "gfpgan", "facexlib", "basicsr",
    "ultralytics", "magi-compiler",
    # the job handler's S3 client lives in the image's Python, not in the ComfyUI venv
    "boto3",
}
TORCH_BUILDS = ("sam2", "groundingdino-py")  # setup.py imports torch: build against the venv's torch
KEEP_EXISTING = False  # --keep-existing: a pack that is already there stays at its ref (a ComfyUI we did not make)


def sh(cmd: list, cwd: Path | None = None, check: bool = True, env: dict | None = None) -> int:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    return subprocess.run([str(c) for c in cmd], cwd=cwd, check=check, env=env).returncode


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_name(line: str) -> str:
    """The distribution a requirements.txt line installs ('' for options and blanks)."""
    line = line.split(" #")[0].strip()
    if not line or line.startswith(("#", "-")):
        return ""
    if "://" in line and " @ " not in line:  # git+https://github.com/facebookresearch/sam2[@ref][#egg=name]
        egg = re.search(r"#egg=([A-Za-z0-9._-]+)", line)
        repo = line.split("#")[0].split(";")[0].rstrip("/").split("/")[-1].split("@")[0]
        return canonical(egg.group(1) if egg else repo.removesuffix(".git"))
    m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", line)
    return canonical(m.group(1)) if m else ""


def installed_versions() -> dict[str, str]:
    out = subprocess.run([sys.executable, "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
                         capture_output=True, text=True).stdout
    try:
        return {canonical(p["name"]): p["version"] for p in json.loads(out or "[]")}
    except ValueError:
        return {}


def write_constraints(path: Path, windows: bool = True) -> list[Path]:
    """Freeze the fragile core (rule 1) and return [freeze, version windows] for every pip call from here on."""
    have = installed_versions()
    keep = [f"{p}=={have[p]}" for p in PROTECTED if p in have]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(keep) + "\n")
    files = [path, WINDOWS] if windows else [path]
    # Every pip started from here on (also pip calls inside a pack's own install script) honours them.
    os.environ["PIP_CONSTRAINT"] = " ".join(str(f) for f in files)
    print(f"constraints: {', '.join(keep) or '(none)'}" + (f" + {WINDOWS.name}" if windows else ""), flush=True)
    return files


def pip_install(args: list, cwd: Path | None, constraints: list[Path], what: str, quiet: bool = False) -> bool:
    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check"]
    for c in constraints:
        cmd += ["-c", c]
    if sh(cmd + args, cwd=cwd, check=False) != 0:
        if not quiet:
            print(f"WARNING: {what}: pip could not install this within the pinned versions; skipped. "
                  "The node may still load; check the ComfyUI log.", flush=True)
        return False
    return True


def filtered_requirements(pack: dict, dest: Path) -> tuple[list[str], list[str], list[str]]:
    """(normal lines, torch-build lines, dropped names) from the pack's requirements.txt."""
    allow = {canonical(a) for a in pack.get("allow", [])}
    normal, torch_builds, dropped = [], [], []
    for raw in (dest / "requirements.txt").read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split(" #")[0].strip()
        if line.startswith(("-r ", "-c ", "--requirement", "--constraint")):
            flag, _, ref = line.partition(" ")
            line = f"{flag} {(dest / ref.strip()).resolve()}"  # the filtered copy lives in a temp dir
        name = requirement_name(line)
        if name in NOT_CARRIED_OVER and name not in allow:
            dropped.append(name)
        elif name in TORCH_BUILDS:
            torch_builds.append(line)
        elif line:
            normal.append(line)
    return normal, torch_builds, dropped


def install_requirements(pack: dict, dest: Path, constraints: list[Path]) -> None:
    if pack.get("requirements") is False or not (dest / "requirements.txt").exists():
        return
    normal, torch_builds, dropped = filtered_requirements(pack, dest)
    if dropped:
        print(f"  {dest.name}: not installing {', '.join(sorted(set(dropped)))} (not needed by the curated set)", flush=True)
    extra = list(pack.get("pip_args", []))
    if normal:
        with tempfile.NamedTemporaryFile("w", suffix="-requirements.txt", delete=False) as f:
            f.write("\n".join(normal) + "\n")
        ok = pip_install(["-r", f.name, *extra], dest, constraints, dest.name, quiet=True)
        os.unlink(f.name)
        if not ok:
            # Rule 1: one requirement that wants a newer core (e.g. nobg -> huggingface-hub 1.x) must not cost the
            # pack all the others: install them one by one, skipping only the ones that conflict.
            print(f"  {dest.name}: installing its requirements one by one", flush=True)
            skipped = [line for line in normal if not line.startswith("-")
                       and not pip_install([line, *extra], dest, constraints, f"{dest.name} ({line})")]
            if skipped:
                print(f"  {dest.name}: skipped (conflict with the pinned core): {', '.join(skipped)}", flush=True)
    for line in torch_builds:
        # SAM2_BUILD_CUDA=0: the optional CUDA post-processing kernel needs nvcc and is not used by the workflows.
        os.environ.setdefault("SAM2_BUILD_CUDA", "0")
        pip_install(["--no-build-isolation", line, *extra], dest, constraints, f"{dest.name} ({requirement_name(line)})")


def git(dest: Path, *args: str) -> str:
    r = subprocess.run(["git", *args], cwd=dest, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def clone(repo: str, ref: str, dest: Path) -> bool:
    """Clone, or move an existing checkout to `ref`. False when it is already there (nothing to reinstall)."""
    if dest.exists():
        if KEEP_EXISTING or not ref or not (dest / ".git").exists() or git(dest, "rev-parse", "HEAD") == git(
                dest, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"):
            print(f"= {dest.name} already present", flush=True)
            return False
        print(f"~ {dest.name}: moving to {ref[:12]}", flush=True)
        sh(["git", "fetch", "--quiet", "origin"], cwd=dest)
        # -f: the start script re-applies its small source patches (blackwell_patches.py) after every update
        sh(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "-f", ref], cwd=dest)
        return True
    sh(["git", "clone", "--quiet", "--filter=blob:none", repo, dest])
    if ref:
        sh(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", ref], cwd=dest)
    return True


def install_pack(pack: dict, comfy: Path, constraints: list[Path]) -> None:
    nodes = comfy / "custom_nodes"
    name = pack.get("dir") or pack["repo"].rstrip("/").split("/")[-1]
    if pack.get("install_mode") == "lightvae":
        # LightVAE ships an installer that copies only its ComfyUI node into custom_nodes (no .git to compare).
        marker = nodes / name / ".kitty-ref"
        if marker.exists() and marker.read_text().strip() == pack.get("ref", ""):
            print(f"= {name} already present", flush=True)
            return
        src = Path(tempfile.mkdtemp()) / "LightVAE"
        clone(pack["repo"], pack.get("ref", ""), src)
        sh([sys.executable, src / "comfyui" / "install.py", "--comfy-root", comfy])
        marker.write_text(pack.get("ref", "") + "\n")
        return
    dest = nodes / name
    if not clone(pack["repo"], pack.get("ref", ""), dest):
        return
    install_requirements(pack, dest, constraints)
    if pack.get("install"):
        # Run the pack's own installer with ComfyUI's interpreter, never whatever `python` is first on PATH:
        # Frame-Interpolation's install.py pip-installs into sys.executable (under PIP_CONSTRAINT).
        cmd = pack["install"].split()
        if cmd and cmd[0] in ("python", "python3"):
            cmd[0] = sys.executable
        sh(cmd, cwd=dest, check=False)


def finish(constraints: list[Path]) -> None:
    """Rules 2 and 5 once every pack is in: protobuf < 6, GPU onnxruntime only, one opencv build."""
    have = installed_versions()
    if "protobuf" in have:
        pip_install(["protobuf>=3.20.2,<6.0.0"], None, constraints, "protobuf")
    if "onnxruntime" in have:  # rembg and others pull the CPU package, which shadows onnxruntime-gpu
        sh([sys.executable, "-m", "pip", "uninstall", "-y", "onnxruntime"], check=False)
    if "onnxruntime" in have or "onnxruntime-gpu" in have:
        pip_install(["--force-reinstall", "--no-deps", "onnxruntime-gpu==1.20.2"], None, constraints, "onnxruntime-gpu")
    opencv = [p for p in ("opencv-python-headless", "opencv-python", "opencv-contrib-python") if p in have]
    if len(opencv) > 1:
        # They all write the same cv2 package: reinstall the last one so cv2 matches it (contrib is a superset).
        pip_install(["--force-reinstall", "--no-deps", f"{opencv[-1]}=={have[opencv[-1]]}"], None, constraints, "opencv")
    check = subprocess.run([sys.executable, "-m", "pip", "check"], capture_output=True, text=True)
    issues = [line for line in check.stdout.splitlines() if line.strip()]
    print(f"pip check: {len(issues)} issue(s)" + "".join(f"\n  {line}" for line in issues[:40]), flush=True)


def parse_extra(spec: str) -> list[dict]:
    packs = []
    for item in re.split(r"[\s,]+", spec.strip()):
        if not item:
            continue
        repo, _, ref = item.partition("@") if not item.startswith("git@") else (item, "", "")
        packs.append({"id": repo.rstrip("/").split("/")[-1], "repo": repo, "ref": ref})
    return packs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--comfy", type=Path, default=Path(os.environ.get("COMFY_DIR", "/workspace/ComfyUI")))
    ap.add_argument("--packs", default="all", help="'all', 'none' or comma-separated pack ids")
    ap.add_argument("--skip", default="", help="comma-separated pack ids to leave out")
    ap.add_argument("--extra", default="", help="extra git repos (URL[@ref], space or comma separated)")
    ap.add_argument("--keep-existing", action="store_true", help="only add missing packs; leave the others as they are")
    ap.add_argument("--no-windows", action="store_true",
                    help="freeze the venv's own core versions but skip venv-constraints.txt (a venv we did not make)")
    ap.add_argument("--constraints", type=Path, default=Path(tempfile.gettempdir()) / "kitty-constraints.txt",
                    help="where to write the freeze of the core packages")
    args = ap.parse_args()
    global KEEP_EXISTING
    KEEP_EXISTING = args.keep_existing

    manifest = json.loads((BACKEND / "custom_nodes.json").read_text(encoding="utf-8"))["packs"]
    if args.packs == "all":
        packs = manifest
    elif args.packs == "none":
        packs = []
    else:
        wanted = {p.strip() for p in args.packs.split(",") if p.strip()}
        unknown = wanted - {p["id"] for p in manifest}
        if unknown:
            print(f"unknown pack ids: {', '.join(sorted(unknown))}", file=sys.stderr)
            return 2
        packs = [p for p in manifest if p["id"] in wanted]
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    packs = [p for p in packs if p["id"] not in skip] + parse_extra(args.extra)
    (args.comfy / "custom_nodes").mkdir(parents=True, exist_ok=True)
    constraints = write_constraints(args.constraints, windows=not args.no_windows)
    failed = []
    for pack in packs:
        try:
            install_pack(pack, args.comfy, constraints)
        except subprocess.CalledProcessError as e:
            failed.append(pack["id"])
            print(f"ERROR installing {pack['id']}: {e}", flush=True)
    if packs:
        finish(constraints)
    if failed:
        print(f"failed packs: {', '.join(failed)}", flush=True)
    return 1 if failed and os.environ.get("STRICT_NODES") == "1" else 0


if __name__ == "__main__":
    sys.exit(main())
