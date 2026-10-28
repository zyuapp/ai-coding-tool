import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, vi } from "vitest";
import { act } from "react";
import { MOBILE_PROTOCOL_VERSION, type MobileView } from "../../src/contracts/mobile.ts";
import { MOBILE_FOLDED_KEY } from "../../src/mobile/client/storage.ts";
import { groupMark, settingsSummary } from "../../src/mobile/format.ts";
import { defaultModelFor } from "../../src/domain/agent-engine.ts";
import { ensureLanguage } from "../../src/renderer/diff/highlight.ts";
import { BUILD, CODE, TOKEN, click, clickButton, clickRow, dom, lastCommand, live, openPhone, patchView, queries, typeInto, view, type FakeSocket } from "../support/mobile-phone.mts";

test("the phone page pairs from the address, opens a thread, and answers an approval", () => {
  const line = openPhone({ code: CODE });
  assert.equal(line.url, "wss://mac.ts.net/m/socket");
  /** The code is out of the address before anything else, so a reload cannot try to spend it twice. */
  assert.equal(window.location.hash, "");

  act(() => line.onopen?.());
  assert.deepEqual(line.sent[0], { kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: CODE, deviceName: "Phone" });

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "paired", sequence: 1, deviceId: "d1", deviceName: "Phone", token: TOKEN });
  receive({ kind: "snapshot", sequence: 2, sessionId: "s1", build: BUILD, view: view() });

  assert.match(document.body.textContent ?? "", /Fix the parser/);
  assert.match(document.body.textContent ?? "", /Needs you/);

  click(".thread-row .thread-open");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });

  assert.equal(document.querySelector(".bar-title p")?.textContent, "App", "the bar names the project; the status lives in the row, the dots and the approval card");

  const text = document.body.textContent ?? "";
  assert.match(text, /3 earlier messages are only on the computer/);
  /** Two calls of the same tool are one row with a count, not two rows saying "Bash". */
  assert.match(text, /Bash ×2/);
  assert.equal(document.querySelector(".queued .queued-text")?.textContent, "then deploy");
  assert.equal(document.querySelector(".turn-when"), null, "a sent message carries no clock; the answer that closes the turn does");
  assert.equal(document.querySelectorAll(".answer-time").length, 1);
  assert.equal(document.querySelector(".answer-time")?.getAttribute("dateTime"), new Date(4).toISOString());
  assert.equal(document.querySelectorAll(".markdown li").length, 2);

  click(".approval-actions .allow");
  assert.deepEqual(lastCommand(line), { type: "run.decide", taskId: "t1", runId: "r1", approvalId: "a1", allow: true });
  assert.ok([...document.querySelectorAll(".approval-actions button")].every((node) => (node as HTMLButtonElement).disabled), "one answer is all a card takes");
  assert.ok(document.querySelector(".approval[data-decided]"));

  assert.equal(document.querySelector(".composer-settings")?.textContent, "ModeConfirmModelOpusEffortHigh");
  click(".composer-settings");
  assert.ok(document.querySelector(".sheet"));
  assert.ok(document.querySelector(".sheet")?.contains(document.activeElement), "focus moves into the sheet");
  assert.equal(document.querySelector(".sheet-group h3")?.textContent, "Mode");
  assert.deepEqual([...document.querySelectorAll('.sheet [role="radiogroup"] .sheet-subheading')].map((node) => node.textContent), ["Claude"], "a thread that exists offers only its own engine's models");
  assert.deepEqual([...document.querySelectorAll(".sheet-subheading")].map((node) => node.textContent), ["Claude", "Codex"], "the other engine keeps its place in the model list");
  assert.equal(document.querySelector(".sheet-new-engine strong")?.textContent, "New thread with Codex");
  assert.match(document.querySelector(".sheet-new-engine small")?.textContent ?? "", /\S/, "and names the models a new thread on it reaches");
  click(".sheet-option");
  assert.deepEqual(lastCommand(line), { type: "task.set-policy", taskId: "t1", policy: "autonomous" });
  assert.match(document.querySelector('.sheet-group[aria-label="Mode"] [aria-checked="true"]')?.textContent ?? "", /^Auto/, "the tap shows before the Mac echoes it");
});

test("a thread's settings start a thread on the other engine in the same place", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click(".composer-settings");
  click(".sheet-new-engine");
  assert.deepEqual(line.sent.slice(-2).map((frame) => frame.kind === "command" ? frame.command : null), [
    { type: "task.new", projectId: "p" },
    { type: "task.set-model", engine: "codex", model: defaultModelFor("codex") },
  ]);
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "New thread");
});

test("a tapped setting the Mac never echoes goes back to what it is", () => {
  vi.useFakeTimers();
  try {
    const line = openPhone({ paired: true });
    live(line);
    click(".thread-row .thread-open");
    click(".composer-settings");
    click(".sheet-option");
    const checked = () => document.querySelector('.sheet-group[aria-label="Mode"] [aria-checked="true"]')?.textContent ?? "";
    assert.match(checked(), /^Auto/);
    act(() => void vi.advanceTimersByTime(5000));
    assert.match(checked(), /^Confirm/);
  } finally {
    vi.useRealTimers();
  }
});

