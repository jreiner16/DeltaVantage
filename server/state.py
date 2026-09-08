"""Save application state (server-side)
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from delta_vantage.config import DATA_DIR
from delta_vantage.data.cache import BarCache
from delta_vantage.trading.paper import PaperBroker
from server.performance import performance
from server.settings import settings
from server.watchlist import DEFAULT_WATCHLIST, watchlist

_PORTFOLIOS_DIR = DATA_DIR / "portfolios"
_PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
_INDEX_FILE = _PORTFOLIOS_DIR / "index.json"


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip().lower()).strip("-")
    return slug or f"portfolio-{uuid.uuid4().hex[:6]}"


class PortfolioManager:
    def __init__(self, data_dir: Path = _PORTFOLIOS_DIR) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._meta: dict = {}
        self._index: dict = {"current": None, "portfolios": {}}
        self._load_index()

    # ── index helpers ────────────────────────────────────────────────────
    def _load_index(self) -> None:
        try:
            if _INDEX_FILE.exists():
                self._index = json.loads(_INDEX_FILE.read_text())
        except Exception:
            self._index = {"current": None, "portfolios": {}}
        self._index.setdefault("portfolios", {})
        self._index.setdefault("current", None)
        # Self-heal: any folder under data_dir that looks like a portfolio
        # stays listed even if it's missing from (or lost from) index.json.
        on_disk = {
            p.name
            for p in self.data_dir.iterdir()
            if p.is_dir() and (p / "meta.json").exists()
        } if self.data_dir.is_dir() else set()
        self._index["portfolios"] = {
            k: v
            for k, v in self._index["portfolios"].items()
            if k in on_disk
        }
        for pid in on_disk:
            self._index["portfolios"].setdefault(pid, True)
        if self._index["current"] not in self._index["portfolios"]:
            self._index["current"] = next(
                (p for p in self._index["portfolios"]), None
            )

    def _save_index(self) -> None:
        try:
            _INDEX_FILE.write_text(json.dumps(self._index, indent=2))
        except Exception:
            pass

    def _portfolio_dir(self, pid: str) -> Path:
        return self.data_dir / pid

    def _load_meta(self, pid: str) -> dict:
        try:
            return json.loads((self._portfolio_dir(pid) / "meta.json").read_text())
        except Exception:
            return {}

    def _save_meta(self, pid: str, meta: dict) -> None:
        (self._portfolio_dir(pid) / "meta.json").write_text(json.dumps(meta, indent=2))

    # ── queries ──────────────────────────────────────────────────────────
    def list(self) -> list[dict]:
        with self._lock:
            out = []
            for pid in self._index["portfolios"]:
                meta = self._load_meta(pid)
                out.append(
                    {
                        "id": pid,
                        "name": meta.get("name", pid),
                        "created": meta.get("created"),
                        "last_opened": meta.get("last_opened"),
                        "starting_cash": meta.get("starting_cash", 100_000.0),
                        "equity": meta.get("equity"),
                        "realized_pnl": meta.get("realized_pnl"),
                        "equity_curve": self._equity_curve(pid),
                        "current": pid == self._index["current"],
                    }
                )
            out.sort(key=lambda p: p["last_opened"] or "", reverse=True)
            return out

    def _equity_curve(self, pid: str, max_points: int = 60) -> list[float]:
        try:
            data = json.loads(self._path(pid, "performance.json").read_text())
            points = data.get("points", [])
        except Exception:
            return []
        if not points:
            return []
        eq = [float(p.get("equity", 0)) for p in points]
        if len(eq) <= max_points:
            return eq
        step = len(eq) / max_points
        return [eq[int(i * step)] for i in range(max_points - 1)] + [eq[-1]]

    def current(self) -> str | None:
        with self._lock:
            return self._index["current"]

    def _path(self, pid: str, filename: str) -> Path:
        return self._portfolio_dir(pid) / filename

    # ── mutation ─────────────────────────────────────────────────────────
    def create(
        self, name: str, starting_cash: float | None = None, extra_settings: dict | None = None
    ) -> dict:
        with self._lock:
            name = name.strip()
            if not name:
                raise ValueError("Portfolio name is required")
            pid = _slugify(name)
            # Avoid clobbering an existing portfolio folder.
            base = pid
            n = 2
            while (self._portfolio_dir(pid)).exists():
                pid = f"{base}-{n}"
                n += 1
            pdir = self._portfolio_dir(pid)
            pdir.mkdir(parents=True, exist_ok=True)
            cash = starting_cash if starting_cash is not None else settings.get("starting_cash")
            meta = {
                "name": name,
                "created": datetime.now(UTC).isoformat(),
                "last_opened": datetime.now(UTC).isoformat(),
                "starting_cash": cash,
            }
            self._save_meta(pid, meta)
            # Seed default watchlist for a fresh portfolio.
            watchlist.reload(self._path(pid, "watchlist.json"))
            for sym in DEFAULT_WATCHLIST:
                watchlist.add(sym)
            performance.reload(self._path(pid, "performance.json"))
            settings.reload(self._path(pid, "settings.json"))
            # Apply any per-portfolio settings overrides.
            if extra_settings:
                settings.update(extra_settings)
            broker.reset(initial_cash=cash)
            broker.save(self._path(pid, "account.json"))
            self._index["portfolios"][pid] = True
            self._index["current"] = pid
            self._save_index()
            return self.list_entry(pid)

    def list_entry(self, pid: str) -> dict:
        meta = self._load_meta(pid)
        return {
            "id": pid,
            "name": meta.get("name", pid),
            "created": meta.get("created"),
            "last_opened": meta.get("last_opened"),
            "starting_cash": meta.get("starting_cash", 100_000.0),
            "equity": meta.get("equity"),
            "realized_pnl": meta.get("realized_pnl"),
            "current": pid == self._index["current"],
        }

    def open(self, pid: str) -> dict:
        with self._lock:
            pdir = self._portfolio_dir(pid)
            if not pdir.exists():
                raise KeyError(f"Portfolio '{pid}' not found")
            self._index["current"] = pid
            self._index["portfolios"][pid] = True
            now = datetime.now(UTC).isoformat()
            meta = self._load_meta(pid)
            meta["last_opened"] = now
            self._save_meta(pid, meta)
            self._save_index()
            # Hot-swap all scoped state in place.
            broker.load(self._path(pid, "account.json"))
            performance.reload(self._path(pid, "performance.json"))
            watchlist.reload(self._path(pid, "watchlist.json"))
            settings.reload(self._path(pid, "settings.json"))
            # Restore live strategies for this portfolio.
            live_manager.stop_all()
            saved_ls = self.load_live_strategies(pid)
            if saved_ls:
                live_manager.restore(saved_ls)
            return self.list_entry(pid)

    def save_current(self) -> None:
        pid = self._index["current"]
        if not pid:
            return
        broker.save(self._path(pid, "account.json"))
        meta = self._load_meta(pid)
        pf = broker.get_portfolio()
        meta["equity"] = round(pf.total_value, 2)
        meta["realized_pnl"] = round(pf.realized_pnl, 2)
        self._save_meta(pid, meta)
        self.save_live_strategies(pid, live_manager.to_dict())

    def rename(self, pid: str, name: str) -> dict:
        with self._lock:
            name = name.strip()
            if not name:
                raise ValueError("Portfolio name is required")
            meta = self._load_meta(pid)
            meta["name"] = name
            self._save_meta(pid, meta)
            return self.list_entry(pid)

    def delete(self, pid: str) -> None:
        with self._lock:
            import shutil

            pdir = self._portfolio_dir(pid)
            if pdir.exists():
                shutil.rmtree(pdir, ignore_errors=True)
            self._index["portfolios"].pop(pid, None)
            if self._index["current"] == pid:
                self._index["current"] = None
            self._save_index()

    # ── export / import ──────────────────────────────────────────────────
    _EXPORT_FILES = (
        "account.json",
        "meta.json",
        "performance.json",
        "watchlist.json",
        "settings.json",
        "backtests.json",
        "live_strategies.json",
    )

    def export(self, pid: str) -> dict:
        """Portfolios can be exported to JSONs for secure saving/sharing"""
        with self._lock:
            pdir = self._portfolio_dir(pid)
            if not pdir.exists():
                raise KeyError(f"Portfolio '{pid}' not found")
            meta = self._load_meta(pid)
            entry = self.list_entry(pid)
            files: dict[str, dict] = {}
            for fn in self._EXPORT_FILES:
                fp = self._path(pid, fn)
                if fp.exists():
                    try:
                        files[fn] = json.loads(fp.read_text())
                    except Exception:
                        pass
            # Fold the equity curve into the meta so thumbnails render after import.
            perf = files.get("performance.json", {})
            if "points" not in files.get("meta.json", {}):
                files["meta.json"] = {
                    **files.get("meta.json", {}),
                    "equity_curve": perf.get("points", []),
                }
            return {
                "format": "delta-vantage-portfolio",
                "version": 1,
                "id": pid,
                "name": meta.get("name", entry["name"]),
                "files": files,
            }

    def import_payload(self, payload: dict, name: str | None = None) -> dict:
        with self._lock:
            if not isinstance(payload, dict) or payload.get("format") != "delta-vantage-portfolio":
                raise ValueError("Not a valid portfolio file")
            files = payload.get("files")
            if not isinstance(files, dict):
                raise ValueError("Not a valid portfolio file")
            meta = files.get("meta.json")
            if not isinstance(meta, dict):
                meta = {}
            base_name = (name or payload.get("name") or meta.get("name") or "imported").strip()
            if not base_name:
                base_name = "imported"
            # Allocate a fresh folder id derived from the name, never clobbering.
            pid = _slugify(base_name)
            base = pid
            n = 2
            while (self._portfolio_dir(pid)).exists():
                pid = f"{base}-{n}"
                n += 1
            pdir = self._portfolio_dir(pid)
            pdir.mkdir(parents=True, exist_ok=True)
            now = datetime.now(UTC).isoformat()
            safe_meta = {
                "name": base_name,
                "created": meta.get("created", now),
                "last_opened": meta.get("last_opened"),
                "starting_cash": meta.get("starting_cash", settings.get("starting_cash")),
                "equity": meta.get("equity"),
                "realized_pnl": meta.get("realized_pnl"),
            }
            self._save_meta(pid, safe_meta)
            for fn in self._EXPORT_FILES:
                if fn == "meta.json":
                    continue
                data = files.get(fn)
                if isinstance(data, (dict, list)):
                    try:
                        self._path(pid, fn).write_text(json.dumps(data, indent=2))
                    except Exception:
                        pass
            self._index["portfolios"][pid] = True
            self._index["current"] = pid
            self._save_index()
            # Hot-swap into the newly imported portfolio.
            broker.load(self._path(pid, "account.json"))
            performance.reload(self._path(pid, "performance.json"))
            watchlist.reload(self._path(pid, "watchlist.json"))
            settings.reload(self._path(pid, "settings.json"))
            return self.list_entry(pid)

    # ── live strategy persistence ────────────────────────────────────────
    def save_live_strategies(self, pid: str, data: dict) -> None:
        try:
            self._path(pid, "live_strategies.json").write_text(json.dumps(data, indent=2))
        except Exception:
            pass

    def load_live_strategies(self, pid: str) -> dict:
        try:
            data = json.loads(self._path(pid, "live_strategies.json").read_text())
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {}

    # ── backtest persistence (results + config presets) ──────────────────
    def _backtests(self, pid: str) -> dict:
        try:
            data = json.loads(self._path(pid, "backtests.json").read_text())
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {"runs": [], "presets": {}}

    def _save_backtests(self, pid: str, data: dict) -> None:
        try:
            self._path(pid, "backtests.json").write_text(json.dumps(data, indent=2))
        except Exception:
            pass

    def list_backtests(self, pid: str) -> list[dict]:
        with self._lock:
            data = self._backtests(pid)
            runs = data.get("runs", [])
            runs.sort(key=lambda r: r.get("ts", ""), reverse=True)
            # Keep the payload lean; full result is loaded on demand.
            return [
                {
                    "id": r["id"],
                    "label": r.get("label", ""),
                    "strategy": r.get("strategy", ""),
                    "symbol": r.get("symbol", ""),
                    "interval": r.get("interval", ""),
                    "days": r.get("days", 30),
                    "ts": r.get("ts", ""),
                    "total_return_pct": r.get("metrics", {}).get("total_return_pct"),
                    "sharpe_ratio": r.get("metrics", {}).get("sharpe_ratio"),
                    "win_rate": r.get("metrics", {}).get("win_rate"),
                    "trade_count": r.get("trade_count", 0),
                }
                for r in runs
            ]

    def get_backtest(self, pid: str, bid: str) -> dict | None:
        with self._lock:
            for r in self._backtests(pid).get("runs", []):
                if r.get("id") == bid:
                    return r
            return None

    def save_backtest(
        self, pid: str, label: str, strategy: str, config: dict, result: dict
    ) -> dict:
        with self._lock:
            data = self._backtests(pid)
            run = {
                "id": uuid.uuid4().hex[:12],
                "label": label,
                "strategy": strategy,
                "symbol": config.get("symbol", ""),
                "interval": config.get("interval", ""),
                "days": config.get("days", 30),
                "params": config.get("params", {}),
                "ts": datetime.now(UTC).isoformat(),
                **result,
            }
            runs = data.setdefault("runs", [])
            runs.append(run)
            if len(runs) > 50:
                runs[:] = runs[-50:]
            self._save_backtests(pid, data)
            return run

    def delete_backtest(self, pid: str, bid: str) -> None:
        with self._lock:
            data = self._backtests(pid)
            data["runs"] = [r for r in data.get("runs", []) if r.get("id") != bid]
            self._save_backtests(pid, data)

    def list_presets(self, pid: str) -> dict:
        with self._lock:
            return self._backtests(pid).get("presets", {})

    def save_preset(self, pid: str, name: str, config: dict) -> None:
        with self._lock:
            data = self._backtests(pid)
            data.setdefault("presets", {})[name] = config
            self._save_backtests(pid, data)

    def delete_preset(self, pid: str, name: str) -> None:
        with self._lock:
            data = self._backtests(pid)
            data.setdefault("presets", {}).pop(name, None)
            self._save_backtests(pid, data)


# The shared broker owns the account state for the active portfolio.
broker = PaperBroker(
    initial_cash=settings.get("starting_cash"),
    slippage=settings.get("slippage"),
    share_increment=settings.get("share_increment") or 1,
    min_order_qty=settings.get("min_order_qty"),
    max_order_qty=settings.get("max_order_qty"),
    short_leverage=settings.get("short_leverage"),
)
cache = BarCache()

from server.live_strategies import LiveStrategyManager

live_manager = LiveStrategyManager(broker, cache)

manager = PortfolioManager()


def _auto_open_or_seed() -> None:
    # Give the module-scope broker a chance to be wired to whatever folder.
    current = manager.current()
    if current:
        try:
            manager.open(current)
            return
        except Exception:
            pass
    # No portfolio yet: create a starting "Default" portfolio from any legacy
    # single-account state so nothing is lost.
    try:
        entry = manager.create("default")
        manager.open(entry["id"])
    except Exception:
        pass


# On boot, restore the last-opened portfolio or create/ensure a seed.
_auto_open_or_seed()
