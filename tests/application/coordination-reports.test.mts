import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinationContext } from "../../src/application/coordination.ts";
import { coordinationView } from "../../src/application/coordination-view.ts";
import type { ThreadBrief } from "../../src/domain/coordination.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";

const BRIEF: ThreadBrief = { intent: "push the login fix", doneWhen: "it is on main", delivers: "commit" };

function lead() {
  return task("lead", { role: "coordinator", title: "Lead" });
}

function member(id: string, overrides: Partial<Thread> = {}) {
  return task(id, { parentId: "lead", title: id[0]!.toUpperCase() + id.slice(1), ...overrides });
}

test("a thread that ends its turn without reporting reads as done in what it last said, and its coordinator is told it never reported", () => {
  const reply = { id: "reply", kind: "assistant" as const, text: "\n- Pushed **commit** `a1b2c3d` to [main](https://github.com/o/r/tree/main).\n\nTests pass.", at: 5 };
  const threads = [
    lead(),
    member("unreported", { brief: BRIEF, outcome: "finished", messages: [reply] }),
    member("silent", { outcome: "finished" }),
    member("progressed", { outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 }, messages: [reply] }),
    member("reported", { outcome: "finished", report: { state: "done", summary: "Shipped", at: 1 }, messages: [reply] }),
    member("asking", { outcome: "finished", messages: [reply], decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 1 }] }),
    member("stopped", { outcome: "stopped", messages: [reply] }),
  ];
  const state = workspace({ threads });
  const view = coordinationView(state, threads[0], new Set(), new Set(), () => undefined);
  assert.deepEqual(view.members.map(({ thread, status, summary }) => [thread.id, status, summary]), [
    ["unreported", "done", "Pushed commit a1b2c3d to main."],
    ["silent", "done", null],
    ["progressed", "done", "Pushed commit a1b2c3d to main."],
    ["reported", "done", "Shipped"],
    ["asking", "asking", "Keep it?"],
    ["stopped", "idle", null],
  ], "a finished turn is done whichever engine ran it, and only its own report outranks what it said");

  const context = coordinationContext(state, threads[0]);
  assert.match(context, /"Unreported" \[unreported\] · idle · ended its turn without reporting; it last said: Pushed commit a1b2c3d to main\.$/m);
  assert.match(context, /"Silent" \[silent\] · idle · ended its turn without reporting$/m);
  assert.match(context, /"Progressed" \[progressed\] · idle · ended its turn without reporting; it last said: Pushed commit a1b2c3d to main\.$/m, "a report that it was working is no final report");
  assert.match(context, /"Reported" \[reported\] · idle · reported done: Shipped$/m, "a thread that reported says so instead");
  assert.doesNotMatch(context, /"Asking" [^\n]*without reporting/, "nor is one waiting on the user");
  assert.doesNotMatch(context, /"Stopped" [^\n]*without reporting/, "nor one that was stopped");
});

test("a thread still at work keeps the report that it is working in its coordinator's roster", () => {
  const threads = [lead(), member("busy", { outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 } })];
  const context = coordinationContext(workspace({ threads, activeRuns: { busy: activeRun("busy", "run-busy") } }), threads[0]);
  assert.match(context, /"Busy" \[busy\] · working · reported working: Halfway$/m);
});