test("a coordinator open on the phone answers the approval a thread under it waits on, naming that thread", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  const coordinating = view();
  coordinating.thread = { ...coordinating.thread!, status: "idle", approval: { taskId: "member", from: "Dark mode", approvalId: "a2", runId: "r2", title: "Run a command", description: "yarn test", toolName: "Bash", detail: "{}" } };
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s1", build: BUILD, view: coordinating }) }));
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".approval-from")?.textContent, "Dark mode");
  click(".approval-actions .allow");
  assert.deepEqual(lastCommand(line), { type: "run.decide", taskId: "member", runId: "r2", approvalId: "a2", allow: true }, "the answer goes to the thread that asked");
});

test("a row something waits on is marked as needing the user, and a folded group says so", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  const waiting = view();
  waiting.thread = null;
  waiting.groups = [{ projectId: "p", name: "App", threads: [{ id: "lead", title: "Plan", projectId: "p", projectName: "App", attention: false, status: "running", waiting: true, headline: "A decision is waiting on you", lastActivityAt: Date.now(), unread: false }] }];
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s1", build: BUILD, view: waiting }) }));
  assert.equal(document.querySelector(".thread-row")?.getAttribute("data-waiting"), "true");
  assert.match(document.querySelector(".thread-row .thread-headline")?.textContent ?? "", /A decision is waiting on you/);
  assert.equal(groupMark(waiting.groups[0]!.threads), "needs-you");

  const filed = view();
  filed.thread = null;
  filed.activity = { priority: [{ ...waiting.groups[0]!.threads[0]!, status: "idle", attention: true }], running: [], threads: [], snoozed: [] };
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 2, sessionId: "s1", build: BUILD, view: filed }) }));
  click('.segmented button[aria-checked="false"]');
  const row = document.querySelector(".thread-row");
  assert.deepEqual([row?.querySelector(".thread-mark") !== null, row?.querySelector(".thread-dismiss") !== null], [true, true], "a row that needs the user keeps its mark beside Dismiss");
});

/**
 * jsdom draws no pseudo-elements, so the cascade is read off the stylesheet: of the rules that pick a
 * row's mark, the needs-you one for something waiting must be at least as specific as any other and
 * come after them, or a news dot or a spinner hides it.
 */
test("the needs-you mark of something waiting outranks every other mark a row can draw", async () => {
  const css = await readFile(new URL("../../src/mobile/mobile.css", import.meta.url), "utf8");
  const specificity = (selector: string) => {
    const attributes = selector.match(/\[[^\]]*\]/g)?.length ?? 0;
    const classes = selector.replace(/\[[^\]]*\]/g, "").match(/\.[\w-]+|:(?!:)[\w-]+/g)?.length ?? 0;
    return attributes + classes;
  };
  const marks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .flatMap(([, selectors, body], order) => body!.includes("background") || body!.includes("animation") ? selectors!.split(",").map((selector) => ({ selector: selector.trim(), order })) : [])
    .filter(({ selector }) => selector.startsWith(".thread-row") && selector.endsWith(".thread-mark::before"));
  const waiting = marks.filter(({ selector }) => selector.includes("[data-waiting]"));
  assert.equal(waiting.length, 1);
  const [rule] = waiting;
  for (const other of marks.filter((item) => item !== rule)) {
    assert.ok(specificity(rule!.selector) > specificity(other.selector) || (specificity(rule!.selector) === specificity(other.selector) && rule!.order > other.order), `${rule!.selector} loses to ${other.selector}`);
  }
});

test("the phone selects an answer without sending until Send answer is pressed", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  const asked = view();
  asked.thread = { ...asked.thread!, approval: null, status: "running", question: {
    id: "q", questionId: "q", runId: "r1", requestId: "request", header: "Marker", question: "Which marker?",
    options: [{ label: "ALPHA", description: "First" }, { label: "BETA", description: "Second" }], blocking: false,
  } };
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s1", build: BUILD, view: asked }) }));
  click(".thread-row .thread-open");
  typeInto('.composer-card textarea', "Keep my message");
  click('input[value="BETA"]');
  assert.equal((document.querySelector('input[value="BETA"]') as HTMLInputElement).checked, true);
  assert.equal((document.querySelector(".question-answer textarea") as HTMLTextAreaElement).value, "", "a picked option is not copied into the typed answer");
  assert.equal((document.querySelector(".composer-card textarea") as HTMLTextAreaElement).value, "Keep my message");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });
  typeInto(".question-answer textarea", "BETA");
  assert.equal((document.querySelector('input[value="BETA"]') as HTMLInputElement).checked, false, "a typed answer replaces the picked option, even one that reads the same");
  assert.equal((document.querySelector(".question-answer textarea") as HTMLTextAreaElement).value, "BETA");
  typeInto(".question-answer textarea", "GAMMA custom");
  click(".question-answer button");
  assert.deepEqual(lastCommand(line), { type: "question.answer", taskId: "t1", runId: "r1", requestId: "request", questionId: "q", text: "GAMMA custom" });
  assert.equal((document.querySelector(".composer-card textarea") as HTMLTextAreaElement).value, "Keep my message");
  clickButton("Queue", ".composer");
  assert.deepEqual(lastCommand(line), { type: "task.send", taskId: "t1", text: "Keep my message" });
});

