import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SAMPLES = 11;
const WARMUPS = 3;
let sink;

function targetsFrom(argv) {
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

function onlyFrom(argv) {
  const at = argv.indexOf("--only");
  return at === -1 ? "" : argv[at + 1] ?? "";
}

async function loadTarget(target) {
  const load = (relative) => import(pathToFileURL(path.join(target.root, "dist/main", relative)).href);
  const [pastes, workflow, diff, workspace, task, taskOrder, projectOrder, projection, reducer] = await Promise.all([
    load("application/pastes.js"),
    load("domain/workflow.js"),
    load("domain/diff.js"),
    load("application/workspace-state.js"),
    load("domain/task.js"),
    load("application/task-order.js"),
    load("application/project-order.js"),
    load("application/thread-projection.js"),
    load("application/workspace-reducer.js"),
  ]);
  return { ...target, pastes, workflow, diff, workspace, task, taskOrder, projectOrder, projection, reducer };
}

function workflowFixture() {
  return {
    id: "span", name: "Span", description: "", status: "completed", phases: [],
    agents: Array.from({ length: 20_000 }, (_item, index) => ({
      index,
      label: `Agent ${index}`,
      state: "done",
      queuedAt: 1_000 + index,
      startedAt: 2_000 + index,
      durationMs: index % 100,
    })),
    totalTokens: 0,
    totalToolCalls: 0,
    startedAt: 500,
    finishedAt: 30_000,
  };
}

function patchFixture() {
  const rows = Array.from({ length: 50_000 }, (_item, index) => {
    if (index % 20 === 0) return `-old value ${index}`;
    if (index % 20 === 1) return `+new value ${index}`;
    return ` context value ${index}`;
  });
  return `--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1,50000 +1,50000 @@ benchmark\n${rows.join("\n")}\n`;
}

function casesFor(target) {
  const manyLines = `${"content\n".repeat(200_000)}tail`;
  const titledPaste = [{ id: "paste", text: `\n \n  First useful line  \n${"tail\n".repeat(200_000)}` }];
  const workflow = workflowFixture();
  const patch = patchFixture();
  const file = target.diff.parseFilePatch(patch, "src/large.ts");
  const orderedTasks = Array.from({ length: 20_000 }, (_item, index) => ({ id: `task-${index}`, sortIndex: index, updatedAt: index }));
  const messages = Array.from({ length: 50_000 }, (_item, index) => index % 2
    ? { id: `assistant-${index}`, kind: "assistant", text: "answer", at: index }
    : { id: `user-${index}`, kind: "user", text: `prompt ${index}`, at: index });
  const emptyWorkspace = target.workspace.emptyWorkspaceState();
  const emptyDock = target.workspace.dockFor(emptyWorkspace, "unused");
  const preferenceTasks = Array.from({ length: 5_000 }, (_item, index) => ({ id: `owner-${index}` }));
  const preferenceState = {
    ...emptyWorkspace,
    tasks: preferenceTasks,
    docks: Object.fromEntries([
      ...preferenceTasks.map((task, index) => [task.id, { ...emptyDock, browserTabs: [{ url: `https://example.com/${index}` }] }]),
      ["orphan-a", { ...emptyDock, browserTabs: [{ url: "https://orphan.invalid/a" }] }],
      ["orphan-b", { ...emptyDock, browserTabs: [{ url: "https://orphan.invalid/b" }] }],
    ]),
  };
  const projects = Array.from({ length: 20_000 }, (_item, index) => ({ id: `project-${index}`, root: `/project/${index}`, sortIndex: index }));
  const projectRoots = Array.from({ length: 20_000 }, (_item, index) => `/Users/example/workspace/team-${index % 200}/project-${index}///`);
  const summaryTasks = Array.from({ length: 5_000 }, (_item, taskIndex) => ({
    id: `summary-${taskIndex}`,
    title: `Summary ${taskIndex}`,
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: taskIndex },
    messages: Array.from({ length: 100 }, (_message, messageIndex) => ({
      id: `message-${taskIndex}-${messageIndex}`,
      kind: messageIndex % 2 ? "assistant" : "user",
      text: "message",
      at: messageIndex,
      ...(messageIndex === 99 ? { attachments: [`/tmp/${taskIndex}.png`] } : {}),
    })),
    sortIndex: taskIndex,
    createdAt: taskIndex,
    updatedAt: taskIndex,
  }));
  const summaryState = { ...emptyWorkspace, tasks: summaryTasks };
  const sendTasks = Array.from({ length: 20_000 }, (_item, index) => ({
    id: `send-${index}`, title: `Send ${index}`, messages: [], sortIndex: index, createdAt: index, updatedAt: index,
  }));
  const sendTaskId = sendTasks[0].id;
  const sendState = { ...emptyWorkspace, tasks: sendTasks, currentId: sendTaskId, prompts: { [sendTaskId]: "plain text without a handle" } };
  const normalizeSend = (transition) => ({
    prompt: transition.state.prompts[sendTaskId],
    pending: Object.values(transition.state.pendingRuns).map(({ id: _id, runId: _runId, ...pending }) => pending),
    effects: transition.effects.map(({ runId: _runId, pendingId: _pendingId, ...effect }) => effect),
  });
  return [
    { group: "batch1", name: "paste line count, 200k lines", iterations: 1, run: () => target.pastes.lineCount(manyLines) },
    { group: "batch1", name: "paste title, early line in 200k-line paste", iterations: 1, run: () => target.pastes.pasteTitle(titledPaste) },
    { group: "batch1", name: "workflow span, 20k agents", iterations: 1, run: () => target.workflow.workflowSpan(workflow, 31_000) },
    { group: "batch1", name: "parse diff patch, 50k rows", iterations: 1, run: () => target.diff.parseFilePatch(patch, "src/large.ts") },
    { group: "batch1", name: "flatten diff rows, 50k rows", iterations: 1, run: () => target.diff.diffRows(file) },
    { group: "batch2", name: "persist view preferences, 5k docks", iterations: 1, run: () => target.workspace.viewPreferences(preferenceState) },
    { group: "batch2", name: "collect sent prompts, 50k messages", iterations: 1, run: () => target.task.sentPrompts(messages) },
    { group: "batch2", name: "order already-sorted 20k tasks", iterations: 1, run: () => target.taskOrder.orderTasks(orderedTasks) },
    { group: "batch2", name: "next task sort index, 20k tasks", iterations: 1, run: () => target.taskOrder.nextSortIndex(orderedTasks) },
    { group: "batch2", name: "diff hunk text, 50k rows", iterations: 1, run: () => target.diff.hunkText(file.hunks[0], "new") },
    { group: "batch3", name: "plain task send, 20k-thread workspace", iterations: 1, run: () => target.reducer.reduce(sendState, { type: "task.send", taskId: sendTaskId }), normalize: normalizeSend },
    { group: "batch3", name: "thread summaries with attachments", iterations: 1, run: () => target.projection.threadSummaries(summaryState, { scope: { kind: "all" }, attachments: true }, 100_000) },
    {
      group: "batch3",
      name: "workflow completion counts, 20k agents",
      iterations: 1,
      run: () => target.workflow.workflowAgentCounts?.(workflow) ?? {
        done: target.workflow.workflowAgentsDone(workflow),
        failed: target.workflow.workflowAgentsFailed(workflow),
      },
    },
    { group: "batch3", name: "next project sort index, 20k projects", iterations: 1, run: () => target.projectOrder.nextProjectSortIndex(projects) },
    { group: "batch3", name: "split diff rows, 50k rows", iterations: 1, run: () => target.diff.splitRows(file) },
    { group: "batch4", name: "project folder names, 20k roots", iterations: 1, run: () => projectRoots.map(target.task.folderName) },
  ];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function stats(samples) {
  const middle = median(samples);
  return { median: middle, mad: median(samples.map((value) => Math.abs(value - middle))) };
}

function measure(benchmark) {
  globalThis.gc?.();
  const started = performance.now();
  for (let index = 0; index < benchmark.iterations; index += 1) sink = benchmark.run();
  return (performance.now() - started) / benchmark.iterations;
}

const argv = process.argv.slice(2);
const targets = await Promise.all(targetsFrom(argv).map(loadTarget));
const only = onlyFrom(argv).toLowerCase();
const suites = targets.map((target) => casesFor(target).filter((benchmark) => `${benchmark.group ?? ""} ${benchmark.name}`.toLowerCase().includes(only)));
if (!suites[0].length) throw new Error(`No benchmark includes "${only}"`);
const rows = [];

for (let caseIndex = 0; caseIndex < suites[0].length; caseIndex += 1) {
  const cases = suites.map((suite) => suite[caseIndex]);
  const expected = cases[0].normalize?.(cases[0].run()) ?? cases[0].run();
  for (const benchmark of cases.slice(1)) {
    const output = benchmark.normalize?.(benchmark.run()) ?? benchmark.run();
    assert.deepEqual(output, expected, `${benchmark.name} changed output`);
  }
  for (const benchmark of cases) {
    for (let warmup = 0; warmup < WARMUPS; warmup += 1) measure(benchmark);
  }
  const samples = cases.map(() => []);
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const order = cases.map((_item, index) => index);
    if (sample % 2) order.reverse();
    for (const index of order) samples[index].push(measure(cases[index]));
  }
  rows.push({ name: cases[0].name, results: samples.map(stats) });
}

const headings = ["benchmark", ...targets.flatMap((target) => [`${target.label} median`, `${target.label} MAD`])];
if (targets.length === 2) headings.push("saved", "gain", "accepted");
const table = rows.map((row) => {
  const values = [row.name, ...row.results.flatMap((result) => [`${result.median.toFixed(2)} ms`, `${result.mad.toFixed(2)} ms`])];
  if (targets.length === 2) {
    const [before, after] = row.results;
    const saved = before.median - after.median;
    const gain = saved / before.median;
    const significant = saved > 3 * (before.mad + after.mad);
    values.push(`${saved.toFixed(2)} ms`, `${(gain * 100).toFixed(1)}%`, gain >= 0.05 && significant ? "yes" : "no");
  }
  return Object.fromEntries(headings.map((heading, index) => [heading, values[index]]));
});
console.table(table);
