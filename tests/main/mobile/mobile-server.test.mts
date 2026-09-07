import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import WebSocket from "ws";
import { MobileServer } from "../../../src/main/mobile/mobile-server.mts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { MobileRelay } from "../../../src/main/mobile/session-host.mts";
import { MAX_PENDING_SOCKETS, MOBILE_EVENT_BUFFER } from "../../../src/domain/mobile.ts";
import { MOBILE_PROTOCOL_VERSION, type MobileClientMessage, type MobileCommand, type MobileRequest, type MobileServerMessage, type MobileView } from "../../../src/contracts/mobile.ts";

const PAGE = "<!doctype html><title>phone</title>";

function view(title: string): MobileView {
  return { groups: [{ projectId: null, name: title, threads: [] }], thread: null, draft: null, error: null };
}

async function until<T>(check: () => T | null | false | undefined, message: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function harness(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-mobile-"));
  await writeFile(path.join(folder, "index.html"), PAGE);
  const devices = new PairingStore(path.join(folder, "mobile-devices.v1.json"));
  const commands: MobileCommand[] = [];
  let snapshot = view("first");
  let refuseSnapshot: string | null = null;
  let held: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const server = new MobileServer({
    devices,
    staticRoot: folder,
    port: 0,
    allowedOrigins: () => [`http://127.0.0.1:${server.port}`],
    snapshot: async () => {
      if (refuseSnapshot) throw new Error(refuseSnapshot);
      if (held) await held;
      return snapshot;
    },
    command: async (_sessionId, command) => { commands.push(command); },
    onChange: () => { changes += 1; },
    sessionGraceMs: 0,
  });
  let changes = 0;
  await server.start("127.0.0.1");
  t.onTestFinished(async () => {
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  });
  return {
    server,
    devices,
    commands,
    origin: `http://127.0.0.1:${server.port}`,
    socketUrl: `ws://127.0.0.1:${server.port}/m/socket`,
    changed: () => changes,
    setSnapshot: (next: MobileView) => { snapshot = next; },
    refuse: (message: string | null) => { refuseSnapshot = message; },
    /** Makes the next snapshot wait, so a test can publish into the gap before it lands. */
    hold: () => {
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = null; release?.(); };
    },
  };
}

/** A socket with everything it has been told, so a test waits for a message rather than a moment. */
function phone(url: string, options?: WebSocket.ClientOptions) {
  const socket = new WebSocket(url, options);
  const messages: MobileServerMessage[] = [];
  const closes: number[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data)) as MobileServerMessage));
  socket.on("close", (code) => closes.push(code));
  socket.on("error", () => undefined);
  const send = (message: MobileClientMessage) => socket.send(JSON.stringify(message));
  return {
    socket,
    messages,
    closes,
    send,
    opened: () => new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    }),
    waitFor: <K extends MobileServerMessage["kind"]>(kind: K) =>
      until(() => messages.find((message): message is Extract<MobileServerMessage, { kind: K }> => message.kind === kind), `no ${kind} message arrived`),
  };
}

