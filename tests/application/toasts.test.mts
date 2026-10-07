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
  assert.ok(effect.type === "schedule-toast-dismissal" && effect.at - Date.now() <= TOAST_LIFETIME_MS);

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

test("the launch's first look at the engines updates every one behind the app, one at a time, saying how each went", () => {
  const reading = reduce(workspace(), { type: "engine.read" }).state;
  const found = reduce(reading, { type: "engine.status", status: BEHIND });
  assert.deepEqual(found.state.engineAutoUpdates, ["claude", "codex"]);
  assert.equal(found.state.engineUpdating, "claude");
  assert.deepEqual(found.effects[0], { type: "engine.update", engine: "claude" });
  assert.deepEqual(found.state.toasts.map(({ tone, title, message }) => ({ tone, title, message })), [
    { tone: "progress", title: "Updating Claude", message: "Claude 2.1.0 is behind 2.1.250." },
  ]);

  const again = reduce(found.state, { type: "engine.status", status: BEHIND });
  assert.deepEqual(again.effects, [], "a later read starts nothing; only the launch's first one does");

  const claudeDone = reduce(found.state, { type: "engine.updated", engine: "claude", status: { ...BEHIND, claude: { access: "ready", version: "2.1.260" } } });
  assert.deepEqual(claudeDone.state.engineAutoUpdates, ["codex"]);
  assert.equal(claudeDone.state.engineUpdating, "codex");
  assert.deepEqual(claudeDone.effects.find((effect) => effect.type === "engine.update"), { type: "engine.update", engine: "codex" });
  assert.deepEqual(claudeDone.state.toasts.map(({ id, tone, title, message }) => ({ id, tone, title, message })), [
    { id: 1, tone: "success", title: "Claude updated", message: "Now on 2.1.260." },
    { id: 2, tone: "progress", title: "Updating Codex", message: "Codex 0.147.0 is behind 0.150.1." },
  ], "the result takes the place of its progress, and comes before the next update starts");
  assert.deepEqual(claudeDone.effects.filter((effect) => effect.type === "schedule-toast-dismissal").map((effect) => effect.type === "schedule-toast-dismissal" && effect.id), [1, 2], "the replaced toast gets its full time again");

  const codexFailed = reduce(claudeDone.state, { type: "engine.update-failed", engine: "codex", message: "EACCES. Run `npm install -g @openai/codex@latest` in your terminal." });
  assert.deepEqual(codexFailed.state.engineAutoUpdates, []);
  assert.equal(codexFailed.state.engineUpdating, null);
  assert.equal(codexFailed.state.actionError, null, "a failure the app ran into on its own is told in the toast alone");
  assert.deepEqual(codexFailed.state.toasts.at(-1), { id: 2, tone: "error", title: "Couldn't update Codex", message: "EACCES. Run `npm install -g @openai/codex@latest` in your terminal.", subject: "codex" });

  const expired = reduce(claudeDone.state, { type: "view.dismiss-toast", id: 2 }).state;
  const failedLater = reduce(expired, { type: "engine.update-failed", engine: "codex", message: "EACCES." });
  assert.deepEqual(failedLater.state.toasts.map((toast) => [toast.id, toast.title]), [[1, "Claude updated"], [3, "Couldn't update Codex"]], "a progress toast that already left is not waited for");
});

test("an update that finishes still behind the app says so, and an engine fixed meanwhile is passed over", () => {
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: BEHIND }).state;
  const stale = reduce(found, { type: "engine.updated", engine: "claude", status: { ...BEHIND, codex: { access: "ready", version: "0.150.1" } } });
  assert.deepEqual(stale.state.toasts, [{ id: 1, tone: "error", title: "Couldn't update Claude", message: "Claude 2.1.0 is still behind 2.1.250. Run `claude update` in your terminal.", subject: "claude" }]);
  assert.deepEqual(stale.state.engineAutoUpdates, [], "codex caught up by itself, so it is not updated");
  assert.equal(stale.state.engineUpdating, null);
});

test("an up-to-date launch updates nothing", () => {
  const found = reduce(reduce(workspace(), { type: "engine.read" }).state, { type: "engine.status", status: { claude: { access: "ready", version: "2.1.260" }, codex: { access: "missing", fix: "brew install --cask codex" } } });
  assert.deepEqual(found.state.engineAutoUpdates, []);
  assert.deepEqual(found.effects, []);
  assert.deepEqual(found.state.toasts, [], "an engine that is not installed is the user's to install");
});
