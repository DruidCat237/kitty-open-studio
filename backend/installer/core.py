"""Model installer core: manifest, presets, size/cost estimate and resumable downloads.

Shared by the web page (app.py), the CLI (cli.py) and the Docker first-boot step.
Standard library only, so it runs in any Python 3.10+ before ComfyUI's deps exist.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(os.environ.get("KITTY_BACKEND_DIR") or Path(__file__).resolve().parents[1])
DEFAULT_MODELS_DIR = os.environ.get("MODELS_DIR") or "/workspace/ComfyUI/models"
GPU_PROFILES = ("24gb", "48gb", "80gb")

# Runpod network volume pricing (runpod.io/pricing, checked 26.10.2026): billed per GB
# per month while the volume exists, even when every pod using it is stopped.
VOLUME_PRICE_PER_GB = 0.07  # up to 1 TB
VOLUME_PRICE_PER_GB_OVER_1TB = 0.05
VOLUME_TIER_GB = 1000
# ComfyUI, its Python packages and custom nodes, inputs and outputs on the same volume.
VOLUME_BASE_GB = 30
VOLUME_HEADROOM = 1.2

CHUNK = 8 * 1024 * 1024
USER_AGENT = "kitty-open-studio-installer/0.1"


class InstallError(Exception):
    """A problem the user can fix; the message says how."""


# --------------------------------------------------------------------------- manifest
def load_json(name: str) -> dict:
    return json.loads((BACKEND_DIR / name).read_text(encoding="utf-8"))


@dataclass
class Catalog:
    models: list[dict]
    workflows: list[dict]
    presets: list[dict]

    @classmethod
    def load(cls) -> "Catalog":
        return cls(
            models=load_json("models.json")["models"],
            workflows=load_json("workflows/index.json")["workflows"],
            presets=load_json("installer/presets.json")["presets"],
        )

    @property
    def by_id(self) -> dict[str, dict]:
        return {m["id"]: m for m in self.models}

    def preset(self, preset_id: str) -> dict:
        for p in self.presets:
            if p["id"] == preset_id:
                return p
        raise InstallError(f"unknown preset '{preset_id}' (choose from: {', '.join(p['id'] for p in self.presets)})")

    def models_for_workflows(self, workflow_ids: list[str]) -> list[str]:
        wanted = {w["id"] for w in self.workflows} if "*" in workflow_ids else set(workflow_ids)
        known = {w["id"] for w in self.workflows}
        unknown = wanted - known
        if unknown:
            raise InstallError(f"unknown workflow(s): {', '.join(sorted(unknown))}")
        ids = []
        for w in self.workflows:
            if w["id"] in wanted:
                ids += [m for m in w.get("models", []) if m not in ids]
        return ids

    def resolve(self, models: list[str] | None = None, preset: str | None = None,
                workflows: list[str] | None = None) -> list[str]:
        """Model ids for any mix of explicit ids, a preset and workflow ids."""
        ids: list[str] = []
        if preset:
            ids += self.models_for_workflows(self.preset(preset)["workflows"])
        if workflows:
            ids += self.models_for_workflows(workflows)
        for m in models or []:
            if m not in self.by_id:
                raise InstallError(f"unknown model id '{m}' (run cli.py --list)")
            ids.append(m)
        out: list[str] = []
        for i in ids:
            if i not in out:
                out.append(i)
        return out


def pick_variant(model: dict, profile: str | None) -> dict:
    """The file to download for this GPU profile (variants swap FP8/INT8/BF16 files)."""
    variant = (model.get("variants") or {}).get(profile or "")
    if variant:
        return {**model, **{k: v for k, v in variant.items() if v is not None}}
    return model


def target_path(model: dict, models_dir: str | Path) -> Path:
    return Path(models_dir) / model["folder"] / model["filename"]


def is_installed(model: dict, models_dir: str | Path) -> bool:
    path = target_path(model, models_dir)
    if not path.is_file():
        return False
    size = model.get("size_bytes")
    return not size or path.stat().st_size == size


def link_copies(model: dict, models_dir: str | Path) -> None:
    """Make the file visible in the other folders some nodes look in (`also_in`), without a second copy."""
    src = target_path(model, models_dir)
    for folder in model.get("also_in") or []:
        extra = Path(models_dir) / folder / model["filename"]
        if extra.exists() or not src.is_file():
            continue
        extra.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, extra)  # same volume: a hardlink costs no space
        except OSError:
            extra.symlink_to(src)


# --------------------------------------------------------------------------- estimate
def monthly_cost(volume_gb: float) -> float:
    low = min(volume_gb, VOLUME_TIER_GB)
    high = max(0.0, volume_gb - VOLUME_TIER_GB)
    return round(low * VOLUME_PRICE_PER_GB + high * VOLUME_PRICE_PER_GB_OVER_1TB, 2)


def recommended_volume_gb(models_gb: float) -> int:
    raw = (models_gb + VOLUME_BASE_GB) * VOLUME_HEADROOM
    return int(math.ceil(raw / 10.0) * 10)


def estimate(catalog: Catalog, ids: list[str], profile: str | None = None,
             models_dir: str | Path | None = None) -> dict:
    by_id = catalog.by_id
    rows, total, missing, unknown_size = [], 0, 0, []
    for i in ids:
        m = pick_variant(by_id[i], profile)
        size = m.get("size_bytes") or 0
        if not m.get("size_bytes"):
            unknown_size.append(i)
        installed = bool(models_dir) and is_installed(m, models_dir)
        total += size
        if not installed and not m.get("auto_download"):
            missing += size
        rows.append({"id": i, "filename": m["filename"], "folder": m["folder"], "size_gb": round(size / 1e9, 2),
                     "license": m.get("license"), "gated": m.get("gated", False),
                     "auto_download": m.get("auto_download", False), "installed": installed})
    total_gb = total / 1e9
    volume = recommended_volume_gb(total_gb)
    return {
        "models": rows,
        "count": len(rows),
        "total_gb": round(total_gb, 1),
        "to_download_gb": round(missing / 1e9, 1),
        "recommended_volume_gb": volume,
        "monthly_cost_usd": monthly_cost(volume),
        "monthly_cost_models_only_usd": monthly_cost(total_gb),
        "price_note": (f"Runpod network volume: ${VOLUME_PRICE_PER_GB}/GB/month up to 1 TB, "
                       f"${VOLUME_PRICE_PER_GB_OVER_1TB}/GB/month above (verify on runpod.io/pricing). "
                       "A volume is billed while it exists, even when the pods using it are stopped."),
        "needs_hf_token": sorted({r["id"] for r in rows if r["gated"] and not r["installed"]}),
        "unknown_size": unknown_size,
        "gpu_profile": profile or "48gb",
    }


def format_estimate(est: dict) -> str:
    lines = [f"{'model':58} {'GB':>7}  license"]
    for r in est["models"]:
        flag = " (installed)" if r["installed"] else (" (fetched by its node)" if r["auto_download"] else "")
        lines.append(f"{r['filename'][:58]:58} {r['size_gb']:7.1f}  {r['license']}{flag}")
    lines += [
        "",
        f"Models:            {est['count']} files, {est['total_gb']} GB ({est['to_download_gb']} GB still to download)",
        f"Recommended volume: {est['recommended_volume_gb']} GB (models + ~{VOLUME_BASE_GB} GB for ComfyUI, +20% headroom)",
        f"Monthly storage:   ${est['monthly_cost_usd']:.2f} for that volume (${est['monthly_cost_models_only_usd']:.2f} for the models alone)",
        f"Note:              {est['price_note']}",
    ]
    if est["needs_hf_token"]:
        lines.append("Gated on Hugging Face (accept the license on the model page, then set HF_TOKEN): "
                     + ", ".join(est["needs_hf_token"]))
    return "\n".join(lines)


# --------------------------------------------------------------------------- downloads
@dataclass
class FileProgress:
    id: str
    filename: str
    total: int = 0
    done: int = 0
    status: str = "queued"  # queued | downloading | verifying | done | skipped | error
    message: str = ""
    speed: float = 0.0  # bytes/s

    def as_dict(self) -> dict:
        return {"id": self.id, "filename": self.filename, "total": self.total, "done": self.done,
                "status": self.status, "message": self.message, "speed": round(self.speed)}


@dataclass
class Job:
    files: list[FileProgress] = field(default_factory=list)
    state: str = "idle"  # idle | running | done | error | cancelled
    message: str = ""
    cancel: threading.Event = field(default_factory=threading.Event)

    def as_dict(self) -> dict:
        total = sum(f.total for f in self.files)
        done = sum(f.total if f.status in ("done", "skipped") else f.done for f in self.files)
        return {"state": self.state, "message": self.message, "total": total, "done": done,
                "files": [f.as_dict() for f in self.files]}


def workflow_readiness(catalog: Catalog, models_dir: str | Path, profile: str | None) -> tuple[list[str], dict]:
    """(ready workflow ids, {workflow id: missing file names}) for the files on this volume."""
    by_id, ready, missing = catalog.by_id, [], {}
    for w in catalog.workflows:
        files = [pick_variant(by_id[i], profile) for i in w.get("models", []) if i in by_id]
        absent = [m["filename"] for m in files if not m.get("auto_download") and not is_installed(m, models_dir)]
        if absent:
            missing[w["id"]] = absent
        else:
            ready.append(w["id"])
    return ready, missing


UNKNOWN_FREE = 100 * 1000 ** 4  # more than 100 TB free: a network filesystem reporting its whole cluster


def free_bytes(path: str | Path) -> int | None:
    """Free bytes where models go; None when the filesystem cannot tell (a Runpod network volume reports the free
    space of the whole storage cluster, not of your volume's size)."""
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    free = shutil.disk_usage(p).free
    return None if free > UNKNOWN_FREE else free


def check_space(needed: int, models_dir: str | Path, margin: int = 2 * 1024 ** 3) -> None:
    free = free_bytes(models_dir)
    if free is not None and needed + margin > free:
        raise InstallError(
            f"Not enough free space in {models_dir}: need {needed / 1e9:.1f} GB (+2 GB margin), "
            f"have {free / 1e9:.1f} GB. Pick fewer models or grow the volume.")


def _request(url: str, start: int = 0) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT}
    token = os.environ.get("HF_TOKEN", "").strip()
    if token and "huggingface.co" in url:
        headers["Authorization"] = f"Bearer {token}"
    if start:
        headers["Range"] = f"bytes={start}-"
    return urllib.request.Request(url, headers=headers)


