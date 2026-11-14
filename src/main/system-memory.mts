import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Free RAM alone excludes reclaimable caches and would stop healthy workloads. */
export async function availableMemory(): Promise<number> {
  try {
    if (process.platform === "linux") {
      const info = await readFile("/proc/meminfo", "utf8");
      const available = /^MemAvailable:\s+(\d+) kB$/m.exec(info);
      return available ? Number(available[1]) * 1024 : Infinity;
    }
    if (process.platform === "darwin") {
      const output = await new Promise<string>((resolve, reject) => execFile("/usr/bin/vm_stat", [], { timeout: 2000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      return availableMacMemory(output);
    }
  } catch { /* A failed pressure reading must not become a false emergency. */ }
  return Infinity;
}

export function availableMacMemory(output: string): number {
  const page = /page size of (\d+) bytes/.exec(output);
  if (!page) return Infinity;
  let pages = 0;
  for (const name of ["free", "inactive", "speculative"]) {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.$`, "m").exec(output);
    if (!match) return Infinity;
    pages += Number(match[1]);
  }
  return pages * Number(page[1]);
}
