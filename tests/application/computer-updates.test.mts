import assert from "node:assert/strict";
import { test } from "vitest";
import { NO_UPDATE_TO_INSTALL } from "../../src/application/app-updates.ts";
import { computerUpkeep } from "../../src/application/computer-updates.ts";
import { routeInput, type PairedComputer } from "../../src/application/computers.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { COMPUTER_CAPABILITIES, REMOTE_UNSUPPORTED } from "../../src/contracts/computer-capabilities.ts";
import type { ComputerLink } from "../../src/domain/computers.ts";
import { activeRun, effectOf, running, task, workspace } from "./workspace-reducer-fixtures.mts";

function paired(id: string, state: WorkspaceState | null = workspace(), overrides: Partial<ComputerLink> = {}): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, ...overrides, state };
}

function withComputers(computers: PairedComputer[], state = workspace()): WorkspaceState {
  return { ...state, computers: { ...state.computers, name: "omarchy", paired: computers } };
}

const available = { status: "available", version: "0.7.11" } as const;
const ready = { status: "ready", version: "0.7.11" } as const;

test("an update asked of an idle computer downloads without a dialog and installs the moment it is ready", () => {
  const asked = reduce(workspace({ appUpdate: available }), { type: "app.update" });
  assert.deepEqual(asked.state.appUpdateRequest, { status: "waiting" });
  assert.deepEqual(effectOf(asked, "app.download-update"), { type: "app.download-update", unattended: true });

  const downloading = reduce(asked.state, { type: "app.update-changed", update: { status: "downloading", version: "0.7.11", percent: 40 } });
  assert.equal(downloading.effects.some((effect) => effect.type === "app.install-update"), false);

  const downloaded = reduce(downloading.state, { type: "app.update-changed", update: ready });
  assert.deepEqual(effectOf(downloaded, "app.install-update"), { type: "app.install-update", unattended: true });
  assert.deepEqual(downloaded.state.appUpdateRequest, { status: "installing", version: "0.7.11" });
  assert.equal(reduce(downloaded.state, { type: "view.set-focused", focused: true }).effects.some((effect) => effect.type === "app.install-update"), false, "it installs once");
});

test("a downloaded update waits for running threads, and a cancelled one never installs", () => {
  const busy = running("task-a", "run-a", { appUpdate: ready });
  const asked = reduce(busy, { type: "app.update" });
  assert.deepEqual(asked.state.appUpdateRequest, { status: "waiting" });
  assert.equal(asked.effects.some((effect) => effect.type === "app.install-update"), false);

  const idle = { ...asked.state, activeRuns: {}, runStatuses: {} };
  const finished = reduce(idle, { type: "view.set-focused", focused: false });
  assert.deepEqual(effectOf(finished, "app.install-update"), { type: "app.install-update", unattended: true });

  const cancelled = reduce(asked.state, { type: "app.cancel-update" }).state;
  assert.equal(cancelled.appUpdateRequest, null);
  assert.equal(reduce({ ...cancelled, activeRuns: {} }, { type: "view.set-focused", focused: false }).effects.some((effect) => effect.type === "app.install-update"), false);
});

test("a download that falls back to offering the version says it failed, and nothing is asked of a computer with no update", () => {
  const asked = reduce(workspace({ appUpdate: available }), { type: "app.update" }).state;
  const started = reduce(asked, { type: "app.update-changed", update: { status: "downloading", version: "0.7.11", percent: 3 } }).state;
  const failed = reduce(started, { type: "app.update-changed", update: available });
  assert.deepEqual(failed.state.appUpdateRequest, { status: "failed", message: "Couldn't download 0.7.11." });
  assert.equal(failed.effects.some((effect) => effect.type === "app.download-update"), false, "a failure does not loop");

  const none = reduce(workspace(), { type: "app.update" });
  assert.deepEqual(none.result, { ok: false, message: NO_UPDATE_TO_INSTALL });
});

test("the launch an update brought upgrades each engine the new build needs, and only those", () => {
  const launched = reduce(workspace({ engineStatus: {} }), { type: "app.launched", version: "0.7.11" }).state;
  assert.equal(launched.engineUpgradesOwed, true);
  const read = reduce(launched, {
    type: "engine.status",
    status: {
      codex: { access: "outdated", version: "0.160.0", required: "0.162.1", latest: "0.163.0", fix: "npm install -g @openai/codex@latest" },
      claude: { access: "ready", version: "2.1.0", latest: "2.2.0", fix: "claude update" },
    },
  });
  assert.deepEqual(effectOf(read, "engine.update"), { type: "engine.update", engine: "codex" });
  assert.equal(read.effects.filter((effect) => effect.type === "engine.update").length, 1, "a newer release alone is only offered");
  assert.equal(read.state.engineUpgradesOwed, false);

  const ordinary = reduce(workspace({ engineStatus: {} }), { type: "engine.status", status: { codex: { access: "outdated", version: "0.160.0", required: "0.162.1", fix: "npm install -g @openai/codex@latest" } } });
  assert.equal(ordinary.effects.some((effect) => effect.type === "engine.update"), false, "an ordinary launch only offers it");
});

