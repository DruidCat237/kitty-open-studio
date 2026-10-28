import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import core
import pytest

PAYLOAD = bytes(range(256)) * 4096  # 1 MiB
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class RangeHandler(BaseHTTPRequestHandler):
    drop_first = False
    gated = False
    requests = []

    def log_message(self, *args):  # keep test output quiet
        pass

    def do_GET(self):  # noqa: N802
        type(self).requests.append(self.headers.get("Range"))
        if type(self).gated and self.headers.get("Authorization") != "Bearer good":
            self.send_response(401)
            self.end_headers()
            return
        start = 0
        rng = self.headers.get("Range")
        if rng:
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            self.send_response(200)
        body = PAYLOAD[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if type(self).drop_first and not rng:
            self.wfile.write(body[: len(body) // 3])  # connection dies a third of the way in
            self.wfile.flush()
            self.connection.close()
            return
        self.wfile.write(body)


@pytest.fixture()
def server():
    RangeHandler.requests, RangeHandler.drop_first, RangeHandler.gated = [], False, False
    srv = ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/model.safetensors"
    srv.shutdown()


def model(url, **kw):
    return {"id": "m", "filename": "sub/m.safetensors", "folder": "loras", "url": url, "size_bytes": len(PAYLOAD),
            "sha256": SHA, **kw}


def test_download_verifies_and_moves_into_place(server, tmp_path):
    prog = core.FileProgress("m", "m.safetensors")
    core.download(model(server), tmp_path, prog, threading.Event())
    assert (tmp_path / "loras/sub/m.safetensors").read_bytes() == PAYLOAD
    assert prog.status == "done" and not list(tmp_path.rglob("*.part"))


def test_download_resumes_after_a_dropped_connection(server, tmp_path, monkeypatch):
    RangeHandler.drop_first = True
    monkeypatch.setattr(core.time, "sleep", lambda s: None)
    core.download(model(server), tmp_path, core.FileProgress("m", "m"), threading.Event())
    assert (tmp_path / "loras/sub/m.safetensors").read_bytes() == PAYLOAD
    assert any(r and r.startswith("bytes=") for r in RangeHandler.requests)


def test_sha_mismatch_deletes_the_file(server, tmp_path):
    with pytest.raises(core.InstallError, match="sha256"):
        core.download(model(server, sha256="0" * 64), tmp_path, core.FileProgress("m", "m"), threading.Event())
    assert not (tmp_path / "loras/sub/m.safetensors").exists()


def test_gated_model_explains_the_token(server, tmp_path, monkeypatch):
    RangeHandler.gated = True
    monkeypatch.setenv("HF_TOKEN", "bad")
    monkeypatch.setattr(core, "_request", lambda url, start=0: core.urllib.request.Request(
        url, headers={"Authorization": "Bearer bad", **({"Range": f"bytes={start}-"} if start else {})}))
    with pytest.raises(core.InstallError, match="HF_TOKEN"):
        core.download(model(server), tmp_path, core.FileProgress("m", "m"), threading.Event())


def test_run_install_skips_installed_and_auto_files(server, tmp_path):
    cat = core.Catalog(models=[model(server), {"id": "auto", "filename": "a.pt", "folder": "x", "url": None,
                                                 "auto_download": True, "size_bytes": 5}], workflows=[], presets=[])
    job = core.run_install(cat, ["m", "auto"], tmp_path)
    assert job.state == "done", job.message
    job = core.run_install(cat, ["m", "auto"], tmp_path)
    assert [f.status for f in job.files] == ["skipped", "skipped"]


def test_also_in_folders_get_a_link_not_a_second_download(server, tmp_path):
    cat = core.Catalog(models=[model(server, filename="m.safetensors", also_in=["sam3"])], workflows=[], presets=[])
    assert core.run_install(cat, ["m"], tmp_path).state == "done"
    main, extra = tmp_path / "loras/m.safetensors", tmp_path / "sam3/m.safetensors"
    assert extra.read_bytes() == PAYLOAD and extra.stat().st_ino == main.stat().st_ino
    extra.unlink()  # an older install without the link gets it on the next run, without downloading
    requests_before = len(RangeHandler.requests)
    core.run_install(cat, ["m"], tmp_path)
    assert extra.exists() and len(RangeHandler.requests) == requests_before


def test_space_check(tmp_path):
    with pytest.raises(core.InstallError, match="Not enough free space"):
        core.check_space(10 ** 18, tmp_path)


def test_estimate_and_pricing():
    assert core.monthly_cost(100) == 7.0
    assert core.monthly_cost(2000) == 70.0 + 50.0
    cat = core.Catalog.load()
    est = core.estimate(cat, cat.resolve(preset="starter"), "48gb")
    assert 40 < est["total_gb"] < 70
    assert est["recommended_volume_gb"] >= est["total_gb"]
    assert not est["needs_hf_token"]
    assert core.estimate(cat, cat.resolve(preset="video"))["needs_hf_token"]


def test_unknown_ids_are_explained():
    cat = core.Catalog.load()
    with pytest.raises(core.InstallError, match="unknown preset"):
        cat.resolve(preset="nope")
    with pytest.raises(core.InstallError, match="unknown model"):
        cat.resolve(models=["nope"])


def test_variants_follow_the_gpu_profile():
    cat = core.Catalog.load()
    m = cat.by_id["fasth3-omniref-8step-pruned-int8-convrot"]
    assert core.pick_variant(m, "24gb")["filename"] == "fasth3_omniref_fp8_comfy.safetensors"
    assert core.pick_variant(m, "48gb")["filename"] == m["filename"]


def test_status_and_install_from_env(tmp_path, monkeypatch):
    import time

    from app import create_app, selection_from_env
    from fastapi.testclient import TestClient

    monkeypatch.setenv("INSTALL_PRESET", "")
    monkeypatch.setenv("INSTALL_WORKFLOWS", "")
    monkeypatch.setenv("INSTALL_MODELS", "rife49, yolox-l")  # fetched by their nodes: no network in the test
    monkeypatch.setenv("DATA_DIR", str(tmp_path))  # setup_volume.py writes kitty/setup-status.json there
    (tmp_path / "kitty").mkdir()
    (tmp_path / "kitty" / "setup-status.json").write_text('{"state": "running", "step": "Python venv"}')
    sel = selection_from_env()
    assert sel.models == ["rife49", "yolox-l"] and not sel.preset
    client = TestClient(create_app(str(tmp_path), autostart=sel, comfy_url="http://127.0.0.1:9"))
    for _ in range(50):
        progress = client.get("/api/progress").json()
        if progress["state"] != "running":
            break
        time.sleep(0.05)
    assert progress["state"] == "done" and [f["status"] for f in progress["files"]] == ["skipped", "skipped"]
    status = client.get("/api/status").json()
    assert status["comfyui"]["ok"] is False and status["install"]["state"] == "done"
    assert status["setup"] == {"state": "running", "step": "Python venv"}
    assert "fasth3-omni" in status["missing_models"] and "fasth3-omni" not in status["ready_workflows"]
    assert "frame-interpolation" in status["ready_workflows"]  # its only model is fetched by the node itself
    # a bad id from the environment shows up as the job's error instead of stopping the page from starting
    monkeypatch.setenv("INSTALL_PRESET", "nope")
    client = TestClient(create_app(str(tmp_path), autostart=selection_from_env()))
    assert "unknown preset" in client.get("/api/progress").json()["message"]


def test_web_app(tmp_path):
    from app import create_app
    from fastapi.testclient import TestClient

    client = TestClient(create_app(str(tmp_path)))
    assert "Kitty Open Studio" in client.get("/").text
    cat = client.get("/api/catalog").json()
    assert cat["presets"] and cat["models"] and cat["workflows"]
    est = client.post("/api/estimate", json={"preset": "instant", "gpu_profile": "24gb"}).json()
    assert est["gpu_profile"] == "24gb" and est["total_gb"] > 0
    assert client.post("/api/estimate", json={"preset": "nope"}).status_code == 400
    assert client.get("/api/progress").json()["state"] == "idle"


def test_job_api_runs_the_handler_and_serves_files(tmp_path, monkeypatch):
    import base64
    import time

    from app import create_app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORK_DIR", str(tmp_path / "work"))
    monkeypatch.delenv("KITTY_API_TOKEN", raising=False)

    def fake_run(job_input, job_id):
        if job_input.get("workflow") == "broken":
            raise RuntimeError("model file missing: x.safetensors")
        return {"workflow": job_input["workflow"], "seed": 7,
                "outputs": [{"filename": "../cat.png", "type": "image/png", "base64": base64.b64encode(b"png").decode()}]}

    client = TestClient(create_app(str(tmp_path), job_runner=fake_run))

    def wait(jid):
        for _ in range(100):
            job = client.get(f"/api/jobs/{jid}").json()
            if job["status"] not in ("IN_QUEUE", "IN_PROGRESS"):
                return job
            time.sleep(0.02)
        raise AssertionError("job did not finish")

    jid = client.post("/api/jobs", json={"input": {"workflow": "qwen-image-t2i", "inputs": {}}}).json()["id"]
    job = wait(jid)
    assert job["status"] == "COMPLETED" and "base64" not in job["output"]["outputs"][0]
    url = job["output"]["outputs"][0]["url"]
    assert url == f"/api/files/{jid}/cat.png" and client.get(url).content == b"png"
    assert client.get(f"/api/files/{jid}/..%2Fapp.py").status_code == 404

    failed = wait(client.post("/api/jobs", json={"input": {"workflow": "broken"}}).json()["id"])
    assert failed["status"] == "FAILED" and "model file missing" in failed["error"]
    assert client.get("/api/jobs/nope").status_code == 404

    monkeypatch.setenv("KITTY_API_TOKEN", "s3cret")
    assert client.post("/api/jobs", json={"input": {}}).status_code == 401
    ok = client.post("/api/jobs", json={"input": {"workflow": "z"}}, headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200
