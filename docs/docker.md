# The backend image: build and configure it yourself

One image runs everywhere: a Runpod pod, a Runpod serverless worker or your own GPU box. It is **small**: the
runtime, the model installer, the job handler and the Kitty scripts, on top of Runpod's base image. Everything heavy
lives on the volume and is prepared there on the first start of a pod: ComfyUI, its node packs, the Python venv and
the models. Pushing a new version of the image moves a few MB, and nothing on the volume is downloaded twice.

```
/workspace/                       the volume (pod: /workspace, serverless: /runpod-volume, linked to /workspace)
  ComfyUI/                        ComfyUI at the commit pinned in custom_nodes.json
    custom_nodes/                 the node packs at their pinned commits
    models/                       the models (the installer puts them here)
  venv/                           Python 3.11: torch 2.8.0 + CUDA 12.8, ComfyUI's and the packs' requirements
  kitty/setup.json                what is installed; an image with newer pins updates only what changed
  kitty/requirements-extra.txt    optional: your own extra packages for the venv (pip format)
  kitty/logs/                     setup, ComfyUI, installer and JupyterLab logs
```

The first pod start takes **30-60 minutes on a Runpod network volume** for ComfyUI, the node packs and the venv (about 10 GB on the volume),
then seconds. The installer page (port 7861) is up from the first minute: it shows this setup and can already
download models. The Python setup is the owner's proven Runpod recipe: a separate venv
on the volume, torch 2.8 for CUDA 12.8 with a matching torchaudio, every node pack's requirements installed under a
freeze of the fragile core (transformers, tokenizers, torch, numpy, huggingface-hub, safetensors, accelerate,
diffusers) plus the version windows in `docker/venv-constraints.txt` (numpy 1.26.4, pillow < 12, protobuf < 6,
onnxruntime-gpu 1.20.2, ...), packages that compile against torch built with `--no-build-isolation`, and packages the
curated workflows do not need (closed API SDKs, training tools, web UIs) left out.

```
backend/
  docker/Dockerfile             the image (runtime only)
  docker/start.sh               entrypoint: MODE=pod | serverless
  docker/setup_volume.py        prepares ComfyUI, node packs and the venv on the volume (seconds when up to date)
  docker/install_nodes.py       installs the node packs from custom_nodes.json (+ CUSTOM_NODES) into the venv
  docker/venv-constraints.txt   the version windows for the venv
  docker/handler.py             Runpod job handler: {workflow, inputs} -> ComfyUI -> URLs or base64
  docker/workflow_patch.py      maps form inputs onto a workflow's API JSON (pure, unit-tested)
  docker/blackwell_patches.py   small idempotent fixes for RTX 50xx / PRO 6000
  docker/docker-compose.yml     build definition + local GPU run (docker compose up)
  docker/docker-bake.hcl        tags and push options for `docker buildx bake --push`
  docker/.env.example           every runtime variable
  installer/                    model installer: web page (port 7861) and CLI
  workflows/api, ui, index.json curated workflows and their input maps
  models.json, custom_nodes.json  what to download and which nodes to install
```

## Build and publish

Everything runs from `backend/docker/` (Windows PowerShell, Linux or macOS):

```bash
cd backend/docker
docker login                     # Docker Hub, once
docker buildx bake --push        # builds and pushes druidcat/kitty-open-studio:0.1.1 and :latest
docker buildx bake               # only build, locally
```

The build takes a minute or two and pushes only Kitty's own layers (tens of MB): the base image's layers already
exist on Docker Hub under `runpod/base` and are not uploaded again. The image holds no model weights and no secrets
(`.dockerignore` keeps `.env` files, `docker/models`, `docker/data` and weight files out), so it is fine to make it
public, for example for a public Runpod template.

`docker-compose.yml` holds the build (context, Dockerfile) and `docker-bake.hcl` the tags, the `linux/amd64`
platform and no attestation manifests. Set `IMAGE` / `VERSION` to change the name or tag, for example PowerShell
`$env:VERSION="0.1.1"` or `$env:IMAGE="ghcr.io/<you>/kitty-open-studio"` (log in with `docker login ghcr.io` and a
token with `write:packages`). On Docker Hub a new repository is public by default.

**With GitHub Actions** (no Docker on your machine; available once the workflow is on the default branch):
**Actions → Backend image → Run workflow**, tag `0.1.1`. It pushes `ghcr.io/<owner>/kitty-open-studio:0.1.1` and
`:latest`; untick *push* to only check that the image builds. The first push creates a private package; make it
public under **your profile → Packages → kitty-open-studio → Package settings → Change visibility**.

Then make the Runpod templates: [runpod-template.md](runpod-template.md).