test("the phone shows the thread the Mac actually has open, and says what went wrong", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  assert.equal(line.sent[0]?.kind, "resume", "a stored token gets the page back in without a code");

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "snapshot", sequence: 1, sessionId: "s2", build: BUILD, view: view() });
  click(".thread-row .thread-open");
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });

  /** Somebody at the Mac opened a different thread. The phone follows rather than waiting for its own. */
  const elsewhere = view();
  elsewhere.thread = { ...elsewhere.thread!, id: "t2", title: "Rewrite the docs", approval: null, queued: [] };
  receive({ kind: "snapshot", sequence: 2, sessionId: "s2", build: BUILD, view: elsewhere });
  assert.match(document.body.textContent ?? "", /Rewrite the docs/);
  assert.doesNotMatch(document.body.textContent ?? "", /Opening the thread/);

  receive({ kind: "patch", sequence: 3, patch: { error: "That worktree is busy." } });
  assert.match(document.querySelector(".banner")?.textContent ?? "", /That worktree is busy/);
  assert.equal(document.querySelector(".banner[role=status] .banner-text")?.textContent, "That worktree is busy.");
  assert.ok(document.querySelector('button[aria-label="Thread options"]'), "the thread's options stay in reach while a notice is up");
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "Rewrite the docs", "the title stays while a notice is up");
  assert.equal(document.querySelector(".bar .banner"), null, "the notice sits under the bar, not in it");

  assert.equal(document.querySelector(".banner-more"), null, "a notice shown whole has nothing more to open");
  assert.equal(document.querySelector("button.banner-text"), null);
  click(".banner-close");
  assert.equal(document.querySelector(".banner"), null, "the cross puts the sentence away");
  receive({ kind: "patch", sequence: 4, patch: { thread: { kind: "changed", id: "t2", delta: { status: "idle" } } } });
  assert.equal(document.querySelector(".banner"), null, "and it stays away while the Mac says the same thing");
  receive({ kind: "patch", sequence: 5, patch: { error: "The Mac is busy." } });
  assert.match(document.querySelector(".banner")?.textContent ?? "", /The Mac is busy/);
});

test("a tap shows the thread it asked for, never the one the Mac still has open", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  const two = view();
  two.groups[0]!.threads.push({ id: "t2", title: "Rewrite the docs", projectId: "p", projectName: "App", attention: false, status: "idle", lastActivityAt: 1, unread: false });
  receive({ kind: "snapshot", sequence: 1, sessionId: "s7", build: BUILD, view: two });

  click(".thread-row:nth-of-type(2) .thread-open");
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "Rewrite the docs");
  assert.match(document.body.textContent ?? "", /Opening the thread/);
  assert.doesNotMatch(document.body.textContent ?? "", /then deploy/, "the thread the Mac still has open is not shown");

  receive({ kind: "patch", sequence: 2, patch: { thread: { kind: "opened", thread: { ...two.thread!, id: "t2", title: "Rewrite the docs", approval: null, queued: [] } } } });
  assert.doesNotMatch(document.body.textContent ?? "", /Opening the thread/);
  assert.equal(document.querySelector(".bar-title p")?.textContent, "App");

  click(".ghost.icon");
  click(".group-header .section-action");
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "New thread");
  assert.equal(document.querySelector("textarea"), null, "the old thread's composer is not the draft's");
});

test("New opens the thread the Mac is about to start, and the first message starts it", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());

  function receive(message: unknown) {
    act(() => line.onmessage?.({ data: JSON.stringify(message) }));
  }
  receive({ kind: "snapshot", sequence: 1, sessionId: "s3", build: BUILD, view: view() });

  click(".group-header .section-action");
  assert.deepEqual(lastCommand(line), { type: "task.new", projectId: "p" });

  /** The Mac has no thread open from here until a message makes one, which is what it answers with. */
  const draft = { projectId: "p", projectName: "App", settings: { engine: "claude", model: "opus" as const, effort: "high" as const, policy: "confirm" as const }, worktree: false, worktreeName: null, worktrees: [], canWorktree: true };
  receive({ kind: "patch", sequence: 2, patch: { thread: { kind: "closed" }, draft } });
  assert.equal(document.querySelector("textarea")?.getAttribute("placeholder"), "Ask Claude to work on anything");
  assert.doesNotMatch(document.body.textContent ?? "", /Opening the thread/);

  click(".composer-settings");
  assert.deepEqual([...document.querySelectorAll(".sheet-subheading")].map((node) => node.textContent), ["Claude", "Codex"], "a draft may still choose either engine");
  assert.equal(document.querySelector(".sheet-locked"), null);
  click(".sheet-option");
  assert.deepEqual(lastCommand(line), { type: "task.set-policy", policy: "autonomous" }, "a thread yet to exist has no id to name");
  click(".sheet-done");
  assert.equal(document.querySelector(".sheet"), null, "under reduced motion the sheet leaves at once");

  typeInto(".composer-card textarea", "start here");
  click(".send-button");
  assert.deepEqual(line.sent.slice(-2).map((frame) => frame.kind === "command" ? frame.command : null), [
    { type: "view.set-prompt", prompt: "start here" },
    { type: "task.send" },
  ]);

  /** The send made the thread, and the Mac opening it is what takes the phone off the draft. */
  receive({ kind: "patch", sequence: 3, patch: { thread: { kind: "opened", thread: view().thread! }, draft: null } });
  assert.match(document.body.textContent ?? "", /Fix the parser/);
});

