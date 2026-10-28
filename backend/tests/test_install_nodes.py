"""install_nodes keeps one Python environment and never lets a pack replace torch."""
import json
import re
import subprocess
import sys

import install_nodes


def fake_pip_list(monkeypatch, packages: dict[str, str]):
    listing = json.dumps([{"name": n, "version": v} for n, v in packages.items()])
    monkeypatch.setattr(install_nodes.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=listing, stderr=""))


def test_constraints_cover_nested_pip_calls(tmp_path, monkeypatch):
    """The reference's freeze list (venv-reference.md rule 1) plus the version windows, also for nested pip calls."""
    fake_pip_list(monkeypatch, {"torch": "2.8.0+cu128", "numpy": "1.26.4", "requests": "2.32.0",
                                "transformers": "4.57.6", "huggingface_hub": "0.36.0", "diffusers": "0.36.0"})
    monkeypatch.setenv("PIP_CONSTRAINT", "unset")  # restored after the test
    files = install_nodes.write_constraints(tmp_path / "c.txt")
    assert files[0].read_text().split() == ["transformers==4.57.6", "torch==2.8.0+cu128", "numpy==1.26.4",
                                            "huggingface-hub==0.36.0", "diffusers==0.36.0"]
    assert install_nodes.os.environ["PIP_CONSTRAINT"] == f"{files[0]} {install_nodes.WINDOWS}"
    assert install_nodes.write_constraints(tmp_path / "c.txt", windows=False) == [files[0]]


def test_version_windows_follow_the_reference():
    pins = install_nodes.WINDOWS.read_text().splitlines()
    for pin in ("numpy==1.26.4", "pillow<12", "protobuf>=3.20.2,<6.0.0", "onnxruntime-gpu==1.20.2", "opencv-python<4.12"):
        assert pin in pins


def test_requirements_leave_out_what_the_curated_set_does_not_need(tmp_path):
    (tmp_path / "requirements.txt").write_text(
        "torch\nopenai>=1.0  # closed API\nfal_client\ngit+https://github.com/facebookresearch/sam2\n"
        "groundingdino-py>=0.4.0\ntaichi>=1.7.4\nimportlib_metadata; python_version < \"3.8\"\n-r extra.txt\n")
    normal, torch_builds, dropped = install_nodes.filtered_requirements({}, tmp_path)
    assert normal == ["torch", 'importlib_metadata; python_version < "3.8"', f"-r {tmp_path / 'extra.txt'}"]
    assert torch_builds == ["git+https://github.com/facebookresearch/sam2", "groundingdino-py>=0.4.0"]
    assert dropped == ["openai", "fal-client", "taichi"]
    assert "taichi>=1.7.4" in install_nodes.filtered_requirements({"allow": ["taichi"]}, tmp_path)[0]


def test_torch_builds_skip_build_isolation(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(install_nodes, "pip_install", lambda args, cwd, constraints, what, quiet=False: calls.append(args) or True)
    (tmp_path / "requirements.txt").write_text("einops\ngit+https://github.com/facebookresearch/sam2\n")
    install_nodes.install_requirements({"pip_args": ["--extra-index-url", "https://pypi.nvidia.com"]}, tmp_path, [])
    assert calls[0][0] == "-r" and calls[0][2:] == ["--extra-index-url", "https://pypi.nvidia.com"]
    assert calls[1][:2] == ["--no-build-isolation", "git+https://github.com/facebookresearch/sam2"]
    calls.clear()
    install_nodes.install_requirements({"requirements": False}, tmp_path, [])
    assert calls == []


def test_pack_install_script_uses_comfyuis_interpreter(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(install_nodes, "clone", lambda repo, ref, dest: dest.mkdir(parents=True) or True)
    monkeypatch.setattr(install_nodes, "sh", lambda cmd, cwd=None, check=True: calls.append(cmd) or 0)
    pack = {"id": "fi", "repo": "https://example.invalid/ComfyUI-Frame-Interpolation", "install": "python install.py"}
    install_nodes.install_pack(pack, tmp_path, [tmp_path / "c.txt"])
    assert calls == [[sys.executable, "install.py"]]


def test_comfyui_and_every_pack_are_pinned_to_a_commit():
    """The volume gets exactly what tools/live validated (setup_volume.py reads comfyui.ref from here)."""
    nodes = json.loads((install_nodes.BACKEND / "custom_nodes.json").read_text(encoding="utf-8"))
    refs = [nodes["comfyui"]["ref"]] + [p["ref"] for p in nodes["packs"]]
    assert all(re.fullmatch(r"[0-9a-f]{40}", r) for r in refs)


def test_one_conflicting_requirement_does_not_cost_the_others(tmp_path, monkeypatch):
    """One pin that conflicts (nobg wants huggingface-hub 1.x): the other requirements still install."""
    calls = []

    def fake(args, cwd, constraints, what, quiet=False):
        calls.append(args[0])
        return not (args[0] == "-r" or args[0].startswith("nobg"))

    monkeypatch.setattr(install_nodes, "pip_install", fake)
    (tmp_path / "requirements.txt").write_text("transparent-background>=1.1.2\nnobg>=0.3.1\nhydra-core>=1.3.0\n")
    install_nodes.install_requirements({}, tmp_path, [])
    assert calls == ["-r", "transparent-background>=1.1.2", "nobg>=0.3.1", "hydra-core>=1.3.0"]
