import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { applyStoredTheme } from "./theme";
import { applyStoredTypography } from "./typography";

applyStoredTheme();
applyStoredTypography();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
