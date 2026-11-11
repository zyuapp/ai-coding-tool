import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECORD = "update-relaunch.json";

/** Writes down the threads to carry on once `version` is the build running. */
export function recordUpdateRelaunch(userData: string, version: string, taskIds: readonly string[]) {
  const record = path.join(userData, RECORD);
  try {
    if (taskIds.length) writeFileSync(record, JSON.stringify({ version, taskIds }));
    else rmSync(record, { force: true });
  } catch (error) {
    console.error("Could not record the threads to resume after updating:", error);
  }
}

/**
 * The threads the last update cut off, read once. A record left by an install that never took is
 * for another version, and is dropped.
 */
export function takeUpdateRelaunch(userData: string, version: string): string[] {
  const record = path.join(userData, RECORD);
  let raw: string;
  try {
    raw = readFileSync(record, "utf8");
  } catch {
    return [];
  }
  rmSync(record, { force: true });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const { version: recorded, taskIds } = parsed as { version?: unknown; taskIds?: unknown };
    if (recorded !== version || !Array.isArray(taskIds)) return [];
    return taskIds.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
