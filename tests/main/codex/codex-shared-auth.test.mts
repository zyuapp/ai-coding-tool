import assert from "node:assert/strict";
import { test } from "vitest";
import { acquireSharedAuth, sharedAuthLogin } from "../../../src/main/codex/codex-shared-auth.mts";
import type { GetAuthStatusResponse } from "../../../src/main/codex/protocol/GetAuthStatusResponse.ts";

test("shared auth forwards supported access credentials without losing account identity", () => {
  const status = { authMethod: "apikey", authToken: "synthetic-api-key", requiresOpenaiAuth: true } as const;
  assert.deepEqual(sharedAuthLogin(status), { type: "apiKey", apiKey: "synthetic-api-key" });
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "pro" } })).toString("base64url")}.fixture`;
  assert.deepEqual(sharedAuthLogin({ ...status, authMethod: "chatgpt", authToken: token }), { type: "chatgptAuthTokens", accessToken: token, chatgptAccountId: "fixture-account", chatgptPlanType: "pro" });
  assert.throws(() => sharedAuthLogin({ ...status, authMethod: "chatgpt", authToken: "invalid-synthetic-token" }), (error: Error) => !error.message.includes("invalid-synthetic-token") && /unreadable/.test(error.message));
  assert.throws(() => sharedAuthLogin({ ...status, authMethod: "headers", authToken: null }), /cannot share headers authentication/);
  assert.equal(sharedAuthLogin({ ...status, authMethod: null, authToken: null }), null);
});

test("concurrent conversations share one auth connection and one in-flight refresh", async () => {
  type Client = ReturnType<Parameters<typeof acquireSharedAuth>[1]>;
  let opened = 0;
  let closed = 0;
  let reads = 0;
  let finish!: (status: GetAuthStatusResponse) => void;
  const status = new Promise<GetAuthStatusResponse>((resolve) => { finish = resolve; });
  const connect = (): Client => ({
    initialize: async () => { opened++; return {} as Awaited<ReturnType<Client["initialize"]>>; },
    request: async () => { reads++; return await status as never; },
    close: async () => { closed++; return { code: 0, signal: null, stderr: "" }; },
  });
  const command = { executable: "fixture-codex", args: [], env: { CODEX_HOME: "/synthetic/shared/auth" } };
  const [one, two] = await Promise.all([acquireSharedAuth(command, connect), acquireSharedAuth(command, connect)]);
  const pending = Promise.all([one.read(true), two.read(true)]);
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(reads, 1);
  finish({ authMethod: "apikey", authToken: "synthetic", requiresOpenaiAuth: true });
  assert.deepEqual(await pending, [{ type: "apiKey", apiKey: "synthetic" }, { type: "apiKey", apiKey: "synthetic" }]);
  await one.release();
  assert.equal(closed, 0);
  await two.release(); await two.release();
  assert.equal(closed, 1);
});