test("a group folds shut and stays shut across a reload", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s4", build: BUILD, view: view() }) }));
  assert.equal(document.querySelectorAll(".thread-row").length, 1);

  click(".section-toggle");
  assert.equal(document.querySelectorAll(".thread-row").length, 0);
  assert.equal(document.querySelector(".section-toggle")?.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".section-mark")?.getAttribute("data-kind"), "needs-you", "the folded header keeps the row's mark");
  assert.equal(localStorage.getItem(MOBILE_FOLDED_KEY), JSON.stringify(["p"]));

  const again = openPhone({ paired: true, folded: JSON.parse(localStorage.getItem(MOBILE_FOLDED_KEY)!) });
  act(() => again.onopen?.());
  act(() => again.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s5", build: BUILD, view: view() }) }));
  assert.equal(document.querySelectorAll(".thread-row").length, 0, "still folded after a reload");

  click(".section-toggle");
  assert.equal(document.querySelectorAll(".thread-row").length, 1);
  assert.equal(document.querySelector(".section-mark"), null);
  assert.equal(localStorage.getItem(MOBILE_FOLDED_KEY), "[]");
});

test("a Mac with no threads still shows a group to start one in", () => {
  const line = openPhone({ paired: true });
  act(() => line.onopen?.());
  const bare: MobileView = { groups: [{ projectId: null, name: "Recents", threads: [] }], activity: { priority: [], running: [], threads: [], snoozed: [] }, theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" }, thread: null, draft: null, error: null };
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "snapshot", sequence: 1, sessionId: "s6", build: BUILD, view: bare }) }));
  assert.ok(document.querySelector(".group-header .section-action"), "the empty group still offers New");
  assert.equal(document.querySelector(".group-empty"), null, "one empty line for the whole list, not one per group");
  assert.match(document.querySelector(".empty")?.textContent ?? "", /No threads yet/);
  click(".empty .primary");
  assert.deepEqual(lastCommand(line), { type: "task.new" }, "the plain way to start goes to whatever project the Mac has open");
});

test("the list ranks by what wants the user when asked, and a Priority row can be filed away", () => {
  const line = openPhone({ paired: true });
  const ranked = view();
  ranked.activity = {
    priority: [
      { id: "t1", title: "Fix the parser", projectId: "p", projectName: "App", status: "awaiting-approval", lastActivityAt: 1, unread: true, attention: false },
      { id: "t3", title: "Nightly check", projectId: null, projectName: null, status: "idle", lastActivityAt: 1, unread: true, attention: true, outcome: "finished", headline: "Tests are red on main" },
    ],
    running: [{ id: "t2", title: "Rewrite the docs", projectId: "p", projectName: "App", status: "running", lastActivityAt: 1, unread: false, attention: false }],
    threads: [],
    snoozed: [],
  };
  live(line, ranked);
  assert.equal(localStorage.getItem("aicodingtool.mobile.list"), null);
  click('.segmented button[aria-checked="false"]');
  assert.equal(localStorage.getItem("aicodingtool.mobile.list"), "activity", "the choice survives a visit");
  assert.deepEqual([...document.querySelectorAll(".section-toggle > span:first-child")].map((node) => node.textContent), ["Priority", "Running", "Threads"]);
  assert.match(document.querySelector(".thread-headline")?.textContent ?? "", /Tests are red/);
  assert.match(document.querySelectorAll(".thread-meta")[1]?.textContent ?? "", /^No project · Done/);
  assert.equal(document.querySelectorAll(".thread-dismiss").length, 1, "only a settled row is filed away; a blocked one is answered");
  click(".thread-dismiss");
  assert.deepEqual(lastCommand(line), { type: "task.dismiss", taskId: "t3" }, "a dismissal goes at once");
  patchView(line, 2, { activity: { ...ranked.activity, priority: ranked.activity.priority.slice(0, 1) } });
  assert.equal(document.querySelectorAll(".thread-dismiss").length, 0);
});

test("Dismiss all is sent at once", () => {
  try {
    const line = openPhone({ paired: true });
    const ranked = view();
    const row = { projectId: "p", projectName: "App", status: "idle", lastActivityAt: 1, unread: true, attention: true, outcome: "finished" } as const;
    ranked.activity = { priority: [{ ...row, id: "a", title: "One" }, { ...row, id: "b", title: "Two" }], running: [], threads: [], snoozed: [] };
    live(line, ranked);
    click('.segmented button[aria-checked="false"]');
    clickButton("Dismiss all");
    assert.deepEqual(lastCommand(line), { type: "task.dismiss-all" });
  } finally {
    localStorage.removeItem("aicodingtool.mobile.list");
  }
});

