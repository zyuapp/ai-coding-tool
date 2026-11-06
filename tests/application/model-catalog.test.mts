import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { BUILT_IN_MODELS, modelsFor, type EngineStatus, type ModelSpec } from "../../src/domain/agent-engine.ts";
import { effectAt, run, send, task, workspace } from "./workspace-reducer-fixtures.mts";
import { parseThreadStore, serializeThreadStore } from "../../src/domain/thread-storage.ts";
import { newThreadSend } from "../../src/application/thread-starts.ts";

const named: ModelSpec[] = [
  { id: "openai/gpt-9", label: "GPT-9", description: "Named by the engine", contextWindow: 400_000, efforts: [{ id: "high", label: "High" }, { id: "low", label: "Low" }], manualCompaction: true },
  { id: "local/tiny", label: "Tiny", description: "Runs alone", contextWindow: 8_000, efforts: [], delegable: false },
];
const status: EngineStatus = { claude: { access: "ready" }, codex: { access: "ready", catalog: named } };
const projectless = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

test("the view offers the built-in models until an engine names its own", () => {
  assert.equal(deriveView(workspace()).models, BUILT_IN_MODELS);
  const read = reduce(workspace(), { type: "engine.status", status }).state;
  assert.deepEqual(modelsFor(deriveView(read).models, "codex").map((spec) => spec.id), ["openai/gpt-9", "local/tiny"]);
  assert.deepEqual(modelsFor(deriveView(read).models, "claude"), modelsFor(BUILT_IN_MODELS, "claude"));
});

test("a model an engine named for itself can be picked and sent once main has named it", () => {
  const unread = reduce(workspace(), { type: "task.set-model", engine: "codex", model: "openai/gpt-9" });
  assert.equal(unread.state.draftModel, workspace().draftModel, "before main names it, no engine offers it");

  const read = reduce(workspace(), { type: "engine.status", status }).state;
  const picked = reduce(read, { type: "task.set-model", engine: "codex", model: "openai/gpt-9" }).state;
  assert.equal(picked.draftEngine, "codex");
  assert.equal(picked.draftModel, "openai/gpt-9");
  assert.equal(reduce(read, { type: "task.set-model", engine: "claude", model: "openai/gpt-9" }).state, read, "it is the engine's that named it, not another's");

  const efforts = reduce(picked, { type: "task.set-effort", engine: "codex", effort: "max" });
  assert.equal(efforts.state, picked, "an effort the named model does not take is refused");
  const medium = reduce(picked, { type: "task.set-effort", engine: "codex", effort: "low" }).state;
  assert.equal(medium.draftEffort, "low");

  const started = send(run(medium, [{ type: "view.set-prompt", prompt: "Inspect the app" }]), projectless);
  const command = effectAt(started, "start-run").command;
  assert.equal(command.engine, "codex");
  assert.equal(command.model, "openai/gpt-9");
  assert.equal(command.effort, "low");
  assert.equal(started.state.threads[0]?.model, "openai/gpt-9");
});

test("a send naming a model no engine offers is refused before any run, whoever sends it", () => {
  const composer = reduce(workspace(), { type: "task.send", text: "Use mystery", model: "mystery/model" });
  assert.equal(composer.state.actionError, "No engine here offers the mystery/model model. Pick another model.");
  assert.deepEqual(composer.state.pendingRuns, {});
  assert.deepEqual(composer.effects.filter((effect) => effect.type === "resolve-run-workspace"), []);

  const caller = task("caller");
  const fromThread = reduce(workspace({ threads: [caller] }), { type: "task.send", text: "Use mystery", model: "mystery/model", from: { taskId: "caller" } } as never);
  assert.deepEqual(fromThread.result, { ok: false, message: "No engine here offers the mystery/model model. Pick another model." });
  assert.deepEqual(fromThread.state.pendingRuns, {});
});

test("a coordinator's threads cannot be set to run on a model no engine offers, nor on one that may not be delegated", () => {
  const lead = task("lead", { role: "coordinator" });
  const state = reduce(workspace({ threads: [lead] }), { type: "engine.status", status }).state;
  const unknown = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "mystery/model" });
  assert.equal(unknown.state.threads[0]?.threadModel, undefined);
  assert.equal(unknown.state.actionError, "No engine here offers the mystery/model model. Pick another model.");

  const tiny = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "local/tiny" });
  assert.equal(tiny.state.threads[0]?.threadModel, undefined, "a named model can still be one a coordinator may not hand work to");

  const gpt9 = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "openai/gpt-9", effort: "max" }).state;
  assert.deepEqual(gpt9.threads[0]?.threadModel, { engine: "codex", model: "openai/gpt-9", effort: "high" });
});

