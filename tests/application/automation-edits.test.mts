import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { editedAutomationFields } from "../../src/domain/automation.ts";
import { task, workspace } from "./workspace-reducer-fixtures.mts";

const saved = { schedule: "0 8 * * *", prompt: "Check the PR", surfaceWhen: "", endsWhen: "" };

test("an automation's unsaved edits are held per thread, and let go once they match what is saved or the automation is removed", () => {
  const edited = reduce(workspace({ threads: [task("t1")] }), { type: "view.edit-automation", taskId: "t1", base: saved, fields: { ...saved, prompt: "Check the PR twice" } });
  assert.deepEqual(edited.effects, []);
  assert.equal(edited.state.automationEdits.t1?.fields.prompt, "Check the PR twice");

  const reverted = reduce(edited.state, { type: "view.edit-automation", taskId: "t1", base: saved, fields: saved });
  assert.deepEqual(reverted.state.automationEdits, {});
  assert.equal(reduce(reverted.state, { type: "view.edit-automation", taskId: "t1", base: saved, fields: saved }).state, reverted.state);

  const removed = reduce(edited.state, { type: "automation.delete", taskId: "t1" });
  assert.deepEqual(removed.state.automationEdits, {});
});

test("edits show only while the saved fields they began from still stand", () => {
  const edit = { base: saved, fields: { ...saved, prompt: "Mine" } };
  assert.equal(editedAutomationFields(saved, edit).prompt, "Mine");
  assert.equal(editedAutomationFields({ ...saved, prompt: "Theirs" }, edit).prompt, "Theirs");
  assert.equal(editedAutomationFields(saved, undefined).prompt, "Check the PR");
});
