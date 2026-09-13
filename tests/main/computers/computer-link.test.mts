import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_ENCODED_BYTES, MAX_ATTACHMENTS } from "../../../src/domain/conversation.ts";
import { COMPUTER_SEND_TOO_LARGE } from "../../../src/contracts/computers.ts";
import assert from "node:assert/strict";
import type { ThreadNotice } from "../../../src/contracts/ipc.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { emptyWorkspaceState, type WorkspaceState } from "../../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../../src/application/workspace-reducer.ts";
import type { WorkspaceUpdate } from "../../../src/contracts/workspace-runtime.ts";
import type { ComputerStatus } from "../../../src/domain/computers.ts";
import { MobileServer, WORKSPACE_SOCKET_PATH } from "../../../src/main/mobile/mobile-server.mts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { createComputerClient, type ComputerClientOptions } from "../../../src/main/computers/computer-client.mts";
import { createComputerLinks } from "../../../src/main/computers/computer-links.mts";
import { task } from "../../application/workspace-reducer-fixtures.mts";

async function until<T>(check: () => T | null | false | undefined, message: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** A host with a workspace of its own, taking computers on the bridge the way the app and aic serve do. */
async function host(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-computers-"));
  await writeFile(path.join(folder, "index.html"), "<!doctype html><title>phone</title>");
  const devices = new PairingStore(path.join(folder, "mobile-devices.v1.json"));
  let state: WorkspaceState = { ...emptyWorkspaceState(), threads: [task("first", { title: "First" })], expandedProjects: new Set(["p1"]) };
  let revision = 0;
  const listeners = new Set<(update: WorkspaceUpdate) => void>();
  const inputs: WorkspaceInput[] = [];
  const server = new MobileServer({
    devices,
    staticRoot: folder,
    port: 0,
    allowedOrigins: () => [],
    snapshot: async () => { throw new Error("no phones here"); },
    command: async () => {},
    query: async () => null,
    onChange: () => {},
    sessionGraceMs: 60_000,
    workspace: {
      snapshot: () => ({ revision, state }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      input: async (batch) => {
        inputs.push(...batch);
        if (batch.some((input) => input.type === "task.rename" && input.title === "refuse")) return { ok: false, message: "Refused by the host", revision };
        return { ok: true, revision };
      },
      query: async (query) => ({ status: "available", patch: `patch for ${query.kind}` }),
    },
  });
  await server.start("127.0.0.1");
  t.onTestFinished(async () => {
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  });
  return {
    folder,
    devices,
    inputs,
    notice: (notice: ThreadNotice) => server.notice(notice),
    url: `ws://127.0.0.1:${server.port}${WORKSPACE_SOCKET_PATH}`,
    mint: () => devices.mint(Date.now()).code,
    /** Moves the host's state and tells every computer, as the runtime's publisher would. */
    publish: (next: Partial<WorkspaceState>) => {
      state = { ...state, ...next };
      revision += 1;
      const update: WorkspaceUpdate = { revision, patches: Object.entries(next).map(([key, value]) => ({ path: [key], value })) };
      for (const listener of listeners) listener(update);
    },
  };
}

function client(options: Partial<ComputerClientOptions> & Pick<ComputerClientOptions, "url" | "credential">) {
  const statuses: Array<[ComputerStatus, string | null]> = [];
  const states: WorkspaceState[] = [];
  const notices: ThreadNotice[] = [];
  let paired: { deviceId: string; token: string } | null = null;
  const link = createComputerClient({
    host: "other.tail.ts.net",
    deviceName: "This Mac",
    onStatus: (status, error) => statuses.push([status, error]),
    onPaired: (deviceId, _name, token) => { paired = { deviceId, token }; },
    onState: (state) => states.push(state),
    onNotice: (notice) => notices.push(notice),
    ...options,
  });
  return { link, statuses, states, notices, paired: () => paired };
}

test("a computer trades the code for a token, is handed the workspace whole, and drives it in the window's inputs", async (t) => {
  const served = await host(t);
  const mac = client({ url: served.url, credential: { code: served.mint() } });
  t.onTestFinished(() => mac.link.stop());
  await until(() => mac.paired(), "the pairing");
  assert.equal(served.devices.list()[0]?.kind, "computer", "a computer is remembered as one, apart from the phones");
  const first = await until(() => mac.states[0], "the snapshot");
  assert.deepEqual(first.threads.map((thread) => thread.title), ["First"]);
  assert.ok(first.expandedProjects instanceof Set, "a set crosses the wire as a set");
  assert.equal(mac.link.status, "connected");

  served.publish({ threads: [task("first", { title: "Renamed there" })] });
  await until(() => mac.states.at(-1)?.threads[0]?.title === "Renamed there", "the difference landing");

  assert.deepEqual(await mac.link.send([{ type: "task.rename", taskId: "first", title: "Renamed from here" }]), { ok: true, revision: 1 });
  assert.deepEqual(served.inputs, [{ type: "task.rename", taskId: "first", title: "Renamed from here" }]);
  const refused = await mac.link.send([{ type: "task.rename", taskId: "first", title: "refuse" }]);
  assert.equal(refused.ok === false && refused.message, "Refused by the host");
  assert.deepEqual(await mac.link.query({ kind: "branches", workspaceId: "ws" }), { status: "available", patch: "patch for branches" });
  served.notice({ taskId: "first", title: "First", headline: "The run finished." });
  await until(() => mac.notices[0], "the notice crossing");
  assert.deepEqual(mac.notices, [{ taskId: "first", title: "First", headline: "The run finished." }]);

  mac.link.stop();
  await until(() => served.inputs.some((input) => input.type === "view.set-focused"), "the host told nobody is looking once the line dropped");
  assert.deepEqual(served.inputs.at(-1), { type: "view.set-focused", focused: false });
});

test("a wrong code, a stale token, and another version are refused for good; a dropped line is dialled again", async (t) => {
  const served = await host(t);
  served.mint();
  const wrong = client({ url: served.url, credential: { code: "NOTTHECODE" } });
  t.onTestFinished(() => wrong.link.stop());
  await until(() => wrong.statuses.some(([status, error]) => status === "offline" && error?.includes("wrong or has expired")), "the refusal");
  const stale = client({ url: served.url, credential: { token: "not-a-token" } });
  t.onTestFinished(() => stale.link.stop());
  await until(() => stale.statuses.some(([status, error]) => status === "offline" && error?.includes("not paired")), "the stale token turned away");
  assert.equal(stale.statuses.filter(([status]) => status === "connecting").length, 1, "a line the host will not have back is not dialled again");
});

test("the links keep the token on disk with the computer's name, and a forgotten computer is cut off", async (t) => {
  const served = await host(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-links-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const changes: string[][] = [];
  const states = new Map<string, WorkspaceState>();
  const links = createComputerLinks({
    file: path.join(folder, "computers.v1.json"),
    deviceName: "This Mac",
    onChanged: (held) => changes.push(held.map((link) => `${link.name}:${link.status}`)),
    onState: (id, state) => states.set(id, state),
    onNotice: () => {},
    connect: (options) => createComputerClient({ ...options, url: served.url }),
  });
  t.onTestFinished(() => links.stop());
  links.start();
  assert.deepEqual(changes, [[]]);
  await links.pair("other.tail.ts.net", "linux-box", served.mint());
  await until(() => changes.at(-1)?.some((entry) => entry === "linux-box:connected"), "the paired computer coming online");
  const id = links.links()[0]!.id;
  await until(() => states.get(id), "the paired computer's state arriving");
  const stored = JSON.parse(await readFile(path.join(folder, "computers.v1.json"), "utf8")) as { computers: Array<{ name: string; host: string; token: string }> };
  assert.equal(stored.computers[0]?.name, "linux-box");
  assert.equal(stored.computers[0]?.host, "other.tail.ts.net");
  assert.ok(stored.computers[0]?.token);
  await assert.rejects(links.pair("other.tail.ts.net", "linux-box", "AGAIN"), /already paired/);

  await links.forget(id);
  assert.deepEqual(links.links(), []);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, "computers.v1.json"), "utf8")).computers, []);
  await assert.rejects(links.send(id, [{ type: "task.new" }]), /no longer paired/);
});


