# Workflows

- `api/<id>.json`: the graph in ComfyUI's API format. The job handler and the app run these.
- `ui/<id>.json`: the same graph for the ComfyUI editor (drag it onto ComfyUI). All share one style: steps flow left
  to right in colored groups (Load Models → Your Inputs → Prepare & Condition → Generate → Decode & Save) and the
  only note is the orange Patreon box.
- `index.json`: one Studio card per API graph: title, category, summary, inputs (form field → node input),
  outputs, VRAM and GPU-time estimates, prompt tags. `models` and `custom_nodes` are derived by
  `tools/manifest.py sync`.

The full catalog with inputs and sizes: [docs/workflows.md](../../docs/workflows.md).

## Where they come from

All workflows were curated from the author's own ComfyUI library (AI Druid Cat) for Kitty Open Studio:
fine-tuned checkpoints, LoRAs without a public Hugging Face source and community-modified text encoders were
replaced by the official open-weights files or removed (removed LoRA slots stay in the UI graphs as bypassed, empty "Optional LoRA slot" nodes),
Fill-Nodes' float-to-int node became ComfyUI's own converter, and every note was removed.

NVIDIA's RTX Video Super Resolution (`RTXVideoSuperResolution`, from Comfy-Org's NVIDIA RTX nodes with NVIDIA's
proprietary `nvidia-vfx` SDK, free on RTX GPUs) runs the two cards badged **NVIDIA RTX** (`rtx-image-upscale`,
`rtx-video-upscale`) and the pre-upscale in `ltx25-v2v-upscale`. The job handler replaces it with a lanczos
resize of the same size in the "100% open weights" profile (`profiles` in `index.json`) and on a ComfyUI without
`nvidia-vfx`, and says so in the job's warnings.

Some graphs build on public templates and examples, credited here:

| Workflow | Built on |
|---|---|
| `qwen-image-*`, `ltx25-t2v`, `ltx25-i2v`, `ltx25-flf`, `h3-i2v` | ComfyUI's official workflow templates (Comfy-Org) |
| `infinitetalk`, `infinitetalk-v2v` | Kijai's ComfyUI-WanVideoWrapper examples |
| `ltx25-v2v-upscale` | a public LTX v2v upscaler workflow by markdkberry (markdkberry.com) |
| `h3-character-swap` | the H3 Relay nodes by akatz-ai |
| `fasth3-omni*` | new for Kitty Open Studio (from `h3-r2v`, settings from the FastH3 Omni model card), see `tools/build_fasth3.py` |
| `rtx-image-upscale`, `rtx-video-upscale` | the example workflows of Comfy-Org's NVIDIA RTX nodes |
| `solar-render` | the low-memory example workflow of Enderfga's SolarRenderer (Apache-2.0 nodes; LoRAs under the MiniMax H3 Community License), with its six-part prompt node |

Optional LightVAE decoding uses ModelTC's LightVAE node (Apache-2.0).

## Not run as one-click jobs

- `qwen-camera-angle` sets the camera on a 3D gizmo node; the app sends the defaults until a camera input is added.
