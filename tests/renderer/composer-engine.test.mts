import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import { deriveView, emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { AgentModel } from "../../src/domain/agent-engine.ts";
import type { Task } from "../../src/domain/task.ts";
import { workspaceActions } from "../../src/renderer/task-workspace/workspace-actions.ts";
import { engineDesktopStub, mobileDesktopStub } from "../support/mobile-desktop.mts";

import { item, mount, query } from "../support/renderer-dom.mts";

const { TaskComposer } = await import("../../src/renderer/components/TaskComposer.tsx");
const { WorkspaceComposer } = await import("../../src/renderer/components/WorkspaceComposer.tsx");
const { ReviewPicker } = await import("../../src/renderer/components/ReviewPicker.tsx");

/** Only what the composer itself reaches for: the command menu's list, and nothing about runs. */
function composerDesktop(): DesktopAPI {
  return {
    ...mobileDesktopStub, ...engineDesktopStub,
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
    commands: async () => ({ status: "available", commands: [] }),
  } as unknown as DesktopAPI;
}

test("a thread that has an engine offers only its models, and says a new thread is how to use the other", async () => {
  window.desktop = composerDesktop();
  const chosen: Array<[string, string]> = [];
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "", folder: "/project", workspaceId: "workspace-1", mode: "confirm",
    engine: "codex", engineLabel: "Codex", engineLocked: true, model: "gpt-5.6-terra", effort: "high", runActive: false,
    onPromptChange() {}, onModeChange() {}, onModelChange: (engine, model) => chosen.push([engine, model]), onEffortChange() {},
    queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
  }));
  await act(async () => {});

  const modelMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[1]);
  assert.equal(query(modelMenu, ".setting-value").textContent, "Terra");
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual([...modelMenu.querySelectorAll(".setting-group-heading")].map((item) => item.textContent), ["Codex"]);
  assert.deepEqual([...modelMenu.querySelectorAll("button.setting-option strong")].map((item) => item.textContent), ["Sol", "Terra"]);
  assert.ok(modelMenu.querySelector(".setting-rule"), "the other engine sits below a rule");
  const locked = query(modelMenu, ".setting-locked");
  assert.equal(locked.textContent, "Start a new thread to use Claude");
  assert.equal(locked.getAttribute("aria-disabled"), "true");
  await act(async () => { locked.click(); });
  assert.equal(chosen.length, 0, "the locked row does nothing");
  await act(async () => { item(modelMenu.querySelectorAll<HTMLButtonElement>("button.setting-option")[0]).click(); });
  assert.deepEqual(chosen, [["codex", "gpt-5.6-sol"]]);
  await view.unmount();
});

test("an engine that is signed out is greyed and inert, and its one sign-in button is what signs in", async () => {
  window.desktop = composerDesktop();
  const chosen: string[] = [];
  const signIns: string[] = [];
  let reads = 0;
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "", folder: "/project", workspaceId: "workspace-1", mode: "confirm",
    engine: "claude", engineLabel: "Claude", engineLocked: false, engineAccess: { claude: "ready", codex: "signed-out" }, model: "opus", effort: "high", runActive: false,
    onPromptChange() {}, onModeChange() {}, onModelChange: (_engine, model) => chosen.push(model), onEffortChange() {}, onEngineRead: () => { reads += 1; }, onSignIn: (engine) => signIns.push(engine),
    queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
  }));
  await act(async () => {});

  const modelMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[1]);
  assert.equal(reads, 0, "nothing is asked until the menu opens");
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(reads, 1, "opening the menu asks which engines can be picked");
  const codex = query(modelMenu, "[role=group][aria-label=Codex]");
  assert.deepEqual([...codex.querySelectorAll(".setting-option")].map((option) => option.getAttribute("aria-disabled")), ["true", "true"]);
  assert.equal(query(codex, ".setting-hint").textContent, "Sign in to use Codex");
  await act(async () => { query<HTMLButtonElement>(codex, ".setting-option").click(); });
  assert.equal(chosen.length, 0, "a greyed model is not chosen");
  assert.equal(signIns.length, 0, "a greyed model does nothing else either");
  await act(async () => { query<HTMLButtonElement>(codex, "button.setting-hint").click(); });
  assert.deepEqual(signIns, ["codex"]);

  await view.render(React.createElement(TaskComposer, {
    prompt: "", folder: "/project", workspaceId: "workspace-1", mode: "confirm",
    engine: "claude", engineLabel: "Claude", engineLocked: false, engineAccess: { claude: "ready", codex: "unavailable" }, model: "opus", effort: "high", runActive: false,
    onPromptChange() {}, onModeChange() {}, onModelChange: (_engine, model) => chosen.push(model), onEffortChange() {}, onSignIn: (engine) => signIns.push(engine),
    queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
  }));
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const missing = query(modelMenu, "[role=group][aria-label=Codex]");
  assert.equal(query(missing, ".setting-hint").textContent, "Codex is not installed");
  await act(async () => { query<HTMLButtonElement>(missing, ".setting-option").click(); });
  assert.deepEqual(signIns, ["codex"], "an engine that is not there offers no sign-in");
  await view.unmount();
});

