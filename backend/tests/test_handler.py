"""The job handler end to end against a fake ComfyUI (no GPU needed)."""
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import handler
import pytest

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class FakeComfy(BaseHTTPRequestHandler):
    prompts, uploads, deleted, fail_with, nodes = [], [], [], None, set()

    def log_message(self, *args):
        pass

    def reply(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/system_stats":
            return self.reply(200, {"system": {"comfyui_version": "test"}, "devices": [{"name": "Fake GPU", "vram_total": 24e9}]})
        if url.path.startswith("/history/"):
            pid = url.path.rsplit("/", 1)[1]
            prompt = FakeComfy.prompts[-1]
            if FakeComfy.fail_with:
                return self.reply(200, {pid: {"status": {"status_str": "error", "messages": [["execution_error", {
                    "node_type": "KSampler", "exception_message": FakeComfy.fail_with}]]}, "outputs": {}}})
            saves = [nid for nid, n in prompt.items() if n["class_type"].startswith(("Save", "VHS_VideoCombine"))]
            outputs = {nid: {"images": [{"filename": f"out_{nid}.png", "subfolder": "", "type": "output"}]} for nid in saves}
            return self.reply(200, {pid: {"status": {"status_str": "success", "completed": True}, "outputs": outputs}})
        if url.path.startswith("/object_info/"):
            cls = url.path.rsplit("/", 1)[1]
            return self.reply(200, {cls: {"name": cls}} if cls in FakeComfy.nodes else {})
        if url.path == "/view":
            return self.reply(200, PNG + parse_qs(url.query)["filename"][0].encode(), "image/png")
        self.reply(404, {})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        if self.path == "/upload/image":
            name = body.split(b'filename="')[1].split(b'"')[0].decode()
            FakeComfy.uploads.append(name)
            return self.reply(200, {"name": name, "subfolder": "", "type": "input"})
        if self.path == "/prompt":
            prompt = json.loads(body)["prompt"]
            missing = [(nid, v) for nid, n in prompt.items() for v in n["inputs"].values()
                       if isinstance(v, str) and v == "missing_model.safetensors"]
            if missing:
                return self.reply(400, {"error": {"type": "prompt_outputs_failed_validation"}, "node_errors": {missing[0][0]: {
                    "errors": [{"type": "value_not_in_list", "message": "Value not in list",
                                "extra_info": {"input_name": "unet_name", "received_value": missing[0][1]}}]}}})
            FakeComfy.prompts.append(prompt)
            bad = [nid for nid, n in prompt.items() if n["inputs"].get("aspect_ratio") == "old label"]
            errors = {bad[0]: {"errors": [{"type": "value_not_in_list", "message": "Value not in list",
                                          "details": "aspect_ratio: 'old label' not in [...]"}]}} if bad else {}
            return self.reply(200, {"prompt_id": f"p{len(FakeComfy.prompts)}", "node_errors": errors})
        if self.path == "/queue":
            FakeComfy.deleted.append(json.loads(body)["delete"])
            return self.reply(200, {})
        self.reply(404, {})


@pytest.fixture()
def comfy(monkeypatch):
    FakeComfy.prompts, FakeComfy.uploads, FakeComfy.fail_with, FakeComfy.nodes = [], [], None, set()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfy)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(handler, "OUTPUT_MODE", "base64")
    yield handler.Comfy(f"http://127.0.0.1:{srv.server_address[1]}")
    srv.shutdown()


def data_uri(data=PNG):
    return "data:image/png;base64," + base64.b64encode(data).decode()


def test_runs_a_workflow_and_returns_base64(comfy):
    result = handler.run_job({"workflow": "simple-upscale", "inputs": {"image": data_uri()}}, "job-1", comfy)
    assert result["outputs"][0]["type"] == "image/png"
    assert base64.b64decode(result["outputs"][0]["base64"]).startswith(PNG)
    assert FakeComfy.uploads == ["job-1_image0.png"]
    assert FakeComfy.prompts[0]["8"]["inputs"]["image"] == "job-1_image0.png"


