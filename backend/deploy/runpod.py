#!/usr/bin/env python3
"""Run Kitty Open Studio on Runpod from a terminal or an AI assistant (see AGENTS.md at the repository root).

  python backend/deploy/runpod.py check
  python backend/deploy/runpod.py gpus --min-vram 48 [--datacenter EU-RO-1]
  python backend/deploy/runpod.py volume create --size 110 --datacenter EU-RO-1             # dry run; add --yes
  python backend/deploy/runpod.py pod create --volume <id> --gpu "NVIDIA GeForce RTX 5090" --preset starter
  python backend/deploy/runpod.py pod wait|status|progress|install|stop|start|delete <pod id>
  python backend/deploy/runpod.py endpoint create --volume <id> --gpu "NVIDIA GeForce RTX 5090"

Uses Runpod's REST API v2. RUNPOD_API_KEY (and HF_TOKEN for gated models, S3_* for serverless outputs) come
from the environment or from .env at the repository root and are never printed. Anything that costs money or
deletes something prints a dry run and acts only with --yes. --json prints machine-readable results.
Standard library only.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "installer"))
import core  # noqa: E402  (presets, size estimates, volume pricing)

API = os.environ.get("RUNPOD_API_URL", "https://api.runpod.io/v2")
QUEUE = os.environ.get("RUNPOD_QUEUE_URL", "https://api.runpod.ai/v2")  # jobs: /{endpoint}/run, /status, /health
PROXY = os.environ.get("RUNPOD_PROXY_URL", "https://{pod}-{port}.proxy.runpod.net")
IMAGE = "druidcat/kitty-open-studio:0.1.1"
PORTS = ["3020/http", "7861/http", "8888/http", "22/tcp"]
# The image runs on CUDA 12.8+ hosts; NVIDIA's RTX Video Super Resolution (nvidia-vfx, on by default) needs driver
# 570.190+ / 580.82+, which CUDA 13 hosts have.
CUDA = "13.0"
DISK_GB = 30
JOB_TIMEOUT_S = 5400
S3_KEYS = ("S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")
STOCK = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}


class Fail(Exception):
    """A problem the user can fix; the message says how."""


# --------------------------------------------------------------------------- settings and HTTP
def env_file(path: Path) -> dict[str, str]:
    out = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                out[key.removeprefix("export ").strip()] = value.strip().strip("\"'")
    return out


def setting(name: str) -> str:
    return os.environ.get(name) or env_file(ROOT / ".env").get(name, "")


def problem(raw: bytes) -> str:
    """Runpod v2 errors are RFC 9457 problem documents: {title, status, detail, errors?}."""
    try:
        p = json.loads(raw)
    except ValueError:
        return raw.decode(errors="replace")[:300]
    if not isinstance(p, dict):
        return str(p)[:300]
    return "; ".join(str(x) for x in [p.get("title"), p.get("detail"), *(p.get("errors") or [])] if x)[:600]


def http(method: str, url: str, body=None, headers: dict | None = None, timeout: float = 60, retry: bool = True):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "kitty-open-studio",
                                          **(headers or {})})
    where = f"{method} {url.split('?')[0]}"
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 429 and retry:  # rate limit: wait as told, once
            time.sleep(min(int(e.headers.get("Retry-After") or 5), 60))
            return http(method, url, body, headers, timeout, retry=False)
        raise Fail(f"{where}: HTTP {e.code} {problem(e.read())}") from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise Fail(f"{where}: {getattr(e, 'reason', e)}") from None
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"message": raw.decode(errors="replace")[:300]}


class Runpod:
    def __init__(self, key: str):
        if not key:
            raise Fail("RUNPOD_API_KEY is not set. Create a key at runpod.io > Settings > API Keys (read/write) and "
                       "put RUNPOD_API_KEY=... into .env at the repository root (never into the chat).")
        self.headers = {"Authorization": f"Bearer {key}"}

    def call(self, method: str, path: str, body=None, **query):
        params = {k: v for k, v in query.items() if v is not None}
        return http(method, API + path + ("?" + urllib.parse.urlencode(params) if params else ""), body, self.headers)


def proxy(pod_id: str, port: int) -> str:
    return PROXY.format(pod=pod_id, port=port)


def installer(pod_id: str, method: str, path: str, body=None, timeout: float = 30):
    return http(method, proxy(pod_id, 7861) + path, body, timeout=timeout)


# --------------------------------------------------------------------------- catalog
def gpu_catalog(rp: Runpod, product: str = "POD") -> list[dict]:
    """GPU types on CUDA 13 hosts (driver for RTX Video Super Resolution), with Secure Cloud price and stock."""
    return rp.call("GET", "/catalog/gpus", include="AVAILABILITY", product=product, cloud="SECURE",
                   minCudaVersion=CUDA).get("gpus") or []


def volume_datacenters(rp: Runpod) -> set[str]:
    data = rp.call("GET", "/catalog/datacenters").get("dataCenters") or []
    return {d["id"] for d in data if d.get("networkVolumeTypes")}


def find_gpu(rp: Runpod, gpu_id: str, product: str = "POD") -> dict:
    for g in gpu_catalog(rp, product):
        if g.get("id") == gpu_id:
            return g
    raise Fail(f"GPU '{gpu_id}' is not offered on CUDA 13 Secure Cloud right now; pick one from `gpus`")


def volume_by_id(rp: Runpod, volume_id: str) -> dict:
    for v in rp.call("GET", "/network-volumes").get("networkVolumes") or []:
        if v.get("id") == volume_id:
            return v
    raise Fail(f"network volume '{volume_id}' not found; `check` lists yours")


# --------------------------------------------------------------------------- summaries
def pod_summary(p: dict) -> dict:
    pid = p.get("id", "")
    network = ((p.get("mounts") or {}).get("network") or [{}])[0]
    return {"id": pid, "name": p.get("name"), "status": p.get("status"), "gpu": (p.get("gpu") or {}).get("id"),
            "usd_per_hour": p.get("cost"), "datacenter": p.get("dataCenterId"), "volume": network.get("volumeId"),
            "image": p.get("image"), "comfyui": proxy(pid, 3020), "installer": proxy(pid, 7861)}


def volume_summary(v: dict) -> dict:
    return {"id": v.get("id"), "name": v.get("name"), "size_gb": v.get("size"), "datacenter": v.get("dataCenter"),
            "usd_per_month": core.monthly_cost(v.get("size") or 0)}


# --------------------------------------------------------------------------- commands
def cmd_check(rp: Runpod, args) -> dict:
    pods = rp.call("GET", "/pods").get("pods") or []
    volumes = rp.call("GET", "/network-volumes").get("networkVolumes") or []
    return {"ok": True, "pods": [pod_summary(p) for p in pods], "volumes": [volume_summary(v) for v in volumes]}


def cmd_gpus(rp: Runpod, args) -> dict:
    with_volumes = volume_datacenters(rp)
    rows = []
    for g in gpu_catalog(rp):
        price = (g.get("price") or {}).get("secure")
        if not g.get("secure") or not price or (g.get("memory") or 0) < args.min_vram:
            continue
        dcs = [d for d in g.get("dataCenters") or [] if d.get("availability") in STOCK and d.get("id") in with_volumes]
        if args.datacenter:
            dcs = [d for d in dcs if d.get("id") == args.datacenter]
            if not dcs:
                continue
        dcs.sort(key=lambda d: STOCK[d["availability"]])
        rows.append({"id": g["id"], "name": g.get("name"), "vram_gb": g.get("memory"), "usd_per_hour": price,
                     "stock": g.get("availability"),
                     "datacenters": [f"{d['id']} ({d['availability'].lower()})" for d in dcs][:6]})
    rows.sort(key=lambda r: (not r["datacenters"], r["usd_per_hour"]))
    return {"min_vram_gb": args.min_vram, "gpus": rows,
            "note": "Secure Cloud, CUDA 13 hosts, data centers with network volumes; prices per GPU per hour"}


def cmd_volume_create(rp: Runpod, args) -> dict:
    if not 10 <= args.size <= 4096:
        raise Fail("--size must be 10-4096 GB")
    plan = {"action": "create a network volume", "name": args.name, "size_gb": args.size,
            "datacenter": args.datacenter, "usd_per_month": core.monthly_cost(args.size),
            "billing": "per month while the volume exists, even when no pod runs"}
    if not args.yes:
        return {"dry_run": True, **plan}
    volume = rp.call("POST", "/network-volumes", {"name": args.name, "size": args.size, "dataCenter": args.datacenter})
    return {"created": True, **plan, "volume": volume_summary(volume)}


def pod_request(args, datacenter: str) -> dict:
    env = {"MODE": "pod", "GPU_PROFILE": args.gpu_profile, "ATTENTION": args.attention}
    if args.preset:
        env["INSTALL_PRESET"] = args.preset
    if args.workflows:
        env["INSTALL_WORKFLOWS"] = args.workflows
    if setting("HF_TOKEN"):
        env["HF_TOKEN"] = setting("HF_TOKEN")
    return {"name": args.name, "image": args.image, "cloud": "SECURE",
            "gpu": {"id": args.gpu, "count": 1, "allowedCudaVersions": [CUDA]},
            "dataCenterIds": [datacenter], "mounts": {"network": [{"volumeId": args.volume, "path": "/workspace"}]},
            "disk": DISK_GB, "ports": PORTS, "env": env, "startSsh": args.ssh}


def cmd_pod_create(rp: Runpod, args) -> dict:
    if args.preset:
        core.Catalog.load().preset(args.preset)  # unknown preset: fail before spending anything
    volume = volume_by_id(rp, args.volume)
    gpu = find_gpu(rp, args.gpu)
    stock = {d.get("id"): d.get("availability") for d in gpu.get("dataCenters") or []}
    body = pod_request(args, volume["dataCenter"])
    plan = {"action": "create a pod", "gpu": args.gpu, "usd_per_hour": (gpu.get("price") or {}).get("secure"),
            "datacenter": volume["dataCenter"], "gpu_stock_there": stock.get(volume["dataCenter"], "NONE"),
            "volume": args.volume, "image": args.image,
            "installs": args.preset or args.workflows or "nothing (use the installer page)",
            "hf_token": "from .env" if "HF_TOKEN" in body["env"] else "not set",
            "billing": "per second while the pod runs; stop it when you are done"}
    if not args.yes:
        return {"dry_run": True, **plan}
    token = None
    if args.jupyter:
        token = secrets.token_urlsafe(18)
        body["env"]["JUPYTER_PASSWORD"] = token
    try:
        pod = rp.call("POST", "/pods", body)
    except Fail as e:
        if "HTTP 400" in str(e):
            raise Fail(f"{e}\nNo {args.gpu} may be free in {volume['dataCenter']} right now: try "
                       f"`gpus --datacenter {volume['dataCenter']}` for another GPU there, or try again later.") from None
        raise
    out = {"created": True, **plan, "pod": pod_summary(pod)}
    if token:
        out["jupyter"] = f"{proxy(pod.get('id', ''), 8888)}/lab?token={token}"
    return out


def pod_running(rp: Runpod, pod_id: str) -> bool:
    status = rp.call("GET", f"/pods/{pod_id}").get("status")
    if status in ("ERROR", "TERMINATED", "EXITED"):
        raise Fail(f"the pod is {status}; see its logs in the Runpod console (or `pod start` if it was stopped)")
    return status == "RUNNING"


def volume_ready(pod: str) -> bool:
    """The pod's first start prepares ComfyUI, the node packs and the venv on the volume (setup_volume.py)."""
    s = installer(pod, "GET", "/api/status", timeout=20)
    setup = s.get("setup") or {}
    if setup.get("state") == "error":
        raise Fail(f"the volume setup failed: {setup.get('message') or setup.get('step')}; "
                   "the pod log and /workspace/kitty/logs/setup.log have the details, restarting the pod retries")
    return setup.get("state") == "done" and bool((s.get("comfyui") or {}).get("ok"))


