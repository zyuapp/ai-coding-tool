import { createRoot } from "react-dom/client";
import { App } from "./App";
import { defaultMobileTheme, paintMobileTheme, readStoredTheme, resolveMobileTheme } from "./theme";
import "./mobile.css";

/**
 * The phone wears the desktop's theme. Until the Mac answers it wears the one it last saw, and on
 * "auto" it reads its own appearance. StrictMode is left off because its second mount would open,
 * drop and reopen the socket, and a pairing code is only good once.
 */
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
paintMobileTheme(resolveMobileTheme(readStoredTheme(window.localStorage) ?? defaultMobileTheme(), scheme.matches));

/**
 * The keyboard covers part of the window without shortening it, so the page is sized to the visual
 * viewport instead. That is what keeps the composer sitting on top of the keyboard rather than
 * under it, and what stops the transcript scrolling behind both.
 *
 * A home-screen app's visual viewport is short by the status bar, so there the page fills 100lvh
 * and gives up only what the keyboard takes: how far the viewport has shrunk from its tallest at
 * this width.
 */
let restingWidth = 0;
let restingHeight = 0;

function measure() {
  const viewport = window.visualViewport;
  const width = viewport ? viewport.width : window.innerWidth;
  const height = viewport ? viewport.height : window.innerHeight;
  if (width !== restingWidth) {
    restingWidth = width;
    restingHeight = height;
  } else {
    restingHeight = Math.max(restingHeight, height);
  }
  const style = document.documentElement.style;
  style.setProperty("--app-height", `${height}px`);
  style.setProperty("--keyboard-height", `${restingHeight - height}px`);
}

measure();
window.visualViewport?.addEventListener("resize", measure);
window.visualViewport?.addEventListener("scroll", measure);
window.addEventListener("resize", measure);

createRoot(document.getElementById("root")!).render(<App />);
