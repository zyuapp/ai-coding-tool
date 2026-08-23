import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAMPLES = 11;
const WARMUPS = 3;
const DATABASE_WRITES = 2_000;

function targetArguments(argv) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--target") continue;
    const value = argv[++index];
    const split = value?.indexOf("=") ?? -1;
    if (split < 1) throw new Error("--target must be label=path");
    targets.push({ label: value.slice(0, split), root: path.resolve(value.slice(split + 1)) });
  }
  return targets.length ? targets : [{ label: "current", root: process.cwd() }];
}

async function loadTarget(target) {
  const load = (relative) => import(pathToFileURL(path.join(target.root, "dist/main", relative)).href);
  const [database, terminal, git, worktrees] = await Promise.all([
    load("main/task-database.mjs"),
    load("main/terminal-host.js"),
    load("main/workspace/git.mjs"),
    load("main/workspace/worktrees.mjs"),
  ]);
  return { ...target, database, terminal, git, worktrees };
}

async function git(root, args, env) {
  return (await execFileAsync("git", args, { cwd: root, ...(env ? { env: { ...process.env, ...env } } : {}) })).stdout.trim();
}

async function repositoryAt(root) {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Benchmark"]);
  await git(root, ["config", "user.email", "benchmark@example.com"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "base"], {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  return root;
}

function storedTask(updatedAt) {
  return {
    id: "benchmark-task",
    title: "Measure persistence",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt,
  };
}

function message(index) {
  return { id: "benchmark-message", kind: "assistant", text: `delta-${index}`, at: 1 };
}

function workspaceRegistry() {
  return {
    registerWorktree: async (root) => ({ status: "available", workspace: { id: "benchmark-workspace", kind: "worktree", root } }),
    forgetWorktree: async () => {},
    forgetWorktrees: async () => {},
    listWorktrees: async () => [],
  };
}

async function waitForTerminal(target, id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await target.terminal.readTerminal(id, { lines: 5 });
    if (snapshot?.lines.some((line) => line.includes("benchmark-ready"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${target.label} terminal fixture did not become ready`);
}

async function targetCases(target, fixtureRoot, repository) {
  const databaseRoot = path.join(fixtureRoot, `database-${target.label}`);
  await mkdir(databaseRoot, { recursive: true });
  const database = new target.database.TaskDatabase(path.join(databaseRoot, "tasks.sqlite"));
  database.persist({ tasks: [{ task: storedTask(0), messages: [{ index: 0, message: message(0) }] }] });

  const terminalId = "benchmark-terminal";
  target.terminal.startTerminalHost({ onData: () => {}, onUpdate: () => {} });
  target.terminal.startTerminal(terminalId, repository);
  const padding = "x".repeat(80);
  target.terminal.writeTerminal(terminalId, `i=0; while [ $i -lt 5000 ]; do printf 'line-%04d ${padding}\\n' "$i"; i=$((i+1)); done; printf 'benchmark-ready\\n'\r`);
  await waitForTerminal(target, terminalId);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const worktreesRoot = path.join(fixtureRoot, `worktrees-${target.label}`);
  await mkdir(worktreesRoot, { recursive: true });
  const worktrees = new target.worktrees.WorktreeService({ worktreesRoot, workspaces: workspaceRegistry() });
  let releaseSequence = 0;

  return {
    cases: [
      {
        name: `database persist, ${DATABASE_WRITES} streaming deltas`,
        sample: async () => {
          const started = performance.now();
          for (let index = 1; index <= DATABASE_WRITES; index += 1) {
            database.persist({ tasks: [{ task: storedTask(index), messages: [{ index: 0, message: message(index) }] }] });
          }
          const elapsed = performance.now() - started;
          const task = database.load().tasks[0];
          return { elapsed, output: { updatedAt: task.updatedAt, text: task.messages[0].text } };
        },
      },
      {
        name: "terminal unfiltered tail, 100 of 5k lines",
        sample: async () => {
          const started = performance.now();
          const snapshot = await target.terminal.readTerminal(terminalId, { lines: 100 });
          const elapsed = performance.now() - started;
          return {
            elapsed,
            output: {
              lines: snapshot.lines.filter((line) => line.includes("line-") || line.includes("benchmark-ready")),
              omitted: snapshot.omitted,
            },
          };
        },
      },
      {
        name: "Git branch inventory",
        sample: async () => {
          const started = performance.now();
          const output = await target.git.listBranches(repository);
          return { elapsed: performance.now() - started, output };
        },
      },
      {
        name: "worktree create from project HEAD",
        sample: async () => {
          const started = performance.now();
          const created = await worktrees.create({ projectRoot: repository, carryChanges: false });
          const elapsed = performance.now() - started;
          const output = {
            baseCommit: created.baseCommit,
            detached: await target.git.isDetached(created.root),
            contents: await readFile(path.join(created.root, "tracked.txt"), "utf8"),
          };
          await worktrees.delete(created.root);
          return { elapsed, output };
        },
      },
      {
        name: "release clean detached commit",
        sample: async () => {
          const root = path.join(worktreesRoot, `release-${releaseSequence++}`);
          await git(repository, ["worktree", "add", "-q", "--detach", root, "HEAD"]);
          await writeFile(path.join(root, "tracked.txt"), "detached benchmark\n");
          await git(root, ["add", "-A"]);
          await git(root, ["commit", "-qm", "detached benchmark"], {
            GIT_AUTHOR_DATE: "2000-01-02T00:00:00Z",
            GIT_COMMITTER_DATE: "2000-01-02T00:00:00Z",
          });
          const expected = await git(root, ["rev-parse", "HEAD"]);
          const started = performance.now();
          const snapshot = await worktrees.release({
            worktreeId: "benchmark-release",
            root,
            taskId: "benchmark-task",
            title: "Detached benchmark",
            release: "returned-to-local",
          });
          const elapsed = performance.now() - started;
          const preserved = await git(repository, ["rev-parse", snapshot.ref]);
          return { elapsed, output: { snapshot, preserved: preserved === expected } };
        },
      },
    ],
    dispose: async () => {
      target.terminal.stopTerminalHost();
      database.close();
    },
  };
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function stats(values) {
  const middle = median(values);
  return { median: middle, mad: median(values.map((value) => Math.abs(value - middle))) };
}

const requested = targetArguments(process.argv.slice(2));
const targets = await Promise.all(requested.map(loadTarget));
const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "aic-main-performance-")));
const repository = await repositoryAt(path.join(fixtureRoot, "repository"));
const originalShell = process.env.SHELL;
process.env.SHELL = "/bin/sh";
const suites = [];

try {
  for (const target of targets) suites.push(await targetCases(target, fixtureRoot, repository));
  const rows = [];
  for (let caseIndex = 0; caseIndex < suites[0].cases.length; caseIndex += 1) {
    const cases = suites.map((suite) => suite.cases[caseIndex]);
    const expected = (await cases[0].sample()).output;
    for (const benchmark of cases.slice(1)) assert.deepEqual((await benchmark.sample()).output, expected, `${benchmark.name} changed output`);
    for (const benchmark of cases) {
      for (let warmup = 0; warmup < WARMUPS; warmup += 1) await benchmark.sample();
    }
    const measured = cases.map(() => []);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const order = cases.map((_item, index) => index);
      if (sample % 2) order.reverse();
      for (const index of order) {
        globalThis.gc?.();
        measured[index].push((await cases[index].sample()).elapsed);
      }
    }
    rows.push({ name: cases[0].name, hash: createHash("sha256").update(JSON.stringify(expected)).digest("hex").slice(0, 12), results: measured.map(stats) });
  }

  const headings = ["benchmark", "output", ...targets.flatMap((target) => [`${target.label} median`, `${target.label} MAD`])];
  if (targets.length === 2) headings.push("saved", "gain", "accepted");
  console.table(rows.map((row) => {
    const values = [row.name, row.hash, ...row.results.flatMap((result) => [`${result.median.toFixed(2)} ms`, `${result.mad.toFixed(2)} ms`])];
    if (targets.length === 2) {
      const [before, after] = row.results;
      const saved = before.median - after.median;
      const gain = saved / before.median;
      const significant = saved > 3 * (before.mad + after.mad);
      values.push(`${saved.toFixed(2)} ms`, `${(gain * 100).toFixed(1)}%`, gain >= 0.05 && significant ? "yes" : "no");
    }
    return Object.fromEntries(headings.map((heading, index) => [heading, values[index]]));
  }));
} finally {
  await Promise.all(suites.map((suite) => suite.dispose()));
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  await rm(fixtureRoot, { recursive: true, force: true });
}
