import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/** The lock `aic serve` holds on a data folder: the id of the process serving from it. */
const SERVE_LOCK = "serve.lock";
/** The lock the desktop app holds on its data folder: a link to `<host>-<pid>`, left behind by a crash. */
const APP_LOCK = "SingletonLock";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process serving from this folder, or null when none is; a lock a dead one left counts for nothing. */
export function servingProcess(userData: string): number | null {
  const lock = path.join(userData, SERVE_LOCK);
  if (!existsSync(lock)) return null;
  const holder = Number(readFileSync(lock, "utf8"));
  return Number.isInteger(holder) && holder !== process.pid && alive(holder) ? holder : null;
}

/** Whether the desktop app has this folder open. A lock naming a dead process here is one a crash left. */
export function desktopOpen(userData: string): boolean {
  const lock = path.join(userData, APP_LOCK);
  let target: string;
  try {
    target = readlinkSync(lock);
  } catch {
    return existsSync(lock);
  }
  const dash = target.lastIndexOf("-");
  const pid = Number(target.slice(dash + 1));
  if (dash < 0 || !Number.isInteger(pid) || target.slice(0, dash) !== hostname()) return true;
  return alive(pid);
}

/** Takes the folder for a server. A second server, or the desktop app, on the same data would write over it. */
export function claimServeLock(userData: string): () => void {
  const holder = servingProcess(userData);
  if (holder !== null) throw new Error(`AI Coding Tool is already serving from this folder (process ${holder}).`);
  if (desktopOpen(userData)) throw new Error("The desktop app is open on this data folder. Quit it before serving, or serve from another machine.");
  const lock = path.join(userData, SERVE_LOCK);
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}