Build argument: `BASE_IMAGE` (default `runpod/base:1.4.1-cuda1281-ubuntu2404`: Ubuntu 24.04, the CUDA 12.8 toolkit for
the optional SageAttention build, Python 3.11 for the venv, JupyterLab, SSH, ffmpeg). Hosts need an NVIDIA driver
for CUDA 12.8 or newer (570+); NVIDIA's RTX Video Super Resolution needs 570.190+, 580.82+ or 590.44+.

## Run on your own GPU

```bash
cd backend/docker
docker compose up -d        # ComfyUI :3020, installer :7861, JupyterLab :8888, all on 127.0.0.1
docker compose logs -f      # the first start prepares ComfyUI and the venv: 10-20 minutes on a local disk, once
```

ComfyUI, the node packs and the venv live in the Docker volume `kitty-workspace` (fast, and it keeps the venv's
symlinks, also on Windows). The models go to `backend/docker/models`, a normal folder you can reuse.
Needs Docker with GPU support (Linux, or Windows with WSL2 + Docker Desktop) and an NVIDIA driver 570+.

Without compose:

```bash
docker run --gpus all -p 3020:3020 -p 7861:7861 -v kitty-workspace:/workspace druidcat/kitty-open-studio:0.1.1
docker run --gpus all -e MODE=serverless -v kitty-workspace:/runpod-volume druidcat/kitty-open-studio:0.1.1   # a worker
```

## Other GPU clouds (open option, not tested)

Kitty Open Studio is built and tested on **Runpod** (pods, network volumes, serverless). The image is a plain Docker
image, so you can also run it on any host that gives you an NVIDIA GPU, Docker and a persistent disk (Vast.ai and the
like), as-is or after building and pushing your own tag (see *Build and publish*). We do not test other platforms;
this is an open door, not a supported path.

What the image needs from the host:

- an NVIDIA GPU with a driver for CUDA 12.8 or newer (570+), 24 GB VRAM or more for most cards;
- a persistent disk mounted at `/workspace` (ComfyUI, the venv and the models live there; 70 GB+ for the Starter
  preset);
- port **7861** reachable from the app (installer and job API) and 3020 if you want ComfyUI's own UI;
- `MODE=pod` (the default). Serverless mode speaks Runpod's job protocol and is Runpod-only.

The installer page, its job API and ComfyUI have no login (like on a Runpod pod, whose proxy URLs only you know), so
do not leave the ports open to the internet: reach them through an SSH tunnel (`ssh -L 7861:localhost:7861 ...`)
or the host's own private proxy. In the app: backend pill → **Runpod pod**, paste the URL of port 7861 (for example
`http://localhost:7861` through the tunnel); the app talks to it like to a pod.

## Environment variables