def download(model: dict, models_dir: str | Path, progress: FileProgress, cancel: threading.Event,
             verify: bool = True, retries: int = 4) -> None:
    """Download one model into place: <dest>.part, resumed with HTTP Range, then renamed."""
    dest = target_path(model, models_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    expected = model.get("size_bytes") or 0
    sha = (model.get("sha256") or "").lower() if verify else ""
    progress.total = expected
    attempt = 0
    while True:
        start = part.stat().st_size if part.exists() else 0
        if expected and start > expected:
            part.unlink()
            start = 0
        hasher = hashlib.sha256() if sha else None
        if hasher and start:
            progress.status, progress.message = "verifying", "hashing the partial file before resuming"
            with part.open("rb") as fh:
                for block in iter(lambda: fh.read(CHUNK), b""):
                    hasher.update(block)
        progress.status, progress.message, progress.done = "downloading", "", start
        try:
            if expected and start == expected:
                break
            with urllib.request.urlopen(_request(model["url"], start), timeout=60) as resp:
                if start and resp.status != 206:  # server ignored Range: start over
                    start, hasher = 0, (hashlib.sha256() if sha else None)
                    progress.done = 0
                if not expected:
                    length = int(resp.headers.get("Content-Length") or 0)
                    progress.total = expected = start + length if length else 0
                mode = "ab" if start else "wb"
                t0, last = time.time(), start
                with part.open(mode) as out:
                    while True:
                        if cancel.is_set():
                            progress.status, progress.message = "error", "cancelled (the partial file is kept for resume)"
                            return
                        block = resp.read(CHUNK)
                        if not block:
                            break
                        out.write(block)
                        if hasher:
                            hasher.update(block)
                        progress.done += len(block)
                        now = time.time()
                        if now - t0 >= 1:
                            progress.speed = (progress.done - last) / (now - t0)
                            t0, last = now, progress.done
            if expected and part.stat().st_size < expected:
                # The body ended early without an exception (the server or a proxy dropped
                # the connection): resume from where it stopped.
                raise ConnectionError(f"connection closed at {part.stat().st_size} of {expected} bytes")
            break
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise InstallError(
                    f"{model['filename']}: access denied (HTTP {e.code}). This model is gated: accept its license on "
                    f"{model.get('source') or model['url']} and set HF_TOKEN to a token of that account.") from e
            if e.code == 416:  # range not satisfiable: the part is complete or broken
                if expected and part.exists() and part.stat().st_size == expected:
                    break
                part.unlink(missing_ok=True)
            attempt += 1
            if attempt > retries:
                raise InstallError(f"{model['filename']}: download failed (HTTP {e.code})") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            attempt += 1
            if attempt > retries:
                raise InstallError(f"{model['filename']}: download failed after {retries} retries ({e})") from e
            progress.message = f"connection problem, retrying ({attempt}/{retries})"
            time.sleep(min(30, 2 ** attempt))
    size = part.stat().st_size
    if expected and size != expected:
        raise InstallError(f"{model['filename']}: size {size} != expected {expected}; the partial file is kept, run again to resume")
    if sha and hasher is not None:
        progress.status = "verifying"
        if hasher.hexdigest() != sha:
            part.unlink(missing_ok=True)
            raise InstallError(f"{model['filename']}: sha256 mismatch, the file was deleted; run again")
    os.replace(part, dest)
    link_copies(model, models_dir)
    progress.status, progress.done, progress.message = "done", size, ""


def plan(catalog: Catalog, ids: list[str], models_dir: str | Path, profile: str | None,
         only_missing: bool = True) -> tuple[list[dict], list[FileProgress]]:
    """Resolve variants, drop installed / auto-downloaded files, return (models, progress rows)."""
    todo, rows = [], []
    for i in ids:
        m = pick_variant(catalog.by_id[i], profile)
        row = FileProgress(id=i, filename=m["filename"], total=m.get("size_bytes") or 0)
        if m.get("auto_download") or not m.get("url"):
            row.status, row.message = "skipped", "downloaded by its custom node on first run"
        elif only_missing and is_installed(m, models_dir):
            link_copies(m, models_dir)  # repairs a missing link from an older install
            row.status, row.message = "skipped", "already installed"
        else:
            todo.append(m)
        rows.append(row)
    return todo, rows


def run_install(catalog: Catalog, ids: list[str], models_dir: str | Path, profile: str | None = None,
                only_missing: bool = True, verify: bool = True, job: Job | None = None,
                on_update=None) -> Job:
    job = job or Job()
    todo, job.files = plan(catalog, ids, models_dir, profile, only_missing)
    job.state, job.message = "running", ""
    gated = [m for m in todo if m.get("gated")]
    try:
        if gated and not os.environ.get("HF_TOKEN"):
            raise InstallError(
                "These models are gated on Hugging Face: " + ", ".join(m["filename"] for m in gated)
                + ". Accept the license on each model page, create a read token at huggingface.co/settings/tokens "
                "and set HF_TOKEN (pod: Edit Pod > Environment Variables).")
        needed = 0
        for m in todo:
            part = target_path(m, models_dir).with_name(m["filename"].split("/")[-1] + ".part")
            have = part.stat().st_size if part.exists() else 0
            needed += max(0, (m.get("size_bytes") or 0) - have)
        check_space(needed, models_dir)
        rows = {r.id: r for r in job.files}
        for m in todo:
            if job.cancel.is_set():
                job.state, job.message = "cancelled", "cancelled; run again to resume"
                return job
            download(m, models_dir, rows[m["id"]], job.cancel, verify=verify)
            if on_update:
                on_update(job)
        job.state = "cancelled" if job.cancel.is_set() else "done"
        job.message = "cancelled; run again to resume" if job.cancel.is_set() else "all selected models are installed"
    except InstallError as e:
        job.state, job.message = "error", str(e)
        for r in job.files:
            if r.status == "downloading":
                r.status, r.message = "error", str(e)
    return job
