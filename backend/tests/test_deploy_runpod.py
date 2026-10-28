"""backend/deploy/runpod.py against a fake Runpod API v2 and a fake pod installer."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pytest
import runpod

KEY = "rpa_TESTKEY_never_printed"
GPUS = [
    {"id": "NVIDIA GeForce RTX 5090", "name": "RTX 5090", "pool": "BLACKWELL_32", "memory": 32, "secure": True,
     "price": {"secure": 0.94, "serverless": 1.10}, "availability": "HIGH",
     "dataCenters": [{"id": "EU-RO-1", "availability": "HIGH"}, {"id": "US-NOVOL-1", "availability": "HIGH"}]},
    {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "name": "RTX PRO 6000", "pool": None, "memory": 96,
     "secure": True, "price": {"secure": 1.79}, "availability": "LOW",
     "dataCenters": [{"id": "EU-RO-1", "availability": "LOW"}]},
    {"id": "NVIDIA GeForce RTX 3090", "name": "RTX 3090", "memory": 24, "secure": True, "price": {"secure": 0.46},
     "availability": "NONE", "dataCenters": []},
]


class Fake(BaseHTTPRequestHandler):
    calls: list = []
    pod_status = "RUNNING"
    setup_state = "done"
    card_job = False

    def log_message(self, *args):
        pass

    def reply(self, body, code=200, ctype="application/json"):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        url = urlsplit(self.path)
        p, q = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        type(self).calls.append((method, p, body, self.headers.get("Authorization"), q))
        pod = {"id": "pod123", "name": "kitty-open-studio", "status": type(self).pod_status, "cost": 0.94,
               "gpu": {"id": "NVIDIA GeForce RTX 5090", "count": 1}, "dataCenterId": "EU-RO-1",
               "image": runpod.IMAGE, "mounts": {"network": [{"volumeId": "vol1", "path": "/workspace"}]}}
        routes = {
            ("GET", "/v2/catalog/gpus"): lambda: {"gpus": GPUS},
            ("GET", "/v2/catalog/datacenters"): lambda: {"dataCenters": [
                {"id": "EU-RO-1", "networkVolumeTypes": ["STANDARD"]}, {"id": "US-NOVOL-1", "networkVolumeTypes": []}]},
            ("GET", "/v2/pods"): lambda: {"pods": [pod]},
            ("GET", "/v2/network-volumes"): lambda: {"networkVolumes": [
                {"id": "vol1", "name": "kitty-models", "size": 110, "dataCenter": "EU-RO-1", "type": "STANDARD"}]},
            ("GET", "/v2/pods/pod123"): lambda: pod,
            ("POST", "/v2/pods/pod123/action"): lambda: {**pod, "status": "EXITED"},
            ("GET", "/proxy/pod123/7861/api/health"): lambda: {"ok": True},
            ("GET", "/proxy/pod123/7861/api/status"): lambda: {
                "setup": {"state": type(self).setup_state, "step": "ready", "message": "pip failed", "warnings": []},
                "comfyui": {"ok": True, "gpu": "RTX 5090"}, "free_bytes": 80e9, "ready_workflows": ["simple-upscale"],
                "missing_models": {"fasth3-omni": ["a", "b"]}, "install": {"state": "running", "done": 10e9, "total": 59.5e9}},
            ("POST", "/proxy/pod123/7861/api/estimate"): lambda: {"count": 16, "to_download_gb": 59.5, "total_gb": 59.5,
                                                                  "needs_hf_token": False},
            ("POST", "/proxy/pod123/7861/api/install"): lambda: {"started": True, "count": 16},
            ("GET", "/proxy/pod123/7861/api/progress"): lambda: {"state": "done", "message": "all installed",
                                                                 "done": 59.5e9, "total": 59.5e9, "files": []},
        }
        if (method, p) == ("POST", "/v2/network-volumes"):
            return self.reply({"id": "vol2", "type": "STANDARD", **body}, 201)
        if (method, p) == ("POST", "/v2/pods"):
            if body["gpu"]["id"] == "NVIDIA RTX PRO 6000 Blackwell Server Edition":
                return self.reply({"title": "Bad Request", "status": 400, "detail": "no capacity"}, 400,
                                  "application/problem+json")
            return self.reply({**pod, "status": "PROVISIONING"}, 201)
        if (method, p) == ("DELETE", "/v2/pods/pod123"):
            return self.reply(None, 204)
        if (method, p) == ("POST", "/v2/serverless"):
            return self.reply({"id": "ep1", "requestUrls": {"runsync": "https://api.runpod.ai/v2/ep1/runsync"}}, 201)
        if (method, p) == ("POST", "/q/ep1/run"):
            return self.reply({"id": "job1", "status": "IN_QUEUE"})
        if (method, p) == ("GET", "/q/ep1/status/job1"):
            output = ({"comfyui": "ok", "gpu": "RTX 5090"} if body is None and not type(self).card_job else
                      {"outputs": [{"filename": "cat.png", "type": "image/png", "base64": "aGVsbG8="}], "seed": 42})
            return self.reply({"id": "job1", "status": "COMPLETED", "delayTime": 151000, "executionTime": 9000,
                               "output": output})
        if (method, p) == ("GET", "/q/ep1/health"):
            return self.reply({"jobs": {"completed": 1, "inQueue": 0}, "workers": {"idle": 1, "running": 0}})
        if (method, p) in routes:
            return self.reply(routes[(method, p)]())
        return self.reply({"title": "Not Found", "status": 404, "detail": f"{method} {p}"}, 404)

    def do_GET(self):  # noqa: N802
        self.handle_any("GET")

    def do_POST(self):  # noqa: N802
        self.handle_any("POST")

    def do_DELETE(self):  # noqa: N802
        self.handle_any("DELETE")


@pytest.fixture()
def api(monkeypatch, tmp_path):
    Fake.calls, Fake.pod_status, Fake.setup_state = [], "RUNNING", "done"
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setattr(runpod, "API", base + "/v2")
    monkeypatch.setattr(runpod, "PROXY", base + "/proxy/{pod}/{port}")
    monkeypatch.setattr(runpod, "QUEUE", base + "/q")
    monkeypatch.setattr(runpod, "ROOT", tmp_path)  # .env lookups go to an empty folder
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    for k in ("HF_TOKEN", *runpod.S3_KEYS):
        monkeypatch.delenv(k, raising=False)
    yield Fake.calls
    srv.shutdown()


def run(capsys, *argv):
    code = runpod.main(list(argv))
    out, err = capsys.readouterr()
    assert KEY not in out + err
    return code, (json.loads(out) if "--json" in argv and code == 0 else out), err


def posts(calls, path):
    return [c[2] for c in calls if c[0] == "POST" and c[1] == path]


def test_volume_dry_run_then_create(api, capsys):
    code, plan, _ = run(capsys, "volume", "create", "--size", "110", "--datacenter", "EU-RO-1", "--json")
    assert code == 0 and plan["dry_run"] and plan["usd_per_month"] == 7.7 and not posts(api, "/v2/network-volumes")
    code, res, _ = run(capsys, "--json", "volume", "create", "--size", "110", "--datacenter", "EU-RO-1", "--yes")
    assert posts(api, "/v2/network-volumes") == [{"name": "kitty-models", "size": 110, "dataCenter": "EU-RO-1"}]
    assert res["volume"]["id"] == "vol2" and api[-1][3] == f"Bearer {KEY}"


def test_pod_create_sends_a_v2_pod_on_the_volume(api, capsys, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_secret_value")
    code, plan, _ = run(capsys, "pod", "create", "--volume", "vol1", "--gpu", "NVIDIA GeForce RTX 5090",
                        "--preset", "starter", "--json")
    assert plan["dry_run"] and plan["usd_per_hour"] == 0.94 and plan["gpu_stock_there"] == "HIGH"
    assert plan["datacenter"] == "EU-RO-1" and plan["hf_token"] == "from .env" and not posts(api, "/v2/pods")
    catalog_query = next(c[4] for c in api if c[1] == "/v2/catalog/gpus")
    assert catalog_query == {"include": "AVAILABILITY", "product": "POD", "cloud": "SECURE", "minCudaVersion": "13.0"}
    code, res, _ = run(capsys, "pod", "create", "--volume", "vol1", "--gpu", "NVIDIA GeForce RTX 5090",
                       "--preset", "starter", "--gpu-profile", "24gb", "--jupyter", "--yes", "--json")
    body = posts(api, "/v2/pods")[0]
    assert body["image"] == runpod.IMAGE and body["cloud"] == "SECURE" and body["disk"] == 30
    assert body["gpu"] == {"id": "NVIDIA GeForce RTX 5090", "count": 1, "allowedCudaVersions": ["13.0"]}
    assert body["mounts"] == {"network": [{"volumeId": "vol1", "path": "/workspace"}]}
    assert body["dataCenterIds"] == ["EU-RO-1"] and body["startSsh"] is False
    assert set(body["ports"]) == {"3020/http", "7861/http", "8888/http", "22/tcp"}
    assert body["env"]["INSTALL_PRESET"] == "starter" and body["env"]["GPU_PROFILE"] == "24gb"
    assert body["env"]["HF_TOKEN"] == "hf_secret_value" and body["env"]["JUPYTER_PASSWORD"]
    assert "hf_secret_value" not in json.dumps(res)
    assert res["pod"]["id"] == "pod123" and res["jupyter"].endswith("/lab?token=" + body["env"]["JUPYTER_PASSWORD"])


def test_no_capacity_and_unknown_preset(api, capsys):
    code, _, err = run(capsys, "pod", "create", "--volume", "vol1", "--gpu",
                       "NVIDIA RTX PRO 6000 Blackwell Server Edition", "--yes")
    assert code == 1 and "no capacity" in err and "gpus --datacenter EU-RO-1" in err
    api.clear()
    code, _, err = run(capsys, "pod", "create", "--volume", "v", "--gpu", "g", "--preset", "nope", "--yes")
    assert code == 1 and "unknown preset" in err and not api


def test_gpus_only_where_a_volume_can_live(api, capsys):
    code, res, _ = run(capsys, "gpus", "--min-vram", "32", "--json")
    assert [g["name"] for g in res["gpus"]] == ["RTX 5090", "RTX PRO 6000"]
    assert res["gpus"][0]["datacenters"] == ["EU-RO-1 (high)"]  # US-NOVOL-1 has no network volumes
    code, res, _ = run(capsys, "gpus", "--min-vram", "24", "--datacenter", "EU-RO-1", "--json")
    assert [g["name"] for g in res["gpus"]] == ["RTX 5090", "RTX PRO 6000"]


def test_wait_status_progress_install(api, capsys):
    code, res, _ = run(capsys, "pod", "wait", "pod123", "--every", "0", "--json")
    assert res["ready_workflows"] == ["simple-upscale"] and res["missing"] == {"fasth3-omni": 2}
    assert res["setup"]["state"] == "done"
    assert res["install"]["done_gb"] == 10.0 and res["pod"]["comfyui"].endswith("/proxy/pod123/3020")
    code, res, _ = run(capsys, "pod", "progress", "pod123", "--follow", "--every", "0", "--json")
    assert res["state"] == "done" and res["total_gb"] == 59.5
    code, plan, _ = run(capsys, "pod", "install", "pod123", "--preset", "starter", "--json")
    assert plan["dry_run"] and plan["download_gb"] == 59.5 and not posts(api, "/proxy/pod123/7861/api/install")
    code, res, _ = run(capsys, "pod", "install", "pod123", "--preset", "starter", "--yes", "--json")
    assert res["started"] and posts(api, "/proxy/pod123/7861/api/install")[0]["preset"] == "starter"


def test_wait_stops_on_a_failed_pod(api, capsys):
    Fake.pod_status = "ERROR"
    code, _, err = run(capsys, "pod", "wait", "pod123", "--every", "0", "--timeout", "600")
    assert code == 1 and "ERROR" in err


def test_wait_reports_a_failed_volume_setup(api, capsys):
    Fake.setup_state = "error"
    code, _, err = run(capsys, "pod", "wait", "pod123", "--every", "0", "--timeout", "600")
    assert code == 1 and "volume setup failed: pip failed" in err
    Fake.setup_state = "running"
    code, _, err = run(capsys, "pod", "wait", "pod123", "--every", "0", "--timeout", "0.2")
    assert code == 1 and "timed out waiting for ComfyUI" in err


def test_endpoint_power_and_errors(api, capsys, monkeypatch):
    for k, v in {"S3_BUCKET": "b", "S3_ACCESS_KEY": "ak", "S3_SECRET_KEY": "sk", "S3_ENDPOINT": "https://s3"}.items():
        monkeypatch.setenv(k, v)
    code, res, _ = run(capsys, "endpoint", "create", "--volume", "vol1", "--gpu", "NVIDIA GeForce RTX 5090", "--yes", "--json")
    ep = posts(api, "/v2/serverless")[0]
    assert ep["type"] == "QUEUE" and ep["image"] == runpod.IMAGE and ep["gpu"]["pools"] == ["BLACKWELL_32"]
    assert ep["mounts"] == {"network": [{"volumeId": "vol1"}]} and ep["dataCenterIds"] == ["EU-RO-1"]
    assert ep["workers"]["min"] == 0 and ep["scaling"]["type"] == "QUEUE_DELAY" and ep["flashboot"] == "FLASHBOOT"
    assert ep["env"]["MODE"] == "serverless" and ep["env"]["OUTPUT_MODE"] == "s3" and ep["env"]["S3_BUCKET"] == "b"
    assert res["runsync"] == "https://api.runpod.ai/v2/ep1/runsync" and "sk" not in json.dumps(res)
    code, res, _ = run(capsys, "pod", "delete", "pod123", "--json")
    assert res["dry_run"] and not [c for c in api if c[0] == "DELETE"]
    code, res, _ = run(capsys, "pod", "stop", "pod123", "--json")
    assert posts(api, "/v2/pods/pod123/action") == [{"action": "stop"}] and res["pod"]["status"] == "EXITED"
    code, _, err = run(capsys, "pod", "status", "nope")
    assert code == 1 and "HTTP 404 Not Found" in err


def test_missing_key_and_env_file(api, capsys, monkeypatch, tmp_path):
    monkeypatch.delenv("RUNPOD_API_KEY")
    code, _, err = run(capsys, "check")
    assert code == 1 and ".env" in err
    (tmp_path / ".env").write_text('# keys\nexport RUNPOD_API_KEY="rpa_TESTKEY_never_printed"\nHF_TOKEN=hf_x\n')
    code, res, _ = run(capsys, "check", "--json")
    assert code == 0 and res["volumes"][0]["usd_per_month"] == 7.7 and res["pods"][0]["volume"] == "vol1"


def test_endpoint_health_and_test_jobs(api, capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("ENDPOINT_ID", "ep1")
    code, out, _ = run(capsys, "endpoint", "health", "--json")
    assert code == 0 and out["workers"]["idle"] == 1
    code, out, _ = run(capsys, "endpoint", "test", "--every", "0", "--json")
    assert code == 0 and out["status"] == "COMPLETED" and out["queue_and_cold_start_s"] == 151
    assert posts(api, "/q/ep1/run")[-1] == {"input": {"action": "health"}}
    Fake.card_job = True
    code, out, _ = run(capsys, "endpoint", "test", "--workflow", "qwen-image-t2i", "--out", str(tmp_path),
                       "--every", "0", "--json")
    assert posts(api, "/q/ep1/run")[-1]["input"]["workflow"] == "qwen-image-t2i"
    assert (tmp_path / "cat.png").read_bytes() == b"hello" and "base64" not in out["output"]["outputs"][0]
    Fake.card_job = False