test("the activity list narrows to one project, remembers it, and dismisses only its rows", () => {
  const line = openPhone({ paired: true });
  const ranked = view();
  ranked.groups.push({ projectId: "q", name: "Docs", threads: [] }, { projectId: null, name: "Recents", threads: [] });
  ranked.activity = {
    priority: [
      { id: "t1", title: "Fix the parser", projectId: "p", projectName: "App", status: "idle", lastActivityAt: 1, unread: true, attention: true, outcome: "finished" },
      { id: "t3", title: "Write the guide", projectId: "q", projectName: "Docs", status: "idle", lastActivityAt: 1, unread: true, attention: true, outcome: "finished" },
    ],
    running: [], threads: [], snoozed: [],
  };
  live(line, ranked);
  click('.segmented button[aria-checked="false"]');
  const titles = () => [...document.querySelectorAll(".thread-title")].map((node) => node.textContent);
  assert.equal(document.querySelector(".list-filter")?.textContent, "All projects");
  assert.deepEqual(titles(), ["Fix the parser", "Write the guide"]);
  click(".list-filter");
  assert.deepEqual([...document.querySelectorAll('.sheet [role="radio"]')].map((node) => node.textContent), ["All projects", "App", "Docs"]);
  assert.equal(document.activeElement?.textContent, "All projects", "the keyboard stays down until the field is tapped");
  typeInto('.sheet-search input', "do");
  assert.deepEqual([...document.querySelectorAll('.sheet [role="radio"]')].map((node) => node.textContent), ["Docs"]);
  typeInto('.sheet-search input', "");
  click('.sheet [role="radio"]:nth-of-type(3)');
  assert.equal(localStorage.getItem("aicodingtool.mobile.activity-project"), "q", "the choice survives a visit");
  assert.equal(document.querySelector(".list-filter")?.textContent, "Docs");
  assert.deepEqual(titles(), ["Write the guide"]);
  clickButton("Dismiss all");
  click('.bar button[aria-label="New thread"]');
  assert.deepEqual(frameOf(line, "task.dismiss-all").command, { type: "task.dismiss-all", projectId: "q" });
  localStorage.removeItem("aicodingtool.mobile.activity-project");
  localStorage.removeItem("aicodingtool.mobile.list");
});

test("while a run is going a message may join the queue or cut into it, and a queued one can be steered or dropped", () => {
  const line = openPhone({ paired: true });
  const busy = view();
  busy.thread = { ...busy.thread!, approval: null, status: "running", queued: [{ id: "q1", text: "then deploy" }, { id: "q2", text: "then tag", steering: true }] };
  live(line, busy);
  click(".thread-row .thread-open");
  assert.ok(document.querySelector('button[aria-label="Stop this run"]'));
  assert.equal(document.querySelector(".composer-pill"), null, "nothing typed, nothing to steer");
  typeInto(".composer-card textarea", "also lint");
  const bar = [...document.querySelectorAll(".composer-bar button")].map((node) => node.getAttribute("aria-label") ?? node.textContent);
  assert.deepEqual(bar.slice(1), ["Stop this run", "Steer now", "Queue"], "with words typed, Queue takes the right-most place and Stop moves aside");
  clickButton("Steer now", ".composer");
  assert.deepEqual(lastCommand(line), { type: "task.send", taskId: "t1", text: "also lint", steer: true });
  typeInto(".composer-card textarea", "and format");
  clickButton("Queue", ".composer");
  assert.deepEqual(lastCommand(line), { type: "task.send", taskId: "t1", text: "and format" });
  assert.equal(document.querySelectorAll(".queued").length, 2);
  assert.equal(document.querySelectorAll(".queued-steer").length, 1, "a message already on its way has no controls");
  click(".queued-steer");
  assert.deepEqual(lastCommand(line), { type: "task.steer-queued", taskId: "t1", messageId: "q1" });
  assert.equal(document.querySelector(".composer-bar button:last-child")?.getAttribute("aria-label"), "Stop this run", "with nothing typed, Stop is back on the right");
  typeInto(".composer-card textarea", "half a thought");
  click(".queued-drop");
  assert.deepEqual(lastCommand(line), { type: "task.drop-queued", taskId: "t1", messageId: "q1" });
  assert.equal(document.querySelector<HTMLTextAreaElement>(".composer-card textarea")?.value, "half a thought\n\nthen deploy", "a removed message's words come back to the field");
});

test("a blocking question takes the message field's place until it is answered", () => {
  const line = openPhone({ paired: true });
  const asked = view();
  asked.thread = { ...asked.thread!, approval: null, status: "running", question: {
    id: "q", questionId: "q", runId: "r1", requestId: "request", header: "Marker", question: "Which marker?",
    options: [{ label: "ALPHA", description: "First" }], blocking: true,
  } };
  live(line, asked);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".composer-card textarea"), null);
  assert.equal(document.querySelectorAll(".composer textarea").length, 1, "one field: the answer");
  assert.equal(document.querySelector(".send-button")?.getAttribute("aria-label"), "Stop this run", "the run can still be stopped");
  assert.ok(document.querySelector(".composer-settings"));
});

