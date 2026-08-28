import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { AppServerClient, AppServerError, AppServerExited, type IncomingRequest } from "../../../src/main/codex/app-server-client.mts";
import type { ModelListResponse } from "../../../src/main/codex/protocol/v2/ModelListResponse.ts";
import type { ThreadListResponse } from "../../../src/main/codex/protocol/v2/ThreadListResponse.ts";

const fakeServer = fileURLToPath(new URL("../../support/fake-app-server.mts", import.meta.url));
const clientInfo = { name: "test-client", title: null, version: "0" };
const clients: AppServerClient[] = [];

function connect() {
  const client = new AppServerClient({ executable: process.execPath, args: ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", fakeServer] });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("the handshake initializes, then tells the server so before anything else is sent", async () => {
  const client = connect();
  const server = await client.initialize(clientInfo);

  assert.equal(server.userAgent, "fake/test-client");
  const models = await client.request("model/list", {});
  assert.equal((models as { initialized?: boolean }).initialized, true);
});

test("responses pair with their own request whatever order they arrive in", async () => {
  const client = connect();
  await client.initialize(clientInfo);

  const settled: string[] = [];
  const started = client.request("thread/start", { model: "gpt-5.6-sol" }).then((result) => { settled.push("thread/start"); return result; });
  const listed = client.request("model/list", {}).then((result) => { settled.push("model/list"); return result as ModelListResponse; });

  const [thread, models] = await Promise.all([started, listed]);
  assert.equal(thread.thread.id, "thread-1");
  assert.equal(thread.model, "gpt-5.6-sol");
  assert.deepEqual(models.data, []);
  assert.deepEqual(settled, ["model/list", "thread/start"]);
});

test("an error response rejects with the server's code, message, and data", async () => {
  const client = connect();
  await client.initialize(clientInfo);

  const error = await client.request("thread/read", { threadId: "missing", includeTurns: false }).then(() => null, (error: unknown) => error);
  assert.ok(error instanceof AppServerError);
  assert.equal(error.code, -32600);
  assert.equal(error.message, "thread/read: no such thread");
  assert.deepEqual(error.data, { threadId: "missing" });
});

test("notifications reach their handlers until unsubscribed, and a server request round-trips through its handler", async () => {
  const client = connect();
  await client.initialize(clientInfo);
  const started: string[] = [];
  const stopListening = client.on("turn/started", (params) => started.push(params.turn.id));
  const requests: IncomingRequest[] = [];
  client.onRequest((request) => {
    requests.push(request);
    if (request.method === "item/commandExecution/requestApproval") request.respond({ decision: "decline" });
  });
  const completed = new Promise<unknown>((resolve) => client.on("turn/completed", (params) => resolve(params.turn)));

  const turn = await client.request("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "go", text_elements: [] }] });

  assert.equal(turn.turn.id, "turn-1");
  assert.deepEqual(started, ["turn-1"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "item/commandExecution/requestApproval");
  assert.equal((requests[0].params as { command: string }).command, "rm -rf build");
  assert.deepEqual((await completed as { reply: unknown }).reply, { decision: "decline" });

  stopListening();
  await client.request("turn/start", { threadId: "thread-1", input: [] });
  assert.deepEqual(started, ["turn-1"]);
});

test("a server request nobody handles is refused rather than left waiting", async () => {
  const client = connect();
  await client.initialize(clientInfo);
  const completed = new Promise<unknown>((resolve) => client.on("turn/completed", (params) => resolve(params.turn)));

  await client.request("turn/start", { threadId: "thread-1", input: [] });

  const reply = (await completed as { reply: { code: number; message: string } }).reply;
  assert.equal(reply.code, -32601);
  assert.match(reply.message, /item\/commandExecution\/requestApproval/);
});

test("a message split across writes, or sharing a write with the next, is framed by newline alone", async () => {
  const client = connect();
  await client.initialize(clientInfo);
  const warned = new Promise<string>((resolve) => client.on("warning", (params) => resolve((params as { message: string }).message)));

  const threads = await client.request("thread/list", {}) as ThreadListResponse;

  assert.equal(threads.data.length, 1);
  assert.equal((threads.data[0] as { id: string }).id.length, 200_000);
  assert.equal(await warned, "framed");
});

test("the child exiting rejects every pending request with its exit status and stderr, and refuses later ones", async () => {
  const client = connect();
  await client.initialize(clientInfo);

  const [logout, thread] = await Promise.all([
    client.request("account/logout").then(() => null, (error: unknown) => error),
    client.request("thread/start", {}).then(() => null, (error: unknown) => error),
  ]);

  for (const error of [logout, thread]) {
    assert.ok(error instanceof AppServerExited);
    assert.equal(error.exit.code, 3);
    assert.match(error.message, /exited with code 3/);
    assert.match(error.message, /fatal: signed out/);
  }
  assert.match((logout as AppServerExited).message, /account\/logout was pending/);
  assert.equal((await client.exited).code, 3);
  const later = await client.request("model/list", {}).then(() => null, (error: unknown) => error);
  assert.ok(later instanceof AppServerExited);
  assert.match(later.message, /before model\/list/);
});

test("closing kills the child and settles its exit", async () => {
  const client = connect();
  await client.initialize(clientInfo);

  const exit = await client.close();

  assert.equal(exit.code, 0);
  assert.equal(exit, await client.exited);
});
