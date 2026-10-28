import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { act } from "react";
import { click, lastCommand, live, openPhone, patchView, view } from "../support/mobile-phone.mts";

function withSecondThread() {
  const body = view();
  body.groups[0]!.threads.push({ id: "t2", title: "Rewrite the docs", projectId: "p", projectName: "App", attention: false, status: "idle", lastActivityAt: 1, unread: false });
  return body;
}

test("a thread on its way shows a spinner, and one the Mac never opens says so over the thread it shows", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line, withSecondThread());
    click(".thread-row:nth-of-type(2) .thread-open");
    assert.ok(document.querySelector(".empty[role=status] .line-spin"));
    act(() => void vi.advanceTimersByTime(3000));
    assert.equal(document.querySelector(".bar-title h1")?.textContent, "Fix the parser");
    assert.equal(document.querySelector(".banner-text")?.textContent, "Couldn't open \"Rewrite the docs\"");
    click(".banner-close");
    assert.equal(document.querySelector(".banner"), null);
  } finally {
    vi.useRealTimers();
  }
});

test("a thread the Mac never opens, with nothing else open, offers to ask again", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    const body = withSecondThread();
    body.thread = null;
    live(line, body);
    click(".thread-row:nth-of-type(2) .thread-open");
    act(() => void vi.advanceTimersByTime(3000));
    assert.equal(document.querySelector(".bar-title h1")?.textContent, "Rewrite the docs");
    assert.equal(document.querySelector(".banner"), null);
    const sent = line.sent.length;
    click(".empty .primary");
    assert.equal(line.sent.length, sent + 1);
    assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t2" });
    assert.ok(document.querySelector(".empty .line-spin"));
    patchView(line, 2, { thread: { kind: "opened", thread: { ...view().thread!, id: "t2", title: "Rewrite the docs", approval: null, queued: [] } } });
    assert.equal(document.querySelector(".empty"), null);
  } finally {
    vi.useRealTimers();
  }
});

test("a thread asked for while the line is down keeps waiting for it", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line, withSecondThread());
    act(() => line.onclose?.());
    click(".thread-row:nth-of-type(2) .thread-open");
    act(() => void vi.advanceTimersByTime(10_000));
    assert.ok(document.querySelector(".empty .line-spin"));
    assert.doesNotMatch(document.body.textContent ?? "", /Couldn't open/);
  } finally {
    vi.useRealTimers();
  }
});
