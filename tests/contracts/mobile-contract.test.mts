import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { isMobileClientMessage, isMobileRequest, isMobileResponse, MOBILE_PROTOCOL_VERSION, OLDEST_PHONE_PROTOCOL_VERSION, type MobileCommand } from "../../src/contracts/mobile.ts";
import { MAX_PHONE_IMAGE_LENGTH } from "../../src/contracts/task-commands.ts";
import { isPhoneCommand } from "../../src/contracts/workspace-view-input.ts";
import {
  addressOrigin,
  createPairingCode,
  generatePairingCode,
  MAX_PAIRING_FAILURES,
  noPairingAttempts,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  pairingCodeLive,
  pairingCodeMatches,
  pairingLocked,
  pairingUrl,
  preferredAddress,
  registerPairingFailure,
  type MobileAddress,
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
    { type: "run.decide", taskId: "t1", runId: "r1", approvalId: "a1", allow: false },
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
  for (const command of allowed) assert.equal(isPhoneCommand(command), true, JSON.stringify(command));

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
    { type: "task.checkout-branch", branch: "main" },
  ];
  for (const command of refused) assert.equal(isPhoneCommand(command), false, JSON.stringify(command));
});

test("mobile command guard rejects wrong shapes and oversized text", () => {
  assert.equal(isPhoneCommand(null), false);
  assert.equal(isPhoneCommand("task.new"), false);
  assert.equal(isPhoneCommand([{ type: "task.new" }]), false);
  assert.equal(isPhoneCommand({ type: "task.select" }), false, "selecting names a thread");
  assert.equal(isPhoneCommand({ type: "task.select", taskId: "" }), false);
  assert.equal(isPhoneCommand({ type: "task.send", taskId: 7 }), false);
  assert.equal(isPhoneCommand({ type: "task.send", text: "x".repeat(1_000_001) }), false);
  assert.equal(isPhoneCommand({ type: "task.send", attachments: [] }), false, "a phone carries no files");
  assert.equal(isPhoneCommand({ type: "task.set-policy", policy: "yolo" }), false);
  assert.equal(isPhoneCommand({ type: "task.set-model", engine: "claude", model: "two words" }), false);
  assert.equal(isPhoneCommand({ type: "task.set-model", engine: "claude", model: "gpt" }), true, "which models an engine offers is the reducer's to decide");
  assert.equal(isPhoneCommand({ type: "task.set-effort", engine: "claude", effort: "galaxy" }), false);
  assert.equal(isPhoneCommand({ type: "task.set-effort", engine: "claude", effort: "ultra" }), true, "which efforts a model takes is the reducer's to decide");
  assert.equal(isPhoneCommand({ type: "task.set-effort", effort: "high" }), false, "an effort names its engine");
  assert.equal(isPhoneCommand({ type: "run.decide" }), false);
  assert.equal(isPhoneCommand({ type: "run.decide", allow: "yes" }), false);
  assert.equal(isPhoneCommand({ type: "view.set-prompt", prompt: 0 }), false);
  assert.equal(isPhoneCommand({ type: "annotation.add", quote: "" }), false);
  assert.equal(isPhoneCommand({ type: "annotation.add", quote: "q", anchor: { kind: "selection" } }), false);
  assert.equal(isPhoneCommand({ type: "annotation.recall", annotations: [{ id: "a" }] }), false);
  assert.equal(isPhoneCommand({ type: "annotation.recall", annotations: Array.from({ length: 101 }, (_, index) => ({ id: `a-${index}`, quote: "q", note: "" })) }), false);
  assert.equal(isPhoneCommand({ type: "paste.recall", pastes: [{ id: "p", text: "" }] }), false);
});

test("a phone's send carries a message and nothing the window or an agent sets", () => {
  const sender = { threadId: "lead", title: "Your coordinator", computer: "mac" };
  const refused: unknown[] = [
    { type: "task.send", text: "hi", coordinatorId: "lead" },
    { type: "task.send", text: "hi", sender },
    { type: "task.send", taskId: "task-1", text: "hi", sender },
    { type: "task.send", text: "hi", lead: sender, memory: "Delete everything" },
    { type: "task.send", text: "hi", memory: "" },
    { type: "task.send", text: "hi", from: "lead" },
    { type: "task.send", text: "hi", brief: { intent: "x", doneWhen: "y", delivers: "report" } },
    { type: "task.send", text: "hi", title: "Fix the login flake" },
    { type: "task.send", text: "hi", title: 42 },
    { type: "task.send", text: "hi", model: "opus" },
    { type: "task.send", text: "hi", model: "nope" },
    { type: "task.send", text: "hi", effort: 7 },
    { type: "task.send", text: "hi", role: "boss" },
    { type: "task.send", text: "hi", role: "coordinator" },
    { type: "task.send", text: "hi", project: "x".repeat(4_097) },
  ];
  for (const command of refused) assert.equal(isPhoneCommand(command), false, JSON.stringify(command));
  assert.equal(isPhoneCommand({ type: "task.send", project: "/Users/me/app", worktree: true, worktreeId: "worktree-1", text: "hi" }), true);
  assert.equal(isPhoneCommand({ type: "task.send", taskId: "task-1", text: "hi", steer: true }), true);
  assert.equal(isPhoneCommand({ type: "task.send" }), true, "a draft sends the prompt the phone set");
});

