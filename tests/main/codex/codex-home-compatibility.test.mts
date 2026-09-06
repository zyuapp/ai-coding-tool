import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AppServerClient, CLIENT_INFO, codexAppServer, type NotificationParams } from "../../../src/main/codex/app-server-client.mts";
import { PRIVATE_CODEX_HOME_ENV } from "../../../src/main/codex/codex-home.mts";
import type { ConfigReadResponse } from "../../../src/main/codex/protocol/v2/ConfigReadResponse.ts";
import type { ThreadListResponse } from "../../../src/main/codex/protocol/v2/ThreadListResponse.ts";

/** Real Codex with synthetic OAuth and Responses endpoints: no account, quota, or internet needed. */
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-compatibility-")));
  const shared = path.join(root, "shared");
  const privateHome = path.join(root, "private");
  const cwd = path.join(root, "workspace");
  const clients: AppServerClient[] = [];
  const bodies: string[] = [];
  let refreshes = 0;
  const jwt = (email: string) => `e30.${Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "pro" } })).toString("base64url")}.synthetic`;
  const server = createServer((request, response) => {
    if (request.url === "/oauth/token") {
      request.resume();
      refreshes++;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id_token: jwt(`refresh${refreshes}@example.invalid`), access_token: jwt(`refresh${refreshes}@example.invalid`), refresh_token: `synthetic-refresh-${refreshes}` }));
    } else if (request.url?.endsWith("/responses")) {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        bodies.push(body);
        const id = `response-${bodies.length}`;
        const events = [
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `message-${bodies.length}`, content: [{ type: "output_text", text: "Storage compatibility response." }] } },
          { type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
        ];
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      });
    } else {
      request.resume();
      response.writeHead(404).end();
    }
  });
  const close = async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await Promise.all([shared, cwd, path.join(root, "user")].map((directory) => mkdir(directory)));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    await mkdir(path.join(shared, "agents"));
    await mkdir(path.join(shared, "skills", "compatibility"), { recursive: true });
    await writeFile(path.join(shared, "agents", "instructions.md"), "SHARED_BASE_INSTRUCTIONS");
    await writeFile(path.join(shared, "AGENTS.md"), "SHARED_GLOBAL_INSTRUCTIONS");
    await writeFile(path.join(shared, "skills", "compatibility", "SKILL.md"), "---\nname: compatibility\ndescription: Synthetic compatibility fixture\n---\nUse only for the compatibility fixture.\n");
    await writeFile(path.join(shared, "config.toml"), `model = "mock-model"
model_provider = "compatibility"
model_instructions_file = "agents/instructions.md"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
sqlite_home = "${shared}"
log_dir = "${shared}/log"
[features]
plugins = false
apps = false
remote_plugin = false
hooks = false
shell_snapshot = false
enable_request_compression = false
goals = true
[model_providers.compatibility]
name = "Local compatibility fixture"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(root, "user"), TMPDIR: root, CODEX_HOME: shared, CODEX_SQLITE_HOME: shared, [PRIVATE_CODEX_HOME_ENV]: privateHome, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${url}/oauth/token` };
    const start = async (sharedHome = false, auth = false) => {
      const overrides = auth ? ["-c", 'model_provider="openai"', "-c", `chatgpt_base_url="${url}"`] : [];
      const command = await codexAppServer(overrides, { env, cwd, sharedHome });
      // Candidate binaries can be checked before replacing the development pin.
      command.executable = process.env.CODEX_COMPAT_BINARY || path.resolve("node_modules/.bin/codex");
      const client = new AppServerClient(command);
      clients.push(client);
      const initialized = await client.initialize(CLIENT_INFO);
      assert.equal(initialized.codexHome, sharedHome ? shared : privateHome);
      return client;
    };
    return { root, shared, privateHome, cwd, start, close, bodies, jwt, refreshes: () => refreshes };
  } catch (error) {
    await close();
    throw error;
  }
}

async function turn(client: AppServerClient, threadId: string) {
  let unsubscribe = () => {};
  const completed = new Promise<NotificationParams<"turn/completed">>((resolve) => {
    unsubscribe = client.on("turn/completed", (params) => { if (params.threadId === threadId) resolve(params); });
  });
  try {
    await client.request("turn/start", { threadId, input: [{ type: "text", text: "Return the fixture response.", text_elements: [] }] });
    assert.equal((await completed).turn.status, "completed");
  } finally { unsubscribe(); }
}

