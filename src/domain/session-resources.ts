/** A saved interruption, independent of whichever process the next session starts. */
export type ResourceStop = { at: number; bytes: number; cleanup: "stopping" | "complete" | "incomplete" };

export function isResourceStop(value: unknown): value is ResourceStop {
  if (!value || typeof value !== "object") return false;
  const stop = value as Record<string, unknown>;
  return typeof stop.at === "number" && Number.isFinite(stop.at) && stop.at >= 0
    && typeof stop.bytes === "number" && Number.isFinite(stop.bytes) && stop.bytes >= 0
    && ["stopping", "complete", "incomplete"].includes(String(stop.cleanup));
}

/** Resident memory includes native allocations and tool processes, beyond an engine's JS heap. */
export type MemorySample = { at: number; bytes: number; available: number };
export type MemoryVerdict = "critical" | "pressure";
const MiB = 1024 ** 2;

/** Reclaimable system memory below which the computer is under pressure. */
export function pressureLine(total: number) { return Math.max(512 * MiB, total / 16); }

/** Only system pressure stops a thread, however large it grows: critical headroom at once, otherwise sustained pressure while it holds an eighth of memory. */
export function unsafeMemory(samples: readonly MemorySample[], total: number): MemoryVerdict | undefined {
  const last = samples.at(-1);
  if (!last || !(last.bytes > 0)) return undefined;
  if (last.available < 256 * MiB && last.bytes >= 64 * MiB) return "critical";
  const recent = samples.slice(-4);
  if (recent.length < 4 || last.at - recent[0]!.at < 15_000) return undefined;
  const line = pressureLine(total);
  return recent.every(sample => sample.available < line && sample.bytes >= total / 8) ? "pressure" : undefined;
}