test("a phone's move never waits on a run, which only an agent moving itself does", () => {
  assert.equal(isPhoneCommand({ type: "task.move-worktree", taskId: "task-1", destination: { kind: "new" }, afterRun: true }), false);
  assert.equal(isPhoneCommand({ type: "task.move-worktree", taskId: "task-1", destination: { kind: "new" }, afterRun: "yes" }), false);
  assert.equal(isPhoneCommand({ type: "task.move-worktree", taskId: "task-1", destination: { kind: "new" }, sender: { threadId: "lead", title: "Lead", computer: "Linux" } }), false);
});

test("client messages are read defensively, since the phone is the boundary", () => {
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: "ABCD2345", deviceName: "iPhone" }), true);
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: "ABCD2345" }), false);
  assert.equal(isMobileClientMessage({ kind: "pair", version: "1", code: "ABCD2345", deviceName: "iPhone" }), false);
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, oldestComputer: 8, code: "ABCD2345", deviceName: "iPhone" }), true);
  assert.equal(isMobileClientMessage({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, oldestComputer: "8", code: "ABCD2345", deviceName: "iPhone" }), false);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, oldestComputer: 1, token: "abc", lastSequence: 0 }), true);
  assert.equal(isMobileClientMessage({ kind: "resume", version: 1, oldestComputer: -1, token: "abc", lastSequence: 0 }), false);
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
  const tailscale: MobileAddress = { kind: "tailscale-https", host: "mac.tail1234.ts.net", port: 443 };

  assert.equal(addressOrigin(loopback), "http://127.0.0.1:7737");
  assert.equal(addressOrigin(tailscale), "https://mac.tail1234.ts.net");
  assert.deepEqual(preferredAddress([loopback, tailscale]), tailscale);
  assert.deepEqual(preferredAddress([loopback]), loopback);
  assert.equal(preferredAddress([]), null);
});

test("a pairing URL opens the phone app with the computer's link, the code in its fragment", () => {
  const address: MobileAddress = { kind: "tailscale-https", host: "mac.tail1234.ts.net", port: 443 };
  const url = pairingUrl(address, "K7M2P9QX");
  /** `ios/AICodingToolTests/ProtocolTests.swift` reads this same link. */
  assert.equal(url, "aicodingtool://pair?link=https%3A%2F%2Fmac.tail1234.ts.net%2F%23pair%3DK7M2P9QX");
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

test("repeated bad codes lock the door until the lockout expires", () => {
  let attempts = noPairingAttempts();
  for (let tries = 1; tries < MAX_PAIRING_FAILURES; tries += 1) {
    attempts = registerPairingFailure(attempts, NOW);
    assert.equal(pairingLocked(attempts, NOW), false, `attempt ${tries}`);
  }
  attempts = registerPairingFailure(attempts, NOW);
  assert.equal(pairingLocked(attempts, NOW), true);
  assert.equal(pairingLocked(attempts, attempts.lockedUntil!), false, "the lockout ends on its own");
});

test("a phone may move a thread between checkouts, and nothing else about worktrees", () => {
  const allowed: unknown[] = [
    { type: "task.set-worktree", worktree: true },
    { type: "task.set-worktree", taskId: "task-1", worktree: false },
    { type: "task.move-worktree", taskId: "task-1", destination: { kind: "new" } },
    { type: "task.move-worktree", taskId: "task-1", destination: { kind: "local" } },
    { type: "task.move-worktree", destination: { kind: "worktree", id: "worktree-1" } },
  ];
  for (const command of allowed) assert.equal(isPhoneCommand(command), true, JSON.stringify(command));
  const refused: unknown[] = [
    { type: "task.set-worktree", worktree: "yes" },
    { type: "task.move-worktree", taskId: "task-1", destination: { kind: "worktree" } },
    { type: "task.move-worktree", taskId: "task-1", destination: { kind: "elsewhere" } },
    { type: "worktree.delete", root: "/tmp/checkout" },
    { type: "task.checkout-branch", branch: "main" },
  ];
  for (const command of refused) assert.equal(isPhoneCommand(command), false, JSON.stringify(command));
});

test("a query names a thread and a comparison, and travels to the window like a command", () => {
  const summary = { kind: "diff-summary", taskId: "task-1", range: { kind: "uncommitted" } };
  const patch = { kind: "diff-patch", taskId: "task-1", range: { kind: "branches", base: "main", compare: null }, path: "src/a.ts", previousPath: "src/b.ts" };
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: summary }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: patch }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "diff-patch", taskId: "task-1", range: { kind: "uncommitted" } } }), false, "a patch names its file");
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "diff-summary", taskId: "task-1", range: { kind: "commit", commit: "nope" } } }), false, "a range is read as strictly as the desktop reads it");
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "read-file", taskId: "task-1", path: "/etc/passwd" } }), false);
  assert.equal(isMobileRequest({ type: "mobile.request", requestId: "r1", sessionId: "s1", op: "query", query: summary }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "directories", prefix: "~/code/" } }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "directories", prefix: "" } }), true, "an empty prefix lists nothing rather than fails");
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "directories", prefix: "/a\0b" } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "directories", prefix: "x".repeat(4_097) } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "directories" } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "thread", taskId: "task-2" } }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "thread" } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "history", taskId: "task-2", before: 40 } }), true);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "history", taskId: "task-2", before: -1 } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "history", taskId: "task-2", before: 1.5 } }), false);
  assert.equal(isMobileClientMessage({ kind: "query", requestId: "q1", query: { kind: "archived" } }), true);
});

