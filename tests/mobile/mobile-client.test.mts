import assert from "node:assert/strict";
import { test } from "vitest";
import { MOBILE_PROTOCOL_VERSION, type MobileServerMessage, type MobileView } from "../../src/contracts/mobile.ts";
import {
  backoffDelay,
  initialMobileClient,
  MOBILE_OUTBOX_LIMIT,
  MOBILE_RESEND_LIMIT,
  MOBILE_RETRY_MAX_MS,
  MOBILE_SETTLE_MS,
  reduceMobileClient,
  shouldReconnect,
  type MobileClientEffect,
  type MobileClientEvent,
  type MobileClientState,
} from "../../src/mobile/client/protocol.ts";
import { settingsSummary } from "../../src/mobile/format.ts";
import { deviceName, readCredential, readFolded, readOutbox, readPairingCode, socketUrl, withoutPairingCode, writeCredential, writeFolded, writeOutbox, type CredentialStore } from "../../src/mobile/client/storage.ts";

const CODE = "K7M2P9QX";
const TOKEN = "a".repeat(64);

function view(title: string): MobileView {
  return {
    groups: [{ projectId: "p", name: "App", threads: [{ id: "t1", title, projectName: "App", attention: false, status: "idle", lastActivityAt: 1, unread: false }] }],
    activity: { priority: [], running: [], threads: [] }, theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" },
    thread: { id: "t1", title, projectId: "p", projectName: "App", worktreeId: null, messages: [], omitted: 0, streamingTail: null, status: "idle", approval: null, queued: [], settings: { engine: "claude", model: "opus", effort: "high", policy: "confirm" }, location: { kind: "local" }, worktrees: [], canMove: true, changes: null, reviewable: true, branchRange: { kind: "branches", base: "HEAD", compare: null } },
    draft: null,
    error: null,
  };
}

const BUILD = "b7f0c1d2e3a4b5c6";

/** A snapshot from the running server named "one", unless a test says another. */
function snapshot(sequence: number, sessionId = "s1", body = view("Thread"), build = BUILD, instance: string | null = "one"): MobileServerMessage {
  return { kind: "snapshot", sequence, sessionId, build, view: body, ...(instance ? { instance } : {}) };
}

/** Runs a run of events through the reducer and keeps every effect they asked for. */
function run(state: MobileClientState, events: MobileClientEvent[]): { state: MobileClientState; effects: MobileClientEffect[] } {
  return events.reduce<{ state: MobileClientState; effects: MobileClientEffect[] }>((carried, event) => {
    const step = reduceMobileClient(carried.state, event);
    return { state: step.state, effects: [...carried.effects, ...step.effects] };
  }, { state, effects: [] });
}

function sent(effects: MobileClientEffect[]) {
  return effects.flatMap((effect) => (effect.kind === "send" ? [effect.message] : []));
}

function paired(): MobileClientState {
  const start = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone" });
  return run(start, [{ kind: "opened", at: 0 }, { kind: "received", message: snapshot(1) }]).state;
}

test("a page opened with a code trades it for a token and keeps it", () => {
  const start = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  assert.equal(start.entry, "pairing");
  const opened = run(start, [{ kind: "opened", at: 0 }]);
  assert.deepEqual(sent(opened.effects), [{ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: CODE, deviceName: "iPhone" }]);

  const done = run(opened.state, [{ kind: "received", message: { kind: "paired", sequence: 1, deviceId: "d1", deviceName: "iPhone", token: TOKEN } }]);
  assert.equal(done.state.entry, "ready");
  assert.equal(done.state.code, null);
  assert.deepEqual(done.state.credential, { token: TOKEN, deviceId: "d1", deviceName: "iPhone" });
  assert.deepEqual(done.effects.at(-1), { kind: "store", credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" } });
});

test("a refused or expired code stops trying and says to scan a fresh one", () => {
  const start = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  const refused = run(start, [{ kind: "opened", at: 0 }, { kind: "received", message: { kind: "error", sequence: 1, code: "expired-code", message: "gone" } }]);
  assert.equal(refused.state.entry, "blocked");
  assert.equal(refused.state.code, null);
  assert.match(refused.state.notice ?? "", /fresh QR code/);
  assert.equal(shouldReconnect(refused.state), false);
  assert.deepEqual(run(refused.state, [{ kind: "closed" }]).effects, []);
});

test("a phone turned away for a token it no longer holds pairs again with the code it was opened with", () => {
  const start = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: CODE, deviceName: "iPhone" });
  const opened = run(start, [{ kind: "opened", at: 0 }]);
  assert.equal(sent(opened.effects)[0]?.kind, "resume", "a token that may still be good is tried first");
  const refused = run(opened.state, [{ kind: "received", message: { kind: "error", sequence: 0, code: "unauthorized", message: "no" } }]);
  assert.equal(refused.state.entry, "pairing");
  assert.equal(refused.state.credential, null);
  assert.deepEqual(refused.effects, [{ kind: "store", credential: null }, { kind: "disconnect" }, { kind: "connect", delayMs: 0 }]);
  const again = run(refused.state, [{ kind: "opened", at: 0 }]);
  assert.deepEqual(sent(again.effects), [{ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: CODE, deviceName: "iPhone" }]);
});

