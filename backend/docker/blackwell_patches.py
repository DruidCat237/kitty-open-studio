#!/usr/bin/env python3
"""Small, idempotent source patches for RTX 50xx / RTX PRO 6000 (Blackwell, sm_120).

Each patch looks for one exact line and is skipped when the line is not there (newer
ComfyUI or node versions already fixed it). Run before ComfyUI starts:

  python blackwell_patches.py /workspace/ComfyUI     (with the venv's Python: it also patches torchaudio)

From the owner's production Runpod images (2026): multinomial sampling in the LLM text
encoders crashes in nvrtc on sm_120, torchaudio's complex abs does too, and DynamicVRAM can return None.
Also small compatibility fixes for the pinned ComfyUI found on a real pod (see the comments at each patch).
"""
from __future__ import annotations

import sys
from pathlib import Path

PATCHES = [
    ("comfy/text_encoders/llama.py",
     "        return torch.multinomial(probs, num_samples=1, generator=generator)",
     "        probs_cpu = probs.float().cpu(); probs_cpu = torch.clamp(probs_cpu, min=1e-10); "
     "probs_cpu = probs_cpu / probs_cpu.sum(dim=-1, keepdim=True); "
     "return torch.multinomial(probs_cpu, num_samples=1).to(probs.device)"),
    ("comfy/text_encoders/llama.py",
     "        probs = torch.nn.functional.softmax(logits, dim=-1)",
     "        logits = torch.nan_to_num(logits, nan=0.0, posinf=1e4, neginf=-1e4)\n"
     "        probs = torch.nn.functional.softmax(logits.float(), dim=-1)"),
    ("comfy/text_encoders/ace15.py",
     "next_token = torch.multinomial(torch.softmax(cfg_logits, dim=-1), num_samples=1, generator=generator).squeeze(1)",
     "probs = torch.softmax(cfg_logits.float(), dim=-1).cpu(); probs = torch.clamp(probs, min=1e-10); "
     "probs = probs / probs.sum(dim=-1, keepdim=True); "
     "next_token = torch.multinomial(probs, num_samples=1).squeeze(1).to(cfg_logits.device)"),
    ("comfy/model_patcher.py", "+ aimdo_mem", "+ (aimdo_mem or 0)"),
    # Qwen 3.5 decode (an LLM prompt writer, e.g. the FLUX 3 prompt upsampler): comfy-kitchen's BF16 GQA decode kernel refuses the KV cache
    # on the cu128 build ("Unsupported Flash Attention tensor strides", RTX 5090), also with a contiguous query.
    # Fall back to the library's own torch version of the same computation when the kernel says no.
    ("comfy/text_encoders/llama.py", "comfy_kitchen.flash_attention_decode_gqa(xq", "_kitchen_decode_gqa(xq"),
    ("comfy/text_encoders/llama.py", "comfy_kitchen.flash_attention_decode_tree_merge(out", "_kitchen_tree_merge(out"),
    ("comfy/text_encoders/llama.py", "from comfy_kitchen.int8_decode import Int8DecodeCache\n",
     "from comfy_kitchen.int8_decode import Int8DecodeCache\n"
     "from comfy_kitchen import flash_attention as _ck_flash  # Kitty: torch fallback below\n\n\n"
     "def _kitchen_decode_gqa(q, k, v, kv_lengths, return_lse=False, causal=True):\n"
     "    try:\n"
     "        return _ck_flash.flash_attention_decode_gqa(q, k, v, kv_lengths, return_lse=return_lse, causal=causal)\n"
     "    except RuntimeError:  # the kernel refuses some layouts on some builds\n"
     "        out, lse = _ck_flash._decode_gqa_torch(q, k, v, kv_lengths, causal)\n"
     "        return (out, lse) if return_lse else out\n\n\n"
     "def _kitchen_tree_merge(*args):\n"
     "    try:\n"
     "        return _ck_flash.flash_attention_decode_tree_merge(*args)\n"
     "    except RuntimeError:\n"
     "        return _ck_flash._tree_merge_torch(*args)\n"),
]
NODE_PATCHES: list[tuple[str, str, str]] = [  # (pack folder, old line, new line)
    # ComfyUI 0.42 fuses Wan's FFN (comfy.ops.linear_input_act), which reads module.weight directly unless the
    # module sets comfy_force_forward; a GGUF layer's weight is still packed (Q8_0: 34 bytes per 32 values), so
    # Wan 2.2 GGUF failed with "mat1 and mat2 shapes cannot be multiplied (...x13824 and 14688x5120)".
    ("custom_nodes/ComfyUI-GGUF",
     "    comfy_cast_weights = True\n    dequant_dtype = None",
     "    comfy_cast_weights = True\n    comfy_force_forward = True  # dequantize in forward, also in fused ops\n"
     "    dequant_dtype = None"),
    # ComfyUI 0.42 walks every output of a finished node (model_patcher.add), which reads VHS's lazy audio even
    # when nothing uses it; a video without a sound track (Wan, frame interpolation input) then failed to load.
    ("custom_nodes/ComfyUI-VideoHelperSuite",
     "    except subprocess.CalledProcessError as e:\n        raise Exception(f\"VHS failed to extract audio from {file}",
     "    except subprocess.CalledProcessError as e:\n"
     "        if b\"does not contain any stream\" in e.stderr:  # a video without sound: empty audio\n"
     "            return {'waveform': torch.zeros((1, 2, 0)), 'sample_rate': 44100}\n"
     "        raise Exception(f\"VHS failed to extract audio from {file}"),
]


def patch_file(path: Path, old: str, new: str) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except (FileNotFoundError, UnicodeDecodeError):
        return False
    if old not in text or new in text:
        return False
    path.write_text(text.replace(old, new), encoding="utf-8")
    return True


def main(comfy: str) -> int:
    root = Path(comfy)
    changed = []
    for rel, old, new in PATCHES:
        if patch_file(root / rel, old, new):
            changed.append(rel)
    for rel_dir, old, new in NODE_PATCHES:
        for f in (root / rel_dir).rglob("*.py") if (root / rel_dir).is_dir() else []:
            if patch_file(f, old, new):
                changed.append(str(f.relative_to(root)))
    try:
        import torchaudio.functional.functional as taf

        if patch_file(Path(taf.__file__), "return spec_f.abs()", "return spec_f.cpu().abs().to(spec_f.device)"):
            changed.append("torchaudio/functional/functional.py")
    except Exception:  # noqa: BLE001 - torchaudio is optional
        pass
    print("blackwell patches: " + (", ".join(sorted(set(changed))) if changed else "nothing to patch"), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/workspace/ComfyUI"))
