# AGENTS.md: installing the Kitty Open Studio backend on a Runpod pod

You are a coding assistant helping a user set up the Kitty Open Studio backend (ComfyUI + curated open-weights
workflows) on their Runpod pod. Follow these steps in order and
**do not download anything before the user has seen the size and the monthly cost and said yes**.

There are two ways in; both do the same install:

- **The installer's HTTP API** (no SSH needed): the user gives you the pod id, and the installer answers on
  `https://<pod-id>-7861.proxy.runpod.net`. See "Without SSH" below.
- **SSH**: the user gives you the pod's SSH command (Runpod: Connect → SSH over exposed TCP); the steps below.

## Facts you need

- The pod runs the Kitty image (small: the runtime and these scripts). Paths inside the pod:
  - backend: `/opt/kitty/backend` (installer, workflows, manifests)
  - ComfyUI: `/workspace/ComfyUI` on the volume, run by the venv `/workspace/venv` (Python 3.11, torch 2.8 +
    CUDA 12.8), listening on port **3020**
  - models: `/workspace/ComfyUI/models`
  - logs: `/workspace/kitty/logs/{setup,comfyui,installer,jupyter}.log`; an install started on boot
    (`INSTALL_PRESET`) runs inside the installer, so its progress is at `curl -s localhost:7861/api/progress`
- On the first start the pod prepares ComfyUI, the node packs and the venv on the volume (30-60 minutes on a Runpod network volume; later
  starts take seconds). `curl -s localhost:7861/api/status` → `setup` shows the step (`state`: running, done or
  error); ComfyUI starts when it is done. Model downloads can run meanwhile.
- The installer CLI: `python3 /opt/kitty/backend/installer/cli.py`
  - `--list [--json]`: presets, workflows (with their model ids) and models
  - `--estimate --preset <id> | --workflows a,b | --models x,y [--json]`: size, recommended volume, monthly cost
  - same selection without `--estimate`: downloads only the missing files, resumable (run it again after an interruption)
  - `--gpu-profile 24gb|48gb|80gb`: FP8 / default / BF16 file variants (default: `$GPU_PROFILE` or `48gb`)
- Presets: `starter` (~66 GB, no token), `flux3` (FLUX 3 Klein, 11 GB, needs `HF_TOKEN`), `instant` (FastH3 Omni), `video` (LTX 2.5 + Wan 2.2, needs `HF_TOKEN`),
  `talking-h3` (MiniMax H3 + InfiniteTalk), `everything` (~510 GB).
- Runpod network volume price: **$0.07 per GB per month up to 1 TB, $0.05 above**. The volume is billed while it
  exists, even when no pod runs. Tell the user to verify on runpod.io/pricing.
- Gated models (LTX 2.5) need the user to accept the license on the Hugging Face model page and a read token.

## Steps

1. **Connect and look around** (read-only):
   ```bash
   nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
   df -h /workspace
   cat /workspace/kitty/setup-status.json
   curl -s localhost:3020/system_stats | head -c 300
   python3 /opt/kitty/backend/installer/cli.py --list
   ```
   While the setup state is `running`, ComfyUI is not up yet: tell the user and continue with the models. If the
   state is `error` or ComfyUI does not answer after it is `done`, read the end of `/workspace/kitty/logs/setup.log`
   or `comfyui.log` and report it.

2. **Ask the user what they want to make** (images, video, talking characters, music videos, FastH3 Omni speed
   demo, upscaling...). Map that to a preset or a list of workflow ids from `--list`. Suggest `GPU_PROFILE=24gb`
   for cards under 48 GB.

3. **Estimate and show it**:
   ```bash
   python3 /opt/kitty/backend/installer/cli.py --estimate --preset talking-h3 --json
   ```
   Show the user a short table: number of files, total GB, GB still to download, recommended volume size,
   monthly cost of that volume, and any gated models. Compare with the free space from step 1.
   - Not enough space: tell the user to grow the network volume in the Runpod console (Storage → the volume →
     Edit) to at least the recommended size. You cannot resize it from inside the pod.
   - Gated models: ask the user to accept the license (the `source` link of each model in `--list --json`) and to
     add a read token as `HF_TOKEN` to the pod's environment variables (Runpod: Edit Pod), or to `.env` before
     `runpod.py pod create`. Never ask them to paste it into the chat.

4. **Wait for an explicit yes**, then install:
   ```bash
   cd /opt/kitty/backend && python3 installer/cli.py --preset talking-h3 --gpu-profile 48gb
   ```
   For long downloads, run it under `nohup ... > /workspace/kitty/logs/agent-install.log 2>&1 &` and check
   the log every few minutes. If it stops, run the same command again: it resumes.

5. **Smoke test** each installed workflow's prerequisites through the handler:
   ```bash
   cd /opt/kitty/backend/docker && COMFY_URL=http://127.0.0.1:3020 python3 handler.py --local '{"action": "health"}'
   ```
   `ready_workflows` and `missing_models` tell you what works. A real render is optional: ask first (it uses
   GPU time), then e.g. `python3 handler.py --local '{"workflow": "simple-upscale", "inputs": {"image": "<an https image URL>"}}'`.

6. **Report**: what was installed, the volume size and monthly cost, which workflows are ready, and the app setting:
   the pod's ComfyUI URL is `https://<pod-id>-3020.proxy.runpod.net`.

## Without SSH: the installer API

The same steps over HTTPS (`$POD` = `https://<pod-id>-7861.proxy.runpod.net`, schemas at `$POD/api/docs`):

| Step | Call |
|---|---|
| 1. look around | `GET $POD/api/status`: the volume `setup`, ComfyUI and its GPU, free space, `ready_workflows`, `missing_models`, the install job |
| 2. choose | `GET $POD/api/catalog`: presets, workflows (with model ids), models (size, license, gated, installed) |
| 3. estimate | `POST $POD/api/estimate` with `{"preset": "talking-h3", "gpu_profile": "48gb"}` (or `"workflows": [...]`, `"models": [...]`) |
| 4. install (after the user's yes) | `POST $POD/api/install` with the same body; then poll `GET $POD/api/progress` every 30 s; `POST $POD/api/cancel` stops it |
| 5. check | `GET $POD/api/status` again: which workflows are ready |

`HF_TOKEN` cannot be sent through the API: for gated models (LTX 2.5) the user adds it to the pod's environment
variables (Edit Pod) before the install, or you use SSH. ComfyUI itself answers on `https://<pod-id>-3020.proxy.runpod.net`.

## Rules

- Never delete files on the volume unless the user asks for that exact path.
- Never print, log or commit tokens and keys. Over SSH the pod's environment variables (including `HF_TOKEN` if the
  user set it on the pod) are already in your shell: the image writes them to `/etc/rp_environment`.
- Install models only from the URLs in `models.json` (no other model sites, no private mirrors).
- If a command fails, show the user the last lines of the relevant log and the fix from `docs/runpod.md` → Troubleshooting.
