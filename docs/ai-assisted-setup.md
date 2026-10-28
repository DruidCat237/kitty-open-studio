# AI-assisted setup: hand the repository to your coding assistant

Your coding assistant (Claude Code, Codex, Cursor's agent, …) can do the whole setup. It reads
[AGENTS.md](../AGENTS.md) at the repository root (Claude Code through `CLAUDE.md`), asks what you want to make,
shows the download size, the GPU price per hour and the storage cost per month, and only after your yes creates
the Runpod volume and pod (or uses your own GPU), installs the models and checks which workflows are ready.

## What you need

1. This repository on your computer (`git clone https://github.com/DruidCat237/kitty-open-studio.git`) and your
   assistant opened in that folder.
2. For Runpod: an account ([sign up](https://runpod.io?ref=1yinrvfx)) with some credit and an API key (**runpod.io → Settings → API Keys → Create API Key**,
   read/write). Put it into a file named `.env` in the repository folder:

   ```
   RUNPOD_API_KEY=rpa_...
   ```

   The file is git-ignored. Do not paste keys into the chat; the assistant's tools read the file.
3. Only for gated models (LTX 2.5): accept the license on the model's Hugging Face page and add a read token to the
   same file: `HF_TOKEN=hf_...`.

## Ask your assistant

> Set up Kitty Open Studio for me on Runpod. I want to make music videos with talking characters and try FastH3
> Omni. Show me the costs before you create anything.

What it does, with `python backend/deploy/runpod.py` (every step that costs money is shown to you first as a dry run):

1. Maps what you want to a preset and shows the estimate: files, GB, recommended volume size, cost per month.
2. Checks the key and lists GPUs with price per hour and availability; proposes one.
3. Creates a network volume in a datacenter that has that GPU (Runpod network volume: **$0.07/GB/month up to 1 TB,
   $0.05/GB/month above**, billed while the volume exists, even with every pod stopped).
4. Creates a pod from the Kitty image on that volume. On its first start the pod puts ComfyUI, the node packs and a
   Python venv on the volume (30-60 minutes on a Runpod network volume, once) and downloads the chosen models at the same time.
5. Follows the setup and the download, then checks which workflows are ready and gives you the ComfyUI and
   installer links.
6. Optionally creates a serverless endpoint on the same volume for the Kitty app.
7. Stops the pod when you are done, so only the volume keeps billing.

## You already have a pod?

Give the assistant the pod id (it then talks to the installer over `https://<pod id>-7861.proxy.runpod.net`, no SSH)
or the pod's SSH command (Runpod: **Connect → SSH over exposed TCP**; add your public key under **Settings → SSH
Public Keys** first). [backend/AGENTS.md](../backend/AGENTS.md) covers both.

## Estimates without anything

The estimate needs nothing but this repository:

```bash
python backend/installer/cli.py --estimate --preset video
python backend/installer/cli.py --estimate --workflows fasth3-omni,h3-talk --gpu-profile 24gb --json
```

```
Models:            19 files, 116.5 GB (116.5 GB still to download)
Recommended volume: 180 GB (models + ~30 GB for ComfyUI, +20% headroom)
Monthly storage:   $12.60 for that volume ($8.16 for the models alone)
```
