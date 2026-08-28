import assert from "node:assert/strict";
import { test } from "vitest";
import { EngineAccessHost } from "../../../src/main/agent/engine-services.mts";
import { readCodexAccess, signInToCodex, type AccountConnect } from "../../../src/main/codex/codex-account.mts";
import { FakeCodexClient, tick, type Script } from "../../support/codex-client.mjs";

const signedIn: Script = { "account/read": () => ({ account: { type: "chatgpt", email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: true }) };
const signedOut: Script = { "account/read": () => ({ account: null, requiresOpenaiAuth: true }) };

/** The host over Claude, which is always ready, and a Codex whose app servers are scripted fakes. */
function hostOver(connect: AccountConnect) {
  return new EngineAccessHost({
    claude: { readiness: async () => ({ access: "ready" }) },
    codex: { readiness: async () => ({ access: await readCodexAccess(connect) }), signIn: (openUrl) => signInToCodex(openUrl, connect) },
  });
}

function host(script: Script, handshake?: () => Promise<never>) {
  const clients: FakeCodexClient[] = [];
  const access = hostOver((command) => {
    const client = new FakeCodexClient(command, script, handshake);
    clients.push(client);
    return client;
  });
  return { access, clients };
}

test("Codex is ready with an account, signed out without one, and asked once per process", async () => {
  const ready = host(signedIn);
  assert.deepEqual(await ready.access.read(), { claude: { access: "ready" }, codex: { access: "ready" } });
  assert.deepEqual(await ready.access.read(), { claude: { access: "ready" }, codex: { access: "ready" } });
  assert.equal(ready.clients.length, 1, "the answer is kept rather than asked again");
  assert.deepEqual(ready.clients[0].sent.map((call) => call.method), ["initialize", "account/read"]);
  assert.deepEqual(ready.clients[0].command.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(ready.clients[0].closed, true, "the server only lives for the question");

  const out = host(signedOut);
  assert.deepEqual(await out.access.read(), { claude: { access: "ready" }, codex: { access: "signed-out" } });
});

test("a Codex that will not start, or cannot be found, is unavailable rather than an error", async () => {
  const stopped = host(signedIn, () => Promise.reject(new Error("spawn ENOENT")));
  assert.deepEqual(await stopped.access.read(), { claude: { access: "ready" }, codex: { access: "unavailable" } });
  assert.equal(stopped.clients[0].closed, true);

  const missing = hostOver(() => { throw new Error("Codex is not bundled for linux x64."); });
  assert.deepEqual(await missing.read(), { claude: { access: "ready" }, codex: { access: "unavailable" } });
});

test("signing in opens the URL Codex hands back, waits for the browser to return, and reads the account again", async () => {
  let account: { type: "chatgpt"; email: string; planType: "pro" } | null = null;
  const { access, clients } = host({
    "account/read": () => ({ account, requiresOpenaiAuth: true }),
    "account/login/start": () => ({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/authorize?x=1" }),
  });
  assert.deepEqual(await access.read(), { claude: { access: "ready" }, codex: { access: "signed-out" } });

  const opened: string[] = [];
  const signingIn = access.signIn("codex", async (url) => { opened.push(url); });
  const again = access.signIn("codex", async (url) => { opened.push(url); });
  assert.equal(again, signingIn, "a second ask while the browser is out joins the first");
  for (let waited = 0; clients.length < 2 || clients[1].calls("account/login/start").length === 0; waited += 1) {
    assert.ok(waited < 100, "login never started");
    await tick();
  }
  const client = clients[1];
  assert.deepEqual(client.calls("account/login/start"), [{ type: "chatgpt" }]);
  await tick();
  assert.deepEqual(opened, ["https://auth.example/authorize?x=1"]);
  assert.equal(client.closed, false, "the server outlives the round trip, since it is what the browser returns to");

  account = { type: "chatgpt", email: "dev@example.com", planType: "pro" };
  client.notify("account/login/completed", { loginId: "login-1", success: true, error: null, onboardingEntrypoint: null });
  assert.deepEqual(await signingIn, { claude: { access: "ready" }, codex: { access: "ready" } });
  assert.equal(client.closed, true);
  assert.deepEqual(await access.read(), { claude: { access: "ready" }, codex: { access: "ready" } }, "the status is what the sign-in found");
  assert.equal(clients.length, 2, "reading after a sign-in asks nothing new");

  assert.deepEqual(await access.signIn("claude", async () => {}), { claude: { access: "ready" }, codex: { access: "ready" } }, "an engine with no sign-in of its own answers with the status as it stands");
});

test("a sign-in the browser brings back as failed, or a server that dies under it, is reported and leaves the status alone", async () => {
  const failing = host({
    "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    "account/login/start": () => ({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/authorize" }),
  });
  assert.deepEqual(await failing.access.read(), { claude: { access: "ready" }, codex: { access: "signed-out" } });
  const failed = failing.access.signIn("codex", async () => {});
  for (let waited = 0; failing.clients.length < 2 || failing.clients[1].calls("account/login/start").length === 0; waited += 1) await tick();
  failing.clients[1].notify("account/login/completed", { loginId: "login-1", success: false, error: "The browser was closed.", onboardingEntrypoint: null });
  await assert.rejects(failed, /The browser was closed/);
  assert.deepEqual(await failing.access.read(), { claude: { access: "ready" }, codex: { access: "signed-out" } });

  const dying = host({
    "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
    "account/login/start": () => ({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/authorize" }),
  });
  await dying.access.read();
  const died = dying.access.signIn("codex", async () => {});
  for (let waited = 0; dying.clients.length < 2 || dying.clients[1].calls("account/login/start").length === 0; waited += 1) await tick();
  dying.clients[1].exit({ code: 1, signal: null, stderr: "boom" });
  await assert.rejects(died, /Codex stopped before the sign-in finished/);
  const retried = dying.access.signIn("codex", async () => {});
  for (let waited = 0; dying.clients.length < 3; waited += 1) await tick();
  assert.equal(dying.clients.length, 3, "a failed sign-in can be tried again");
  dying.clients[2].exit({ code: 1, signal: null, stderr: "boom" });
  await assert.rejects(retried);
});
