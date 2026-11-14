import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { availableMemory } from "./system-memory.mjs";
import { totalmem } from "node:os";
import { memoryBudget, unsafeMemory, type MemorySample, type ResourceStop } from "../domain/session-resources.js";
import type { SessionResourceMessage } from "../contracts/session-resources.js";

export type ProcessSample = { pid: number; parent: number; bytes: number; born: string };
type Owned = { taskId: string; sessionId: string; roots: Set<number>; known: Map<number, string>; history: MemorySample[]; busy?: boolean; released?: number; stopped?: ResourceStop };

/** lstart distinguishes a live process from another that later reuses its PID, on macOS and Linux. */
export function parseProcessSamples(output: string): ProcessSample[] {
  const samples: ProcessSample[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/.exec(line);
    if (!match) continue;
    const [, pid, parent, rss, born] = match;
    const sample = { pid: Number(pid), parent: Number(parent), bytes: Number(rss) * 1024, born: born!.replace(/\s+/g, " ") };
    if (Number.isSafeInteger(sample.pid) && sample.pid > 1 && Number.isSafeInteger(sample.bytes)) samples.push(sample);
  }
  return samples;
}

export function readProcessSamples(): Promise<ProcessSample[]> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,rss=,lstart="], { env: { ...process.env, LC_ALL: "C" }, timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, output) => {
      if (error) reject(error); else resolve(parseProcessSamples(output));
    });
  });
}

export type ResourceMonitorOptions = {
  journal?: string;
  stop(taskId: string, sessionId: string, stop: ResourceStop): void;
  release?(taskId: string, sessionId: string): void;
  changed(taskId: string, stop: ResourceStop): void;
  read?: () => Promise<ProcessSample[]>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  memory?: () => { total: number; available: number };
};

/** Runs in the app host, independently of the engines and their shared worker's event loop. */
export class SessionResourceMonitor {
  private readonly sessions = new Map<string, Owned>();
  private timer?: ReturnType<typeof setTimeout>;
  private sampling?: Promise<void>;
  private closed = false;
  private enabled = true;
  private readonly ready: Promise<void>;
  private lastJournal = "";
  constructor(private readonly options: ResourceMonitorOptions) {
    this.ready = this.restore();
    void this.ready.then(() => this.schedule(0));
  }

