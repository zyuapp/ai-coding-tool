import {
  parseThreadStore,
  serializeThreadStore,
  type SerializedThreadStore,
  type StorageValues,
  type ThreadStoreData,
  type ThreadStoreParseResult,
} from "../domain/thread-storage.js";

export const TASK_STORE_KEYS = {
  v1: {
    tasks: "aicodingtool.tasks.v1",
    projects: "aicodingtool.projects.v1",
    lastFolder: "aicodingtool.last-folder.v1",
  },
  v2: {
    envelope: "aicodingtool.store.v2",
    tasks: "aicodingtool.tasks.v2",
    projects: "aicodingtool.projects.v2",
    worktrees: "aicodingtool.worktrees.v2",
    lastFolder: "aicodingtool.last-folder.v2",
  },
} as const;

export const LEGACY_TASK_STORE_KEYS = {
  v1: {
    tasks: "threadline.tasks.v1",
    projects: "threadline.projects.v1",
    lastFolder: "threadline.last-folder.v1",
  },
  v2: {
    envelope: "threadline.store.v2",
    tasks: "threadline.tasks.v2",
    projects: "threadline.projects.v2",
    worktrees: "threadline.worktrees.v2",
    lastFolder: "threadline.last-folder.v2",
  },
} as const;

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type TaskStoreSaveResult =
  | { ok: true; values: SerializedThreadStore }
  | { ok: false; reason: "load-required" | "corrupt" | "storage"; error?: string };

export class TaskStore {
  private loaded = false;
  private writable = false;
  constructor(private readonly storage: KeyValueStorage) {}

  load(): ThreadStoreParseResult {
    let envelope: string | null = null;
    let values: StorageValues | null = null;
    try {
      envelope = this.storage.getItem(TASK_STORE_KEYS.v2.envelope);
      if (envelope === null) {
        const v2 = read(this.storage, TASK_STORE_KEYS.v2);
        if (complete(v2)) {
          values = v2;
        } else {
          const v1 = read(this.storage, TASK_STORE_KEYS.v1);
          if (!empty(v2) || !empty(v1)) {
            values = v1;
          } else {
            envelope = this.storage.getItem(LEGACY_TASK_STORE_KEYS.v2.envelope);
            if (envelope === null) {
              const legacyV2 = read(this.storage, LEGACY_TASK_STORE_KEYS.v2);
              values = complete(legacyV2) ? legacyV2 : read(this.storage, LEGACY_TASK_STORE_KEYS.v1);
            }
          }
        }
      }
    } catch (error) {
      this.loaded = true;
      this.writable = false;
      return {
        ok: false,
        canWrite: false,
        sourceVersion: 0,
        errorKind: "storage",
        errors: [errorMessage(error)],
        preservedV1: null,
        raw: { tasks: null, projects: null, worktrees: null, lastFolder: null },
      };
    }
    const decodedEnvelope = envelope === null ? null : parseEnvelope(envelope);
    const result = decodedEnvelope === "corrupt"
      ? corruptEnvelope(envelope!)
      : decodedEnvelope
        ? parseThreadStore(decodedEnvelope)
        : parseThreadStore(values!);
    this.loaded = true;
    this.writable = result.ok;
    return result;
  }

  save(data: ThreadStoreData): TaskStoreSaveResult {
    if (!this.loaded) return { ok: false, reason: "load-required" };
    if (!this.writable) return { ok: false, reason: "corrupt" };
    const values = serializeThreadStore(data);
    try {
      this.storage.setItem(TASK_STORE_KEYS.v2.envelope, JSON.stringify(values));
      return { ok: true, values };
    } catch (error) {
      this.writable = false;
      return { ok: false, reason: "storage", error: errorMessage(error) };
    }
  }
}

function read(storage: KeyValueStorage, keys: { tasks: string; projects: string; worktrees?: string; lastFolder: string }): StorageValues {
  return {
    tasks: storage.getItem(keys.tasks),
    projects: storage.getItem(keys.projects),
    worktrees: keys.worktrees ? storage.getItem(keys.worktrees) : null,
    lastFolder: storage.getItem(keys.lastFolder),
  };
}

function empty(values: StorageValues) {
  return values.tasks === null && values.projects === null && values.lastFolder === null;
}

function complete(values: StorageValues) {
  return values.tasks !== null && values.projects !== null && values.lastFolder !== null;
}

function parseEnvelope(raw: string): StorageValues | "corrupt" {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "corrupt";
    if (![value.tasks, value.projects, value.lastFolder].every((item) => item === null || typeof item === "string")) return "corrupt";
    /** An envelope written before checkouts had records of their own carries no worktrees key. */
    if (value.worktrees !== undefined && value.worktrees !== null && typeof value.worktrees !== "string") return "corrupt";
    return { ...value, worktrees: (value.worktrees as string | null | undefined) ?? null } as StorageValues;
  } catch {
    return "corrupt";
  }
}

function corruptEnvelope(raw: string): ThreadStoreParseResult {
  return {
    ok: false,
    canWrite: false,
    sourceVersion: 2,
    errorKind: "corrupt",
    errors: ["version 2 task storage envelope is invalid"],
    preservedV1: null,
    raw: { tasks: raw, projects: null, worktrees: null, lastFolder: null },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
