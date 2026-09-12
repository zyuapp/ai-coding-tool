import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import react from "@vitejs/plugin-react";
import WebSocket from "ws";
import { mobileDevelopment } from "../../../scripts/mobile-development.mts";
import { developmentSocket, requestDevelopmentPairing } from "../../../src/main/mobile/development.mts";
import * as host from "../../../src/main/mobile/mobile-host.mts";
import { MOBILE_PROTOCOL_VERSION, type MobileClientMessage, type MobileRequest, type MobileServerMessage, type MobileView } from "../../../src/contracts/mobile.ts";
import { isolatedViteServer } from "../../support/vite-server.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

async function until<T>(check: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The mobile preview did not receive the expected desktop response.");
}

function phone(origin: string) {
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/m/socket`, { origin });
  const messages: MobileServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  return {
    socket,
    messages,
    opened: once(socket, "open"),
    send: (message: MobileClientMessage) => socket.send(JSON.stringify(message)),
    waitFor: <K extends MobileServerMessage["kind"]>(kind: K) => until(() => messages.find((message): message is Extract<MobileServerMessage, { kind: K }> => message.kind === kind)),
  };
}

test("the development preview automatically pairs through the desktop bridge and streams real protocol updates", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "mobile-dev-test-"));
  await copyFile(path.join(ROOT, "index.mobile.html"), path.join(folder, "index.mobile.html"));
  const { vite, close } = await isolatedViteServer({
    root: ROOT,
    configFile: false,
    plugins: [react(), mobileDevelopment(folder)],
    server: { port: 0 },
    logLevel: "silent",
  });
  const sockets: WebSocket[] = [];
  t.onTestFinished(async () => {
    sockets.forEach((socket) => socket.terminate());
    await close();
    await host.stopMobileHost();
    await rm(path.dirname(await developmentSocket(folder)), { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const waiting = await fetch(`${origin}/m/`);
  assert.equal(waiting.status, 503);
  assert.match(await waiting.text(), /Waiting for desktop app/);

  const requests: MobileRequest[] = [];
  const view: MobileView = { groups: [{ projectId: null, name: "Desktop threads", threads: [] }], activity: { priority: [], running: [], threads: [] }, theme: { dark: "aicodingtool-dark", light: "aicodingtool-light", mode: "dark" }, thread: null, draft: null, error: null };
  let tailscaleCalls = 0;
  const options = {
    userData: folder,
    staticRoot: folder,
    developmentRoot: folder,
    send(request: MobileRequest) {
      requests.push(request);
      queueMicrotask(() => host.answerMobileRequest({ type: "mobile.response", requestId: request.requestId, ok: true, result: view }));
      return true;
    },
    onState() {},
    tailscale: {
      async read() { tailscaleCalls++; return { status: "missing" as const, magicDnsName: null, certs: false, serving: false, error: null }; },
      async start() { tailscaleCalls++; return { ok: true as const }; },
      async stop() { tailscaleCalls++; return { ok: true as const }; },
    },
  };
  await host.startMobileHost(options);
  assert.equal((await stat(path.dirname(await developmentSocket(folder)))).mode & 0o777, 0o700);
  const page = await fetch(`${origin}/m/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const html = await page.text();
  assert.match(html, /@vite\/client/);
  assert.match(html, /@react-refresh/);
  const code = /"\/m\/#pair=" \+ "([0-9A-Z]+)"/.exec(html)?.[1];
  assert.ok(code, "the real mobile entry receives a pairing code before it mounts");

  const paired = phone(origin);
  sockets.push(paired.socket);
  await paired.opened;
  paired.send({ kind: "pair", version: MOBILE_PROTOCOL_VERSION, code, deviceName: "Development preview" });
  const credential = await paired.waitFor("paired");
  assert.deepEqual((await paired.waitFor("snapshot")).view, view);
  assert.equal(host.mobileState().sessions.length, 1, "desktop projections see the preview as a connected mobile session");
  paired.send({ kind: "command", requestId: "preview-command", command: { type: "task.select", taskId: "desktop-thread" } });
  assert.equal((await paired.waitFor("ack")).ok, true);
  assert.ok(requests.some((request) => request.op === "command" && request.command.type === "task.select"));
  host.publishMobileView({ kind: "patch", patch: { error: "A desktop update" } });
  assert.deepEqual((await paired.waitFor("patch")).patch, { error: "A desktop update" });

  const returning = phone(origin);
  sockets.push(returning.socket);
  await returning.opened;
  returning.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: credential.token, lastSequence: 0 });
  await returning.waitFor("snapshot");
  assert.equal(host.mobileState().devices.length, 1, "reloads reuse the existing mobile credential");

  assert.equal((await fetch(`${origin}/m/`, { headers: { origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await fetch(`${origin}/m/`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const foreign = new WebSocket(`${origin.replace("http:", "ws:")}/m/socket`, { origin: "https://untrusted.example" });
  sockets.push(foreign);
  await assert.rejects(once(foreign, "open"), /403/);
  assert.equal(host.mobileState().enabled, false, "local development does not change the phone-access preference");
  assert.equal(tailscaleCalls, 0, "local development never needs Tailscale");

  sockets.forEach((socket) => socket.terminate());
  await host.stopMobileHost();
  await assert.rejects(requestDevelopmentPairing(folder));
  await host.startMobileHost(options);
  const reloaded = await fetch(`${origin}/m/`);
  assert.equal(reloaded.status, 200, "the launcher finds the desktop again after it restarts");
  const resumed = phone(origin);
  sockets.push(resumed.socket);
  await resumed.opened;
  resumed.send({ kind: "resume", version: MOBILE_PROTOCOL_VERSION, token: credential.token, lastSequence: 0 });
  await resumed.waitFor("snapshot");
  const localPort = host.mobileState().port;
  await host.setMobileEnabled(true);
  await until(() => tailscaleCalls > 0);
  assert.equal(host.mobileState().port, localPort, "turning on phone access reuses the development listener");
});