test("a page the Mac calls out of date fetches itself again", () => {
  const step = run(paired(), [{ kind: "received", message: { kind: "error", sequence: 0, code: "version", message: "old" } }]);
  assert.deepEqual(step.effects, [{ kind: "disconnect" }, { kind: "reload" }, { kind: "connect", delayMs: 500 }], "a reload the page cannot make still leaves the line tried");
  assert.deepEqual(step.state.credential, paired().credential);
});

test("a pairing phone locked out is told what the Mac said rather than that it will try again", () => {
  const pairing = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  const refused = run(pairing, [{ kind: "opened", at: 0 }, { kind: "received", message: { kind: "error", sequence: 0, code: "rate-limited", message: "Too many wrong codes. Wait a few minutes and scan the code again." } }]);
  assert.equal(refused.state.notice, "Too many wrong codes. Wait a few minutes and scan the code again.");
  assert.deepEqual(refused.effects.filter((effect) => effect.kind !== "send"), [{ kind: "disconnect" }]);
  assert.equal(shouldReconnect(refused.state), false, "its code will have expired before the lockout lifts");
});

test("a frame before the first snapshot is answered but does not make the phone live on nothing", () => {
  const start = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone" });
  const step = run(start, [{ kind: "opened", at: 0 }, { kind: "received", message: { kind: "ping", sequence: 1, at: 5 } }]);
  assert.equal(step.state.connection, "connecting");
  assert.deepEqual(sent(step.effects).filter((message) => message.kind === "pong"), [{ kind: "pong", at: 5 }]);
  const live = run(step.state, [{ kind: "received", message: snapshot(2) }]);
  assert.equal(live.state.connection, "live");
});

test("a wake on a line that has gone quiet redials at once as a resume", () => {
  const live = run(paired(), [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { groups: [] } } }]).state;
  assert.deepEqual(run(live, [{ kind: "wake", stale: false }]).effects, [], "a line that is answering is left alone");
  const stale = run(live, [{ kind: "wake", stale: true }]);
  assert.deepEqual(stale.effects, [{ kind: "disconnect" }, { kind: "connect", delayMs: 0 }]);
  assert.equal(stale.state.connection, "resuming");
  assert.equal(stale.state.sessionId, "s1", "the session is kept so the redial replays rather than reloads");
  assert.deepEqual(sent(run(stale.state, [{ kind: "opened", at: 0 }]).effects)[0], { kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: TOKEN, sessionId: "s1", lastSequence: 2 });
});

test("a page opened with neither a code nor a token asks to be shown one", () => {
  const start = initialMobileClient({ credential: null, code: null, deviceName: "iPhone" });
  assert.equal(start.entry, "blocked");
  assert.match(start.notice ?? "", /Scan the QR code/);
});

test("a revoked device forgets its token", () => {
  const live = paired();
  const step = run(live, [{ kind: "received", message: { kind: "error", sequence: 2, code: "unauthorized", message: "no" } }]);
  assert.equal(step.state.credential, null);
  assert.equal(step.state.entry, "blocked");
  assert.deepEqual(step.effects[0], { kind: "store", credential: null });
});

test("a phone that comes back resumes from the sequence it last saw", () => {
  const live = run(paired(), [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { thread: { kind: "changed", id: "t1", delta: { status: "running" } } } } }]).state;
  assert.equal(live.lastSequence, 2);
  const again = run({ ...live, connection: "offline" }, [{ kind: "opened", at: 0 }]);
  assert.deepEqual(sent(again.effects), [{ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: TOKEN, sessionId: "s1", lastSequence: 2 }]);
  assert.equal(again.state.connection, "resuming");
});

