import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIRST_NAME = "Threadline";

/** What a folder can hold and still count as empty: Chromium's lock, and the Finder's leavings. */
const DISPOSABLE = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", ".DS_Store"]);

/**
 * The app shipped as Threadline and carried that data folder through two renames. Moves it once so
 * the folder matches the app, and answers with the folder to read: the adopted one, or the old one
 * when the move cannot happen, so a launch never starts on an empty store. A target that already
 * holds data keeps it, and the old folder is left where it is.
 */
export function adoptUserDataFolder(appData: string, appName: string) {
  const legacy = path.join(appData, FIRST_NAME);
  const adopted = path.join(appData, appName);
  if (legacy === adopted || !existsSync(legacy)) return adopted;
  try {
    clearDisposable(adopted);
    renameSync(legacy, adopted);
    repointWorkspaces(path.join(adopted, "workspaces.v1.json"), legacy, adopted);
    return adopted;
  } catch (error) {
    console.error("Could not move the app data folder off its first name:", error);
    return legacy;
  }
}

/** Empties a folder that holds nothing worth keeping, and refuses the rest, so no store is buried. */
function clearDisposable(folder: string) {
  if (!existsSync(folder)) return;
  const kept = readdirSync(folder).filter((entry) => !DISPOSABLE.has(entry));
  if (kept.length) throw new Error(`${folder} already holds ${kept.length} file(s)`);
  for (const entry of readdirSync(folder)) rmSync(path.join(folder, entry), { force: true });
  rmdirSync(folder);
}

/** Workspace roots are stored absolute, so the ones inside the folder move with it. */
function repointWorkspaces(registryPath: string, from: string, to: string) {
  if (!existsSync(registryPath)) return;
  const escape = (target: string) => JSON.stringify(`${target}${path.sep}`).slice(1, -1);
  const before = readFileSync(registryPath, "utf8");
  const after = before.replaceAll(escape(from), escape(to));
  if (after !== before) writeFileSync(registryPath, after);
}
