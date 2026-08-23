import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const SAMPLES = 11;
const WARMUPS = 3;

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
  const vite = await createServer({ root: target.root, logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  const { ProjectSidebar } = await vite.ssrLoadModule("/src/renderer/components/ProjectSidebar.tsx");
  const require = createRequire(path.join(target.root, "package.json"));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  return { ...target, vite, React, renderToStaticMarkup, ProjectSidebar };
}

function task(id, index, overrides = {}) {
  return {
    id, title: `Thread ${index}`, executionPolicy: "confirm", messages: [], continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: index }, sortIndex: index, createdAt: index, updatedAt: index,
    ...overrides,
  };
}

const noops = Object.fromEntries([
  "onGoBack", "onGoForward", "onNewTask", "onOpenFolder", "onToggleProject", "onRenameProject", "onEditProject",
  "onRemoveProject", "onSetMode", "onSetSectionOpen", "onSetOpenMenu", "onSelectTask", "onArchiveTask",
  "onDismissTask", "onDismissAll", "onRenameTask", "onMoveTask", "onMoveProject", "onOpenSettings",
].map((name) => [name, () => {}]));

function props(overrides) {
  return {
    open: true, inactive: false, projects: [], orderedTasks: [], recentTasks: [], currentId: null,
    draftProjectId: null, expandedProjects: new Set(), runningTaskIds: new Set(), blockedTaskIds: new Set(),
    schedules: new Map(), worktreeTaskIds: new Set(), worktreeGroups: [],
    activityTasks: { priority: [], running: [], threads: [] }, mode: "projects",
    sections: { projects: true, recents: false, priority: false, running: false, threads: true },
    openMenu: null, settingsOpen: false, canGoBack: false, canGoForward: false, ...noops, ...overrides,
  };
}

const timedTasks = Array.from({ length: 300 }, (_item, index) => task(`timed-${index}`, index));
const projects = Array.from({ length: 800 }, (_item, index) => ({ id: `project-${index}`, root: `/project/${index}` }));
const projectTasks = Array.from({ length: 8_000 }, (_item, index) => task(`project-task-${index}`, index, { projectId: `project-${index % projects.length}` }));
const worktreeGroups = Array.from({ length: 1_500 }, (_item, index) => ({
  worktree: { id: `worktree-${index}`, projectId: `project-${index % projects.length}`, root: `/worktree/${index}`, workspaceId: `workspace-${index}`, baseCommit: "abcdef0", createdAt: index, lastUsedAt: index },
  tasks: [],
}));
const cases = [
  ["sidebar time formatting", props({ mode: "activity", activityTasks: { priority: [], running: [], threads: timedTasks } })],
  ["sidebar project grouping", props({ projects, orderedTasks: projectTasks, worktreeGroups })],
];

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function stats(values) {
  const middle = median(values);
  return { median: middle, mad: median(values.map((value) => Math.abs(value - middle))) };
}

const targets = await Promise.all(targetArguments(process.argv.slice(2)).map(loadTarget));
try {
  const rows = [];
  for (const [name, input] of cases) {
    const runs = targets.map((target) => () => target.renderToStaticMarkup(target.React.createElement(target.ProjectSidebar, input)));
    const expected = runs[0]();
    for (const run of runs.slice(1)) assert.equal(run(), expected, `${name} changed rendered output`);
    for (const run of runs) for (let warmup = 0; warmup < WARMUPS; warmup += 1) run();
    const samples = runs.map(() => []);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const order = sample % 2 ? runs.map((_run, index) => index).reverse() : runs.map((_run, index) => index);
      for (const index of order) {
        globalThis.gc?.();
        const started = performance.now();
        runs[index]();
        samples[index].push(performance.now() - started);
      }
    }
    rows.push({ name, output: expected, measured: samples.map(stats) });
  }
  console.table(rows.map(({ name, output, measured }) => {
    const row = { benchmark: name, hash: createHash("sha256").update(output).digest("hex").slice(0, 12), bytes: output.length };
    for (const [index, result] of measured.entries()) {
      row[`${targets[index].label} median`] = `${result.median.toFixed(2)} ms`;
      row[`${targets[index].label} MAD`] = `${result.mad.toFixed(2)} ms`;
    }
    if (measured.length === 2) {
      row.saved = `${(measured[0].median - measured[1].median).toFixed(2)} ms`;
      row.speedup = `${(measured[0].median / measured[1].median).toFixed(2)}x`;
    }
    return row;
  }));
} finally {
  await Promise.all(targets.map((target) => target.vite.close()));
}
