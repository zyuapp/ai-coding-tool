import assert from "node:assert/strict";
import { test } from "vitest";
import { isMobileClientMessage, isMobileCommand, isMobileRequest, isMobileResponse, isMobileServerMessage, MOBILE_PROTOCOL_VERSION } from "../../src/contracts/mobile.ts";
import {
  addressOrigin,
  clearPairingFailures,
  createPairingCode,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
  deviceForToken,
  MAX_PAIRING_FAILURES,
  noPairingAttempts,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  pairingCodeLive,
  pairingCodeMatches,
  pairingLocked,
  pairingUrl,
  parsePairingUrl,
  preferredAddress,
  registerPairingFailure,
  type MobileAddress,
  type PairedDevice,
} from "../../src/domain/mobile.ts";

const NOW = 1_800_000_000_000;

test("a phone may drive the conversation and nothing outside it", () => {
  const allowed: unknown[] = [
    { type: "task.new" },
    { type: "task.new", projectId: "project-app", worktreeId: "worktree-1" },
    { type: "task.select", taskId: "task-1" },
    { type: "task.send", text: "look at this" },
    { type: "task.send", taskId: "task-1", steer: true },
    { type: "task.archive", taskId: "task-1" },
    { type: "task.restore", taskId: "task-1" },
    { type: "task.rename", taskId: "task-1", title: "" },
    { type: "task.dismiss", taskId: "task-1" },
    { type: "task.dismiss-all" },
    { type: "task.fork", taskId: "task-1", worktree: true },
    { type: "task.set-policy", policy: "bypass" },
    { type: "task.set-model", taskId: "task-1", engine: "claude", model: "opus" },
    { type: "task.set-effort", engine: "claude", effort: "max" },
    { type: "task.set-effort", taskId: "task-1", engine: "codex", effort: "ultra" },
    { type: "task.steer-queued", messageId: "queued-1" },
    { type: "task.drop-queued", taskId: "task-1", messageId: "queued-1" },
    { type: "run.cancel" },
    { type: "run.decide", allow: false },
    { type: "run.stop-process", taskId: "task-1", processId: "bash-1" },
    { type: "annotation.add", quote: "this line", note: "why?" },
    { type: "annotation.add", quote: "this line", anchor: { kind: "message", messageId: "message-1", start: 0, end: 9 } },
    { type: "annotation.note", annotationId: "annotation-1", note: "" },
    { type: "annotation.remove", annotationId: "annotation-1" },
    { type: "annotation.recall", annotations: [{ id: "annotation-1", quote: "this line", note: "" }] },
    { type: "paste.add", text: "pasted" },
    { type: "paste.remove", pasteId: "paste-1" },
    { type: "paste.recall", pastes: [{ id: "paste-1", text: "pasted" }] },
    { type: "view.set-prompt", prompt: "" },
  ];
  for (const command of allowed) assert.equal(isMobileCommand(command), true, JSON.stringify(command));

  const refused: unknown[] = [
    { type: "terminal.open" },
    { type: "terminal.input", terminalId: "terminal-1", data: "ls" },
    { type: "browser.open", taskId: "task-1", url: "https://example.com" },
    { type: "browser.decide", allow: true },
    { type: "diff.toggle" },
    { type: "app.open-folder", appId: "com.apple.dt.Xcode" },
    { type: "worktree.delete", taskId: "task-1" },
    { type: "project.remove", projectId: "project-app" },
    { type: "view.set-theme", theme: "graphite" },
    { type: "view.shortcut", action: "task.new", surface: "window" },
    { type: "view.close-tab" },
    { type: "image.add", taskId: "task-1", path: "/tmp/shot.png", label: "shot" },
    { type: "task.clear-archive" },
    { type: "task.move", taskId: "task-1", target: { projectId: null, index: 0 } },
    { type: "task.set-worktree", worktree: true },
  ];
  for (const command of refused) assert.equal(isMobileCommand(command), false, JSON.stringify(command));
});

