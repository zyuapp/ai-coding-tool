import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { appCandidates, externalApps, type AppCandidate, type ExternalApp } from "../domain/external-apps.js";
import type { InstalledApp } from "../contracts/ipc.js";
import type { Platform } from "../domain/editors.js";
import { bundleIcon } from "./bundle-icon.js";

/** Narrowed once here: a platform the catalog does not know simply offers nothing to open. */
const PLATFORM = process.platform as Platform;

/** Long enough that opening the list twice costs one scan, short enough to see a new install. */
const SCAN_TTL_MS = 30_000;

let scan: { at: number; apps: Promise<InstalledApp[]> } | null = null;

/** Whether a candidate is on this machine, without starting anything. */
async function exists(candidate: AppCandidate) {
  if (candidate.probe) return readable(candidate.probe);
  return (await onPath(candidate.command)) !== null;
}

async function readable(target: string) {
  return access(target, constants.F_OK).then(() => true, () => false);
}

/** The launcher's absolute path, found the way a shell finds it, or null when PATH has none. */
async function onPath(command: string) {
  const extensions = PLATFORM === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const target = path.join(folder, `${command}${path.extname(command) ? "" : extension}`);
      if (await readable(target)) return target;
    }
  }
  return null;
}

/** The first place an application really is, which is also where its icon is read from. */
async function installed(entry: ExternalApp): Promise<InstalledApp | null> {
  for (const candidate of appCandidates(entry.id, PLATFORM, homedir(), "/")) {
    if (!(await exists(candidate))) continue;
    return { ...entry, icon: candidate.icon ? await bundleIcon(candidate.icon) : null };
  }
  return null;
}

/** Every application on this machine that can take a folder, in catalog order. */
export function listInstalledApps(): Promise<InstalledApp[]> {
  if (scan && Date.now() - scan.at < SCAN_TTL_MS) return scan.apps;
  const apps = Promise.all(externalApps(PLATFORM).map(installed))
    .then((results) => results.filter((entry): entry is InstalledApp => entry !== null))
    .catch((error) => {
      scan = null;
      throw error;
    });
  scan = { at: Date.now(), apps };
  return apps;
}

/** Starts a launcher and reports whether it was there, the way opening a file does. */
function launch(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    /** Some launchers spawn throws over outright, such as a `.cmd` on Windows without a shell. */
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Opens a checkout in one application, trying each place it might be until one answers. */
async function openFolderInApp(appId: string, folder: string) {
  const name = externalApps(PLATFORM).find((entry) => entry.id === appId)?.label;
  const candidates = appCandidates(appId, PLATFORM, homedir(), folder);
  if (!name || !candidates.length) throw new Error("AI Coding Tool does not know that application.");
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    if (await launch(candidate.command, candidate.args)) return;
  }
  throw new Error(`${name} is not installed on this machine.`);
}

/** Longer than any id the catalog holds, and still bounded. */
const MAX_APP_ID = 64;

/** Only the window asks for this, and only for a folder it already works in. */
export function serveExternalApps(trusted: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle("apps:list", (event) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    return listInstalledApps();
  });

  ipcMain.handle("apps:open", async (event, appId: unknown, root: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof appId !== "string" || !appId || appId.length > MAX_APP_ID) throw new Error("Invalid application.");
    const { fileInCheckout } = await import("./path-policy.mjs");
    await openFolderInApp(appId, await fileInCheckout(root, "."));
  });
}
