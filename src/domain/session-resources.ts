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
export type MemorySample = { at: number; bytes: number };
const GiB = 1024 ** 3;

/** Keep headroom for the desktop; a large machine does not grant one thread an unlimited budget. */
export function memoryBudget(total: number) { return Math.min(8 * GiB, Math.max(512 * 1024 ** 2, total / 4)); }

/** Several high samples tolerate brief peaks; sustained growth and critical headroom act sooner. */
export function unsafeMemory(samples: readonly MemorySample[], budget: number, available: number): boolean {
  const last = samples.at(-1);
  if (!last || !Number.isFinite(last.bytes) || last.bytes <= 0) return false;
  if (available < 256 * 1024 ** 2 && last.bytes >= 64 * 1024 ** 2) return true;
  const recent = samples.slice(-4);
  if (recent.length < 4 || last.at - recent[0]!.at < 15_000) return false;
  return recent.every(sample => sample.bytes >= budget)
    || recent.every(sample => sample.bytes >= budget / 2) && last.bytes - recent[0]!.bytes >= budget / 4;
}
