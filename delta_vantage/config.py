"""Global configuration and paths."""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# .env loader (zero-dependency)
# ---------------------------------------------------------------------------


def _load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE pairs from a repo-root .env into os.environ.

    Real environment variables always win; values are never overridden.
    Lines that are blank, or start with ``#`` or ``;``, are skipped. No
    value interpolation is performed.
    """
    if path is None:
        root_candidates = [Path.cwd(), Path(__file__).resolve().parent.parent]
        path = next((c / ".env" for c in root_candidates if (c / ".env").is_file()), None)
    if path is None:
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("DV_DATA_DIR", Path.home() / ".delta-vantage"))
CACHE_DB = DATA_DIR / "cache.db"
STRATEGIES_DIR = Path(os.environ.get("DV_STRATEGIES_DIR", Path.cwd() / "strategies"))

DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Alpaca API keys (paper trading account)
# ---------------------------------------------------------------------------

ALPACA_API_KEY = os.environ.get("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.environ.get("ALPACA_SECRET_KEY", "")
