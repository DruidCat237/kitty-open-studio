# Kitty Open Studio — plan for the cloud sessions

Our entry for **Comfy's October 2026 open-source app challenge** (comfy.org).
**Deadline: Fri 30.10.2026, 9:00 PT = 17:00 Polish time** (form: https://form.typeform.com/to/V1dSQrkS). Target: submittable by **Thu 29.10 evening**.
Repo: github.com/DruidCat237/kitty-open-studio (private until submission, then public).

> Naming rule: the product, the repo, the README, the code and the UI never use the name of the commercial service the challenge refers to (a trademark). Describe us as "an open-source AI video studio on ComfyUI".

Cloud sessions only see this repo. They cannot run a GPU, ComfyUI, Runpod or the Electron window: they build, type-check, lint, unit-test, write docs and CI. The owner tests on Runpod and records the demo.

---

## 0. What we are building

A self-hostable, open-source AI video studio. It is a desktop app built from the owner's own Kitty AI Studio 1.x (Electron, TypeScript), slimmed and renamed. It generates images, video, voice and music only through the user's own ComfyUI: local, a Runpod pod, or Runpod serverless.

It has two ways to work:
- **Studio**: pick an effect or model card, drop in a picture, video or audio, and generate. Results land in a feed or gallery, and no timeline is needed.
- **Editor**: the existing timeline (cut, captions, export).

An MCP server inside the app lets Claude (Desktop, Code) or ChatGPT direct it the way the old built-in agent did: from song to shot list to generations to the timeline, captions and export. The scenarios ship inside the MCP prompts and resources.

The backend is a user-configurable slim Docker image (ComfyUI plus a small job handler only) and a **model installer**: a web page on the pod where the user ticks the models to download to the network volume. Workflows are curated, open-weights and SFW, and share one visual style.

**Not shipped:**
- the built-in Gemini chat and Google auth
- paid or closed APIs: PoYo, Seedance, Veo, Kling, Nano Banana, GPT Image, ElevenLabs, MiniMax API
- druidcat.com credits, the WordPress plugin and the account system
- the music-structure analyzer (~400 MB)
- templates
- Remotion
- fine-tuned checkpoints
- CivitAI LoRAs
- NSFW
- "heretic"/abliterated text encoders

## 1. Decisions taken

- **Stay on TypeScript/Electron (Kitty 1.x); no Rust rewrite.** The MCP tools are re-implemented in TS after the owner's own Kitty 2 tool design.
- **Our own product.** Kitty Open Studio is the owner's work and is presented as such (not as a fork). The 1.x code base started long ago from an MIT starter template and has since been rewritten almost entirely. **Phase 2 audits it:** if any file or substantial portion of the original MIT template code still remains, keep one short MIT credit line in `THIRD_PARTY.md` (that is all MIT asks for; it is not branding); if nothing remains, no credit is needed.
- **License: MIT** for the app, the installer, the handler and the workflow JSONs. `THIRD_PARTY.md` lists every model and its license. Weights are downloaded by the user and never bundled.
- **Remotion is replaced with FilmCraft (upstream github.com/storytold/filmcraft, MIT OR Apache-2.0, pure Rust):**
  - **Export:** the app writes the timeline as **OpenTimelineIO** (`.otio`). `filmcraft-cli` (upstream, unmodified, shipped as a sidecar binary with its license and attribution) imports the OTIO and renders MP4/MOV with its own pure-Rust encoders. No ffmpeg and no GPL in the product.
  - **Preview:** a light in-app canvas/`<video>` compositor in the renderer (cuts, opacity, text and caption overlays, audio mix through WebAudio). Optional later: FilmCraft's WASM build (`apps/filmcraft-web`, WebCodecs) as the preview engine.
  - **CI:** a GitHub Actions workflow builds `filmcraft-cli` for Windows, macOS and Linux from a pinned upstream commit and attaches it to the release.
- **Voice and music** (licenses checked 25.10.2026 on the official pages):

  | Role | Model | License | ComfyUI | Notes |
  |---|---|---|---|---|
  | Default voice (**owner-approved**) | **VoxCPM2** (OpenBMB, 2B) | Apache-2.0 code and weights | community nodes (wildminder/ComfyUI-VoxCPM, RunningHub) | **Polish**, voice design + cloning, about 8 GB |
  | Newest voice | **Ming-3.0-tts** (inclusionAI, Oct 2026; 0.5B / tiny MoE) | MIT (0.5B card) | none yet: write a small custom node or a handler path | emotions, 14 paralinguistic tags, podcast dialogue (tiny); verify the tiny weights' license |
  | Extra voice | Qwen3-TTS (0.6B/1.7B) | Apache-2.0 | community | voice design |
  | Optional "drama" | Fish Audio **Drama 3** (Oct 13, 35B MoE / 3B active, up to 16 speakers) | **Fish Audio Community License** (custom: revenue cap, hosted service needs a separate license, "Built with Fish Audio") | community ComfyUI-Drama3 (local, 8 GB) | opt-in card with a license warning; never the default |
  | Music (**owner-approved**) | **ACE-Step 1.5** | Apache-2.0 | **native** | 10 s to 10 min songs with vocals, fast |
  | Music 2 | **HeartMuLa** 3B (+ MuLaCover) | Apache-2.0 | community node | songs from lyrics |
  | Not used | YuE2 (CC-BY-NC weights), VibeVoice (research-only) | — | — | — |

- **Speed showcase: FastH3 Omni** (FastVideo/Nuva Lab, released Oct 2026). An 8-step distillation of MiniMax H3: text plus ordered references (up to 9 pictures, 3 videos, 3 audio clips; `<Picture 1>`/`<Video 1>`/`<Audio 1>` in the prompt) produces video with synced 32 kHz stereo audio at 24 fps, with guidance 1.0 and shift 12 (video) / 3 (audio).
  - **ComfyUI-native files:**
    - `FastVideo/FastH3-Omni-FP8-Comfy`: `diffusion_models/fasth3_omniref_fp8_comfy.safetensors`
    - or `FastVideo/FastH3-Omni-Comfy`: `fasth3_omniref_8step_pruned_int8_convrot.safetensors` / `_bf16`
  - **Plus, from the same repo:** `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors`, `vae/minimax_h3_video_vae_fp16.safetensors` and `vae/minimax_h3_audio_vae_fp32.safetensors`.
  - **Nodes:** current ComfyUI with native MiniMax H3 and the "MiniMax H3 Reference to Video" node.
  - **Optional speed-ups:** LightVAE (Apache-2.0, faster H3/Wan decoders), Spark-H3 (Apache-2.0, block-sparse attention for H3), and the NVFP4 QAD variant for Blackwell cards.
  - **License:** the MiniMax H3 Community License (open weights, custom terms; list it in `THIRD_PARTY.md`).
  - **Card in the app:** "Instant scene with sound" with a big **speed badge**, timed on the owner's Runpod GPU.
- **Optional FLUX bonus:** FLUX 3 Image Klein (5.6B open weights, Oct 15). Add it as an image card only if its license allows; check that first.

## 2. Challenge angle

- **Best Overall ($10k)** and **Most Innovative (RTX 5090)**: a complete, open, self-hostable AI studio, where your AI assistant (Claude or ChatGPT over MCP) directs a music video end to end on your own GPUs. The demo must explain why that is new.
- **Open Weights Only (RTX 5090)**: every generation runs on open weights through ComfyUI. Claude and ChatGPT are optional external clients.
- **Bonuses** (they stack with a main category):
  - **VFX with LTX ($2k):** LTX 2.5 as the core model, as VFX presets (FLF transitions, v2v restyle/upscale, custom-audio I2V).
  - **MiniMax H3 ($1k credits):** H3 Character Swap, H3 talking/R2V, and **FastH3 Omni**.
  - FLUX ($1k/$500/$250 credits): FLUX 3 Klein, if added.
- **Judges must be able to run it:** a one-page README, a 3-command local start, a Runpod guide with screenshots, and a 2-minute demo.

## 2b. Your mandate: think, extend, improve (every session)

You are not a typist for this plan. **Treat it as a starting point and make it better**, especially wherever judges will look.

Before coding, spend a few minutes as a judge would:
- open the repo cold;
- read the README top to bottom;
- picture the 2-minute demo.

Then improve the plan where it helps win, and write your changes back into PLAN.md under "Changes by session N" with a one-line reason each. Decisions in section 1 stand unless you find a hard blocker; explain it if you do.

**What judges are likely to weigh, so optimise for it:**
- **First 30 seconds:**
  - a README hero GIF;
  - a one-line pitch;
  - "Run it in 3 commands" (local) and "Deploy on Runpod in 10 minutes";
  - badges: license, ComfyUI, open weights.
- **It obviously works:**
  - every Studio card has a sample result (thumbnail/GIF) in the docs;
  - no dead buttons;
  - clear empty states and errors ("ComfyUI not reachable — check URL" instead of a stack trace).
- **Delight (Most Viral):**
  - Studio feels like a consumer app: big cards, before/after previews, one-click "Remix", a generation feed;
  - a FastH3 Omni speed badge with the real seconds;
  - a "make a music video from this song" one-button flow driven by MCP.
- **Novelty (Most Innovative):**
  - MCP-directed production (an assistant plans, generates, cuts and captions);
  - AI-assisted SSH setup with a storage cost estimate;
  - optional local green-screen keying (CorridorKey).
- **Openness (Open Weights Only):**
  - a visible "100% open weights" toggle or badge and a model licence table;
  - nothing calls a paid API.
- **Bonus fit:**
  - LTX 2.5 front and centre for VFX presets;
  - MiniMax H3 / FastH3 Omni front and centre for character and talking cards.
- **Polish:**
  - consistent naming and icons;
  - dark theme;
  - keyboard shortcuts;
  - accessible contrast;
  - fast startup;
  - small download;
  - screenshots in the docs;
  - CONTRIBUTING.md and good first issues.

**Ideas you are encouraged to add if cheap:**
- a first-run onboarding wizard (choose local, pod or serverless → test the connection → pick a starter preset);
- "estimated GPU time" on each card;
- a gallery or share export (MP4 + prompt card);
- prompt helpers with clickable tags (`<Picture 1>`…);
- a "Copy MCP config" button for Claude/ChatGPT.

Keep scope honest. A polished small thing beats a broken big thing, and the deadline is fixed.

## 3. Phases — one cloud session each (~$100 cloud credit)

| # | Session | Budget | Done when |
|---|---------|--------|-----------|
| 0 | **Local** (owner's machine): stage the sources into the repo | local | `sources/` pushed, secret scan clean |
| 1 | Backend: workflows, model manifest, installer, configurable Docker, Runpod guide, FastH3 Omni | ~$25 | `backend/` complete; py_compile + JSON validation pass |
| 2 | App: strip/rename 1.x, ComfyUI client, Studio mode, OTIO export + FilmCraft sidecar | ~$30 | `npm run build` + `tsc` green; the paid-API grep gate is empty |
| 3 | MCP server, scenarios, docs | ~$20 | tools listed by `npx @modelcontextprotocol/inspector`; README |
| 4 | Voice/music workflows, lightweight beat detection, polish and bug fixes | ~$15 | voice and music cards work in the manifest |
| — | Reserve | ~$10 | fixes after the owner's Runpod test |

Each session reads this file and `sources/README.md` first, works on a branch, ends with a PR and a short report, and never pushes secrets, NSFW or model weights.

### Phase 0 — local staging (owner's machine, NOT cloud)

Copy into ``sources/`:
- `app-1x/`: `Druidcat-Kitty-AI-Studio-App` without `node_modules`, `.next`, `dist*`, `.env.local`, `local-media` or `wordpress-plugin`.
- `workflows/`: the curated UI + API JSON pairs (section 4).
- `style-reference/`: 2-3 workflows from `D:\ComfyUi_Hub\druidcat_scripts nowe September\druidcat_scripts`, as a look reference only. The originals are untouched.
- `models-from-install.sh.txt`: the download lines from `install.sh` with **every token removed**.
- `handler-reference.py`: the ComfyUI queue/poll/upload parts of `handler_animate.py`, without endpoints or keys.
- `kitty2-mcp-reference/`: Kitty 2 `agent-tools.json`, `knowledge.json` and `kinetic-reel.md`, without prices or druidcat.com links.
- **Secret gate before the push:** grep for `hf_`, `token=`, `Bearer`, `sk-`, `rpa_`, `AKIA`, Runpod endpoint ids, druidcat API keys and the trademark word. It must find nothing.

### Phase 1 — backend (`backend/`)

1. **Curate the workflows** (section 4). Fine-tuned checkpoints are swapped for the base model or the workflow is dropped. CivitAI LoRAs go; public HF LoRAs such as turbo/lightning/people can stay. Standard text encoders replace the heretic ones. Nothing NSFW.
2. **Restyle the UI workflows.** Reposition the newer ones for a clean left-to-right flow and use one consistent group color scheme. Add **no text notes above columns**. Add only **one orange note box** ("Support Druid Cat on Patreon" + link), like the style reference.
3. **FastH3 Omni workflow** (UI + API): references → "MiniMax H3 Reference to Video" → 8 steps, cfg 1, shifts 12/3 → video + audio save. Include an FP8 and an INT8-convrot variant, and an optional LightVAE decode.
4. **`models.json` manifest**: id, display name, url, size, sha256 if known, target folder, license, the workflows that need it, group (image/video/voice/music/upscale/speed), and minimum VRAM.
5. **Model installer**: FastAPI + one static page on the pod (`python installer/app.py`, port 7861).
   - Model cards with checkboxes and size totals.
   - Presets: "Starter 60 GB", "Video", "Talking + H3", "Everything".
   - "Only missing", a progress bar per file, resume, and a free-space check.
   - A CLI (`installer/cli.py --models ...` or `--preset ...`) for scripted and serverless builds.
   - `HF_TOKEN` is read from the environment only when the user sets it.
6. **Configurable Docker** (`backend/docker/`):
   - The image holds ComfyUI, the required custom nodes and `handler.py`, a generic Runpod handler: `{workflow, inputs}` → patch the API JSON from the manifest's input map → run → return URLs or base64.
   - **Everything is configurable by environment variables, with an `.env.example`:**
     - `COMFY_PORT`
     - `MODELS_DIR` (network volume path)
     - `CUSTOM_NODES` (extra node repos)
     - `INSTALL_PRESET` / `INSTALL_MODELS` (auto-install on first boot)
     - `HF_TOKEN` (optional)
     - `OUTPUT_MODE` (s3 | base64)
     - `S3_*` (optional)
     - `ENABLE_INSTALLER_UI`
     - `ATTENTION` (sdpa | sage)
     - `GPU_PROFILE` (24gb | 48gb | 80gb, which picks FP8/INT8 variants)
   - Also a `docker-compose.yml` for local GPUs and a Dockerfile that builds with build args.
   - **One image, two modes**, `MODE=pod|serverless`. Base it on the owner's references in `sources/docker-reference/`:
     - **pod** (from `pod-jupyter/`): **JupyterLab on 8888** (token/password from env, empty by default as in the owner's setup), ComfyUI on 3020, and the installer UI on 7861. This is what users open first on Runpod to install models and test.
     - **serverless** (from `serverless/`): Runpod handler only, models from the network volume, the same base image.
     - Python env: follow `sources/venv-reference.md` (venv on the volume, torch 2.8 cu128, the constraints-file rule for every custom node, optional SageAttention build).
     - Keep the owner's proven fixes: install `cryptography` with `--ignore-installed` before `runpod`; Blackwell env (`PYTORCH_CUDA_ALLOC_CONF`, `TORCHDYNAMO_DISABLE`); never upgrade the Debian pip; pin tokenizers if a node pulls a newer one.
7. **Storage and AI-assisted setup:**
   - `docs/s3.md`: step-by-step S3 setup for outputs and inputs: Runpod network volume S3-compatible API, or Cloudflare R2 / AWS S3 (bucket, access keys, CORS, which env vars to fill).
   - `docs/ai-assisted-setup.md` + `backend/AGENTS.md`: the user's own coding assistant (Claude Code, Codex, etc.) connects to the Runpod pod over **SSH** and does the install. It asks which models the user wants, shows the disk size and the **monthly storage cost** (Runpod network volume: $0.07/GB/month up to 1 TB, $0.05/GB/month above; verify on runpod.io/pricing, and note that volumes are billed while pods are stopped), recommends a volume size with headroom, then runs `installer/cli.py`.
   - `installer/cli.py --estimate --models ... | --preset ...`: prints the total GB, the recommended volume size and the monthly cost, as plain text and JSON, so an assistant can read it.
8. **Docs:**
   - `docs/runpod.md`: (a) a GPU pod with a network volume, run the installer, test in the ComfyUI UI; (b) the same volume on a serverless endpoint from the image, with every env var explained and screenshots placeholders; (c) local ComfyUI.
   - `docs/docker.md`: building and configuring the image yourself.

### Phase 2 — app (`app/`)

1. Start from `sources/app-1x`. Rename (product name, appId, icon placeholder) and set the version to 0.1.0.
2. **Remove:**
   - the Gemini/Vertex agent and chat UI
   - ElevenLabs
   - every provider adapter except ComfyUI
   - credits, balance, account and WordPress code
   - templates
   - the music analyzer
   - Remotion and `google-auth-library`

   **Gate:** this grep must return nothing in `app/src`:
   ```
   grep -riE "poyo|seedance|veo|kling|elevenlabs|vertex|gemini|wp-json|remotion"
   ```
3. **ComfyUI client.** Settings take a "Local ComfyUI URL" or a "Runpod serverless endpoint + API key". The client loads the backend manifest, maps the UI fields to API-JSON node inputs, uploads the inputs, polls, and downloads the outputs into the project.
4. **Studio mode:**
   - a card grid by category: Image, Edit, Video, Talking, VFX (LTX), Character Swap (H3), **Instant scene + sound (FastH3 Omni, speed badge)**, Upscale, Voice, Music;
   - one-screen forms, with hover hints that show each input's prompt tag;
   - a generation feed with re-run, upscale and "send to timeline".

   The existing timeline stays as the Editor.
5. **Export:** timeline → `.otio` → bundled `filmcraft-cli` → MP4. Show progress, and keep a simple fallback message if the sidecar is missing. **Preview:** the canvas compositor.
6. **Small fixes and polish** from the 1.x backlog.

### Phase 2b — optional add-on: local green-screen keying (CorridorKey 2.0)

The **code** ships in the app. The **models and the Python environment** are never in the repo or the installer: the user installs them on demand from inside the app.

- **Source:** github.com/nikopueringer/CorridorKey2.0, branch `master`. Pin a commit; there is no pyproject.
- **Install dialog** (Settings ▸ Add-ons ▸ "Green screen keying (CorridorKey 2.0)"). Before anything is downloaded it shows:
  - NVIDIA CUDA only, RTX 30-series or newer (bf16). VRAM: 4 GB up to 1440p, 6 GB for 4K.
  - About **10 GB on disk** in total: Python env + torch + weights. Show the exact install path.
  - The **license**: a CC BY-NC-SA 4.0 variant. Commercial use of the *results* is OK. Selling the model or offering it as a paid API/inference service is not allowed, and integrating it into commercial software needs an email to contact@corridordigital.com. It runs only locally on the user's own GPU.
  - Install only after the user confirms.
- **Install** (Electron main process, with a progress bar per step and per file, resumable, cancelable):
  1. A **uv-managed venv** under the app data dir: `<userData>/addons/corridorkey/{venv,repo,weights,vfms}`.
  2. torch==2.9.1 + torchvision==0.24.1 from `https://download.pytorch.org/whl/cu128` (**cu126** if the GPU compute capability is < 7.0).
  3. The repo's `requirements.txt`. Install utils3d from the zip `https://github.com/EasternJournalist/utils3d/archive/83bfa5bda008803f6521ce9547f94023b8afeddd.zip`, so no git is needed.
  4. Weights (about 5 GB, all public HF, **no token**):

     | Model | Source | Destination |
     |---|---|---|
     | CorridorKey v2 | `nikopueringer/CorridorKey2.0` | `weights/corridorkey_v2.safetensors` (2.66 GB) + `weights/foundation_stats.safetensors` |
     | C-RADIOv4 | `nvidia/C-RADIOv4-SO400M` @ `c0457f5dc26ca145f954cd4fc5bb6114e5705ad8` (skip `*.pth.tar`) | `vfms/cradio/C-RADIOv4-SO400M/` |
     | MoGe-2 | `Ruicheng/moge-2-vitb-normal` @ `ca5f0e07ff01d3e5a364c1d954ed12ee1814b368`, file `model.pt` | `vfms/moge/model.pt` |
     | RVM small | `https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz` (verify MD5 base64 `ZJb6kj8+tasiJbVeplXu7Q==`) | `vfms/rvm/` |

     All paths are relative to the CorridorKey repo root.
  5. A "Remove add-on" button that frees the space, plus a size readout.
- **Use:** right-click a video clip on the timeline ▸ "Key green screen (local)". The app renders the clip's trimmed range and runs:

  ```
  python infer.py --input clip.mp4 --output_dir out --outputs cutout [--low_vram] [--despill_strength 0..1]
  ```

  It shows progress and imports `out/<clip>_cutout.mov` (ProRes 4444, straight alpha) as a new clip above the original. Optional hint: `--hint_first_frame`. infer.py needs ffmpeg: point `--ffmpeg_bin` at a bundled or system ffmpeg, or ask the user.
- **Never** route this through any paid service. It is listed in `THIRD_PARTY.md` as an optional, user-installed, non-commercial-licensed add-on.

### Phase 3 — MCP (`app/electron/mcp/`)

- A Streamable HTTP MCP server on `127.0.0.1` inside Electron, plus a stdio bridge for Claude Desktop.
- **Tools** (after Kitty 2): list workflows (with prompt tags and guides), generate, job status, media library, timeline state, plan/place blocks, captions, audio info, analyze audio (lightweight beats/sections), export.
- **Prompts and resources:**
  - the music-video playbook (song → sections → shot list → generate → place on beats → captions → export);
  - a prompt guide per workflow (H3 `<Video 1>`/`<Picture 1>`, FastH3 `<Picture N>`/`<Video N>`/`<Audio N>`, slot syntax per model);
  - cost and time hints in GPU minutes.
- **Docs:** Claude Desktop/Code config snippets; ChatGPT through a developer-mode connector over an HTTPS tunnel.

### Phase 4 — voice, music, beats, polish

- Voice and music workflows from section 1, each with a license note. Drama 3 is opt-in with its license warning.
- Beat/onset/section detection in the app (about 1 MB of JS: energy and onset novelty), replacing the 400 MB model.
- README polish, GIFs, `THIRD_PARTY.md`, `CONTRIBUTING.md`.

### Phase 5 — owner (local)

1. Test on Runpod.
2. Time FastH3 Omni for the speed badge.
3. Record the 2-minute demo.
4. **Squash the git history into one fresh commit** (the staging history names private LoRAs and encoders), then make the repo public.
5. Post.
6. Submit through the challenge's Typeform before **Fri 30.10, 17:00 PL** (aim for Thursday).

## 4. Workflow curation (starting list — verify each file)

**CORE** (base/official models, keep):
- Qwen Image 2.1 t2i / edit / inpainting
- FLUX 3 Image Klein (text to image, edit with up to 4 references; added Oct 28)
- FireRed Image Edit 1.1, Qwen 2511 Camera Multi-Angle (single/multi)
- LTX 2.5 T2V / I2V / FLF (custom audio), LTX 2.5 v2v Upscaler
- MiniMax H3 i2v, H3S talk fast, H3 Character Swap v2, MiniMax H3 R2V, **FastH3 Omni (new)**
- InfiniteTalk v3.1 (+ V2V)
- Wan 2.2 FLF, Wan 2.2 I2V fast, Wan 2.2 SVI Pro 30 s, Wan 2.1 SCAIL-2 Loopable, SCAIL dance multi-person
- Frame Interpolation (green screen: CorridorKey add-on in Phase 2b, not MatAnyone/VideoMaMa)
- SeedVR2 image/video upscale, Simple Upscale, Qwen Upscale, video upscale with restore (FlashVSR)
- **RTX image/video upscale** (owner requirement; `RTXVideoSuperResolution` + `nvidia-vfx`, NVIDIA's proprietary but free SDK): ship it as a fast Upscale card, label it "NVIDIA RTX" and keep it out of the "100% open weights" profile

**CHECK** (inspect models and LoRAs first):
- Ideogram 4 + LoRA
- Z-Image face inpaint with LoRA
- Qwen Camera Angle Editor / Change Clothes LoRA
- Wan 2.2 Animate V2 long loop, Wan 2.2 enhancers

**EXCLUDE:** uncensored or fine-tuned checkpoints and LoRAs of unknown origin, superseded models (LTX 2.3, replaced by
2.5), non-commercial upscalers (FLUX.1-dev based), templates, hidden and backup files.

## 5. Rules for every session

- Never push secrets, model weights, NSFW content, the owner's private endpoints or the trademark name.
- Model files are never committed; only the manifest with URLs.
- `sources/` was a private staging copy of the owner's originals; it is not part of the published repository.
- Prefer small, working, documented pieces over big unfinished ones. The deadline wins.

---

## Changes by session 1 (Phase 1, backend)

Done: `backend/` (workflows, `models.json`, `custom_nodes.json`, installer, Docker image, handler, tests, CI), `docs/runpod.md`,
`docs/docker.md`, `docs/s3.md`, `docs/ai-assisted-setup.md`, `backend/AGENTS.md`, generated `docs/models.md` + `docs/workflows.md`.

- **One source of truth for cards: `backend/workflows/index.json`.** Every API graph has an id, category, summary, VRAM/GPU-time estimate, prompt tags and an *input map* (form field → node input). The handler, the app (Phase 2) and the MCP tools (Phase 3) all read it; adding a workflow is JSON only. Reason: no per-workflow Python branches like the old handler.
- **Generic handler talks to ComfyUI only over HTTP** (`/upload/image`, `/prompt`, `/history`, `/view`). Reason: the same code serves a local ComfyUI, a pod and serverless; `{"action": "health"}` reports GPU and missing models for the app's "Test connection".
- **Official encoders instead of the abliterated ones:** H3 → `qwen3vl_32b_minimax_h3_int8_convrot` (Comfy-Org/MiniMax-H3), LTX 2.5 → `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot` (Lightricks). Reason: section 4 rules; both are the publishers' own files.
- **FLUX 3 Image Klein comes from BFL's gated `black-forest-labs/flux-3-image-klein-comfy`** (FLUX Kommunity License: the installer links the license page and needs HF_TOKEN). INT8 by default, BF16 on the 80gb profile.
- **Removed LoRAs without a public HF source** (5 files) from the API graphs and rewired; in the UI graphs they stay as bypassed, empty "Optional LoRA slot" nodes. Reason: users can still add their own LoRA.
- **RTX Video Super Resolution stays (owner decision, replacing the earlier lanczos swap):** `ltx25-v2v-upscale` uses it again by default, and two new Upscale cards badged **NVIDIA RTX** (`rtx-image-upscale`, `rtx-video-upscale`, from the RTX pack's own examples) bring the total to 41 workflows. The node comes from Comfy-Org's `Nvidia_RTX_Nodes_ComfyUI` (Apache-2.0, pinned) with NVIDIA's proprietary `nvidia-vfx` SDK, installed by default from pypi.nvidia.com (`INSTALL_NVIDIA_RTX=false` leaves both out); `THIRD_PARTY.md` and `docs/nodes.md` mark it proprietary. `index.json` gained `profiles`: `open-weights` ("100% open weights") hides the cards with the `nvidia-rtx` badge and makes the handler swap RTX VSR for a lanczos resize of the same size; the same swap (with a warning in the job result) happens on a worker without `nvidia-vfx`. The pack 0.2 added `strength` and `image_encoding` inputs, filled in by the curation script.
- **GPU profiles in the manifest**: `24gb` swaps in FP8 files, `80gb` BF16, default INT8 ConvRot/FP8; the installer downloads and the handler loads the matching file. H3 i2v now defaults to INT8 (`minimax_h3_fl2va_pruned_bf16` was 40 GB and had no URL).
- **FastH3 Omni is core-ComfyUI-only** (no Power Lora / custom nodes): Euler, simple, 8 steps, BasicGuider (cfg 1), `ModelSamplingMiniMaxH3` 12/3 as in the FP8 repo's validation; picture slots 1-2 + up to 7 more, Video 1 (with its sound), Audio 1; LightVAE lite decoder as a second API graph and as a bypassed node in the UI graphs. The FP8 file is `FastVideo/FastH3-Omni-FP8-Comfy/fasth3_omniref_fp8_comfy.safetensors`.
- **Presets:** added `instant` (FastH3 Omni, 58 GB). `starter` = Z-Image Turbo + 4K upscale, SeedVR2, Real-ESRGAN and InfiniteTalk (59.5 GB, no HF token, so the first run never hits a gated model).
- **LTX 2.5 is gated on Hugging Face** (license click + `HF_TOKEN`), and HF hides gated checksums from anonymous requests: `python backend/tools/manifest.py refresh` with a token fills them in. Docs say so up front.
- **Light image, everything heavy on the volume (owner decision, replacing "ComfyUI inside the image"):** the image is Runpod's `runpod/base:1.4.1-cuda1281-ubuntu2404` plus tini, the image-Python packages for the installer and handler (runpod, boto3, fastapi, uvicorn) and the Kitty scripts: a push uploads tens of MB instead of GBs, because the base layers are mounted from `runpod/base` on Docker Hub. On a pod's first start `docker/setup_volume.py` clones ComfyUI and the node packs at their pins to `/workspace/ComfyUI` and builds `/workspace/venv`, the layout of the owner's proven setup; `kitty/setup.json` records what is there, so later starts take seconds and a newer image reinstalls only what changed. Serverless workers link `/workspace` to `/runpod-volume` and only read it (`setup_volume.py --check`; an unprepared volume gives every job a "start a pod once" error). The installer page and `/api/status` show the setup step; `runpod.py pod wait` waits for it. Local Docker: the venv in a Docker volume, models in `backend/docker/models`. Reason: the owner's push was GBs and slow; models, ComfyUI and the venv are configured on the volume anyway.
- **Pod mode starts `sshd` from Runpod's `PUBLIC_KEY`**: our entrypoint replaces Runpod's own, which would otherwise drop SSH, and AI-assisted setup needs it.
- **`docs/models.md` (license table) and `docs/workflows.md` (card catalog) are generated and checked in CI.** Reason: the "Open Weights Only" judges see every license, with non-commercial/community ones flagged (PixelDiT, Qwen Image 2.1, MiniMax H3, LTX-2, FLUX 3 Klein).
- **Default prompts made SFW and on-brand** (the SVI 30 s shot list is now a ginger cat explorer), Polish/Chinese titles translated.
- **UI layout:** 35 of the 39 UI graphs auto-laid out left to right in five colored steps; four hand-made layouts kept (Character Swap, Six Camera Angles, SVI 30 s, InfiniteTalk V2V) and recolored.
- **The six API-only workflows got UI graphs** (Wan FLF, Wan I2V fast, SCAIL-2, SCAIL dance, SeedVR2 image, SeedVR2 4K), built by `backend/tools/api_to_ui.py` from ComfyUI's `/object_info` with the editor's own widget rules (checked against the real frontend). Reason: every card is also editable in ComfyUI; a test fails if one of these API graphs changes and `--regenerate` was not run.
- **`green-screen` (MatAnyone + VideoMaMa) removed** with both node packs and the SAM2 checkpoint (owner decision: green screen is the CorridorKey add-on, Phase 2b).
- **Everything validated against a real ComfyUI** (0.42.0 + all 34 packs, CPU harness in `backend/tools/live/`, no GPU needed): 231 node classes come from the packs `custom_nodes.json` names; 39 workflows × 5 variants (as shipped, required inputs only, all inputs, `24gb`, `80gb`) pass `/prompt` validation; all 39 UI graphs load in the real frontend with no missing nodes, and the prompts the editor queues from them validate too. Reason: catches schema drift and broken graphs before anyone pays for a GPU.
- **What that found and fixed:** new required inputs in RIFE VFI and SAM3Segment; three node classes listed under the wrong pack; SAM3 also read from `models/sam3` (`also_in` hardlink, no second download); InfiniteTalk, H3 talk and Z-Image UI graphs saved with other settings than their API graphs (synced; InfiniteTalk's pointed at a 720p model we do not ship); Z-Image's refine subgraph had lost its model/latent links (the editor could not queue it); SVI 30 s segments 3-5 had segment 6's prompt; pack installers ran with the wrong Python and could replace torch (now ComfyUI's interpreter + `PIP_CONSTRAINT`).
- **ComfyUI and every node pack are pinned** in `backend/custom_nodes.json` (`comfyui.ref` + a commit per pack) to exactly what was validated; the Dockerfile reads the ComfyUI pin. Reason: a build on submission day must not pick up an untested master.
- **Python setup follows `sources/venv-reference.md` (owner decision, replacing the torch 2.13 + cu130 base):** a Python 3.11 venv on the volume with `torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0` from the cu128 index, ComfyUI's requirements and its `comfy*` packages upgraded within their pins, accelerate/diffusers/huggingface_hub before the freeze, then every node pack's requirements under the freeze of transformers, tokenizers, torch*, numpy, huggingface-hub, safetensors, accelerate, diffusers plus the version windows in `docker/venv-constraints.txt` (numpy 1.26.4, pillow < 12, protobuf < 6, transformers 4.57, tokenizers 0.22, onnxruntime-gpu 1.20.2, opencv < 4.12, ...); `--no-build-isolation` for sam2 and groundingdino; the reference's "do not carry over" packages (closed API SDKs, training tools, web UIs, taichi, mss, ...) are filtered out of the packs' requirements; afterwards protobuf < 6, GPU-only onnxruntime and one opencv build; `pip check` in the log. SageAttention (`ATTENTION=sage`) is the reference's source build with torch's CUDA check silenced only while compiling, once per volume and GPU arch. One exception to the reference: ComfyUI 0.42 requires `av>=17` (the reference pins `<17`), so ComfyUI's pin wins. Trade-off to know: ComfyUI 0.42 enables comfy-kitchen's fastest FP8/INT8 CUDA kernels only on cu130 torch, so INT8 ConvRot / FP8 models run on its slower fallback with cu128; `TORCH_PACKAGES` / `TORCH_INDEX_URL` switch it if the GPU test shows it matters.
- **Fill-Nodes is gone:** the curated set only used its `FL_FloatToInt` (LTX v2v frame rate), and the pack imports fal/openai/google-genai SDKs at load time, which the reference keeps out of the venv. ComfyUI's own `ComfyNumberConvert` does the same; 33 packs + the RTX pack.
- **Public image and templates**: the image is ready to publish (`docs/docker.md` → Publish the image; GitHub Action with a build-only switch, provenance off so Runpod gets one plain manifest), and `docs/runpod-template.md` has the pod/serverless template fields plus the README for a public Runpod template. Reason: the owner publishes the image and a public template before the GPU test.
- **JupyterLab needs a token now** (`JUPYTER_TOKEN`, or `JUPYTER_PASSWORD` which Runpod sets via *Start Jupyter notebook*; `JUPYTER_DISABLE_AUTH=true` to opt out), changing the plan's "empty by default". Reason: Runpod's proxy URL is reachable by anyone who has it (Runpod's own image says so and keeps Jupyter off without a password); a public template must not hand out root shells.
- **Agent-friendly pod**: the installer's `/api/status` answers in one call what is ready and what is missing, `INSTALL_PRESET` now runs as the installer's own job (progress on port 7861 and `/api/progress`), and the pod's environment is written to `/etc/rp_environment` so SSH sessions see `HF_TOKEN`/`GPU_PROFILE`. `backend/AGENTS.md` describes both ways in (HTTP API, SSH). Reason: the goal is that a user hands the repo to their AI assistant and it does the setup.
- **`docs/nodes.md`** (generated, checked in CI) lists ComfyUI and every node pack with commit and license. Six packs have no license file (ComfyLiterals, Comfyroll, JPS-Nodes, MelBandRoFormer, SCAIL-Pose, LightVAE); the first three only provide literal/text/seed nodes and can be swapped for core nodes. *Owner: decide before the image goes public.*
- **"Hand the repo to your assistant" setup**: root `AGENTS.md` (Claude Code reads it through `CLAUDE.md`) walks an assistant through the whole setup in the user's language: goal → preset → estimate → Runpod volume and pod (or local Docker / an existing ComfyUI) → install → ready check → stop. `backend/deploy/runpod.py` does the Runpod part with the user's `RUNPOD_API_KEY` from a git-ignored `.env`; everything that costs money is a dry run until `--yes`. It uses Runpod's REST API **v2** (v1 is retired on 15.11.2026, GraphQL in 2027), whose catalog gives price, stock and data centers with network volumes for CUDA 13 hosts. *Not yet run against the real API (the cloud session cannot reach Runpod): first thing in the GPU test.* Reason: the owner wants users to get a working studio by giving the repository to Claude.
- **Image name `druidcat/kitty-open-studio`**, built and pushed with `docker buildx bake --push` from `backend/docker` (compose file + `docker-bake.hcl`), the owner's usual flow.
- **The volume setup was run for real in the CPU harness** (same recipe, PyPI's identical cu128 torch wheels because download.pytorch.org is blocked there): 12 min 22 s on a slow link, an 11 GB venv, `pip check` with only harmless leftovers; then `start.sh` itself in pod mode (setup "up to date" in seconds, Blackwell patches applied with the venv's Python, ComfyUI 0.42.0 from the venv, the installer showing the setup) and in serverless mode (`--check`, ComfyUI from the venv, the handler running a job through a stand-in `runpod`). Against that ComfyUI: 232 node classes, 0 missing; 41 workflows × 5 variants, 0 validation failures; the changed and new UI graphs load in the real frontend with no missing nodes and their editor prompts validate. It found and fixed: a new diffusers pulled huggingface-hub 2.x and broke transformers 4.57 (windows now `huggingface-hub<1.0`, `diffusers<0.40`), and RMBG's `nobg` (wants hub 1.x) made pip skip all of RMBG's requirements (a pack's requirements now fall back to one by one). `nvidia-vfx` could not be fetched there (pypi.nvidia.com blocked), so the RTX node ran on a test stand-in: the first real RTX run is the GPU test.
- **SolarRenderer card (`solar-render`, owner request)**: Enderfga's SolarRenderer turns a structure video (grey boxes, segmentation, skeletons, depth, a sketch) into a finished clip on MiniMax H3 in four steps. Built from the authors' own low-memory ComfyUI workflow: the official `minimax_h3_ref2va` INT8 + Qwen3-VL INT8 we already ship, plus the control and four-step LoRAs (4.15 GB each, MiniMax H3 Community License) and the authors' node pack (Apache-2.0, pinned); the six-part prompt is built by their prompt node from a summary and a 350-500-word description. In the Talking + H3 preset and Everything. Validated in the harness (`/prompt`, the editor round trip). **MiniMax H3 Singularity V2** (community fine-tune of H3, approved by the owner) is a second model choice in `solar-render` and `h3-r2v` (`model` input; the pruned INT8 file, pinned to a commit); its card says Apache-2.0 but H3's license governs derivatives, so the manifest lists it under the H3 license. Not added yet: the long-clip causal LoRA pair (+8.3 GB; a second card later) and SelfLift / TST (experimental for H3 by their own README).
- **H3 Community License, territories**: SolarRenderer's card repeats that the MiniMax H3 Community License excludes the EU, the UK, the Republic of Korea and the United States. *Owner: check this for H3, FastH3 and SolarRenderer before the demo (the owner is in the EU).*
- Known, harmless for now: ComfyUI_essentials and controlnet_aux want different `albucore`/`albumentations` versions (both import); rembg declares the CPU `onnxruntime` that is swapped for `onnxruntime-gpu`; Frame-Interpolation's installer cannot build `cupy-wheel` (RIFE does not need it); SeedVR2 only imports with a GPU present (CPU harness patched, pods are fine).
- **Wan 2.2 SVI Pro 30 s removed (owner: outdated)**: card, graphs and its three LoRAs (SVI Pro high/low, lightx2v 4-step v1030) are gone.
- **SCAIL dance removed in favour of SCAIL-2 Loopable (owner)**: card, graphs, its six models (SCAIL preview Q8, lightx2v rank-128 LoRA, NLF, ViTPose, YOLOv10m, YOLOX) and the two packs only it used (ComfyUI-SCAIL-Pose, ComfyUI-WanAnimatePreprocess); 39 workflows, 78 models (623 GB).
- **First run on a real RTX 5090 pod (27.10.2026)**, through `backend/tools/smoke_test.py` from outside the pod. Fixed on the way:
  - ComfyUI 0.42 / pack incompatibilities, patched at start by `blackwell_patches.py`: Qwen 3.5 decode (comfy-kitchen refuses the KV cache on the cu128 build: torch fallback), ComfyUI-GGUF in Wan's fused feed-forward (`comfy_force_forward`), VideoHelperSuite on videos without sound;
  - renamed options and multi-GPU-only values (`9:16 (Portrait Widescreen)`, `gpu:0`, SageAttention in three Wan cards), and the handler now fails a job whose outputs did not all validate;
  - card bugs: Wan FLF swapped first/last frame;
  - quality: H3 cards at H3's native 0.98 MP instead of the 0.4 MP draft size, sizes follow the input picture or video (Wan, InfiniteTalk, aspect choices), Wan at its 720p pixel count.

### Owner checklist for the Runpod test (Phase 5)

1. Build and push the image: `cd backend/docker && docker buildx bake --push` (a minute or two; only Kitty's layers upload). ComfyUI and every node pack are pinned in `backend/custom_nodes.json` to the commits the workflows were validated against.
2. Pod (GPU filter **CUDA 13.0**): `INSTALL_PRESET=instant`. The installer on :7861 shows the volume setup (first start 10-20 minutes: note the real time, and whether `pip check` in `/workspace/kitty/logs/setup.log` lists anything serious). Then :3020, run *FastH3 Omni INT8* and time it (speed badge). Try `fasth3-omni-lightvae`.
3. Check the swapped files: H3 with the official 32B encoder; render FLUX 3 Klein (t2i + edit) for the gallery. RTX: run both NVIDIA RTX cards and LTX v2v (RTX VSR inside), then LTX v2v once with `"profile": "open-weights"` (lanczos) to compare.
4. Restart the pod once: it must come up in seconds ("up to date"). Optional: `ATTENTION=sage` (SageAttention build on Blackwell).
5. Schemas, packs and graphs are validated on CPU (`backend/tools/live/`); the GPU run checks what CPU cannot: speed, VRAM and output quality. Run each card once and note time and peak VRAM for the cards' estimates.
6. With an HF token: `python backend/tools/manifest.py refresh` to add the LTX 2.5 checksums.
7. Serverless on the same volume: `{"action": "health"}`, then one image and one video job with `OUTPUT_MODE=s3`.

## Changes by session 2 (Phases 2-3, app and MCP)

Branch `phase2-app` (on top of `phase1-backend`).

- **app/** is Kitty 1.x stripped and renamed Kitty Open Studio 0.1.0: no paid APIs, credits, balance, update checker,
  in-app LLM agent, templates or landing page; the leftover provider brand is gone from code and copy.
- **Studio** is the home page (`/[locale]`): card tiles from `src/data/catalog.json` (copied from
  `backend/workflows/index.json` plus `docs/gallery/showcase.json` by `scripts/sync-catalog.mjs`, run before dev
  and build). A card opens its form (built from the inputs) and its results feed (queue, progress, Remix, Download,
  Add to project). The editor's right panel is the same Studio; editor actions (clip menu, gallery, planned blocks)
  open the matching card with the media filled in.
- **Backend**: `src/app/api/backend/[...path]` proxies pod and local Docker (the installer's job API from Phase 1)
  and Runpod serverless (`/run`, `/status`, `/cancel`, `/health`); settings in localStorage, set in the header pill.
- **MCP moved from `app/electron/mcp/` to a Next.js route** (`/api/mcp`, Streamable HTTP, stateless) so it works in
  the browser build and in Electron alike; app-side tools run in the window through a long-poll bridge. Stdio bridge
  for Claude Desktop: `app/mcp/kitty-mcp-stdio.mjs`. ChatGPT through a tunnel with a key. See `docs/mcp.md`.
- **Owner decision: music analysis is done by the assistant over MCP** (`get_media_file` → its own tools →
  `set_music_analysis`), not by an in-app analyser; the Phase 4 "1 MB JS beat detector" is dropped. The Music
  Analyze button points to MCP.
- Deviations kept for the deadline: Remotion stays for preview and export; native ffmpeg export stays. New Studio and
  MCP strings are English only (the old 18 locales cover the editor).
- Tested with a mock backend (Playwright: Studio, card run, editor panel, every MCP tool); not yet against a live pod
  from the app.

## Changes on Oct 28 (before publishing)

- **FLUX 3 Image Klein**: `flux3-klein` (text to image, 15 steps er_sde) and `flux3-klein-edit` (up to 4 references
  through core `ReferenceMultiLatent`; the result takes image 1's size), both built from Comfy's official templates
  with core nodes only and validated against the pinned ComfyUI. Gated: the installer links the license page.
- **Prompt filter in the app** (`app/src/lib/safety.ts`, obscenity MIT + a nudity word list in a few languages): the
  Studio form and the backend route (so also the editor and MCP) refuse sexual or nude prompts.
- **JupyterLab deletes on the volume** (`--FileContentsManager.delete_to_trash=False`: a network volume has no trash).
- **Timeline drops**: the whole timeline area takes a dropped file, not only the strip under the last track.
