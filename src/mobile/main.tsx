import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./mobile.css";

/**
 * The phone follows the system's own ground rather than the desktop's stored theme: it is a
 * different device, and a phone in the dark should not be lit by a choice made at a Mac.
 * StrictMode is left off because its second mount would open, drop and reopen the socket, and a
 * pairing code is only good once.
 */
function paint(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "aicodingtool-dark" : "aicodingtool-light";
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
paint(scheme.matches);
scheme.addEventListener("change", (event) => paint(event.matches));

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
