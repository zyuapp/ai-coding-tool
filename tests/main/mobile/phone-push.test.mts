import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isMobileClientMessage } from "../../../src/contracts/mobile.ts";
import { deviceView, type PhonePush } from "../../../src/domain/mobile.ts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { PUSH_RELAY_URL, pushToPhones } from "../../../src/main/mobile/phone-push.mts";

const AT = 1_700_000_000_000;
const TOKEN = "ab".repeat(32);
const PUSH: PhonePush = { token: TOKEN, environment: "production" };
const NOTICE = { taskId: "task-1", title: "Fix the build", headline: "Waiting for your permission to use Bash" };

async function store(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-push-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "mobile-devices.v1.json");
  const devices = new PairingStore(file);
  const pair = (name: string, kind: "phone" | "computer" = "phone") => {
    const outcome = devices.redeem(devices.mint(AT).code, name, "10.0.0.9", AT + 1, kind);
    assert.ok(outcome.ok);
    return outcome.device.id;
  };
  return { file, devices, pair, reopen: () => new PairingStore(file) };
}

function relay(status: number) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    return new Response(null, { status });
  }) as typeof fetch;
  return { sent, send };
}

test("a phone's push token is kept across launches and never shown to settings", async (t) => {
  const { devices, pair, reopen } = await store(t);
  const phone = pair("iPhone");
  devices.setPush(phone, PUSH);

  const reopened = reopen();
  assert.deepEqual(reopened.pushTargets().map((device) => [device.id, device.push]), [[phone, PUSH]]);
  assert.equal("push" in deviceView(reopened.list()[0]!), false);
});

test("a token moves to the newest pairing of the same phone, and a phone can give it up", async (t) => {
  const { devices, pair } = await store(t);
  const old = pair("iPhone");
  const fresh = pair("iPhone");
  devices.setPush(old, PUSH);
  devices.setPush(fresh, PUSH);
  assert.deepEqual(devices.pushTargets().map((device) => device.id), [fresh]);

  devices.setPush(fresh, null);
  assert.deepEqual(devices.pushTargets(), []);
});

test("only phones take a push token", async (t) => {
  const { devices, pair } = await store(t);
  const computer = pair("Studio", "computer");
  devices.setPush(computer, PUSH);
  assert.deepEqual(devices.pushTargets(), []);
});

test("a push token that does not read is dropped without unpairing the phone", async (t) => {
  const { file, devices, pair, reopen } = await store(t);
  pair("iPhone");
  const stored = JSON.parse(await readFile(file, "utf8")) as { devices: Array<Record<string, unknown>> };
  stored.devices[0]!.push = { token: "nope", environment: "production" };
  await writeFile(file, JSON.stringify(stored));

  const reopened = reopen();
  assert.equal(reopened.list().length, 1);
  assert.deepEqual(reopened.pushTargets(), []);
  assert.equal(devices.list().length, 1);
});

test("a phone may send its token, or give it up, and nothing else of that kind", () => {
  assert.equal(isMobileClientMessage({ kind: "push-token", push: PUSH }), true);
  assert.equal(isMobileClientMessage({ kind: "push-token", push: null }), true);
  assert.equal(isMobileClientMessage({ kind: "push-token", push: { token: "zz", environment: "production" } }), false);
  assert.equal(isMobileClientMessage({ kind: "push-token", push: { token: TOKEN, environment: "beta" } }), false);
});

test("a notice reaches each phone through the relay, grouped by thread and naming what a tap opens", async (t) => {
  const { devices, pair } = await store(t);
  const phone = pair("iPhone");
  devices.setPush(phone, { ...PUSH, environment: "sandbox" });
  const { sent, send } = relay(200);

  await pushToPhones(devices, { ...NOTICE, headline: `  Waiting\n for ${"x".repeat(400)}` }, send);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, PUSH_RELAY_URL);
  const body = sent[0]!.body;
  assert.equal(body.token, TOKEN);
  assert.equal(body.environment, "sandbox");
  assert.equal(body.title, "Fix the build");
  assert.equal((body.body as string).length, 300);
  assert.ok((body.body as string).startsWith("Waiting for xxx"));
  assert.equal(body.thread, `${phone}:task-1`);
  assert.deepEqual(body.data, { taskId: "task-1", deviceId: phone });
});

test("a phone Apple says is gone stops being told; a failing relay changes nothing", async (t) => {
  const { devices, pair } = await store(t);
  const phone = pair("iPhone");
  devices.setPush(phone, PUSH);

  await pushToPhones(devices, NOTICE, relay(502).send);
  assert.equal(devices.pushTargets().length, 1);

  await pushToPhones(devices, NOTICE, (async () => { throw new Error("offline"); }) as typeof fetch);
  assert.equal(devices.pushTargets().length, 1);

  await pushToPhones(devices, NOTICE, relay(410).send);
  assert.deepEqual(devices.pushTargets(), []);
});
