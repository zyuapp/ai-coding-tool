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

test("the Mac's Undo for a move shows above the composer, and moves the thread back", () => {
  const line = openPhone({ paired: true });
  const housed = view();
  housed.thread = { ...housed.thread!, worktrees: [{ id: "wt-2", name: "Spike", branch: "spike" }] };
  live(line, housed);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Location");
  click('.location-option[aria-checked="false"]:not(:disabled)');
  assert.deepEqual(lastCommand(line), { type: "task.move-worktree", taskId: "t1", destination: { kind: "worktree", id: "wt-2" } });
  patchView(line, 2, { undo: { id: 1, title: "Moved to Spike", command: { type: "task.move-worktree", taskId: "t1", destination: { kind: "local" } } } });
  assert.match(document.querySelector(".toast-dock .undo-toast")?.textContent ?? "", /Moved to Spike/);
  click(".undo-toast button");
  assert.deepEqual(lastCommand(line), { type: "task.move-worktree", taskId: "t1", destination: { kind: "local" } });
  assert.equal(document.querySelector(".undo-toast"), null);
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

test("a line down for a minute or more says for how long", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line);
    act(() => line.onclose?.());
    const mark = () => document.querySelector(".bar .line-mark");
    assert.equal(mark()?.querySelector(".line-since"), null, "a line just lost says only that it is down");
    act(() => void vi.advanceTimersByTime(125_000));
    assert.equal(mark()?.querySelector(".line-since")?.textContent, "2m");
  } finally {
    vi.useRealTimers();
  }
});