test("a replayed message is ignored and a gap forces a fresh snapshot", () => {
  const live = run(paired(), [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { groups: [] } } }]).state;
  const replay = run(live, [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { groups: [{ projectId: null, name: "Recents", threads: [] }] } } }]);
  assert.deepEqual(replay.state.view.groups, []);
  assert.deepEqual(replay.effects, []);

  const gap = run(live, [{ kind: "received", message: { kind: "patch", sequence: 9, patch: { groups: [] } } }]);
  assert.equal(gap.state.lastSequence, 0);
  assert.equal(gap.state.sessionId, null);
  assert.deepEqual(gap.effects, [{ kind: "disconnect" }, { kind: "connect", delayMs: 0 }]);
});

test("a phone turned away for the moment keeps its token and redials", () => {
  const live = paired();
  const step = run(live, [{ kind: "received", message: { kind: "error", sequence: 2, code: "rate-limited", message: "wait" } }]);
  assert.deepEqual(step.state.credential, live.credential, "a phone that is paired stays paired");
  assert.equal(step.state.entry, "ready");
  assert.equal(shouldReconnect(step.state), true);
  assert.deepEqual(step.effects, [{ kind: "disconnect" }, { kind: "connect", delayMs: 500 }]);

  const pairing = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  const refused = run(pairing, [{ kind: "opened", at: 0 }, { kind: "received", message: { kind: "error", sequence: 1, code: "rate-limited", message: "wait" } }]);
  assert.equal(refused.state.entry, "blocked", "a phone with only a code has nothing to redial with");
});

test("a snapshot from a new session is read even though its numbering starts over", () => {
  const live = run(paired(), [{ kind: "received", message: { kind: "patch", sequence: 5, patch: { groups: [] } } }]).state;
  const restarted = run({ ...live, lastSequence: 5 }, [{ kind: "received", message: snapshot(1, "s2", view("Renamed")) }]);
  assert.equal(restarted.state.sessionId, "s2");
  assert.equal(restarted.state.lastSequence, 1);
  assert.equal(restarted.state.view.thread?.title, "Renamed");
});

test("a patch moves the view the phone holds", () => {
  const live = paired();
  const step = run(live, [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { thread: { kind: "changed", id: "t1", delta: { status: "running", spliced: { dropped: 0, kept: 0, messages: [{ kind: "assistant", text: "on it", at: 9 }] } } } } } }]);
  assert.equal(step.state.view.thread?.status, "running");
  assert.deepEqual(step.state.view.thread?.messages, [{ kind: "assistant", text: "on it", at: 9 }]);
});

test("a ping is answered so the Mac knows the line is alive", () => {
  const step = run(paired(), [{ kind: "received", message: { kind: "ping", sequence: 2, at: 1234 } }]);
  assert.deepEqual(sent(step.effects), [{ kind: "pong", at: 1234 }]);
  assert.equal(step.state.connection, "live");
});

