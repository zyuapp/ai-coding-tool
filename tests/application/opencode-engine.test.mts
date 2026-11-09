import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { newThreadSend, threadProposal } from "../../src/application/thread-starts.ts";
import { BUILT_IN_MODELS,defaultModelFor, defaultModelIn, engineCatalog, engineModelsKnown, engineNotice, modelLabel, policyFor, resolveModel, threadModel, type AgentEngine, type EngineStatus, type ModelSpec } from "../../src/domain/agent-engine.ts";
import { threadModelOf } from "../../src/domain/coordination.ts";
import { describeToolCall } from "../../src/domain/tool-call.ts";
import { effectAt, run, send, task, workspace } from "./workspace-reducer-fixtures.mts";

const models: ModelSpec[] = [
  { id: "openrouter/z-ai/glm-5.3-flash", label: "GLM-5.3-Flash", description: "z-ai/glm-5.3-flash", provider: "OpenRouter", contextWindow: 1_048_576, efforts: [{ id: "max", label: "Max" }, { id: "high", label: "High" }, { id: "low", label: "Low" }], manualCompaction: true },
  { id: "opencode-go/glm-5.3", label: "GLM-5.3", description: "glm-5.3", provider: "OpenCode Go", contextWindow: 200_000, efforts: [], manualCompaction: true },
];
const status: EngineStatus = { opencode: { access: "ready", version: "2.2.5", catalog: models } };
const projectless = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

test("OpenCode offers every mode but Auto, which stands on a reviewer it has none of", () => {
  assert.equal(policyFor("opencode", "autonomous"), "allow-edits");
  assert.equal(policyFor("opencode", "bypass"), "bypass");
  assert.equal(policyFor("claude", "autonomous"), "autonomous");
  assert.equal(policyFor("codex", "autonomous"), "autonomous");
  assert.equal(policyFor("opencode", "plan"), "plan");
  assert.equal(policyFor("future" as AgentEngine, "bypass"), "confirm", "an engine only a newer build knows offers no mode, so it asks for everything");
});

test("an engine's models are known by how it knows them, never by an empty list", () => {
  assert.equal(engineModelsKnown(null, "claude"), true);
  assert.equal(engineModelsKnown(null, "opencode"), false);
  assert.equal(engineModelsKnown(status, "opencode"), true);
  assert.equal(engineModelsKnown(null, "future" as AgentEngine), true, "one only a newer build knows offers none here, and does not throw");
  assert.equal(defaultModelFor("opencode"), undefined);
  assert.equal(defaultModelFor("future" as AgentEngine), undefined);
});

test("an OpenCode thread that names no model never runs on a Claude one", () => {
  const unnamed = task("task-a", { engine: "opencode" });
  assert.equal(threadModel(BUILT_IN_MODELS, unnamed), undefined);
  assert.equal(threadModel(engineCatalog(status), unnamed), "openrouter/z-ai/glm-5.3-flash");

  const early = reduce(workspace({ threads: [unnamed] }), { type: "task.send", taskId: "task-a", text: "Carry on" });
  assert.equal(early.state.actionError, "OpenCode has not named a model for this thread yet. Pick a model.");
  assert.deepEqual(early.state.pendingRuns, {});
  assert.equal(deriveView(workspace({ threads: [unnamed], currentId: "task-a" })).model, undefined, "the composer names no model for it either");

  const read = reduce(workspace({ threads: [unnamed] }), { type: "engine.status", status }).state;
  const sending = reduce(read, { type: "task.send", taskId: "task-a", text: "Carry on" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: projectless });
  assert.equal(effectAt(started, "start-run").command.model, "openrouter/z-ai/glm-5.3-flash", "once named, it runs on its engine's default");

  const lead = task("lead", { engine: "opencode", role: "coordinator" });
  assert.equal(threadModelOf(BUILT_IN_MODELS, lead), undefined, "nor does a coordinator's thread take one");
  assert.equal(threadModelOf(engineCatalog(status), lead)?.model, "openrouter/z-ai/glm-5.3-flash");
});

