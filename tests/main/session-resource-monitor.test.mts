import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionResourceMonitor, parseProcessSamples, type ProcessSample } from "../../src/main/session-resource-monitor.mts";
import { availableMacMemory } from "../../src/main/system-memory.mts";
import { memoryBudget, unsafeMemory } from "../../src/domain/session-resources.ts";

const GiB = 1024 ** 3;
const row = (pid: number, parent: number, bytes = GiB, born = "Fri Nov 13 12:00:00 2026"): ProcessSample => ({ pid, parent, bytes, born });

test("memory budgets tolerate peaks, enforce sustained growth and act on critical headroom", () => {
  assert.equal(memoryBudget(16 * GiB), 4 * GiB);
  assert.equal(memoryBudget(128 * GiB), 8 * GiB);
  assert.equal(memoryBudget(GiB), GiB / 2);
  const samples = [0, 5000, 10000, 15000].map(at => ({ at, bytes: GiB }));
  assert.equal(unsafeMemory(samples, GiB, Infinity), true);
  assert.equal(unsafeMemory(samples.slice(1), GiB, Infinity), false);
  assert.equal(unsafeMemory(samples.map((s, i) => ({ ...s, bytes: i === 2 ? GiB - 1 : GiB })), GiB, Infinity), false);
  assert.equal(unsafeMemory(samples.map((s, i) => ({ ...s, bytes: GiB / 2 + i * GiB / 12 })), GiB, Infinity), true);
  assert.equal(unsafeMemory([{ at: 0, bytes: GiB / 4 }], GiB, 0), true);
  assert.equal(unsafeMemory([{ at: 0, bytes: 0 }], GiB, 0), false);
});

test("OS samples include birth identity and reclaimable macOS pages; malformed input cannot imply pressure", () => {
  assert.deepEqual(parseProcessSamples(" 100 10 1024 Fri Nov 13 12:00:00 2026\n nonsense\n"), [row(100, 10, 1024 ** 2)]);
  assert.equal(availableMacMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n'), 35 * 16384);
  assert.equal(availableMacMemory("Pages free: 0."), Infinity);
});

test("a stopped owner includes reparented children, never reused PIDs or another thread, and cleanup is verified", async () => {
  let now = 0;
  let rows = [row(101, 1, GiB / 2), row(102, 101, GiB / 2), row(201, 1, 1)];
  const stopped: string[] = [], changes: string[] = [], signals: Array<[number, string]> = [];
  const monitor = new SessionResourceMonitor({ read: async () => rows, now: () => now, memory: () => ({ total: 4 * GiB, available: GiB }), stop: (taskId) => { stopped.push(taskId); }, changed: (taskId, stop) => { changes.push(`${taskId}:${stop.cleanup}`); }, signal: (pid, signal) => { signals.push([pid, signal]); } });
  try {
    monitor.receive({ type: "session.process", taskId: "a", sessionId: "one", pid: 101 });
    monitor.receive({ type: "session.process", taskId: "b", sessionId: "two", pid: 201 });
    for (now = 0; now <= 15000; now += 5000) await monitor.sample();
    assert.deepEqual(stopped, ["a"]);
    rows = [row(101, 1, 1, "Fri Nov 13 12:01:00 2026"), row(102, 1, GiB / 2), row(201, 1, 1)];
    now = 20000;
    await monitor.sample();
    assert.deepEqual(signals, [[102, "SIGKILL"]]);
    rows = rows.filter(r => r.pid !== 102);
    now = 25000;
    await monitor.sample();
    assert.deepEqual(changes, ["a:complete"]);
    assert.deepEqual(stopped, ["a"]);
  } finally { monitor.close(); }
});

test("disabled protection clears the growth window; aggregate pressure stops only the largest owner", async () => {
  let now = 0;
  const stops: string[] = [];
  const monitor = new SessionResourceMonitor({ read: async () => [row(101, 1, GiB), row(201, 1, GiB / 2)], now: () => now, memory: () => ({ total: 4 * GiB, available: 0 }), stop: taskId => { stops.push(taskId); }, changed() {}, signal() {} });
  try {
    monitor.setEnabled(false);
    for (const [taskId, pid] of [["a", 101], ["b", 201]] as const) monitor.receive({ type: "session.process", taskId, sessionId: taskId, pid });
    for (now = 0; now <= 20000; now += 5000) await monitor.sample();
    assert.deepEqual(stops, []);
    monitor.setEnabled(true);
    await monitor.sample();
    assert.deepEqual(stops, ["a"]);
    now += 5000;
    await monitor.sample();
    assert.deepEqual(stops, ["a"], "do not stop a second owner while waiting for cleanup");
  } finally { monitor.close(); }
});

test("the recovery journal cleans only matching old process identities, independently of the setting", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "aic-memory-"));
  const journal = path.join(folder, "processes.json");
  let now = 0;
  let rows = [row(101, 1, 1), row(102, 101, 1)];
  const signals: number[] = [];
  const options = { journal, read: async () => rows, now: () => now, memory: () => ({ total: 4 * GiB, available: GiB }), stop() {}, changed() {}, signal(pid: number) { signals.push(pid); } };
  const first = new SessionResourceMonitor(options);
  first.receive({ type: "session.process", taskId: "a", sessionId: "old", pid: 101 });
  await first.sample();
  first.close();
  assert.match(await readFile(journal, "utf8"), /old/);
  rows = [row(101, 1, 1, "Fri Nov 13 12:01:00 2026"), row(102, 1, 1)];
  const second = new SessionResourceMonitor(options);
  try {
    second.setEnabled(false);
    await second.sample();
    now = 6000;
    await second.sample();
    assert.deepEqual(signals, [102]);
    rows = [];
    await second.sample();
    await second.beforeStart("a");
    assert.equal(await readFile(journal, "utf8"), "[]");
  } finally { second.close(); await rm(folder, { recursive: true, force: true }); }
});