async function listed(client: AppServerClient) {
  return ((await client.request("thread/list", { modelProviders: [], limit: 100 })) as ThreadListResponse).data.map(({ id }) => id);
}

test("Codex binary preserves shared settings/auth and isolates durable conversation state", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  try {
    const original = await f.start(true);
    let isolated = await f.start();
    const privateConfig = (await isolated.request("config/read", { includeLayers: false })) as ConfigReadResponse;
    assert.equal(privateConfig.config.sqlite_home, f.privateHome);
    const skills = await isolated.request("skills/list", { cwds: [f.cwd], forceReload: true });
    assert(skills.data.flatMap(({ skills }) => skills).some(({ name }) => name === "compatibility"));
    const sharedId = (await original.request("thread/start", { cwd: f.cwd })).thread.id;
    const privateId = (await isolated.request("thread/start", { cwd: f.cwd })).thread.id;
    await turn(original, sharedId); await turn(isolated, privateId);
    assert(f.bodies.at(-1)?.includes("SHARED_BASE_INSTRUCTIONS"));
    assert(f.bodies.at(-1)?.includes("SHARED_GLOBAL_INSTRUCTIONS"));
    assert.deepEqual(await listed(original), [sharedId]);
    assert.deepEqual(await listed(isolated), [privateId]);
    await isolated.request("thread/name/set", { threadId: privateId, name: "Private title" });
    await isolated.request("thread/goal/set", { threadId: privateId, objective: "Fixture goal", tokenBudget: 100 });
    await isolated.close();
    isolated = await f.start();
    assert.equal((await isolated.request("thread/resume", { threadId: privateId, cwd: f.cwd })).thread.name, "Private title");
    assert.equal((await isolated.request("thread/goal/get", { threadId: privateId })).goal?.objective, "Fixture goal");
    await isolated.request("thread/goal/clear", { threadId: privateId });
    await turn(isolated, privateId);
    const forkId = (await isolated.request("thread/fork", { threadId: privateId, cwd: f.cwd })).thread.id;
    await turn(isolated, forkId);
    await isolated.request("thread/archive", { threadId: privateId });
    await isolated.request("thread/unarchive", { threadId: privateId });
    await isolated.request("thread/resume", { threadId: privateId, cwd: f.cwd });
    assert.deepEqual(await listed(original), [sharedId]);
    await isolated.request("config/value/write", { keyPath: "model_reasoning_effort", value: "low", mergeStrategy: "replace" });
    assert.equal(await readlink(path.join(f.privateHome, "config.toml")), path.join(f.shared, "config.toml"));
    assert((await readFile(path.join(f.shared, "config.toml"), "utf8")).includes('model_reasoning_effort = "low"'));
    await original.close(); await isolated.close();

    await writeFile(path.join(f.shared, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: f.jwt("initial@example.invalid"), id_token: f.jwt("initial@example.invalid"), refresh_token: "synthetic-initial", account_id: "synthetic-account" }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
    const account = await f.start(true, true);
    const conversation = await f.start(false, true);
    const initial = await account.request("account/read", { refreshToken: false });
    assert(initial.account?.type === "chatgpt");
    assert.equal(initial.account.email, "initial@example.invalid");
    const refreshed = await conversation.request("account/read", { refreshToken: true });
    const reread = await account.request("account/read", { refreshToken: true });
    assert.deepEqual(refreshed.account, reread.account);
    assert(refreshed.account?.type === "chatgpt");
    assert.equal(refreshed.account.email, "refresh1@example.invalid");
    assert.equal(f.refreshes(), 1, "the second process reloads the token instead of reusing its old refresh token");
    assert.equal(await readlink(path.join(f.privateHome, "auth.json")), path.join(f.shared, "auth.json"));
    await account.close(); await conversation.close();

    // Exercise link removal without revoking OAuth credentials, even synthetic ones.
    await writeFile(path.join(f.shared, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-key" }));
    const logout = await f.start();
    await logout.request("account/logout");
    await logout.close();
    const repaired = await f.start(false, true);
    assert.equal((await repaired.request("account/read", { refreshToken: false })).account?.type, "apiKey");
    assert.equal(await readlink(path.join(f.privateHome, "auth.json")), path.join(f.shared, "auth.json"));
  } finally { await f.close(); }
}, 30_000);
