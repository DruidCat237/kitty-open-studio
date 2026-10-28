# Deploy on Runpod (about 10 minutes)

Kitty Open Studio runs every generation on **your own ComfyUI**. This guide covers three setups:

- **A. A GPU pod with a network volume.** Start here: install models, test them in ComfyUI, and point the app at it.
- **B. A serverless endpoint on the same volume.** Pay per second of GPU, scales to zero when idle.
- **C. Local ComfyUI.** You already have a GPU and ComfyUI.

All three use one Docker image, built from `backend/docker/Dockerfile` (see [docker.md](docker.md)); the ready-made
public templates are described in [runpod-template.md](runpod-template.md). Below it is
called `IMAGE`: the published `druidcat/kitty-open-studio:0.1.1`, or your own build (`docker buildx bake --push` in
`backend/docker`, or the "Backend image" GitHub Action).


---

## A. GPU pod + network volume

No Runpod account yet? [Sign up here](https://runpod.io?ref=1yinrvfx).

**Fastest:** deploy the public template, **[Kitty Open Studio on the Runpod Hub](https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx)**, with a network volume
(steps 1 and 3 below; step 2 is only for your own template).

### 1. Create a network volume

Runpod console, **Storage → New Network Volume**.

| Field | Value |
|---|---|
| Datacenter | One with the GPUs you want (for example RTX 5090 / RTX PRO 6000 / H100). Pods and serverless workers must run in the **same** datacenter as the volume. Pick one that offers the **S3-compatible API** if you want [S3 outputs](s3.md). |
| Size | What the installer recommends: **120 GB** for the Starter preset, **180 GB** for Video, **210 GB** for Talking + H3, **~650 GB** for Everything. Check any selection with `python installer/cli.py --estimate --preset <id>`. |

Cost: **$0.07 per GB per month** up to 1 TB and **$0.05** above (verify on runpod.io/pricing). A 120 GB volume costs
about **$8.40/month**, and the volume is billed while it exists, **even when no pod is running**.


### 2. Make a pod template

**Templates → New Template**:

| Field | Value |
|---|---|
| Container image | `IMAGE` |
| Container disk | 30 GB (the image and temporary files; ComfyUI, the venv and the models live on the volume) |
| Volume mount path | `/workspace` |
| Expose HTTP ports | `8888, 3020, 7861` (JupyterLab, ComfyUI, model installer) |
| Expose TCP ports | `22` (only for [AI-assisted setup](ai-assisted-setup.md) over SSH) |
| Environment variables | see the table below; all are optional |

| Variable | Pod value | What it does |
|---|---|---|
| `MODE` | `pod` | JupyterLab + ComfyUI + installer UI (+ SSH) |
| `GPU_PROFILE` | `24gb`, `48gb` or `80gb` | picks FP8 / INT8 / BF16 files for the installer |
| `HF_TOKEN` | your read token | only for gated models (LTX 2.5); accept the license on the model page first |
| `INSTALL_PRESET` | for example `starter` | downloads a preset on first boot; the installer page on port 7861 shows the progress |
| `ATTENTION` | `sdpa` or `sage` | SageAttention is faster on RTX 30/40/50; `sage` builds it on the first start (10-30 minutes, once per volume and GPU type) |
| `INSTALL_NVIDIA_RTX` | `true` (default) or `false` | the RTX Video Super Resolution node with NVIDIA's `nvidia-vfx` SDK (proprietary, free on RTX GPUs); `false` = lanczos instead |
| `JUPYTER_PASSWORD` | set by Runpod | tick **Start Jupyter notebook** when you deploy: Runpod sets it and its Connect button logs you in. Without it JupyterLab stays off, because the proxy URL works for anyone who has it |
| `CUSTOM_NODES` | git URLs | extra custom nodes, installed at start into the volume's ComfyUI |


### 3. Deploy and install models

**Pods → Deploy**: choose the network volume, a GPU (48 GB+ for MiniMax H3 / FastH3 at full quality, 24-32 GB
with `GPU_PROFILE=24gb`) and your template. Under the GPU filters set **CUDA version 13.0**: the image itself runs on
any host with CUDA 12.8+, but NVIDIA's RTX Video Super Resolution needs driver 570.190+ / 580.82+, which CUDA 13 hosts
have.

**The first start prepares the volume: 30-60 minutes on a Runpod network volume**, once. The pod puts ComfyUI, the node packs and a Python venv
(Python 3.11, torch 2.8 + CUDA 12.8, about 10 GB) on the volume; every later start takes seconds, and a newer image
only updates what changed. The installer page is up after a minute and shows this setup at the top. When the pod is
running, open **Connect**:

- **Port 7861: model installer.** Click a preset or tick models, check the size and monthly cost, click **Install**.
  Only missing files are downloaded, with a progress bar per file. If the pod restarts, click Install again and it
  resumes. Downloads can start while the volume setup is still running.
- **Port 3020: ComfyUI** (once the setup is done). The curated workflows are under **Workflows → Kitty**. Run one to test.
- **Port 8888: JupyterLab.** Terminal access to the volume, logs in `/workspace/kitty/logs`.


### 4. Connect the app

In Kitty Open Studio click the backend pill in the header (**Set up backend**) → **Runpod pod**, paste the pod id
(or any of its proxy URLs) and click **Test connection**. The app talks to the pod's job API on port 7861
(`https://<pod-id>-7861.proxy.runpod.net/api/jobs`), the same one the installer page uses.

Stop the pod when you are done: the models stay on the volume. Only the volume keeps billing.

---

## B. Serverless endpoint on the same volume

Do part A once: the pod prepares ComfyUI, the node packs and the venv on the volume and downloads the models.
Serverless workers mount the same volume at `/runpod-volume` and only read it (ComfyUI from
`/runpod-volume/ComfyUI`, the venv from `/runpod-volume/venv`), so a cold start does not install anything. After
updating the image, start the pod once so it updates the volume.

**Serverless → New Endpoint → Custom source → Docker image**:

| Field | Value |
|---|---|
| Container image | `IMAGE` |
| GPU | the same class you tested on the pod |
| Allowed CUDA versions (advanced) | 13.0, as on the pod |
| Network volume | the volume from part A (this pins the endpoint to its datacenter) |
| Container disk | 30 GB |
| Max workers / idle timeout | 1-3 workers, 5-60 s idle timeout (longer = fewer cold starts, more cost) |
| Execution timeout | 5400 s for long video jobs |

Environment variables:

| Variable | Value | Notes |
|---|---|---|
| `MODE` | `serverless` | runs the job handler instead of Jupyter / installer; a worker of a serverless endpoint switches to it by itself (Runpod sets `RUNPOD_ENDPOINT_ID`) |
| `GPU_PROFILE` | as on the pod | the handler swaps model files to match |
| `OUTPUT_MODE` | `s3` (recommended) or `base64` | base64 is fine for images; videos usually exceed Runpod's result size, use S3 |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | see [s3.md](s3.md) | where outputs are uploaded |
| `KITTY_PROFILE` | `all` or `open-weights` | `open-weights` hides the NVIDIA RTX cards and uses lanczos instead of RTX Video Super Resolution |
| `JOB_TIMEOUT` | `5400` | seconds the handler waits for ComfyUI |

**Check it from your machine** (key in `.env`):

```bash
python backend/deploy/runpod.py endpoint test <endpoint id>                               # health check job
python backend/deploy/runpod.py endpoint test <endpoint id> --workflow qwen-image-t2i  # one render, saved locally
python backend/deploy/runpod.py endpoint health <endpoint id>                             # workers and jobs
```

`queue_and_cold_start_s` in the result is the time the job waited for a worker (the cold start, when one had to
start); `execution_s` is the job itself.

**Cold starts.** A cold start happens when a new worker starts, not on every call: a worker stays up for the idle
timeout after a job and answers the next job at once, with its models still in memory. A new worker reads everything
from the network volume, which is the slow part. Measured on an RTX 5090 pod with the same volume:

| Step | Time |
|---|---|
| Python and torch from the volume | ~50 s |
| Node packs (serverless loads only the ones the cards use, not ComfyUI-Manager) | ~1.5-2 min |
| First job of a card: its models from the volume into VRAM | 20 s (images) to 2-3 min (14B video models) |

So expect about 3 minutes before a new worker's first job, plus the model load. To keep the app snappy: a longer
idle timeout (300 s and more while someone works), **FlashBoot** on (Runpod restores recently stopped workers much
faster), or one **active worker** during a demo (billed all the time, never cold). `SERVERLESS_ALL_NODES=true`
loads every pack on the volume instead, for packs you added yourself.

Test it from a terminal (`RUNPOD_API_KEY` from **Settings → API Keys**):

```bash
curl -s https://api.runpod.ai/v2/$ENDPOINT_ID/runsync \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"action": "health"}}'

curl -s https://api.runpod.ai/v2/$ENDPOINT_ID/run \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"workflow": "fasth3-omni", "inputs": {
        "prompt": "<Picture 1> walks along a sunny garden wall and meows",
        "picture1": "https://example.com/cat.png", "duration": 5}}}'
# then poll: curl -s https://api.runpod.ai/v2/$ENDPOINT_ID/status/<job id> -H "Authorization: Bearer $RUNPOD_API_KEY"
```

`{"action": "health"}` reports the GPU, the ComfyUI version and, per workflow, any model files missing on the volume.
**Connect the app.** Backend pill in the header → **Serverless**, paste the endpoint id and your Runpod API key, **Test
connection** (it shows idle/running workers and the queue). How a job travels:

1. The app's own server (Next.js, on your machine) sends `POST https://api.runpod.ai/v2/<endpoint id>/run` with your
   key. The key never goes anywhere but Runpod.
2. Runpod starts a worker if none is warm (cold start, above); the worker runs the card's ComfyUI graph from the
   network volume.
3. The app polls `/status/<job id>` every few seconds; the result comes back as base64 (pictures) or as a signed S3
   link (`OUTPUT_MODE=s3`, needed for videos) and lands in the Studio feed and, in the editor, in the project.

You pay for the seconds a worker runs (plus the idle timeout); with no jobs nothing runs but the volume.

Job input reference: [`backend/workflows/index.json`](../backend/workflows/index.json) lists every workflow's inputs
(`key`, `type`, `required`, `default`, `min`/`max`). Media inputs take an `https://` URL, an `s3://bucket/key`, a
`data:` URI or `{"base64": "...", "filename": "x.png"}`.

---

## C. Local ComfyUI

Two options:

1. **Docker on your GPU** (Linux with the NVIDIA Container Toolkit, or Windows with WSL2 + Docker Desktop):

   ```bash
   cd backend/docker
   cp .env.example .env      # optional
   docker compose up -d      # the first start prepares ComfyUI and the venv: 10-20 minutes on a local disk, once
   ```

   Needs an NVIDIA driver for CUDA 12.8 or newer (570+). ComfyUI and the venv live in the Docker volume
   `kitty-workspace`, the models in `backend/docker/models`. Open the installer on http://localhost:7861 and ComfyUI
   on http://localhost:3020.

2. **Your existing ComfyUI.** Install the custom nodes the workflows need (listed per workflow in
   `backend/workflows/index.json`, repos in `backend/custom_nodes.json`, or in one go:
   `python backend/docker/install_nodes.py --comfy /path/to/ComfyUI`), then download models straight into it:

   ```bash
   python backend/installer/cli.py --preset starter --models-dir /path/to/ComfyUI/models
   ```

   Kitty's own venv uses torch 2.8 for CUDA 12.8, the owner's proven setup. ComfyUI 0.42+ enables its fastest
   FP8/INT8 kernels only on torch builds for CUDA 13 (cu130); on cu128 everything runs, quantized models somewhat
   slower. Drag any file from `backend/workflows/ui/` onto ComfyUI to use it by hand. In the app, set
   **Local ComfyUI URL** to `http://127.0.0.1:8188` (or your port).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "ComfyUI not reachable" | Pod: the first start prepares the volume for 30-60 minutes on a Runpod network volume (the installer page on port 7861 shows the step); later starts take 1-2 minutes. Check `/workspace/kitty/logs/comfyui.log`. Serverless: the worker log shows why ComfyUI did not start. |
| The installer page says "The ComfyUI setup failed" | The step and message are on the page; the full log is `/workspace/kitty/logs/setup.log`. Usually a network hiccup while downloading packages: restart the pod (it retries three times per start and resumes where it stopped). |
| Serverless jobs fail with "ComfyUI is not prepared on this network volume yet" | Start a pod with the same volume once and wait until the installer page says ComfyUI is ready. |
| An RTX upscale says it "upscaled with lanczos instead" | `nvidia-vfx` is not installed on that volume: `INSTALL_NVIDIA_RTX=false`, or its install failed (the installer page lists it under the setup). |
| RTX Video Super Resolution fails with a driver error | NVIDIA's SDK needs driver 570.190+ / 580.82+ / 590.44+ and an RTX GPU: deploy with the CUDA 13.0 filter. |
| "model file missing: X" | Install it on the pod (port 7861), or `python installer/cli.py --workflows <id>`. |
| "access denied (HTTP 401/403)" while installing | Gated model: accept its license on Hugging Face with the account whose token is in `HF_TOKEN`. |
| "GPU ran out of memory" | Lower resolution or duration, set `GPU_PROFILE=24gb`, or pick a bigger GPU. |
| A custom node is missing | Add the repo to `CUSTOM_NODES` and restart the pod; `NODE_PACKS` must include the pack. |
| JupyterLab (port 8888) does not open | Deploy with **Start Jupyter notebook** ticked (or set `JUPYTER_PASSWORD`); the pod log says "JupyterLab not started" otherwise. |
| The pod or worker never starts, or "CUDA driver version is insufficient" | The host's driver is older than CUDA 12.8: set the CUDA filter to 13.0 (or 12.8+). |