test("a thread that has its engine asks nothing when its model menu opens", async () => {
  window.desktop = composerDesktop();
  let reads = 0;
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "", folder: "/project", workspaceId: "workspace-1", mode: "confirm",
    engine: "claude", engineLabel: "Claude", engineLocked: true, model: "opus", effort: "high", runActive: false,
    onPromptChange() {}, onModeChange() {}, onModelChange() {}, onEffortChange() {}, onEngineRead: () => { reads += 1; },
    queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
  }));
  await act(async () => {});
  const modelMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[1]);
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(reads, 0, "only a menu that offers another engine needs to know about it");
  await view.unmount();
});

test("an idle Sol thread offers compact as an app slash command", async () => {
  window.desktop = composerDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const render = (model: AgentModel) => {
    const currentTask: Task = {
      id: "task-1", title: "Sol thread", engine: "codex", model, executionPolicy: "confirm",
      messages: [], continuation: { provider: "codex", value: "thread-1" }, continuationStatus: "available",
      contextUsage: { tokens: 125_000, limit: 272_000, model }, lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    };
    const view = deriveView({ ...emptyWorkspaceState(), tasks: [currentTask], currentId: currentTask.id });
    return React.createElement(WorkspaceComposer, {
      workspace: { ...view, prompt: "/c", threadHandles: [], threadHandlesFor: () => [], dispatch, actions: workspaceActions(dispatch) } as never,
      actions: [],
    });
  };
  const view = await mount(render("gpt-5.6-sol"));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/compact"]);
  assert.equal(query(view.container, ".command-source").textContent, "AI Coding Tool");
  await act(async () => { query<HTMLButtonElement>(view.container, '[role="option"]').click(); });
  assert.deepEqual(dispatched.slice(-2), [{ type: "view.set-prompt", prompt: "" }, { type: "run.compact" }]);

  await view.render(render("gpt-5.6-terra"));
  assert.equal(view.container.querySelector('[role="option"]'), null, "Terra does not inherit the Sol-specific command");
  await view.unmount();
});

test("an idle Codex project thread opens review options from the slash menu", async () => {
  window.desktop = composerDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const currentTask: Task = {
    id: "task-1", title: "Codex thread", projectId: "project-1", engine: "codex", model: "gpt-5.6-terra", executionPolicy: "confirm",
    messages: [], continuation: { provider: "codex", value: "thread-1" }, continuationStatus: "available",
    lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  const derived = deriveView({
    ...emptyWorkspaceState(),
    projects: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }],
    tasks: [currentTask], currentId: currentTask.id,
  });
  assert.equal(derived.workspaceId, "workspace-1");
  const view = await mount(React.createElement(WorkspaceComposer, {
    workspace: { ...derived, prompt: "/r", threadHandles: [], threadHandlesFor: () => [], dispatch, actions: workspaceActions(dispatch) } as never,
    actions: [],
  }));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new Event("select", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/review"]);
  await act(async () => { query<HTMLButtonElement>(view.container, '[role="option"]').click(); });
  assert.deepEqual(dispatched.slice(-2), [{ type: "view.set-prompt", prompt: "" }, { type: "review.open" }]);
  await view.unmount();
});

test("the review picker mirrors Codex's four target choices", async () => {
  const steps: string[] = [];
  const targets: unknown[] = [];
  const view = await mount(React.createElement(ReviewPicker, {
    picker: { taskId: "task-1", step: "targets" },
    workspaceId: "workspace-1",
    returnFocus: { current: null },
    onStep: (step: string) => steps.push(step),
    onReview: (target: unknown) => targets.push(target),
    onClose() {},
  }));
  const options = [...view.container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  assert.deepEqual(options.map((option) => query(option, "strong").textContent), [
    "Review against a base branch",
    "Review uncommitted changes",
    "Review a commit",
    "Custom review instructions",
  ]);
  await act(async () => { options[0].click(); });
  assert.deepEqual(steps, ["base"]);
  await act(async () => { options[1].click(); });
  assert.deepEqual(targets, [{ type: "uncommittedChanges" }]);
  await view.unmount();
});