test("the server hands out the phone page and nothing outside it", async (t) => {
  const { origin } = await harness(t);

  const redirected = await fetch(`${origin}/m?pair=ABCDEFGH`, { redirect: "manual" });
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("location"), "/m/?pair=ABCDEFGH");

  const page = await fetch(`${origin}/m/`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), PAGE);
  assert.equal(await (await fetch(`${origin}/m/health`)).text(), "aicodingtool-mobile-v1");
  assert.equal((await fetch(`${origin}/m/threads/abc`)).status, 200, "a route the page draws is still the page");

  assert.equal((await fetch(`${origin}/m/../../package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/m/%2e%2e%2f%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${origin}/m/%zz`)).status, 404, "a path no browser could have escaped is not one we hold");
  assert.equal((await fetch(`${origin}/m/`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/m/socket`)).status, 400, "the socket address is not a page");
});

test("a snapshot names the build of the page the server hands out", async (t) => {
  const { devices, socketUrl, origin } = await harness(t);
  const code = devices.mint(Date.now());
  const client = phone(socketUrl);
  t.onTestFinished(() => client.socket.close());
  await client.opened();

  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const opening = await client.waitFor("snapshot");
  const served = await (await fetch(`${origin}/m/`)).text();
  assert.equal(opening.build, createHash("sha256").update(served).digest("hex").slice(0, 16));
});

test("a phone trades its code for a token and is handed the view", async (t) => {
  const { devices, socketUrl, server, commands } = await harness(t);
  const code = devices.mint(Date.now());
  const client = phone(socketUrl);
  t.onTestFinished(() => client.socket.close());
  await client.opened();

  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await client.waitFor("paired");
  assert.equal(paired.sequence, 1);
  assert.match(paired.token, /^[0-9a-f]{64}$/);
  assert.equal(devices.authenticate(paired.token)?.id, paired.deviceId);

  const snapshot = await client.waitFor("snapshot");
  assert.equal(snapshot.sequence, 2);
  assert.deepEqual(snapshot.view, view("first"));
  assert.deepEqual(server.sessionViews().map((session) => [session.deviceName, session.connection]), [["iPhone", "live"]]);

  const command: MobileCommand = { type: "task.select", taskId: "task-1" };
  client.send({ kind: "command", requestId: "request-1", command });
  const ack = await client.waitFor("ack");
  assert.equal(ack.ok, true);
  assert.deepEqual(commands, [command]);

  client.send({ kind: "command", requestId: "request-2", command: { type: "task.select", taskId: "" } as MobileCommand });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.messages.filter((message) => message.kind === "ack").length, 1, "a command that fails the guard is not relayed");
});

test("a phone that drops resumes where it was, and falls back to a snapshot when it cannot", async (t) => {
  const { devices, socketUrl, server, setSnapshot } = await harness(t);
  const code = devices.mint(Date.now());
  const first = phone(socketUrl);
  await first.opened();
  first.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await first.waitFor("paired");
  const opening = await first.waitFor("snapshot");
  const sessionId = opening.sessionId;

  first.socket.close();
  await until(() => server.sessionViews()[0]?.connection === "offline", "the session never went offline");
  server.publish({ kind: "patch", patch: { groups: [{ projectId: null, name: "while away", threads: [] }] } });

  const back = phone(socketUrl);
  t.onTestFinished(() => back.socket.close());
  await back.opened();
  back.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: paired.token, sessionId, lastSequence: opening.sequence });
  const missed = await back.waitFor("patch");
  assert.equal(missed.sequence, opening.sequence + 1);
  assert.deepEqual(missed.patch.groups?.[0]?.name, "while away");
  assert.equal(back.messages.some((message) => message.kind === "snapshot"), false, "a resume that worked costs no snapshot");
  assert.equal(server.sessionViews().length, 1, "the session was picked up rather than replaced");

  back.socket.close();
  await until(() => server.sessionViews()[0]?.connection === "offline", "the session never went offline");
  setSnapshot(view("second"));
  for (let sent = 0; sent <= MOBILE_EVENT_BUFFER; sent += 1) server.publish({ kind: "patch", patch: { groups: [] } });
  const behind = phone(socketUrl);
  t.onTestFinished(() => behind.socket.close());
  await behind.opened();
  behind.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: paired.token, sessionId, lastSequence: missed.sequence });
  const snapshot = await behind.waitFor("snapshot");
  assert.deepEqual(snapshot.view, view("second"));
  assert.notEqual(snapshot.sessionId, sessionId, "a phone too far behind is given a session of its own");
});

test("a socket is refused without a token this Mac knows, and without an origin it served", async (t) => {
  const { socketUrl, origin, server, devices } = await harness(t);

  const stranger = phone(socketUrl);
  await stranger.opened();
  stranger.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: "0".repeat(64), lastSequence: 0 });
  const refused = await stranger.waitFor("error");
  assert.equal(refused.code, "unauthorized");
  await until(() => stranger.closes.length > 0, "the refused socket stayed open");
  assert.equal(server.sessionViews().length, 0);

  const outdated = phone(socketUrl);
  t.onTestFinished(() => outdated.socket.close());
  await outdated.opened();
  outdated.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION + 1, code: devices.mint(Date.now()).code, deviceName: "iPhone" });
  assert.equal((await outdated.waitFor("error")).code, "version");

  const allowed = phone(socketUrl, { origin });
  t.onTestFinished(() => allowed.socket.close());
  await allowed.opened();

  const foreign = phone(socketUrl, { origin: "https://evil.example" });
  await assert.rejects(foreign.opened(), /403/);
});

test("a command re-sent after a lost ack is answered, not run again", async (t) => {
  const { devices, socketUrl, commands } = await harness(t);
  const code = devices.mint(Date.now());
  const client = phone(socketUrl);
  t.onTestFinished(() => client.socket.close());
  await client.opened();
  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  await client.waitFor("snapshot");

  const command: MobileCommand = { type: "task.send", taskId: "task-1", text: "ship it" };
  client.send({ kind: "command", requestId: "request-1", command });
  const first = await client.waitFor("ack");
  assert.equal(first.ok, true);

  client.send({ kind: "command", requestId: "request-1", command });
  await until(() => client.messages.filter((message) => message.kind === "ack").length === 2, "the resend went unanswered");
  assert.deepEqual(commands, [command], "the window was asked once");
});

test("a phone whose pairing is revoked loses the session with it", async (t) => {
  const { devices, socketUrl, server } = await harness(t);
  const code = devices.mint(Date.now());
  const client = phone(socketUrl);
  await client.opened();
  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await client.waitFor("paired");
  await client.waitFor("snapshot");

  devices.revoke(paired.deviceId);
  server.dropDevice(paired.deviceId);
  await until(() => client.closes.length > 0, "the revoked phone was left connected");
  assert.equal(server.sessionViews().length, 0);
});

test("a view the window will not give up is reported rather than dropped", async (t) => {
  const { devices, socketUrl, refuse, server } = await harness(t);
  refuse("The AI Coding Tool window is not open.");
  const code = devices.mint(Date.now());
  const client = phone(socketUrl);
  t.onTestFinished(() => client.socket.close());
  await client.opened();

  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const failed = await client.waitFor("error");
  assert.equal(failed.code, "internal");
  assert.match(failed.message, /window is not open/);
  /** A session that never got its view is not kept: the phone is hung up on and dials into a fresh one. */
  await until(() => client.closes.length > 0, "the phone was left on a session with no view");
  assert.equal(server.sessionViews().length, 0);
});

test("a command whose acknowledgement was lost before the session expired is still only run once", async (t) => {
  const { devices, socketUrl, server, commands } = await harness(t);
  const code = devices.mint(Date.now());
  const first = phone(socketUrl);
  await first.opened();
  first.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await first.waitFor("paired");
  const opening = await first.waitFor("snapshot");
  const command: MobileCommand = { type: "task.send", taskId: "task-1", text: "ship it" };
  first.send({ kind: "command", requestId: "request-1", command });
  await first.waitFor("ack");

  first.socket.close();
  await until(() => server.sessionViews()[0]?.connection === "offline", "the session never went offline");
  (server as unknown as { tick(): void }).tick();
  assert.equal(server.sessionViews().length, 0, "the session outlived its grace");

  const back = phone(socketUrl);
  t.onTestFinished(() => back.socket.close());
  await back.opened();
  back.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: paired.token, sessionId: opening.sessionId, lastSequence: opening.sequence + 1 });
  await back.waitFor("snapshot");
  back.send({ kind: "command", requestId: "request-1", command });
  const again = await back.waitFor("ack");
  assert.equal(again.ok, true);
  assert.deepEqual(commands, [command], "the window ran the resent command a second time");
});

test("a resume with nothing to replay is still handed a frame, so the phone calls itself live at once", async (t) => {
  const { devices, socketUrl } = await harness(t);
  const code = devices.mint(Date.now());
  const first = phone(socketUrl);
  await first.opened();
  first.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await first.waitFor("paired");
  const opening = await first.waitFor("snapshot");
  first.socket.close();

  const back = phone(socketUrl);
  t.onTestFinished(() => back.socket.close());
  await back.opened();
  back.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: paired.token, sessionId: opening.sessionId, lastSequence: opening.sequence });
  const ping = await back.waitFor("ping");
  assert.equal(ping.sequence, opening.sequence + 1, "the frame is numbered after what the phone already saw");
  assert.equal(back.messages.some((message) => message.kind === "snapshot"), false);
});

test("a page served through a proxy is let in by the host it was served on, and wrong codes count against the phone behind the proxy", async (t) => {
  const { socketUrl, devices } = await harness(t);
  const proxied = { origin: "https://mac.tail1234.ts.net", headers: { "x-forwarded-host": "mac.tail1234.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.7" } };
  const allowed = phone(socketUrl, proxied);
  t.onTestFinished(() => allowed.socket.close());
  await allowed.opened();

  const foreign = phone(socketUrl, { ...proxied, origin: "https://evil.example" });
  await assert.rejects(foreign.opened(), /403/);

  devices.mint(Date.now());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const guess = phone(socketUrl, proxied);
    await guess.opened();
    guess.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: "WRONGONE", deviceName: "iPhone" });
    await guess.waitFor("error");
  }
  const other = phone(socketUrl, { ...proxied, headers: { ...proxied.headers, "x-forwarded-for": "100.64.0.8" } });
  t.onTestFinished(() => other.socket.close());
  await other.opened();
  other.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: devices.mint(Date.now()).code, deviceName: "iPad" });
  await other.waitFor("paired");
});

test("a phone's request is answered by the window, or by the wait running out", async () => {
  const sent: MobileRequest[] = [];
  const relay = new MobileRelay({ send: (request) => { sent.push(request); return true; } }, 40);

  const answered = relay.snapshot("session-1");
  await until(() => sent.length === 1, "the request never reached the window");
  relay.answer({ type: "mobile.response", requestId: sent[0].requestId, ok: true, result: view("first") });
  assert.deepEqual(await answered, view("first"));

  relay.answer({ type: "mobile.response", requestId: sent[0].requestId, ok: true, result: view("first") });

  const refused = relay.command("session-1", { type: "task.select", taskId: "task-1" });
  await until(() => sent.length === 2, "the command never reached the window");
  relay.answer({ type: "mobile.response", requestId: sent[1].requestId, ok: false, message: "No such thread." });
  await assert.rejects(refused, /No such thread/);

  await assert.rejects(relay.snapshot("session-1"), /did not answer/);
  const closed = new MobileRelay({ send: () => false });
  await assert.rejects(closed.snapshot("session-1"), /window is not open/);

  const abandoned = new MobileRelay({ send: () => true });
  const waiting = abandoned.snapshot("session-1");
  abandoned.failAll("The phone bridge was turned off.");
  await assert.rejects(waiting, /turned off/);
});

/**
 * A socket that speaks the protocol but never answers a close frame, which is what a patched client
 * would do and what a well-behaved `ws` client cannot be made to do.
 */
async function rudePhone(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.on("error", () => undefined);
  socket.write([
    "GET /m/socket HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  await once(socket, "data");
  return {
    socket,
    send: (message: MobileClientMessage) => socket.write(clientFrame(JSON.stringify(message))),
  };
}

/** One masked text frame, which is the only shape of frame these tests send. */
function clientFrame(text: string) {
  const body = Buffer.from(text, "utf8");
  assert.ok(body.length < 126, "the test frames are short on purpose");
  const mask = randomBytes(4);
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
}

test("every response says the page may not be framed", async (t) => {
  const { origin } = await harness(t);
  for (const target of ["/m/", "/m/nothing-here.png", "/m/socket"]) {
    const response = await fetch(`${origin}${target}`);
    assert.equal(response.headers.get("x-frame-options"), "DENY", target);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, target);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", target);
  }
});

test("a revoked phone that will not hang up is cut off rather than left issuing commands", async (t) => {
  const { devices, server, commands } = await harness(t);
  const code = devices.mint(Date.now());
  const rude = await rudePhone(server.port ?? 0);
  rude.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "Stolen" });
  await until(() => server.sessionViews().length === 1, "the rude phone never paired");
  const device = devices.list()[0]!;

  rude.send({ kind: "command", requestId: "before", command: { type: "task.select", taskId: "task-1" } });
  await until(() => commands.length === 1, "the paired phone's command never arrived");

  devices.revoke(device.id);
  server.dropDevice(device.id);
  rude.send({ kind: "command", requestId: "after", command: { type: "task.send", taskId: "task-1", text: "rm -rf ~" } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(commands.length, 1, "a revoked phone reached the window again");
  assert.equal(server.sessionViews().length, 0);
  await until(() => rude.socket.destroyed || rude.socket.readyState === "closed", "the revoked socket was left alive");
});

test("turning the bridge off finishes even while a phone refuses to hang up", async (t) => {
  const { devices, server } = await harness(t);
  const code = devices.mint(Date.now());
  const rude = await rudePhone(server.port ?? 0);
  rude.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "Stolen" });
  await until(() => server.sessionViews().length === 1, "the rude phone never paired");

  const started = Date.now();
  await server.stop();
  assert.ok(Date.now() - started < 5_000, `stop took ${Date.now() - started}ms`);
  assert.equal(server.port, null);
});

test("a command a phone re-sends after falling past the buffer is still only run once", async (t) => {
  const { devices, socketUrl, server, commands } = await harness(t);
  const code = devices.mint(Date.now());
  const first = phone(socketUrl);
  await first.opened();
  first.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  const paired = await first.waitFor("paired");
  const opening = await first.waitFor("snapshot");

  const command: MobileCommand = { type: "task.send", taskId: "task-1", text: "deploy to prod" };
  first.send({ kind: "command", requestId: "request-1", command });
  await until(() => commands.length === 1, "the command never reached the window");

  first.socket.close();
  await until(() => server.sessionViews()[0]?.connection === "offline", "the session never went offline");
  for (let sent = 0; sent <= MOBILE_EVENT_BUFFER; sent += 1) server.publish({ kind: "patch", patch: { groups: [] } });

  const behind = phone(socketUrl);
  t.onTestFinished(() => behind.socket.close());
  await behind.opened();
  behind.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: paired.token, sessionId: opening.sessionId, lastSequence: opening.sequence });
  const fresh = await behind.waitFor("snapshot");
  assert.notEqual(fresh.sessionId, opening.sessionId, "the phone fell too far behind to resume");

  behind.send({ kind: "command", requestId: "request-1", command });
  await until(() => behind.messages.some((message) => message.kind === "ack"), "the resend went unanswered");
  assert.deepEqual(commands, [command], "the window was asked once across two sessions");
});

test("what a phone missed before its first snapshot is not sent with the wrong numbering", async (t) => {
  const { devices, socketUrl, server, hold } = await harness(t);
  const code = devices.mint(Date.now());
  const release = hold();
  const client = phone(socketUrl);
  t.onTestFinished(() => client.socket.close());
  await client.opened();
  client.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: code.code, deviceName: "iPhone" });
  await client.waitFor("paired");

  server.publish({ kind: "patch", patch: { groups: [{ projectId: null, name: "too early", threads: [] }] } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.messages.some((message) => message.kind === "patch"), false, "a patch outran the snapshot it belongs after");

  release();
  const snapshot = await client.waitFor("snapshot");
  server.publish({ kind: "patch", patch: { groups: [{ projectId: null, name: "in order", threads: [] }] } });
  const patch = await client.waitFor("patch");
  assert.equal(patch.sequence, snapshot.sequence + 1);
});

test("sockets that never say who they are cannot be piled up without limit", async (t) => {
  const { socketUrl } = await harness(t);
  const idle = await Promise.all(Array.from({ length: MAX_PENDING_SOCKETS }, async () => {
    const client = phone(socketUrl);
    await client.opened();
    return client;
  }));
  t.onTestFinished(() => idle.forEach((client) => client.socket.close()));
  const over = phone(socketUrl);
  await assert.rejects(over.opened(), /503/);
});