def test_fasth3_with_optional_inputs_missing(comfy):
    result = handler.run_job({"workflow": "fasth3-omni", "inputs": {
        "prompt": "<Picture 1> waves", "picture1": {"base64": base64.b64encode(PNG).decode(), "filename": "cat.png"},
        "duration": 4, "seed": 7}}, "job-2", comfy)
    prompt = FakeComfy.prompts[0]
    assert result["seed"] == 7 and prompt["129"]["inputs"]["noise_seed"] == 7
    assert "142" not in prompt and "ref_video" not in prompt
    assert [o["node"] for o in result["outputs"]] == ["92"]


def test_errors_are_readable(comfy, monkeypatch):
    out = handler.handler({"id": "x", "input": {"workflow": "nope"}})
    assert "unknown workflow" in out["error"]
    with pytest.raises(handler.JobError, match="required"):
        handler.run_job({"workflow": "simple-upscale", "inputs": {}}, "job-3", comfy)
    FakeComfy.fail_with = "CUDA out of memory"
    with pytest.raises(handler.JobError, match="ran out of memory"):
        handler.run_job({"workflow": "simple-upscale", "inputs": {"image": data_uri()}}, "job-4", comfy)


def test_missing_model_names_the_installer(comfy):
    with pytest.raises(handler.JobError, match="model file missing: missing_model.safetensors"):
        handler.run_job({"workflow_json": {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "missing_model.safetensors"}}}},
                        "job-5", comfy)


def test_health_and_list(comfy, tmp_path, monkeypatch):
    monkeypatch.setattr(handler, "MODELS_DIR", str(tmp_path))
    health = handler.run_job({"action": "health"}, "h", comfy)
    assert health["gpu"] == "Fake GPU" and "simple-upscale" in health["missing_models"]
    listed = handler.run_job({"action": "list_workflows"}, "l", comfy)["workflows"]
    assert any(w["id"] == "fasth3-omni" for w in listed)
    assert not any(w["id"] == "fasth3-omni-lightvae" for w in listed)


def test_rtx_upscale_falls_back_to_lanczos_without_nvidia_vfx(comfy):
    result = handler.run_job({"workflow": "rtx-image-upscale", "inputs": {"image": data_uri(), "scale": 3}}, "r1", comfy)
    node = FakeComfy.prompts[-1]["1"]
    assert node["class_type"] == "ImageScaleBy" and node["inputs"]["scale_by"] == 3.0
    assert node["inputs"]["upscale_method"] == "lanczos" and any("lanczos" in w for w in result["warnings"])
    FakeComfy.nodes = {"RTXVideoSuperResolution"}
    comfy.nodes.clear()
    result = handler.run_job({"workflow": "rtx-image-upscale", "inputs": {"image": data_uri()}}, "r2", comfy)
    assert FakeComfy.prompts[-1]["1"]["class_type"] == "RTXVideoSuperResolution" and not result["warnings"]


def test_open_weights_profile(comfy):
    """The NVIDIA RTX cards are hidden and refused; RTX VSR inside LTX v2v becomes the lanczos resize."""
    FakeComfy.nodes = {"RTXVideoSuperResolution"}
    listed = handler.run_job({"action": "list_workflows", "profile": "open-weights"}, "l", comfy)["workflows"]
    ids = {w["id"] for w in listed}
    assert "rtx-video-upscale" not in ids and "ltx25-v2v-upscale" in ids
    assert "rtx-video-upscale" in {w["id"] for w in handler.run_job({"action": "list_workflows"}, "l2", comfy)["workflows"]}
    with pytest.raises(handler.JobError, match="100% open weights"):
        handler.run_job({"workflow": "rtx-image-upscale", "profile": "open-weights", "inputs": {"image": data_uri()}},
                        "o1", comfy)
    handler.run_job({"workflow": "ltx25-v2v-upscale", "profile": "open-weights",
                     "inputs": {"video": "data:video/mp4;base64,AAAA"}}, "o2", comfy)
    upscaler = FakeComfy.prompts[-1]["449"]
    assert upscaler["class_type"] == "ImageScale" and (upscaler["inputs"]["width"], upscaler["inputs"]["height"]) == (1920, 1088)
    with pytest.raises(handler.JobError, match="unknown profile"):
        handler.run_job({"action": "list_workflows", "profile": "nope"}, "o3", comfy)