test("what is sent offline is queued and goes the moment the line is back", () => {
  const offline = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone" });
  const queued = run(offline, [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" }, at: 0 }]);
  assert.deepEqual(sent(queued.effects), []);
  assert.equal(queued.state.outbox.length, 1);

  const back = run(queued.state, [{ kind: "opened", at: 0 }, { kind: "received", message: snapshot(1) }]);
  assert.deepEqual(sent(back.effects).at(-1), { kind: "command", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" } });
  assert.equal(back.state.outbox[0]?.sent, true);
});

test("an acknowledged command leaves the queue and a refused one says why", () => {
  const live = paired();
  const asked = run(live, [{ kind: "dispatch", requestId: "r1", command: { type: "run.cancel", taskId: "t1" }, at: 0 }]);
  assert.deepEqual(sent(asked.effects), [{ kind: "command", requestId: "r1", command: { type: "run.cancel", taskId: "t1" } }]);
  const acked = run(asked.state, [{ kind: "received", message: { kind: "ack", sequence: 2, requestId: "r1", ok: false, message: "nothing to cancel" } }]);
  assert.deepEqual(acked.state.outbox, []);
  assert.equal(acked.state.notice, "nothing to cancel");
});

test("a line that comes back writes everything still owed at once, in the order it was asked", () => {
  const live = paired();
  const asked = run(live, [{ kind: "dispatch", requestId: "r1", command: { type: "run.decide", taskId: "t1", runId: "r1", approvalId: "a1", allow: true }, at: 0 }]);
  const offline = run(asked.state, [{ kind: "closed" }, { kind: "dispatch", requestId: "r2", command: { type: "task.send", taskId: "t1", text: "after" }, at: 0 }]);
  const back = run(offline.state, [{ kind: "opened", at: 1 }, { kind: "received", message: { kind: "ping", sequence: 2, at: 1 } }]);
  assert.deepEqual(sent(back.effects).filter((message) => message.kind === "command").map((message) => message.kind === "command" && message.requestId), ["r1", "r2"], "the one written before the drop goes first");
});

test("a settle that lands before the line is live asks again rather than stranding the command", () => {
  const asked = run(paired(), [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "deploy" }, at: 0 }]);
  assert.equal(asked.state.outbox[0]?.sent, true);
  const resuming = run(asked.state, [{ kind: "closed" }, { kind: "opened", at: 0 }]);
  assert.equal(resuming.state.connection, "resuming");

  const early = run(resuming.state, [{ kind: "settled" }]);
  assert.deepEqual(early.effects, [{ kind: "settle", delayMs: MOBILE_SETTLE_MS }], "the window was re-armed, not dropped");

  const back = run(early.state, [{ kind: "received", message: snapshot(1, "s2") }]);
  assert.deepEqual(sent(back.effects), [{ kind: "command", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "deploy" } }], "the Mac runs it once, however often it is written");
  const settled = run(back.state, [{ kind: "settled" }]);
  assert.deepEqual(sent(settled.effects), [{ kind: "command", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "deploy" } }]);
});

test("an outbox with no room refuses rather than throwing away what the user typed", () => {
  let carried = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone" });
  for (let index = 0; index < MOBILE_OUTBOX_LIMIT; index += 1) {
    carried = run(carried, [{ kind: "dispatch", requestId: `r${index}`, command: { type: "task.send", taskId: "t1", text: `message ${index}` }, at: 0 }]).state;
  }
  const full = run(carried, [{ kind: "dispatch", requestId: "over", command: { type: "task.send", taskId: "t1", text: "one too many" }, at: 0 }]);
  assert.equal(full.state.outbox.length, MOBILE_OUTBOX_LIMIT);
  assert.equal(full.state.outbox[0]?.requestId, "r0", "the oldest was kept, not silently dropped");
  assert.equal(full.state.outbox.some((item) => item.requestId === "over"), false);
  assert.match(full.state.notice ?? "", /Too much is already waiting/);
});

test("a dropped line is redialled with a backoff that a wake cuts short", () => {
  assert.equal(backoffDelay(1), 500);
  assert.equal(backoffDelay(3), 2_000);
  assert.equal(backoffDelay(40), MOBILE_RETRY_MAX_MS);
  const dropped = run(paired(), [{ kind: "closed" }, { kind: "closed" }]);
  assert.deepEqual(dropped.effects, [{ kind: "connect", delayMs: 500 }, { kind: "connect", delayMs: 1_000 }]);
  const woken = run(dropped.state, [{ kind: "wake" }]);
  assert.deepEqual(woken.effects, [{ kind: "connect", delayMs: 0 }]);
  assert.equal(woken.state.attempt, 0);
});

test("a page from a build the Mac no longer serves fetches itself again", () => {
  const started = paired();
  assert.equal(started.build, BUILD);

  /** The same build says nothing: a phone that reconnects all day is never reloaded for it. */
  const again = run(started, [{ kind: "received", message: snapshot(2, "s2") }]);
  assert.deepEqual(again.effects.filter((effect) => effect.kind === "reload"), []);
  assert.equal(again.state.view.thread?.title, "Thread");

  const rebuilt = run(again.state, [{ kind: "received", message: snapshot(3, "s3", view("Newer"), "0000111122223333") }]);
  assert.deepEqual(rebuilt.effects.filter((effect) => effect.kind === "reload"), [{ kind: "reload" }]);
  /** A reload the page cannot make leaves it on the newest view, never live on a stale one, and told to reload. */
  assert.equal(rebuilt.state.view.thread?.title, "Newer");
  assert.equal(rebuilt.state.sessionId, "s3");
  assert.match(rebuilt.state.notice ?? "", /Reload/);
  assert.deepEqual(again.effects.filter((effect) => effect.kind === "current"), [{ kind: "current" }], "agreeing on the build lets the next change reload the page again");
});

