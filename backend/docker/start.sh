#!/usr/bin/env bash
# Kitty Open Studio container entrypoint.
#   MODE=pod         JupyterLab (8888), ComfyUI (3020), model installer (7861), SSH; stays up.
#   MODE=serverless  ComfyUI in the background + the Runpod job handler.
# The image is only this runtime. ComfyUI, its node packs, the Python venv and the models live on the volume
# (/workspace on a pod, /runpod-volume on serverless): a pod prepares them on its first start (setup_volume.py),
# serverless workers use what a pod prepared. Settings are environment variables: docker/.env.example.
set -euo pipefail

log() { echo "[kitty $(date +%H:%M:%S)] $*"; }
truthy() { case "${1:-}" in 1|true|TRUE|True|yes|on) return 0 ;; *) return 1 ;; esac; }

BACKEND=${KITTY_BACKEND_DIR:-/opt/kitty/backend}
MODE=${MODE:-pod}
# Runpod sets RUNPOD_ENDPOINT_ID in every serverless worker. Without the handler a worker never takes a job and never
# stops (it bills while the queue waits), so a forgotten or wrong MODE must not leave a worker in pod mode.
if [ -n "${RUNPOD_ENDPOINT_ID:-}" ] && [ "$MODE" != "serverless" ]; then
  echo "[kitty] RUNPOD_ENDPOINT_ID is set: this is a serverless worker, running with MODE=serverless (MODE was '$MODE')"
  MODE=serverless
fi
COMFY_PORT=${COMFY_PORT:-3020}
INSTALLER_PORT=${INSTALLER_PORT:-7861}
JUPYTER_PORT=${JUPYTER_PORT:-8888}

# --- 1. the volume -------------------------------------------------------------------------------
if [ "$MODE" = "serverless" ] && [ -d /runpod-volume ]; then
  # Same paths as on a pod: the scripts in the venv point to /workspace/venv.
  if [ -d /workspace ] && [ ! -L /workspace ] && [ -z "$(ls -A /workspace)" ]; then rmdir /workspace; fi
  [ -e /workspace ] || ln -s /runpod-volume /workspace
fi
if [ -z "${DATA_DIR:-}" ]; then
  if [ "$MODE" = "serverless" ] && [ -d /runpod-volume ] && [ "$(readlink -f /workspace)" != /runpod-volume ]; then
    DATA_DIR=/runpod-volume
  else
    DATA_DIR=/workspace
  fi
fi
COMFY_DIR=${COMFY_DIR:-$DATA_DIR/ComfyUI}
VENV_DIR=${VENV_DIR:-$DATA_DIR/venv}
MODELS_DIR=$COMFY_DIR/models
export DATA_DIR COMFY_DIR VENV_DIR MODELS_DIR COMFY_PORT
if [ "$MODE" = "serverless" ]; then
  WORK_DIR=${WORK_DIR:-/tmp/kitty}   # per-worker scratch: no locks on the shared volume
else
  WORK_DIR=${WORK_DIR:-$DATA_DIR/kitty}
