# AGENTS.md

Two kinds of requests come with this repository:

- **"Set it up for me"** (the user hands you the repo, asks you to install Kitty Open Studio, get it running on
  Runpod or on their GPU): follow **Setup** below, step by step.
- **Changing the code** (a development session): read [PLAN.md](PLAN.md) and [backend/README.md](backend/README.md);
  ignore Setup.
- **Trying the app** (run Kitty Open Studio on this computer): follow **Run the app** below.

## Run the app

Needs Node.js 20+ (22 recommended). From the repository root:

```bash
cd app
npm ci                      # ELECTRON_SKIP_BINARY_DOWNLOAD=1 skips Electron when only the web version is wanted
npm run dev                 # http://localhost:3000 (syncs the workflow cards and gallery first)
```

Desktop app: `npm run electron:dev` (builds, then opens the window; the app serves itself on 127.0.0.1:19847).
Installers: `npm run electron:build` (Windows) or `npm run electron:build:linux`.

Then, in the app: the backend pill in the header → a Runpod pod (pod id), a serverless endpoint (endpoint id + the
user's Runpod API key, typed into the app, never into the chat) or local Docker. For MCP: **Claude & ChatGPT** in the
Studio's header shows the config for Claude Code, Claude Desktop and ChatGPT ([docs/mcp.md](docs/mcp.md)).

## Setup

You set up Kitty Open Studio's backend for the user: ComfyUI with 33 curated workflows (open weights, plus two
NVIDIA RTX upscalers) and a model installer, on Runpod or on their own NVIDIA GPU. The Docker image is small: on the
first start a pod puts ComfyUI, its node packs and a Python venv on the volume (30-60 minutes on a Runpod network volume, once), next to the
models. Talk in the user's language, explain each step in a sentence or
two, and let the tools below do the work.

### Rules

- **Money**: show the cost and wait for a clear yes before anything that bills: a network volume (per GB per month,
  even while no pod runs), a pod (per hour while it runs), a serverless endpoint, a big download. Commands that
  cost money print a dry run first and need `--yes`; show the user that dry run.
- **Secrets**: never ask the user to paste a key into the chat and never print one. They put keys into `.env` at
  the repository root (git-ignored), for example `RUNPOD_API_KEY=...` and, only for gated models, `HF_TOKEN=...`.
  The tools read it.
