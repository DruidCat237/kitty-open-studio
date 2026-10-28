# Kitty Open Studio

An open-source, self-hosted AI video studio powered by **your own ComfyUI**.
Make pictures, edits, video with sound, talking characters and upscales from 33 curated open-weights workflows,
cut them on a timeline, and let Claude or ChatGPT direct a whole music video over MCP: all on your own GPU
(a Runpod pod, pay-per-second serverless, or your own card).

Built for Comfy's October 2026 open-source app challenge.

## ▶ 2-minute demo

<a href="docs/demo/kitty-open-studio-demo.mp4"><img src="docs/demo/kitty-open-studio-demo-poster.jpg" alt="Kitty Open Studio: 2-minute demo (click to play)"></a>

▶ **[Watch the 2-minute demo](docs/demo/kitty-open-studio-demo.mp4)**: a Celtic shaman from one prompt, an edit, MiniMax H3
video with sound, an NVIDIA RTX upscale on the timeline, and Claude directing a 10-second LTX 2.5 shot over MCP.
Narrated by Druid Cat.

<p>
<img src="docs/gallery/badge-hero-workflows.svg" alt="33 curated workflows">
<img src="docs/gallery/badge-hero-open.svg" alt="open weights, 100% local">
<img src="docs/gallery/badge-hero-comfy.svg" alt="ComfyUI 0.42">
<img src="docs/gallery/badge-hero-gpu.svg" alt="tested on an RTX 5090 on Runpod">
</p>

## The app

<img src="docs/screenshots/studio-home.jpg" alt="Studio: every workflow as a card with its render">

<p>
<img src="docs/screenshots/studio-card.jpg" alt="A card: form on the left, results on the right" width="49%">
<img src="docs/screenshots/editor-studio.jpg" alt="The editor with the Studio panel" width="49%">
</p>
<p align="center">
<img src="docs/screenshots/mcp-dialog.jpg" alt="Connect Claude or ChatGPT over MCP" width="60%">
</p>

- **Studio**: every workflow is a card with a real render and its time on a Runpod GPU. Pick one, fill in the form, press
  Generate; the feed shows queue, progress, results, Remix and Download.
- **Editor**: the timeline from Kitty 1.x with the same Studio as a side panel; results land in the project's media.
  Right-click a clip to upscale, edit, animate or interpolate it with the matching card.
- **Your backend**: a Runpod pod, a serverless endpoint (pay per second) or Docker on your GPU, set in the header pill.
- **Claude and ChatGPT over MCP**: the app is an MCP server. An assistant lists the workflows, generates on your
  backend, reads the project, analyses your song with its own tools and cuts the shots on the beat
  ([docs/mcp.md](docs/mcp.md)).
