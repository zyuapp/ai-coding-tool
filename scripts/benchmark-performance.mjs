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
  const [find, projection, workspace, reducer, database, taskDomain, workflow, taskOrder, markdown, handles] = await Promise.all([
    module("domain/find.js"),
    module("application/thread-projection.js"),
    module("application/workspace-state.js"),
    module("application/workspace-reducer.js"),
    module("main/task-database.mjs"),
    module("domain/task.js"),
    module("domain/workflow.js"),
    module("application/task-order.js"),
    module("domain/markdown-stream.js"),
    module("domain/thread-handles.js"),
  ]);
  return { ...target, find, projection, workspace, reducer, database, taskDomain, workflow, taskOrder, markdown, handles };
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

function worktree(id, index, projectId) {
  return {
    id,
    projectId,
    root: `/worktrees/${id}`,
    workspaceId: `workspace-${id}`,
    baseCommit: "abcdef0",
    createdAt: index,
    lastUsedAt: index,
  };
}

function versioned(value) {
  return JSON.stringify({ version: 2, value });
}

function workflowFixture() {
  return {
    id: "workflow-large-phase",
    name: "Large single phase",
    description: "Exercises phase bucket construction",
    status: "completed",
    phases: [{ index: 0, title: "Workers" }],
    agents: Array.from({ length: 10_000 }, (_item, index) => ({
      index,
      label: `Worker ${index}`,
      state: "done",
      phaseIndex: 0,
    })),
    totalTokens: 0,
    totalToolCalls: 0,
    startedAt: 0,
    finishedAt: 1,
  };
}

function parseStoreFixture() {
  const projects = Array.from({ length: 200 }, (_item, index) => ({
    id: `parse-project-${index}`,
    root: `/parse/${index}`,
    sortIndex: index,
  }));
  const worktrees = Array.from({ length: 4_000 }, (_item, index) =>
    worktree(`parse-worktree-${index}`, index, projects[index % projects.length].id));
  const tasks = Array.from({ length: 4_000 }, (_item, index) => task(`parse-task-${index}`, index, {
    projectId: projects[index % projects.length].id,
    worktreeId: worktrees[index].id,
  }));
  return {
    tasks: versioned(tasks),
    projects: versioned(projects),
    worktrees: versioned(worktrees),
    lastFolder: versioned(projects[0].root),
  };
}

function mergeStoreFixture(target) {
  const projects = Array.from({ length: 200 }, (_item, index) => ({
    id: `merge-project-${index}`,
    root: `/merge/${index}`,
    sortIndex: index,
  }));
  const storedWorktrees = Array.from({ length: 4_000 }, (_item, index) =>
    worktree(`stored-worktree-${index}`, index, projects[index % projects.length].id));
  const storedTasks = storedWorktrees.map((item, index) => task(`stored-task-${index}`, index, {
    projectId: item.projectId,
    worktreeId: item.id,
  }));
  const liveWorktrees = Array.from({ length: 4_000 }, (_item, index) =>
    worktree(`live-worktree-${index}`, index, projects[index % projects.length].id));
  const liveTasks = liveWorktrees.map((item, index) => task(`live-task-${index}`, 10_000 + index, {
    projectId: item.projectId,
    worktreeId: item.id,
  }));
  const state = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: liveTasks,
    projects,
    worktrees: [...storedWorktrees.slice(0, 2_000), ...liveWorktrees],
    creatingWorktrees: liveTasks.map((item) => item.id),
    restored: true,
  };
  return {
    state,
    data: { version: 2, tasks: storedTasks, projects, worktrees: storedWorktrees, lastFolder: projects[0].root },
  };
}

function activityFixture() {
  const withdrawn = Array.from({ length: 200 }, (_item, index) => ({
    id: `withdrawn-${index}`,
    kind: "assistant",
    text: "quiet",
    withdrawn: true,
    at: 100_000 + index,
  }));
  const tasks = Array.from({ length: 5_000 }, (_item, index) => task(`activity-task-${index}`, index, {
    createdAt: 0,
    messages: [{ id: `audible-${index}`, kind: "assistant", text: "heard", at: index * 7_919 % 5_000 }, ...withdrawn],
  }));
  return {
    tasks,
    busy: new Set(tasks.filter((_item, index) => index % 10 === 0).map((item) => item.id)),
    blocked: new Set(tasks.filter((_item, index) => index % 17 === 0).map((item) => item.id)),
  };
}

function projectionFixtures(target) {
  const findTasks = Array.from({ length: 20_000 }, (_item, index) => task(
    index === 19_999 ? "needle-target-19999" : `search-task-${index}`,
    index,
    { createdAt: index * 7_919 % 20_000, updatedAt: index * 7_919 % 20_000 },
  ));
  const repeatedTool = { id: "tool", kind: "tool", text: "work", at: 2 };
  const waitTask = task("wait-thread", 0, {
    messages: [
      { id: "reply", kind: "assistant", text: "The answer", at: 1 },
      ...Array(99_999).fill(repeatedTool),
    ],
  });
  return {
    findState: { ...target.workspace.emptyWorkspaceState(), tasks: findTasks },
    waitState: { ...target.workspace.emptyWorkspaceState(), tasks: [waitTask] },
  };
}