test("the reply that closes a turn can be copied whole", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  const copy = document.querySelector(".answer-meta .copy-affordance");
  assert.equal(copy?.getAttribute("aria-label"), "Copy reply");
  assert.equal(document.querySelectorAll(".answer-meta .copy-affordance").length, 1);
});

test("the thread menu moves the thread between checkouts, forks it, renames it and archives it", () => {
  const line = openPhone({ paired: true });
  const housed = view();
  housed.thread = { ...housed.thread!, location: { kind: "worktree", name: "Feature", threads: 2 }, worktreeId: "wt-1", worktrees: [{ id: "wt-2", name: "Spike", branch: "spike" }], changes: { branch: "feature", files: 3, additions: 10, deletions: 2 } };
  live(line, housed);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".bar-title p")?.textContent, "App · Feature");
  click('button[aria-label="Thread options"]');
  assert.match(document.querySelector(".menu-row .menu-copy small")?.textContent ?? "", /3 files · \+10 −2/);
  clickRow("Location");
  assert.deepEqual([...document.querySelectorAll(".location-option strong")].map((node) => node.textContent), ["App", "Feature", "Spike", "New worktree"]);
  click('.location-option[aria-checked="false"]:not(:disabled)');
  assert.deepEqual(lastCommand(line), { type: "task.move-worktree", taskId: "t1", destination: { kind: "local" } });

  click('button[aria-label="Thread options"]');
  clickRow("New thread here");
  assert.deepEqual(lastCommand(line), { type: "task.new", projectId: "p", worktreeId: "wt-1" });
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "New thread");
});

test("a thread's changes are read from the Mac on demand, and a file opens to its patch", async () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Changes");
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "Changes");
  const asked = queries(line);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.query, { kind: "diff-summary", taskId: "t1", range: { kind: "uncommitted" } });
  await act(async () => line.onmessage?.({ data: JSON.stringify({ kind: "answer", sequence: 2, requestId: asked[0]!.requestId, ok: true, result: {
    status: "available", range: { kind: "uncommitted" }, ignoreWhitespace: true, additions: 1, deletions: 1,
    files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
  } }) }));
  assert.match(document.querySelector(".changes-progress")?.textContent ?? "", /1 file/);
  click(".diff-file-row");
  const patch = queries(line).at(-1)!;
  assert.deepEqual(patch.query, { kind: "diff-patch", taskId: "t1", range: { kind: "uncommitted" }, path: "src/a.ts" });
  await act(async () => {
    line.onmessage?.({ data: JSON.stringify({ kind: "answer", sequence: 3, requestId: patch.requestId, ok: true, result: { status: "available", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const label = 'old';\n+const label = 'new';\n" } }) });
    await ensureLanguage("typescript");
  });
  assert.deepEqual([...document.querySelectorAll(".diff-line")].map((node) => node.className), ["diff-line hunk", "diff-line delete", "diff-line add"]);
  assert.equal(document.querySelector(".diff-line.add code")?.textContent, "const label = 'new';");
  for (const kind of ["add", "delete"]) {
    const tokens = [...document.querySelectorAll<HTMLSpanElement>(`.diff-line.${kind} code span`)];
    assert.equal(tokens.find((token) => token.textContent === "const")?.style.color, "var(--syntax-keyword)");
    assert.ok(tokens.some((token) => token.style.color === "var(--syntax-string)"), "strings have their own colour on both sides");
  }

  click('.changes-toolbar .segmented button[aria-checked="false"]');
  assert.deepEqual(queries(line).at(-1)!.query, { kind: "diff-summary", taskId: "t1", range: { kind: "branches", base: "HEAD", compare: null } });
  click('button[aria-label="Back to thread"]');
  assert.equal(document.querySelector(".bar-title h1")?.textContent, "Fix the parser");
});

test("the phone wears the theme the Mac sends and remembers it for the next visit", () => {
  const line = openPhone({ paired: true });
  const themed = view();
  themed.theme = { dark: "nord", light: "nord-snow", mode: "light" };
  live(line, themed);
  assert.equal(document.documentElement.dataset.theme, "nord-snow");
  assert.deepEqual(JSON.parse(localStorage.getItem("aicodingtool.mobile.theme")!), themed.theme);
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "patch", sequence: 2, patch: { theme: { dark: "nord", light: "nord-snow", mode: "dark" } } }) }));
  assert.equal(document.documentElement.dataset.theme, "nord");
});

test("the phone names a mode, model or effort only a newer build knows as it was sent", () => {
  assert.deepEqual(settingsSummary({ engine: "claude", model: "opus-next" as never, effort: "galaxy" as never, policy: "yolo" as never }), { mode: "yolo", model: "opus-next", effort: "galaxy" });
  assert.deepEqual(settingsSummary({ engine: "claude", model: "opus", effort: "high", policy: "confirm" }).effort, "High");
});

