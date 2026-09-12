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
 */
function measure() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty("--app-height", `${viewport ? viewport.height : window.innerHeight}px`);
}

measure();
window.visualViewport?.addEventListener("resize", measure);
window.visualViewport?.addEventListener("scroll", measure);
window.addEventListener("resize", measure);

createRoot(document.getElementById("root")!).render(<App />);
