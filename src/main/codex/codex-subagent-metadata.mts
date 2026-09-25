import type { SubagentMetadata } from "../../domain/run.js";
import { CLIENT_INFO, codexAppServer, connectAppServer, type AppServerClient, type AppServerCommand } from "./app-server-client.mjs";

type MetadataClient = Pick<AppServerClient, "initialize" | "request" | "close">;
type MetadataConnect = (command: AppServerCommand) => MetadataClient;
const pending = new Map<string, Promise<SubagentMetadata>>();
const unavailable = new Map<string, { at: number; metadata: SubagentMetadata }>();
const waiting = new Set<() => void>();
let readingCount = 0;

/** Inspecting a saved child can recover settings even when its original session is no longer running. */
export function readCodexSubagentMetadata(id: string, connect: MetadataConnect = connectAppServer, timeoutMs = 20_000): Promise<SubagentMetadata> {
  const held = pending.get(id);
  if (held) return held;
  const cached = unavailable.get(id);
  if (cached && Date.now() - cached.at < 30_000) return Promise.resolve(cached.metadata);
  unavailable.delete(id);
  const reading = readWithSlot(id, connect, timeoutMs).then((metadata) => {
    if (!metadata.model || !metadata.effort) {
      unavailable.set(id, { at: Date.now(), metadata });
      if (unavailable.size > 256) unavailable.delete(unavailable.keys().next().value!);
    }
    return metadata;
  }).finally(() => pending.delete(id));
  pending.set(id, reading);
  return reading;
}

/** Rapid inspection changes share four process slots; absent settings are briefly cached above. */
async function readWithSlot(id: string, connect: MetadataConnect, timeoutMs: number): Promise<SubagentMetadata> {
  if (readingCount < 4) readingCount += 1;
  else await new Promise<void>((resolve) => waiting.add(resolve));
  try {
    return await read(id, connect, timeoutMs);
  } finally {
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else readingCount -= 1;
  }
}

async function read(id: string, connect: MetadataConnect, timeoutMs: number): Promise<SubagentMetadata> {
  let client: MetadataClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = connect(await codexAppServer(["--disable", "plugins", "--disable", "apps", "--disable", "hooks"]));
    const connection = client;
    const reading = (async () => {
      await connection.initialize(CLIENT_INFO);
      const { thread } = await connection.request("thread/read", { threadId: id, includeTurns: false });
      if (thread.id !== id) return {};
      return {
        ...(thread.model ? { model: thread.model } : {}),
        ...(thread.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
      };
    })();
    const expired = new Promise<SubagentMetadata>((resolve) => { timer = setTimeout(() => resolve({}), timeoutMs); });
    return await Promise.race([reading, expired]);
  } catch {
    /** Old or deleted provider threads have no recoverable settings; the inspector keeps its empty fields. */
    return {};
  } finally {
    clearTimeout(timer);
    await client?.close();
  }
}
