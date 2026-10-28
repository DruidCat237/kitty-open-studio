#!/usr/bin/env python3
"""Generic Kitty Open Studio job handler for ComfyUI (Runpod serverless or local).

Job input:
  {"workflow": "fasth3-omni",                      # id from workflows/index.json
   "inputs": {"prompt": "...", "picture1": "https://...png", "duration": 5, "seed": -1}}

Media inputs accept an http(s) URL, an s3://bucket/key URL, a data: URI, or
{"base64": "...", "filename": "x.png"}. Every file is uploaded to ComfyUI through
its own HTTP API, so the handler also works against a ComfyUI on another machine.

Other actions:
  {"action": "health"}           ComfyUI reachable? GPU, VRAM, missing models per workflow
  {"action": "list_workflows"}   ids, titles, inputs of every workflow
  {"workflow_json": {...}}       run a raw API graph (advanced; no input map)

"profile": "open-weights" (or KITTY_PROFILE) hides the NVIDIA RTX cards and turns RTX Video Super Resolution inside
other workflows into a lanczos resize; the same swap happens on a worker without nvidia-vfx, with a warning.

Output: {"outputs": [{"node", "filename", "type", "url" | "base64"}], "seed", "workflow", "timing"}
OUTPUT_MODE=s3 uploads to S3_BUCKET and returns presigned URLs; base64 returns the bytes inline.

Local test without Runpod:  python handler.py --local '{"workflow": "simple-upscale", "inputs": {"image": "..."}}'
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import mimetypes
import os
import struct
import sys
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path
from urllib.parse import urlencode, urlparse

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cleanup  # noqa: E402
from workflow_patch import RTX_VSR, InputError, build_prompt, estimate_seconds, media_specs, replace_rtx_upscale  # noqa: E402

BACKEND_DIR = Path(os.environ.get("KITTY_BACKEND_DIR") or Path(__file__).resolve().parents[1])
COMFY_URL = os.environ.get("COMFY_URL") or f"http://127.0.0.1:{os.environ.get('COMFY_PORT', '3020')}"
MODELS_DIR = os.environ.get("MODELS_DIR") or "/workspace/ComfyUI/models"
GPU_PROFILE = os.environ.get("GPU_PROFILE") or "48gb"
OUTPUT_MODE = (os.environ.get("OUTPUT_MODE") or "base64").lower()
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT") or 5400)
STARTUP_TIMEOUT = int(os.environ.get("COMFY_STARTUP_TIMEOUT") or 600)
PROFILE = os.environ.get("KITTY_PROFILE") or "all"
MAX_INPUT_BYTES = int(os.environ.get("MAX_INPUT_MB") or 2048) * 1024 * 1024
BASE64_WARN_BYTES = 15 * 1024 * 1024


def log(msg: str, level: str = "INFO") -> None:
    print(f"[{time.strftime('%H:%M:%S')}] [{level}] {msg}", flush=True)


class JobError(Exception):
    """Shown to the user as is: say what went wrong and what to do."""


# --------------------------------------------------------------------------- manifests
def load_index() -> dict[str, dict]:
    data = json.loads((BACKEND_DIR / "workflows" / "index.json").read_text(encoding="utf-8"))
    return {w["id"]: w for w in data["workflows"]}


def load_profile(profile_id: str | None) -> dict:
    """A profile from index.json ("all", "open-weights"); unknown ids are an input error."""
    pid = profile_id or PROFILE
    profiles = json.loads((BACKEND_DIR / "workflows" / "index.json").read_text(encoding="utf-8")).get("profiles", [])
    for p in profiles:
        if p["id"] == pid:
            return p
    raise JobError(f"unknown profile '{pid}'. Valid: {', '.join(p['id'] for p in profiles)}")


def excluded(entry: dict, profile: dict) -> bool:
    return bool(set(entry.get("badges", [])) & set(profile.get("exclude_badges", [])))


def load_models() -> list[dict]:
    return json.loads((BACKEND_DIR / "models.json").read_text(encoding="utf-8"))["models"]


def load_api(entry: dict) -> dict:
    return json.loads((BACKEND_DIR / "workflows" / entry["api"]).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- ComfyUI client
class Comfy:
    def __init__(self, base: str = COMFY_URL):
        self.base = base.rstrip("/")
        self.http = requests.Session()
        self.nodes: dict[str, bool] = {}

    def wait_ready(self, timeout: int = STARTUP_TIMEOUT) -> dict:
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            try:
                r = self.http.get(f"{self.base}/system_stats", timeout=5)
                if r.ok:
                    return r.json()
                last = f"HTTP {r.status_code}"
            except requests.RequestException as e:
                last = type(e).__name__
            time.sleep(2)
        raise JobError(f"ComfyUI not reachable at {self.base} ({last}). Check COMFY_URL / COMFY_PORT and the ComfyUI log.")

    def has_node(self, class_type: str) -> bool:
        """Is this node class loaded in ComfyUI? (/object_info/<class> is empty when it is not.)"""
        if class_type not in self.nodes:
            try:
                r = self.http.get(f"{self.base}/object_info/{class_type}", timeout=30)
                self.nodes[class_type] = r.ok and class_type in r.json()
            except (requests.RequestException, ValueError):
                return True  # unknown: let ComfyUI's own validation answer
        return self.nodes[class_type]

    def upload(self, data: bytes, filename: str) -> str:
        files = {"image": (filename, data, mimetypes.guess_type(filename)[0] or "application/octet-stream")}
        r = self.http.post(f"{self.base}/upload/image", files=files, data={"overwrite": "true"}, timeout=600)
        if not r.ok:
            raise JobError(f"uploading {filename} to ComfyUI failed (HTTP {r.status_code}: {r.text[:200]})")
        body = r.json()
        return f"{body['subfolder']}/{body['name']}" if body.get("subfolder") else body["name"]

    def queue(self, prompt: dict, client_id: str) -> str:
        r = self.http.post(f"{self.base}/prompt", json={"prompt": prompt, "client_id": client_id}, timeout=60)
        if not r.ok:
            raise JobError(describe_rejection(r, prompt))
        body = r.json()
        if body.get("node_errors"):
            # ComfyUI still queues the outputs that passed validation; without the broken ones the job is useless
            self.http.post(f"{self.base}/queue", json={"delete": [body["prompt_id"]]}, timeout=30)
            raise JobError(describe_rejection(r, prompt))
        return body["prompt_id"]

    def wait(self, prompt_id: str, timeout: int = JOB_TIMEOUT) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.http.get(f"{self.base}/history/{prompt_id}", timeout=30)
            if r.ok:
                entry = r.json().get(prompt_id)
                if entry is not None:
                    status = entry.get("status") or {}
                    if status.get("status_str") == "error":
                        raise JobError(describe_execution_error(status))
                    if status.get("completed", True):
                        return entry
            time.sleep(1.5)
        self.http.post(f"{self.base}/interrupt", timeout=10)
        raise JobError(f"timed out after {timeout} s; the job was interrupted. Raise JOB_TIMEOUT for long renders.")

    def watch(self, client_id: str, prompt: dict, report=None) -> "ProgressLog":
        """Start logging this client's progress events; call before queue() so the first node is not missed."""
        watcher = ProgressLog(self.base, client_id, prompt, report)
        watcher.start()
        return watcher

    def view(self, item: dict) -> bytes:
        params = {"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
        r = self.http.get(f"{self.base}/view", params=params, timeout=600)
        if not r.ok:
            raise JobError(f"could not read output {item['filename']} from ComfyUI (HTTP {r.status_code})")
        return r.content


class ProgressLog:
    """Logs ComfyUI's progress from its websocket while a job runs.

    ComfyUI draws its step bars with carriage returns, so the worker log stays silent for the whole sampling
    otherwise. Logs each node as it starts and its steps every 10 % (at most every 15 s), and hands the same line
    to `report` (Runpod's progress_update). Best effort: without the websockets package or a socket it does nothing.
    """

    def __init__(self, base: str, client_id: str, prompt: dict, report=None):
        self.url = base.replace("http", "ws", 1) + f"/ws?clientId={client_id}"
        self.classes = {str(k): v.get("class_type", "?") for k, v in prompt.items() if isinstance(v, dict)}
        self.report = report
        self.prompt_id: str | None = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.last_report = 0.0

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.done.set()

    def say(self, line: str) -> None:
        log(line)
        if self.report and time.time() - self.last_report >= 5:
            self.last_report = time.time()
            try:
                self.report(line)
            except Exception:  # progress is cosmetic; never fail a job over it
                pass

    def run(self) -> None:
        try:
            from websockets.sync.client import connect
        except ImportError:
            return
        node, last_pct, last_t = None, -10, 0.0
        try:
            with connect(self.url, open_timeout=10, max_size=None) as ws:
                while not self.done.is_set():
                    try:
                        msg = ws.recv(timeout=1)
                    except TimeoutError:
                        continue
                    if isinstance(msg, bytes):  # preview images
                        continue
                    event = json.loads(msg)
                    data = event.get("data") or {}
                    if self.prompt_id and data.get("prompt_id") not in (None, self.prompt_id):
                        continue
                    if event.get("type") == "executing" and data.get("node"):
                        node, last_pct = str(data["node"]), -10
                        self.say(f"node {node} {self.classes.get(node, '?')}")
                    elif event.get("type") == "progress" and data.get("max"):
                        value, total = int(data.get("value", 0)), int(data["max"])
                        pct = value * 100 // total
                        if pct >= last_pct + 10 or value == total or time.time() - last_t >= 15:
                            last_pct, last_t = pct, time.time()
                            name = self.classes.get(str(data.get("node") or node), "?")
                            self.say(f"{name}: {value}/{total} ({pct} %)")
        except Exception as e:  # closed socket, ComfyUI restart, ...: the job itself carries on
            if not self.done.is_set() and type(e).__name__ != "ConnectionClosedOK":
                log(f"progress log stopped: {type(e).__name__}", "WARN")


def describe_rejection(resp: requests.Response, prompt: dict) -> str:
    try:
        err = resp.json()
    except ValueError:
        return f"ComfyUI rejected the workflow (HTTP {resp.status_code}): {resp.text[:300]}"
    lines = []
    for nid, ne in (err.get("node_errors") or {}).items():
        cls = prompt.get(nid, {}).get("class_type", ne.get("class_type", "?"))
        for d in ne.get("errors") or []:
            extra = d.get("extra_info") or {}
            value = extra.get("received_value")
            if d.get("type") == "value_not_in_list" and isinstance(value, str) and "." in value[-14:]:
                lines.append(f"model file missing: {value} (node {nid} {cls}). Install it with the model installer "
                             f"(port 7861) or: python installer/cli.py --workflows <this workflow>")
            else:
                lines.append(f"node {nid} {cls}: {d.get('message', '')} {d.get('details', '')}".strip())
    if not lines:
        top = err.get("error") or {}
        if isinstance(top, dict) and top.get("type") == "invalid_prompt" and "missing_node_type" in json.dumps(top):
            return f"a custom node is missing: {top.get('message')}. Rebuild the image or add it with CUSTOM_NODES."
        lines.append(top.get("message", str(top)) if isinstance(top, dict) else str(top))
    return "ComfyUI rejected the workflow: " + "; ".join(lines)


def describe_execution_error(status: dict) -> str:
    for message in status.get("messages") or []:
        if isinstance(message, (list, tuple)) and len(message) >= 2 and message[0] == "execution_error":
            info = message[1] if isinstance(message[1], dict) else {}
            node = info.get("node_type") or info.get("node_id") or "a node"
            exc = str(info.get("exception_message") or info.get("exception_type") or "").strip()
            tb = info.get("traceback")
            if isinstance(tb, list) and tb:
                log("ComfyUI traceback: " + " | ".join(str(t).strip() for t in tb[-4:]), "ERROR")
            hint = ""
            if "out of memory" in exc.lower() or "allocation on device" in exc.lower():
                hint = " The GPU ran out of memory: lower the resolution or duration, or set GPU_PROFILE=24gb."
            return f"{node} failed: {exc}{hint}"
    return "the workflow failed inside ComfyUI (see the worker log)"


# --------------------------------------------------------------------------- media
def fetch_media(value, key: str) -> tuple[bytes, str]:
    """Return (bytes, filename) for a URL, s3:// URL, data: URI or {"base64": ...}."""
    if isinstance(value, dict):
        if "url" in value:
            return fetch_media(value["url"], key)
        if "base64" in value:
            try:
                data = base64.b64decode(value["base64"], validate=False)
            except (binascii.Error, ValueError) as e:
                raise JobError(f"'{key}': invalid base64") from e
            return data, value.get("filename") or f"{key}.bin"
        raise JobError(f"'{key}': expected a URL or {{'base64': ...}}")
    if not isinstance(value, str) or not value:
        raise JobError(f"'{key}': expected a URL or a data: URI")
    if value.startswith("data:"):
        header, _, payload = value.partition(",")
        ext = mimetypes.guess_extension(header[5:].split(";")[0]) or ".bin"
        try:
            return base64.b64decode(payload), f"{key}{ext}"
        except (binascii.Error, ValueError) as e:
            raise JobError(f"'{key}': invalid data URI") from e
    parsed = urlparse(value)
    name = Path(parsed.path).name or key
    if parsed.scheme == "s3":
        buf = io.BytesIO()
        s3_client().download_fileobj(parsed.netloc, parsed.path.lstrip("/"), buf)
        return buf.getvalue(), name
    if parsed.scheme in ("http", "https"):
        with requests.get(value, stream=True, timeout=120) as r:
            if not r.ok:
                raise JobError(f"'{key}': download failed (HTTP {r.status_code}) from {parsed.netloc}")
            chunks, size = [], 0
            for chunk in r.iter_content(1 << 20):
                size += len(chunk)
                if size > MAX_INPUT_BYTES:
                    raise JobError(f"'{key}': file is larger than {MAX_INPUT_BYTES >> 20} MB")
                chunks.append(chunk)
            return b"".join(chunks), name
    raise JobError(f"'{key}': unsupported location {value[:60]!r} (use https://, s3:// or data:)")


def image_size(data: bytes) -> tuple[int, int] | None:
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            return im.size
    except Exception:  # noqa: BLE001 - size is only a hint
        return None


def video_size(data: bytes) -> tuple[int, int] | None:
    """Display size of a video (rotation applied), from ffprobe; None when unknown."""
    try:
        import subprocess

        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            f.write(data)
            f.flush()
            out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-of", "json", "-show_entries",
                                  "stream=width,height:stream_side_data=rotation", f.name],
                                 capture_output=True, text=True, timeout=60).stdout
        stream = json.loads(out)["streams"][0]
        w, h = int(stream["width"]), int(stream["height"])
        rotation = next((int(d["rotation"]) for d in stream.get("side_data_list", []) if "rotation" in d), 0)
        return (h, w) if abs(rotation) % 180 == 90 else (w, h)
    except Exception:  # noqa: BLE001 - size is only a hint
        return None


