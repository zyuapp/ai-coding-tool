import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { OpenCodeError, readLoaded, startOpenCodeServer, unreadLine, WATCHED_SERVE, type OpenCodeEvent } from "../../../src/main/opencode/opencode-server.mts";
import { temporaryDirectory } from "../../support/temporary-directory.mts";

/** An `opencode` that serves the few routes these tests read, behind a password, and notes its pid. */
const FAKE = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const password = "pw-" + process.pid;
const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) return response.writeHead(401).end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
  if (request.url === "/api/model") return response.end(JSON.stringify({ location: { directory: process.cwd() }, data: [{ id: "m", providerID: "p", config: process.env.OPENCODE_CONFIG_CONTENT }] }));
  if (request.url === "/api/missing") return response.writeHead(404).end(JSON.stringify({ _tag: "SessionNotFoundError", message: "Session not found: x" }));
  if (request.url === "/api/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"server.connected"}\\n\\n');
    response.write('data: {"type":"session.text.delta","data":{"sessionID":"s","delta":"he"}}\\n\\ndata: {"type":"session.text.de');
    setTimeout(() => response.write('lta","data":{"sessionID":"s","delta":"llo"}}\\n\\n: heartbeat\\n\\n'), 20);
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  console.log("Server listening on http://127.0.0.1:" + server.address().port);
  console.log("server password " + password);
});
`;

async function fakeOpenCode() {
  const directory = await temporaryDirectory(path.join(os.tmpdir(), "fake-opencode-"));
  const binary = path.join(directory, "opencode");
  await writeFile(binary, FAKE);
  await chmod(binary, 0o755);
  const pidFile = path.join(directory, "pid");
  const previous = { path: process.env.PATH, pid: process.env.FAKE_PID_FILE };
  process.env.PATH = `${directory}${path.delimiter}${previous.path ?? ""}`;
  process.env.FAKE_PID_FILE = pidFile;
  return {
    directory,
    pid: async () => Number(await readFile(pidFile, "utf8")),
    restore: () => {
      process.env.PATH = previous.path;
      process.env.FAKE_PID_FILE = previous.pid;
    },
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number) {
  for (const deadline = Date.now() + 8_000; Date.now() < deadline;) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("a server is started behind its own password, in the folder asked, with the config it was given, and stopped on close", async () => {
  const fake = await fakeOpenCode();
  try {
    const client = await startOpenCodeServer({ cwd: fake.directory, config: { mcp: { app: { type: "remote" } } } });
    const [model] = await client.request<{ config: string }[]>("GET", "/api/model");
    assert.deepEqual(JSON.parse(model!.config), { mcp: { app: { type: "remote" } } });
    await assert.rejects(client.request("GET", "/api/missing"), (error: unknown) => error instanceof OpenCodeError && error.status === 404 && error.tag === "SessionNotFoundError" && error.message === "Session not found: x");

    const events: OpenCodeEvent[] = [];
    client.subscribe((event) => events.push(event));
    for (const deadline = Date.now() + 5_000; events.length < 3 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, [
      { type: "server.connected" },
      { type: "session.text.delta", data: { sessionID: "s", delta: "he" } },
      { type: "session.text.delta", data: { sessionID: "s", delta: "llo" } },
    ], "a frame split across chunks arrives whole, and a comment is skipped");

    const pid = await fake.pid();
    await client.close();
    assert.ok(await gone(pid), "closing stops the server");
  } finally {
    fake.restore();
  }
});

test("a server outlives nothing: when the app dies without closing it, it stops too", async () => {
  const fake = await fakeOpenCode();
  try {
    /** The app as the server sees it: a process holding the watchdog's stdin, killed before it can close anything. */
    const script = `
      const { spawn } = require("node:child_process");
      const server = spawn("/bin/sh", ["-c", ${JSON.stringify(WATCHED_SERVE)}, ${JSON.stringify(path.join(fake.directory, "opencode"))}], { stdio: ["pipe", "pipe", "inherit"] });
      server.stdout.on("data", (chunk) => { if (String(chunk).includes("server password")) process.kill(process.pid, "SIGKILL"); });
    `;
    const parent = spawn(process.execPath, ["-e", script], { env: process.env, stdio: "ignore" });
    await new Promise((resolve) => parent.once("exit", resolve));
    const pid = await fake.pid();
    assert.ok(await gone(pid), "the server stopped once the app was gone");
  } finally {
    fake.restore();
  }
});

test("the server the app asks outside a run stops when the app closes its engine services", async () => {
  const fake = await fakeOpenCode();
  try {
    const { engineServices, closeEngineServices } = await import("../../../src/main/engines.mts");
    await engineServices.opencode.commands({ workspaceRoot: fake.directory, projectless: false });
    const pid = await fake.pid();
    assert.ok(alive(pid), "the services server stays up between questions");
    await closeEngineServices();
    assert.ok(await gone(pid), "closing the services stops their server");
  } finally {
    fake.restore();
  }
});

test("a server that ignores being asked to stop is killed", async () => {
  const fake = await fakeOpenCode();
  try {
    const binary = path.join(fake.directory, "opencode");
    await writeFile(binary, (await readFile(binary, "utf8")).replace("const http = require", "process.on(\"SIGTERM\", () => {});\nconst http = require"));
    const client = await startOpenCodeServer({ cwd: fake.directory });
    const pid = await fake.pid();
    await client.close();
    assert.ok(await gone(pid), "a server deaf to SIGTERM is killed after its grace");
  } finally {
    fake.restore();
  }
}, 15_000);

test("a server that also mentions its password elsewhere still starts once both lines are read", async () => {
  const fake = await fakeOpenCode();
  try {
    const binary = path.join(fake.directory, "opencode");
    /** Each line in a tick of its own, so the warning and the address arrive before the password does. */
    const spaced = [
      'console.log("Warning: OPENCODE_SERVER_PASSWORD is not set, generating one");',
      'setTimeout(() => console.log("Server listening on http://127.0.0.1:" + server.address().port), 50);',
      'setTimeout(() => console.log("server password " + password), 100);',
    ].join("\n  ");
    await writeFile(binary, (await readFile(binary, "utf8"))
      .replace('console.log("Server listening on http://127.0.0.1:" + server.address().port);\n  console.log("server password " + password);', spaced));
    assert.match(await readFile(binary, "utf8"), /setTimeout\(\(\) => console\.log\("server password/);
    const client = await startOpenCodeServer({ cwd: fake.directory });
    assert.ok(Array.isArray(await client.request("GET", "/api/model")));
    await client.close();
  } finally {
    fake.restore();
  }
});

test("a server that dies before it is ready reports why", async () => {
  const fake = await fakeOpenCode();
  try {
    await writeFile(path.join(fake.directory, "opencode"), "#!/bin/sh\necho 'config is invalid' >&2\nexit 3\n");
    await assert.rejects(startOpenCodeServer({ cwd: fake.directory }), /config is invalid/);
  } finally {
    fake.restore();
  }
});

test("a list read while the server loads its folder is read again until it settles", async () => {
  const answers = [[], ["a"], ["a", "b"], ["a", "b"]];
  let asked = 0;
  const list = await readLoaded<string>({ request: async () => answers[asked++] as never }, "/api/skill", 1);
  assert.deepEqual(list, ["a", "b"]);
  assert.equal(asked, 4);
  let never = 0;
  assert.deepEqual(await readLoaded<string>({ request: async () => { never += 1; return [] as never; } }, "/api/skill", 1), []);
  assert.equal(never, 10, "an empty folder is believed after a few seconds");
  let again = 0;
  const client = { request: async () => { again += 1; return ["a"] as never; } };
  await readLoaded<string>(client, "/api/command", 1);
  assert.equal(again, 2);
  assert.deepEqual(await readLoaded<string>(client, "/api/command", 1), ["a"]);
  assert.equal(again, 3, "a list the server has loaded is read once from then on");
  await readLoaded<string>(client, "/api/skill", 1);
  assert.equal(again, 5, "another list is still waited on");
});

test("a start that never said how to reach it blames the last line naming what is missing, and a slow start blames nothing", () => {
  assert.equal(unreadLine("Loading models…\n"), undefined);
  assert.equal(unreadLine("Server listening on http://127.0.0.1:5555\n"), undefined, "a password never mentioned is a slow start");
  assert.equal(unreadLine("Ready, listening at port 5555\nserver password abc\n"), "Ready, listening at port 5555");
  assert.equal(unreadLine("Warning: OPENCODE_SERVER_PASSWORD is not set\nServer listening on http://127.0.0.1:5555\npassword: abc\n"), "password: abc", "the last such line, not a warning before it");
  assert.equal(unreadLine("Warning: OPENCODE_SERVER_PASSWORD is not set\nReady, listening at port 5555\nserver password abc\n"), "Ready, listening at port 5555", "a read password leaves only the address to blame");
});
