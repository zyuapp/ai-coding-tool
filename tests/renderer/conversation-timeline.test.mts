import { type TimelineProps, type TimelineMessage, transcript, timelineView } from "../support/timeline.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import type { Thread } from "../../src/domain/thread.ts";

import { item, mount, query } from "../support/renderer-dom.mts";

const { groupTimeline } = await import("../../src/renderer/components/ConversationTimeline.tsx");
const { groupMessageIds, messageRows } = await import("../../src/renderer/timeline/grouping.ts");

async function expand(details: HTMLDetailsElement) {
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

test("find opens the fold the match it is showing was written into", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: "retry the build" },
    { kind: "assistant", text: "Done." },
  );
  const find: NonNullable<TimelineProps["find"]> = {
    target: { kind: "thread", taskId: null },
    query: "retry",
    index: 0,
    focus: 1,
    matches: 1,
    counting: false,
    hit: { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
  };
  const view = await mount(timelineView(messages, "idle", undefined, undefined, find));

  assert.equal(query(view.container, ".work-steps pre").textContent, "retry the build");

  await view.render(timelineView(messages, "idle", undefined, undefined, { ...find, hit: null, matches: 0, query: "" }));
  assert.equal(view.container.querySelector(".work-steps"), null, "the fold closes again once the match is no longer being read");
  await view.unmount();
});

test("a running turn collapses its tool calls behind the newest one", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "tool", text: "Read", detail: "three" },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Read");
  assert.equal(query(run, ".work-count").textContent, "+2");
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
  assert.equal(view.container.querySelectorAll(".work-steps").length, 0);

  await expand(run);
  assert.deepEqual([...view.container.querySelectorAll(".work-steps .work-row .work-tool")].map((step) => step.textContent), ["Bash", "Grep", "Read"]);
  await view.unmount();
});

test("a run of tool calls leads with the argument, not the tool name", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "git status --short" }) },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "yarn tsc --noEmit" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "$yarn tsc --noEmit");

  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["$git status --short", "$yarn tsc --noEmit"]);
  assert.equal(run.querySelector(".work-row .work-tool"), null, "a run of one tool names it once, in its own summary");
  await view.unmount();
});

test("a thread on an engine only a newer build knows reads its calls by their common arguments", async () => {
  const messages = transcript(
    { kind: "user", text: "Look around" },
    { kind: "tool", text: "run_shell", detail: JSON.stringify({ command: "ls -la" }) },
    { kind: "tool", text: "open_file", detail: JSON.stringify({ path: "/repo/src/app.ts" }) },
  );
  const shown = timelineView(messages, "running");
  const view = await mount(React.cloneElement(shown, { engine: "gemini", engineLabel: "gemini", currentThread: { ...shown.props.currentThread, engine: "gemini" } } as never));
  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row")].map((step) => [step.querySelector(".work-tool")?.textContent, step.querySelector(".work-arg")?.textContent]), [["run_shell", "ls -la"], ["open_file", "…/src/app.ts"]]);
  await view.unmount();
});

test("a run of mixed tools names the tool on every call", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Read", detail: JSON.stringify({ file_path: "/repo/src/renderer/styles.css" }) },
    { kind: "tool", text: "Grep", detail: JSON.stringify({ pattern: "work-row", path: "src/renderer" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-tool")].map((step) => step.textContent), ["Read", "Grep"]);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["…/renderer/styles.css", "work-row in src/renderer"]);
  await view.unmount();
});

test("a settled turn folds its steps behind the final answer", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Fixed the race." },
  );
  const view = await mount(timelineView(messages, "idle"));

  const settled = query<HTMLDetailsElement>(view.container, ".work-group");
  assert.equal(query(settled, ".work-summary").textContent, "3 steps");
  assert.equal(query(view.container, ".message.turn > .message-text").textContent, "Fixed the race.");
  assert.equal(view.container.querySelector(".work-note"), null);

  await expand(settled);
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Grep");
  assert.equal(query(run, ".work-count").textContent, "+1");

  await view.unmount();
});

