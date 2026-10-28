"""Delete job files older than RETENTION_DAYS (default 3; 0 keeps everything).

No timers and no storage lifecycle rules: a quick check runs when someone generates. The serverless handler calls
`clean_old_files()` at the start of each job (ComfyUI's input and output folders, and the S3 output prefix); on a
pod, the `kitty_cleanup` ComfyUI node calls it each time a prompt is queued. Each process checks at most every
10 minutes, in a background thread, so a job never waits for it. From the owner's production handler
(`cleanup_old_files`, 24 hours there).
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

CHECK_EVERY_S = 600
_last = 0.0
_lock = threading.Lock()


def retention_seconds() -> float:
    try:
        return float(os.environ.get("RETENTION_DAYS") or 3) * 86400
    except ValueError:
        return 3 * 86400


def local_dirs() -> list[Path]:
    """ComfyUI's input and output (start.sh passes WORK_DIR), and the S3 prefix when the bucket is this volume."""
    work = os.environ.get("WORK_DIR")
    dirs = [Path(work) / "input", Path(work) / "output"] if work else []
    data, prefix = os.environ.get("DATA_DIR"), (os.environ.get("S3_PREFIX") or "outputs").strip("/")
    if data and prefix:
        dirs.append(Path(data) / prefix)  # Runpod's S3 API writes bucket keys straight onto the network volume
    return dirs


def clean_dirs(dirs: list[Path], cutoff: float, log=print) -> int:
    removed = 0
    for top in dirs:
        if not top.is_dir():
            continue
        for root, _subdirs, files in os.walk(top):
            for name in files:
                path = Path(root) / name
                try:
                    if path.lstat().st_mtime < cutoff:
                        path.unlink()
                        removed += 1
                except OSError:
                    pass  # in use, already gone, or not ours to delete
    if removed:
        log(f"cleanup: removed {removed} file(s) older than {retention_seconds() / 86400:g} days")
    return removed


def clean_s3(client, bucket: str, prefix: str, cutoff: float, log=print, max_pages: int = 20) -> int:
    """Delete objects under `prefix/` older than the cutoff (oldest pages first are not guaranteed; runs again later)."""
    removed, token = 0, None
    for _ in range(max_pages):
        kwargs = {"Bucket": bucket, "Prefix": f"{prefix}/", "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        old = [{"Key": o["Key"]} for o in page.get("Contents", []) if o["LastModified"].timestamp() < cutoff]
        if old:
            client.delete_objects(Bucket=bucket, Delete={"Objects": old, "Quiet": True})
            removed += len(old)
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    if removed:
        log(f"cleanup: removed {removed} S3 object(s) under {prefix}/ older than {retention_seconds() / 86400:g} days")
    return removed


def clean_old_files(s3=None, log=print, now: float | None = None, wait: bool = False) -> bool:
    """Start a cleanup unless one ran in the last 10 minutes. `s3`: a boto3 client when outputs go to S3."""
    global _last
    if retention_seconds() <= 0:
        return False
    now = time.time() if now is None else now
    with _lock:
        if now - _last < CHECK_EVERY_S:
            return False
        _last = now
    cutoff = now - retention_seconds()

    def work():
        try:
            clean_dirs(local_dirs(), cutoff, log)
            bucket = os.environ.get("S3_BUCKET")
            if s3 is not None and bucket:
                clean_s3(s3, bucket, (os.environ.get("S3_PREFIX") or "outputs").strip("/"), cutoff, log)
        except Exception as e:  # noqa: BLE001 - a cleanup problem must never fail a job
            log(f"cleanup skipped: {type(e).__name__}: {e}")

    if wait:
        work()
    else:
        threading.Thread(target=work, daemon=True).start()
    return True