function frameOf(line: FakeSocket, type: string) {
  const frame = line.sent.findLast((item) => item.kind === "command" && item.command.type === type);
  assert.ok(frame && frame.kind === "command", `no ${type} sent`);
  return frame;
}

test("archiving a thread from its menu asks first, and only Archive archives it and goes back to the list", () => {
  const line = openPhone({ paired: true });
  const running = view();
  running.thread = { ...running.thread!, status: "running" };
  live(line, running);
  click(".thread-row .thread-open");
  const sent = line.sent.length;
  click('button[aria-label="Thread options"]');
  clickRow("Archive…");
  assert.equal(document.querySelector(".sheet-head h2")?.textContent, "Archive “Fix the parser”?");
  assert.match(document.querySelector(".sheet-lead")?.textContent ?? "", /^Its run stops/);
  clickButton("Cancel", ".sheet");
  assert.equal(line.sent.length, sent, "Cancel archives nothing");
  assert.equal(document.querySelector(".thread-list"), null, "the thread stays open");

  click('button[aria-label="Thread options"]');
  clickRow("Archive…");
  clickRow("Archive");
  assert.deepEqual(lastCommand(line), { type: "task.archive", taskId: "t1" });
  assert.ok(document.querySelector(".thread-list"), "back on the list");
});

test("an approval answer says it is on its way, and one the Mac turns down can be given again", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click(".approval-actions .allow");
  assert.equal(document.querySelector(".approval-actions .allow")?.textContent, "Allowing…");
  assert.equal(document.querySelector(".approval-actions .deny")?.textContent, "Deny");
  assert.ok(document.querySelector(".approval-actions .allow[data-chosen] .line-spin"), "the chosen answer spins");
  assert.equal(document.querySelector(".approval-actions .deny[data-chosen]"), null, "the other one is not marked chosen");
  const { requestId } = frameOf(line, "run.decide");
  act(() => line.onmessage?.({ data: JSON.stringify({ kind: "ack", sequence: 2, requestId, ok: false, message: "The Mac could not take that answer." }) }));
  assert.ok([...document.querySelectorAll<HTMLButtonElement>(".approval-actions button")].every((node) => !node.disabled), "the card is answerable again");
  assert.equal(document.querySelector(".approval-actions .allow")?.textContent, "Allow once");
  click(".approval-actions .deny");
  assert.deepEqual(lastCommand(line), { type: "run.decide", taskId: "t1", runId: "r1", approvalId: "a1", allow: false });
  assert.equal(document.querySelector(".approval-actions .deny")?.textContent, "Denying…");
  assert.equal(document.querySelector(".approval-actions .allow[data-chosen]"), null);
});

test("a link the phone cannot follow reads as text, and a web link opens", () => {
  const line = openPhone({ paired: true });
  const linked = view();
  linked.thread = { ...linked.thread!, messages: [{ kind: "assistant", text: "See [parser.ts](src/parser.ts) and [the docs](https://example.com/docs).", at: 1 }] };
  live(line, linked);
  click(".thread-row .thread-open");
  const anchors = [...document.querySelectorAll(".markdown a")];
  assert.deepEqual(anchors.map((node) => node.getAttribute("href")), ["https://example.com/docs"]);
  assert.match(document.querySelector(".markdown")?.textContent ?? "", /See parser\.ts and the docs/);
});

