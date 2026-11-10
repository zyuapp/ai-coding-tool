import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { followFramePanes, shareListenersWithGlassLayer } from "./glass-layer";
import { applyWindowChrome } from "./platform";
import { applyStoredTheme } from "./theme";
import { applyStoredTypography } from "./typography";

applyWindowChrome(window.desktop.platform, window.desktop.windowMaterial);
shareListenersWithGlassLayer();
if (window.desktop.windowMaterial === "glass") followFramePanes();
applyStoredTheme();
applyStoredTypography();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
