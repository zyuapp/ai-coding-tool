import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { emptyWorkspaceState } from "../../../src/application/workspace-state.ts";
import { reduce, type WorkspaceInput } from "../../../src/application/workspace-reducer.ts";
import { isComputerClientMessage } from "../../../src/contracts/computers.ts";
import { isTerminalOutputRead } from "../../../src/contracts/terminal.ts";
import type { WorkspaceUpdate } from "../../../src/contracts/workspace-runtime.ts";
import { MobileServer, WORKSPACE_SOCKET_PATH } from "../../../src/main/mobile/mobile-server.mts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { createComputerClient } from "../../../src/main/computers/computer-client.mts";
import * as terminal from "../../../src/main/terminal-host.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The paired terminal did not reach the expected state.");
}

test("a paired computer opens, types in, resizes, reconnects to, and closes a real host shell", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aic-terminal-"));
  await writeFile(path.join(folder, "index.html"), "<!doctype html>");
  const devices = new PairingStore(path.join(folder, "devices.json"));
  let state = emptyWorkspaceState();
  let revision = 0;
  const listeners = new Set<(update: WorkspaceUpdate) => void>();
  function dispatch(input: WorkspaceInput) {
    const next = reduce(state, input);
    state = next.state;
    for (const effect of next.effects) {
      if (effect.type === "terminal.start") terminal.startTerminal(effect.terminalId, effect.cwd);
      if (effect.type === "terminal.write") terminal.writeTerminal(effect.terminalId, effect.data);
      if (effect.type === "terminal.resize") terminal.resizeTerminal(effect.terminalId, effect.cols, effect.rows);
      if (effect.type === "terminal.close") terminal.closeTerminal(effect.terminalId);
    }
    revision++;
    for (const listener of listeners) listener({ revision, state });
    return { ...(next.result ?? { ok: true as const }), revision };
  }
  terminal.startTerminalHost({ onData: () => {}, onUpdate: (update) => { dispatch({ type: "terminal.updated", update }); } });
  const server = new MobileServer({
    devices, staticRoot: folder, port: 0, allowedOrigins: () => [],
    snapshot: async () => { throw new Error("No phone view"); }, command: async () => {}, query: async () => null, onChange: () => {},
    workspace: {
      snapshot: () => ({ revision, state }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      input: async (inputs) => { let result = { ok: true as const, revision }; for (const input of inputs) { const next = dispatch(input); if (!next.ok) return next; result = next; } return result; },
      query: async (query) => query.kind === "terminal-output" ? terminal.readTerminalOutput(query.terminalId, query.after) : null,
    },
  });
  await server.start("127.0.0.1");
  let deviceId = "";
  let connections = 0;
  const client = createComputerClient({
    host: "127.0.0.1", url: `ws://127.0.0.1:${server.port}${WORKSPACE_SOCKET_PATH}`, deviceName: "Viewer",
    credential: { code: devices.mint(Date.now()).code },
    onPaired: (id) => { deviceId = id; }, onState: () => {},
    onStatus: (status) => { if (status === "connected") connections++; },
  });
  t.onTestFinished(async () => { client.stop(); terminal.stopTerminalHost(); await server.stop(); await rm(folder, { recursive: true, force: true }); });
  await until(() => client.status === "connected");
  assert.equal((await client.send([{ type: "terminal.open", cwd: folder }])).ok, true);
  await until(() => Boolean(client.state?.docks.draft?.terminals.length));
  const id = client.state!.docks.draft.terminals[0].id;
  const read = async (after?: number) => {
    const value = await client.query({ kind: "terminal-output", terminalId: id, after });
    assert.ok(isTerminalOutputRead(value));
    return value;
  };
  const initial = await read();
  assert.equal(initial?.kind, "snapshot");
  let sequence = initial!.sequence;
  await client.send([{ type: "terminal.input", terminalId: id, data: "AIC_PAIR_VALUE=survived; printf 'paired-%s\\n' output\r" }]);
  let text = "";
  for (let attempt = 0; attempt < 10 && !text.includes("paired-output"); attempt++) { const output = await read(sequence); assert.ok(output); sequence = output.sequence; text += output.data; }
  assert.match(text, /paired-output/);
  await client.send([{ type: "terminal.resize", terminalId: id, cols: 90, rows: 28 }]);
  assert.equal((await read())?.cols, 90);
  server.dropDevice(deviceId);
  await until(() => connections === 2);
  await client.send([{ type: "terminal.input", terminalId: id, data: "printf 'session-%s\\n' \"$AIC_PAIR_VALUE\"\r" }]);
  for (let attempt = 0; attempt < 10 && !text.includes("session-survived"); attempt++) { const output = await read(sequence); assert.ok(output); sequence = output.sequence; text += output.data; }
  assert.match(text, /session-survived/, "the same shell survives a connection loss");
  await client.send([{ type: "terminal.close", terminalId: id }]);
  assert.equal(await read(), null);
});

test("the paired command boundary rejects oversized keyboard input and invalid terminal dimensions", () => {
  const accepted = (input: unknown) => isComputerClientMessage({ kind: "input", requestId: "read", inputs: [input] });
  assert.equal(accepted({ type: "terminal.input", terminalId: "t", data: "x".repeat(65_537) }), false);
  for (const cols of [0, -1, 1.5, 1001, Infinity]) assert.equal(accepted({ type: "terminal.resize", terminalId: "t", cols, rows: 24 }), false);
  assert.equal(accepted({ type: "terminal.resize", terminalId: "t", cols: 120, rows: 40 }), true);
});
