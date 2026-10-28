import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
for sub in ("docker", "installer", "tools", "deploy"):
    sys.path.insert(0, str(BACKEND / sub))