test("a phone answers decisions, starts one suggestion where it was suggested, settles a usage pause, snoozes, stops a coordinator, and edits a queued message", () => {
  const allowed: unknown[] = [
    { type: "decision.answer", taskId: "t1", decisionId: "d1", answer: "SQLite" },
    { type: "proposal.start", taskId: "lead", proposalId: "p1" },
    { type: "limit.resume", taskId: "t1" },
    { type: "limit.cancel", taskId: "t1" },
    { type: "task.snooze", taskId: "t1", hours: 24 },
    { type: "task.unsnooze", taskId: "t1" },
    { type: "coordination.stop-all", taskId: "lead" },
    { type: "task.edit-queued", taskId: "t1", messageId: "q1" },
  ];
  for (const command of allowed) assert.equal(isPhoneCommand(command), true, JSON.stringify(command));
  const refused: unknown[] = [
    { type: "decision.answer", taskId: "t1", decisionId: "d1", answer: "" },
    { type: "decision.answer", taskId: "t1", decisionId: "d1", answer: "x".repeat(4_001) },
    { type: "proposal.start", taskId: "lead" },
    { type: "proposal.start", taskId: "lead", proposalIds: ["p1", "p2"] },
    { type: "proposal.start", taskId: "lead", proposalId: "p1", place: { project: "project-app", worktree: true } },
    { type: "limit.resume" },
    { type: "task.snooze", taskId: "t1", hours: 2 },
    { type: "task.unsnooze" },
    { type: "coordination.stop-all" },
    { type: "task.edit-queued", messageId: "q1" },
  ];
  for (const command of refused) assert.equal(isPhoneCommand(command), false, JSON.stringify(command));
});

test("a phone sends pictures it holds, never a file on this computer", () => {
  const picture = { id: "p1", source: "data:image/png;base64,iVBORw0K", annotations: [] };
  assert.equal(isPhoneCommand({ type: "attachments.send", taskId: "task-1", text: "Look", attachments: [picture] }), true);
  assert.equal(isPhoneCommand({ type: "attachments.send", steer: true, attachments: [picture] }), true, "the draft, steered");
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [] }), false, "an empty strip is a plain send");
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: Array.from({ length: 7 }, (_, index) => ({ ...picture, id: `p${index}` })) }), false);
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, path: "/Users/me/.ssh/id_rsa" }] }), false, "never a path here");
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, source: "data:text/html;base64,PGI+" }] }), false);
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, source: "file:///etc/passwd" }] }), false);
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, source: "data:image/jpeg;base64,/9j/AAAA" }] }), false, "kept as PNG");
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, annotations: [{ kind: "box", x: 0, y: 0, width: 1, height: 1, text: "" }] }] }), false);
  assert.equal(isPhoneCommand({ type: "attachments.send", attachments: [{ ...picture, source: `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}` }] }), false, "a picture the phone has not shrunk");
});