function workspaceMergeOutput(state) {
  return {
    tasks: state.tasks.map((item) => [item.id, item.projectId, item.worktreeId]),
    worktrees: state.worktrees.map((item) => [item.id, item.projectId]),
    projects: state.projects.map((item) => [item.id, item.root]),
    lastFolder: state.lastFolder,
    currentId: state.currentId,
    history: state.history,
    draftProjectId: state.draftProjectId,
  };
}

function additionalCases(target) {
  const workflow = workflowFixture();
  const parsedStore = parseStoreFixture();
  const merge = mergeStoreFixture(target);
  const activity = activityFixture();
  const projection = projectionFixtures(target);
  const paragraph = "plain words ".repeat(200_000);
  const findMessage = { id: "find-message", kind: "assistant", text: "haystack ".repeat(1_000_000), at: 1 };
  const findViewState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: [task("find-view-task", 0, { messages: [findMessage] })],
    currentId: "find-view-task",
    find: { target: { kind: "transcript" }, query: "needle", index: 0 },
  };
  const dockState = target.workspace.emptyWorkspaceState();
  const emptyDock = target.workspace.dockFor(dockState, "unused");
  const reducerState = {
    ...dockState,
    docks: Object.fromEntries(Array.from({ length: 10_000 }, (_item, index) => [`dock-${index}`, emptyDock])),
  };
  const archiveWorktrees = Array.from({ length: 5_000 }, (_item, index) => worktree(`archive-worktree-${index}`, index, "archive-project"));
  const archiveState = {
    ...target.workspace.emptyWorkspaceState(),
    tasks: [
      ...archiveWorktrees.map((item, index) => task(`live-archive-${index}`, index, { projectId: "archive-project", worktreeId: item.id })),
      ...Array.from({ length: 5_000 }, (_item, index) => task(`filed-${index}`, 10_000 + index, { archivedAt: index + 1 })),
    ],
    worktrees: archiveWorktrees,
  };
  const handleOptions = Array.from({ length: 20_000 }, (_item, index) => ({
    id: `handle-option-${index}`, title: `Investigate renderer ${index === 19_999 ? "needle" : "boundary"} ${index}`, handle: `investigate-renderer-${index}`,
    project: "project", inScope: true, running: false, lastActivityAt: 20_000 - index,
  }));
  return [
    {
      name: "workflow groups, large single phase",
      iterations: 1,
      run: () => target.workflow.workflowGroups(workflow),
      normalize: (groups) => groups.map((group) => [group.key, group.title, group.agents.map((agent) => agent.index)]),
    },
    {
      name: "task store parse, tasks and worktrees",
      iterations: 1,
      run: () => target.taskDomain.parseTaskStore(parsedStore),
      normalize: (result) => result,
    },
    {
      name: "store data merge",
      iterations: 1,
      run: () => target.workspace.withStoreData(merge.state, merge.data),
      normalize: workspaceMergeOutput,
    },
    {
      name: "activity sections, withdrawn tails",
      iterations: 1,
      run: () => target.taskOrder.activitySections(activity.tasks, activity.busy, activity.blocked),
      normalize: (sections) => Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.map((item) => item.id)])),
    },
    {
      name: "find thread, 20k tasks",
      iterations: 1,
      run: () => target.projection.findThread(projection.findState, "needle-target"),
      normalize: (result) => result && [result.id, result.title, result.createdAt, result.updatedAt],
    },
    {
      name: "thread wait result, 100k messages",
      iterations: 1,
      run: () => target.projection.threadWaitResult(projection.waitState, "wait-thread", true),
      normalize: (result) => result,
    },
    {
      name: "inline-safe end, long plain paragraph",
      iterations: 1,
      run: () => target.markdown.inlineSafeEnd(paragraph),
      normalize: (result) => result,
    },
    {
      name: "workspace view, unchanged transcript find",
      iterations: 1,
      run: () => target.workspace.deriveView(findViewState),
      normalize: (view) => view.find,
    },
    {
      name: "reducer event, unchanged workflow docks",
      iterations: 1,
      run: () => target.reducer.reduce(reducerState, { type: "view.set-menu", menu: "benchmark" }),
      normalize: (transition) => transition,
    },
    {
      name: "clear archive, claimed worktrees",
      iterations: 1,
      run: () => target.reducer.reduce(archiveState, { type: "task.clear-archive" }),
      normalize: (transition) => ({ tasks: transition.state.tasks.map((item) => item.id), worktrees: transition.state.worktrees.map((item) => item.id), effects: transition.effects }),
    },
    {
      name: "bounded thread handle ranking",
      iterations: 1,
      run: () => target.handles.rankThreadHandles(handleOptions, "", 8).slice(0, 8),
      normalize: (options) => options.map((option) => option.id),
    },
    {
      name: "thread handle title matching",
      iterations: 1,
      run: () => target.handles.rankThreadHandles(handleOptions, "needle", 8).slice(0, 8),
      normalize: (options) => options.map((option) => option.id),
    },
  ];
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
      return { roots, loaded: database.load() };
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
      ...additionalCases(target),
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
