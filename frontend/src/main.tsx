import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { WindowProvider } from "./lib/windowContext.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WindowProvider>
      <App />
    </WindowProvider>
  </StrictMode>
);
