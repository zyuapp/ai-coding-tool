import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { KeyValueStorage } from "../application/task-store.js";

/** What a window keeps between launches, as one JSON file of the same keys it kept in its own storage. */
export type JsonStorage = KeyValueStorage & {
  /** Takes on values a window still holds from hosting the runtime itself, without overwriting any it already has. */
  adopt(values: Record<string, string>): boolean;
};

function readValues(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** Every write lands whole: the file is replaced, never appended to, so a crash mid-write leaves the last one. */
export function createJsonStorage(file: string): JsonStorage {
  const values = readValues(file);
  function write() {
    mkdirSync(path.dirname(file), { recursive: true });
    const draft = `${file}.${process.pid}.tmp`;
    writeFileSync(draft, JSON.stringify(values));
    renameSync(draft, file);
  }
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
      write();
    },
    adopt: (incoming) => {
      let changed = false;
      for (const [key, value] of Object.entries(incoming)) {
        if (key in values) continue;
        values[key] = value;
        changed = true;
      }
      if (changed) write();
      return changed;
    },
  };
}
