import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { AgentModel } from "../../src/domain/agent-engine.ts";
import { task, workspace, activeRun, automation, effectAt, required, run, running, queueMessage, send } from "./workspace-reducer-fixtures.mts";

test("a composer send waits for its workspace, then starts the run and clears the draft", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects, [{ type: "resolve-run-workspace", pendingId: Object.keys(sending.state.pendingRuns)[0], picker: false }]);
  assert.equal(sending.state.threads.length, 0, "no task exists until the workspace resolves");

  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.equal(effect.type, "start-run");
  assert.equal(effect.command.prompt, "Inspect the app");
  assert.equal(effect.command.workspaceId, "projectless");
  assert.equal(started.state.threads[0].messages[0].text, "Inspect the app");
  assert.equal(started.state.activeRuns[effect.command.taskId].runId, effect.command.runId);
  assert.deepEqual(started.state.prompts, {});
  assert.deepEqual(started.state.pendingRuns, {});
});

test("the chosen effort sticks to the task and rides along with its runs", () => {
  const drafted = run(workspace(), [
    { type: "task.set-effort", engine: "claude", effort: "max" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  assert.equal(drafted.draftEffort, "max");

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(effectAt(started, "start-run").command.effort, "max");
  assert.equal(started.state.threads[0].effort, "max");

  const lowered = reduce(started.state, { type: "task.set-effort", engine: "claude", effort: "low" });
  assert.equal(lowered.state.threads[0].effort, "low");
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
  assert.equal(required(delivered.state.threads[0]?.messages.at(-1)).text, "Check the tests too");
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
  assert.equal(required(first.state.threads[0]?.messages.at(-1)).text, "Run the tests");
  assert.deepEqual(first.state.queuedMessages["task-a"].map((message) => message.text), ["Then update the README"], "the rest waits for this run to finish");

  const second = drain(first.state, firstStart.command.runId);
  assert.equal(effectAt(second, "start-run").command.prompt, "Then update the README");
  assert.equal(required(second.state.threads[0]?.messages.at(-1)).text, "Then update the README");
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
  assert.ok(cancelled.state.threads[0].runEndedAt, "the work the stop cut short knows when it ended");
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
  const finished = reduce({ ...looking, threads: [...looking.threads, task("task-b")] }, {
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

  assert.equal(started.state.currentId, started.state.threads[0].id);
});

test("a new thread asks for a name, and the name the user types outlasts the suggestion", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const taskId = started.state.threads[0].id;

  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [{ type: "suggest-title", taskId, engine: "claude", text: "Inspect the app", attachments: [] }]);
  assert.equal(started.state.threads[0].title, "Inspect the app", "the typed message titles the thread until a suggestion lands");

  const named = reduce(started.state, { type: "title.suggested", taskId, title: "App breakage review" }).state;
  assert.equal(named.threads[0].title, "App breakage review");
  assert.equal(named.threads[0].updatedAt, started.state.threads[0].updatedAt, "renaming is cosmetic and never reorders recents");

  const renamed = reduce(named, { type: "task.rename", taskId, title: "  Nightly audit  " }).state;
  assert.equal(renamed.threads[0].title, "Nightly audit");

  const late = reduce(renamed, { type: "title.suggested", taskId, title: "Something else" }).state;
  assert.equal(late.threads[0].title, "Nightly audit");
  assert.equal(reduce(renamed, { type: "task.rename", taskId, title: "   " }).state, renamed, "an empty name leaves the thread alone");
});

test("only a thread the send just created is named, from what the user typed and any screenshots", () => {
  const existing = task("task-a", { title: "Inspect the app" });
  const drafted = run(workspace({ threads: [existing], currentId: "task-a" }), [{ type: "view.set-prompt", prompt: "Now check the reducer" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(started.effects.some((effect) => effect.type === "suggest-title"), false);

  const attached = reduce(workspace(), { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] });
  const fromImage = reduce(attached.state, { type: "run.resolved", pendingId: effectAt(attached, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(fromImage.state.threads[0].title, "Screenshot");
  assert.deepEqual(
    fromImage.effects.filter((effect) => effect.type === "suggest-title"),
    [{ type: "suggest-title", taskId: fromImage.state.threads[0].id, engine: "claude", text: "", attachments: ["/tmp/shot.png"] }],
    "a screenshot-only thread is named from the screenshot",
  );
});

test("choosing another engine's model moves the draft onto that engine, but never a thread that has a message", () => {
  const drafted = reduce(workspace({ draftEngine: "codex", draftModel: "gpt-5.6-sol", draftEffort: "ultra" }), { type: "task.set-model", engine: "claude", model: "sonnet" }).state;
  assert.equal(drafted.draftEngine, "claude");
  assert.equal(drafted.draftModel, "sonnet");
  assert.equal(drafted.draftEffort, "max", "an effort the new model lacks drops to the nearest one below");
  assert.equal(reduce(workspace({ draftEffort: "low" }), { type: "task.set-model", engine: "codex", model: "gpt-5.6-sol" }).state.draftEffort, "low", "an effort both models offer stays");
  assert.equal(deriveView(drafted).engineLocked, false, "a draft may still choose either engine");

  const thread = task("task-a", { model: "opus", messages: [{ id: "m1", kind: "user", text: "Have a look", at: 5 }] });
  const state = workspace({ threads: [thread], currentId: "task-a" });
  assert.equal(deriveView(state).engineLocked, true);
  const held = reduce(state, { type: "task.set-model", engine: "codex", model: "gpt-5.6-sol" }).state;
  assert.equal(held, state, "a thread keeps the engine its first message went to");
  assert.equal(held.threads[0].engine, "claude");
  assert.equal(held.draftEngine, "claude", "nor does the draft move behind the thread's back");
});

test("a send is refused with the command that fixes it when the engine is missing or too old", () => {
  const missing = workspace({
    prompts: { "draft:": "do the thing" },
    engineStatus: { claude: { access: "missing", fix: "curl -fsSL https://claude.ai/install.sh | bash" } },
  });
  const refused = reduce(missing, { type: "task.send", attachments: [] });
  assert.equal(required(refused.state.actionError), "Claude is not installed. Run `curl -fsSL https://claude.ai/install.sh | bash` to fix it.");
  assert.equal(refused.state.actionErrorPage, "engines", "the error carries the settings page that clears it");
  assert.deepEqual(refused.effects, [{ type: "engine.read", refresh: true }], "nothing is started, and the engine is read again in case the user has just fixed it");
  assert.equal(refused.state.prompts["draft:"], "do the thing", "the draft is kept, so the message is not lost");

  const old = workspace({
    prompts: { "draft:": "do the thing" },
    draftEngine: "codex",
    engineStatus: { codex: { access: "outdated", version: "0.147.0", required: "0.150.1", fix: "brew update && brew upgrade --cask codex" } },
  });
  assert.equal(
    required(reduce(old, { type: "task.send", attachments: [] }).state.actionError),
    "Codex 0.147.0 is too old. This app needs 0.150.1. Run `brew update && brew upgrade --cask codex` to fix it.",
  );
});

test("an engine's access comes from main, and only a signed-out engine can be signed in to", () => {
  const state = workspace();
  assert.deepEqual(deriveView(state).engineAccess, { claude: { access: "ready" }, codex: { access: "ready" } }, "every engine is ready until main says otherwise");
  assert.deepEqual(reduce(state, { type: "engine.sign-in", engine: "codex" }).effects, [], "a ready engine has nothing to sign in to");

  const signedOut = reduce(state, { type: "engine.status", status: { codex: { access: "signed-out" } } }).state;
  assert.deepEqual(deriveView(signedOut).engineAccess, { claude: { access: "ready" }, codex: { access: "signed-out" } });
  assert.deepEqual(reduce(signedOut, { type: "engine.sign-in", engine: "codex" }).effects, [{ type: "engine.sign-in", engine: "codex" }]);
  assert.deepEqual(reduce(signedOut, { type: "engine.sign-in", engine: "claude" }).effects, []);

  const missing = reduce(signedOut, { type: "engine.status", status: { codex: { access: "unavailable" } } }).state;
  assert.deepEqual(reduce(missing, { type: "engine.sign-in", engine: "codex" }).effects, [], "an engine that is not there cannot be signed in to");
});

test("engine access is asked of main once while every engine is fine, and again while one is not", () => {
  const state = workspace();
  const asked = reduce(state, { type: "engine.read" });
  assert.deepEqual(asked.effects, [{ type: "engine.read" }]);
  assert.equal(asked.state.engineChecking, true);
  assert.deepEqual(reduce(asked.state, { type: "engine.read" }).effects, [], "a second ask while the first is out asks nothing");
  assert.deepEqual(deriveView(asked.state).engineAccess, { claude: { access: "ready" }, codex: { access: "ready" } }, "every engine is ready until main answers");

  const answered = reduce(asked.state, { type: "engine.status", status: { codex: { access: "signed-out" } } }).state;
  assert.equal(answered.engineChecking, false);
  assert.deepEqual(reduce(answered, { type: "engine.read" }).effects, [], "an engine that only wants signing in to is not asked about again");
  assert.deepEqual(deriveView(answered).engineAccess, { claude: { access: "ready" }, codex: { access: "signed-out" } });

  const behind = reduce(asked.state, { type: "engine.status", status: { codex: { access: "missing", fix: "brew install --cask codex" } } }).state;
  assert.deepEqual(reduce(behind, { type: "engine.read" }).effects, [{ type: "engine.read", refresh: true }], "an engine the user has to fix is read again on every ask");
  assert.deepEqual(reduce(answered, { type: "engine.read", refresh: true }).effects, [{ type: "engine.read", refresh: true }], "and asking outright always asks");
});

test("an answer that clears the engine clears the error the refused send left behind", () => {
  const missing = workspace({
    prompts: { "draft:": "do the thing" },
    engineStatus: { claude: { access: "missing", fix: "curl -fsSL https://claude.ai/install.sh | bash" } },
  });
  const refused = reduce(missing, { type: "task.send", attachments: [] }).state;

  const stillMissing = reduce(refused, { type: "engine.status", status: { claude: { access: "missing" } } }).state;
  assert.equal(stillMissing.actionError, refused.actionError, "an answer that changes nothing leaves the error where it is");

  const installed = reduce(refused, { type: "engine.status", status: { claude: { access: "ready", version: "2.1.250" } } }).state;
  assert.equal(installed.actionError, null);
  assert.equal(installed.actionErrorPage, null);
});

test("an ask that main could not answer says so and leaves nothing waiting", () => {
  const asked = reduce(workspace(), { type: "engine.read" }).state;
  const failed = reduce(asked, { type: "engine.failed", message: "Engine check failed." }).state;
  assert.equal(failed.engineChecking, false);
  assert.equal(failed.actionError, "Engine check failed.");
  assert.deepEqual(reduce(failed, { type: "engine.read", refresh: true }).effects, [{ type: "engine.read", refresh: true }], "and the next ask is free to go out");
});

test("a model the engine does not offer changes neither the thread nor the draft", () => {
  const state = workspace({ threads: [task("task-a", { model: "opus" })], currentId: "task-a" });
  const foreign = "gpt" as AgentModel;

  assert.equal(reduce(state, { type: "task.set-model", engine: "claude", model: foreign }).state, state);
  assert.equal(reduce(state, { type: "task.set-model", taskId: "task-a", engine: "claude", model: foreign }).state, state);
});

test("an effort the engine does not offer changes neither the thread nor the draft", () => {
  const state = workspace({ threads: [task("task-a", { effort: "high" })], currentId: "task-a" });

  assert.equal(reduce(state, { type: "task.set-effort", engine: "claude", effort: "ultra" }).state, state);
  assert.equal(reduce(state, { type: "task.set-effort", taskId: "task-a", engine: "codex", effort: "ultra" }).state, state, "a Claude thread cannot borrow a Codex effort");

  const draft = workspace();
  assert.equal(draft.draftEngine, "claude");
  assert.equal(reduce(draft, { type: "task.set-effort", engine: "codex", effort: "ultra" }).state, draft, "a Claude draft cannot borrow a Codex effort either");
  assert.equal(reduce(draft, { type: "task.set-effort", engine: "codex", effort: "low" }).state.draftEffort, "low", "an effort both engines offer lands on the draft");

  const codexThread = workspace({ threads: [task("task-c", { engine: "codex", model: "gpt-5.6-sol", effort: "high" })], currentId: "task-c" });
  const raised = reduce(codexThread, { type: "task.set-effort", engine: "codex", effort: "ultra" }).state;
  assert.equal(raised.threads[0].effort, "ultra");
  assert.equal(raised.draftEffort, codexThread.draftEffort, "the Claude draft keeps its own effort");
});

test("a command that names its task acts on that one, whichever task the user is looking at", () => {
  const state = workspace({
    threads: [task("task-a"), task("task-b")],
    currentId: "task-a",
    activeRuns: { "task-b": activeRun("task-b", "run-b") },
  });

  const modelled = reduce(state, { type: "task.set-model", taskId: "task-b", engine: "claude", model: "haiku" });
  assert.equal(modelled.state.threads[1].model, "haiku");
  assert.equal(modelled.state.threads[0].model, undefined);
  assert.equal(modelled.state.draftModel, workspace().draftModel, "naming a task leaves the composer's draft alone");
  assert.equal(modelled.state.threads[1].engine, "claude", "a thread keeps the engine it started on");

  assert.deepEqual(reduce(state, { type: "run.cancel", taskId: "task-b" }).effects, [
    { type: "send-run-command", command: { type: "cancel", taskId: "task-b", runId: "run-b" } },
  ]);
  assert.deepEqual(reduce(state, { type: "run.cancel" }).effects, [], "task-a has no run of its own");
  assert.deepEqual(reduce(state, { type: "automation.delete", taskId: "task-b" }).effects, [{ type: "automation.delete", taskId: "task-b" }]);
});

test("a command naming a task that does not exist changes nothing", () => {
  const state = workspace({ threads: [task("task-a")], currentId: "task-a" });

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
  assert.equal(started.state.threads[0].projectId, "project-1");
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
  assert.equal(started.state.threads[0].projectId, "project-2");

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
  assert.deepEqual(state.threads.map((item) => item.messages[0].text).sort(), ["Implement 1", "Implement 2", "Implement 3"]);
  assert.equal(Object.keys(state.activeRuns).length, 3);
});

test("a send to a running thread queues behind that run rather than the current one", () => {
  const state = workspace({
    threads: [task("task-a"), task("task-b")],
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

  const [created] = started.state.threads;
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
  const drafted = run(workspace({ threads: [named] }), [
    { type: "view.set-prompt", prompt: "compare with @sink-the-mode-choices and @nobody" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const sent = "compare with [Sink the mode choices](aicodingtool://thread/t-named) and @nobody";
  assert.equal(effectAt(started, "start-run").command.prompt, sent);
  assert.equal(required(started.state.threads.find((task) => task.id !== "t-named")).messages[0].text, sent);
});

test("a send that carries its own text is not a draft, so its @ is left alone", () => {
  const sending = reduce(workspace(), { type: "task.send", text: "email me at zhuocheng@gmail.com", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(effectAt(started, "start-run").command.prompt, "email me at zhuocheng@gmail.com");
});
