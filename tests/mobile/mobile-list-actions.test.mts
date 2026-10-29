import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { act } from "react";
import { click, clickRow, lastCommand, live, openPhone, patchView, view } from "../support/mobile-phone.mts";

test("every row carries a visible options button that opens the row's options", () => {
  const line = openPhone({ paired: true });
  live(line);
  const more = document.querySelector<HTMLButtonElement>(".thread-row .thread-more");
  assert.equal(more?.getAttribute("aria-label"), "Options for Fix the parser");
  assert.equal(more?.getAttribute("aria-haspopup"), "dialog");
  const sent = line.sent.length;
  click(".thread-row .thread-more");
  assert.equal(line.sent.length, sent, "opening the options sends nothing");
  assert.equal(document.querySelector(".scrim")?.getAttribute("aria-label"), "Thread options");
  clickRow("Fork thread");
  assert.deepEqual(lastCommand(line), { type: "task.fork", taskId: "t1" });
});

test("a setting the live Mac never echoes says it could not change, and the next tap clears that", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line);
    click(".thread-row .thread-open");
    click(".composer-settings");
    click(".sheet-option");
    assert.equal(document.querySelector(".sheet-refused"), null, "nothing is refused while the choice is on its way");
    act(() => void vi.advanceTimersByTime(5000));
    const mode = document.querySelector('.sheet-group[aria-label="Mode"]');
    assert.equal(mode?.querySelector(".sheet-refused")?.textContent, "Couldn't change. Try again.");
    assert.equal(document.querySelectorAll(".sheet-refused").length, 1, "only the group the choice was made in says so");
    click('.sheet-group[aria-label="Mode"] .sheet-option');
    assert.equal(document.querySelector(".sheet-refused"), null);
  } finally {
    vi.useRealTimers();
  }
});

test("a setting tapped while the line is down waits with its command instead of being called refused", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line);
    click(".thread-row .thread-open");
    click(".composer-settings");
    act(() => line.onclose?.());
    click(".sheet-option");
    act(() => void vi.advanceTimersByTime(5000));
    assert.equal(document.querySelector(".sheet-refused"), null);
    assert.match(document.querySelector('.sheet-group[aria-label="Mode"] [aria-checked="true"]')?.textContent ?? "", /^Auto/);
  } finally {
    vi.useRealTimers();
  }
});

test("moving a thread to another checkout sends the move at once", () => {
  const line = openPhone({ paired: true });
  const housed = view();
  housed.thread = { ...housed.thread!, worktrees: [{ id: "wt-2", name: "Spike", branch: "spike" }] };
  live(line, housed);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Location");
  click('.location-option[aria-checked="false"]:not(:disabled)');
  assert.deepEqual(lastCommand(line), { type: "task.move-worktree", taskId: "t1", destination: { kind: "worktree", id: "wt-2" } });
  assert.equal(document.querySelector(".sheet"), null);
});

test("leaving a worktree only this thread works in says it goes", () => {
  const line = openPhone({ paired: true });
  const housed = view();
  housed.thread = { ...housed.thread!, location: { kind: "worktree", name: "Feature", threads: 1 }, worktreeId: "wt-1", worktrees: [] };
  live(line, housed);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Location");
  assert.equal(document.querySelector('.location-option[aria-checked="true"] small')?.textContent, "Removed once this thread leaves");
  click('.location-option[aria-checked="false"]:not(:disabled)');
  assert.deepEqual(lastCommand(line), { type: "task.move-worktree", taskId: "t1", destination: { kind: "local" } });
});