def test_unprepared_volume_fails_jobs_with_the_fix(comfy, monkeypatch):
    monkeypatch.setenv("KITTY_SETUP_ERROR", "ComfyUI is not prepared on this network volume yet. Start a pod once.")
    with pytest.raises(handler.JobError, match="Start a pod"):
        handler.run_job({"workflow": "simple-upscale", "inputs": {"image": data_uri()}}, "s1", comfy)
    assert handler.run_job({"action": "list_workflows"}, "s2", comfy)["workflows"]  # the catalog still answers


def test_unreachable_comfyui_message():
    comfy = handler.Comfy("http://127.0.0.1:9")
    with pytest.raises(handler.JobError, match="ComfyUI not reachable"):
        comfy.wait_ready(timeout=1)


def test_silent_wav_is_valid():
    import io
    import wave

    with wave.open(io.BytesIO(handler.silent_wav(2))) as w:
        assert w.getnframes() == 88200


def test_inpaint_needs_a_transparent_area(comfy):
    pytest.importorskip("PIL")
    import io

    from PIL import Image

    def png(alpha):
        buf = io.BytesIO()
        Image.new("RGBA", (4, 4), (200, 50, 50, alpha)).save(buf, "PNG")
        return buf.getvalue()

    with pytest.raises(handler.JobError, match="no transparent area"):
        handler.run_job({"workflow": "qwen-image-inpaint", "inputs": {"image": data_uri(png(255))}}, "job-9", comfy)
    handler.run_job({"workflow": "qwen-image-inpaint", "inputs": {"image": data_uri(png(0))}}, "job-11", comfy)


def test_partly_invalid_prompt_is_an_error(comfy):
    """ComfyUI queues the outputs that validate and reports the others in node_errors with HTTP 200."""
    prompt = {"1": {"class_type": "ResolutionSelector", "inputs": {"aspect_ratio": "old label"}},
              "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}}}
    with pytest.raises(handler.JobError, match="node 1 ResolutionSelector: Value not in list"):
        handler.run_job({"workflow_json": prompt}, "job-12", comfy)
    assert FakeComfy.deleted[-1] == [f"p{len(FakeComfy.prompts)}"]


def test_runpod_volume_s3_returns_an_s3_url_instead_of_a_presigned_link(monkeypatch):
    class FakeS3:
        def put_object(self, **kw):
            self.put = kw

        def generate_presigned_url(self, *a, **kw):
            return "https://store.example/outputs/x?X-Amz-Signature=abc"

    s3 = FakeS3()
    monkeypatch.setattr(handler, "OUTPUT_MODE", "s3")
    monkeypatch.setattr(handler, "s3_client", lambda: s3)
    monkeypatch.setenv("S3_BUCKET", "vol123")
    monkeypatch.setenv("S3_REGION", "eu-ro-1")
    monkeypatch.delenv("S3_PUBLIC_URL", raising=False)
    monkeypatch.delenv("S3_PRESIGN", raising=False)

    monkeypatch.setenv("S3_ENDPOINT", "https://s3api-eu-ro-1.runpod.io")
    out = handler.deliver(b"video", "a.mp4", "job1")
    assert out["url"].startswith("s3://vol123/outputs/job1/a.mp4?")
    assert parse_qs(urlparse(out["url"]).query) == {"endpoint": ["https://s3api-eu-ro-1.runpod.io"], "region": ["eu-ro-1"]}
    assert s3.put["Key"] == "outputs/job1/a.mp4"

    monkeypatch.setenv("S3_ENDPOINT", "https://abc.r2.cloudflarestorage.com")
    assert "X-Amz-Signature" in handler.deliver(b"video", "a.mp4", "job1")["url"]
    monkeypatch.setenv("S3_PRESIGN", "0")
    assert handler.deliver(b"video", "a.mp4", "job1")["url"].startswith("s3://")
