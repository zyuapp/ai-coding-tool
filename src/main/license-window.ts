import { app, BrowserWindow, protocol } from "electron";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SCHEME = "aicodingtool-licenses";
const ROOT = `${SCHEME}://notices/`;
const OVERVIEW = "THIRD-PARTY-NOTICES.txt";
const CSP = `default-src 'none'; style-src 'unsafe-inline'; frame-src ${SCHEME}:; img-src data:`;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Only shipped notices are addressable; a URL never becomes a filesystem path. */
export async function licenseFiles(): Promise<Map<string, string>> {
  const root = app.isPackaged ? path.join(process.resourcesPath, "legal") : path.join(app.getAppPath(), "assets", "legal");
  const files = new Map((await readdir(root)).filter((name) => /\.(txt|md|html)$/i.test(name)).sort().map((name) => [name, path.join(root, name)]));
  if (!app.isPackaged) {
    for (const [directory, name] of [
      ["dist/renderer/legal", "RENDERER-THIRD-PARTY-LICENSES.md"],
      ["dist/mobile/legal", "MOBILE-THIRD-PARTY-LICENSES.md"],
      ["node_modules/electron/dist", "LICENSE"],
      ["node_modules/electron/dist", "LICENSES.chromium.html"],
    ]) {
      const filename = path.join(app.getAppPath(), directory, name);
      const entries = await readdir(path.dirname(filename)).catch(() => [] as string[]);
      if (entries.includes(name)) files.set(name, filename);
    }
  }
  return files;
}

export async function licenseResponse(url: string, files: ReadonlyMap<string, string>): Promise<Response> {
  const parsed = new URL(url);
  const raw = parsed.pathname.startsWith("/raw/");
  const name = decodeURIComponent(parsed.pathname.slice(raw ? 5 : 1)) || OVERVIEW;
  const file = files.get(name);
  if (parsed.protocol !== `${SCHEME}:` || parsed.host !== "notices" || !file) return new Response("License not found.", { status: 404 });
  const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP };
  try {
    if (raw) return new Response(name.endsWith(".html") ? await readFile(file, "utf8") : escapeHtml(await readFile(file, "utf8")), { headers });
    const links = [...files.keys()].map((entry) => `<a href="${ROOT}${encodeURIComponent(entry)}"${entry === name ? ' aria-current="page"' : ""}>${escapeHtml(entry === OVERVIEW ? "Overview" : entry)}</a>`).join("");
    const content = name.endsWith(".html")
      ? `<iframe title="${escapeHtml(name)}" sandbox="allow-same-origin" src="${ROOT}raw/${encodeURIComponent(name)}"></iframe>`
      : `<pre>${escapeHtml(await readFile(file, "utf8"))}</pre>`;
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Open Source Licenses</title>
      <style>
        :root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
        * { box-sizing: border-box; } body { margin: 0; display: flex; height: 100vh; }
        nav { width: 250px; flex-shrink: 0; overflow: auto; padding: 20px 12px; border-right: 1px solid GrayText; }
        h1 { font-size: 16px; margin: 0 8px 20px; } a { display: block; padding: 10px 8px; border-radius: 6px; color: inherit; text-decoration: none; overflow-wrap: anywhere; font-size: 12px; }
        a:hover, a[aria-current] { background: light-dark(#eee, #303030); } a:focus-visible { outline: 2px solid Highlight; }
        main { flex: 1; min-width: 0; overflow: auto; } pre { margin: 0; padding: 28px; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.65 ui-monospace, monospace; }
        iframe { width: 100%; height: 100%; border: 0; background: white; }
      </style></head><body><nav aria-label="License documents"><h1>Open Source Licenses</h1>${links}</nav><main>${content}</main></body></html>`, { headers });
  } catch {
    return new Response("This license document could not be read. Close this window and try again.", { status: 500 });
  }
}

let viewer: BrowserWindow | null = null;
let opening: Promise<void> | null = null;
let registered = false;

/** Keep one reader, independent of the OS's text-editor and terminal associations. */
export function openSourceLicenses(parent: BrowserWindow | null): Promise<void> {
  if (opening) return opening;
  if (viewer && !viewer.isDestroyed()) {
    if (viewer.isMinimized()) viewer.restore();
    viewer.show();
    viewer.focus();
    return Promise.resolve();
  }
  opening = (async () => {
    const files = await licenseFiles();
    if (!registered) {
      protocol.handle(SCHEME, (request) => licenseResponse(request.url, files));
      registered = true;
    }
    const created = new BrowserWindow({
      width: 1000, height: 760, minWidth: 650, minHeight: 400, title: "Open Source Licenses", show: false,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
    });
    viewer = created;
    created.setMenu(null);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(ROOT)) event.preventDefault();
    });
    created.webContents.on("will-frame-navigate", (event) => {
      if (!event.url.startsWith(ROOT)) event.preventDefault();
    });
    created.on("closed", () => { if (viewer === created) viewer = null; });
    try {
      await created.loadURL(ROOT);
      created.show();
    } catch (error) {
      created.destroy();
      throw error;
    }
  })().finally(() => { opening = null; });
  return opening;
}
