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

test("letting go adds the words after what was typed, and asks the composer on screen to send", () => {
  const { state, id } = held();
  assert.equal(state.dictation.session?.phase, "recording");
  const typed = reduce(state, { type: "view.set-prompt", prompt: "Look at the diff." }).state;

  const stopped = reduce(typed, { type: "dictation.stop" });
  assert.deepEqual(effectOf(stopped, "dictation.stop"), { type: "dictation.stop", id });
  assert.equal(deriveView(stopped.state).dictation.phase, "transcribing");

  const heard = reduce(stopped.state, { type: "dictation.transcribed", id, text: "Then fix the failing test." });
  assert.equal(heard.state.prompts.a, "Look at the diff. Then fix the failing test.");
  assert.equal(heard.state.dictation.session, null);
  assert.equal(deriveView(heard.state).dictation.release, deriveView(state).dictation.release + 1);
});

test("words for a thread left during the hold stay in its draft and are not sent", () => {
  const { state, id } = held();
  const moved = run(state, [{ type: "dictation.stop" }, { type: "task.select", taskId: "b" }]);
  const heard = reduce(moved, { type: "dictation.transcribed", id, text: "keep me" });

  assert.equal(heard.state.prompts.a, "keep me");
  assert.equal(heard.state.prompts.b, undefined);
  assert.equal(heard.state.dictation.release, state.dictation.release);
});

test("a hold that heard nothing sends nothing and says so under the composer", () => {
  const { state, id } = held(run(workspace(), [ready]));
  const heard = reduce(run(state, [{ type: "dictation.stop" }]), { type: "dictation.transcribed", id, text: "  " });

  assert.equal(heard.state.prompts[NEW_THREAD_DRAFT], undefined);
  assert.equal(heard.state.attachmentSends[MAIN_COMPOSER]?.error, DICTATION_HEARD_NOTHING);
  assert.equal(heard.state.dictation.release, 0);
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

test("spoken words join typing with one space, or start the draft", () => {
  assert.equal(withSpokenWords("", " hello "), "hello");
  assert.equal(withSpokenWords("Fix it.", "Now."), "Fix it. Now.");
  assert.equal(withSpokenWords("Fix it.\n", "Now."), "Fix it.\nNow.");
  assert.equal(withSpokenWords("Fix it.", ""), "Fix it.");
});

test("holding to talk on a paired computer's thread shows this computer's microphone and sends from here", () => {
  const remote = workspace({ threads: [task("remote-thread")], currentId: "remote-thread", dictation: { model: "unsupported", message: null, session: null, release: 7 } });
  const local = workspace({ dictation: { model: "ready", message: null, session: null, release: 0 } });
  const link = { id: "linux", name: "linux", host: "linux.tail.ts.net", status: "connected" as const, error: null, pairedAt: 1, state: remote };
  const state = { ...local, computers: { ...local.computers, name: "This Mac", paired: [link], active: "linux" } };
  const key = promptKey(state);
  assert.equal(key, "remote-thread");
  const view = deriveView({ ...state, dictation: { ...state.dictation, session: { id: "hold", key, phase: "recording" }, release: 1 } });
  assert.equal(view.dictation.model, "ready");
  assert.equal(view.dictation.phase, "recording");
  assert.equal(view.dictation.release, 1);
});
