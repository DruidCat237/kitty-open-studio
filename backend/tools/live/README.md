# Live checks against a running ComfyUI

Tests that need a real ComfyUI with the custom nodes installed (a Runpod pod from the Kitty image, or a
local install). They complement `pytest backend/tests`, which runs without ComfyUI.

| File | What it does |
|---|---|
| `validate_only_ext.py` | test-only custom node: copy it to `ComfyUI/custom_nodes/zz_kitty_validate_only/__init__.py` and `/prompt` validates without executing anything. Never ship it. |
| `validate.py` | every node class exists and comes from the pack `custom_nodes.json` says; every workflow passes ComfyUI's validation as shipped, with required inputs only, with all inputs, and for the 24 GB / 80 GB profiles |
| `roundtrip.js` | loads every UI graph in the real ComfyUI frontend (Playwright), converts it with `graphToPrompt`, saves the result and screenshots; `validate.py --prompts <out dir>` then validates those editor prompts too |
| `compare.py` | compares those frontend prompts with the shipped API graphs node by node |

```bash
python backend/tools/live/validate.py http://127.0.0.1:8188 /path/to/ComfyUI --fixtures
node backend/tools/live/roundtrip.js http://127.0.0.1:8188 backend/workflows/ui /tmp/rt fasth3-omni-int8
python backend/tools/live/compare.py /tmp/rt
python backend/tools/live/validate.py http://127.0.0.1:8188 /path/to/ComfyUI --prompts /tmp/rt
```

Differences `compare.py` reports that are expected (the graphs still do the same thing):

- inputs a newer ComfyUI or node pack added (`codec`, `color_space`, `format.codec`, `sampling`, `pre_cfg`, ...):
  the editor sends their defaults, the API graphs leave them out and get the same defaults;
- leftovers in the API graphs that ComfyUI ignores (`video-preview`, `preview_text`, ...) and seeds;
- FastH3: the API graphs use named node ids (`sigma_shift`), the editor numbers them; the FP8 graph loads the FP8 file;
- FireRed edit: the optional second and third images are bypassed in the editor graph.