def has_transparency(data: bytes) -> bool | None:
    """False when the picture is fully opaque (an inpaint mask from it would be empty); None when unknown."""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            if im.mode not in ("RGBA", "LA", "PA") and "transparency" not in im.info:
                return False
            return im.convert("RGBA").getchannel("A").getextrema()[0] < 255
    except Exception:  # noqa: BLE001 - let ComfyUI decide
        return None


def silent_wav(seconds: float) -> bytes:
    rate = 44100
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 0) * int(rate * max(1.0, seconds)))
    return buf.getvalue()


# --------------------------------------------------------------------------- outputs
_s3 = None


def s3_client():
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client(
            "s3",
            endpoint_url=os.environ.get("S3_ENDPOINT") or None,
            region_name=os.environ.get("S3_REGION") or None,
            aws_access_key_id=os.environ.get("S3_ACCESS_KEY") or None,
            aws_secret_access_key=os.environ.get("S3_SECRET_KEY") or None,
        )
    return _s3


def presign_supported() -> bool:
    """S3_PRESIGN=1/0 forces it; by default every store but Runpod's network-volume S3 (no presigned GETs)."""
    forced = (os.environ.get("S3_PRESIGN") or "").lower()
    if forced in ("1", "true", "yes", "0", "false", "no"):
        return forced in ("1", "true", "yes")
    return not (urlparse(os.environ.get("S3_ENDPOINT") or "").hostname or "").endswith(".runpod.io")


