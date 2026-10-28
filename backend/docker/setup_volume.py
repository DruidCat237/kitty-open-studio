#!/usr/bin/env python3
"""Prepare ComfyUI, its node packs and the Python venv on the volume; takes seconds when nothing changed.

The image only carries the runtime and the Kitty scripts, so it is small to push and to update. Everything heavy
lives on the volume, in the layout of the owner's proven Runpod setup:

  /workspace/ComfyUI/                       ComfyUI at the pinned commit, custom_nodes/ at the refs in custom_nodes.json
  /workspace/ComfyUI/models/                the models (the installer puts them here)
  /workspace/venv/                          Python 3.11: torch 2.8.0 + cu128, ComfyUI's and the packs' requirements
  /workspace/kitty/setup.json               what is installed; an image with newer pins updates only what changed
  /workspace/kitty/requirements-extra.txt   optional: your own packages for the venv (pip requirements format)

Serverless workers mount the same volume at /runpod-volume; start.sh links /workspace to it, so the paths inside the
venv stay valid there.

  python3 setup_volume.py            # start.sh runs this on every pod start
  python3 setup_volume.py --check    # exit 0 when the volume is ready (serverless start)

A ComfyUI that was already on the volume (not made by this script) is used as it is: no checkout, existing node
packs stay where they are, only missing packs are added; an existing venv keeps its torch.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install_nodes  # noqa: E402  (BACKEND, WINDOWS)

VENV_PYTHON = os.environ.get("VENV_PYTHON", "python3.11")
TORCH = os.environ.get("TORCH_PACKAGES", "torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0").split()
TORCH_INDEX = os.environ.get("TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu128")
# The core of the reference's "Packages to keep" that the packs need (Easy-Use, WanVideoWrapper, SeedVR2):
# installed before the freeze, so every pack gets the same accelerate / diffusers.
BASE = ["accelerate", "diffusers", "huggingface_hub", "hf_xet"]
RTX_PACK = "comfyui-nvidia-rtx-nodes"  # RTX Video Super Resolution + NVIDIA's nvidia-vfx SDK
SAGE_REPO = "https://github.com/thu-ml/SageAttention"
SAGE_REF = os.environ.get("SAGEATTENTION_REF", "d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5")  # the build that works


class SetupError(Exception):
    pass


def truthy(value: str | None, default: bool = False) -> bool:
    return default if value in (None, "") else value.lower() in ("1", "true", "yes", "on")


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:16]


def gpu_arch() -> str:
    """Compute capability of the first GPU (12.0 Blackwell, 9.0 Hopper, 8.9 Ada, 8.6 Ampere), '' without one."""
    if os.environ.get("TORCH_CUDA_ARCH_LIST"):
        return os.environ["TORCH_CUDA_ARCH_LIST"]
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=20).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return ""
    return out[0] if out else ""


def wanted(extra_file: Path) -> dict:
    nodes = json.loads((install_nodes.BACKEND / "custom_nodes.json").read_text(encoding="utf-8"))
    skip = "" if truthy(os.environ.get("INSTALL_NVIDIA_RTX"), True) else RTX_PACK
    sage = os.environ.get("ATTENTION", "sdpa") == "sage"
    return {
        "layout": 2,
        "comfyui": os.environ.get("COMFYUI_REF") or nodes["comfyui"]["ref"],
        "torch": " ".join([*TORCH, TORCH_INDEX]),
        "windows": digest([install_nodes.WINDOWS.read_text(encoding="utf-8"), BASE]),
        "packs": digest([[p["id"], p.get("ref", ""), p.get("allow", []), p.get("requirements", True)]
                         for p in nodes["packs"]] + [os.environ.get("NODE_PACKS", "all"), skip]),
        "attention": f"sage {SAGE_REF[:12]} sm{gpu_arch()}" if sage else "",
        "requirements_extra": digest(extra_file.read_text(encoding="utf-8")) if extra_file.exists() else "",
    }


class Volume:
    def __init__(self, data: Path):
        self.data = data
        self.comfy = Path(os.environ.get("COMFY_DIR") or data / "ComfyUI")
        self.venv = Path(os.environ.get("VENV_DIR") or data / "venv")
        self.python = self.venv / "bin" / "python"
        self.state = data / "kitty"
        self.marker = self.state / "setup.json"
        self.extra = self.state / "requirements-extra.txt"
        self.warnings: list[str] = []

    def installed(self) -> dict:
        try:
            return json.loads(self.marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def runs(self) -> bool:
        return self.python.exists() and subprocess.run([self.python, "-c", "pass"], capture_output=True).returncode == 0

    def ready(self, want: dict, have: dict) -> bool:
        return {k: have.get(k) for k in want} == want and self.runs() and (self.comfy / "main.py").exists()

    def status(self, state: str, step: str, message: str = "") -> None:
        """setup-status.json, which the installer shows on its page and in /api/status."""
        self.state.mkdir(parents=True, exist_ok=True)
        tmp = self.state / "setup-status.json.tmp"
        tmp.write_text(json.dumps({"state": state, "step": step, "message": message, "warnings": self.warnings,
                                   "updated": int(time.time())}))
        os.replace(tmp, self.state / "setup-status.json")
        print(f"[setup] {step}{': ' + message if message else ''}", flush=True)


def run(cmd: list, cwd: Path | None = None, env: dict | None = None) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    if subprocess.run([str(c) for c in cmd], cwd=cwd, env=env).returncode != 0:
        raise SetupError(f"failed: {' '.join(str(c) for c in cmd[:6])}")


def pip(vol: Volume, *args, constraints: bool = True) -> None:
    cmd = [vol.python, "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check"]
    if constraints:
        cmd += ["-c", install_nodes.WINDOWS]
    run([*cmd, *args])


def comfy_requirements(vol: Volume) -> None:
    """ComfyUI's requirements, then its comfy* packages upgraded within their pins (reference: base install)."""
    req = vol.comfy / "requirements.txt"
    torch_pins = vol.state / "torch-pins.txt"
    torch_pins.write_text("\n".join(TORCH) + "\n")  # nothing in requirements.txt may move torch
    pip(vol, "-r", req, "-c", torch_pins)
    comfy = [line.split("#")[0].strip() for line in req.read_text(encoding="utf-8").splitlines()
             if line.strip().lower().startswith("comfy")]
    if comfy:
        pip(vol, "--upgrade", *comfy, "-c", torch_pins)
    pip(vol, *BASE, "-c", torch_pins)