test("a run of several tool calls opens to list each one in order", () => {
  const line = openPhone({ paired: true });
  const worked = view();
  worked.thread = { ...worked.thread!, messages: [{ kind: "tool", text: "Read", at: 1 }, { kind: "tool", text: "Bash", at: 2 }, { kind: "tool", text: "Read", at: 3 }, { kind: "assistant", text: "ok", at: 4 }, { kind: "tool", text: "Edit", at: 5 }] };
  live(line, worked);
  click(".thread-row .thread-open");
  const [several, single] = [...document.querySelectorAll(".work")];
  assert.equal(single?.querySelector("button"), null, "a single call has nothing more to show");
  assert.equal(single?.querySelector(".work-count"), null, "nor a count that looks like one");
  assert.ok(single?.hasAttribute("data-single"), "a lone call is drawn as a plain line, not a card that opens");
  assert.equal(several?.hasAttribute("data-single"), false);
  const toggle = several?.querySelector<HTMLButtonElement>("button.work-row");
  assert.equal(toggle?.getAttribute("aria-expanded"), "false");
  assert.equal(several?.querySelector(".work-calls"), null);
  act(() => void toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.equal(toggle?.getAttribute("aria-expanded"), "true");
  assert.deepEqual([...several!.querySelectorAll(".work-calls li")].map((node) => node.textContent), ["Read", "Bash", "Read"]);
});

test("Cmd or Ctrl+Enter sends from a hardware keyboard, and a bare Enter stays a newline", () => {
  const line = openPhone({ paired: true });
  const idle = view();
  idle.thread = { ...idle.thread!, approval: null, status: "idle" };
  live(line, idle);
  click(".thread-row .thread-open");
  const field = document.querySelector<HTMLTextAreaElement>(".composer-card textarea")!;
  act(() => field.focus());
  typeInto(".composer-card textarea", "ship it");
  act(() => void field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(lastCommand(line), { type: "task.select", taskId: "t1" });
  act(() => void field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
  assert.deepEqual(lastCommand(line), { type: "task.send", taskId: "t1", text: "ship it" });
  assert.equal(field.value, "");
});

test("the settings summary names its values to a reader and Tab stays inside the sheet it opens", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".composer-settings")?.getAttribute("aria-label"), "Thread settings: Confirm, Opus, High");
  click(".composer-settings");
  const sheet = document.querySelector(".sheet")!;
  const stops = [...sheet.querySelectorAll<HTMLButtonElement>("button")];
  act(() => stops.at(-1)!.focus());
  act(() => void stops.at(-1)!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, stops[0]);
  act(() => void stops[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, stops.at(-1));
});

test("a phone with no notice still says how to pair", () => {
  openPhone();
  assert.match(document.querySelector(".gate p")?.textContent ?? "", /Scan the QR code on your computer/);
  assert.equal(document.querySelector(".gate .gate-path")?.textContent, "Settings › Devices › Pair a phone");
});

test("the list's bar starts a thread in the project worked in last, and a thread's bar has no such button", () => {
  const line = openPhone({ paired: true });
  live(line);
  click('.bar button[aria-label="New thread"]');
  assert.deepEqual(lastCommand(line), { type: "task.new", projectId: "p" });
  assert.equal(document.querySelector(".bar-title p")?.textContent, "App");
  click('button[aria-label="Back to threads"]');
  click(".thread-row .thread-open");
  assert.equal(document.querySelector('.bar button[aria-label="New thread"]'), null);
});

test("an approval opens a short tool input before the answer, and keeps a long one folded", () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  assert.equal(document.querySelector(".approval details")?.hasAttribute("open"), true, "a short input is read before Allow once");
  assert.equal(document.querySelector(".approval-actions .allow")?.textContent, "Allow once");

  const long = view();
  long.thread = { ...long.thread!, approval: { ...long.thread!.approval!, approvalId: "a2", detail: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") } };
  live(line, long);
  assert.equal(document.querySelector(".approval details")?.hasAttribute("open"), false);
});

test("a file whose patch could not be read offers Try again, which reads it again, and names its status to a reader", async () => {
  const line = openPhone({ paired: true });
  live(line);
  click(".thread-row .thread-open");
  click('button[aria-label="Thread options"]');
  clickRow("Changes");
  const summary = queries(line).at(-1)!;
  await act(async () => line.onmessage?.({ data: JSON.stringify({ kind: "answer", sequence: 2, requestId: summary.requestId, ok: true, result: {
    status: "available", range: { kind: "uncommitted" }, ignoreWhitespace: true, additions: 1, deletions: 0,
    files: [{ path: "src/new.ts", status: "added", additions: 1, deletions: 0, binary: false }],
  } }) }));
  assert.match(document.querySelector(".diff-file-row")?.textContent ?? "", /new\.ts, Added/);
  click(".diff-file-row");
  const first = queries(line).at(-1)!;
  assert.equal(first.query.kind, "diff-patch");
  await act(async () => line.onmessage?.({ data: JSON.stringify({ kind: "answer", sequence: 3, requestId: first.requestId, ok: false, message: "The Mac could not read it." }) }));
  assert.match(document.querySelector(".diff-error")?.textContent ?? "", /could not read it/);
  const asked = queries(line).length;
  clickButton("Try again", ".diff-file");
  assert.equal(queries(line).length, asked + 1);
  assert.deepEqual(queries(line).at(-1)!.query, first.query);
  assert.equal(document.querySelector(".diff-error"), null, "the file says it is reading again");
});

test("a notice cut short says there is more, and opens to its full length", () => {
  const line = openPhone({ paired: true });
  live(line);
  const scrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.classList.contains("banner-words") ? 60 : 0; } });
  try {
    act(() => line.onmessage?.({ data: JSON.stringify({ kind: "patch", sequence: 2, patch: { error: "The worktree could not be removed because a process still holds files open in it." } }) }));
    assert.equal(document.querySelector(".banner-more")?.textContent, "More");
    assert.equal(document.querySelector(".banner-text")?.getAttribute("aria-expanded"), "false");
    click(".banner-text");
    assert.equal(document.querySelector(".banner")?.getAttribute("data-open"), "true");
    assert.equal(document.querySelector(".banner-text")?.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector(".banner-more")?.textContent, "Less");
    click(".banner-text");
    assert.equal(document.querySelector(".banner")?.getAttribute("data-open"), null);
  } finally {
    if (scrollHeight) Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", scrollHeight);
  }
});

test("the connection's state is said on the list as well as in a thread", () => {
  const line = openPhone({ paired: true });
  live(line);
  const status = () => document.querySelector(".bar .line-status[role=status]");
  assert.equal(status()?.textContent, "", "a live line says nothing");
  act(() => line.onclose?.());
  assert.ok(document.querySelector(".thread-list"));
  assert.match(status()?.textContent ?? "", /Offline|Connecting/);
});
