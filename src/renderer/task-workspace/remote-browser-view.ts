import { MAX_BROWSER_VIEWPORT, type BrowserControl, type BrowserFrame, type BrowserViewport } from "../../contracts/browser-control";
import type { AppCommand } from "../../contracts/commands";

type Command = Extract<AppCommand, { type: "browser.viewport" | "browser.control" }>;
type Host = {
  read: () => Promise<BrowserFrame | null>;
  send: (command: Command) => Promise<void>;
  status: (message: string | null) => void;
};

function modifiers(event: MouseEvent | KeyboardEvent) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** DOM input and frame delivery have the lifetime of the visible panel, never the thread run. */
export function mountRemoteBrowser(canvas: HTMLCanvasElement, keyboard: HTMLTextAreaElement, tabId: string, host: Host) {
  let stopped = false;
  let frame: BrowserFrame | null = null;
  let viewport: BrowserViewport | null = null;
  let applied = "";
  let live = false;
  let sending = false;
  const queue: { epoch: number; input: BrowserControl }[] = [];
  const abort = new window.AbortController();
  const options = { signal: abort.signal };
  const context = canvas.getContext("2d");
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (!stopped && queue.length) {
        const next = queue.shift()!;
        await host.send({ type: "browser.control", tabId, ...next });
      }
    } catch (error) {
      queue.length = 0;
      if (!stopped) host.status(error instanceof Error ? error.message : String(error));
    } finally { sending = false; }
  }
  function input(input: BrowserControl) {
    if (!live || !frame || stopped) return;
    const last = queue.at(-1);
    if (input.kind === "pointer" && input.phase === "move" && last?.input.kind === "pointer" && last.input.phase === "move") queue.pop();
    if (input.kind === "wheel" && last?.input.kind === "wheel") {
      input = { ...input, deltaX: Math.max(-10_000, Math.min(10_000, input.deltaX + last.input.deltaX)), deltaY: Math.max(-10_000, Math.min(10_000, input.deltaY + last.input.deltaY)) };
      queue.pop();
    }
    if (queue.length >= 100) { host.status("The connection is catching up…"); return; }
    queue.push({ epoch: frame.epoch, input });
    void flush();
  }
  function point(event: MouseEvent) {
    if (!frame) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    // The canvas is sized to the frame's aspect ratio; coordinates are page CSS pixels.
    return { x: Math.max(0, Math.min(frame.width - 1, (event.clientX - box.left) / box.width * frame.width)),
      y: Math.max(0, Math.min(frame.height - 1, (event.clientY - box.top) / box.height * frame.height)) };
  }
  for (const [eventType, phase] of [["pointerdown", "down"], ["pointerup", "up"], ["pointermove", "move"]] as const) {
    canvas.addEventListener(eventType, (event) => {
      const position = point(event);
      if (!position) return;
      event.preventDefault();
      if (phase === "down") { keyboard.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId); }
      const button = phase === "move" && !event.buttons ? "none" : event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      input({ kind: "pointer", phase, ...position, button, buttons: event.buttons & 7, clicks: phase === "move" ? 0 : Math.min(3, Math.max(1, event.detail)), modifiers: modifiers(event) });
    }, options);
  }
  canvas.addEventListener("contextmenu", (event) => event.preventDefault(), options);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const position = point(event);
    if (!position) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame!.height : 1;
    input({ kind: "wheel", ...position, deltaX: Math.max(-10_000, Math.min(10_000, event.deltaX * scale)), deltaY: Math.max(-10_000, Math.min(10_000, event.deltaY * scale)), modifiers: modifiers(event) });
  }, { ...options, passive: false });
  for (const phase of ["down", "up"] as const) {
    keyboard.addEventListener(phase === "down" ? "keydown" : "keyup", (event) => {
      if (event.isComposing) return;
      // Paste is performed by this window; its input event transfers text, never a host clipboard.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      input({ kind: "key", phase, key: event.key, code: event.code, keyCode: event.keyCode, repeat: event.repeat, modifiers: modifiers(event) });
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) event.preventDefault();
    }, options);
  }
  keyboard.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing) return;
    const text = keyboard.value;
    keyboard.value = "";
    if (text) input({ kind: "text", text: text.slice(0, 16_384) });
  }, options);
  keyboard.addEventListener("compositionend", () => {
    const text = keyboard.value;
    keyboard.value = "";
    if (text) input({ kind: "text", text: text.slice(0, 16_384) });
  }, options);

  function measure() {
    const box = canvas.parentElement!.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) { viewport = null; return; }
    const scale = Math.min(1, MAX_BROWSER_VIEWPORT / box.width, MAX_BROWSER_VIEWPORT / box.height);
    viewport = { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
  }
  const observer = new ResizeObserver(measure);
  observer.observe(canvas.parentElement!);
  measure();

  async function follow() {
    host.status("Connecting…");
    while (!stopped) {
      if (!viewport || document.hidden) { live = false; applied = ""; await pause(250); continue; }
      const started = performance.now();
      try {
        const size = `${viewport.width}:${viewport.height}`;
        if (applied !== size) {
          live = false;
          await host.send({ type: "browser.viewport", tabId, viewport });
          applied = size;
          if (stopped) break;
        }
        const next = await host.read();
        if (stopped) break;
        if (!next) { live = false; host.status("This browser tab has closed."); break; }
        const picture = new Image();
        picture.src = `data:image/jpeg;base64,${next.data}`;
        await picture.decode();
        if (stopped) break;
        if (picture.naturalWidth < 1 || picture.naturalHeight < 1 || picture.naturalWidth > MAX_BROWSER_VIEWPORT || picture.naturalHeight > MAX_BROWSER_VIEWPORT) {
          throw new Error("The browser sent an invalid frame size.");
        }
        canvas.width = picture.naturalWidth;
        canvas.height = picture.naturalHeight;
        const box = canvas.parentElement!.getBoundingClientRect();
        const scale = Math.min(box.width / next.width, box.height / next.height);
        canvas.style.width = `${next.width * scale}px`;
        canvas.style.height = `${next.height * scale}px`;
        context?.drawImage(picture, 0, 0);
        frame = next;
        live = true;
        host.status(null);
      } catch (error) {
        live = false;
        applied = "";
        queue.length = 0;
        if (!stopped) host.status(error instanceof Error ? error.message : String(error));
        await pause(1_000);
      }
      await pause(Math.max(0, 125 - (performance.now() - started)));
    }
  }
  void follow();
  return () => {
    stopped = true;
    live = false;
    queue.length = 0;
    abort.abort();
    observer.disconnect();
    // The host lease expires after the final read. Another window may still be viewing this tab.
  };
}