test("a thread on a model no engine here offers still draws, by its id and the effort it was given", () => {
  const thread = task("task-a", { engine: "codex", model: "openai/gpt-9", effort: "max" });
  const view = deriveView(workspace({ threads: [thread], currentId: "task-a" }));
  assert.equal(view.model, "openai/gpt-9");
  assert.equal(view.effort, "max");
});

test("a composer send on a draft whose model its engine does not offer here is refused before any run", () => {
  const drafted = run(workspace({ draftEngine: "codex", draftModel: "gpt-9-future" }), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sent = reduce(drafted, { type: "task.send", attachments: [] });
  assert.equal(sent.state.actionError, "No engine here offers the gpt-9-future model. Pick another model.");
  assert.deepEqual(sent.state.pendingRuns, {});

  const crossed = run(workspace({ draftEngine: "claude", draftModel: "gpt-6.1-sol" }), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  assert.deepEqual(reduce(crossed, { type: "task.send", attachments: [] }).state.pendingRuns, {}, "a model of another engine is not this one's");
});

test("a loaded thread on a model its engine no longer offers takes no message until another model is picked", () => {
  const thread = task("task-a", { engine: "codex", model: "gpt-9-future" });
  const serialized = serializeThreadStore({ version: 2, tasks: [thread], projects: [], worktrees: [], lastFolder: null });
  const parsed = parseThreadStore(serialized);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const loaded = reduce(workspace(), { type: "store.loaded", data: parsed.data }).state;
  assert.equal(loaded.draftModel, "gpt-9-future", "the draft follows the first thread, as it always has");

  const refused = reduce(loaded, { type: "task.send", taskId: "task-a", text: "Carry on" });
  assert.equal(refused.state.actionError, "No engine here offers the gpt-9-future model. Pick another model.");
  assert.deepEqual(refused.state.pendingRuns, {});
  assert.deepEqual(reduce(loaded, { type: "task.send", text: "Start fresh" }).state.pendingRuns, {}, "nor does a new thread on the draft");

  const repicked = reduce(loaded, { type: "task.set-model", taskId: "task-a", engine: "codex", model: "gpt-6.1-sol" }).state;
  assert.notDeepEqual(reduce(repicked, { type: "task.send", taskId: "task-a", text: "Carry on" }).state.pendingRuns, {});
});

test("a draft seeded from a stored thread that names no model takes its engine's default", () => {
  const thread = task("task-a", { engine: "codex" });
  delete thread.model;
  const loaded = reduce(workspace(), { type: "store.loaded", data: { version: 2, tasks: [thread], projects: [], worktrees: [], lastFolder: null } }).state;
  assert.equal(loaded.draftEngine, "codex");
  assert.equal(loaded.draftModel, "gpt-6.1-sol");
  assert.notDeepEqual(reduce(loaded, { type: "task.send", text: "Start fresh" }).state.pendingRuns, {});
});

test("a run whose model left the catalogue while it found its workspace is not started", () => {
  const read = reduce(workspace(), { type: "engine.status", status }).state;
  const picked = run(reduce(read, { type: "task.set-model", engine: "codex", model: "openai/gpt-9" }).state, [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(picked, { type: "task.send", attachments: [] });
  const dropped = reduce(sending.state, { type: "engine.status", status: { codex: { access: "ready", catalog: [named[1]!] } } }).state;
  const resolved = reduce(dropped, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: projectless });
  assert.equal(resolved.effects.some((effect) => effect.type === "start-run"), false);
  assert.equal(resolved.state.threads.length, 0);
  assert.equal(resolved.state.actionError, "No engine here offers the openai/gpt-9 model. Pick another model.");
});

test("no run of any kind starts on a thread whose model its engine does not offer here", () => {
  const thread = task("task-a", { engine: "codex", model: "gpt-9-future", continuation: { provider: "codex", value: "thread-1" }, contextUsage: { tokens: 10, limit: 100, model: "gpt-9-future" } });
  const base = { runId: "run-x", taskId: "task-a", text: "Check", prompt: "Check", attachments: [] };
  const pendings = {
    tick: { ...base, id: "tick", origin: "automation" as const, automationId: "a1" },
    resume: { ...base, id: "resume", origin: "composer" as const, operation: { type: "resume" as const } },
    compact: { ...base, id: "compact", origin: "composer" as const, operation: { type: "compact" as const } },
    send: { ...base, id: "send", origin: "composer" as const },
  };
  for (const [id, pending] of Object.entries(pendings)) {
    const state = workspace({ threads: [thread], pendingRuns: { [id]: pending as never } });
    const resolved = reduce(state, { type: "run.resolved", pendingId: id, workspace: projectless });
    assert.equal(resolved.effects.some((effect) => effect.type === "start-run"), false, id);
    assert.deepEqual(resolved.state.pendingRuns, {}, id);
    assert.deepEqual(resolved.state.activeRuns, {}, id);
    if (id === "tick") assert.deepEqual(resolved.effects, [{ type: "automation.ack", ack: { automationId: "a1", runId: "run-x", started: false } }]);
    else assert.equal(resolved.state.actionError, "No engine here offers the gpt-9-future model. Pick another model.", id);
  }

  const known = { ...thread, model: "gpt-6.1-sol" };
  const tick = reduce(workspace({ threads: [known], pendingRuns: { tick: pendings.tick } }), { type: "run.resolved", pendingId: "tick", workspace: projectless });
  assert.equal(tick.effects.some((effect) => effect.type === "start-run"), true, "a thread on a model its engine offers still ticks");
});

test("a thread on an engine whose models main has yet to name runs on its model, and is held to them once named", () => {
  const thread = task("task-a", { engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" });
  const early = reduce(workspace({ threads: [thread] }), { type: "task.send", taskId: "task-a", text: "Carry on" });
  assert.equal(early.state.actionError, null);
  assert.notDeepEqual(early.state.pendingRuns, {}, "a launch still reading its engines does not turn the thread away");

  const named = reduce(workspace({ threads: [thread] }), { type: "engine.status", status: { opencode: { access: "ready", catalog: [{ id: "openrouter/other", label: "Other", description: "", contextWindow: 8_000, efforts: [] }] } } });
  const refused = reduce(named.state, { type: "task.send", taskId: "task-a", text: "Carry on" });
  assert.equal(refused.state.actionError, "No engine here offers the openrouter/z-ai/glm-5.3-flash model. Pick another model.");
  assert.deepEqual(refused.state.pendingRuns, {});

  const drafted = run(workspace({ draftEngine: "opencode", draftModel: "openrouter/z-ai/glm-5.3-flash" }), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const fresh = send(drafted, projectless);
  assert.equal(effectAt(fresh, "start-run").command.model, "openrouter/z-ai/glm-5.3-flash", "nor a new thread on a draft of that engine");

  const codex = task("task-b", { engine: "codex", model: "gpt-9-future" });
  assert.deepEqual(reduce(workspace({ threads: [codex] }), { type: "task.send", taskId: "task-b", text: "Carry on" }).state.pendingRuns, {}, "an engine that ships knowing its models is held to them from the start");
});

test("a model two engines name runs on the engine it was picked on, and one named without its engine on the first", () => {
  const gateway: ModelSpec = { id: "opus", label: "Gateway Opus", description: "Served elsewhere", contextWindow: 64_000, efforts: [{ id: "low", label: "Low" }] };
  const both = reduce(workspace({ threads: [task("lead", { role: "coordinator" })] }), { type: "engine.status", status: { claude: { access: "ready" }, codex: { access: "ready", catalog: [gateway] } } }).state;
  const started = (input: { model: string; engine?: "claude" | "codex" }) => {
    const sending = reduce(both, { type: "task.send", text: "Inspect the app", ...input });
    const request = effectAt(sending, "resolve-run-workspace");
    return effectAt(reduce(sending.state, { type: "run.resolved", pendingId: request.pendingId, workspace: projectless }), "start-run").command;
  };
  assert.deepEqual([started({ engine: "codex", model: "opus" }).engine, started({ engine: "codex", model: "opus" }).effort], ["codex", "low"]);
  assert.equal(started({ engine: "claude", model: "opus" }).engine, "claude");
  assert.equal(started({ model: "opus" }).engine, "claude", "as an older computer names it");

  const chosen = reduce(both, { type: "coordination.set-thread-model", taskId: "lead", engine: "codex", model: "opus" }).state;
  assert.deepEqual(chosen.threads.find((thread) => thread.id === "lead")?.threadModel, { engine: "codex", model: "opus", effort: "low" });

  const caller = both.threads[0]!;
  const asked = (input: { model: string; engine?: "codex" }) => newThreadSend(both, { ...caller, role: undefined }, { type: "task.send", text: "Fix it", ...input });
  assert.deepEqual(asked({ model: "opus" }), { error: "opus could mean opus on Claude, opus on Codex. Name the engine as well, or pin the one you mean in the model picker." }, "a thread asking names which one it means");
  const start = asked({ model: "Gateway Opus", engine: "codex" });
  assert.ok("command" in start && start.command.engine === "codex" && start.command.model === "opus");
});
