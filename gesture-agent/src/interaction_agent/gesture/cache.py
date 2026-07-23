import os
import tempfile
from pathlib import Path


def configure_cache() -> None:
    cache_root = Path(tempfile.gettempdir()) / "gesture-agent-cache"
    cache_root.mkdir(exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", str(cache_root / "matplotlib"))
    os.environ.setdefault("XDG_CACHE_HOME", str(cache_root / "xdg"))