fi
LOGS=$WORK_DIR/logs
export WORK_DIR   # cleanup.py deletes job files older than RETENTION_DAYS from its input/output
mkdir -p "$MODELS_DIR" "$DATA_DIR/kitty" "$WORK_DIR"/{input,output,user/default/workflows/Kitty} "$LOGS"
# The Kitty folder mirrors this image's graphs (a removed workflow disappears); save your own edits elsewhere.
rm -f "$WORK_DIR/user/default/workflows/Kitty/"*.json
cp -f "$BACKEND"/workflows/ui/*.json "$WORK_DIR/user/default/workflows/Kitty/" 2>/dev/null || true

log "MODE=$MODE DATA_DIR=$DATA_DIR GPU_PROFILE=${GPU_PROFILE:-48gb} image ${KITTY_IMAGE_VERSION:-dev}"
if command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader || log "nvidia-smi failed"
else
  log "nvidia-smi not available"
fi

# --- 2. pod services that work before ComfyUI is ready: SSH, JupyterLab, the installer ------------
if [ "$MODE" != "serverless" ]; then
  # SSH sessions (AI-assisted setup) get the same settings as the services: HF_TOKEN, GPU_PROFILE...
  # Same file Runpod's own images write; root-only because it can hold tokens.
  (umask 077; export -p | grep -vE '^declare -x (PUBLIC_KEY|HOME|PWD|OLDPWD|SHLVL|_)=' > /etc/rp_environment) || true
  grep -qxF 'source /etc/rp_environment' ~/.bashrc 2>/dev/null || echo 'source /etc/rp_environment' >> ~/.bashrc

  if [ -n "${PUBLIC_KEY:-}" ] && command -v sshd >/dev/null; then
    # Runpod passes your SSH key here; this is what AI-assisted setup connects through.
    mkdir -p ~/.ssh && chmod 700 ~/.ssh
    grep -qxF "$PUBLIC_KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$PUBLIC_KEY" >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    ssh-keygen -A >/dev/null 2>&1 || true
    mkdir -p /run/sshd && /usr/sbin/sshd && log "sshd started"
  fi

  # JupyterLab is a root shell and Runpod's proxy URL is open to anyone who has it, so like Runpod's own images it
  # needs a token: JUPYTER_TOKEN, or JUPYTER_PASSWORD (Runpod sets it when "Start Jupyter notebook" is ticked, and
  # its Connect button logs you in with it). JUPYTER_DISABLE_AUTH=true runs it without one.
  start_jupyter() {
    local token
    if truthy "${JUPYTER_DISABLE_AUTH:-}"; then
      log "WARNING: JUPYTER_DISABLE_AUTH=true: JupyterLab has NO login; anyone with the :$JUPYTER_PORT URL gets a root shell"
      token=""
    elif [ -n "${JUPYTER_TOKEN:-${JUPYTER_PASSWORD:-}}" ]; then
      token=${JUPYTER_TOKEN:-$JUPYTER_PASSWORD}
    else
      log "JupyterLab not started: set JUPYTER_PASSWORD (Runpod: tick \"Start Jupyter notebook\") or JUPYTER_DISABLE_AUTH=true"
      return 0
    fi
    log "starting JupyterLab on :$JUPYTER_PORT"
    # delete_to_trash=False: a network volume has no trash, so send2trash failed and files could not be deleted
    jupyter lab --allow-root --no-browser --ip=0.0.0.0 --port="$JUPYTER_PORT" --ServerApp.root_dir="$DATA_DIR" \
      --ServerApp.allow_origin='*' --IdentityProvider.token="$token" \
      --FileContentsManager.delete_to_trash=False >> "$LOGS/jupyter.log" 2>&1 &
  }
  if truthy "${ENABLE_JUPYTER:-true}" && command -v jupyter >/dev/null; then
    start_jupyter
  fi

  # The installer runs on the image's Python, so its page is up at once: it shows the volume setup below and can
  # already download models. INSTALL_PRESET / _WORKFLOWS / _MODELS start as its own job (progress in /api/progress).
  if truthy "${ENABLE_INSTALLER_UI:-true}"; then
    log "starting the model installer on :$INSTALLER_PORT"
    (
      args=(--port "$INSTALLER_PORT" --models-dir "$MODELS_DIR" --install-from-env)
      while true; do  # keep the page up; a restart only re-reads INSTALL_* if nothing was installed yet
        python3 "$BACKEND/installer/app.py" "${args[@]}" >> "$LOGS/installer.log" 2>&1 || true
        log "the installer exited; restarting it in 3 s (log: $LOGS/installer.log)"
        args=(--port "$INSTALLER_PORT" --models-dir "$MODELS_DIR")
        sleep 3
      done
    ) &
  else
    install_args=()
    [ -n "${INSTALL_PRESET:-}" ] && install_args+=(--preset "$INSTALL_PRESET")
    [ -n "${INSTALL_WORKFLOWS:-}" ] && install_args+=(--workflows "$INSTALL_WORKFLOWS")
    [ -n "${INSTALL_MODELS:-}" ] && install_args+=(--models "$INSTALL_MODELS")
    if [ ${#install_args[@]} -gt 0 ]; then
      log "installing models: ${install_args[*]} (only missing files; log: $LOGS/install-models.log)"
      python3 "$BACKEND/installer/cli.py" "${install_args[@]}" --models-dir "$MODELS_DIR" \
        >> "$LOGS/install-models.log" 2>&1 &
    fi
  fi
fi

# --- 3. ComfyUI, node packs and the venv on the volume -----------------------------------------
setup_ok=false
if [ "$MODE" = "serverless" ]; then
  # Serverless only reads the volume: two workers must not rebuild a venv that a pod or each other is using.
  if python3 "$BACKEND/docker/setup_volume.py" --check; then
    setup_ok=true
  else
    export KITTY_SETUP_ERROR="ComfyUI is not prepared on this network volume yet. Start a pod with this volume once (it installs ComfyUI, the node packs and the Python venv), then send the job again."
  fi
else
  for attempt in 1 2 3; do
    if python3 "$BACKEND/docker/setup_volume.py" 2>&1 | tee -a "$LOGS/setup.log"; then setup_ok=true; break; fi
    log "volume setup failed (attempt $attempt of 3; log: $LOGS/setup.log)"
    if [ "$attempt" -lt 3 ]; then sleep 30; fi
  done
fi
PY=$VENV_DIR/bin/python

if $setup_ok; then
  if [ -n "${CUSTOM_NODES:-}" ] && [ "$MODE" != "serverless" ]; then
    log "installing extra custom nodes: $CUSTOM_NODES"
    "$PY" "$BACKEND/docker/install_nodes.py" --comfy "$COMFY_DIR" --packs none --extra "$CUSTOM_NODES" \
      --constraints "$DATA_DIR/kitty/constraints.txt" || log "WARN: some extra nodes failed"
  fi
  # Deletes input/output files older than RETENTION_DAYS (3) when a prompt is queued; RETENTION_DAYS=0 keeps them.
  ln -sfn "$BACKEND/comfy_nodes/kitty_cleanup" "$COMFY_DIR/custom_nodes/kitty_cleanup"
  if truthy "${BLACKWELL_PATCHES:-true}"; then
    "$PY" "$BACKEND/docker/blackwell_patches.py" "$COMFY_DIR" || log "WARN: patches skipped"
  fi
  MANAGER_CFG="$WORK_DIR/user/__manager/config.ini"
  if [ "$MODE" = "serverless" ] && [ -f "$MANAGER_CFG" ]; then
    sed -i 's/network_mode = public/network_mode = offline/' "$MANAGER_CFG" || true  # no registry fetch on cold start
  fi
  # torch's own CUDA libraries first (cuDNN for onnxruntime-gpu, nvJitLink...), as in the owner's serverless image
  for d in "$VENV_DIR"/lib/python3*/site-packages/nvidia/*/lib "$VENV_DIR"/lib/python3*/site-packages/torch/lib; do
    [ -d "$d" ] && LD_LIBRARY_PATH="$d:${LD_LIBRARY_PATH:-}"
  done
  export LD_LIBRARY_PATH