def deliver(data: bytes, filename: str, job_id: str) -> dict:
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if OUTPUT_MODE == "s3":
        bucket = os.environ.get("S3_BUCKET")
        if not bucket:
            raise JobError("OUTPUT_MODE=s3 but S3_BUCKET is not set (see docs/s3.md)")
        key = f"{(os.environ.get('S3_PREFIX') or 'outputs').strip('/')}/{job_id}/{filename}"
        s3_client().put_object(Bucket=bucket, Key=key, Body=data, ContentType=mime)
        public = os.environ.get("S3_PUBLIC_URL")
        if public:
            url = f"{public.rstrip('/')}/{key}"
        elif not presign_supported():
            # Runpod's volume S3 answers presigned links with 403: hand back where the file is and let the app fetch
            # it with its own S3 keys (header-signed requests work)
            url = f"s3://{bucket}/{key}?" + urlencode({"endpoint": os.environ.get("S3_ENDPOINT", ""),
                                                        "region": os.environ.get("S3_REGION", "")})
        else:
            url = s3_client().generate_presigned_url(
                "get_object", Params={"Bucket": bucket, "Key": key},
                ExpiresIn=int(os.environ.get("S3_PRESIGN_SECONDS") or 7 * 24 * 3600))
        return {"filename": filename, "type": mime, "url": url, "s3_key": key, "bytes": len(data)}
    if len(data) > BASE64_WARN_BYTES:
        log(f"{filename} is {len(data) >> 20} MB as base64; Runpod caps job results, set OUTPUT_MODE=s3", "WARN")
    return {"filename": filename, "type": mime, "base64": base64.b64encode(data).decode(), "bytes": len(data)}


