# Runpod templates for the Kitty image

The public pod template: **[Kitty Open Studio on the Runpod Hub](https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx)**. This page is for making your own.

Two templates use the same public image: a **pod** template (install models, try workflows in ComfyUI, let an AI
assistant do the setup) and a **serverless** template (the app's job endpoint). Publish the image first
([docker.md → Build and publish](docker.md#build-and-publish)). Below, `IMAGE` is its name, for example
`druidcat/kitty-open-studio:0.1.1`. Pin a version tag, not `latest`, so a template keeps
working when you push a new image.

## Pod template

Runpod console → **Templates → New Template**:

| Field | Value |
|---|---|
| Name | `Kitty Open Studio (ComfyUI + model installer)` |
| Type | Pod |
| Visibility | Public (or private while you test) |
| Container image | `IMAGE` |
| Container start command | empty (the image starts everything itself) |
| Container disk | `30` GB |
| Volume disk | `0` with a network volume, or `150`+ GB for a pod-only volume (ComfyUI, the venv and the models live there) |
| Volume mount path | `/workspace` |
| HTTP ports | `3020` ComfyUI, `7861` Model installer, `8888` JupyterLab |
| TCP ports | `22` (SSH, for AI-assisted setup) |
| Environment variables | `MODE=pod`, `GPU_PROFILE=48gb`, `ATTENTION=sdpa`, `INSTALL_PRESET=` (empty), `HF_TOKEN=` (empty) |

When deploying: pick GPUs with the **CUDA 13.0** filter (the image runs on CUDA 12.8+ hosts; NVIDIA's RTX Video
Super Resolution needs the newer drivers of CUDA 13 hosts) and tick **Start Jupyter notebook** if you want JupyterLab
(Runpod then sets its password; without it JupyterLab stays off). Users set `INSTALL_PRESET` and `HF_TOKEN` per pod;
never put a token into a public template.

### Template README (paste into the template's README field)

One line per paragraph and blank lines around lists: the Hub's README field does not join wrapped lines.

```markdown
# Kitty Open Studio: ComfyUI + curated open-weights workflows

ComfyUI 0.42 with **33 curated workflows**: FastH3 Omni (scene + sound in 8 steps), MiniMax H3, LTX 2.5, Wan 2.2, FLUX 3 Image Klein, Qwen Image 2.1, SeedVR2, NVIDIA RTX upscaling and more. Every workflow is validated against exactly the ComfyUI and node versions this template installs, and all of them were tested on an RTX 5090 on Runpod.

The image is small: ComfyUI, its node packs, a Python venv and the models live on your network volume, and a model installer shows the download size and the monthly volume cost before it downloads anything.

## Start

1. Deploy with a **network volume** (120 GB is enough for the Starter preset) and a GPU with the **CUDA 13.0** filter. 48 GB+ VRAM for H3 / FastH3 at full quality; on 24 GB cards set `GPU_PROFILE=24gb`.
2. The first start prepares ComfyUI and the venv on the volume: 30-60 minutes once, later starts take seconds.
3. Open port **7861** (model installer): it shows the setup progress; pick a preset, check size and cost, click Install. Or set `INSTALL_PRESET` before deploying.
4. Open port **3020** (ComfyUI): the workflows are under **Workflows → Kitty**.

## The app

The Kitty Open Studio app (a Studio with every workflow as a card, a timeline editor, MCP for Claude and ChatGPT) connects to this pod: backend pill → **Runpod pod** → paste the pod id. For pay-per-second use, add a serverless endpoint on the same volume (see `docs/runpod.md` in the repository).

## Environment variables

- `GPU_PROFILE`: `24gb` (FP8 files), `48gb` (default), `80gb` (BF16)
- `INSTALL_PRESET`: `starter`, `flux3`, `instant`, `video`, `talking-h3` or `everything`, installed on boot (progress on port 7861)
- `HF_TOKEN`: only for gated models (LTX 2.5); accept the license on Hugging Face first
- `ATTENTION`: `sdpa` or `sage` (SageAttention, built on the first start)
- `INSTALL_NVIDIA_RTX=false`: leaves out NVIDIA's proprietary RTX Video SDK (lanczos instead)
- `MODE=serverless`: the same image as a Runpod serverless worker on a volume a pod prepared

## Let your AI assistant do it

Point Claude Code (or another coding assistant) at the repository: it reads `AGENTS.md`, asks what you want to make, shows the size and cost, and installs through the installer's API on port 7861 (or over SSH on port 22).

## Security

Anyone who has a pod's proxy URL can use its ComfyUI and installer, so do not share the URLs.

## Links

- Source, docs and licenses: https://github.com/DruidCat237/kitty-open-studio
- Workflows by AI Druid Cat: https://www.patreon.com/c/AiDruid
```

## Serverless template

Runpod console → **Templates → New Template**, type **Serverless**:

| Field | Value |
|---|---|
| Name | `Kitty Open Studio worker` |
| Container image | `IMAGE` |
| Container disk | `30` GB |
| Environment variables | `MODE=serverless`, `GPU_PROFILE=48gb`, `OUTPUT_MODE=s3`, `S3_*` (see [s3.md](s3.md)), `JOB_TIMEOUT=5400` |

Then **Serverless → New Endpoint** from this template with the same network volume (ComfyUI, the venv and the
models a pod prepared on it) and **Allowed CUDA versions: 13.0**. Step-by-step:
[runpod.md → B](runpod.md#b-serverless-endpoint-on-the-same-volume).