- Models come only from `backend/models.json`; never delete files on a volume unless the user names them.
- When something fails, show the last lines of the output and the fix from
  [docs/runpod.md → Troubleshooting](docs/runpod.md#troubleshooting).

### 1. What does the user want?

Ask what they want to make (images, video with sound, talking characters, music videos, upscaling, the FastH3
Omni speed demo) and whether they have an NVIDIA GPU with 24 GB+ (local) or want Runpod (no GPU needed).
Then pick a preset or workflows and show the estimate:

```bash
python backend/installer/cli.py --list --json
python backend/installer/cli.py --estimate --preset starter --json     # files, GB, recommended volume, $/month
```

Presets: `starter` (images + upscaling + talking video, ~66 GB, 24 GB VRAM), `flux3` (FLUX 3 Klein image + edit, 11 GB, needs `HF_TOKEN`), `instant` (FastH3 Omni, 32 GB+),
`video` (LTX 2.5 + Wan 2.2, 32 GB+, needs `HF_TOKEN`), `talking-h3` (MiniMax H3 + InfiniteTalk, 48 GB+),
`everything` (~510 GB). Cards with 24-32 GB use `--gpu-profile 24gb` (FP8 files).

### 2a. Runpod (recommended)

The user needs a Runpod account with credit (no account yet: sign up at https://runpod.io?ref=1yinrvfx) and an API key (runpod.io → Settings → API Keys, read/write) in
`.env` as `RUNPOD_API_KEY`. Then, with `python backend/deploy/runpod.py` (add `--json` to read results):

1. `check`: the key works; lists existing pods and volumes (reuse a volume that already has models).
2. `gpus --min-vram 48`: GPUs with price per hour and stock. Propose one; 5090 / PRO 6000 / H100 class.
3. `volume create --size <recommended GB> --datacenter <id>`: dry run shows $/month; `--yes` after the user agrees.
   Pick a datacenter that has the chosen GPU in stock (`gpus` shows them).
   If the user prefers clicking: the public template [Kitty Open Studio on the Runpod Hub](https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx) with that volume.
4. `pod create --volume <volume id> --gpu "<gpu id>" --preset <preset>`: dry run shows $/hour; `--yes` after a yes.
   On its first boot the pod prepares ComfyUI and the venv on the volume and downloads the preset at the same time.
5. `pod wait <pod id>` (until ComfyUI is ready: 30-60 minutes on a new network volume), then `pod progress <pod id> --follow`
   until the model download is done (minutes to an hour).
6. `pod status <pod id>`: which workflows are ready. Give the user the links: ComfyUI
   `https://<pod id>-3020.proxy.runpod.net` (Workflows → Kitty) and the installer `https://<pod id>-7861.proxy.runpod.net`.
7. Optional, for the Kitty app: a serverless endpoint, see **2d** below.
8. When the user is done for now: `pod stop <pod id>`. The volume keeps the models and keeps billing monthly;
   `pod start <pod id>` brings it back.

More details on what runs inside the pod: [backend/AGENTS.md](backend/AGENTS.md).

### 2b. Their own NVIDIA GPU (Docker)

Needs Docker with GPU support (Linux, or Windows with WSL2 + Docker Desktop) and an NVIDIA driver for CUDA 12.8 or
newer (570+). Then:

```bash
cd backend/docker
docker compose up -d          # pulls druidcat/kitty-open-studio, ComfyUI :3020, installer :7861 (localhost only)
```

The first start prepares ComfyUI and the venv in the Docker volume `kitty-workspace` (10-20 minutes on a local disk; `GET /api/status`
→ `setup` shows the step). Install models through the installer's API at `http://localhost:7861` (`GET /api/status`,
`POST /api/estimate`, `POST /api/install`, `GET /api/progress`, see [backend/AGENTS.md](backend/AGENTS.md)) or the
page itself. Models are stored in `backend/docker/models`.

### 2c. An existing ComfyUI

```bash
python backend/docker/install_nodes.py --comfy /path/to/ComfyUI       # the node packs, pinned
python backend/installer/cli.py --preset starter --models-dir /path/to/ComfyUI/models
```

The workflows to load by hand are in `backend/workflows/ui/`.

### 2d. Serverless endpoint (pay per second, for the Kitty app)

Do this after 2a: the pod has prepared ComfyUI, the venv and the models on the network volume, and the workers only
read them. Walk the user through it one step at a time and say what each step costs.

1. **Prerequisites.** The volume from 2a (an endpoint can only use volumes in its own datacenter), a GPU class the user
   tested on the pod, and (for video) an S3 bucket: the volume's own S3 API is the simplest
   ([docs/s3.md](docs/s3.md), option 1; the user creates the S3 key pair and puts `S3_*` into `.env`).
2. **Create it.** `endpoint create --volume <volume id> --gpu "<gpu id>"` prints a dry run with $/hour while a worker
   runs; `--yes` after a clear yes. It sets `MODE=serverless`, `GPU_PROFILE`, the S3 settings from `.env`, FlashBoot,
   the volume and CUDA 13.0. Or in the console (Serverless → New Endpoint → Docker image): the fields and variables in
   [docs/runpod.md → B](docs/runpod.md#b-serverless-endpoint-on-the-same-volume). Max workers 1 is enough to start.
3. **One test, no more.** `endpoint test <endpoint id> --workflow qwen-image-t2i`: one render, cancelled by itself
   after 15 minutes if no worker takes it. The first job waits for a cold start (about 3 minutes plus the model load,
   see docs/runpod.md); later jobs on a warm worker start at once. Do not test every card on serverless: each job
   costs GPU time, and the pod already showed which cards work.
4. **If the job sits in the queue**: open the endpoint's Logs. `[kitty]` lines say what the worker does. A worker that
   prints installer or JupyterLab lines runs as a pod (an old image without the automatic switch: set
   `MODE=serverless`); "no ComfyUI on the volume" means no volume is attached or a pod never prepared it.
5. **Costs.** No workers, no cost while idle (only the volume's monthly price). A worker bills per second while it runs a
   job and during the idle timeout. To stop everything at once: Max workers 0. `endpoint health` shows workers and jobs.
6. Give the user the endpoint id for the app's settings (the API key stays in their `.env` or the app's settings).

### 3. Finish

Tell the user what runs where, the links, the monthly volume cost and the hourly GPU cost, and how to stop and
start the pod. Offer one test render in ComfyUI (it uses GPU time).
