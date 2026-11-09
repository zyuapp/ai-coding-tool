import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { MAIN_COMPOSER } from "../../src/application/composer-attachments.ts";
import { NEW_THREAD_DRAFT, deriveView, promptKey } from "../../src/application/workspace-state.ts";
import { DICTATION_HEARD_NOTHING, DICTATION_MISSING, withSpokenWords } from "../../src/domain/dictation.ts";
import { effectOf, run, task, workspace } from "./workspace-reducer-fixtures.mts";

const ready = { type: "dictation.model" as const, model: "ready" as const };

function held(state = run(workspace({ threads: [task("a"), task("b")], currentId: "a" }), [ready])) {
  const started = reduce(state, { type: "dictation.start" });
  const id = effectOf(started, "dictation.start")!.id;
  return { state: run(started.state, [{ type: "dictation.started", id }]), id };
}

test("a hold is refused until the speech model is ready, and says how to get it", () => {
  const refused = reduce(run(workspace(), [{ type: "dictation.model", model: "missing" }]), { type: "dictation.start" });
  assert.deepEqual(refused.result, { ok: false, message: DICTATION_MISSING });
  assert.equal(refused.state.dictation.session, null);
  assert.equal(refused.effects.length, 0);
});

test("letting go adds the words after what was typed and hands the caret back, sending nothing", () => {
  const { state, id } = held();
  assert.equal(state.dictation.session?.phase, "recording");
  const typed = reduce(state, { type: "view.set-prompt", prompt: "Look at the diff." }).state;

  const stopped = reduce(typed, { type: "dictation.stop" });
  assert.deepEqual(effectOf(stopped, "dictation.stop"), { type: "dictation.stop", id });
  assert.equal(deriveView(stopped.state).dictation.phase, "transcribing");

  const heard = reduce(stopped.state, { type: "dictation.transcribed", id, text: "Then fix the failing test." });
  assert.equal(heard.state.prompts.a, "Look at the diff. Then fix the failing test.");
  assert.equal(heard.state.dictation.session, null);
  assert.equal(heard.state.composerFocus, typed.composerFocus + 1, "the caret goes back to the draft so Enter sends it");
  assert.equal(heard.effects.some((effect) => effect.type === "start-run" || effect.type === "send-attachments"), false);
});

test("words for a thread left during the hold stay in its draft without taking the caret", () => {
  const { state, id } = held();
  const moved = run(state, [{ type: "dictation.stop" }, { type: "task.select", taskId: "b" }]);
  const heard = reduce(moved, { type: "dictation.transcribed", id, text: "keep me" });

  assert.equal(heard.state.prompts.a, "keep me");
  assert.equal(heard.state.prompts.b, undefined);
  assert.equal(heard.state.composerFocus, moved.composerFocus);
});

test("a hold that heard nothing writes nothing and says so under the composer", () => {
  const { state, id } = held(run(workspace(), [ready]));
  const heard = reduce(run(state, [{ type: "dictation.stop" }]), { type: "dictation.transcribed", id, text: "  " });

  assert.equal(heard.state.prompts[NEW_THREAD_DRAFT], undefined);
  assert.equal(heard.state.attachmentSends[MAIN_COMPOSER]?.error, DICTATION_HEARD_NOTHING);
});

test("cancelling drops the hold, and a late answer for it changes nothing", () => {
  const { state, id } = held();
  const cancelled = reduce(state, { type: "dictation.cancel" });
  assert.deepEqual(effectOf(cancelled, "dictation.cancel"), { type: "dictation.cancel", id });
  assert.equal(cancelled.state.dictation.session, null);

  const late = reduce(cancelled.state, { type: "dictation.transcribed", id, text: "too late" });
  assert.equal(late.state, cancelled.state);
});

test("words that are sent clear what an earlier hold said under the composer", () => {
  const first = held();
  const missed = run(first.state, [{ type: "dictation.stop" }, { type: "dictation.transcribed", id: first.id, text: "" }]);
  assert.equal(missed.attachmentSends[MAIN_COMPOSER]?.error, DICTATION_HEARD_NOTHING);
  const second = held(missed);
  const heard = run(second.state, [{ type: "dictation.stop" }, { type: "dictation.transcribed", id: second.id, text: "now it heard" }]);
  assert.equal(heard.attachmentSends[MAIN_COMPOSER]?.error, null);
});