def build_sageattention(vol: Volume, arch: str) -> None:
    """The reference's Blackwell build: torch's CUDA-version check is silenced only while it compiles."""
    if not shutil.which("nvcc") and not Path("/usr/local/cuda/bin/nvcc").exists():
        raise SetupError("nvcc not found (the image's CUDA toolkit)")
    patch_file = Path(subprocess.run([vol.python, "-c", "import torch.utils.cpp_extension as e; print(e.__file__)"],
                                     capture_output=True, text=True).stdout.strip())
    original = patch_file.read_text(encoding="utf-8")
    src = Path(tempfile.mkdtemp()) / "SageAttention"
    env = {**os.environ, "TORCH_CUDA_ARCH_LIST": arch or "8.6;8.9;9.0;12.0", "MAX_JOBS": os.environ.get("MAX_JOBS", "1"),
           "NVCC_APPEND_FLAGS": "--threads 1", "PATH": f"/usr/local/cuda/bin:{os.environ.get('PATH', '')}"}
    try:
        patch_file.write_text(original.replace("raise RuntimeError(CUDA_MISMATCH_MESSAGE",
                                               "pass  # raise RuntimeError(CUDA_MISMATCH_MESSAGE"), encoding="utf-8")
        subprocess.run([vol.python, "-m", "pip", "uninstall", "-y", "sageattention"], capture_output=True)
        run(["git", "clone", "--quiet", "--filter=blob:none", SAGE_REPO, src])
        run(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", SAGE_REF], cwd=src)
        run([vol.python, "-m", "pip", "install", "--no-cache-dir", "--no-build-isolation", "-c", install_nodes.WINDOWS,
             "-c", vol.state / "constraints.txt", "."], cwd=src, env=env)
    finally:
        patch_file.write_text(original, encoding="utf-8")
        shutil.rmtree(src.parent, ignore_errors=True)
    run([vol.python, "-c", "import sageattention; print('sageattention', getattr(sageattention, '__version__', 'ok'))"])


@contextlib.contextmanager
def volume_lock(path: Path):
    """Two pods starting on one volume must not install into it at the same time."""
    import fcntl
    with open(path, "w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[setup] another pod is preparing this volume; waiting for it", flush=True)
            fcntl.flock(f, fcntl.LOCK_EX)
        except OSError:  # a network filesystem without locks: carry on
            pass
        yield


def setup(vol: Volume, want: dict, have: dict) -> dict:
    nodes = json.loads((install_nodes.BACKEND / "custom_nodes.json").read_text(encoding="utf-8"))
    # A ComfyUI this script did not make is the user's: use it, do not move it. Decided once, on the first run.
    managed = have.get("managed", not (vol.comfy / "main.py").exists())
    if "managed" not in have:
        vol.marker.write_text(json.dumps({"managed": managed}))  # an interrupted first run must not flip it
    changed = {k for k in want if have.get(k) != want[k]}

    vol.status("running", "ComfyUI")
    if not (vol.comfy / "main.py").exists():
        vol.comfy.mkdir(parents=True, exist_ok=True)  # may already hold models/ (the installer starts first)
        run(["git", "init", "-q"], cwd=vol.comfy)  # also fine on the half-made clone of an interrupted start
        subprocess.run(["git", "remote", "remove", "origin"], cwd=vol.comfy, capture_output=True)
        run(["git", "remote", "add", "origin", nodes["comfyui"]["repo"]], cwd=vol.comfy)
        run(["git", "fetch", "-q", "--filter=blob:none", "origin"], cwd=vol.comfy)
        run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "-f", want["comfyui"]], cwd=vol.comfy)
    elif managed and "comfyui" in changed:
        run(["git", "fetch", "-q", "origin"], cwd=vol.comfy)
        # -f: blackwell_patches.py edits a few files; start.sh applies them again after the update
        run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "-f", want["comfyui"]], cwd=vol.comfy)

    vol.status("running", "Python venv")
    if vol.venv.exists() and not vol.runs():
        raise SetupError(f"{vol.venv} exists but its Python does not start (made with another image?). "
                         f"Rename it, e.g. to venv.old, and restart: a new one is made")
    if not vol.venv.exists():
        if not shutil.which(VENV_PYTHON):
            raise SetupError(f"{VENV_PYTHON} not found in the image")
        run([VENV_PYTHON, "-m", "venv", vol.venv])
        pip(vol, "--upgrade", "pip", "setuptools", "wheel", constraints=False)  # inside the venv only
    torch_ok = subprocess.run([vol.python, "-c", "import torch, torchvision, torchaudio"], capture_output=True).returncode == 0
    new_torch = not torch_ok or (managed and "torch" in changed)
    if new_torch:
        vol.status("running", "PyTorch 2.8 for CUDA 12.8 (about 3.5 GB, a few minutes)")
        index = ["--index-url", TORCH_INDEX] if TORCH_INDEX else []  # empty: PyPI (its Linux torch 2.8 is cu128 too)
        pip(vol, *TORCH, *index, constraints=False)  # torchaudio must match torch exactly

    # The user's own venv keeps its versions: only a venv made here gets ComfyUI's requirements and the windows.
    new_core = new_torch or (managed and bool(changed & {"comfyui", "windows"}))
    if new_core:
        vol.status("running", "ComfyUI requirements")
        comfy_requirements(vol)

    if new_core or "packs" in changed:
        vol.status("running", "custom node packs (first time: 30-60 minutes on a Runpod network volume)")
        skip = [] if truthy(os.environ.get("INSTALL_NVIDIA_RTX"), True) else ["--skip", RTX_PACK]
        run([vol.python, HERE / "install_nodes.py", "--comfy", vol.comfy, "--packs", os.environ.get("NODE_PACKS", "all"),
             "--constraints", vol.state / "constraints.txt", *skip,
             *([] if managed else ["--keep-existing", "--no-windows"])])
        if not skip and subprocess.run([vol.python, "-c", "import nvvfx"], capture_output=True).returncode != 0:
            vol.warnings.append("nvidia-vfx did not install: RTX Video Super Resolution falls back to lanczos")

    if want["attention"] and (new_torch or "attention" in changed):
        vol.status("running", "SageAttention build (ATTENTION=sage, 10-30 minutes, once per volume and GPU type)")
        try:
            build_sageattention(vol, want["attention"].rsplit("sm", 1)[-1])
        except SetupError as e:  # not retried on every start; a new SAGEATTENTION_REF or GPU type tries again
            vol.warnings.append(f"SageAttention not built ({e}); ComfyUI uses PyTorch attention")

    if vol.extra.exists() and (new_core or changed & {"packs", "requirements_extra"}):
        vol.status("running", f"your extra packages ({vol.extra.name})")
        try:
            pip(vol, "-r", vol.extra, "-c", vol.state / "constraints.txt")
        except SetupError as e:
            vol.warnings.append(f"{vol.extra.name}: {e}")
    return {**want, "managed": managed, "warnings": vol.warnings, "finished": int(time.time())}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=Path(os.environ.get("DATA_DIR", "/workspace")))
    ap.add_argument("--check", action="store_true", help="only report whether the volume is ready")
    args = ap.parse_args()
    vol = Volume(args.data)
    want, have = wanted(vol.extra), vol.installed()
    if args.check:
        # no marker at all: a ComfyUI + venv made by hand, used as it is; a marker without "finished": interrupted
        if not (vol.runs() and (vol.comfy / "main.py").exists()) or (have and not have.get("finished")):
            print(f"not prepared: start a pod with this volume once ({vol.data}); it installs ComfyUI and the venv")
            return 1
        stale = sorted(k for k in want if k != "attention" and have and have.get(k) != want[k])
        print("ready" + (f" (prepared for older pins: {', '.join(stale)}; start a pod once to update)" if stale else ""))
        return 0
    vol.state.mkdir(parents=True, exist_ok=True)
    if vol.ready(want, have):
        vol.warnings = have.get("warnings", [])
        vol.status("done", "up to date")
        return 0
    started = time.time()
    with volume_lock(vol.state / "setup.lock"):
        have = vol.installed()  # another pod may have finished meanwhile
        if vol.ready(want, have):
            vol.warnings = have.get("warnings", [])
            vol.status("done", "up to date")
            return 0
        try:
            done = setup(vol, want, have)
        except SetupError as e:
            vol.status("error", "setup failed", f"{e} (log: kitty/logs/setup.log)")
            return 1
        tmp = vol.marker.with_suffix(".tmp")
        tmp.write_text(json.dumps(done, indent=2))
        os.replace(tmp, vol.marker)
    vol.status("done", "ready", f"prepared in {int(time.time() - started) // 60} min {int(time.time() - started) % 60} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