test("a command about a whole computer is carried there as that computer's own", () => {
  const state = withComputers([paired("mac"), paired("old", workspace(), { capabilities: ["command:task.send"] }), paired("away", workspace(), { status: "offline" })]);
  assert.deepEqual(routeInput(state, { type: "app.update", computerId: "mac" }), { kind: "computer", computer: state.computers.paired[0], inputs: [{ type: "app.update" }] });
  assert.deepEqual(routeInput(state, { type: "engine.update", engine: "codex", computerId: "mac" }), { kind: "computer", computer: state.computers.paired[0], inputs: [{ type: "engine.update", engine: "codex" }] });
  assert.deepEqual(routeInput(state, { type: "app.cancel-update", computerId: "old" }), { kind: "refuse", reason: "unsupported", message: REMOTE_UNSUPPORTED });
  assert.equal(routeInput(state, { type: "app.update", computerId: "away" }).kind, "refuse");
  assert.deepEqual(routeInput(state, { type: "app.update" }), { kind: "local" });
  assert.deepEqual(routeInput(state, { type: "engine.update", engine: "codex" }), { kind: "local" });
});

test("a paired computer's row says where its update stands and offers the next step", () => {
  const lines = (remote: Partial<WorkspaceState>, overrides: Partial<ComputerLink> = {}) =>
    computerUpkeep([paired("mac", workspace(remote), overrides)], { version: "0.7.11", selfUpdating: true })[0]!.lines.map(({ text, action }) => [text, action?.label]);

  assert.deepEqual(lines({ appBuild: { version: "0.7.10", selfUpdating: true } }), []);
  assert.deepEqual(lines({ appUpdate: available }), [["0.7.11 is available.", "Update"]]);
  assert.deepEqual(lines({ appUpdate: available, activeRuns: { a: activeRun("a", "r") }, threads: [task("a")] }), [["0.7.11 is available.", "Update when idle"]]);
  assert.deepEqual(lines({ appUpdate: ready, appUpdateRequest: { status: "waiting" }, activeRuns: { a: activeRun("a", "r"), b: activeRun("b", "s") } }), [["Updates to 0.7.11 after 2 running threads finish.", "Cancel"]]);
  assert.deepEqual(lines({ appUpdate: { status: "downloading", version: "0.7.11", percent: 42 }, appUpdateRequest: { status: "waiting" } }), [["Downloading 0.7.11… 42%", undefined]]);
  assert.deepEqual(lines({ appUpdate: available, appUpdateRequest: { status: "failed", message: "Couldn't download 0.7.11." } }), [["Couldn't download 0.7.11.", "Try again"]]);
  assert.deepEqual(lines({ appUpdateRequest: { status: "installing", version: "0.7.11" } }, { status: "connecting" }), [["Restarting into 0.7.11…", undefined]]);
  assert.deepEqual(lines({ appBuild: { version: "0.7.9", selfUpdating: false } }), [["0.7.11 is out. Update it on that computer.", undefined]]);
  assert.deepEqual(lines({}, { capabilities: ["command:task.send"] }), [["Update AI Coding Tool on that computer to manage it from here.", undefined]]);
  assert.deepEqual(lines({ engineStatus: { codex: { access: "outdated", version: "0.160.0", required: "0.162.1", fix: "npm i -g @openai/codex" } } }), [["Codex 0.160.0 is too old. Update to 0.162.1.", "Upgrade"]]);
  assert.deepEqual(lines({ engineStatus: { claude: { access: "ready", version: "2.1.0", latest: "2.2.0", fix: "claude update" } } }), [["Claude 2.2.0 is available.", "Upgrade"]]);
  assert.deepEqual(lines({ engineStatus: { claude: { access: "ready", version: "2.1.0", latest: "2.2.0" } } }), [], "a release the app cannot install there is not worth a line");
  assert.deepEqual(lines({ engineUpdating: "codex" }), [["Updating Codex…", undefined]]);
});

test("the Computers page keeps its rows while nothing it shows has changed", () => {
  let state = withComputers([paired("mac", workspace({ appUpdate: available }))]);
  const before = deriveView(state).computerUpkeep;
  state = reduce(state, { type: "computer.state", id: "mac", state: workspace({ appUpdate: available, prompts: { draft: "typing" } }) }).state;
  assert.equal(deriveView(state).computerUpkeep, before);
});

test("an install that leaves the build no longer ready says it failed and can be tried again", () => {
  const installing = workspace({ appUpdate: ready, appUpdateRequest: { status: "installing", version: "0.7.11" } });
  const failed = reduce(installing, { type: "app.update-changed", update: available });
  assert.deepEqual(failed.state.appUpdateRequest, { status: "failed", message: "Couldn't install 0.7.11." });
  const again = reduce(failed.state, { type: "app.update" });
  assert.deepEqual(again.state.appUpdateRequest, { status: "waiting" });
  assert.deepEqual(effectOf(again, "app.download-update"), { type: "app.download-update", unattended: true });
});

test("a thread waiting out a usage limit does not hold an install, since it resumes after the restart", () => {
  const paused = task("t", { limitPause: { resetsAt: 10, window: "session", pausedAt: 1 } });
  const asked = reduce(workspace({ threads: [paused], appUpdate: ready }), { type: "app.update" });
  assert.deepEqual(effectOf(asked, "app.install-update"), { type: "app.install-update", unattended: true });
});

test("an engine notice on another computer's thread opens that computer's row, not this one's Engines page", () => {
  const remote = workspace({ threads: [task("remote-thread")], currentId: "remote-thread" });
  const state = withComputers([paired("mac", remote)]);
  assert.deepEqual(deriveView(state).engineSettingsPage, { section: "engines", settingId: null });
  const shown = reduce(state, { type: "task.select", taskId: "remote-thread" }).state;
  assert.deepEqual(deriveView(shown).engineSettingsPage, { section: "phone", settingId: "phone.computers" });
});