test("a command the Mac could not read is refused here rather than sent, and moves between screens are not stacked up offline", () => {
  const live = paired();
  const bad = run(live, [{ kind: "dispatch", requestId: "bad", command: { type: "task.rename", taskId: "t1", title: "x".repeat(5_000) }, at: 0 }]);
  assert.deepEqual(bad.state.outbox, []);
  assert.deepEqual(sent(bad.effects), []);
  assert.match(bad.state.notice ?? "", /could not be sent/);
  const moves = run(live, [{ kind: "closed" },
    { kind: "dispatch", requestId: "a", command: { type: "task.select", taskId: "t1" }, at: 0 },
    { kind: "dispatch", requestId: "b", command: { type: "task.new", projectId: "p" }, at: 0 },
    { kind: "dispatch", requestId: "c", command: { type: "task.select", taskId: "t2" }, at: 0 }]);
  assert.deepEqual(moves.state.outbox.map((item) => item.requestId), ["c"], "only the last of several moves is kept");
  const depended = run(live, [{ kind: "closed" },
    { kind: "dispatch", requestId: "a", command: { type: "task.new", projectId: "p" }, at: 0 },
    { kind: "dispatch", requestId: "b", command: { type: "view.set-prompt", prompt: "hello" }, at: 0 },
    { kind: "dispatch", requestId: "c", command: { type: "task.send" }, at: 0 },
    { kind: "dispatch", requestId: "d", command: { type: "task.select", taskId: "t2" }, at: 0 }]);
  assert.deepEqual(depended.state.outbox.map((item) => item.requestId), ["a", "b", "c", "d"], "a move something later depends on stays");
});

