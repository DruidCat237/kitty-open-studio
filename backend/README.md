# Kitty Open Studio backend

Everything that runs on **your** GPU: curated ComfyUI workflows, the model manifest, a model installer
and one configurable Docker image for Runpod pods, Runpod serverless and local GPUs.
Open weights only; nothing here calls a paid API.

| | |
|---|---|
| [`workflows/`](workflows/) | 33 workflow graphs (API + editable UI graphs) and [`index.json`](workflows/index.json): Studio cards with input maps |
| [`models.json`](models.json) | every model: URL, size, sha256, target folder, license, GPU-profile variants, the workflows that use it |
| [`custom_nodes.json`](custom_nodes.json) | the ComfyUI commit and node packs the workflows need, pinned to the commits they were validated with |
| [`installer/`](installer/) | model installer: web page on port 7861 and a CLI with size and storage-cost estimates |
| [`deploy/runpod.py`](deploy/runpod.py) | creates the Runpod volume, pod and serverless endpoint and drives the install (what [AGENTS.md](../AGENTS.md) uses when an assistant sets things up) |
| [`docker/`](docker/) | the image: ComfyUI + nodes + installer + Runpod job handler, `MODE=pod` or `serverless` |
| [`tools/`](tools/) | `manifest.py` (sync, check, docs, refresh), `api_to_ui.py` (editor graph from an API graph), [`live/`](tools/live/) (checks against a running ComfyUI) and the one-time curation scripts |
| [`AGENTS.md`](AGENTS.md) | instructions for your coding assistant to install everything over SSH |

## Quick start

```bash
# what does a preset cost?
python installer/cli.py --estimate --preset starter

# download it into an existing ComfyUI (only missing files; resumable)
python installer/cli.py --preset starter --models-dir /path/to/ComfyUI/models

# or run the whole backend on a local GPU (ComfyUI :3020, installer :7861, JupyterLab :8888)
docker compose -f docker/docker-compose.yml up --build
```

Guides: [Runpod in 10 minutes](../docs/runpod.md) · [Docker image](../docs/docker.md) · [S3 outputs](../docs/s3.md) ·
[AI-assisted setup](../docs/ai-assisted-setup.md) · [All workflows](../docs/workflows.md) · [Models and licenses](../docs/models.md)

## Highlights

- **Instant scene + sound (FastH3 Omni).** 8-step MiniMax H3 distillation: up to 9 pictures, 3 videos and 3 audio
  clips in (`<Picture 1>`, `<Video 1>`, `<Audio 1>` in the prompt), video with synced stereo sound out. INT8 and FP8
  graphs, an optional LightVAE fast decode, core ComfyUI nodes only.
- **LTX 2.5 VFX**: text/image/first-last-frame to video with sound or your own audio track, and v2v restyle/upscale.
- **MiniMax H3**: image to video with sound, talking pictures, reference-to-video with your audio, Character Swap.
- **One style**: every UI graph flows left to right in colored step groups, with a single Patreon note.
- **Validated against a real ComfyUI**: every workflow passes ComfyUI's own `/prompt` validation in five variants
  (as shipped, required inputs only, all inputs, 24 GB and 80 GB files), and every UI graph loads in the real editor
  and queues a valid prompt ([`tools/live/`](tools/live/)).
- **Honest licenses**: [docs/models.md](../docs/models.md) lists every model's license, flags non-commercial and
  community licenses, and nothing is bundled.

## Developing

```bash
pip install -r requirements-dev.txt
python tools/manifest.py sync     # after editing workflows or index.json: recompute derived fields
python tools/manifest.py check    # what CI runs: links, model files, node packs, input maps, house style
python tools/manifest.py docs     # regenerate docs/models.md and docs/workflows.md
pytest tests                      # handler (fake ComfyUI), installer resume/verify, every input map
```

Adding a workflow: export it from ComfyUI as **API** into `workflows/api/<id>.json` and as a normal workflow into
`workflows/ui/<id>.json`, add its card and input map to `workflows/index.json`, add any new model to `models.json`
(`python tools/manifest.py refresh` fills size and sha256 from Hugging Face), run `sync`, then `check`.
No editor graph? `python tools/api_to_ui.py workflows/api/<id>.json --comfy http://127.0.0.1:8188 -o workflows/ui/<id>.json`
builds one with the editor's widget rules (add the id to `GENERATED` so a test keeps it in sync). Before a release,
run the [live checks](tools/live/README.md) against a ComfyUI with the pinned packs.
