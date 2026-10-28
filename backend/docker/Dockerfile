# syntax=docker/dockerfile:1.7
# =====================================================================================
# Kitty Open Studio backend image: the runtime and Kitty's scripts only (tens of MB on top of Runpod's base).
# ComfyUI, its node packs, the Python venv and the models live on the volume: a pod prepares them on its first start
# (docker/setup_volume.py, the owner's proven Runpod layout), serverless workers reuse them.
# Pushing or updating the image therefore moves only these small layers. One image, two modes: MODE=pod | serverless.
#
#   cd backend/docker && docker buildx bake --push     (build definition: docker-compose.yml + docker-bake.hcl)
#
# Runtime settings are env vars (see docker/.env.example and docs/docker.md).
# =====================================================================================
# Runpod's base: Ubuntu 24.04, the CUDA 12.8 toolkit (nvcc for the optional SageAttention build), Python 3.9-3.13
# with venv, JupyterLab, SSH, ffmpeg, git. Runpod hosts usually have it cached, and a push of this image only uploads
# the layers below (the base layers are mounted from runpod/base on Docker Hub). Hosts need a driver for CUDA 12.8+.
ARG BASE_IMAGE=runpod/base:1.4.1-cuda1281-ubuntu2404
FROM ${BASE_IMAGE}
ARG KITTY_VERSION=dev

LABEL org.opencontainers.image.title="Kitty Open Studio backend" \
      org.opencontainers.image.description="Runtime for ComfyUI with curated open-weights workflows, a model installer and a Runpod job handler. ComfyUI, the venv and the models live on your volume; no model weights inside." \
      org.opencontainers.image.source="https://github.com/DruidCat237/kitty-open-studio" \
      org.opencontainers.image.documentation="https://github.com/DruidCat237/kitty-open-studio/blob/main/docs/docker.md"

# Blackwell (RTX 50xx / PRO 6000) settings are the proven ones from the owner's production images.
# HF_HUB_ENABLE_HF_TRANSFER=0: the base turns hf_transfer on, but the venv downloads through hf_xet; with the flag on
# and hf_transfer missing, huggingface_hub refuses to download at all (node packs fetch some models themselves).
# The last block holds runtime defaults; override them with -e or in the Runpod template.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_ENABLE_HF_TRANSFER=0 \
    KITTY_BACKEND_DIR=/opt/kitty/backend \
    KITTY_IMAGE_VERSION=${KITTY_VERSION} \
    VENV_PYTHON=python3.11 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True,max_split_size_mb:512,roundup_power2_divisions:16 \
    TORCHDYNAMO_DISABLE=1 \
    TORCH_COMPILE_DISABLE=1 \
    CUDA_MODULE_LOADING=LAZY \
    TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=1 \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
    MODE=pod \
    COMFY_PORT=3020 \
    INSTALLER_PORT=7861 \
    JUPYTER_PORT=8888 \
    GPU_PROFILE=48gb \
    ATTENTION=sdpa \
    OUTPUT_MODE=base64

RUN apt-get update && apt-get install -y --no-install-recommends tini dos2unix \
    && rm -rf /var/lib/apt/lists/*

# The image's own Python (3.12) runs the installer page, the job handler and JupyterLab; ComfyUI runs from the venv.
# Never upgrade the distro pip (apt-managed). cryptography first and with --ignore-installed: the base ships an
# apt-installed copy that pip cannot uninstall ("uninstall-no-record-file"), and runpod needs a newer one.
RUN python3 -m pip install --ignore-installed "cryptography==50.0.2" \
 && python3 -m pip install "runpod==1.12.0" "boto3==1.43.119" "requests==2.34.2" "fastapi==0.162.0" "uvicorn[standard]==0.54.0" \
 && python3 -c "import runpod, boto3, fastapi; print('runpod', runpod.__version__)"

COPY . ${KITTY_BACKEND_DIR}
RUN find ${KITTY_BACKEND_DIR}/docker -name "*.sh" -exec dos2unix -q {} + \
 && chmod +x ${KITTY_BACKEND_DIR}/docker/*.sh

EXPOSE 22 3020 7861 8888
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/kitty/backend/docker/start.sh"]
