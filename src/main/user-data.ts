import { existsSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIRST_NAME = "Threadline";

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
    if (existsSync(adopted)) rmdirSync(adopted);
    renameSync(legacy, adopted);
    repointWorkspaces(path.join(adopted, "workspaces.v1.json"), legacy, adopted);
    return adopted;
  } catch (error) {
    console.error("Could not move the app data folder off its first name:", error);
    return legacy;
  }
}

/** Workspace roots are stored absolute, so the ones inside the folder move with it. */
function repointWorkspaces(registryPath: string, from: string, to: string) {
  if (!existsSync(registryPath)) return;
  const escape = (target: string) => JSON.stringify(`${target}${path.sep}`).slice(1, -1);
  const before = readFileSync(registryPath, "utf8");
  const after = before.replaceAll(escape(from), escape(to));
  if (after !== before) writeFileSync(registryPath, after);
}