- **Safe for work**: the app refuses sexual or nude prompts, from the Studio, the editor and MCP alike
  ([`app/src/lib/safety.ts`](app/src/lib/safety.ts): the MIT [obscenity](https://github.com/jo3-l/obscenity) matcher
  plus a nudity word list in several languages).

```bash
cd app && npm ci && npm run dev        # http://localhost:3000 ; desktop build: npm run electron:build (Windows) / electron:build:linux
```

## Made with Kitty Open Studio

One prompt idea (a red-haired woman in a black dress, in scenes of every kind), then edits, video, voices and upscales, all from the curated cards in this repository. Every thumbnail is a real render; the badge under it is the card and how long the job took.

### 🖼️ Pictures

<table>
<tr><td align="center" valign="top"><img src="docs/gallery/qwen-image-paris.jpg" width="260" alt="Golden hour on a Paris rooftop"><br><img src="docs/gallery/badge-qwen-image-paris.svg" alt="Qwen Image 2.1, 102 s"><br><sub>Golden hour on a Paris rooftop</sub></td><td align="center" valign="top"><img src="docs/gallery/flux3-cafe.jpg" width="260" alt="Morning in a minimalist cafe"><br><img src="docs/gallery/badge-flux3-cafe.svg" alt="FLUX 3 Klein, 7 s on a warm serverless worker"><br><sub>Morning in a minimalist cafe</sub></td></tr>
</table>

### 🐈‍⬛ Edits: *add a black cat with green eyes*

<table>
<tr><td align="center" valign="top"><img src="docs/gallery/edit-qwen-cat.jpg" width="260" alt="+ a black cat on the railing"><br><img src="docs/gallery/badge-edit-qwen-cat.svg" alt="Qwen Image Edit, 105 s"><br><sub>+ a black cat on the railing</sub></td><td align="center" valign="top"><img src="docs/gallery/edit-firered-cat.jpg" width="260" alt="+ a black cat in the cafe"><br><img src="docs/gallery/badge-edit-firered-cat.svg" alt="FireRed Image Edit, 195 s"><br><sub>+ a black cat in the cafe</sub></td><td align="center" valign="top"><img src="docs/gallery/edit-flux-cat.jpg" width="260" alt="+ a black cat in her arms"><br><img src="docs/gallery/badge-edit-flux-cat.svg" alt="FLUX 3 Klein Edit, 33 s on an RTX PRO 4500"><br><sub>+ a black cat in her arms</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/edit-qwen-inpaint.jpg" width="260" alt="Masked area: a cat on the deck"><br><img src="docs/gallery/badge-edit-qwen-inpaint.svg" alt="Qwen Image Inpaint, 420 s"><br><sub>Masked area: a cat on the deck</sub></td><td align="center" valign="top"><img src="docs/gallery/edit-camera-angle.jpg" width="260" alt="New camera angle from one picture"><br><img src="docs/gallery/badge-edit-camera-angle.svg" alt="Qwen Camera Angle, 186 s"><br><sub>New camera angle from one picture</sub></td></tr>
</table>

### 🎬 Video with sound

<table>
<tr><td align="center" valign="top"><img src="docs/gallery/ltx-t2v-beach.webp" width="260" alt="Beach promenade, sea sound"><br><img src="docs/gallery/badge-ltx-t2v-beach.svg" alt="LTX 2.5 text to video, 171 s"><br><sub>Beach promenade, sea sound</sub></td><td align="center" valign="top"><img src="docs/gallery/ltx-i2v-selfie.webp" width="260" alt="The Paris picture takes a selfie"><br><img src="docs/gallery/badge-ltx-i2v-selfie.svg" alt="LTX 2.5 image to video, 191 s"><br><sub>The Paris picture takes a selfie</sub></td><td align="center" valign="top"><img src="docs/gallery/ltx-flf-cat.webp" width="260" alt="From the picture to the edit: the cat jumps up"><br><img src="docs/gallery/badge-ltx-flf-cat.svg" alt="LTX 2.5 first + last frame, 189 s"><br><sub>From the picture to the edit: the cat jumps up</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/h3-i2v-cafe.webp" width="260" alt="768 x 1344 with stereo sound"><br><img src="docs/gallery/badge-h3-i2v-cafe.svg" alt="MiniMax H3 image to video, 599 s"><br><sub>768 x 1344 with stereo sound</sub></td><td align="center" valign="top"><img src="docs/gallery/h3-r2v-park.webp" width="260" alt="Woman + cat from two pictures"><br><img src="docs/gallery/badge-h3-r2v-park.svg" alt="MiniMax H3 reference to video, 302 s"><br><sub>Woman + cat from two pictures</sub></td><td align="center" valign="top"><img src="docs/gallery/fasth3-dance.webp" width="260" alt="Text to scene + sound, 1344 x 768"><br><img src="docs/gallery/badge-fasth3-dance.svg" alt="FastH3 Omni (8 steps), 310 s"><br><sub>Text to scene + sound, 1344 x 768</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/fasth3-talk.webp" width="260" alt=""Hi everyone, welcome back to my channel""><br><img src="docs/gallery/badge-fasth3-talk.svg" alt="FastH3 Omni LightVAE, 316 s"><br><sub>"Hi everyone, welcome back to my channel"</sub></td><td align="center" valign="top"><img src="docs/gallery/wan-flf-tokyo.webp" width="260" alt="A cat walks in and sits down"><br><img src="docs/gallery/badge-wan-flf-tokyo.svg" alt="Wan 2.2 first + last frame, 357 s"><br><sub>A cat walks in and sits down</sub></td><td align="center" valign="top"><img src="docs/gallery/wan-i2v-yacht.webp" width="260" alt="Sea breeze, sunglasses"><br><img src="docs/gallery/badge-wan-i2v-yacht.svg" alt="Wan 2.2 image to video, 501 s"><br><sub>Sea breeze, sunglasses</sub></td></tr>
</table>

### 🗣️ Talking, character swap, motion transfer

<table>
<tr><td align="center" valign="top"><img src="docs/gallery/h3-talk.webp" width="260" alt="A picture speaks a recorded voice"><br><img src="docs/gallery/badge-h3-talk.svg" alt="H3 Talk, 399 s"><br><sub>A picture speaks a recorded voice</sub></td><td align="center" valign="top"><img src="docs/gallery/swap-anime.webp" width="260" alt="The dancer becomes an anime character"><br><img src="docs/gallery/badge-swap-anime.svg" alt="H3 Character Swap, 344 s"><br><sub>The dancer becomes an anime character</sub></td><td align="center" valign="top"><img src="docs/gallery/swap-real.webp" width="260" alt="Same dance, the Paris woman"><br><img src="docs/gallery/badge-swap-real.svg" alt="H3 Character Swap, 364 s"><br><sub>Same dance, the Paris woman</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/infinitetalk.webp" width="260" alt="The Paris picture talks, full frame"><br><img src="docs/gallery/badge-infinitetalk.svg" alt="InfiniteTalk, 359 s"><br><sub>The Paris picture talks, full frame</sub></td><td align="center" valign="top"><img src="docs/gallery/infinitetalk-v2v.webp" width="260" alt="New voice, new lip sync on the cafe clip"><br><img src="docs/gallery/badge-infinitetalk-v2v.svg" alt="InfiniteTalk video to video, 128 s"><br><sub>New voice, new lip sync on the cafe clip</sub></td><td align="center" valign="top"><img src="docs/gallery/solar-street.webp" width="260" alt="Grey boxes in, a dusk street out"><br><img src="docs/gallery/badge-solar-street.svg" alt="SolarRenderer (MiniMax H3), 591 s"><br><sub>Grey boxes in, a dusk street out</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/scail2-loop.webp" width="260" alt="The yacht picture dances the FastH3 moves"><br><img src="docs/gallery/badge-scail2-loop.svg" alt="Wan 2.1 SCAIL-2 Loop, 566 s"><br><sub>The yacht picture dances the FastH3 moves</sub></td><td align="center" valign="top"><img src="docs/gallery/multi-angle.jpg" width="260" alt="Six shots from one portrait"><br><img src="docs/gallery/badge-multi-angle.svg" alt="Qwen Camera Multi-Angle, 390 s"><br><sub>Six shots from one portrait</sub></td></tr>
</table>

### 🔍 Upscale and restore

<table>
<tr><td align="center" valign="top"><img src="docs/gallery/up-rtx.jpg" width="260" alt="832 x 1248 -> 1664 x 2496"><br><img src="docs/gallery/badge-up-rtx.svg" alt="NVIDIA RTX Super Resolution, 17 s"><br><sub>832 x 1248 -> 1664 x 2496</sub></td><td align="center" valign="top"><img src="docs/gallery/up-seedvr2-4k.jpg" width="260" alt="832 x 1248 -> 2730 x 4096"><br><img src="docs/gallery/badge-up-seedvr2-4k.svg" alt="SeedVR2 4K, 112 s"><br><sub>832 x 1248 -> 2730 x 4096</sub></td><td align="center" valign="top"><img src="docs/gallery/up-seedvr2.jpg" width="260" alt="720 x 1280 -> 1080 x 1920"><br><img src="docs/gallery/badge-up-seedvr2.svg" alt="SeedVR2, 28 s"><br><sub>720 x 1280 -> 1080 x 1920</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/up-qwen.jpg" width="260" alt="1024 -> 2048, anime"><br><img src="docs/gallery/badge-up-qwen.svg" alt="Qwen Upscale, 190 s"><br><sub>1024 -> 2048, anime</sub></td><td align="center" valign="top"><img src="docs/gallery/up-simple.jpg" width="260" alt="1056 x 1392 -> 2112 x 2784"><br><img src="docs/gallery/badge-up-simple.svg" alt="Simple Upscale, 6 s"><br><sub>1056 x 1392 -> 2112 x 2784</sub></td><td align="center" valign="top"><img src="docs/gallery/up-rtx-video.webp" width="260" alt="1344 x 768 -> 2688 x 1536, 5 s clip"><br><img src="docs/gallery/badge-up-rtx-video.svg" alt="NVIDIA RTX Video Upscale, 14 s"><br><sub>1344 x 768 -> 2688 x 1536, 5 s clip</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/up-ltx-v2v.webp" width="260" alt="1280 x 704 -> 1920 x 1088"><br><img src="docs/gallery/badge-up-ltx-v2v.svg" alt="LTX 2.5 video upscale, 264 s"><br><sub>1280 x 704 -> 1920 x 1088</sub></td><td align="center" valign="top"><img src="docs/gallery/up-seedvr2-video.webp" width="260" alt="768 x 1344 -> 1080 x 1890"><br><img src="docs/gallery/badge-up-seedvr2-video.svg" alt="SeedVR2 video, 187 s"><br><sub>768 x 1344 -> 1080 x 1890</sub></td><td align="center" valign="top"><img src="docs/gallery/up-flashvsr.webp" width="260" alt="Detail restore at 1344 x 768"><br><img src="docs/gallery/badge-up-flashvsr.svg" alt="FlashVSR restore, 54 s"><br><sub>Detail restore at 1344 x 768</sub></td></tr>
<tr><td align="center" valign="top"><img src="docs/gallery/up-interp.webp" width="260" alt="30 -> 50 fps"><br><img src="docs/gallery/badge-up-interp.svg" alt="RIFE frame interpolation, 47 s"><br><sub>30 -> 50 fps</sub></td></tr>
</table>

## Quick start

1. **A GPU backend.** Deploy the [Kitty Open Studio template on Runpod](https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx)
   with a network volume and pick a model preset on port 7861, or `docker compose up` in `backend/docker` on your own
   NVIDIA card, or just ask your AI assistant to do it (below).
2. **The app.** `cd app && npm ci && npm run dev` (web, http://localhost:3000) or `npm run electron:dev` (desktop).
   On first start it shows what it makes, then points at the backend pill: paste the pod id, a serverless endpoint
   or the local URL.
3. **Create.** Pick a card in the Studio, or open the Editor and let Claude or ChatGPT direct
   ([docs/mcp.md](docs/mcp.md)).

## Open weights

Every generation runs on open-weights models in your own ComfyUI: no partner nodes, no closed generation APIs, and
the weights download straight from their publishers ([licenses](docs/models.md)). Two Upscale cards use NVIDIA's
free but closed RTX Video SDK; the **100% open weights** profile (backend setting or `KITTY_PROFILE=open-weights`)
hides them and swaps RTX Video Super Resolution for an open resize. Claude and ChatGPT are optional MCP clients that
direct the app; nothing they do is needed to generate.

## Layout
- [`app/`](app/) - the desktop and web app (Electron + Next.js + TypeScript): Studio cards, generation feed, timeline editor, MCP server.
- [`backend/`](backend/) - curated ComfyUI workflows, model manifest, model installer, a small Docker image (ComfyUI, its venv and the models live on your volume) and Runpod job handler.
- [`docs/`](docs/) - [Deploy on Runpod](docs/runpod.md) · [Docker image](docs/docker.md) · [S3 outputs](docs/s3.md) · [AI-assisted setup](docs/ai-assisted-setup.md) · [MCP for Claude and ChatGPT](docs/mcp.md) · [Hosted demo link](docs/hosted-demo.md) · [Workflows](docs/workflows.md) · [Models and licenses](docs/models.md) · [Third-party software](THIRD_PARTY.md)

## Let your AI assistant set it up

Open this repository in Claude Code (or Codex, Cursor's agent, ...) and say *"set up Kitty Open Studio for me"*.
It follows [AGENTS.md](AGENTS.md): asks what you want to make, shows the download size, the GPU price per hour and
the storage cost per month, and after your yes creates the Runpod volume and pod (or uses your own GPU), installs
the models and checks that the workflows are ready. Your keys stay in a local `.env` file, never in the chat.

## Where it runs

- **[Runpod](https://runpod.io?ref=1yinrvfx)** (built and tested there): a pod with a network volume, then optionally a serverless endpoint on the same
  volume that bills per second. Deploy the **[public Kitty Open Studio template](https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx)** or let your AI
  assistant create everything ([docs/runpod.md](docs/runpod.md)).
- **Your own NVIDIA GPU**: `docker compose up` ([docs/docker.md](docs/docker.md)).
- **Anywhere else with Docker and a GPU** (Vast.ai, your own server, ...): the same public image, or build and push
  your own; an open option we do not test ([docs/docker.md → Other GPU clouds](docs/docker.md#other-gpu-clouds-open-option-not-tested)).

## Backend in one minute
```bash
python backend/installer/cli.py --estimate --preset starter          # size + monthly storage cost
python backend/installer/cli.py --preset starter --models-dir /path/to/ComfyUI/models
cd backend/docker && docker compose up                               # ComfyUI :3020, installer :7861
```

## License
MIT (see [LICENSE](LICENSE)). Models keep their own licenses ([list](docs/models.md)) and are downloaded by the user.
