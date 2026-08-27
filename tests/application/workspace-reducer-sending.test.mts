import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { AgentModel } from "../../src/domain/agent-engine.ts";
import { task, workspace, activeRun, automation, effectAt, required, run, running, queueMessage, send } from "./workspace-reducer-fixtures.mts";

test("a composer send waits for its workspace, then starts the run and clears the draft", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects, [{ type: "resolve-run-workspace", pendingId: Object.keys(sending.state.pendingRuns)[0], picker: false }]);
  assert.equal(sending.state.tasks.length, 0, "no task exists until the workspace resolves");

  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.equal(effect.type, "start-run");
  assert.equal(effect.command.prompt, "Inspect the app");
  assert.equal(effect.command.workspaceId, "projectless");
  assert.equal(started.state.tasks[0].messages[0].text, "Inspect the app");
  assert.equal(started.state.activeRuns[effect.command.taskId].runId, effect.command.runId);
  assert.deepEqual(started.state.prompts, {});
  assert.deepEqual(started.state.pendingRuns, {});
});

test("the chosen effort sticks to the task and rides along with its runs", () => {
  const drafted = run(workspace(), [
    { type: "task.set-effort", effort: "max" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  assert.equal(drafted.draftEffort, "max");

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(effectAt(started, "start-run").command.effort, "max");
  assert.equal(started.state.tasks[0].effort, "max");

  const lowered = reduce(started.state, { type: "task.set-effort", effort: "low" });
  assert.equal(lowered.state.tasks[0].effort, "low");
});

test("a second send is ignored while the first is still resolving", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect" }]);
  const first = reduce(drafted, { type: "task.send", attachments: [] });
  const second = reduce(first.state, { type: "task.send", attachments: [] });

  assert.deepEqual(second.effects, []);
  assert.equal(Object.keys(second.state.pendingRuns).length, 1);
});

test("a run whose folder is never reopened reports why and keeps nothing pending", () => {
  const drafted = run(workspace({ projects: [{ id: "project-1", root: "/project" }] }), [
    { type: "task.new", projectId: "project-1" },
    { type: "view.set-prompt", prompt: "Continue" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const resolution = effectAt(sending, "resolve-run-workspace");
  assert.deepEqual(sending.effects, [{ type: "resolve-run-workspace", pendingId: resolution.pendingId, picker: true, root: "/project" }]);

  const failed = reduce(sending.state, { type: "run.unresolved", pendingId: resolution.pendingId, message: "Choose the same project folder to continue this task." });
  assert.match(required(failed.state.actionError), /Choose the same project folder/);
  assert.deepEqual(failed.state.pendingRuns, {});
});

test("an action error can be dismissed", () => {
  const failed = workspace({ actionError: "That action is not supported." });
  assert.equal(reduce(failed, { type: "view.dismiss-action-error" }).state.actionError, null);
});

test("a message typed during a run is queued rather than starting a second run", () => {
  const queued = reduce(run(running(), [{ type: "view.set-prompt", prompt: "Also run the tests" }]), { type: "task.send", attachments: [] });

  assert.deepEqual(queued.effects, [], "queueing waits for the run instead of resolving a workspace");
  assert.equal(queued.state.queuedMessages["task-a"].length, 1);
  assert.equal(queued.state.queuedMessages["task-a"][0].text, "Also run the tests");
  assert.deepEqual(queued.state.prompts, {}, "the draft clears so the composer is ready for the next one");
  assert.deepEqual(queued.state.pendingRuns, {});
});

test("steering hands a queued message to the run it was queued against, and delivery threads it", () => {
  const queued = queueMessage(running(), "Check the tests too");
  const [message] = queued.queuedMessages["task-a"];
  const steered = reduce(queued, { type: "task.steer-queued", messageId: message.id });

  assert.deepEqual(steered.effects, [{
    type: "send-run-command",
    command: { type: "steer", taskId: "task-a", runId: "run-a", messageId: message.id, prompt: "Check the tests too" },
  }]);
  assert.equal(steered.state.queuedMessages["task-a"][0].steering, true);
  assert.deepEqual(reduce(steered.state, { type: "task.steer-queued", messageId: message.id }).effects, [], "steering twice sends one command");
  assert.deepEqual(reduce(steered.state, { type: "task.drop-queued", messageId: message.id }).state.queuedMessages["task-a"].length, 1, "a steered message can no longer be dropped");

  const delivered = reduce(steered.state, {
    type: "run.event",
    event: { type: "queued.delivered", taskId: "task-a", runId: "run-a", sequence: 1, messageId: message.id },
  });
  assert.deepEqual(delivered.state.queuedMessages, {});
  assert.equal(required(delivered.state.tasks[0]?.messages.at(-1)).text, "Check the tests too");
});

test("command-enter queues the message and steers it in one go", () => {
  const steered = reduce(run(running(), [{ type: "view.set-prompt", prompt: "Stop reading that file" }]), { type: "task.send", attachments: [], steer: true });
  const [message] = steered.state.queuedMessages["task-a"];

  assert.equal(message.steering, true);
  assert.deepEqual(steered.effects, [{
    type: "send-run-command",
    command: { type: "steer", taskId: "task-a", runId: "run-a", messageId: message.id, prompt: "Stop reading that file" },
  }]);
});

test("a finished run drains its queue one message at a time, each getting its own run", () => {
  const queued = queueMessage(queueMessage(running(), "Run the tests"), "Then update the README");

  /** Settles the run the task has going and starts whatever the queue hands on next. */
  const drain = (state: WorkspaceState, runId: string): WorkspaceTransition => {
    const finished = reduce(state, {
      type: "run.event",
      event: { type: "run.status", taskId: "task-a", runId, sequence: 1, status: "succeeded" },
    });
    const [resolve] = finished.effects.filter((effect) => effect.type === "resolve-run-workspace");
    assert.ok(resolve, "the drained queue asks for its workspace the way a send does");
    assert.equal(finished.state.queuedMessages["task-a"].length, 2 - Number(runId !== "run-a"), "a message stays queued until its own run starts");
    return reduce(finished.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  };

  const first = drain(queued, "run-a");
  const firstStart = effectAt(first, "start-run");
  assert.equal(firstStart.command.prompt, "Run the tests", "the second message is not spoken for by the first");
  assert.equal(required(first.state.tasks[0]?.messages.at(-1)).text, "Run the tests");
  assert.deepEqual(first.state.queuedMessages["task-a"].map((message) => message.text), ["Then update the README"], "the rest waits for this run to finish");

  const second = drain(first.state, firstStart.command.runId);
  assert.equal(effectAt(second, "start-run").command.prompt, "Then update the README");
  assert.equal(required(second.state.tasks[0]?.messages.at(-1)).text, "Then update the README");
  assert.deepEqual(second.state.queuedMessages, {});
});

test("stopping a run hands the queue back to the composer instead of speaking for the user", () => {
  const queued = queueMessage(running(), "Run the tests");
  const cancelled = reduce(queued, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "cancelled" },
  });

  assert.deepEqual(cancelled.effects, []);
  assert.deepEqual(cancelled.state.queuedMessages, {});
  assert.equal(cancelled.state.prompts["task-a"], "Run the tests");
  assert.ok(cancelled.state.tasks[0].runEndedAt, "the work the stop cut short knows when it ended");
});

test("dropping a queued message removes only that one", () => {
  const queued = queueMessage(queueMessage(running(), "First"), "Second");
  const [first] = queued.queuedMessages["task-a"];
  const dropped = reduce(queued, { type: "task.drop-queued", messageId: first.id });

  assert.deepEqual(dropped.effects, []);
  assert.deepEqual(dropped.state.queuedMessages["task-a"].map((message) => message.text), ["Second"]);
});

test("a run starting on a task the user is not looking at leaves them where they are", () => {
  const queued = queueMessage(running(), "Run the tests");
  const looking = run(queued, [{ type: "task.select", taskId: "task-b" }]);
  const finished = reduce({ ...looking, tasks: [...looking.tasks, task("task-b")] }, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "succeeded" },
  });
  const [resolve] = finished.effects.filter((effect) => effect.type === "resolve-run-workspace");
  assert.ok(resolve);
  const started = reduce(finished.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(started.state.currentId, "task-b", "the drained queue runs without stealing the view");
  assert.equal(required(started.state.activeRuns["task-a"]).runId, resolve.pendingId ? effectAt(started, "start-run").command.runId : undefined);
});

test("a send with no task yet opens the task it creates", () => {
  const sending = reduce(run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]), { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(started.state.currentId, started.state.tasks[0].id);
});

test("a new thread asks for a name, and the name the user types outlasts the suggestion", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const taskId = started.state.tasks[0].id;

  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [{ type: "suggest-title", taskId, text: "Inspect the app", attachments: [] }]);
  assert.equal(started.state.tasks[0].title, "Inspect the app", "the typed message titles the thread until a suggestion lands");

  const named = reduce(started.state, { type: "title.suggested", taskId, title: "App breakage review" }).state;
  assert.equal(named.tasks[0].title, "App breakage review");
  assert.equal(named.tasks[0].updatedAt, started.state.tasks[0].updatedAt, "renaming is cosmetic and never reorders recents");

  const renamed = reduce(named, { type: "task.rename", taskId, title: "  Nightly audit  " }).state;
  assert.equal(renamed.tasks[0].title, "Nightly audit");

  const late = reduce(renamed, { type: "title.suggested", taskId, title: "Something else" }).state;
  assert.equal(late.tasks[0].title, "Nightly audit");
  assert.equal(reduce(renamed, { type: "task.rename", taskId, title: "   " }).state, renamed, "an empty name leaves the thread alone");
});

test("only a thread the send just created is named, from what the user typed and any screenshots", () => {
  const existing = task("task-a", { title: "Inspect the app" });
  const drafted = run(workspace({ tasks: [existing], currentId: "task-a" }), [{ type: "view.set-prompt", prompt: "Now check the reducer" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(started.effects.some((effect) => effect.type === "suggest-title"), false);

  const attached = reduce(workspace(), { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] });
  const fromImage = reduce(attached.state, { type: "run.resolved", pendingId: effectAt(attached, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(fromImage.state.tasks[0].title, "Screenshot");
  assert.deepEqual(
    fromImage.effects.filter((effect) => effect.type === "suggest-title"),
    [{ type: "suggest-title", taskId: fromImage.state.tasks[0].id, text: "", attachments: ["/tmp/shot.png"] }],
    "a screenshot-only thread is named from the screenshot",
  );
});

test("a model the engine does not offer changes neither the thread nor the draft", () => {
  const state = workspace({ tasks: [task("task-a", { model: "opus" })], currentId: "task-a" });
  const foreign = "gpt" as AgentModel;

  assert.equal(reduce(state, { type: "task.set-model", engine: "claude", model: foreign }).state, state);
  assert.equal(reduce(state, { type: "task.set-model", taskId: "task-a", engine: "claude", model: foreign }).state, state);
});

test("a command that names its task acts on that one, whichever task the user is looking at", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-b") },
  });

  const modelled = reduce(state, { type: "task.set-model", taskId: "task-b", engine: "claude", model: "haiku" });
  assert.equal(modelled.state.tasks[1].model, "haiku");
  assert.equal(modelled.state.tasks[0].model, undefined);
  assert.equal(modelled.state.draftModel, workspace().draftModel, "naming a task leaves the composer's draft alone");
  assert.equal(modelled.state.tasks[1].engine, "claude", "a thread keeps the engine it started on");

  assert.deepEqual(reduce(state, { type: "run.cancel", taskId: "task-b" }).effects, [
    { type: "send-run-command", command: { type: "cancel", taskId: "task-b", runId: "run-b" } },
  ]);
  assert.deepEqual(reduce(state, { type: "run.cancel" }).effects, [], "task-a has no run of its own");
  assert.deepEqual(reduce(state, { type: "automation.delete", taskId: "task-b" }).effects, [{ type: "automation.delete", taskId: "task-b" }]);
});

test("a command naming a task that does not exist changes nothing", () => {
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a" });

  for (const command of [
    { type: "task.set-policy", taskId: "ghost", policy: "autonomous" },
    { type: "task.send", taskId: "ghost", text: "Ship it" },
    { type: "automation.run-now", taskId: "ghost" },
  ] satisfies WorkspaceInput[]) {
    const transition = reduce(state, command);
    assert.equal(transition.state, state, `${command.type} left state alone`);
    assert.deepEqual(transition.effects, []);
  }
});

test("a send that carries its own text starts a thread without touching the draft or the user's place", () => {
  const drafted = run(workspace({ projects: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }] }), [
    { type: "view.set-prompt", prompt: "Half-typed thought" },
  ]);

  const sending = reduce(drafted, { type: "task.send", project: "project-1", text: "Implement item 1" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "workspace-1", kind: "project", root: "/project" } });

  const start = effectAt(started, "start-run");
  assert.equal(start.command.prompt, "Implement item 1");
  assert.equal(started.state.tasks[0].projectId, "project-1");
  assert.equal(started.state.currentId, null, "an agent's send does not move the user");
  assert.equal(started.state.prompts["draft:"], "Half-typed thought", "the composer keeps what the user was typing");
});