def cmd_pod_wait(rp: Runpod, args) -> dict:
    deadline = time.time() + args.timeout
    steps = [(lambda: pod_running(rp, args.pod), "the pod to start", False),
             (lambda: installer(args.pod, "GET", "/api/health", timeout=10).get("ok"),
              "the installer (the first start pulls the image: a few minutes)", True),
             (lambda: volume_ready(args.pod),
              "ComfyUI (a new volume gets ComfyUI, the node packs and the venv first: 30-60 minutes on a Runpod network volume)", "setup")]
    for check, what, tolerate_errors in steps:
        while True:
            try:
                if check():
                    break
                last = "not ready yet"
            except Fail as e:
                # the pod failed or was stopped, or the volume setup failed: no point waiting
                if not tolerate_errors or (tolerate_errors == "setup" and "setup failed" in str(e)):
                    raise
                last = str(e)
            if time.time() > deadline:
                raise Fail(f"timed out waiting for {what} ({last}); check the pod's logs in the Runpod console")
            if not args.json:
                print(f"  waiting for {what}...", file=sys.stderr, flush=True)
            time.sleep(args.every)
    return cmd_pod_status(rp, args)


def cmd_pod_status(rp: Runpod, args) -> dict:
    out = {"pod": pod_summary(rp.call("GET", f"/pods/{args.pod}"))}
    try:
        s = installer(args.pod, "GET", "/api/status")
    except Fail as e:
        out["installer"] = f"not reachable yet: {e}"
        return out
    job, setup = s.get("install") or {}, s.get("setup") or {}
    out.update({"setup": {k: setup.get(k) for k in ("state", "step", "message", "warnings")},
                "comfyui_ready": (s.get("comfyui") or {}).get("ok"), "gpu": (s.get("comfyui") or {}).get("gpu"),
                "free_gb": None if s.get("free_bytes") is None else round(s["free_bytes"] / 1e9, 1), "ready_workflows": s.get("ready_workflows"),
                "missing": {k: len(v) for k, v in (s.get("missing_models") or {}).items()},
                "install": {"state": job.get("state"), "message": job.get("message"),
                            "done_gb": round((job.get("done") or 0) / 1e9, 1), "total_gb": round((job.get("total") or 0) / 1e9, 1)}})
    return out


