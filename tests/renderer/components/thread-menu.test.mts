import assert from "node:assert/strict";
import { test } from "vitest";
import type { MenuEntry, MenuItem } from "../../../src/renderer/components/PopoverMenu.tsx";
import { threadMenuEntries } from "../../../src/renderer/components/thread-menu.ts";
import type { Thread } from "../../../src/domain/thread.ts";
import { task } from "../../application/workspace-reducer-fixtures.mts";

function entries(thread: Thread, notifications = true, onSetMuted: (muted: boolean) => void = () => {}, stoppable = false, onStopAll: () => void = () => {}): MenuItem[] {
  const menu: MenuEntry[] = threadMenuEntries(thread, { onRename: () => {}, onFork: () => {}, onArchive: () => {}, onSetRole: () => {}, coordinators: [], onSetCoordinator: () => {}, notifications, onSetMuted, stoppable, onStopAll });
  return menu.filter((entry): entry is MenuItem => entry !== "separator");
}

function mute(thread: Thread, notifications?: boolean, onSetMuted?: (muted: boolean) => void) {
  return entries(thread, notifications, onSetMuted).find((entry) => entry.label.endsWith("ute notifications"));
}

test("a coordinator's menu mutes and unmutes its notifications by name, with no tick", () => {
  const chosen: boolean[] = [];
  const loud = mute(task("lead", { role: "coordinator" }), true, (muted) => chosen.push(muted));
  assert.equal(loud?.label, "Mute notifications");
  assert.deepEqual(loud?.command, { type: "coordination.set-muted", taskId: "lead", muted: true });
  assert.equal(loud?.checked, undefined, "a tick would mark the whole menu as one to tick");
  loud?.onSelect?.();

  const quiet = mute(task("lead", { role: "coordinator", muted: true }), true, (muted) => chosen.push(muted));
  assert.equal(quiet?.label, "Unmute notifications");
  assert.deepEqual(quiet?.command, { type: "coordination.set-muted", taskId: "lead", muted: false });
  quiet?.onSelect?.();
  assert.deepEqual(chosen, [true, false]);

  assert.equal(mute(task("solo")), undefined, "only a coordinator has notices of its own to mute");
  assert.equal(mute(task("worker", { parentId: "lead" })), undefined);
});

test("muting waits on notifications being on in Settings", () => {
  const off = mute(task("lead", { role: "coordinator" }), false);
  assert.equal(off?.disabled, true);
  assert.equal(off?.title, "Notifications are off in Settings");
  assert.equal(mute(task("lead", { role: "coordinator" }), true)?.disabled, undefined);
});

test("a coordinator's menu stops it and its threads, while there is work to stop", () => {
  const stopping: string[] = [];
  const stop = (thread: Thread, stoppable: boolean) => entries(thread, true, () => {}, stoppable, () => stopping.push(thread.id)).find((entry) => entry.label === "Stop all");
  const lead = task("lead", { role: "coordinator" });
  const going = stop(lead, true);
  assert.deepEqual(going?.command, { type: "coordination.stop-all", taskId: "lead" });
  assert.equal(going?.disabled, undefined);
  going?.onSelect?.();
  assert.deepEqual(stopping, ["lead"]);
  assert.equal(stop(lead, false)?.disabled, true, "with nothing going there is nothing to stop");
  assert.equal(stop(task("solo"), true), undefined, "only a coordinator stops threads under it");
});

test("a thread a coordinator on another computer started moves out from under it, from either computer", () => {
  const remoteLead = { threadId: "lead", title: "Planner", computer: "Laptop" };
  const there = entries(task("far", { remoteLead })).find((entry) => entry.label.startsWith("Move out"));
  assert.equal(there?.label, "Move out of Planner");
  assert.deepEqual(there?.command, { type: "task.set-coordinator", taskId: "far", coordinatorId: null });
  const menu = threadMenuEntries(task("far", { remoteLead }), { onRename: () => {}, onFork: () => {}, onArchive: () => {}, onSetRole: () => {}, coordinators: [task("lead", { role: "coordinator", title: "Lead here" })], onSetCoordinator: () => {}, notifications: true, onSetMuted: () => {}, stoppable: false, onStopAll: () => {} });
  assert.ok(menu.some((entry) => entry !== "separator" && entry.label === "Move out of Lead here"), "the coordinator's own computer names it as it is called there");
});