test("real process sampling kills a runaway subtree and leaves an independent session alive", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { readProcessSamples } = await import("../../src/main/session-resource-monitor.mts");
  const healthy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const hog = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    global.hold=Buffer.alloc(96*1024*1024,1);
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{});
    process.send({child:child.pid});
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let now = 0;
  let descendant: number | undefined;
  const stops: string[] = [], clean: string[] = [];
  const monitor = new SessionResourceMonitor({ read: readProcessSamples, now: () => now, memory: () => ({ total: 4 * GiB, available: 0 }), stop: taskId => { stops.push(taskId); }, changed: (taskId, stop) => { clean.push(`${taskId}:${stop.cleanup}`); } });
  try {
    const [message] = await once(hog, "message") as [{ child: number }];
    descendant = message.child;
    monitor.receive({ type: "session.process", taskId: "runaway", sessionId: "hog", pid: hog.pid! });
    monitor.receive({ type: "session.process", taskId: "healthy", sessionId: "healthy", pid: healthy.pid! });
    await monitor.sample();
    assert.deepEqual(stops, ["runaway"]);
    const exited = once(hog, "exit");
    now = 6000;
    await monitor.sample();
    await exited;
    await monitor.sample();
    assert.deepEqual(clean, ["runaway:complete"]);
    assert.equal(healthy.exitCode, null);
    assert.equal(healthy.signalCode, null);
    assert.equal((await readProcessSamples()).some(row => row.pid === descendant), false);
  } finally {
    monitor.close();
    hog.kill("SIGKILL"); healthy.kill("SIGKILL");
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
  }
});

test("resume waits through a transient cleanup sampling failure", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "aic-memory-retry-"));
  const journal = path.join(folder, "processes.json");
  await writeFile(journal, JSON.stringify([{ taskId: "a", sessionId: "old", known: [[101, "Fri Nov 13 12:00:00 2026"]] }]));
  let reads = 0;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const monitor = new SessionResourceMonitor({ journal, read: async () => { if (++reads === 1) throw new Error("temporary ps timeout"); return []; }, memory: () => ({ total: 4 * GiB, available: GiB }), stop() {}, changed() {} });
  try {
    await monitor.beforeStart("a");
    assert.ok(reads >= 2);
  } finally { monitor.close(); errors.mockRestore(); await rm(folder, { recursive: true, force: true }); }
});