def start_cleanup() -> None:
    """Files older than RETENTION_DAYS (3) go, checked when someone generates (docker/cleanup.py)."""
    try:
        s3 = s3_client() if OUTPUT_MODE == "s3" and os.environ.get("S3_BUCKET") else None
        cleanup.clean_old_files(s3=s3, log=log)
    except Exception as e:  # noqa: BLE001 - never fail a job over housekeeping
        log(f"cleanup skipped: {e}", "WARN")


def collect_outputs(comfy: Comfy, history: dict, wanted: list[str], job_id: str) -> list[dict]:
    outputs = history.get("outputs") or {}
    order = [n for n in wanted if n in outputs] or list(outputs)
    results = []
    for nid in order:
        for kind in ("videos", "gifs", "images", "audio"):
            for item in outputs[nid].get(kind) or []:
                if not isinstance(item, dict) or "filename" not in item:
                    continue
                if item.get("type") == "temp" and nid not in wanted:
                    continue
                data = comfy.view(item)
                results.append({"node": nid, **deliver(data, item["filename"], job_id)})
    if not results:
        raise JobError("the workflow finished but produced no file (check the output nodes in the index)")
    return results


# --------------------------------------------------------------------------- actions
def missing_models(entry: dict, models: dict[str, dict]) -> list[str]:
    out = []
    for mid in entry.get("models", []):
        m = models.get(mid)
        if not m or m.get("auto_download"):
            continue
        v = (m.get("variants") or {}).get(GPU_PROFILE) or {}
        fname = v.get("filename") or m["filename"]
        if not (Path(MODELS_DIR) / m["folder"] / fname).is_file():
            out.append(fname)
    return out


