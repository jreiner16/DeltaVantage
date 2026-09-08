"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

// ── Constants ────────────────────────────────────────────────────────────────

const isDev = !app.isPackaged;
const BACKEND_PORT = 8321;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
// This file lives at <repo>/frontend/electron/main.cjs
const ELECTRON_DIR = __dirname;                                   // frontend/electron
const PROJECT_ROOT = path.resolve(ELECTRON_DIR, "../../");        // repo root (has server/, delta_vantage/)
// Vite builds to a non-synced temp dir (see vite.config.ts): the project lives
// under a cloud-synced folder that mangles writes into `frontend/dist/`.
const DIST_DIR = "/tmp/dv-frontend-dist";
// Dev server runs on 5174 with --strictPort (see package.json dev:electron).
// A fixed strict port avoids colliding with any stale `npm run dev` Vite that
// may still be squatting on 5173 and proxying to a dead backend.
const DEV_PORT = 5174;
const PYTHON = process.env.DV_PYTHON || (process.platform === "win32"
  ? path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
  : path.join(PROJECT_ROOT, ".venv", "bin", "python"));

// ── Backend subprocess ───────────────────────────────────────────────────────

let backendProc = null;

function startBackend() {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", "uvicorn", "server.main:app",
      "--host", "127.0.0.1",
      "--port", String(BACKEND_PORT),
    ];
    const opts = {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DV_SERVER_PORT: String(BACKEND_PORT) },
    };

    backendProc = spawn(PYTHON, args, opts);

    let started = false;
    const onReady = () => {
      if (started) return;
      started = true;
      resolve();
    };

    backendProc.stdout.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Uvicorn running") || s.includes("Application startup complete")) {
        onReady();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend-log", s.trim());
      }
    });

    backendProc.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Uvicorn running") || s.includes("Application startup complete")) {
        onReady();
      }
    });

    backendProc.on("error", reject);
    backendProc.on("exit", (code) => {
      if (!started) reject(new Error(`Backend exited with code ${code}`));
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!started) {
        reject(new Error("Backend startup timed out"));
      }
    }, 30000);
  });
}

function waitForBackend(maxAttempts = 60, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get(`${BACKEND_URL}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (++attempts < maxAttempts) return setTimeout(check, intervalMs);
        reject(new Error("Backend health check timed out"));
      }).on("error", () => {
        if (++attempts < maxAttempts) return setTimeout(check, intervalMs);
        reject(new Error("Backend health check timed out"));
      });
    };
    check();
  });
}

function stopBackend() {
  if (backendProc) {
    try { backendProc.kill("SIGTERM"); } catch {}
    backendProc = null;
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────

let hubWindow = null;
let mainWindow = null;
const detachedWindows = new Map();

function createHubWindow() {
  hubWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 450,
    title: "Delta Vantage",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    hubWindow.loadURL(`http://localhost:${DEV_PORT}/?window=hub`);
  } else {
    hubWindow.loadFile(path.join(DIST_DIR, "index.html"), {
      hash: "/?window=hub",
    });
  }

  hubWindow.on("closed", () => {
    hubWindow = null;
    // If no other windows open, quit
    if (!mainWindow || mainWindow.isDestroyed()) {
      app.quit();
    }
  });
}

function createPortfolioWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Delta Vantage",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${DEV_PORT}/?window=portfolio`);
  } else {
    mainWindow.loadFile(path.join(DIST_DIR, "index.html"), {
      hash: "/?window=portfolio",
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Close all detached panels
    for (const [, win] of detachedWindows) {
      if (!win.isDestroyed()) win.close();
    }
    detachedWindows.clear();
  });
}

function createDetachedPanel(panelType) {
  const panelTitles = {
    chart: "Chart",
    watchlist: "Watchlist",
    orders: "Orders",
    strategy: "Strategy",
    performance: "Performance",
    backtest: "Backtest",
  };

  const win = new BrowserWindow({
    width: 600,
    height: 500,
    minWidth: 300,
    minHeight: 250,
    title: `Delta Vantage — ${panelTitles[panelType] || panelType}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = isDev
    ? `http://localhost:${DEV_PORT}/detachedPanel.html?window=detached&panel=${panelType}`
    : `${path.join(DIST_DIR, "detachedPanel.html")}?window=detached&panel=${panelType}`;

  if (isDev) {
    win.loadURL(url);
  } else {
    win.loadFile(path.join(DIST_DIR, "detachedPanel.html"), {
      search: `window=detached&panel=${panelType}`,
    });
  }

  const id = `${panelType}-${Date.now()}`;
  detachedWindows.set(id, win);
  win.on("closed", () => detachedWindows.delete(id));

  return id;
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle("open-portfolio", (_e, pid) => {
    createPortfolioWindow();
    // Send the portfolio ID to open after a short delay to let the window load
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("open-portfolio", pid);
      }
    }, 500);
    return true;
  });

  ipcMain.handle("detach-panel", (_e, panelType) => {
    return createDetachedPanel(panelType);
  });

  ipcMain.handle("get-backend-url", () => BACKEND_URL);

  ipcMain.handle("is-electron", () => true);

  ipcMain.handle("open-external", (_e, url) => {
    shell.openExternal(url);
  });

  // Cross-window state sync: broadcast messages to all windows
  ipcMain.on("broadcast", (event, channel, data) => {
    const sender = event.sender;
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (win.webContents !== sender && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  });

  ipcMain.handle("get-window-type", () => {
    // This is determined by the URL param, but we can also check window size
    return "unknown"; // The renderer determines this from URL params
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  setupIPC();
  createHubWindow();

  // Start backend in background and notify the hub of progress
  const sendStatus = (msg) => {
    if (hubWindow && !hubWindow.isDestroyed()) {
      hubWindow.webContents.send("boot-status", msg);
    }
  };

  sendStatus("starting backend");

  try {
    await startBackend();
    sendStatus("server ready");
    await waitForBackend();
    sendStatus("ready");
  } catch (err) {
    console.error("Backend failed to start:", err.message);
    sendStatus("backend failed — try again");
  }

  // Tell the renderer boot is done
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.webContents.send("boot-complete");
  }
});

app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createHubWindow();
  }
});

app.on("before-quit", () => {
  stopBackend();
});