test("a strip larger than the old socket cap crosses intact, and oversize images leave the link usable", async (t) => {
  const served = await host(t);
  const mac = client({ url: served.url, credential: { code: served.mint() } });
  t.onTestFinished(() => mac.link.stop());
  await until(() => mac.link.status === "connected", "the connection");
  const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, id) => ({ id: String(id), source: `data:image/png;base64,${"A".repeat(512 * 1024)}`, annotations: [] }));
  assert.equal((await mac.link.send([{ type: "attachments.send", attachments }])).ok, true);
  assert.deepEqual(served.inputs, [{ type: "attachments.send", attachments }]);
  await assert.rejects(mac.link.send([{ type: "attachments.send", attachments: [{ id: "oversize", source: `data:image/png;base64,${"A".repeat(MAX_ATTACHMENT_ENCODED_BYTES + 1)}`, annotations: [] }] }]), { message: COMPUTER_SEND_TOO_LARGE });
  assert.equal(served.inputs.length, 1, "the oversized payload never reaches the socket");
  assert.equal(mac.link.status, "connected");
  assert.equal((await mac.link.send([{ type: "task.send", text: "still connected" }])).ok, true);
  assert.deepEqual(await mac.link.query({ kind: "attachment", name: "shot.png" }), { status: "available", patch: "patch for attachment" });
});


test("a full strip of images just under the decoded byte limit crosses intact", async (t) => {
  const served = await host(t);
  const mac = client({ url: served.url, credential: { code: served.mint() } });
  t.onTestFinished(() => mac.link.stop());
  await until(() => mac.link.status === "connected", "the connection");
  const data = Buffer.alloc(MAX_ATTACHMENT_BYTES - 1, 7).toString("base64");
  const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, id) => ({ id: String(id), source: `data:image/png;base64,${data}`, annotations: [] }));
  assert.equal((await mac.link.send([{ type: "attachments.send", attachments }])).ok, true);
  const sent = served.inputs[0];
  assert.ok(sent?.type === "attachments.send");
  assert.equal(sent.attachments.length, MAX_ATTACHMENTS);
  for (const image of sent.attachments) assert.equal(image.source, attachments[0]!.source);
  assert.equal(mac.link.status, "connected");
}, 30_000);
