"""setup_volume.py prepares ComfyUI + venv once and afterwards only what a newer image changed."""
import json
import subprocess

import pytest
import setup_volume as sv


@pytest.fixture()
def volume(tmp_path, monkeypatch):
    """A volume where every command 'works': git creates main.py, venv creates bin/python."""
    calls = []

    def fake_run(cmd, cwd=None, env=None):
        cmd = [str(c) for c in cmd]
        calls.append(cmd)
        if cmd[:2] == ["git", "-c"] and "checkout" in cmd and cwd:
            (cwd / "main.py").write_text("")
        if cmd[1:3] == ["-m", "venv"]:
            (tmp_path / "venv" / "bin").mkdir(parents=True)
            (tmp_path / "venv" / "bin" / "python").write_text("")

    monkeypatch.setattr(sv, "run", fake_run)
    monkeypatch.setattr(sv, "comfy_requirements", lambda vol: calls.append(["comfy-requirements"]))
    monkeypatch.setattr(sv.shutil, "which", lambda name: f"/usr/bin/{name}")
    # imports in the venv (torch, nvvfx) and `python -c pass` succeed
    monkeypatch.setattr(sv.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="", stderr=""))
    for var in ("NODE_PACKS", "ATTENTION", "INSTALL_NVIDIA_RTX", "COMFYUI_REF", "COMFY_DIR", "VENV_DIR"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr("sys.argv", ["setup_volume.py", "--data", str(tmp_path)])
    return tmp_path, calls


def steps(calls):
    names = []
    for c in calls:
        if c[0] == "git":
            names.append("git " + next(x for x in c[1:] if x in ("init", "remote", "fetch", "checkout")))
            continue
        elif c[1:3] == ["-m", "venv"]:
            names.append("venv")
        elif c[1:4] == ["-m", "pip", "install"]:
            names.append("torch" if any(x.startswith("torch==") for x in c) else "pip " + c[-1])
        elif c[-1].endswith("install_nodes.py") or any(x.endswith("install_nodes.py") for x in c):
            names.append("packs")
        else:
            names.append(c[0])
    return names


def test_first_start_then_nothing_then_only_what_changed(volume, monkeypatch):
    data, calls = volume
    assert sv.main() == 0
    assert steps(calls) == ["git init", "git remote", "git fetch", "git checkout", "venv", "pip wheel", "torch",
                            "comfy-requirements", "packs"]
    marker = json.loads((data / "kitty" / "setup.json").read_text())
    assert marker["managed"] is True and marker["comfyui"] == json.loads(
        (sv.install_nodes.BACKEND / "custom_nodes.json").read_text())["comfyui"]["ref"]
    status = json.loads((data / "kitty" / "setup-status.json").read_text())
    assert status["state"] == "done" and status["step"] == "ready"

    calls.clear()
    assert sv.main() == 0 and calls == []  # an unchanged volume: seconds
    assert json.loads((data / "kitty" / "setup-status.json").read_text())["step"] == "up to date"

    monkeypatch.setenv("NODE_PACKS", "comfyui-kjnodes")  # e.g. a new image with another pack ref
    assert sv.main() == 0 and steps(calls) == ["packs"]
    packs = calls[0]
    assert packs[packs.index("--packs") + 1] == "comfyui-kjnodes" and "--keep-existing" not in packs

    calls.clear()
    monkeypatch.setenv("COMFYUI_REF", "v0.43.0")
    assert sv.main() == 0
    assert steps(calls) == ["git fetch", "git checkout", "comfy-requirements", "packs"]
    assert "-f" in calls[1] and "v0.43.0" in calls[1]


def test_a_comfyui_we_did_not_make_is_left_as_it_is(volume):
    data, calls = volume
    (data / "ComfyUI").mkdir()
    (data / "ComfyUI" / "main.py").write_text("")
    (data / "venv" / "bin").mkdir(parents=True)
    (data / "venv" / "bin" / "python").write_text("")
    assert sv.main() == 0
    assert steps(calls) == ["packs"]  # no checkout, no torch, no ComfyUI requirements in the user's own venv
    assert "--keep-existing" in calls[0] and "--no-windows" in calls[0]
    assert json.loads((data / "kitty" / "setup.json").read_text())["managed"] is False


def test_rtx_pack_can_be_left_out(volume, monkeypatch):
    data, calls = volume
    monkeypatch.setenv("INSTALL_NVIDIA_RTX", "false")
    assert sv.main() == 0
    packs = next(c for c in calls if any(x.endswith("install_nodes.py") for x in c))
    assert packs[packs.index("--skip") + 1] == sv.RTX_PACK


def test_check_for_serverless(volume, monkeypatch, capsys):
    data, calls = volume
    monkeypatch.setattr("sys.argv", ["setup_volume.py", "--data", str(data), "--check"])
    assert sv.main() == 1 and "start a pod" in capsys.readouterr().out
    monkeypatch.setattr("sys.argv", ["setup_volume.py", "--data", str(data)])
    sv.main()
    monkeypatch.setattr("sys.argv", ["setup_volume.py", "--data", str(data), "--check"])
    monkeypatch.setenv("NODE_PACKS", "comfyui-kjnodes")
    calls.clear()
    assert sv.main() == 0 and calls == []  # serverless never installs
    assert "older pins: packs" in capsys.readouterr().out


def test_failed_setup_is_reported_for_the_installer_page(volume, monkeypatch):
    data, calls = volume

    def broken_torch(*a, **k):
        raise sv.SetupError("failed: pip install torch")

    monkeypatch.setattr(sv, "pip", lambda vol, *args, **k: broken_torch() if any("torch==" in str(x) for x in args) else None)
    assert sv.main() == 1
    status = json.loads((data / "kitty" / "setup-status.json").read_text())
    assert status["state"] == "error" and "pip install torch" in status["message"]
    # an interrupted first run keeps the volume "managed": the next start continues instead of treating it as foreign
    assert json.loads((data / "kitty" / "setup.json").read_text()) == {"managed": True}
    monkeypatch.setattr("sys.argv", ["setup_volume.py", "--data", str(data), "--check"])
    assert sv.main() == 1  # serverless must not start on a half-made venv