test("timeline groups keep user turns apart and leave a lone answer uncollapsed", () => {
  const messages = transcript(
    { kind: "user", text: "One" },
    { kind: "assistant", text: "Sure." },
    { kind: "user", text: "Two" },
    { kind: "assistant", text: "Checking." },
    { kind: "tool", text: "Bash" },
  );

  const settled = groupTimeline(messages, { running: false });
  assert.deepEqual(settled.map((group) => group.kind), ["message", "turn", "message", "turn"]);
  assert.deepEqual(settled[1], { kind: "turn", id: "m1", steps: [], final: messages[1], endsAt: messages[1].at, live: false });
  const settledTurn = item(settled[3]);
  if (settledTurn.kind !== "turn") assert.fail("expected the last settled group to be a turn");
  assert.equal(settledTurn.final, null);
  assert.equal(settledTurn.steps.length, 2);

  const running = groupTimeline(messages, { running: true });
  const earlierTurn = item(running[1]);
  const liveTurn = item(running[3]);
  if (earlierTurn.kind !== "turn" || liveTurn.kind !== "turn") assert.fail("expected grouped turns");
  assert.equal(earlierTurn.live, false);
  assert.equal(liveTurn.live, true);
});

test("a coordinator's superseded thread updates fold into one row before the newest", () => {
  const messages = transcript(
    { kind: "user", text: "Ship it" },
    { kind: "assistant", text: "Started two threads." },
    { kind: "user", text: "\"One\" ended its turn.", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "assistant", text: "One is done." },
    { kind: "user", text: "\"Two\" ended its turn.", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "tool", text: "Read" },
    { kind: "assistant", text: "Both are done." },
    { kind: "user", text: "Thanks" },
    { kind: "user", text: "\"Three\" ended its turn.", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "assistant", text: "Three is done." },
  );
  const groups = groupTimeline(messages, { running: false });
  assert.deepEqual(groups.map((group) => group.kind), ["message", "turn", "updates", "message", "turn", "message", "message", "turn"]);
  const folded = item(groups[2]);
  if (folded.kind !== "updates") assert.fail("expected folded updates");
  assert.equal(folded.count, 1);
  assert.deepEqual(folded.entries.map((entry) => entry.id), ["m2", "m3"]);
});

test("a coordinator's thread messages fold to one row naming the sender, and the user's own words stay open", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix login" },
    { kind: "assistant", text: "Started a thread." },
    { kind: "user", text: "\"Fix login\" ended its turn.\nIt last said: done", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "assistant", text: "Login is fixed." },
    { kind: "user", text: "Can I merge?", origin: { kind: "thread", threadId: "t2", title: "Fix login" }, detail: "From Fix login · t2" },
  );
  const groups = groupTimeline(messages, { running: false, coordinator: true });
  assert.deepEqual(groups.map((group) => group.kind === "message" ? group.from ?? null : group.kind), [null, "turn", "Thread updates", "turn", "From Fix login"]);
  assert.equal(groupTimeline(messages, { running: false }).some((group) => group.kind === "message" && group.from), false, "only a coordinator folds them");

  const plain = timelineView(messages, "idle");
  const view = await mount(React.cloneElement(plain, { currentThread: { ...plain.props.currentThread!, role: "coordinator" } }));
  const folds = [...view.container.querySelectorAll<HTMLDetailsElement>(".thread-message")];
  assert.deepEqual(folds.map((fold) => query(fold, ".work-lead").textContent), ["Thread updates", "From Fix login"]);
  assert.equal(folds[0]!.querySelector(".thread-message-text"), null, "the news stays out of view until opened");
  assert.equal(view.container.querySelectorAll(".message.user .message-text").length, 1);
  await expand(folds[1]!);
  assert.equal(query(folds[1]!, ".thread-message-text").textContent, "Can I merge?");
  await view.unmount();
});