test("what was written to a server that has since restarted is let go of, not run twice", () => {
  const first = run(paired(), [{ kind: "received", message: { ...snapshot(2, "s1"), instance: "one" } as MobileServerMessage }]);
  const asked = run(first.state, [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" }, at: 0 }]);
  assert.equal(asked.state.outbox[0]?.instance, "one");
  const whole = run(asked.state, [{ kind: "received", message: snapshot(3, "s1", view("Thread"), BUILD, null) }]);
  assert.equal(whole.state.outbox.length, 1, "a whole view within the same session is the same server, which remembers");
  const offline = run(asked.state, [{ kind: "closed" }, { kind: "dispatch", requestId: "r2", command: { type: "task.send", taskId: "t1", text: "unsent" }, at: 0 }]);
  const restarted = run(offline.state, [{ kind: "opened", at: 0 }, { kind: "received", message: { ...snapshot(1, "s2"), instance: "two" } as MobileServerMessage }]);
  assert.deepEqual(sent(restarted.effects).filter((message) => message.kind === "command").map((message) => message.kind === "command" && message.requestId), ["r2"]);
  assert.match(restarted.state.notice ?? "", /restarted/);
  const unnamed = run(offline.state, [{ kind: "opened", at: 0 }, { kind: "received", message: snapshot(1, "s2", view("Thread"), BUILD, null) }]);
  assert.deepEqual(unnamed.state.outbox.map((item) => item.requestId), ["r2"], "a server that does not say which it is cannot be trusted to remember");
  const legacy = run(paired(), [{ kind: "dispatch", requestId: "old", command: { type: "task.send", taskId: "t1", text: "hi" }, at: 0 }]);
  const stripped = { ...legacy.state, outbox: legacy.state.outbox.map((item) => ({ ...item, instance: undefined })) };
  const after = run(stripped, [{ kind: "closed" }, { kind: "opened", at: 0 }, { kind: "received", message: { ...snapshot(1, "s3"), instance: "two" } as MobileServerMessage }]);
  assert.deepEqual(after.state.outbox, [], "one written to a server that never said which it was is let go of too");
  const same = run(offline.state, [{ kind: "opened", at: 0 }, { kind: "received", message: { ...snapshot(1, "s2"), instance: "one" } as MobileServerMessage }]);
  assert.deepEqual(sent(same.effects).filter((message) => message.kind === "command").map((message) => message.kind === "command" && message.requestId), ["r1", "r2"], "the same server remembers, so it is asked again");
});

test("a stop asked long before the line came back is dropped, not carried out late", () => {
  const offline = run(paired(), [{ kind: "closed" }, { kind: "dispatch", requestId: "stop", command: { type: "run.cancel", taskId: "t1" }, at: 1_000 }]);
  const late = run(offline.state, [{ kind: "opened", at: 1_000 + 60_000 }, { kind: "received", message: { kind: "ping", sequence: 2, at: 1 } }]);
  assert.deepEqual(sent(late.effects).filter((message) => message.kind === "command"), []);
  assert.deepEqual(late.state.outbox, []);
  assert.match(late.state.notice ?? "", /not sent/);
  const soon = run(offline.state, [{ kind: "opened", at: 1_000 + 5_000 }, { kind: "received", message: { kind: "ping", sequence: 2, at: 1 } }]);
  assert.equal(sent(soon.effects).filter((message) => message.kind === "command").length, 1);
});

test("a live line writes again what stays unanswered, and gives up after a few tries", () => {
  let step = run(paired(), [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" }, at: 0 }]);
  for (let index = 1; index < MOBILE_RESEND_LIMIT; index += 1) {
    step = run(step.state, [{ kind: "remind" }]);
    assert.equal(sent(step.effects).length, 1, `write ${index + 1}`);
  }
  step = run(step.state, [{ kind: "remind" }]);
  assert.deepEqual(step.state.outbox, []);
  assert.match(step.state.notice ?? "", /did not answer/);
  assert.deepEqual(step.effects.at(-1), { kind: "keep", outbox: [] }, "what is given up on is forgotten where it was kept");
});

test("a message the Mac refuses comes back to the screen that sent it", () => {
  const asked = run(paired(), [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "my words" }, at: 0 }]);
  const refused = run(asked.state, [{ kind: "received", message: { kind: "ack", sequence: 2, requestId: "r1", ok: false, message: "Busy" } }]);
  assert.deepEqual(refused.state.returned, { requestId: "r1", command: { type: "task.send", taskId: "t1", text: "my words" }, message: "Busy" });
});

test("a patch that does not fit the view held, or a gap in the numbering, fetches the view whole", () => {
  const live = paired();
  const misfit = run(live, [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { thread: { kind: "changed", id: "t1", delta: { tail: { from: 40, text: "more" } } } } } }]);
  assert.equal(misfit.state.sessionId, null);
  assert.deepEqual(misfit.effects, [{ kind: "disconnect" }, { kind: "connect", delayMs: 0 }]);
  const skipped = run(live, [{ kind: "skipped", sequence: 2 }, { kind: "received", message: { kind: "ping", sequence: 3, at: 1 } }]);
  assert.equal(skipped.state.lastSequence, 3, "a frame this page could not read still holds its place");
  assert.equal(skipped.state.connection, "live");
  const again = run(misfit.state, [{ kind: "skipped", sequence: 9 }]);
  assert.equal(again.state.lastSequence, 9, "with no session yet there is nothing to have missed");
});

test("what was owed survives a reload, sent again from the start", () => {
  const store = new Map<string, string>();
  const shelf: CredentialStore = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); }, removeItem: (key) => { store.delete(key); } };
  const asked = run(paired(), [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" }, at: 5 }]);
  const kept = asked.effects.find((effect) => effect.kind === "keep");
  assert.ok(kept?.kind === "keep");
  writeOutbox(shelf, kept.outbox);
  const restored = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone", outbox: readOutbox(shelf) });
  assert.deepEqual(restored.outbox.map((item) => [item.requestId, item.sent]), [["r1", true]], "it is still known to have been written, so a restarted computer is not handed it again");
  const back = run(restored, [{ kind: "opened", at: 5 }, { kind: "received", message: snapshot(1) }]);
  assert.deepEqual(sent(back.effects).filter((message) => message.kind === "command").map((message) => message.kind === "command" && message.requestId), ["r1"], "and the same computer is asked again");
  writeOutbox(shelf, []);
  assert.equal(store.size, 0);
});