test("mobile command guard rejects wrong shapes and oversized text", () => {
  assert.equal(isMobileCommand(null), false);
  assert.equal(isMobileCommand("task.new"), false);
  assert.equal(isMobileCommand([{ type: "task.new" }]), false);
  assert.equal(isMobileCommand({ type: "task.select" }), false, "selecting names a thread");
  assert.equal(isMobileCommand({ type: "task.select", taskId: "" }), false);
  assert.equal(isMobileCommand({ type: "task.send", taskId: 7 }), false);
  assert.equal(isMobileCommand({ type: "task.send", text: "x".repeat(1_000_001) }), false);
  assert.equal(isMobileCommand({ type: "task.send", attachments: [] }), false, "a phone carries no files");
  assert.equal(isMobileCommand({ type: "task.set-policy", policy: "yolo" }), false);
  assert.equal(isMobileCommand({ type: "task.set-model", engine: "claude", model: "gpt" }), false);
  assert.equal(isMobileCommand({ type: "task.set-effort", engine: "claude", effort: "ultra" }), false, "ultra is Codex's alone");
  assert.equal(isMobileCommand({ type: "task.set-effort", effort: "high" }), false, "an effort names its engine");
  assert.equal(isMobileCommand({ type: "run.decide" }), false);
  assert.equal(isMobileCommand({ type: "run.decide", allow: "yes" }), false);
  assert.equal(isMobileCommand({ type: "view.set-prompt", prompt: 0 }), false);
  assert.equal(isMobileCommand({ type: "annotation.add", quote: "" }), false);
  assert.equal(isMobileCommand({ type: "annotation.add", quote: "q", anchor: { kind: "selection" } }), false);
  assert.equal(isMobileCommand({ type: "annotation.recall", annotations: [{ id: "a" }] }), false);
  assert.equal(isMobileCommand({ type: "annotation.recall", annotations: Array.from({ length: 101 }, (_, index) => ({ id: `a-${index}`, quote: "q", note: "" })) }), false);
  assert.equal(isMobileCommand({ type: "paste.recall", pastes: [{ id: "p", text: "" }] }), false);
});

test("client messages are read defensively, since the phone is the boundary", () => {
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: "ABCD2345", deviceName: "iPhone" }), true);
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: "ABCD2345" }), false);
  assert.equal(isMobileClientMessage({ kind: "pair", version: "1", code: "ABCD2345", deviceName: "iPhone" }), false);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, token: "abc", lastSequence: 0 }), true);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, token: "abc", sessionId: "session-1", lastSequence: 12 }), true);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, token: "abc", lastSequence: -1 }), false);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, token: "abc", lastSequence: 1.5 }), false);
  assert.equal(isMobileClientMessage({ kind: "command", requestId: "request-1", command: { type: "run.cancel" } }), true);
  assert.equal(isMobileClientMessage({ kind: "command", requestId: "request-1", command: { type: "terminal.open" } }), false);
  assert.equal(isMobileClientMessage({ kind: "command", command: { type: "run.cancel" } }), false);
  assert.equal(isMobileClientMessage({ kind: "pong", at: NOW }), true);
  assert.equal(isMobileClientMessage({ kind: "hello" }), false);
});

test("every server message carries a sequence", () => {
  const view = { groups: [], thread: null };
  assert.equal(isMobileServerMessage({ kind: "snapshot", sequence: 1, sessionId: "session-1", build: "b7f0c1d2e3a4b5c6", view }), true);
  assert.equal(isMobileServerMessage({ kind: "snapshot", sessionId: "session-1", build: "b7f0c1d2e3a4b5c6", view }), false);
  assert.equal(isMobileServerMessage({ kind: "snapshot", sequence: 1, sessionId: "session-1", build: "b7f0c1d2e3a4b5c6", view: [] }), false);
  /** Without the build it names, a page could never tell that the Mac had started serving another. */
  assert.equal(isMobileServerMessage({ kind: "snapshot", sequence: 1, sessionId: "session-1", view }), false);
  assert.equal(isMobileServerMessage({ kind: "patch", sequence: 2, patch: {} }), true);
  assert.equal(isMobileServerMessage({ kind: "paired", sequence: 1, deviceId: "device-1", deviceName: "iPhone", token: "abc" }), true);
  assert.equal(isMobileServerMessage({ kind: "ack", sequence: 3, requestId: "request-1", ok: true }), true);
  assert.equal(isMobileServerMessage({ kind: "ack", sequence: 3, requestId: "request-1", ok: false, message: "no such thread" }), true);
  assert.equal(isMobileServerMessage({ kind: "ack", sequence: 3, requestId: "request-1", ok: false }), false);
  assert.equal(isMobileServerMessage({ kind: "error", sequence: 4, code: "unauthorized", message: "pair again" }), true);
  assert.equal(isMobileServerMessage({ kind: "error", sequence: 4, code: "teapot", message: "" }), false);
  assert.equal(isMobileServerMessage({ kind: "ping", sequence: 5, at: NOW }), true);
});

test("a phone's request travels to the window and is answered there", () => {
  assert.equal(isMobileRequest({ type: "mobile.request", requestId: "request-1", sessionId: "session-1", op: "snapshot" }), true);
  assert.equal(isMobileRequest({ type: "mobile.request", requestId: "request-1", sessionId: "session-1", op: "command", command: { type: "task.dismiss-all" } }), true);
  assert.equal(isMobileRequest({ type: "mobile.request", requestId: "request-1", sessionId: "session-1", op: "command", command: { type: "browser.new-tab" } }), false);
  assert.equal(isMobileRequest({ type: "thread.request", requestId: "request-1", sessionId: "session-1", op: "snapshot" }), false);
  assert.equal(isMobileResponse({ type: "mobile.response", requestId: "request-1", ok: true, result: null }), true);
  assert.equal(isMobileResponse({ type: "mobile.response", requestId: "request-1", ok: false, message: "refused" }), true);
  assert.equal(isMobileResponse({ type: "mobile.response", requestId: "request-1", ok: false }), false);
});

