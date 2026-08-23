import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const SAMPLES = 11;
const WARMUPS = 3;
let sink;

function targetArguments(argv) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--target") continue;
    const value = argv[index + 1];
    if (!value?.includes("=")) throw new Error("--target must be label=path");
    const split = value.indexOf("=");
    targets.push({ label: value.slice(0, split), root: path.resolve(value.slice(split + 1)) });
    index += 1;
  }
  return targets.length ? targets : [{ label: "current", root: process.cwd() }];
}

async function loadTarget(target) {
  const module = (relative) => import(pathToFileURL(path.join(target.root, "dist/main", relative)).href);
  const [find, projection, workspace, database] = await Promise.all([
    module("domain/find.js"),
    module("application/thread-projection.js"),
    module("application/workspace-state.js"),
    module("main/task-database.mjs"),
  ]);
  return { ...target, find, projection, workspace, database };
}

function task(id, index, overrides = {}) {
  return {
    id,
    title: `Thread ${index}`,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: index },
    sortIndex: index,
    createdAt: index,
    updatedAt: index,
    ...overrides,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function stats(samples) {
  const middle = median(samples);
  return {
    median: middle,
    p95: percentile(samples, 0.95),
    mad: median(samples.map((value) => Math.abs(value - middle))),
  };
}

function measure(fn, iterations) {
  globalThis.gc?.();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) sink = fn();
  return (performance.now() - started) / iterations;
}

async function databaseFixture(target) {
  const directory = await mkdtemp(path.join(tmpdir(), `aic-performance-${target.label}-`));
  const database = new target.database.TaskDatabase(path.join(directory, "tasks.sqlite"));
  const projects = Array.from({ length: 30 }, (_item, index) => ({ id: `project-${index}`, root: `/project/${index}` }));
  const tasks = Array.from({ length: 300 }, (_item, taskIndex) => {
    const record = task(`db-task-${taskIndex}`, taskIndex, { projectId: `project-${taskIndex % projects.length}` });
    const { messages: _messages, ...stored } = record;
    return {
      task: stored,
      messages: Array.from({ length: 100 }, (_message, messageIndex) => ({
        index: messageIndex,
        message: {
          id: `message-${taskIndex}-${messageIndex}`,
          kind: messageIndex % 2 ? "assistant" : "user",
          text: `${taskIndex}:${messageIndex}:${"transcript ".repeat(12)}`,
          at: taskIndex * 100 + messageIndex,
        },
      })),
    };
  });
  database.persist({ projects, lastFolder: projects[0].root, tasks });
  return {
    run() {
      const roots = typeof database.projectRoots === "function"
        ? database.projectRoots()
        : database.load()?.projects.map((project) => project.root) ?? [];
      const loaded = database.load();
      return { roots, tasks: loaded?.tasks.length ?? 0, messages: loaded?.tasks.reduce((total, item) => total + item.messages.length, 0) ?? 0 };
    },
    close: async () => {
      database.close();
      await rm(directory, { recursive: true });
    },
  };
}