test("the pairing code is read from the fragment, the query, and nowhere else", () => {
  assert.equal(readPairingCode(`https://mac.ts.net/m#pair=${CODE}`), CODE);
  assert.equal(readPairingCode(`https://mac.ts.net/m?pair=${CODE.toLowerCase()}`), CODE);
  assert.equal(readPairingCode("https://mac.ts.net/m"), null);
  assert.equal(readPairingCode("https://mac.ts.net/m#pair=SHORT"), null);
  assert.equal(readPairingCode("https://mac.ts.net/m#pair=IIIIIIII"), null);
  assert.equal(withoutPairingCode(`https://mac.ts.net/m?pair=${CODE}`), "/m");
  assert.equal(withoutPairingCode(`https://mac.ts.net/m#pair=${CODE}`), "/m");
});

test("the socket sits beside the page the same server handed over", () => {
  assert.equal(socketUrl("https://mac.ts.net/m#pair=X"), "wss://mac.ts.net/m/socket");
  assert.equal(socketUrl("http://127.0.0.1:7737/m/"), "ws://127.0.0.1:7737/m/socket");
});

test("a stored credential is only believed when it is whole", () => {
  const held = new Map<string, string>();
  const store: CredentialStore = {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
  assert.equal(readCredential(store), null);
  writeCredential(store, { token: TOKEN, deviceId: "d1", deviceName: "iPhone" });
  assert.deepEqual(readCredential(store), { token: TOKEN, deviceId: "d1", deviceName: "iPhone" });
  store.setItem("aicodingtool.mobile.device", "{\"token\":\"\"}");
  assert.equal(readCredential(store), null);
  store.setItem("aicodingtool.mobile.device", "not json");
  assert.equal(readCredential(store), null);
  writeCredential(store, null);
  assert.equal(readCredential(store), null);
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14)"), "Android phone");
});

test("folded groups survive a visit, and a store holding garbage folds nothing", () => {
  const items = new Map<string, string>();
  const store: CredentialStore = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
  assert.deepEqual([...readFolded(store)], []);
  writeFolded(store, new Set(["p1", "recents"]));
  assert.deepEqual([...readFolded(store)], ["p1", "recents"]);
  items.set("aicodingtool.mobile.folded", "{not json");
  assert.deepEqual([...readFolded(store)], []);
  items.set("aicodingtool.mobile.folded", JSON.stringify([1, "p2", null]));
  assert.deepEqual([...readFolded(store)], ["p2"], "only names are kept");
});

test("the composer reads settings as labels, and says no effort for a model that takes none", () => {
  assert.deepEqual(settingsSummary({ engine: "codex", model: "gpt-6.1-sol", effort: "high", policy: "confirm", fastMode: true }), { mode: "Confirm", model: "Sol · Fast", effort: "High" });
  assert.deepEqual(settingsSummary({ engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", policy: "allow-edits" }), { mode: "Edits", model: "Sol", effort: "Extra high" });
  assert.deepEqual(settingsSummary({ engine: "claude", model: "opus", effort: "high", policy: "autonomous" }), { mode: "Auto", model: "Opus", effort: "High" });
  assert.deepEqual(settingsSummary({ engine: "claude", model: "haiku", effort: "high", policy: "confirm" }), { mode: "Confirm", model: "Haiku", effort: null });
});

test("a dismissed error stays away until the Mac says something else", () => {
  const start = paired();
  const shown = run(start, [{ kind: "received", message: snapshot(2, "s1", { ...view("Thread"), error: "x" }) }]).state;
  assert.equal(shown.view.error, "x");
  assert.equal(shown.dismissedError, null);

  const dismissed = reduceMobileClient(shown, { kind: "dismiss-notice" }).state;
  assert.equal(dismissed.dismissedError, "x", "the same sentence is not shown again");

  const again = run(dismissed, [{ kind: "received", message: { kind: "patch", sequence: 3, patch: { error: "y" } } }]).state;
  assert.equal(again.view.error, "y");
  assert.notEqual(again.view.error, again.dismissedError, "a different error is shown");
  const cleared = run(reduceMobileClient(again, { kind: "dismiss-notice" }).state, [{ kind: "received", message: { kind: "patch", sequence: 4, patch: { error: null } } }]).state;
  const back = run(cleared, [{ kind: "received", message: { kind: "patch", sequence: 5, patch: { error: "y" } } }]).state;
  assert.equal(back.dismissedError, null, "the same sentence, said again after it was cleared, is shown");
});
