import assert from "node:assert/strict";
import { test } from "vitest";
import type { BackgroundReport } from "../../../src/contracts/ipc.ts";
import type { BackgroundProcess } from "../../../src/domain/run.ts";
import { BackgroundWork } from "../../../src/main/agent/background-work.mts";

const shell = (id: string): BackgroundProcess => ({ id, kind: "shell", description: "npm run dev" });

/** The session's own busy: whatever else it has going, plus the work this module holds. */
function opened(otherWork: () => boolean = () => false) {
  const reported: BackgroundReport[] = [];
  const rests: number[] = [];
  const work: BackgroundWork = new BackgroundWork(() => work.running || otherWork(), () => rests.push(reported.length));
  work.openWith((report) => reported.push(report));
  return { work, rests, ids: () => reported.map((report) => report.processes.map((process) => process.id)) };
}

test("a fresh session starts empty and reports the whole set each time it changes", () => {
  const { work, ids } = opened();
  assert.equal(work.running, false);

  work.replace([shell("bash-1")]);
  assert.equal(work.running, true);
  work.replace([shell("bash-1"), shell("bash-2")]);
  work.replace([shell("bash-2")]);
  assert.deepEqual(ids(), [[], ["bash-1"], ["bash-1", "bash-2"], ["bash-2"]]);
});

test("work stopping rests the session, and work still running does not", () => {
  const { work, rests } = opened();
  work.replace([shell("bash-1")]);
  assert.deepEqual(rests, [], "a set that grows from empty is not rest");

  work.replace([shell("bash-2")]);
  assert.deepEqual(rests, [], "one shell replacing another leaves work running");

  work.replace([]);
  assert.equal(work.running, false);
  assert.deepEqual(rests, [4], "rest is reported after the set it follows");
});

test("a session with other work going does not rest when its processes stop", () => {
  let answering = true;
  const { work, rests } = opened(() => answering);
  work.replace([shell("bash-1")]);
  work.replace([]);
  assert.deepEqual(rests, [], "the turn in flight still owns the session");

  answering = false;
  work.replace([shell("bash-1")]);
  work.replace([]);
  assert.deepEqual(rests, [5]);
});

test("work that keeps the session busy can be wider than what is reported", () => {
  const { work, rests, ids } = opened();
  work.replace([shell("bash-1")], ["bash-1", "agent-1"]);
  assert.deepEqual(ids(), [[], ["bash-1"]], "an agent task of the engine's own is not a process of its own");

  work.replace([], ["agent-1"]);
  assert.equal(work.running, true, "the task the report leaves out still owns the session");
  assert.deepEqual(rests, []);
});

test("the session ending empties the set without calling it rest", () => {
  const { work, rests, ids } = opened();
  work.replace([shell("bash-1")]);
  work.clear();
  assert.equal(work.running, false);
  assert.deepEqual(ids(), [[], ["bash-1"], []]);
  assert.deepEqual(rests, []);
});