  private async restore() {
    if (!this.options.journal) return;
    try {
      const entries: unknown = JSON.parse(await readFile(this.options.journal, "utf8"));
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || typeof entry.taskId !== "string" || typeof entry.sessionId !== "string" || !Array.isArray(entry.known)) continue;
        const known = new Map<number, string>();
        for (const pair of entry.known) if (Array.isArray(pair) && Number.isSafeInteger(pair[0]) && pair[0] > 1 && typeof pair[1] === "string") known.set(pair[0], pair[1]);
        if (known.size && !this.sessions.has(entry.sessionId)) this.sessions.set(entry.sessionId, { taskId: entry.taskId, sessionId: entry.sessionId, known, roots: new Set(), history: [], released: this.now() });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Memory protection recovery:", error);
    }
  }

  private async persist() {
    if (!this.options.journal) return;
    const data = JSON.stringify([...this.sessions.values()].filter(owner => owner.known.size).map(owner => ({ taskId: owner.taskId, sessionId: owner.sessionId, known: [...owner.known] })));
    if (data === this.lastJournal) return;
    const temporary = `${this.options.journal}.${process.pid}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, this.options.journal);
    this.lastJournal = data;
  }

  /** A crash's leftover processes must exit before the same thread starts another engine. */
  async beforeStart(taskId: string) {
    await this.ready;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (![...this.sessions.values()].some(owner => owner.taskId === taskId && owner.released !== undefined)) return;
      try { await this.sample(); } catch (error) { console.error("Memory protection cleanup retry:", error); }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("The previous session still has processes running. Wait for them to exit before resuming.");
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    for (const owner of this.sessions.values()) owner.history = [];
  }

  receive(event: SessionResourceMessage) {
    if (this.closed) return;
    let owner = this.sessions.get(event.sessionId);
    if (owner && owner.taskId !== event.taskId) return;
    if (event.type === "session.process") {
      if (!owner) {
        owner = { taskId: event.taskId, sessionId: event.sessionId, roots: new Set(), known: new Map(), history: [] };
        this.sessions.set(event.sessionId, owner);
      }
      owner.roots.add(event.pid);
    } else if (owner && event.type === "session.state") owner.busy = event.busy;
    else if (owner) owner.released ??= this.now();
    this.schedule(0);
  }

  /** Shutdown releases only owned processes; shared services never enter this registry. */
  releaseAll() {
    for (const owner of this.sessions.values()) owner.released ??= this.now();
    this.schedule(0);
  }

  close() { this.closed = true; clearTimeout(this.timer); }

  sample(): Promise<void> {
    return this.sampling ??= this.poll().finally(() => { this.sampling = undefined; });
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private schedule(delay = 5000) {
    if (this.closed || this.timer || !this.sessions.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sample().catch((error: unknown) => console.error("Memory protection:", error)).finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private async poll() {
    await this.ready;
    const rows = await (this.options.read ?? readProcessSamples)();
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const children = new Map<number, ProcessSample[]>();
    for (const row of rows) {
      const siblings = children.get(row.parent) ?? [];
      siblings.push(row);
      children.set(row.parent, siblings);
    }
    const now = this.now();
    const memory = this.options.memory?.() ?? { total: totalmem(), available: await availableMemory() };
    const budget = memoryBudget(memory.total);
    const totals = new Map<Owned, number>();
    const claimed = new Set<number>();
    for (const owner of this.sessions.values()) {
      // Remember descendants before reparenting; never adopt a PID whose birth changed.
      const live = new Map<number, string>();
      const visit = (pid: number, born?: string) => {
        const row = byPid.get(pid);
        if (!row || row.pid === process.pid || born !== undefined && row.born !== born || claimed.has(pid)) return;
        claimed.add(pid);
        live.set(pid, row.born);
        for (const child of children.get(pid) ?? []) visit(child.pid);
      };
      for (const [pid, born] of owner.known) visit(pid, born);
      for (const pid of owner.roots) {
        // A root is adopted once; stale roots cannot claim later PID reuse.
        if (!owner.known.has(pid)) visit(pid);
      }
      owner.roots.clear();
      owner.known = live;
      if (!live.size) {
        if (owner.stopped) this.options.changed(owner.taskId, { ...owner.stopped, cleanup: "complete" });
        this.sessions.delete(owner.sessionId);
        continue;
      }
      let bytes = 0;
      for (const pid of live.keys()) bytes += byPid.get(pid)!.bytes;
      totals.set(owner, bytes);
      owner.history.push({ at: now, bytes });
      if (owner.history.length > 12) owner.history.shift();
    }
    // A low-headroom intervention chooses one largest owner per sample, rather than stopping every thread.
    const largest = [...totals].filter(([owner]) => owner.released === undefined).sort((a, b) => b[1] - a[1])[0]?.[0];
    const idle = [...totals].filter(([owner]) => owner.busy === false && owner.released === undefined).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (this.enabled && memory.available < 512 * 1024 ** 2 && idle) {
      idle.busy = true;
      this.options.release?.(idle.taskId, idle.sessionId);
    }
    const alreadyStopping = Boolean(idle && this.enabled && memory.available < 512 * 1024 ** 2) || [...this.sessions.values()].some(owner => owner.released !== undefined);
    for (const [owner] of totals) {
      if (this.enabled && owner.released === undefined && unsafeMemory(owner.history, budget, !alreadyStopping && owner === largest ? memory.available : Infinity)) {
        owner.stopped = { at: now, bytes: owner.history.at(-1)!.bytes, cleanup: "stopping" };
        owner.released = now;
        this.options.stop(owner.taskId, owner.sessionId, owner.stopped);
      }
      if (owner.released === undefined) continue;
      const elapsed = now - owner.released;
      if (elapsed < 1000) continue;
      const signal = elapsed >= 5000 ? "SIGKILL" : "SIGTERM";
      // Identity is checked against this sample immediately before signalling each known process.
      for (const [pid, born] of owner.known) {
        if (byPid.get(pid)?.born !== born) continue;
        try { (this.options.signal ?? process.kill)(pid, signal); } catch { /* Already gone. */ }
      }
      if (elapsed >= 15_000 && owner.stopped?.cleanup !== "incomplete") {
        owner.stopped = owner.stopped ? { ...owner.stopped, cleanup: "incomplete" } : undefined;
        if (owner.stopped) this.options.changed(owner.taskId, owner.stopped);
      }
    }
    await this.persist();
  }
}
