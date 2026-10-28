# Third-party software and models

Kitty Open Studio's own code (the app, the model installer, the job handler, the Docker scripts and the workflow
JSONs) is MIT, see [LICENSE](LICENSE). Nothing below is bundled in this repository or in the Docker image: the
installer downloads each model from its publisher, and a pod's first start clones ComfyUI and the node packs from
their authors' repositories onto your volume.

- **Models and their licenses:** [docs/models.md](docs/models.md), generated from `backend/models.json`. Some use
  non-commercial or community licenses (for example the MiniMax H3 Community License): read them before
  commercial use.
- **ComfyUI and the node packs:** [docs/nodes.md](docs/nodes.md), generated from `backend/custom_nodes.json`.
- **Python packages in the venv:** installed by pip from PyPI, the PyTorch index and NVIDIA's index, each under its
  own license.

## Proprietary components

| Component | Vendor | Used by | License | How to leave it out |
|---|---|---|---|---|
| `nvidia-vfx` (Python bindings of the NVIDIA Video Effects SDK) | NVIDIA | RTX Video Super Resolution: the two upscale cards badged NVIDIA RTX and the pre-upscale in LTX 2.5 Video Restyle / Upscale | proprietary (`LicenseRef-NvidiaProprietary`), free to use on NVIDIA RTX GPUs | `INSTALL_NVIDIA_RTX=false` does not install it; the "100% open weights" profile hides the RTX cards and uses a lanczos resize instead |

The CUDA libraries (the CUDA toolkit in Runpod's base image and the CUDA wheels that come with PyTorch) are NVIDIA
software under NVIDIA's license terms, as in every GPU build of PyTorch.
