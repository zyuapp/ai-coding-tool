import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WINDOW_STORAGE_FILE } from "./json-storage.js";

const LAUNCHED_VERSION = "launched-version";

/**
 * The version this launch updated the app to, or null when it is not the first launch since an
 * update. A profile from before the app kept this record has still launched before, which its window
 * storage shows, so it counts as updated too. Read once at startup, before the window writes there.
 */
export function readAppLaunch(userData: string, version: string): string | null {
  const record = path.join(userData, LAUNCHED_VERSION);
  let previous: string | null = null;
  try {
    previous = readFileSync(record, "utf8").trim() || null;
  } catch {}
  if (previous === version) return null;
  const launchedBefore = previous !== null || existsSync(path.join(userData, WINDOW_STORAGE_FILE));
  try {
    writeFileSync(record, version);
  } catch {}
  return launchedBefore ? version : null;
}
