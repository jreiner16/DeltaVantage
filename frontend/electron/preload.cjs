const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openPortfolio: (pid) => ipcRenderer.invoke("open-portfolio", pid),
  detachPanel: (panelType) => ipcRenderer.invoke("detach-panel", panelType),
  getBackendUrl: () => ipcRenderer.invoke("get-backend-url"),
  isElectron: () => ipcRenderer.invoke("is-electron"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Cross-window events
  onOpenPortfolio: (cb) => {
    ipcRenderer.on("open-portfolio", (_e, pid) => cb(pid));
  },
  onBootStatus: (cb) => {
    ipcRenderer.on("boot-status", (_e, msg) => cb(msg));
  },
  onBootComplete: (cb) => {
    ipcRenderer.on("boot-complete", () => cb());
  },
  onStateUpdate: (cb) => {
    ipcRenderer.on("state-update", (_e, data) => cb(data));
  },

  // Broadcast state changes to other windows
  broadcast: (channel, data) => ipcRenderer.send("broadcast", channel, data),
});
