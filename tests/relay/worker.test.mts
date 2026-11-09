import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apnsPayload, handle, isPushRequest, providerToken, type PushRequest, type RelayEnv } from "../../relay/worker.mts";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const env: RelayEnv = { APNS_KEY: pem, APNS_KEY_ID: "KEY1234567", APPLE_TEAM_ID: "TEAM123456", APNS_TOPIC: "com.example.app" };

const push: PushRequest = {
  token: "a".repeat(64),
  environment: "production",
  title: "Fix the build",
  body: "Waiting for your permission to use Bash",
  thread: "computer-1:task-1",
  data: { taskId: "task-1", computer: "computer-1" },
};

function post(body: unknown) {
  return new Request("https://relay.test/v1/push", { method: "POST", body: JSON.stringify(body) });
}

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function apns(status: number, reason?: string) {
  const sent: Sent[] = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(reason ? JSON.stringify({ reason }) : null, { status });
  }) as typeof fetch;
  return { sent, send };
}

describe("relay request", () => {
  it("takes a well-formed notice", () => {
    expect(isPushRequest(push)).toBe(true);
  });

  it("refuses a token that is not hex, an unknown environment, and data that would replace aps", () => {
    expect(isPushRequest({ ...push, token: "not-a-token" })).toBe(false);
    expect(isPushRequest({ ...push, environment: "staging" })).toBe(false);
    expect(isPushRequest({ ...push, data: { aps: "x" } })).toBe(false);
    expect(isPushRequest({ ...push, title: "" })).toBe(false);
  });

  it("puts the thread's notices in one group with sound", () => {
    expect(apnsPayload(push)).toEqual({
      aps: { alert: { title: "Fix the build", body: "Waiting for your permission to use Bash" }, sound: "default", "thread-id": "computer-1:task-1" },
      taskId: "task-1",
      computer: "computer-1",
    });
  });
});

describe("provider token", () => {
  it("is an ES256 JWT APNs can verify with the key's public half", async () => {
    const token = await providerToken(env, Date.UTC(2026, 0, 1));
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: Date.UTC(2026, 0, 1) / 1_000 });
    const valid = verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
    expect(valid).toBe(true);
  });
});

describe("relay", () => {
  it("sends an alert push to the phone's environment, collapsed by thread", async () => {
    const { sent, send } = apns(200);
    const response = await handle(post({ ...push, environment: "sandbox" }), env, send);
    expect(response.status).toBe(200);
    expect(sent[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${push.token}`);
    expect(sent[0]!.headers).toMatchObject({ "apns-topic": "com.example.app", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "computer-1:task-1" });
    expect(sent[0]!.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("says a token Apple no longer takes is gone", async () => {
    const response = await handle(post(push), env, apns(410, "Unregistered").send);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ ok: false, gone: true, reason: "Unregistered" });
  });

  it("keeps a token through an error that is not about it", async () => {
    const response = await handle(post(push), env, apns(429, "TooManyRequests").send);
    expect(await response.json()).toEqual({ ok: false, gone: false, reason: "TooManyRequests" });
  });

  it("refuses a phone over its limit before calling Apple", async () => {
    const { sent, send } = apns(200);
    const limited: RelayEnv = { ...env, PER_DEVICE: { limit: async () => ({ success: false }) } };
    const response = await handle(post(push), limited, send);
    expect(response.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it("refuses an unreadable body and unknown paths", async () => {
    expect((await handle(post({ token: "x" }), env, apns(200).send)).status).toBe(400);
    expect((await handle(new Request("https://relay.test/other", { method: "POST" }), env, apns(200).send)).status).toBe(404);
  });
});