test("a coordinator's threads appear where they began", async () => {
  const messages = transcript(
    { kind: "user", text: "Ship it" },
    { kind: "tool", text: "start_thread" },
    { kind: "tool", text: "start_thread" },
    { kind: "assistant", text: "Started two threads." },
    { kind: "user", text: "\"One\" ended its turn.", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "assistant", text: "One is done; starting a follow-up." },
    { kind: "user", text: "\"Two\" ended its turn.", origin: { kind: "coordination" }, detail: "Thread updates" },
    { kind: "assistant", text: "Both are done." },
    { kind: "user", text: "Thanks" },
    { kind: "assistant", text: "Anytime." },
  );
  const starts = [{ id: "one", at: 1500 }, { id: "two", at: 2500 }, { id: "follow-up", at: 5500 }, { id: "suggested", at: 8500 }];
  const groups = groupTimeline(messages, { running: false, coordinator: true, starts });
  assert.deepEqual(groups.map((group) => group.kind), ["message", "turn", "threads", "updates", "message", "turn", "message", "threads", "turn"]);
  assert.deepEqual(groups[2], { kind: "threads", id: "threads-one", threadIds: ["one", "two"] }, "threads started in one turn share a row after it");
  assert.deepEqual(groups[7], { kind: "threads", id: "threads-suggested", threadIds: ["suggested"] }, "one the user started later lands at its time");
  const folded = item(groups[3]);
  if (folded.kind !== "updates") assert.fail("expected folded updates");
  assert.deepEqual(folded.entries.map((entry) => entry.id), ["m4", "m5", "threads-follow-up"], "a folded update cycle carries the threads it started");
  assert.equal(messageRows(groups).get("threads-one"), 2);
  assert.deepEqual(groupMessageIds(item(groups[2])), []);

  const view = (role?: "coordinator") => {
    const plain = timelineView(messages.slice(0, 4), "idle");
    const member = (id: string, title: string): Thread => ({ ...plain.props.currentThread!, id, title, parentId: "t1", messages: [] });
    const cards = new Map(["one", "two"].map((id) => [id, { thread: member(id, id === "one" ? "Fix login" : "Dark mode"), status: "working" as const, summary: null, pullRequest: null, steps: [], startedAt: 1500, host: null, lastHeard: false }]));
    return React.cloneElement(plain, {
      currentThread: { ...plain.props.currentThread!, ...(role ? { role } : {}) },
      threadCards: { cards, worktrees: new Map(), onSelect() {} },
      starts: starts.slice(0, 2),
    });
  };
  const shown = await mount(view("coordinator"));
  const row = query(shown.container, '.timeline-row.threads');
  assert.deepEqual([...row.querySelectorAll(".coordination-card strong")].map((node) => node.textContent), ["Fix login", "Dark mode"]);
  await shown.unmount();
  const plain = await mount(view());
  assert.equal(plain.container.querySelector(".coordination-card"), null, "a thread that coordinates nothing draws no cards");
  await plain.unmount();
});

test("a settled turn times each step it folds away", async () => {
  const settledMessages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "Looking." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Done." },
  );
  const settledView = await mount(timelineView(settledMessages, "idle"));

  const settled = query<HTMLDetailsElement>(settledView.container, ".work-group");
  assert.equal(query(settled, ".work-time").textContent, "3s");
  await expand(settled);
  const run = query<HTMLDetailsElement>(settledView.container, ".work-run");
  assert.equal(query(run, ".work-time").textContent, "2s");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-time")].map((time) => time.textContent), ["1s", "1s"]);
  await settledView.unmount();
});

test("a running turn counts up until its work ends", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await act(async () => { vi.advanceTimersByTime(4_000); });
  assert.equal(elapsed(), "1m 4s");

  await view.render(timelineView([...running, { id: "l2", at: 106_000, kind: "assistant", text: "Done." }], "idle"));
  assert.equal(elapsed(), "1m 6s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 6s");

  await view.unmount();
});

test("a stopped turn freezes at the moment its run ended", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await view.render(timelineView(running, "stopped", null, 102_000));
  assert.equal(elapsed(), "1m 2s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 2s", "stopping ends the turn even though no answer closed it");

  await view.render(timelineView(running, "stopped", null));
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "55s", "work stored before stops were timed rests on its last step");

  await view.unmount();
});

test("elapsed labels stay readable from seconds to hours", async () => {
  const { formatElapsed } = await import("../../src/renderer/components/ConversationTimeline.tsx");

  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(940), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_500_000), "2h 5m");
});

