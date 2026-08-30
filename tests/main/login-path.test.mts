import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { adoptLoginShellPath, mergeSearchPaths, searchPathFromEnvironment } from "../../src/main/login-path.ts";

const MARK = "__aic_environment__";
const dump = (body: string) => `a start-up file said this\n${MARK}${body}${MARK}\ngoodbye\n`;

test("the search path is read out of the shell's own environment, past anything else it printed", () => {
  assert.equal(searchPathFromEnvironment(dump("HOME=/Users/dev\nPATH=/opt/homebrew/bin:/usr/bin\nSHELL=/bin/zsh\n")), "/opt/homebrew/bin:/usr/bin");
});

test("a shell that said nothing usable leaves no search path to adopt", () => {
  assert.equal(searchPathFromEnvironment(""), null, "no marks at all");
  assert.equal(searchPathFromEnvironment(`noise${MARK}HOME=/Users/dev\n`), null, "only the opening mark");
  assert.equal(searchPathFromEnvironment(dump("HOME=/Users/dev\n")), null, "no PATH in the environment");
  assert.equal(searchPathFromEnvironment(dump("PATH=\n")), null, "an empty PATH is no answer");
  assert.equal(searchPathFromEnvironment(`PATH=/should/not/count\n${MARK}HOME=/Users/dev\n${MARK}`), null, "a PATH outside the marks is not the shell's");
});

test("merging keeps the first mention of each folder, in the order it was first given", () => {
  assert.equal(mergeSearchPaths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", null, undefined, ":/sbin:"), "/opt/homebrew/bin:/usr/bin:/bin:/sbin");
  assert.equal(mergeSearchPaths(null, undefined, ""), "");
});

test("the process takes the search path its login shell has, and keeps the one it started with", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-path-"));
  const started = process.env.PATH;
  const shell = process.env.SHELL;
  try {
    process.env.PATH = folder;
    process.env.SHELL = "/bin/sh";
    await adoptLoginShellPath();
    const folders = (process.env.PATH ?? "").split(path.delimiter);

    assert.ok(folders.includes(folder), "what the shell reported is adopted");
    assert.equal(folders.length, new Set(folders).size, "no folder is listed twice");
  } finally {
    process.env.PATH = started;
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
  }
});

test.skipIf(process.platform !== "linux")("the Linux login shell has no share in the launching terminal's job control", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-shell-session-"));
  const shell = path.join(folder, "probe");
  await writeFile(shell, `#!/bin/sh
read pid comm state ppid pgrp session tty rest < /proc/$$/stat
printf '${MARK}PATH=p%s:s%s:t%s\n${MARK}' "$pid" "$session" "$tty"
`);
  await chmod(shell, 0o755);
  const started = process.env.PATH;
  const originalShell = process.env.SHELL;
  try {
    process.env.PATH = "/usr/bin";
    process.env.SHELL = shell;
    await adoptLoginShellPath();
    const [pid, session, tty] = (process.env.PATH ?? "").split(path.delimiter);

    assert.equal(session.slice(1), pid.slice(1), "the probe is the leader of its own session");
    assert.equal(tty, "t0", "the new session has no controlling terminal");
  } finally {
    process.env.PATH = started;
    if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell;
  }
});

test("a shell that cannot be run leaves the process able to find its tools anyway", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-bin-"));
  const started = process.env.PATH;
  const shell = process.env.SHELL;
  try {
    process.env.PATH = bin;
    process.env.SHELL = path.join(bin, "no-such-shell");
    await adoptLoginShellPath();

    assert.ok((process.env.PATH ?? "").split(path.delimiter).includes(bin), "the search path the app was started with survives");
  } finally {
    process.env.PATH = started;
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
  }
});

test("a folder tools are installed in is added when it is really there, and never when it is not", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-home-"));
  const local = path.join(home, ".local", "bin");
  await mkdir(local, { recursive: true });
  const started = process.env.PATH;
  const shell = process.env.SHELL;
  const was = process.env.HOME;
  try {
    process.env.HOME = home;
    process.env.PATH = "/usr/bin";
    /** This case isolates standard-folder discovery from whatever a Linux login profile adds. */
    process.env.SHELL = path.join(home, "no-such-shell");
    await adoptLoginShellPath();
    const folders = (process.env.PATH ?? "").split(path.delimiter);

    assert.ok(folders.includes(local), "a standard folder that exists is worth looking in");
    assert.ok(!folders.some((folder) => folder.startsWith(home) && folder !== local), "one that does not is left out");
  } finally {
    process.env.PATH = started;
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
    if (was === undefined) delete process.env.HOME; else process.env.HOME = was;
  }
});