test("picking an engine without a model moves the draft to that engine's default here", () => {
  assert.equal(reduce(workspace(), { type: "task.set-model", engine: "opencode" }).state.draftEngine, "claude", "nothing to move to before OpenCode names its models");
  const read = reduce(workspace(), { type: "engine.status", status }).state;
  const moved = reduce(read, { type: "task.set-model", engine: "opencode" }).state;
  assert.equal(moved.draftEngine, "opencode");
  assert.equal(moved.draftModel, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(reduce(workspace(), { type: "task.set-model", engine: "codex" }).state.draftModel, "gpt-6.1-sol");
});

test("an engine whose models are only known once it names them defaults to the first it names", () => {
  assert.equal(defaultModelIn(BUILT_IN_MODELS, "claude"), "opus");
  assert.equal(defaultModelIn(engineCatalog(status), "opencode"), "openrouter/z-ai/glm-5.3-flash");
  assert.equal(defaultModelIn(BUILT_IN_MODELS, "opencode"), undefined, "an engine that lists no models has no default");
  assert.deepEqual(engineNotice("opencode", { access: "ready", catalog: [], fix: "opencode auth login" }), { blocking: true, message: "OpenCode has no models. Connect a provider first.", fix: "opencode auth login" });
  assert.equal(engineNotice("opencode", status.opencode!), null);
  assert.deepEqual(engineNotice("opencode", { access: "outdated", version: "1.18.34", required: "2.2.5" }), { blocking: true, message: "OpenCode 1.18.34 is too old. Update to 2.2.5." });
});

test("a draft moved onto OpenCode on Auto is held to Edits, and Auto cannot be picked there", () => {
  const read = reduce(workspace({ draftPolicy: "autonomous" }), { type: "engine.status", status }).state;
  const moved = reduce(read, { type: "task.set-model", engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }).state;
  assert.equal(moved.draftEngine, "opencode");
  assert.equal(moved.draftPolicy, "allow-edits");
  assert.equal(reduce(moved, { type: "task.set-policy", policy: "autonomous" }).state, moved);
  assert.equal(reduce(moved, { type: "task.set-policy", policy: "bypass" }).state.draftPolicy, "bypass");
  const back = reduce(moved, { type: "task.set-model", engine: "claude", model: "opus" }).state;
  assert.equal(back.draftPolicy, "allow-edits", "moving back keeps a mode the engine also offers");
});

test("a thread on OpenCode starts on its model, the effort it takes, and a mode it offers, and is titled on its model", () => {
  const read = reduce(workspace({ draftPolicy: "autonomous", draftEffort: "medium" }), { type: "engine.status", status }).state;
  const picked = run(reduce(read, { type: "task.set-model", engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }).state, [{ type: "view.set-prompt", prompt: "Fix the flaky test" }]);
  const started = send({ ...picked, draftPolicy: "autonomous" }, projectless);
  const command = effectAt(started, "start-run").command;
  assert.equal(command.engine, "opencode");
  assert.equal(command.model, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(command.effort, "low", "medium drops to the nearest depth the model offers");
  assert.equal(command.policy, "allow-edits");
  assert.equal(started.state.threads[0]?.executionPolicy, "allow-edits");
  assert.deepEqual(started.effects.find((effect) => effect.type === "suggest-title"), { type: "suggest-title", taskId: started.state.threads[0]!.id, engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash", text: "Fix the flaky test", attachments: [] });
});

test("a reviewer on OpenCode runs on Bypass, since a mode that asks for each look would stall its round", () => {
  const read = reduce(workspace({ draftPolicy: "autonomous" }), { type: "engine.status", status }).state;
  const picked = reduce(read, { type: "task.set-model", engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }).state;
  const sending = reduce(picked, { type: "task.send", text: "Review the diff", attachments: [], role: "reviewer" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: projectless });
  assert.equal(started.state.threads[0]?.executionPolicy, "bypass");
  assert.equal(effectAt(started, "start-run").command.policy, "bypass");
});

test("a stored OpenCode thread on Auto runs on Edits, and its view shows the model by name once main has named it", () => {
  const thread = task("task-a", { engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash", executionPolicy: "autonomous", messages: [{ id: "m", kind: "user", text: "hi", at: 1 }] });
  const state = reduce(workspace({ threads: [thread], currentId: "task-a" }), { type: "engine.status", status }).state;
  const view = deriveView(state);
  assert.equal(view.engine, "opencode");
  assert.equal(view.engineLabel, "OpenCode");
  assert.equal(modelLabel(view.models, "opencode", "openrouter/z-ai/glm-5.3-flash"), "GLM-5.3-Flash");
  const sent = reduce(state, { type: "task.send", taskId: "task-a", text: "Carry on" });
  const resolved = reduce(sent.state, { type: "run.resolved", pendingId: effectAt(sent, "resolve-run-workspace").pendingId, workspace: projectless });
  assert.equal(effectAt(resolved, "start-run").command.policy, "allow-edits");
});

test("an agent can start a thread on an engine by name, which means that engine's default model", () => {
  const caller = task("caller", { model: "opus" });
  const state = reduce(workspace({ threads: [caller] }), { type: "engine.status", status }).state;
  const named = newThreadSend(state, caller, { type: "task.send", text: "Review this", model: "opencode" });
  assert.ok("command" in named && named.command);
  assert.equal(named.command.model, "openrouter/z-ai/glm-5.3-flash");
  const direct = newThreadSend(state, caller, { type: "task.send", text: "Review this", model: "opencode-go/glm-5.3", effort: "high" });
  assert.ok("error" in direct, "a model that reasons at one depth takes no effort");
  const empty = newThreadSend(workspace({ threads: [caller] }), caller, { type: "task.send", text: "Review this", model: "opencode" });
  assert.deepEqual(empty, { error: "OpenCode has no models to start a thread on. Connect a provider first." }, "never a thread on another engine's model");
  const codex = newThreadSend(state, caller, { type: "task.send", text: "Review this", model: "codex" });
  assert.ok("command" in codex && codex.command);
  assert.equal(codex.command.model, "gpt-6.1-sol");
});

test("OpenCode's tool calls read as the app's own rows do", () => {
  assert.deepEqual(describeToolCall("opencode", "shell", JSON.stringify({ command: "npm test" })), { family: "shell", label: "shell", sigil: "$", argument: "npm test" });
  assert.deepEqual(describeToolCall("opencode", "write", JSON.stringify({ path: "/repo/src/app/main.ts", content: "x" })), { family: "write", label: "write", argument: "…/app/main.ts" });
  assert.deepEqual(describeToolCall("opencode", "read", JSON.stringify({ filePath: "/repo/src/index.ts" })), { family: "read", label: "read", argument: "…/src/index.ts" });
  assert.deepEqual(describeToolCall("opencode", "grep", JSON.stringify({ pattern: "TODO", path: "/repo/src" })), { family: "search", label: "grep", argument: "TODO in /repo/src" });
  assert.deepEqual(describeToolCall("opencode", "browser_open", JSON.stringify({ url: "https://example.com" })), { family: "web", label: "Open page", verb: true, argument: "https://example.com" });
});

const glm = (id: string, label: string, provider: string): ModelSpec => ({ id, label, description: id, provider, contextWindow: 1, efforts: [] });
const glms = engineCatalog({ opencode: { access: "ready", catalog: [glm("openrouter/z-ai/glm-5.3-flash", "GLM-5.3-Flash", "OpenRouter"), glm("opencode-go/glm-5.3-flash", "GLM-5.3-Flash", "OpenCode Go"), glm("opencode/glm-5.3-flash-free", "GLM-5.3-Flash Free", "OpenCode"), glm("openrouter/qwen/qwen-4", "Qwen 4", "OpenRouter")] } });

test("a model named as people say it resolves to the one model it can mean, and to the pinned one where several can", () => {
  assert.deepEqual(resolveModel(glms, "opencode-go/glm-5.3-flash", []), { engine: "opencode", model: "opencode-go/glm-5.3-flash" }, "an id is itself");
  assert.deepEqual(resolveModel(glms, "qwen-4", []), { engine: "opencode", model: "openrouter/qwen/qwen-4" });
  assert.deepEqual(resolveModel(glms, "Qwen 4", []), { engine: "opencode", model: "openrouter/qwen/qwen-4" }, "a label reads the same with spaces and capitals");
  assert.deepEqual(resolveModel(glms, "glm-5.3-flash", [{ engine: "opencode", model: "opencode-go/glm-5.3-flash" }]), { engine: "opencode", model: "opencode-go/glm-5.3-flash" });
  assert.deepEqual(resolveModel(glms, "GLM 5.3 Flash", [{ engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }, { engine: "claude", model: "opus" }]), { engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" });
  assert.deepEqual(resolveModel(glms, "glm-5.3-flash", []), { error: "glm-5.3-flash could mean openrouter/z-ai/glm-5.3-flash, opencode-go/glm-5.3-flash. Name one of them, or pin the one you mean in the model picker." }, "never a guess between providers");
  assert.deepEqual(resolveModel(glms, "glm-5.3-flash", [{ engine: "opencode", model: "openrouter/z-ai/glm-5.3-flash" }, { engine: "opencode", model: "opencode-go/glm-5.3-flash" }]), { error: "glm-5.3-flash could mean openrouter/z-ai/glm-5.3-flash, opencode-go/glm-5.3-flash. Name one of them, or pin the one you mean in the model picker." }, "two pinned are still two");
  assert.deepEqual(resolveModel(glms, "glm-5.3-flash-free", []), { engine: "opencode", model: "opencode/glm-5.3-flash-free" }, "the free one is only the free one");
  assert.deepEqual(resolveModel(glms, "glm", []), { error: "No engine here offers the glm model. Pick another model." }, "a part of a name is not a name");
  assert.deepEqual(resolveModel(glms, "---", []), { error: "No engine here offers the --- model. Pick another model." });
  assert.deepEqual(resolveModel(glms, "Sol", []), { engine: "codex", model: "gpt-6.1-sol" }, "built-in models answer to their labels too");
});

test("an agent starting a thread by a model's name gets the model the user pinned, or is told which it could mean", () => {
  const caller = task("caller", { model: "opus" });
  const status: EngineStatus = { opencode: { access: "ready", catalog: [...glms.models.opencode] } };
  const read = reduce(workspace({ threads: [caller] }), { type: "engine.status", status }).state;
  const pinned = newThreadSend({ ...read, favoriteModels: [{ engine: "opencode" as const, model: "opencode-go/glm-5.3-flash" }] }, caller, { type: "task.send", text: "Review this", model: "glm-5.3-flash", role: "reviewer" });
  assert.ok("command" in pinned && pinned.command);
  assert.equal(pinned.command.model, "opencode-go/glm-5.3-flash");
  const unpinned = newThreadSend(read, caller, { type: "task.send", text: "Review this", model: "glm 5.3 flash" });
  assert.ok("error" in unpinned && /could mean openrouter\/z-ai\/glm-5.3-flash, opencode-go\/glm-5.3-flash/.test(unpinned.error ?? ""));
});

test("a suggestion keeps the model its name meant when suggested, and an engine stays an engine", () => {
  const lead = task("lead", { role: "coordinator", model: "opus" });
  const status: EngineStatus = { opencode: { access: "ready", catalog: [...glms.models.opencode] } };
  const state = { ...reduce(workspace({ threads: [lead] }), { type: "engine.status", status }).state, favoriteModels: [{ engine: "opencode" as const, model: "opencode-go/glm-5.3-flash" }] };
  const brief = { intent: "review it", doneWhen: "approved", delivers: "report" as const };
  const named = threadProposal(state, lead, { prompt: "Review it", brief, model: "glm-5.3-flash" }, 1);
  assert.ok("proposal" in named);
  assert.equal(named.proposal.model, "opencode-go/glm-5.3-flash");
  const engine = threadProposal(state, lead, { prompt: "Review it", brief, model: "opencode" }, 1);
  assert.ok("proposal" in engine);
  assert.equal(engine.proposal.model, "opencode");
});