test("a thread waiting on its checkout says so in the transcript, and its composer holds", async () => {
  window.desktop = fakeDesktop();
  const messages = transcript({ kind: "user", text: "Refactor the loader" });

  const view = await mount(timelineView(messages, "idle"));
  assert.equal(view.container.querySelector(".waiting-row"), null, "an idle thread is not waiting on anything");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "worktree"));
  const waiting = query(view.container, ".waiting-row");
  assert.match(waiting.textContent, /Creating worktree/);
  assert.equal(waiting.getAttribute("role"), "status", "the wait is announced rather than only drawn");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "run"));
  assert.match(query(view.container, ".waiting-row").textContent, /Starting/);
  await view.unmount();
});

test("a running turn says it is working to assistive tech, not only with dots", async () => {
  const view = await mount(timelineView(transcript({ kind: "user", text: "go" }), "running"));
  const row = query(view.container, ".thinking-row");
  assert.equal(row.getAttribute("role"), "status");
  assert.equal(query(row, ".thinking-label").textContent, "Working");
  assert.equal(query(row, ".thinking-elapsed").getAttribute("aria-hidden"), "true", "the ticking time is not read out every second");
  await view.unmount();
});

test("the working row shows how long the live turn has run", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "u", at: 10_000, kind: "user", text: "go" },
    { id: "l0", at: 88_000, kind: "tool", text: "Bash", detail: "one" },
  ];
  const view = await mount(timelineView(running, "running"));
  assert.equal(query(view.container, ".thinking-elapsed").textContent, "12s");
  await act(async () => { vi.advanceTimersByTime(3_000); });
  assert.equal(query(view.container, ".thinking-elapsed").textContent, "15s");
  await view.unmount();
});

test("a fold opened for a find match can still be closed by hand", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: "retry the build" },
    { kind: "assistant", text: "Done." },
  );
  const find: NonNullable<TimelineProps["find"]> = {
    target: { kind: "thread", taskId: null }, query: "retry", index: 0, focus: 1, matches: 1, counting: false,
    hit: { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
  };
  const view = await mount(timelineView(messages, "idle", undefined, undefined, find));
  const fold = query<HTMLDetailsElement>(view.container, ".work-group");
  assert.equal(fold.open, true);
  await act(async () => {
    fold.open = false;
    fold.dispatchEvent(new Event("toggle"));
  });
  assert.equal(fold.open, false);
  assert.equal(view.container.querySelector(".work-steps"), null);
  await view.render(timelineView(messages, "idle", undefined, undefined, { ...find, hit: { ...find.hit!, start: 1, occurrence: 1 } }));
  assert.equal(fold.open, false, "the same match does not reopen what the reader closed");
  await view.unmount();
});

test("a call that printed nothing says so when opened", async () => {
  const messages = transcript({ kind: "user", text: "Fix it" }, { kind: "tool", text: "Bash" });
  const view = await mount(timelineView(messages, "running"));
  await expand(query<HTMLDetailsElement>(view.container, ".work-row"));
  assert.equal(query(view.container, ".work-empty").textContent, "No output");
  assert.equal(view.container.querySelector(".work-row pre"), null);
  await view.unmount();
});

test("a retrying run can be stopped from the row that says so", async () => {
  const sent: unknown[] = [];
  const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
  const timeline = React.cloneElement(timelineView(transcript({ kind: "user", text: "go" }), "running"), { retrying: { message: "Overloaded.", attempt: 2, maxRetries: 5 } });
  const view = await mount(React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command: unknown) => { sent.push(command); } } }, timeline));
  const row = query(view.container, ".retrying-row");
  assert.match(row.textContent, /Overloaded\. Retrying 2 of 5…/);
  await act(async () => { query<HTMLButtonElement>(row, "button").click(); });
  assert.deepEqual(sent, [{ type: "run.cancel", taskId: "t1" }]);
  await view.unmount();
});

test("a usage limit's sentence keeps up with the clock while it waits", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const timeline = React.cloneElement(timelineView(transcript({ kind: "user", text: "go" }), "idle"), { limitPause: { resetsAt: 130_000, window: "session", pausedAt: 90_000, position: null } });
  const view = await mount(timeline);
  assert.match(query(view.container, ".limit-row").textContent, /Usage limit reached\. Resumes at/);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  assert.match(query(view.container, ".limit-row").textContent, /Usage limit reset\. Resuming\./);
  await view.unmount();
});