def action_health(comfy: Comfy) -> dict:
    stats = comfy.wait_ready(timeout=30)
    models = {m["id"]: m for m in load_models()}
    devices = stats.get("devices") or [{}]
    ready, missing = [], {}
    local = Path(MODELS_DIR).is_dir()
    for wf in load_index().values():
        miss = missing_models(wf, models) if local else []
        (missing.__setitem__(wf["id"], miss) if miss else ready.append(wf["id"]))
    return {"comfyui": "ok", "comfyui_version": (stats.get("system") or {}).get("comfyui_version"),
            "gpu": devices[0].get("name"), "vram_gb": round((devices[0].get("vram_total") or 0) / 1e9, 1),
            "gpu_profile": GPU_PROFILE, "models_dir": MODELS_DIR if local else None,
            "ready_workflows": ready, "missing_models": missing}


def action_list(profile: dict) -> dict:
    return {"profile": profile["id"],
            "workflows": [{k: w.get(k) for k in ("id", "title", "category", "summary", "inputs", "min_vram_gb",
                                                 "est_gpu_minutes", "prompt_tags", "badges", "status")}
                          for w in load_index().values() if not w.get("hidden") and not excluded(w, profile)]}


def apply_profile(prompt: dict, profile: dict, comfy: Comfy, warnings: list[str]) -> None:
    """Swap nodes the profile leaves out, or that this ComfyUI does not have (RTX VSR without nvidia-vfx)."""
    if not any(n.get("class_type") == RTX_VSR for n in prompt.values()):
        return
    if profile.get("replace_nodes", {}).get(RTX_VSR) == "lanczos":
        replace_rtx_upscale(prompt)
    elif not comfy.has_node(RTX_VSR):
        replace_rtx_upscale(prompt)
        warnings.append("NVIDIA RTX Video Super Resolution is not available on this worker (nvidia-vfx not installed "
                        "or no RTX GPU): upscaled with lanczos instead")


