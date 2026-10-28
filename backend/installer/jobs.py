"""Generation jobs on a pod or a local Docker install, in the shape of Runpod serverless.

The Kitty app (and an assistant) send the same job to every backend: {"input": {"workflow": ..., "inputs": {...}}}.
On serverless Runpod queues it for docker/handler.py; here the installer runs the same handler against the local
ComfyUI, one job at a time, and keeps the results as files in ComfyUI's output folder (so the 3-day cleanup covers
them) behind /api/files/<job>/<name>.

  POST /api/jobs              {"input": {...}}            -> {"id", "status": "IN_QUEUE"}
  GET  /api/jobs/<id>                                     -> {"id", "status", "output" | "error", "delayTime", "executionTime"}
  POST /api/jobs/<id>/cancel
"""
from __future__ import annotations

import base64
import os
import queue
import re
import sys
import threading
import time
import uuid
from pathlib import Path

DOCKER = Path(__file__).resolve().parents[1] / "docker"
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


def files_dir() -> Path:
    work = os.environ.get("WORK_DIR") or str(Path(os.environ.get("DATA_DIR") or "/workspace") / "kitty")
    return Path(work) / "output" / "kitty-jobs"


class Jobs:
    def __init__(self, run=None, keep: int = 200):
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.pending: queue.Queue[str] = queue.Queue()
        self.keep = keep
        self.lock = threading.Lock()
        self._run = run  # tests pass a fake; by default docker/handler.run_job
        threading.Thread(target=self._worker, daemon=True).start()

    def submit(self, job_input: dict) -> dict:
        jid = uuid.uuid4().hex[:16]
        with self.lock:
            self.jobs[jid] = {"id": jid, "status": "IN_QUEUE", "input": job_input, "created": time.time()}
            self.order.append(jid)
            for old in self.order[:-self.keep]:  # the newest jobs stay listed; their files follow the 3-day cleanup
                self.jobs.pop(old, None)
            self.order = self.order[-self.keep:]
        self.pending.put(jid)
        return {"id": jid, "status": "IN_QUEUE"}

    def get(self, jid: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(jid)
            return None if job is None else {k: v for k, v in job.items() if k not in ("input", "created", "started")}

    def cancel(self, jid: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(jid)
            if job is None:
                return None
            if job["status"] == "IN_QUEUE":
                job["status"] = "CANCELLED"
            return {"id": jid, "status": job["status"]}

    def _runner(self):
        if self._run is None:
            sys.path.insert(0, str(DOCKER))
            import handler  # the serverless handler: same inputs, same checks, same outputs

            handler.OUTPUT_MODE = "base64"
            self._run = handler.run_job
        return self._run

    def _worker(self) -> None:
        while True:
            jid = self.pending.get()
            with self.lock:
                job = self.jobs.get(jid)
                if job is None or job["status"] != "IN_QUEUE":
                    continue
                job["status"], job["started"] = "IN_PROGRESS", time.time()
                job["delayTime"] = int((job["started"] - job["created"]) * 1000)
            try:
                output = self._runner()(job["input"], f"pod-{jid}")
                output = store_files(jid, output)
                status, error = "COMPLETED", None
            except Exception as e:  # noqa: BLE001 - the job reports it; the queue carries on
                output, status, error = None, "FAILED", f"{type(e).__name__}: {e}"
            with self.lock:
                job["status"] = status
                job["executionTime"] = int((time.time() - job["started"]) * 1000)
                if output is not None:
                    job["output"] = output
                if error:
                    job["error"] = error


def store_files(jid: str, output: dict) -> dict:
    """Write base64 outputs to files and hand out their URLs instead (videos are far too big for JSON)."""
    folder = files_dir() / jid
    for out in output.get("outputs", []) if isinstance(output, dict) else []:
        if "base64" not in out:
            continue
        name = SAFE_NAME.sub("_", Path(out.get("filename") or "output.bin").name)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(base64.b64decode(out.pop("base64")))
        out["filename"], out["url"] = name, f"/api/files/{jid}/{name}"
    return output


def file_path(jid: str, name: str) -> Path | None:
    if SAFE_NAME.search(jid) or SAFE_NAME.search(name) or name.startswith("."):
        return None
    path = files_dir() / jid / name
    return path if path.is_file() else None