test("an address says where a phone reaches the Mac, and only Tailscale is secure", () => {
  const loopback: MobileAddress = { kind: "loopback", host: "127.0.0.1", port: 7737 };
  const lan: MobileAddress = { kind: "lan", host: "192.168.1.20", port: 7737 };
  const tailscale: MobileAddress = { kind: "tailscale-https", host: "mac.tail1234.ts.net", port: 443 };

  assert.equal(addressOrigin(loopback), "http://127.0.0.1:7737");
  assert.equal(addressOrigin(tailscale), "https://mac.tail1234.ts.net");
  assert.deepEqual(preferredAddress([loopback, lan, tailscale]), tailscale);
  assert.deepEqual(preferredAddress([loopback, lan]), lan);
  assert.deepEqual(preferredAddress([loopback]), loopback);
  assert.equal(preferredAddress([]), null);
});

test("a pairing URL carries the code and reads back", () => {
  const address: MobileAddress = { kind: "tailscale-https", host: "mac.tail1234.ts.net", port: 443 };
  const url = pairingUrl(address, "ABCD2345");
  assert.equal(url, "https://mac.tail1234.ts.net/m/#pair=ABCD2345");
  assert.deepEqual(parsePairingUrl(url), { origin: "https://mac.tail1234.ts.net", code: "ABCD2345" });
  assert.deepEqual(parsePairingUrl("http://127.0.0.1:7737/m/?pair=abcd2345"), { origin: "http://127.0.0.1:7737", code: "ABCD2345" });
  assert.equal(parsePairingUrl("https://mac.tail1234.ts.net/m"), null, "a URL with no code pairs nothing");
  assert.equal(parsePairingUrl("https://mac.tail1234.ts.net/other?pair=ABCD2345"), null);
  assert.equal(parsePairingUrl("aicodingtool://pair?pair=ABCD2345"), null);
  assert.equal(parsePairingUrl("not a url"), null);
});

test("a pairing code expires on the clock and is matched exactly", () => {
  const pairing = createPairingCode(NOW);
  assert.equal(pairing.expiresAt, NOW + PAIRING_CODE_TTL_MS);
  assert.equal(pairing.code.length, PAIRING_CODE_LENGTH);
  assert.match(pairing.code, /^[0-9A-HJKMNP-TV-Z]+$/, "the alphabet leaves out the letters that read as digits");
  assert.equal(pairingCodeLive(pairing, NOW), true);
  assert.equal(pairingCodeLive(pairing, NOW + PAIRING_CODE_TTL_MS), false);
  assert.equal(pairingCodeLive(null, NOW), false);
  assert.equal(pairingCodeMatches(pairing, pairing.code.toLowerCase()), true);
  assert.equal(pairingCodeMatches(pairing, ` ${pairing.code} `), true);
  assert.equal(pairingCodeMatches(pairing, `${pairing.code}X`), false);
  assert.notEqual(generatePairingCode(), generatePairingCode());
});

test("repeated bad codes lock the door, and a good one clears the count", () => {
  let attempts = noPairingAttempts();
  for (let tries = 1; tries < MAX_PAIRING_FAILURES; tries += 1) {
    attempts = registerPairingFailure(attempts, NOW);
    assert.equal(pairingLocked(attempts, NOW), false, `attempt ${tries}`);
  }
  attempts = registerPairingFailure(attempts, NOW);
  assert.equal(pairingLocked(attempts, NOW), true);
  assert.equal(pairingLocked(attempts, attempts.lockedUntil!), false, "the lockout ends on its own");
  assert.equal(pairingLocked(clearPairingFailures(), NOW), false);
});

test("only a hash of a device token is kept, and a token finds its device", async () => {
  const token = generateDeviceToken();
  assert.equal(token.length, 64);
  const hash = await hashDeviceToken(token);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);
  assert.equal(await hashDeviceToken(token), hash, "the same token always hashes the same");

  const device: PairedDevice = { id: "device-1", name: "iPhone", tokenHash: hash, pairedAt: NOW, lastSeenAt: null };
  assert.deepEqual(await deviceForToken([device], token), device);
  assert.equal(await deviceForToken([device], generateDeviceToken()), null);
  assert.equal(await deviceForToken([], token), null);
});