def run_job(job_input: dict, job_id: str, comfy: Comfy | None = None, report=None) -> dict:
    comfy = comfy or Comfy()
    t0 = time.time()
    action = job_input.get("action")
    profile = load_profile(job_input.get("profile"))
    if action == "list_workflows":
        return action_list(profile)
    if os.environ.get("KITTY_SETUP_ERROR"):  # start.sh: the volume has no ComfyUI / venv yet
        raise JobError(os.environ["KITTY_SETUP_ERROR"])
    start_cleanup()
    if action == "health":
        return action_health(comfy)

    if "workflow_json" in job_input:
        entry = {"id": "custom", "inputs": [], "outputs": {"nodes": []}}
        prompt, info = job_input["workflow_json"], {"workflow": "custom", "warnings": []}
    else:
        index = load_index()
        wf_id = job_input.get("workflow")
        if wf_id not in index:
            raise JobError(f"unknown workflow '{wf_id}'. Valid ids: {', '.join(sorted(index))}")
        entry = index[wf_id]
        if entry.get("status") == "ui-only":
            raise JobError(f"'{wf_id}' needs interactive steps in the ComfyUI UI and cannot run as a job")
        if excluded(entry, profile):
            raise JobError(f"'{wf_id}' is not part of the '{profile['title']}' profile")
        inputs = job_input.get("inputs") or {}
        comfy.wait_ready()
        media, sizes = {}, {}
        for spec in media_specs(entry):
            raw = inputs.get(spec["key"])
            if raw in (None, "", []):
                continue
            items = raw if spec["type"] == "image_list" and isinstance(raw, list) else [raw]
            names = []
            for i, item in enumerate(items):
                data, name = fetch_media(item, spec["key"])
                safe = f"{job_id[:12]}_{spec['key']}{i}{Path(name).suffix or '.bin'}"
                names.append(comfy.upload(data, safe))
                if spec.get("mask") == "alpha" and not inputs.get(spec.get("mask_alt", "")) and has_transparency(data) is False:
                    alt = f", or describe the area in '{spec['mask_alt']}'" if spec.get("mask_alt") else ""
                    raise JobError(f"'{spec['key']}' has no transparent area: make the part to repaint transparent "
                                   f"(a PNG with alpha){alt}")
                if spec["type"] in ("image", "video") and spec["key"] not in sizes:
                    size = image_size(data) if spec["type"] == "image" else video_size(data)
                    if size:
                        sizes[spec["key"]] = size
            media[spec["key"]] = names if spec["type"] == "image_list" else names[0]
        silence_cache: dict[int, str] = {}

        def silence(seconds: float) -> str:
            key = int(seconds + 0.999)
            if key not in silence_cache:
                silence_cache[key] = comfy.upload(silent_wav(key), f"kitty_silence_{key}s.wav")
            return silence_cache[key]

        try:
            prompt, info = build_prompt(entry, load_api(entry), inputs, media, models=load_models(), profile=GPU_PROFILE,
                                        job_id=job_id, media_size=sizes, silence=silence)
        except InputError as e:
            raise JobError(str(e)) from e
        log(f"{wf_id}: queued (est. {estimate_seconds(entry, inputs)} s GPU) seed={info.get('seed')} "
            f"variants={info.get('variants') or '-'}")

    comfy.wait_ready()
    apply_profile(prompt, profile, comfy, info["warnings"])
    t_queue = time.time()
    watcher = comfy.watch(job_id, prompt, report)
    try:
        prompt_id = comfy.queue(prompt, client_id=job_id)
        watcher.prompt_id = prompt_id
        history = comfy.wait(prompt_id)
    finally:
        watcher.stop()
    t_done = time.time()
    outputs = collect_outputs(comfy, history, [str(n) for n in entry.get("outputs", {}).get("nodes", [])], job_id)
    return {"workflow": info["workflow"], "outputs": outputs, "seed": info.get("seed"), "warnings": info["warnings"],
            "timing": {"prepare_s": round(t_queue - t0, 1), "comfyui_s": round(t_done - t_queue, 1),
                       "total_s": round(time.time() - t0, 1)}}