def cmd_pod_progress(rp, args) -> dict:
    while True:
        p = installer(args.pod, "GET", "/api/progress")
        current = next((f for f in p.get("files", []) if f.get("status") == "downloading"), None)
        line = {"state": p.get("state"), "message": p.get("message"),
                "done_gb": round((p.get("done") or 0) / 1e9, 1), "total_gb": round((p.get("total") or 0) / 1e9, 1),
                "current": current and current.get("filename"),
                "errors": [f"{f['filename']}: {f.get('message')}" for f in p.get("files", []) if f.get("status") == "error"]}
        if not args.follow or p.get("state") != "running":
            return line
        if not args.json:
            print(f"  {line['done_gb']} / {line['total_gb']} GB  {line['current'] or ''}", file=sys.stderr, flush=True)
        time.sleep(args.every)


def selection(args) -> dict:
    sel = {"gpu_profile": args.gpu_profile}
    if args.preset:
        sel["preset"] = args.preset
    if args.workflows:
        sel["workflows"] = [w.strip() for w in args.workflows.split(",") if w.strip()]
    if len(sel) == 1:
        raise Fail("choose --preset or --workflows")
    return sel


def cmd_pod_install(rp, args) -> dict:
    sel = selection(args)
    est = installer(args.pod, "POST", "/api/estimate", sel)
    plan = {"action": "install models on the pod", **sel, "files": est.get("count"), "download_gb": est.get("to_download_gb"),
            "total_gb": est.get("total_gb"), "needs_hf_token": est.get("needs_hf_token")}
    if not args.yes:
        return {"dry_run": True, **plan}
    return {"started": True, **plan, **installer(args.pod, "POST", "/api/install", sel)}


