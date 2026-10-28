#!/usr/bin/env python3
"""Kitty Open Studio model installer: one web page on the pod (port 7861).

  python installer/app.py [--port 7861] [--models-dir /workspace/ComfyUI/models]

Tick the models (or a preset), see the total size and the monthly storage cost,
then download only what is missing, with a progress bar per file and resume.

The page is a thin client of a small JSON API, so a coding assistant can drive the same install over the pod's
proxy URL: GET /api/status, POST /api/estimate, POST /api/install, GET /api/progress (schemas at /api/docs).
It also runs generation jobs for the Kitty app in the shape of Runpod serverless: POST /api/jobs, GET /api/jobs/<id>
(installer/jobs.py; KITTY_API_TOKEN, when set, protects them).
With --install-from-env, INSTALL_PRESET / INSTALL_WORKFLOWS / INSTALL_MODELS start an install at boot.
/api/status also reports the volume setup (ComfyUI, node packs and the venv, prepared by docker/setup_volume.py).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core  # noqa: E402
import jobs as kitty_jobs  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"


class JobRequest(BaseModel):
    input: dict


class Selection(BaseModel):
    models: list[str] = []
    preset: str | None = None
    workflows: list[str] = []
    gpu_profile: str | None = None
    only_missing: bool = True


def selection_from_env() -> Selection | None:
    """INSTALL_PRESET / INSTALL_WORKFLOWS / INSTALL_MODELS (comma-separated ids), as the Docker image passes them."""
    def ids(name: str) -> list[str]:
        return [x.strip() for x in os.environ.get(name, "").split(",") if x.strip()]

    sel = Selection(preset=os.environ.get("INSTALL_PRESET") or None, workflows=ids("INSTALL_WORKFLOWS"),
                    models=ids("INSTALL_MODELS"))
    return sel if (sel.preset or sel.workflows or sel.models) else None


def setup_status(data_dir: str | None = None) -> dict:
    """What docker/setup_volume.py is doing (state: running | done | error), or {} outside the Docker image."""
    path = Path(data_dir or os.environ.get("DATA_DIR") or "/workspace") / "kitty" / "setup-status.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def comfy_status(url: str) -> dict:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/system_stats", timeout=3) as r:
            stats = json.loads(r.read())
    except (OSError, ValueError) as e:
        return {"ok": False, "url": url, "error": str(e)[:200]}
    device = (stats.get("devices") or [{}])[0]
    return {"ok": True, "url": url, "version": (stats.get("system") or {}).get("comfyui_version"),
            "gpu": device.get("name"), "vram_gb": round((device.get("vram_total") or 0) / 1e9, 1)}


def create_app(models_dir: str | None = None, autostart: Selection | None = None,
               comfy_url: str | None = None, job_runner=None) -> FastAPI:
    app = FastAPI(title="Kitty Open Studio model installer", docs_url="/api/docs", redoc_url=None)
    state = {"job": core.Job(), "thread": None, "lock": threading.Lock()}
    mdir = models_dir or core.DEFAULT_MODELS_DIR
    comfy = comfy_url or os.environ.get("COMFY_URL") or f"http://127.0.0.1:{os.environ.get('COMFY_PORT', '3020')}"

    def catalog() -> core.Catalog:
        return core.Catalog.load()

    def profile(p: str | None) -> str:
        p = p or os.environ.get("GPU_PROFILE") or "48gb"
        if p not in core.GPU_PROFILES:
            raise HTTPException(400, f"gpu_profile must be one of {', '.join(core.GPU_PROFILES)}")
        return p

    def resolve(sel: Selection) -> list[str]:
        try:
            return catalog().resolve(models=sel.models, preset=sel.preset, workflows=sel.workflows)
        except core.InstallError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/api/catalog")
    def get_catalog(gpu_profile: str | None = None) -> dict:
        cat, prof = catalog(), profile(gpu_profile)
        models = []
        for m in cat.models:
            v = core.pick_variant(m, prof)
            models.append({
                "id": m["id"], "filename": v["filename"], "folder": v["folder"], "size_bytes": v.get("size_bytes"),
                "group": m.get("group"), "license": m.get("license"), "license_kind": m.get("license_kind"),
                "source": m.get("source"), "gated": m.get("gated", False), "auto_download": m.get("auto_download", False),
                "workflows": m.get("workflows", []), "installed": core.is_installed(v, mdir),
            })
        return {
            "models_dir": mdir,
            "free_bytes": core.free_bytes(mdir),
            "gpu_profile": prof,
            "gpu_profiles": list(core.GPU_PROFILES),
            "hf_token_set": bool(os.environ.get("HF_TOKEN")),
            "presets": cat.presets,
            "workflows": [{"id": w["id"], "title": w["title"], "category": w["category"], "models": w.get("models", []),
                           "min_vram_gb": w.get("min_vram_gb"), "hidden": w.get("hidden", False)} for w in cat.workflows],
            "models": models,
        }

    @app.post("/api/estimate")
    def post_estimate(sel: Selection) -> dict:
        return core.estimate(catalog(), resolve(sel), profile(sel.gpu_profile), mdir)

    @app.get("/api/status")
    def get_status(gpu_profile: str | None = None) -> dict:
        """One call for an assistant: volume setup, ComfyUI and its GPU, free space, ready workflows, the install job."""
        prof = profile(gpu_profile)
        ready, missing = core.workflow_readiness(catalog(), mdir, prof)
        return {"setup": setup_status(), "comfyui": comfy_status(comfy), "models_dir": mdir,
                "free_bytes": core.free_bytes(mdir),
                "gpu_profile": prof, "hf_token_set": bool(os.environ.get("HF_TOKEN")),
                "ready_workflows": ready, "missing_models": missing, "install": state["job"].as_dict()}

    @app.post("/api/install")
    def post_install(sel: Selection) -> dict:
        ids = resolve(sel)
        if not ids:
            raise HTTPException(400, "nothing selected")
        with state["lock"]:
            t = state["thread"]
            if t is not None and t.is_alive():
                raise HTTPException(409, "an install is already running")
            job = core.Job()
            state["job"] = job
            t = threading.Thread(target=core.run_install, daemon=True,
                                 kwargs={"catalog": catalog(), "ids": ids, "models_dir": mdir,
                                         "profile": profile(sel.gpu_profile), "only_missing": sel.only_missing, "job": job})
            state["thread"] = t
            t.start()
        return {"started": True, "count": len(ids)}

    @app.get("/api/progress")
    def get_progress() -> dict:
        return state["job"].as_dict()

    @app.post("/api/cancel")
    def post_cancel() -> dict:
        state["job"].cancel.set()
        return {"cancelling": True}

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    # --- generation jobs for the Kitty app, in the shape of Runpod serverless (installer/jobs.py) -------------
    jobs = kitty_jobs.Jobs(run=job_runner)

    def authorize(authorization: str | None) -> None:
        token = os.environ.get("KITTY_API_TOKEN")
        if token and authorization != f"Bearer {token}":
            raise HTTPException(401, "this pod has KITTY_API_TOKEN set: send Authorization: Bearer <token>")

    @app.post("/api/jobs")
    def post_job(req: JobRequest, authorization: str | None = Header(None)) -> dict:
        authorize(authorization)
        return jobs.submit(req.input)

    @app.get("/api/jobs/{jid}")
    def get_job(jid: str, authorization: str | None = Header(None)) -> dict:
        authorize(authorization)
        job = jobs.get(jid)
        if job is None:
            raise HTTPException(404, "no such job (the pod keeps the last 200)")
        return job

    @app.post("/api/jobs/{jid}/cancel")
    def cancel_job(jid: str, authorization: str | None = Header(None)) -> dict:
        authorize(authorization)
        job = jobs.cancel(jid)
        if job is None:
            raise HTTPException(404, "no such job")
        return job

    @app.get("/api/files/{jid}/{name}")
    def get_file(jid: str, name: str) -> FileResponse:
        # no token here: the job id is a random 16-hex name, and <img>/<video> tags cannot send headers
        path = kitty_jobs.file_path(jid, name)
        if path is None:
            raise HTTPException(404, "no such file (job files are deleted after RETENTION_DAYS)")
        return FileResponse(path)

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    if autostart is not None:
        try:
            post_install(autostart)
        except HTTPException as e:  # e.g. an unknown preset id: show it on the page instead of failing to start
            state["job"].state, state["job"].message = "error", f"install from the environment: {e.detail}"
    return app


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("INSTALLER_PORT", "7861")))
    ap.add_argument("--models-dir", default=core.DEFAULT_MODELS_DIR)
    ap.add_argument("--install-from-env", action="store_true",
                    help="start installing INSTALL_PRESET / INSTALL_WORKFLOWS / INSTALL_MODELS right away")
    args = ap.parse_args()
    autostart = selection_from_env() if args.install_from_env else None
    uvicorn.run(create_app(args.models_dir, autostart), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
