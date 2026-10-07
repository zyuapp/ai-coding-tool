import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { MAX_TOASTS, TOAST_LIFETIME_MS } from "../../src/domain/toast.ts";
import type { EngineStatus } from "../../src/domain/agent-engine.ts";
import { run, workspace } from "./workspace-reducer-fixtures.mts";

const BEHIND: EngineStatus = {
  claude: { access: "ready", version: "2.1.0", required: "2.1.250", fix: "claude update" },
  codex: { access: "outdated", version: "0.147.0", required: "0.150.1", fix: "npm install -g @openai/codex@latest" },
};

test("the first launch after an update says so in a toast that leaves on its own", () => {
  const launched = reduce(workspace(), { type: "app.launched", version: "0.8.0" });
  assert.deepEqual(launched.state.toasts, [{ id: 1, tone: "success", title: "AI Coding Tool updated", message: "Now on 0.8.0." }]);
  const [effect] = launched.effects;
  assert.equal(effect.type, "schedule-toast-dismissal");
  assert.equal(effect.type === "schedule-toast-dismissal" && effect.id, 1);
  assert.ok(effect.type === "schedule-toast-dismissal" && effect.at !== null && effect.at - Date.now() <= TOAST_LIFETIME_MS);

  const dismissed = reduce(launched.state, { type: "view.dismiss-toast", id: 1 });
  assert.deepEqual(dismissed.state.toasts, []);
  assert.equal(reduce(dismissed.state, { type: "view.dismiss-toast", id: 1 }).state, dismissed.state, "a toast already gone is left alone");
});

test("the corner holds a few toasts, the newest pushing the oldest out, and a window that mounts restarts their time", () => {
  const state = run(workspace(), Array.from({ length: MAX_TOASTS + 1 }, (_, index) => ({ type: "app.launched" as const, version: `0.${index}.0` })));
  assert.deepEqual(state.toasts.map((toast) => toast.id), [2, 3, 4, 5]);
  const mounted = reduce(state, { type: "view.mounted" });
  assert.deepEqual(mounted.effects.filter((effect) => effect.type === "schedule-toast-dismissal").map((effect) => effect.type === "schedule-toast-dismissal" && effect.id), [2, 3, 4, 5]);
});

test("the launch's first look at the engines offers each update in a card that waits for the user", () => {
  const reading = reduce(workspace(), { type: "engine.read" }).state;
  const found = reduce(reading, { type: "engine.status", status: BEHIND });
  assert.deepEqual(found.effects, [], "nothing is installed until the user asks, and an offer leaves on no timer");
  assert.equal(found.state.engineUpdating, null);
  assert.deepEqual(found.state.toasts, [
    { id: 1, tone: "update", title: "Claude 2.1.250 is available", message: "This app needs 2.1.250 or newer. You have 2.1.0.", subject: "claude", persistent: true, remember: "engine-update:claude@2.1.250", action: { label: "Upgrade", command: { type: "engine.update", engine: "claude" } } },
    { id: 2, tone: "update", title: "Codex 0.150.1 is available", message: "This app needs 0.150.1 or newer. You have 0.147.0.", subject: "codex", persistent: true, remember: "engine-update:codex@0.150.1", action: { label: "Upgrade", command: { type: "engine.update", engine: "codex" } } },
  ]);
  assert.deepEqual(reduce(found.state, { type: "engine.status", status: BEHIND }).state.toasts, found.state.toasts, "a later read offers nothing again");
});