def cmd_pod_power(rp: Runpod, args) -> dict:
    if args.action == "delete":
        if not args.yes:
            return {"dry_run": True, "action": f"delete pod {args.pod}",
                    "note": "the network volume and its models stay; the pod's own disk is lost"}
        rp.call("DELETE", f"/pods/{args.pod}")
        return {"ok": True, "action": "delete", "pod": args.pod}
    pod = rp.call("POST", f"/pods/{args.pod}/action", {"action": args.action})
    return {"ok": True, "action": args.action, "pod": pod_summary(pod) if pod.get("id") else args.pod}


def cmd_endpoint_create(rp: Runpod, args) -> dict:
    volume = volume_by_id(rp, args.volume)
    gpu = find_gpu(rp, args.gpu, product="SERVERLESS")
    if not gpu.get("pool"):
        raise Fail(f"{args.gpu} is not offered for serverless; pick another GPU from `gpus`")
    env = {"MODE": "serverless", "GPU_PROFILE": args.gpu_profile, "JOB_TIMEOUT": str(JOB_TIMEOUT_S)}
    if all(setting(k) for k in ("S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY")):
        env.update({"OUTPUT_MODE": "s3", **{k: setting(k) for k in S3_KEYS if setting(k)}})
    else:
        env["OUTPUT_MODE"] = "base64"
    if setting("HF_TOKEN"):
        env["HF_TOKEN"] = setting("HF_TOKEN")
    plan = {"action": "create a serverless endpoint", "gpu": args.gpu, "pool": gpu["pool"],
            "usd_per_hour_while_working": (gpu.get("price") or {}).get("serverless"), "datacenter": volume["dataCenter"],
            "volume": args.volume, "image": args.image, "workers_max": args.workers_max,
            "outputs": env["OUTPUT_MODE"] + (" (S3 settings from .env)" if env["OUTPUT_MODE"] == "s3" else ""),
            "billing": "per second while a worker runs or idles; no workers (and no cost) while there are no jobs"}
    if not args.yes:
        return {"dry_run": True, **plan}
    endpoint = rp.call("POST", "/serverless", {
        "name": args.name, "type": "QUEUE", "image": args.image, "env": env, "disk": DISK_GB,
        "gpu": {"pools": [gpu["pool"]], "count": 1, "allowedCudaVersions": [CUDA]},
        "workers": {"min": 0, "max": args.workers_max, "idleTimeout": args.idle},
        "scaling": {"type": "QUEUE_DELAY", "queueDelay": 4}, "timeout": (JOB_TIMEOUT_S + 300) * 1000,
        "flashboot": "FLASHBOOT", "dataCenterIds": [volume["dataCenter"]],
        "mounts": {"network": [{"volumeId": args.volume}]}})
    eid = endpoint.get("id")
    urls = endpoint.get("requestUrls") if isinstance(endpoint.get("requestUrls"), dict) else {}
    return {"created": True, **plan, "endpoint_id": eid,
            "runsync": urls.get("runsync") or f"https://api.runpod.ai/v2/{eid}/runsync"}


