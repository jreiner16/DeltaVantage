import { createContext, useContext, useEffect, useState } from "react";

// ── Electron API types exposed via preload ──────────────────────────────────

export interface ElectronAPI {
  openPortfolio: (pid: string) => Promise<boolean>;
  detachPanel: (panelType: string) => Promise<string>;
  getBackendUrl: () => Promise<string>;
  isElectron: () => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  onOpenPortfolio: (cb: (pid: string) => void) => void;
  onBootStatus: (cb: (msg: string) => void) => void;
  onBootComplete: (cb: () => void) => void;
  onStateUpdate: (cb: (data: unknown) => void) => void;
  broadcast: (channel: string, data: unknown) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// ── Window types ───────────────────────────────────────────────────────────

export type WindowType = "hub" | "portfolio" | "detached";

export interface WindowContextValue {
  windowType: WindowType;
  detachedPanel: string | null; // panel type if windowType === "detached"
  isElectron: boolean;
  electronAPI: ElectronAPI | null;
}

const WindowContext = createContext<WindowContextValue>({
  windowType: "portfolio",
  detachedPanel: null,
  isElectron: false,
  electronAPI: null,
});

export function useWindowContext() {
  return useContext(WindowContext);
}

function detectWindowType(): { windowType: WindowType; detachedPanel: string | null } {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^[#?]+/, ""));

  const win = params.get("window") || hashParams.get("window");
  const panel = params.get("panel") || hashParams.get("panel");

  switch (win) {
    case "hub":
      return { windowType: "hub", detachedPanel: null };
    case "detached":
      return { windowType: "detached", detachedPanel: panel };
    case "portfolio":
    default:
      return { windowType: "portfolio", detachedPanel: null };
  }
}

export function WindowProvider({ children }: { children: React.ReactNode }) {
  const [ctx, setCtx] = useState<WindowContextValue>(() => {
    const { windowType, detachedPanel } = detectWindowType();
    return {
      windowType,
      detachedPanel,
      isElectron: false,
      electronAPI: window.electronAPI ?? null,
    };
  });

  useEffect(() => {
    // Detect Electron at runtime
    if (window.electronAPI) {
      window.electronAPI.isElectron().then((is) => {
        setCtx((prev) => ({ ...prev, isElectron: is, electronAPI: window.electronAPI! }));
      });
    }
  }, []);

  return <WindowContext.Provider value={ctx}>{children}</WindowContext.Provider>;
}