fi

# --- 4. ComfyUI ------------------------------------------------------------------------------------
comfy_args=(--listen 0.0.0.0 --port "$COMFY_PORT" --enable-cors-header
  --input-directory "$WORK_DIR/input" --output-directory "$WORK_DIR/output" --user-directory "$WORK_DIR/user")
case "${ATTENTION:-sdpa}" in
  sage)
    if $setup_ok && "$PY" -c "import sageattention" 2>/dev/null; then comfy_args+=(--use-sage-attention)
    else log "ATTENTION=sage but SageAttention is not installed in the venv: using PyTorch attention"; comfy_args+=(--use-pytorch-cross-attention); fi ;;
  sdpa) comfy_args+=(--use-pytorch-cross-attention) ;;
  *) log "ATTENTION=${ATTENTION} unknown, using ComfyUI's default" ;;
esac
# Serverless loads only the packs whose nodes the cards use: no ComfyUI-Manager (~13 s of a cold start), no packs a
# pod added by hand or an older image left on the volume. SERVERLESS_ALL_NODES=true loads everything.
if [ "$MODE" = "serverless" ] && ! truthy "${SERVERLESS_ALL_NODES:-false}"; then
  mapfile -t used_packs < <(python3 -c '
import json, sys
for p in json.load(open(sys.argv[1]))["packs"]:
    if p.get("classes"):
        print(p.get("dir") or p["repo"].rstrip("/").split("/")[-1])' "$BACKEND/custom_nodes.json")
  comfy_args+=(--disable-all-custom-nodes --whitelist-custom-nodes "${used_packs[@]}" kitty_cleanup)
fi
# shellcheck disable=SC2206  # COMFY_ARGS is a user-supplied, space-separated flag list
[ -n "${COMFY_ARGS:-}" ] && comfy_args+=(${COMFY_ARGS})

start_comfy() {
  log "starting ComfyUI on :$COMFY_PORT ($PY)"
  (cd "$COMFY_DIR" && exec "$PY" main.py "${comfy_args[@]}") >> "$LOGS/comfyui.log" 2>&1 &
  COMFY_PID=$!
}
touch "$LOGS/comfyui.log"
tail -n 0 -F "$LOGS/comfyui.log" 2>/dev/null | sed -u 's/^/[comfyui] /' &

# --- 5a. serverless --------------------------------------------------------------------------------
if [ "$MODE" = "serverless" ]; then
  if $setup_ok; then start_comfy; else log "ERROR: $KITTY_SETUP_ERROR"; fi
  export COMFY_URL="http://127.0.0.1:$COMFY_PORT"
  exec python3 -u "$BACKEND/docker/handler.py"   # the image's Python: runpod, boto3, requests
fi

# --- 5b. pod: keep ComfyUI up, restart it if it crashes (out of memory, a bad node) -------------------
if ! $setup_ok; then
  # Keep the pod up: the installer page, JupyterLab and SSH stay reachable to see why and fix it.
  log "ComfyUI not started: the volume setup failed (see $LOGS/setup.log and the installer page)."
  log "Fix the cause, then restart the pod (or run: python3 $BACKEND/docker/setup_volume.py)."
  exec sleep infinity
fi
start_comfy
while true; do
  wait "$COMFY_PID" || true
  log "ComfyUI exited; restarting in 5 s (log: $LOGS/comfyui.log)"
  sleep 5
  start_comfy
done
