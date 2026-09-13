import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { claimServeLock, desktopOpen, servingProcess } from "../../src/main/instance-lock.ts";

/** A process that outlives the test unless ended, standing in for an app or server on the same data. */
function bystander(t: { onTestFinished: (fn: () => void) => void }): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.onTestFinished(() => { child.kill(); });
  return child;
}

async function ended(child: ChildProcess) {
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exit;
}

async function folder(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-lock-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a serve lock stands while its process lives, and one a dead process left is nobody's", async (t) => {
  const userData = await folder(t);
  assert.equal(servingProcess(userData), null);
  const server = bystander(t);
  await writeFile(path.join(userData, "serve.lock"), String(server.pid));
  assert.equal(servingProcess(userData), server.pid);
  assert.throws(() => claimServeLock(userData), new RegExp(`already serving from this folder \\(process ${server.pid}\\)`));
  await ended(server);
  assert.equal(servingProcess(userData), null);
  const release = claimServeLock(userData);
  assert.equal(existsSync(path.join(userData, "serve.lock")), true);
  release();
  assert.equal(existsSync(path.join(userData, "serve.lock")), false);
});

test("a server lets go of its own lock only, never one another took over", async (t) => {
  const userData = await folder(t);
  const release = claimServeLock(userData);
  const other = bystander(t);
  await writeFile(path.join(userData, "serve.lock"), String(other.pid));
  release();
  assert.equal(servingProcess(userData), other.pid, "the other server's lock stands");
});

test("the desktop app's own lock keeps a server off its data only while the app runs", async (t) => {
  const userData = await folder(t);
  assert.equal(desktopOpen(userData), false);
  const app = bystander(t);
  const lock = path.join(userData, "SingletonLock");
  await symlink(`${os.hostname()}-${app.pid}`, lock);
  assert.equal(desktopOpen(userData), true);
  assert.throws(() => claimServeLock(userData), /desktop app is open on this data folder/);
  await ended(app);
  assert.equal(desktopOpen(userData), false);
  claimServeLock(userData)();
  await rm(lock);
  await symlink(`elsewhere-${process.pid}`, lock);
  assert.equal(desktopOpen(userData), true, "a lock held from another machine cannot be checked, so it stands");
});