test("a thread can be started in another project by name, and a name that matches nothing is refused", () => {
  const state = workspace({ projects: [
    { id: "project-1", root: "/code/app", workspaceId: "workspace-1" },
    { id: "project-2", root: "/code/site", workspaceId: "workspace-2" },
  ] });

  const sending = reduce(state, { type: "task.send", project: "site", text: "Implement item 1" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "workspace-2", kind: "project", root: "/code/site" } });
  assert.equal(started.state.tasks[0].projectId, "project-2");

  const missing = reduce(state, { type: "task.send", project: "nowhere", text: "Implement item 1" });
  assert.deepEqual(missing.effects, []);
  assert.match(required(missing.state.actionError), /No project matches "nowhere". Open projects: app \(\/code\/app\), site \(\/code\/site\)./);
});

test("several sends can start their own threads at once, unlike the composer's one draft", () => {
  let state = workspace();
  const pendingIds: string[] = [];
  for (const text of ["Implement 1", "Implement 2", "Implement 3"]) {
    const sending = reduce(state, { type: "task.send", text });
    state = sending.state;
    pendingIds.push(effectAt(sending, "resolve-run-workspace").pendingId);
  }
  assert.equal(Object.keys(state.pendingRuns).length, 3);

  for (const pendingId of pendingIds) {
    state = reduce(state, { type: "run.resolved", pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;
  }
  assert.deepEqual(state.tasks.map((item) => item.messages[0].text).sort(), ["Implement 1", "Implement 2", "Implement 3"]);
  assert.equal(Object.keys(state.activeRuns).length, 3);
});

test("a send to a running thread queues behind that run rather than the current one", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-b") },
  });

  const queued = reduce(state, { type: "task.send", taskId: "task-b", text: "Also update the README" });
  assert.deepEqual(queued.effects, []);
  assert.equal(queued.state.queuedMessages["task-b"].length, 1);
  assert.equal(queued.state.queuedMessages["task-a"], undefined);

  const steered = reduce(state, { type: "task.send", taskId: "task-b", text: "Stop and read this", steer: true });
  const effect = effectAt(steered, "send-run-command");
  assert.equal(effect.command.type, "steer");
  assert.equal(effect.command.taskId, "task-b");
});

test("a new thread records when it was created", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const [created] = started.state.tasks;
  assert.ok(created?.createdAt !== undefined && created.createdAt > 0);
  assert.ok(created.createdAt <= required(created.messages[0]).at);
});

test("a draft's @handle becomes a link on the way out, and one naming nothing is left as typed", () => {
  const named = task("t-named", {
    title: "Sink the mode choices",
    lastChangeSnapshot: { files: [], capturedAt: 0 },
    createdAt: 0,
    updatedAt: 0,
  });
  const drafted = run(workspace({ tasks: [named] }), [
    { type: "view.set-prompt", prompt: "compare with @sink-the-mode-choices and @nobody" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const sent = "compare with [Sink the mode choices](aicodingtool://thread/t-named) and @nobody";
  assert.equal(effectAt(started, "start-run").command.prompt, sent);
  assert.equal(required(started.state.tasks.find((task) => task.id !== "t-named")).messages[0].text, sent);
});

test("a send that carries its own text is not a draft, so its @ is left alone", () => {
  const sending = reduce(workspace(), { type: "task.send", text: "email me at zhuocheng@gmail.com", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(effectAt(started, "start-run").command.prompt, "email me at zhuocheng@gmail.com");
});