test("a failed hold ends and shows why", () => {
  const { state, id } = held();
  const failed = reduce(state, { type: "dictation.failed", id, message: "No microphone is available." });
  assert.equal(failed.state.dictation.session, null);
  assert.equal(failed.state.attachmentSends[MAIN_COMPOSER]?.error, "No microphone is available.");
});

test("a second hold while one is going is ignored", () => {
  const { state } = held();
  const again = reduce(state, { type: "dictation.start" });
  assert.equal(again.state, state);
  assert.equal(again.effects.length, 0);
});

test("downloading the model is only offered while it is missing or failed", () => {
  const missing = run(workspace(), [{ type: "dictation.model", model: "missing" }]);
  const downloading = reduce(missing, { type: "dictation.download" });
  assert.equal(downloading.state.dictation.model, "downloading");
  assert.deepEqual(effectOf(downloading, "dictation.download"), { type: "dictation.download" });

  const again = reduce(downloading.state, { type: "dictation.download" });
  assert.equal(again.effects.length, 0);
});

test("cancelling a download stops it and offers the download again", () => {
  const downloading = run(workspace(), [{ type: "dictation.model", model: "missing" }, { type: "dictation.download" }, { type: "dictation.model", model: "downloading", progress: 0.3 }]);
  const cancelled = reduce(downloading, { type: "dictation.cancel-download" });
  assert.deepEqual(effectOf(cancelled, "dictation.cancel-download"), { type: "dictation.cancel-download" });
  assert.equal(cancelled.state.dictation.model, "missing");
  assert.equal(cancelled.state.dictation.progress, null);
  assert.equal(reduce(cancelled.state, { type: "dictation.cancel-download" }).effects.length, 0, "nothing to cancel once it stopped");
});

test("a download shows how much has arrived, then that it is being prepared, then nothing once ready", () => {
  const started = run(workspace(), [{ type: "dictation.model", model: "missing" }, { type: "dictation.download" }]);
  assert.equal(deriveView(started).dictation.progress, 0);
  const halfway = run(started, [{ type: "dictation.model", model: "downloading", progress: 0.42 }]);
  assert.equal(deriveView(halfway).dictation.progress, 0.42);
  const preparing = run(halfway, [{ type: "dictation.model", model: "downloading" }]);
  assert.equal(deriveView(preparing).dictation.progress, null);
  const ready = run(preparing, [{ type: "dictation.model", model: "ready", progress: 1 }]);
  assert.equal(ready.dictation.model, "ready");
  assert.equal(ready.dictation.progress, null);
});

test("spoken words join typing with one space, or start the draft", () => {
  assert.equal(withSpokenWords("", " hello "), "hello");
  assert.equal(withSpokenWords("Fix it.", "Now."), "Fix it. Now.");
  assert.equal(withSpokenWords("Fix it.\n", "Now."), "Fix it.\nNow.");
  assert.equal(withSpokenWords("Fix it.", ""), "Fix it.");
});

test("holding to talk on a paired computer's thread shows this computer's microphone", () => {
  const remote = workspace({ threads: [task("remote-thread")], currentId: "remote-thread", dictation: { model: "unsupported", message: null, progress: null, session: null } });
  const local = workspace({ dictation: { model: "ready", message: null, progress: null, session: null } });
  const link = { id: "linux", name: "linux", host: "linux.tail.ts.net", status: "connected" as const, error: null, pairedAt: 1, state: remote };
  const state = { ...local, computers: { ...local.computers, name: "This Mac", paired: [link], active: "linux" } };
  const key = promptKey(state);
  assert.equal(key, "remote-thread");
  const view = deriveView({ ...state, dictation: { ...state.dictation, session: { id: "hold", key, phase: "recording" } } });
  assert.equal(view.dictation.model, "ready");
  assert.equal(view.dictation.phase, "recording");
});
