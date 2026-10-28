"""Job files older than RETENTION_DAYS go when someone generates; no timers."""
import datetime as dt
import os
import time

import cleanup
import core
import pytest


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(cleanup, "_last", 0.0)
    monkeypatch.setenv("WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "vol"))
    monkeypatch.delenv("RETENTION_DAYS", raising=False)
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("S3_PREFIX", raising=False)


def make(path, age_days):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")
    t = time.time() - age_days * 86400
    os.utime(path, (t, t))
    return path


def test_old_inputs_and_outputs_go_new_ones_stay(tmp_path):
    old_out = make(tmp_path / "work/output/kitty/job1/a.mp4", 4)
    old_in = make(tmp_path / "work/input/job1_image0.png", 3.1)
    on_volume = make(tmp_path / "vol/outputs/job0/b.png", 5)  # S3 keys written onto the network volume
    new = make(tmp_path / "work/output/kitty/job2/c.mp4", 1)
    model = make(tmp_path / "vol/ComfyUI/models/loras/x.safetensors", 30)
    assert cleanup.clean_old_files(wait=True)
    assert not old_out.exists() and not old_in.exists() and not on_volume.exists()
    assert new.exists() and model.exists()
    assert not cleanup.clean_old_files(wait=True)  # at most one check every 10 minutes


def test_retention_zero_keeps_everything(tmp_path, monkeypatch):
    monkeypatch.setenv("RETENTION_DAYS", "0")
    f = make(tmp_path / "work/output/old.png", 400)
    assert not cleanup.clean_old_files(wait=True) and f.exists()


class FakeS3:
    def __init__(self, objects):
        self.objects, self.deleted = objects, []

    def list_objects_v2(self, **kw):
        assert kw["Prefix"] == "outputs/"
        return {"Contents": [{"Key": k, "LastModified": t} for k, t in self.objects.items()], "IsTruncated": False}

    def delete_objects(self, Bucket, Delete):  # noqa: N803 - boto3's names
        self.deleted += [o["Key"] for o in Delete["Objects"]]


def test_s3_objects_older_than_three_days_are_deleted(monkeypatch):
    monkeypatch.setenv("S3_BUCKET", "b")
    now = dt.datetime.now(dt.timezone.utc)
    s3 = FakeS3({"outputs/j1/a.mp4": now - dt.timedelta(days=4), "outputs/j2/b.png": now - dt.timedelta(hours=5)})
    cleanup.clean_old_files(s3=s3, wait=True)
    assert s3.deleted == ["outputs/j1/a.mp4"]


def test_network_volume_free_space_is_unknown(monkeypatch, tmp_path):
    monkeypatch.setattr(core.shutil, "disk_usage", lambda p: core.shutil._ntuple_diskusage(0, 0, 687_765 * 1000 ** 3))
    assert core.free_bytes(tmp_path) is None
    core.check_space(10 ** 15, tmp_path)  # no false "not enough space" on such a volume
    monkeypatch.setattr(core.shutil, "disk_usage", lambda p: core.shutil._ntuple_diskusage(0, 0, 50 * 1000 ** 3))
    assert core.free_bytes(tmp_path) == 50 * 1000 ** 3
