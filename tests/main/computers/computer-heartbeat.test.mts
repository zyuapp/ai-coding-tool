import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { emptyWorkspaceState } from "../../../src/application/workspace-state.ts";
import { COMPUTER_PROTOCOL_VERSION, COMPUTER_TRANSFER_TIMEOUT_MS, type ComputerClientMessage, type ComputerServerMessage } from "../../../src/contracts/computers.ts";
import { MOBILE_DEAD_AFTER_MS, MOBILE_PING_INTERVAL_MS } from "../../../src/domain/mobile.ts";
import { createComputerClient } from "../../../src/main/computers/computer-client.mts";
import { MobileServer, WORKSPACE_SOCKET_PATH } from "../../../src/main/mobile/mobile-server.mts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";

// Socket I/O stays real while only the heartbeat and request clocks advance.
const realTimeout = setTimeout;
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => realTimeout(resolve, 5));
  }
  assert.fail("The socket did not reach the expected state.");
}

const input = { type: "attachments.send" as const, attachments: [{ id: "shot", source: "data:image/png;base64,AQID", annotations: [] }] };
const query = { kind: "attachment" as const, name: "shot.png" };

test.each(["idle", "send", "query", "overlap", "timeout"])("client heartbeat uses the normal deadline outside a pending transfer: %s", async (mode) => {
  vi.useFakeTimers();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let peer: WebSocket | undefined;
  const requests: Array<Extract<ComputerClientMessage, { kind: "input" | "query" }>> = [];
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as ComputerClientMessage;
      if (message.kind === "resume") socket.send(JSON.stringify({ kind: "workspace", sequence: 1, update: { revision: 0, state: emptyWorkspaceState() } }));
      if (message.kind === "input" || message.kind === "query") requests.push(message);
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = createComputerClient({ host: `127.0.0.1:${address.port}`, credential: { token: "test" }, deviceName: "Mac", onStatus: () => {}, onState: () => {}, onPaired: () => {} });
  try {
    await until(() => client.status === "connected");
    const pending = [];
    if (mode !== "idle") pending.push((mode === "send" ? client.send([input]) : client.query(query)).catch(() => undefined));
    if (mode === "overlap") pending.push(client.send([input]).catch(() => undefined));
    if (pending.length) await until(() => requests.length === pending.length);
    await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS);
    if (mode === "idle") return await until(() => client.status === "offline");
    assert.equal(client.status, "connected");
    if (mode === "timeout") {
      await vi.advanceTimersByTimeAsync(COMPUTER_TRANSFER_TIMEOUT_MS - MOBILE_DEAD_AFTER_MS);
      await Promise.all(pending);
      return await until(() => client.status === "offline");
    }
    for (const [index, request] of requests.entries()) {
      // Both rejection and acceptance must retire their transfer allowance.
      peer!.send(JSON.stringify(request.kind === "query"
        ? { kind: "answer", requestId: request.requestId, sequence: index + 2, ok: false, message: "Read failed" }
        : { kind: "result", requestId: request.requestId, sequence: index + 2, result: { ok: true, revision: 0 } }));
      await pending[index];
      if (index < requests.length - 1) {
        await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS);
        assert.equal(client.status, "connected", "the other transfer is still pending");
      }
    }
    await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS);
    await until(() => client.status === "offline");
  } finally {
    client.stop();
    peer?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  }
});

test.each(["idle", "send", "query", "abandoned"])("holder heartbeat extends only an active transfer, including its upload: %s", async (mode) => {
  vi.useFakeTimers();
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-heartbeat-"));
  const devices = new PairingStore(path.join(folder, "devices.json"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let received = false;
  const server = new MobileServer({
    devices, staticRoot: folder, port: 0, allowedOrigins: () => [], onChange: () => {},
    snapshot: async () => { throw new Error("No phones"); }, command: async () => {}, query: async () => null,
    workspace: {
      snapshot: () => ({ revision: 0, state: emptyWorkspaceState() }), subscribe: () => () => {},
      input: async () => { received = true; await held; return { ok: true, revision: 0 }; },
      query: async () => { received = true; await held; throw new Error("Read failed"); },
    },
  });
  await server.start("127.0.0.1");
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WORKSPACE_SOCKET_PATH}`);
  const messages: ComputerServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ kind: "pair", version: COMPUTER_PROTOCOL_VERSION, code: devices.mint(Date.now()).code, deviceName: "Mac" }));
    await until(() => messages.some((message) => message.kind === "workspace"));
    if (mode !== "idle") {
      socket.send(JSON.stringify({ kind: "transfer", requestId: "image" }));
      // A following pong is observed in lastSeenAt, so the preceding announcement has arrived.
      vi.setSystemTime(Date.now() + 1);
      socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
      await until(() => server.sessionViews()[0]?.lastSeenAt === Date.now());
    }
    await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS + MOBILE_PING_INTERVAL_MS);
    if (mode === "idle") return await until(() => socket.readyState === WebSocket.CLOSED);
    assert.equal(socket.readyState, WebSocket.OPEN, "the upload has not fully arrived yet");
    if (mode === "abandoned") {
      await vi.advanceTimersByTimeAsync(COMPUTER_TRANSFER_TIMEOUT_MS);
      return await until(() => socket.readyState === WebSocket.CLOSED);
    }
    socket.send(JSON.stringify(mode === "send" ? { kind: "input", requestId: "image", inputs: [input] } : { kind: "query", requestId: "image", query }));
    await until(() => received);
    await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS + MOBILE_PING_INTERVAL_MS);
    assert.equal(socket.readyState, WebSocket.OPEN, "the attachment request is still pending");
    release();
    await until(() => messages.some((message) => message.kind === "answer" || message.kind === "result"));
    await vi.advanceTimersByTimeAsync(MOBILE_DEAD_AFTER_MS + MOBILE_PING_INTERVAL_MS);
    await until(() => socket.readyState === WebSocket.CLOSED);
  } finally {
    release();
    socket.terminate();
    await server.stop();
    vi.useRealTimers();
    await rm(folder, { recursive: true, force: true });
  }
});