test("an upgrade turns its card into progress, a second one waits its turn, and each result takes its card's place", () => {
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: BEHIND }).state;
  const claude = reduce(found, { type: "engine.update", engine: "claude" });
  assert.deepEqual(claude.effects, [{ type: "engine.update", engine: "claude" }, { type: "schedule-toast-dismissal", id: 1, at: null }]);
  assert.deepEqual(claude.state.toasts[0], { id: 1, tone: "progress", title: "Updating Claude", message: "Moving from 2.1.0 to 2.1.250.", subject: "claude", persistent: true });

  const codex = reduce(claude.state, { type: "engine.update", engine: "codex" });
  assert.deepEqual(codex.effects.filter((effect) => effect.type === "engine.update"), [], "package managers lock, so the second waits");
  assert.deepEqual(codex.state.engineUpdateQueue, ["codex"]);
  assert.equal(codex.state.toasts[1]?.message, "Waiting for Claude to finish.");

  const claudeDone = reduce(codex.state, { type: "engine.updated", engine: "claude", status: { ...BEHIND, claude: { access: "ready", version: "2.1.260" } } });
  assert.equal(claudeDone.state.engineUpdating, "codex");
  assert.deepEqual(claudeDone.state.engineUpdateQueue, []);
  assert.deepEqual(claudeDone.state.toasts.map(({ id, tone, title, message }) => ({ id, tone, title, message })), [
    { id: 1, tone: "success", title: "Claude updated", message: "Now on 2.1.260." },
    { id: 2, tone: "progress", title: "Updating Codex", message: "Moving from 0.147.0 to 0.150.1." },
  ]);
  assert.ok(claudeDone.effects.some((effect) => effect.type === "schedule-toast-dismissal" && effect.id === 1 && effect.at !== null), "a success leaves on its own");
  assert.deepEqual(claudeDone.effects.find((effect) => effect.type === "engine.update"), { type: "engine.update", engine: "codex" });

  const codexFailed = reduce(claudeDone.state, { type: "engine.update-failed", engine: "codex", message: "EACCES. Run `npm install -g @openai/codex@latest` in your terminal." });
  assert.equal(codexFailed.state.engineUpdating, null);
  assert.equal(codexFailed.state.actionError, null, "how it went is told in the toast alone");
  assert.deepEqual(codexFailed.state.toasts.at(-1), { id: 2, tone: "error", title: "Couldn't update Codex", message: "EACCES. Run `npm install -g @openai/codex@latest` in your terminal.", subject: "codex", persistent: true });
});

test("an update that finishes still behind says so and stays up", () => {
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: BEHIND }).state;
  const updating = reduce(found, { type: "engine.update", engine: "claude" }).state;
  const stale = reduce(updating, { type: "engine.updated", engine: "claude", status: BEHIND });
  assert.deepEqual(stale.state.toasts[0], { id: 1, tone: "error", title: "Couldn't update Claude", message: "Claude is still on 2.1.0. Run `claude update` in your terminal.", subject: "claude", persistent: true });
});

test("a closed offer is remembered for that release only, and an install the app cannot upgrade is offered without a button", () => {
  const managed: EngineStatus = { claude: { access: "ready", version: "2.1.291", latest: "2.1.300" }, codex: { access: "ready", version: "0.160.1" } };
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: managed });
  assert.deepEqual(found.state.toasts, [{ id: 1, tone: "update", title: "Claude 2.1.300 is available", message: "You have 2.1.291. Update it the way you installed it.", subject: "claude", persistent: true, remember: "engine-update:claude@2.1.300" }]);

  const closed = reduce(found.state, { type: "view.dismiss-toast", id: 1 });
  assert.deepEqual(closed.state.dismissedToasts, ["engine-update:claude@2.1.300"]);
  assert.deepEqual(closed.effects.map((effect) => effect.type === "persist-preferences" && effect.preferences.dismissedToasts), [["engine-update:claude@2.1.300"]], "it is kept between launches");

  const relaunched = { ...workspace(), dismissedToasts: closed.state.dismissedToasts };
  assert.deepEqual(reduce(relaunched, { type: "engine.status", status: managed }).state.toasts, [], "the same release is not offered again");
  const newer = reduce(relaunched, { type: "engine.status", status: { claude: { ...managed.claude!, latest: "2.1.301" } } });
  assert.equal(newer.state.toasts[0]?.title, "Claude 2.1.301 is available", "the next release is");
});

test("an up-to-date launch offers nothing", () => {
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: { claude: { access: "ready", version: "2.1.260" }, codex: { access: "missing", fix: "brew install --cask codex" } } });
  assert.deepEqual(found.effects, []);
  assert.deepEqual(found.state.toasts, [], "an engine that is not installed is the user's to install");
});
