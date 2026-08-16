import {
  parseTaskStore,
  serializeTaskStore,
  type SerializedTaskStore,
  type StorageValues,
  type TaskStoreData,
  type TaskStoreParseResult,
} from "../domain/task.js";

export const TASK_STORE_KEYS = {
  v1: {
    tasks: "claudex.tasks.v1",
    projects: "claudex.projects.v1",
    lastFolder: "claudex.last-folder.v1",
  },
  v2: {
    envelope: "claudex.store.v2",
    tasks: "claudex.tasks.v2",
    projects: "claudex.projects.v2",
    lastFolder: "claudex.last-folder.v2",
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
    lastFolder: "threadline.last-folder.v2",
  },
} as const;

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type TaskStoreSaveResult =
  | { ok: true; values: SerializedTaskStore }
  | { ok: false; reason: "load-required" | "corrupt" | "storage"; error?: string };

export class TaskStore {
  private loaded = false;
  private writable = false;
  constructor(private readonly storage: KeyValueStorage) {}

  load(): TaskStoreParseResult {
    let envelope: string | null;
    let v2: StorageValues;
    let v1: StorageValues;
    try {
      envelope = this.storage.getItem(TASK_STORE_KEYS.v2.envelope);
      v2 = read(this.storage, TASK_STORE_KEYS.v2);
      v1 = read(this.storage, TASK_STORE_KEYS.v1);
      if (envelope === null && empty(v2) && empty(v1)) {
        envelope = this.storage.getItem(LEGACY_TASK_STORE_KEYS.v2.envelope);
        v2 = read(this.storage, LEGACY_TASK_STORE_KEYS.v2);
        v1 = read(this.storage, LEGACY_TASK_STORE_KEYS.v1);
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
        raw: { tasks: null, projects: null, lastFolder: null },
      };
    }
    const decodedEnvelope = envelope === null ? null : parseEnvelope(envelope);
    const result = decodedEnvelope === "corrupt"
      ? corruptEnvelope(envelope!)
      : decodedEnvelope
        ? parseTaskStore(decodedEnvelope)
        : v2.tasks !== null && v2.projects !== null && v2.lastFolder !== null
          ? parseTaskStore(v2)
          : parseTaskStore(v1);
    this.loaded = true;
    this.writable = result.ok;
    return result;
  }

  save(data: TaskStoreData): TaskStoreSaveResult {
    if (!this.loaded) return { ok: false, reason: "load-required" };
    if (!this.writable) return { ok: false, reason: "corrupt" };
    const values = serializeTaskStore(data);
    try {
      this.storage.setItem(TASK_STORE_KEYS.v2.envelope, JSON.stringify(values));
      return { ok: true, values };
    } catch (error) {
      this.writable = false;
      return { ok: false, reason: "storage", error: errorMessage(error) };
    }
  }
}

function read(storage: KeyValueStorage, keys: { tasks: string; projects: string; lastFolder: string }): StorageValues {
  return {
    tasks: storage.getItem(keys.tasks),
    projects: storage.getItem(keys.projects),
    lastFolder: storage.getItem(keys.lastFolder),
  };
}

function empty(values: StorageValues) {
  return values.tasks === null && values.projects === null && values.lastFolder === null;
}

function parseEnvelope(raw: string): StorageValues | "corrupt" {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "corrupt";
    if (![value.tasks, value.projects, value.lastFolder].every((item) => item === null || typeof item === "string")) return "corrupt";
    return value as StorageValues;
  } catch {
    return "corrupt";
  }
}

function corruptEnvelope(raw: string): TaskStoreParseResult {
  return {
    ok: false,
    canWrite: false,
    sourceVersion: 2,
    errorKind: "corrupt",
    errors: ["version 2 task storage envelope is invalid"],
    preservedV1: null,
    raw: { tasks: raw, projects: null, lastFolder: null },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