def handler(job: dict) -> dict:
    """Runpod entry point. Errors come back as {"error": "..."} with a readable message."""
    job_id = str(job.get("id") or uuid.uuid4())
    report = None
    if "runpod" in sys.modules:  # a real worker: the progress line also shows in the job's /status
        report = lambda line: sys.modules["runpod"].serverless.progress_update(job, line)  # noqa: E731
    try:
        return run_job(job.get("input") or {}, job_id, report=report)
    except (JobError, InputError) as e:
        log(str(e), "ERROR")
        return {"error": str(e)}
    except requests.ConnectionError:
        msg = f"ComfyUI not reachable at {COMFY_URL}: check the URL, or the worker log if ComfyUI crashed."
        log(msg, "ERROR")
        return {"error": msg}


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--local":
        payload = json.loads(Path(sys.argv[2]).read_text() if os.path.isfile(sys.argv[2]) else sys.argv[2])
        result = handler({"id": f"local-{uuid.uuid4().hex[:8]}", "input": payload})
        for out in result.get("outputs", []):
            if "base64" in out:
                dest = Path(tempfile.gettempdir()) / out["filename"]
                dest.write_bytes(base64.b64decode(out["base64"]))
                out["base64"] = f"<{out['bytes']} bytes saved to {dest}>"
        print(json.dumps(result, indent=2))
        return
    import runpod

    log(f"Kitty Open Studio handler: ComfyUI at {COMFY_URL}, GPU_PROFILE={GPU_PROFILE}, OUTPUT_MODE={OUTPUT_MODE}, "
        f"profile={PROFILE}")
    if os.environ.get("KITTY_SETUP_ERROR"):
        log(os.environ["KITTY_SETUP_ERROR"], "ERROR")  # every job gets this message until the volume is prepared
    else:
        try:
            Comfy().wait_ready()
            log("ComfyUI is ready")
        except JobError as e:
            log(f"{e} (will retry on the first job)", "WARN")
    runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
