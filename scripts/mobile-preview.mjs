// @ts-check
import electron from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { emulatePhone, phoneLayout } from "./mobile-preview-layout.mjs";

// Screen is a native module that is available only after app.whenReady().
const { app, BrowserWindow, Menu } = electron;

app.setName("Mobile Preview");
const profile = path.join(app.getPath("appData"), "AI Coding Tool Mobile Preview");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);

/** @type {import("electron").BrowserWindow | null} */
let window = null;
let landscape = false;
let pageReady = false;
let quitting = false;
let emulated = "";

function fitPhone() {
  if (!window || window.isDestroyed()) return;
  const bounds = window.getBounds();
  const content = window.getContentBounds();
  const workArea = electron.screen.getDisplayMatching(bounds).workArea;
  const frame = { width: bounds.width - content.width, height: bounds.height - content.height };
  const layout = phoneLayout(landscape, workArea, frame);
  if (content.width !== layout.width || content.height !== layout.height) window.setContentSize(layout.width, layout.height);
  const key = `${window.webContents.getOSProcessId()}:${landscape}:${layout.scale}`;
  if (pageReady && key !== emulated) {
    emulatePhone(window.webContents, layout, true);
    emulated = key;
  }
  window.setTitle(`Mobile Preview — ${layout.viewSize.width} × ${layout.viewSize.height}`);
  const resized = window.getBounds();
  const x = Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - resized.width)));
  const y = Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - resized.height)));
  if (x !== resized.x || y !== resized.y) window.setPosition(x, y);
}

function previewMenu() {
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === "darwin" ? [{ role: /** @type {const} */ ("appMenu") }] : []),
    { role: "editMenu" },
    {
      label: "Preview",
      submenu: [
        { label: "Rotate", accelerator: "CmdOrCtrl+Shift+R", click: () => { landscape = !landscape; fitPhone(); } },
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { label: "Developer Tools", accelerator: "CmdOrCtrl+Alt+I", click: () => {
          const contents = window?.webContents;
          if (contents?.isDevToolsOpened()) contents.closeDevTools();
          else contents?.openDevTools({ mode: "detach" });
        } },
        { type: "separator" },
        { role: "close" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  const url = process.argv[2];
  if (!url || new URL(url).protocol !== "http:" || new URL(url).hostname !== "127.0.0.1") {
    throw new Error("Run npm run start:mobile to start the local preview.");
  }
  await app.whenReady();
  if (quitting) return;
  window = new BrowserWindow({
    title: "Mobile Preview",
    width: 390,
    height: 844,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: "#0e1117",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  previewMenu();
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (new URL(event.url).origin !== new URL(url).origin) event.preventDefault();
  });
  window.on("closed", () => { window = null; app.quit(); });
  window.on("moved", fitPhone);
  electron.screen.on("display-metrics-changed", fitPhone);
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) pageReady = false;
  });
  window.webContents.on("render-process-gone", () => { pageReady = false; emulated = ""; });
  window.webContents.on("did-finish-load", () => { pageReady = true; fitPhone(); });
  fitPhone();
  await window.loadURL(`${url}m/`);
  if (quitting || !window || window.isDestroyed()) return;
  window.show();
  // Electron can leave the first emulated frame unpresented. Request one compositor frame.
  await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
  console.log("Mobile Preview ready. Rotate: Cmd/Ctrl+Shift+R. DevTools: Cmd/Ctrl+Alt+I.");
}

// The launcher closes Vite when this process exits. A vanished launcher closes this window too.
process.on("disconnect", () => app.quit());
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => { window?.restore(); window?.show(); window?.focus(); });
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());

if (app.requestSingleInstanceLock()) {
  void start().catch((error) => {
    console.error("Could not start Mobile Preview:", error);
    process.exitCode = 1;
    app.quit();
  });
} else app.exit(0);
