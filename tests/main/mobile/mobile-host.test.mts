import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import WebSocket from "ws";
import { allowedOrigins, reachableAddresses } from "../../../src/main/mobile/addresses.mts";
import { servesPort } from "../../../src/main/mobile/tailscale.mts";
import { MOBILE_PROTOCOL_VERSION, type MobileRequest } from "../../../src/contracts/mobile.ts";
import type { MobileServerState } from "../../../src/domain/mobile.ts";

test("the addresses are the loopback bind and the tailnet name while Tailscale serves it", () => {
  const quiet = reachableAddresses({ port: 7737, magicDnsName: null });
  assert.deepEqual(quiet, [{ kind: "loopback", host: "127.0.0.1", port: 7737 }]);
  assert.deepEqual(allowedOrigins(quiet), ["http://127.0.0.1:7737", "http://localhost:7737"]);

  const served = reachableAddresses({ port: 7737, magicDnsName: "mac.tail1234.ts.net" });
  assert.deepEqual(served, [{ kind: "tailscale-https", host: "mac.tail1234.ts.net", port: 443 }, { kind: "loopback", host: "127.0.0.1", port: 7737 }]);
  assert.ok(allowedOrigins(served).includes("https://mac.tail1234.ts.net"), "the tailnet name is served without a port");
});

test("Serve is only ours when a handler points at this very port", () => {
  const config = {
    Web: {
      "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7737" } } },
      "other.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
    },
  };
  assert.equal(servesPort(config, 7737), true);
  assert.equal(servesPort(config, 3000), true, "any host of ours counts");
  assert.equal(servesPort(config, 9999), false);
  assert.equal(servesPort({}, 7737), false, "an unused Tailscale serves nothing");
  assert.equal(servesPort(null, 7737), false);
  assert.equal(servesPort({ Web: { "x:443": { Handlers: { "/": { Path: "/var/www" } } } } }, 7737), false);
});

/**
 * A machine with no Tailscale. Answering for it rather than shelling out is what keeps these tests
 * saying the same thing on a developer's Mac that happens to be serving and on one that is not.
 */
function noTailscale() {
  return {
    read: () => Promise.resolve({ status: "missing" as const, magicDnsName: null, certs: false, serving: false, error: null }),
    start: () => Promise.resolve({ ok: false as const, message: "no Tailscale in this test" }),
    stop: () => Promise.resolve({ ok: true as const }),
  };
}

/** The host is a module singleton, so each test takes it, uses it and gives it back. */
async function bridge(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const host = await import("../../../src/main/mobile/mobile-host.mts");
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-host-"));
  const states: MobileServerState[] = [];
  const requests: MobileRequest[] = [];
  await host.startMobileHost({
    userData: folder,
    staticRoot: folder,
    tailscale: noTailscale(),
    /** Whatever the machine offers, so this never takes the port the developer's own app serves on. */
    port: 0,
    send: (request) => { requests.push(request); return true; },
    onState: (state) => { states.push(state); },
  });
  t.onTestFinished(async () => {
    await host.stopMobileHost();
    await rm(folder, { recursive: true, force: true });
  });
  return { host, folder, states, requests };
}

test("the bridge starts off, comes up on the loopback, and goes back down promptly", async (t) => {
  const { host, folder } = await bridge(t);
  assert.deepEqual(host.mobileState().enabled, false);
  assert.equal(host.mobileState().port, null);

  const on = await host.setMobileEnabled(true);
  assert.equal(on.enabled, true);
  assert.equal(on.status, "listening");
  assert.deepEqual(on.primary, { kind: "loopback", host: "127.0.0.1", port: on.port });
  assert.equal(JSON.parse(await readFile(path.join(folder, "mobile.v1.json"), "utf8")).enabled, true);

  const page = await fetch(`http://127.0.0.1:${on.port}/m/`);
  assert.equal(page.status, 404, "the built page is not in a temporary folder, but the server answered");

  const started = Date.now();
  const off = await host.setMobileEnabled(false);
  assert.ok(Date.now() - started < 3_000, `turning it off took ${Date.now() - started}ms`);
  assert.equal(off.status, "off");
  assert.equal(off.port, null);
  await assert.rejects(fetch(`http://127.0.0.1:${on.port}/m/`), "the port was let go");
});

test("a pairing code needs a listening server and carries the address in its fragment", async (t) => {
  const { host } = await bridge(t);
  await assert.rejects(host.createMobilePairingCode(), /Turn the phone bridge on/);

  const on = await host.setMobileEnabled(true);
  const offer = await host.createMobilePairingCode();
  assert.match(offer.code, /^[0-9A-Z]{8}$/);
  assert.equal(offer.url, `http://127.0.0.1:${on.port}/m/#pair=${offer.code}`);
  assert.equal(host.mobileState().pairing?.code, offer.code, "settings draws the code that was minted");

  const second = await host.createMobilePairingCode();
  assert.notEqual(second.code, offer.code, "a fresh code replaces the one on screen");

  await host.setMobileEnabled(false);
  assert.equal(host.mobileState().pairing, null, "turning the bridge off throws away the code with it");
});

test("a phone paired through the host reaches the window, and revoking it drops the line", async (t) => {
  const { host, requests } = await bridge(t);
  const on = await host.setMobileEnabled(true);
  const offer = await host.createMobilePairingCode();

  const socket = new WebSocket(`ws://127.0.0.1:${on.port}/m/socket`);
  t.onTestFinished(() => socket.close());
  const heard: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => heard.push(JSON.parse(String(data))));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
  socket.send(JSON.stringify({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: offer.code, deviceName: "iPhone" }));

  await until(() => heard.some((message) => message.kind === "paired"), "the phone never paired");
  await until(() => requests.some((request) => request.op === "snapshot"), "the window was never asked for a view");
  const devices = host.mobileState().devices;
  assert.deepEqual(devices.map((device) => device.name), ["iPhone"]);
  assert.equal("tokenHash" in devices[0]!, false, "the hash never leaves the main process");
  await until(() => host.mobileState().sessions.length === 1, "the session was never reported to settings");

  const after = await host.revokeMobileDevice(devices[0]!.id);
  assert.deepEqual(after.devices, []);
  assert.deepEqual(after.sessions, []);
});

async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