async function casesFor(target) {
  const denseMessage = [{ id: "dense", kind: "assistant", text: "needle ".repeat(100_000), at: 1 }];

  const handleProjects = Array.from({ length: 800 }, (_item, index) => ({ id: `project-${index}`, root: `/projects/${index}` }));
  const handleTasks = Array.from({ length: 8_000 }, (_item, index) => task(`handle-${index}`, index, {
    title: `Investigate renderer path ${index}`,
    projectId: `project-${index % handleProjects.length}`,
  }));
  const handlePending = Object.fromEntries(Array.from({ length: 500 }, (_item, index) => [
    `pending-${index}`,
    { id: `pending-${index}`, runId: `run-${index}`, origin: "composer", taskId: `handle-${index * 3}`, text: "go", prompt: "go", attachments: [] },
  ]));
  const handleState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: handleTasks,
    projects: handleProjects,
    pendingRuns: handlePending,
    draftProjectId: "project-7",
  };

  const viewProjects = Array.from({ length: 300 }, (_item, index) => ({ id: `view-project-${index}`, root: `/view/${index}`, sortIndex: index }));
  const viewWorktrees = Array.from({ length: 1_500 }, (_item, index) => ({
    id: `worktree-${index}`,
    projectId: `view-project-${index % viewProjects.length}`,
    root: `/worktrees/${index}`,
    workspaceId: `workspace-${index}`,
    baseCommit: "abcdef0",
    createdAt: index,
    lastUsedAt: index,
  }));
  const viewTasks = Array.from({ length: 3_000 }, (_item, index) => task(`view-task-${index}`, index, {
    projectId: `view-project-${index % viewProjects.length}`,
    worktreeId: `worktree-${index % viewWorktrees.length}`,
  }));
  const viewState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: viewTasks,
    projects: viewProjects,
    worktrees: viewWorktrees,
    currentId: viewTasks[0].id,
    history: [viewTasks[0].id],
    historyIndex: 0,
    restored: true,
  };

  const historyTasks = Array.from({ length: 5_000 }, (_item, index) => task(`live-${index}`, index));
  const shortHistoryState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: historyTasks,
    history: ["gone", historyTasks.at(-1).id],
    historyIndex: -1,
  };
  const historyState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: historyTasks,
    history: Array.from({ length: 5_000 }, (_item, index) => `gone-${index}`),
    historyIndex: -1,
  };

  const database = await databaseFixture(target);
  return {
    cases: [
      {
        name: "capped transcript search",
        iterations: 1,
        run: () => target.find.findHits(denseMessage, "needle"),
        normalize: (hits) => hits.map(({ messageId, field, start, occurrence }) => [messageId, field, start, occurrence]),
      },
      {
        name: "thread handle options",
        iterations: 1,
        run: () => target.projection.threadHandleOptions(handleState, "draft:project-7"),
        normalize: (options) => options.map(({ id, handle, inScope, running }) => [id, handle, inScope, running]),
      },
      {
        name: "workspace view derivation",
        iterations: 1,
        run: () => target.workspace.deriveView(viewState),
        normalize: (view) => ({
          ordered: view.orderedTasks.map((item) => item.id),
          groups: view.worktreeGroups.map((group) => [group.worktree.id, group.tasks.map((item) => item.id)]),
          activity: Object.fromEntries(Object.entries(view.activityTasks).map(([key, items]) => [key, items.map((item) => item.id)])),
        }),
      },
      {
        name: "history navigation, one stale entry",
        iterations: 10,
        run: () => target.workspace.reachableVisit(shortHistoryState, 1),
        normalize: (value) => value,
      },
      {
        name: "history navigation",
        iterations: 1,
        run: () => target.workspace.reachableVisit(historyState, 1),
        normalize: (value) => value,
      },
      {
        name: "startup project discovery",
        iterations: 1,
        run: database.run,
        normalize: (value) => value,
      },
    ],
    close: database.close,
  };
}

function format(value) {
  return value.toFixed(2);
}

const targets = await Promise.all(targetArguments(process.argv.slice(2)).map(loadTarget));
const suites = await Promise.all(targets.map(casesFor));

try {
  const rows = [];
  for (let caseIndex = 0; caseIndex < suites[0].cases.length; caseIndex += 1) {
    const cases = suites.map((suite) => suite.cases[caseIndex]);
    const expected = cases[0].normalize(cases[0].run());
    for (const benchmark of cases.slice(1)) assert.deepEqual(benchmark.normalize(benchmark.run()), expected, `${benchmark.name} changed output`);
    for (const benchmark of cases) {
      for (let warmup = 0; warmup < WARMUPS; warmup += 1) measure(benchmark.run, benchmark.iterations);
    }
    const samples = cases.map(() => []);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const order = sample % 2 ? cases.map((_item, index) => index).reverse() : cases.map((_item, index) => index);
      for (const index of order) samples[index].push(measure(cases[index].run, cases[index].iterations));
    }
    const measured = samples.map(stats);
    rows.push({ name: cases[0].name, measured });
  }

  const headings = ["benchmark", ...targets.map((target) => `${target.label} median`), ...(targets.length === 2 ? ["saved", "speedup"] : [])];
  const table = rows.map((row) => {
    const values = [row.name, ...row.measured.map((result) => `${format(result.median)} ms`)];
    if (targets.length === 2) {
      const before = row.measured[0].median;
      const after = row.measured[1].median;
      values.push(`${format(before - after)} ms`, `${(before / after).toFixed(2)}x`);
    }
    return Object.fromEntries(headings.map((heading, index) => [heading, values[index]]));
  });
  console.table(table);
  console.log("\nNoise (p95 / MAD, ms):");
  for (const row of rows) {
    console.log(`${row.name}: ${row.measured.map((result, index) => `${targets[index].label} ${format(result.p95)} / ${format(result.mad)}`).join(", ")}`);
  }
} finally {
  await Promise.all(suites.map((suite) => suite.close()));
}