def endpoint_id(args) -> str:
    eid = args.endpoint or setting("ENDPOINT_ID")
    if not eid:
        raise Fail("which endpoint? Pass its id, or put ENDPOINT_ID=... into .env")
    return eid


def cmd_endpoint_health(rp: Runpod, args) -> dict:
    eid = endpoint_id(args)
    return {"endpoint": eid, **http("GET", f"{QUEUE}/{eid}/health", headers=rp.headers)}


def cmd_endpoint_test(rp: Runpod, args) -> dict:
    """Send one job and wait for it: the handler's health check, or a card with a prompt."""
    eid = endpoint_id(args)
    job = ({"workflow": args.workflow, "inputs": {"prompt": args.prompt, "seed": args.seed}} if args.workflow
           else {"action": "health"})
    t0 = time.time()
    started = http("POST", f"{QUEUE}/{eid}/run", {"input": job}, rp.headers)
    jid = started.get("id")
    if not jid:
        raise Fail(f"the endpoint did not take the job: {started}")
    status = started
    while status.get("status") in ("IN_QUEUE", "IN_PROGRESS", None) and time.time() - t0 < args.timeout:
        time.sleep(args.every)
        status = http("GET", f"{QUEUE}/{eid}/status/{jid}", headers=rp.headers)
        if not args.json:
            print(f"  {time.time() - t0:5.0f} s  {status.get('status')}", flush=True)
    if status.get("status") in ("IN_QUEUE", "IN_PROGRESS"):
        # never leave a test job waiting: a queued job keeps a worker up (and billing)
        http("POST", f"{QUEUE}/{eid}/cancel/{jid}", {}, rp.headers)
        status = {**status, "status": "CANCELLED", "error": f"no result after {args.timeout:.0f} s: cancelled. "
                  "Check the worker log (Logs tab) for the [kitty] lines and docs/runpod.md#troubleshooting."}
    output = status.get("output") or {}
    saved = []
    for out in output.get("outputs", []) if isinstance(output, dict) else []:
        if "base64" in out:
            dest = Path(args.out) / out["filename"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(base64.b64decode(out.pop("base64")))
            saved.append(str(dest))
    result = {"endpoint": eid, "job": jid, "status": status.get("status"), "seconds_total": round(time.time() - t0),
              # delayTime: in the queue, including a cold start; executionTime: the job itself (ms)
              "queue_and_cold_start_s": round((status.get("delayTime") or 0) / 1000),
              "execution_s": round((status.get("executionTime") or 0) / 1000), "output": output}
    if saved:
        result["saved"] = saved
    if status.get("status") != "COMPLETED":
        result["error"] = status.get("error") or (output.get("error") if isinstance(output, dict) else None)
    return result


# --------------------------------------------------------------------------- CLI
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    common = argparse.ArgumentParser(add_help=False)  # so --json also works after the command
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("check", parents=[common], help="test the API key; list pods and network volumes")
    g = sub.add_parser("gpus", parents=[common], help="GPUs with price per hour, stock and data centers")
    g.add_argument("--min-vram", type=int, default=24)
    g.add_argument("--datacenter", help="only GPUs available in this data center (e.g. your volume's)")

    vol = sub.add_parser("volume").add_subparsers(dest="action", required=True)
    vc = vol.add_parser("create", parents=[common])
    vc.add_argument("--size", type=int, required=True, help="GB (the installer's estimate recommends one)")
    vc.add_argument("--datacenter", required=True, help="e.g. EU-RO-1; one that has the GPU you want (`gpus`)")
    vc.add_argument("--name", default="kitty-models")
    vc.add_argument("--yes", action="store_true")

    pod = sub.add_parser("pod").add_subparsers(dest="action", required=True)
    pc = pod.add_parser("create", parents=[common])
    pc.add_argument("--volume", required=True)
    pc.add_argument("--gpu", required=True, help='GPU id from `gpus`, e.g. "NVIDIA GeForce RTX 5090"')
    pc.add_argument("--preset", help="install this preset on first boot")
    pc.add_argument("--workflows", help="or these workflow ids (comma-separated)")
    pc.add_argument("--gpu-profile", default="48gb", choices=core.GPU_PROFILES)
    pc.add_argument("--attention", default="sdpa", choices=["sdpa", "sage"])
    pc.add_argument("--jupyter", action="store_true", help="start JupyterLab with a generated token")
    pc.add_argument("--ssh", action="store_true", help="pass the SSH keys registered in your Runpod account")
    pc.add_argument("--image", default=IMAGE)
    pc.add_argument("--name", default="kitty-open-studio")
    pc.add_argument("--yes", action="store_true")
    for name in ("wait", "status", "progress", "install", "stop", "start", "delete"):
        p = pod.add_parser(name, parents=[common])
        p.add_argument("pod")
        if name in ("wait", "progress"):
            p.add_argument("--timeout", type=float, default=3600)
            p.add_argument("--every", type=float, default=15)
        if name == "progress":
            p.add_argument("--follow", action="store_true", help="keep printing until the install ends")
        if name == "install":
            p.add_argument("--preset")
            p.add_argument("--workflows")
            p.add_argument("--gpu-profile", default="48gb", choices=core.GPU_PROFILES)
        if name in ("install", "delete"):
            p.add_argument("--yes", action="store_true")

    ep = sub.add_parser("endpoint").add_subparsers(dest="action", required=True)
    ec = ep.add_parser("create", parents=[common])
    ec.add_argument("--volume", required=True)
    ec.add_argument("--gpu", required=True)
    ec.add_argument("--gpu-profile", default="48gb", choices=core.GPU_PROFILES)
    ec.add_argument("--workers-max", type=int, default=1)
    ec.add_argument("--idle", type=int, default=10, help="seconds a worker stays up after a job")
    ec.add_argument("--image", default=IMAGE)
    ec.add_argument("--name", default="kitty-worker")
    ec.add_argument("--yes", action="store_true")
    eh = ep.add_parser("health", parents=[common], help="workers and jobs of an endpoint")
    eh.add_argument("endpoint", nargs="?", help="endpoint id (default: ENDPOINT_ID from .env)")
    et = ep.add_parser("test", parents=[common], help="send one job and wait: the handler's health check, or a card")
    et.add_argument("endpoint", nargs="?", help="endpoint id (default: ENDPOINT_ID from .env)")
    et.add_argument("--workflow", help="a card id, e.g. qwen-image-t2i (default: only the health check)")
    et.add_argument("--prompt", default="A small ginger cat explorer with a green backpack in a sunny forest")
    et.add_argument("--seed", type=int, default=42)
    et.add_argument("--out", default="kitty-test-output", help="folder for base64 outputs")
    et.add_argument("--timeout", type=float, default=900, help="cancel the job after this many seconds")
    et.add_argument("--every", type=float, default=5)
    return ap


COMMANDS = {
    ("check", None): cmd_check, ("gpus", None): cmd_gpus, ("volume", "create"): cmd_volume_create,
    ("pod", "create"): cmd_pod_create, ("pod", "wait"): cmd_pod_wait, ("pod", "status"): cmd_pod_status,
    ("pod", "progress"): cmd_pod_progress, ("pod", "install"): cmd_pod_install, ("pod", "stop"): cmd_pod_power,
    ("pod", "start"): cmd_pod_power, ("pod", "delete"): cmd_pod_power, ("endpoint", "create"): cmd_endpoint_create,
    ("endpoint", "health"): cmd_endpoint_health, ("endpoint", "test"): cmd_endpoint_test,
}
NO_KEY = {("pod", "progress"), ("pod", "install")}  # these only talk to the pod's installer


def show(result: dict, indent: str = "") -> None:
    for key, value in result.items():
        if isinstance(value, dict):
            print(f"{indent}{key}:")
            show(value, indent + "  ")
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            print(f"{indent}{key}:")
            for item in value:
                print(f"{indent}  - " + ", ".join(f"{k}={v}" for k, v in item.items() if v not in (None, "", [])))
        else:
            print(f"{indent}{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    command = (args.command, getattr(args, "action", None))
    try:
        rp = None if command in NO_KEY else Runpod(setting("RUNPOD_API_KEY"))
        result = COMMANDS[command](rp, args)
    except (Fail, core.InstallError) as e:
        print(json.dumps({"error": str(e)}) if args.json else f"error: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        show(result)
        if result.get("dry_run"):
            print("\nDry run: nothing was created. Add --yes to do it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
