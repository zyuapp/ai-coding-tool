import { existsSync, linkSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function holderOf(lock: string): number | null {
  try {
    const holder = Number(readFileSync(lock, "utf8"));
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/** The process serving from this folder, or null when none is; a lock a dead one left counts for nothing. */
export function servingProcess(userData: string): number | null {
  const holder = holderOf(path.join(userData, SERVE_LOCK));
  return holder !== null && holder !== process.pid && alive(holder) ? holder : null;
}

/** Whole and in one step: the lock is a link to a file already holding the process id, which fails if one stands. */
function claim(lock: string): boolean {
  const staging = `${lock}.${process.pid}`;
  writeFileSync(staging, String(process.pid));
  try {
    linkSync(staging, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
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

/**
 * The turn to clear a dead server's lock: a link naming the starter that has it, made in one step.
 * A starter keeps its turn as long as it lives, however long it takes; only a turn a starter died
 * holding is taken over, and that starter cannot come back to finish it.
 */
function takeTurn(turn: string): boolean {
  try {
    symlinkSync(String(process.pid), turn);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let holder: number;
  try {
    holder = Number(readlinkSync(turn));
  } catch {
    return false;
  }
  if (!Number.isInteger(holder) || holder <= 0 || alive(holder)) return false;
  rmSync(turn, { force: true });
  try {
    symlinkSync(String(process.pid), turn);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Clears a dead server's lock and takes it, one starter at a time, so a starter that arrives while
 * another has the turn neither clears that one's fresh lock nor waits.
 */
function reclaim(userData: string, lock: string): boolean {
  const turn = `${lock}.reclaim`;
  if (!takeTurn(turn)) return false;
  try {
    if (servingProcess(userData) !== null) return false;
    rmSync(lock, { force: true });
    return claim(lock);
  } finally {
    rmSync(turn, { force: true });
  }
}

/** Takes the folder for a server. A second server, or the desktop app, on the same data would write over it. */
export function claimServeLock(userData: string): () => void {
  if (desktopOpen(userData)) throw new Error("The desktop app is open on this data folder. Quit it before serving, or serve from another machine.");
  const lock = path.join(userData, SERVE_LOCK);
  if (!claim(lock) && (servingProcess(userData) !== null || !reclaim(userData, lock))) {
    const holder = servingProcess(userData);
    throw new Error(holder === null ? "Another AI Coding Tool is starting to serve from this folder." : `AI Coding Tool is already serving from this folder (process ${holder}).`);
  }
  return () => {
    if (holderOf(lock) === process.pid) rmSync(lock, { force: true });
  };
}