All are optional; `docker/.env.example` has the same list with comments.

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `pod` | `pod`: JupyterLab (8888), ComfyUI (3020), installer UI (7861), SSH from `PUBLIC_KEY`; prepares the volume. `serverless`: ComfyUI + Runpod handler on a volume a pod prepared. |
| `COMFY_PORT` | `3020` | ComfyUI port |
| `INSTALLER_PORT` / `JUPYTER_PORT` | `7861` / `8888` | pod mode ports |
| `DATA_DIR` | `/workspace` | the volume (serverless: `/runpod-volume`, linked to `/workspace` so the venv's paths match) |
| `WORK_DIR` | pod: `$DATA_DIR/kitty`, serverless: `/tmp/kitty` | ComfyUI input, output, user data and logs |
| `NODE_PACKS` | `all` | `all` or comma-separated pack ids from `custom_nodes.json`, for a slimmer ComfyUI |
| `INSTALL_NVIDIA_RTX` | `true` | the RTX Video Super Resolution node and NVIDIA's `nvidia-vfx` SDK (proprietary, free on RTX GPUs); `false` leaves both out, the workflows then use a lanczos resize |
| `CUSTOM_NODES` | empty | extra node repos installed at pod start (`URL[@ref]`, space or comma separated) |
| `COMFYUI_REF` | empty | empty = the ComfyUI commit pinned in `custom_nodes.json`, the one every workflow is validated against; or any tag, commit or branch |
| `TORCH_PACKAGES`, `TORCH_INDEX_URL` | torch 2.8.0 + torchvision 0.23.0 + torchaudio 2.8.0, `.../whl/cu128` | the venv's PyTorch |
| `INSTALL_PRESET` | empty | `starter`, `flux3`, `instant`, `video`, `talking-h3`, `everything`: downloaded on boot (pod: by the installer, progress on port 7861) |
| `INSTALL_WORKFLOWS` / `INSTALL_MODELS` | empty | comma-separated workflow / model ids (`python installer/cli.py --list`) |
| `HF_TOKEN` | empty | read token for gated Hugging Face models (LTX 2.5); used only for huggingface.co downloads |
| `GPU_PROFILE` | `48gb` | `24gb` FP8 files, `48gb` defaults (INT8 ConvRot / FP8), `80gb` BF16 where available |
| `ATTENTION` | `sdpa` | `sdpa` (PyTorch) or `sage`: SageAttention, built once per volume and GPU type on the pod (10-30 minutes); without it ComfyUI uses PyTorch attention |
| `KITTY_PROFILE` | `all` | `open-weights`: the handler hides the NVIDIA RTX cards and swaps RTX Video Super Resolution for lanczos |
| `RETENTION_DAYS` | `3` | job files older than this are deleted when someone generates (no timers): ComfyUI's input and output folders, and the S3 output prefix. `0` keeps everything |
| `OUTPUT_MODE` | `base64` | `s3` uploads results and returns links (recommended for video) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | empty | S3-compatible storage, see [s3.md](s3.md) |
| `S3_PUBLIC_URL`, `S3_PREFIX`, `S3_PRESIGN_SECONDS` | empty, `outputs`, `604800` | public base URL instead of presigned links; key prefix; link lifetime |
| `ENABLE_INSTALLER_UI`, `ENABLE_JUPYTER` | `true` | pod mode services |
| `JUPYTER_TOKEN`, `JUPYTER_PASSWORD` | empty | JupyterLab's login token. Both empty = JupyterLab stays off. Runpod sets `JUPYTER_PASSWORD` when you tick *Start Jupyter notebook* and its Connect button logs you in with it |
| `JUPYTER_DISABLE_AUTH` | empty | `true` runs JupyterLab with no login: anyone who has the pod's port-8888 URL gets a root shell |
| `COMFY_ARGS` | empty | extra ComfyUI flags, e.g. `--reserve-vram 1.5` |
| `BLACKWELL_PATCHES` | `true` | apply the small idempotent sm_120 source fixes before start |
| `JOB_TIMEOUT` | `5400` | seconds a serverless job may run |
| `COMFY_URL` | `http://127.0.0.1:$COMFY_PORT` | the handler can also drive a ComfyUI elsewhere |

## Updating

A new image with newer pins (ComfyUI, a pack, torch, the version windows) updates the volume on the next pod start:
only what changed is reinstalled (`kitty/setup.json` records what is there). Local edits inside `ComfyUI/` or a pinned
pack are overwritten by such an update; put your own nodes in other folders under `custom_nodes/`. Serverless workers
never change the volume: start a pod on it once after an update. A ComfyUI that was already on the volume and not
made by Kitty is used as it is (no checkout; only missing packs are added; its venv keeps its versions).

## Proven fixes kept from the owner's production images

- The venv on the volume, separate from the image's Python; `pip` is upgraded only
  inside the venv, never the distro pip.
- `cryptography` is installed with `--ignore-installed` before `runpod` (the base image's apt copy cannot be uninstalled by pip).
- protobuf < 6; onnxruntime-gpu 1.20.2 with numpy < 2 and pillow < 12; one opencv build; `--no-build-isolation` for
  packages that compile against torch (sam2, groundingdino, SageAttention).
- Blackwell: `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True,...`, `TORCHDYNAMO_DISABLE=1`, `TORCH_COMPILE_DISABLE=1`,
  and source patches for multinomial sampling in LLM text encoders, torchaudio's complex `abs` and a `None`
  DynamicVRAM value (`docker/blackwell_patches.py`, each applied only if the old line is still there).
- Serverless workers load only the node packs the cards use (`--whitelist-custom-nodes`, from `custom_nodes.json`): no
  ComfyUI-Manager and no packs left on the volume by hand or by an older image. `SERVERLESS_ALL_NODES=true` loads them all.
- Serverless workers keep ComfyUI's input, output and database on local disk, so workers never lock each other on the shared volume.

## Handler API

```json
{"input": {"workflow": "ltx25-i2v", "inputs": {"image": "https://.../frame.png", "prompt": "...", "duration": 5}}}
{"input": {"action": "health"}}
{"input": {"action": "list_workflows", "profile": "open-weights"}}
{"input": {"workflow_json": {"1": {"class_type": "...", "inputs": {}}}}}
```

The result is `{"outputs": [{"node", "filename", "type", "url" | "base64", "bytes"}], "seed", "timing", "warnings"}`
or `{"error": "readable message"}`. `"profile": "open-weights"` (or `KITTY_PROFILE`) leaves out the NVIDIA RTX cards
and turns RTX Video Super Resolution inside other workflows into a lanczos resize; a worker without `nvidia-vfx` does
the same swap and says so in `warnings`. Run a job against any ComfyUI without Runpod:

```bash
COMFY_URL=http://127.0.0.1:8188 MODELS_DIR=/path/to/ComfyUI/models \
  python backend/docker/handler.py --local '{"workflow": "simple-upscale", "inputs": {"image": "https://.../a.png"}}'
```

## Checks

```bash
pip install -r backend/requirements-dev.txt
python backend/tools/manifest.py check     # workflows <-> manifests <-> node packs, forbidden words
pytest backend/tests                       # handler against a fake ComfyUI, installer resume, input maps
```