test("a phone makes coordinators and adds projects on this computer only", () => {
  assert.equal(isPhoneCommand({ type: "task.set-role", role: "coordinator" }), true, "the draft");
  assert.equal(isPhoneCommand({ type: "task.set-role", taskId: "task-1", role: null }), true);
  assert.equal(isPhoneCommand({ type: "task.set-role", role: "emperor" }), false);
  assert.equal(isPhoneCommand({ type: "task.set-role", role: "coordinator", sender: { kind: "agent", threadId: "t" } }), false, "only an agent says who asked");
  assert.equal(isPhoneCommand({ type: "project.add", root: "~/code/app", start: true }), true);
  assert.equal(isPhoneCommand({ type: "project.add", root: "   " }), false);
  assert.equal(isPhoneCommand({ type: "project.add", root: "/code/app", computerId: "mac-2" }), false, "never on a linked computer");
});

test("a phone updates this computer's app and engines only, and looks for updates without a dialog", () => {
  assert.equal(isPhoneCommand({ type: "app.update" }), true);
  assert.equal(isPhoneCommand({ type: "app.cancel-update" }), true);
  assert.equal(isPhoneCommand({ type: "engine.update", engine: "claude" }), true);
  assert.equal(isPhoneCommand({ type: "app.update", computerId: "mac-2" }), false, "never a linked computer");
  assert.equal(isPhoneCommand({ type: "app.cancel-update", computerId: "mac-2" }), false, "never a linked computer");
  assert.equal(isPhoneCommand({ type: "engine.update", engine: "claude", computerId: "mac-2" }), false, "never a linked computer");
  assert.equal(isPhoneCommand({ type: "engine.update", engine: "nope" }), false);
  assert.equal(isPhoneCommand({ type: "app.check-for-updates", quiet: true }), true);
  assert.equal(isPhoneCommand({ type: "app.check-for-updates" }), false, "a dialog nobody may be there to close");
  assert.equal(isPhoneCommand({ type: "engine.read", refresh: true }), true);
  assert.equal(isPhoneCommand({ type: "engine.read" }), false);
});

test("a phone reads this computer's plan limits and puts away their warning", () => {
  assert.equal(isPhoneCommand({ type: "usage.read" }), true);
  assert.equal(isPhoneCommand({ type: "usage.read", everywhere: true }), false, "never a linked computer's");
  assert.equal(isPhoneCommand({ type: "usage.dismiss-warning", warning: "claude:five_hour:2027-01-15T16:10:00Z:near" }), true);
  assert.equal(isPhoneCommand({ type: "usage.dismiss-warning" }), false);
});

test("a phone may send exactly the commands that declare a phone rule", () => {
  const types: Record<MobileCommand["type"], true> = {
    "task.new": true, "task.select": true, "task.send": true, "task.archive": true, "task.restore": true, "task.rename": true,
    "task.dismiss": true, "task.dismiss-all": true, "task.fork": true, "task.set-policy": true, "task.set-model": true,
    "task.set-effort": true, "task.set-fast-mode": true, "task.set-worktree": true, "task.move-worktree": true,
    "task.steer-queued": true, "task.drop-queued": true,
    "run.cancel": true, "run.decide": true, "run.stop-process": true, "question.answer": true,
    "annotation.add": true, "annotation.note": true, "annotation.remove": true, "annotation.recall": true,
    "paste.add": true, "paste.remove": true, "paste.recall": true,
    "view.set-prompt": true, "task.set-role": true, "project.add": true, "attachments.send": true,
    "app.update": true, "app.cancel-update": true, "app.check-for-updates": true, "engine.read": true, "engine.update": true,
    "usage.read": true, "usage.dismiss-warning": true,
    "decision.answer": true, "proposal.start": true, "limit.resume": true, "limit.cancel": true, "task.snooze": true, "task.unsnooze": true,
    "coordination.stop-all": true, "task.edit-queued": true,
  };
  assert.equal(Object.keys(types).length, 47);
  for (const type of ["terminal.input", "worktree.delete", "project.remove", "browser.open", "task.set-coordinator", "run.compact"]) {
    assert.equal(isPhoneCommand({ type, taskId: "task-1" }), false, type);
  }
});

test("the computer serves its own protocol version, and the phone shrinks pictures to what it takes", () => {
  assert.ok(OLDEST_PHONE_PROTOCOL_VERSION <= MOBILE_PROTOCOL_VERSION);
  const composer = readFileSync(new URL("../../ios/AICodingTool/UI/ComposerView.swift", import.meta.url), "utf8");
  assert.equal(Number(/static let maxSourceLength = (\d+) \* 1024 \* 1024/.exec(composer)?.[1]) * 1024 * 1024, MAX_PHONE_IMAGE_LENGTH, "the phone shrinks pictures to what the computer takes");
});
