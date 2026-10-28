"""Kitty Open Studio: when a prompt is queued, delete ComfyUI input/output files older than RETENTION_DAYS.

start.sh links this folder into ComfyUI/custom_nodes. The work is in backend/docker/cleanup.py (also used by the
serverless handler): no timers, at most one quick check every 10 minutes, in the background.
"""
import importlib.util
import logging
import os
from pathlib import Path

from server import PromptServer

_path = Path(os.environ.get("KITTY_BACKEND_DIR") or Path(__file__).resolve().parents[2]) / "docker" / "cleanup.py"
_spec = importlib.util.spec_from_file_location("kitty_cleanup_impl", _path)
_cleanup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cleanup)


def _on_prompt(json_data):
    _cleanup.clean_old_files(log=logging.info)
    return json_data


PromptServer.instance.add_on_prompt_handler(_on_prompt)
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
