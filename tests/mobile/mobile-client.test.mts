import assert from "node:assert/strict";
import { test } from "vitest";
import type { MobileServerMessage, MobileView } from "../../src/contracts/mobile.ts";
import {
  backoffDelay,
  initialMobileClient,
  MOBILE_OUTBOX_LIMIT,
  MOBILE_RETRY_MAX_MS,
  MOBILE_SETTLE_MS,
  reduceMobileClient,
  shouldReconnect,
  type MobileClientEffect,
  type MobileClientEvent,
  type MobileClientState,
} from "../../src/mobile/client/protocol.ts";
import { deviceName, readCredential, readPairingCode, socketUrl, withoutPairingCode, writeCredential, type CredentialStore } from "../../src/mobile/client/storage.ts";

const CODE = "K7M2P9QX";
const TOKEN = "a".repeat(64);

function view(title: string): MobileView {
  return {
    groups: [{ projectId: "p", name: "App", threads: [{ id: "t1", title, status: "idle", lastActivityAt: 1, unread: false }] }],
    thread: { id: "t1", title, projectName: "App", messages: [], omitted: 0, streamingTail: null, status: "idle", approval: null, queued: [], prompt: "", settings: { model: "opus", effort: "high", policy: "confirm" } },
    draft: null,
    error: null,
  };
}

function snapshot(sequence: number, sessionId = "s1", body = view("Thread")): MobileServerMessage {
  return { kind: "snapshot", sequence, sessionId, view: body };
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
  return run(start, [{ kind: "opened" }, { kind: "received", message: snapshot(1) }]).state;
}

test("a page opened with a code trades it for a token and keeps it", () => {
  const start = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  assert.equal(start.entry, "pairing");
  const opened = run(start, [{ kind: "opened" }]);
  assert.deepEqual(sent(opened.effects), [{ kind: "pair", version: 1, code: CODE, deviceName: "iPhone" }]);

  const done = run(opened.state, [{ kind: "received", message: { kind: "paired", sequence: 1, deviceId: "d1", deviceName: "iPhone", token: TOKEN } }]);
  assert.equal(done.state.entry, "ready");
  assert.equal(done.state.code, null);
  assert.deepEqual(done.state.credential, { token: TOKEN, deviceId: "d1", deviceName: "iPhone" });
  assert.deepEqual(done.effects.at(-1), { kind: "store", credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" } });
});

test("a refused or expired code stops trying and says to scan a fresh one", () => {
  const start = initialMobileClient({ credential: null, code: CODE, deviceName: "iPhone" });
  const refused = run(start, [{ kind: "opened" }, { kind: "received", message: { kind: "error", sequence: 1, code: "expired-code", message: "gone" } }]);
  assert.equal(refused.state.entry, "blocked");
  assert.equal(refused.state.code, null);
  assert.match(refused.state.notice ?? "", /fresh QR code/);
  assert.equal(shouldReconnect(refused.state), false);
  assert.deepEqual(run(refused.state, [{ kind: "closed" }]).effects, []);
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
  const again = run({ ...live, connection: "offline" }, [{ kind: "opened" }]);
  assert.deepEqual(sent(again.effects), [{ kind: "resume", version: 1, token: TOKEN, sessionId: "s1", lastSequence: 2 }]);
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
  const refused = run(pairing, [{ kind: "opened" }, { kind: "received", message: { kind: "error", sequence: 1, code: "rate-limited", message: "wait" } }]);
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
  const step = run(live, [{ kind: "received", message: { kind: "patch", sequence: 2, patch: { thread: { kind: "changed", id: "t1", delta: { status: "running", appended: [{ kind: "assistant", text: "on it", at: 9 }] } } } } }]);
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
  const queued = run(offline, [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" } }]);
  assert.deepEqual(sent(queued.effects), []);
  assert.equal(queued.state.outbox.length, 1);

  const back = run(queued.state, [{ kind: "opened" }, { kind: "received", message: snapshot(1) }]);
  assert.deepEqual(sent(back.effects).at(-1), { kind: "command", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "hello" } });
  assert.equal(back.state.outbox[0]?.sent, true);
});

test("an acknowledged command leaves the queue and a refused one says why", () => {
  const live = paired();
  const asked = run(live, [{ kind: "dispatch", requestId: "r1", command: { type: "run.cancel", taskId: "t1" } }]);
  assert.deepEqual(sent(asked.effects), [{ kind: "command", requestId: "r1", command: { type: "run.cancel", taskId: "t1" } }]);
  const acked = run(asked.state, [{ kind: "received", message: { kind: "ack", sequence: 2, requestId: "r1", ok: false, message: "nothing to cancel" } }]);
  assert.deepEqual(acked.state.outbox, []);
  assert.equal(acked.state.notice, "nothing to cancel");
});

test("a command whose acknowledgement never arrived is sent again once the replay has settled", () => {
  const live = paired();
  const asked = run(live, [{ kind: "dispatch", requestId: "r1", command: { type: "run.decide", taskId: "t1", allow: true } }]);
  const dropped = run(asked.state, [{ kind: "closed" }, { kind: "opened" }, { kind: "received", message: { kind: "ping", sequence: 2, at: 1 } }]);
  assert.deepEqual(sent(dropped.effects).filter((message) => message.kind === "command"), []);
  const settled = run(dropped.state, [{ kind: "settled" }]);
  assert.deepEqual(sent(settled.effects), [{ kind: "command", requestId: "r1", command: { type: "run.decide", taskId: "t1", allow: true } }]);
});

test("a settle that lands before the line is live asks again rather than stranding the command", () => {
  const asked = run(paired(), [{ kind: "dispatch", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "deploy" } }]);
  assert.equal(asked.state.outbox[0]?.sent, true);
  const resuming = run(asked.state, [{ kind: "closed" }, { kind: "opened" }]);
  assert.equal(resuming.state.connection, "resuming");

  const early = run(resuming.state, [{ kind: "settled" }]);
  assert.deepEqual(early.effects, [{ kind: "settle", delayMs: MOBILE_SETTLE_MS }], "the window was re-armed, not dropped");

  const back = run(early.state, [{ kind: "received", message: snapshot(1, "s2") }]);
  assert.deepEqual(sent(back.effects), [], "a command already written is not repeated the moment the line returns");
  const settled = run(back.state, [{ kind: "settled" }]);
  assert.deepEqual(sent(settled.effects), [{ kind: "command", requestId: "r1", command: { type: "task.send", taskId: "t1", text: "deploy" } }]);
});

test("an outbox with no room refuses rather than throwing away what the user typed", () => {
  let carried = initialMobileClient({ credential: { token: TOKEN, deviceId: "d1", deviceName: "iPhone" }, code: null, deviceName: "iPhone" });
  for (let index = 0; index < MOBILE_OUTBOX_LIMIT; index += 1) {
    carried = run(carried, [{ kind: "dispatch", requestId: `r${index}`, command: { type: "task.send", taskId: "t1", text: `message ${index}` } }]).state;
  }
  const full = run(carried, [{ kind: "dispatch", requestId: "over", command: { type: "task.send", taskId: "t1", text: "one too many" } }]);
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
