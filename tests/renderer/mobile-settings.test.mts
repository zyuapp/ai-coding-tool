import assert from "node:assert/strict";
import { test } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MobileSettings } from "../../src/renderer/components/MobileSettings.tsx";
import { emptyMobileServerState, pairingUrl, type MobileServerState } from "../../src/domain/mobile.ts";
import { settleUntil } from "../support/settle.mts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const LOOPBACK = { kind: "loopback" as const, host: "127.0.0.1", port: 7737 };
const TAILNET = { kind: "tailscale-https" as const, host: "mac.tail1234.ts.net", port: 443 };

type Calls = { enabled: boolean[]; lan: boolean[]; serve: boolean[]; revoked: string[]; codes: number; refreshes: number };

function draw(remote: MobileServerState) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const calls: Calls = { enabled: [], lan: [], serve: [], revoked: [], codes: 0, refreshes: 0 };
  act(() => void createRoot(host).render(React.createElement(MobileSettings, {
    remote,
    onSetEnabled: (value: boolean) => calls.enabled.push(value),
    onSetLanExposed: (value: boolean) => calls.lan.push(value),
    onCreatePairingCode: () => { calls.codes += 1; },
    onRevokeDevice: (id: string) => calls.revoked.push(id),
    onSetTailscaleServe: (value: boolean) => calls.serve.push(value),
    onRefreshTailscale: () => { calls.refreshes += 1; },
  })));
  return calls;
}

function click(selector: string, index = 0) {
  const node = document.querySelectorAll(selector)[index];
  assert.ok(node, `no ${selector} at ${index}`);
  act(() => void node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}



test("a bridge that is off says so and offers nothing to pair with", () => {
  const calls = draw(emptyMobileServerState());
  const text = document.body.textContent ?? "";
  assert.match(text, /Off/);
  assert.match(text, /Turn phone access on to pair a phone/);
  assert.match(text, /No phone has paired/);
  assert.equal(document.querySelector<HTMLButtonElement>("[aria-labelledby='phone-pairing-heading'] button")?.disabled, true);

  click("[aria-labelledby='phone-availability-heading'] [role='switch']");
  assert.deepEqual(calls.enabled, [true]);
});

test("a listening bridge draws every address, and the QR of the code on screen", async () => {
  const at = Date.now();
  const remote: MobileServerState = {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [TAILNET, LOOPBACK],
    primary: TAILNET,
    tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: true, certs: true, error: null },
    pairing: { code: "K7M2P9QX", expiresAt: at + 90_000, address: TAILNET, url: pairingUrl(TAILNET, "K7M2P9QX") },
  };
  const calls = draw(remote);
  await settleUntil(() => document.querySelector("img.phone-qr") !== null, "no QR was ever drawn");

  const text = document.body.textContent ?? "";
  assert.match(text, /Listening/);
  assert.match(text, /https:\/\/mac\.tail1234\.ts\.net/);
  assert.match(text, /http:\/\/127\.0\.0\.1:7737/);
  assert.match(text, /K7M2P9QX/);
  assert.match(text, /Expires in 1:3\d/);

  const qr = document.querySelector<HTMLImageElement>("img.phone-qr");
  assert.ok(qr, "no QR was drawn");
  assert.match(qr.src, /^data:image\/png;base64,/);
  assert.equal(qr.alt, "QR code for https://mac.tail1234.ts.net/m/#pair=K7M2P9QX");
  assert.equal(qr.alt.includes("?"), false, "the code rides the fragment, where no proxy sees it");

  click("[data-route='tailscale'] [role='switch']");
  assert.deepEqual(calls.serve, [false], "the switch offers the opposite of what is happening");
  click("[data-route='lan'] [role='switch']");
  assert.deepEqual(calls.lan, [true]);
});

test("paired phones are listed with a way to cut each one off", () => {
  const remote: MobileServerState = {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    devices: [
      { id: "device-1", name: "iPhone", pairedAt: 1, lastSeenAt: Date.now() },
      { id: "device-2", name: "iPad", pairedAt: 1, lastSeenAt: null },
    ],
    sessions: [{ id: "s1", startedAt: 1, lastSeenAt: 2, sequence: 9, connection: "live", deviceName: "iPhone" }],
  };
  const calls = draw(remote);
  const text = document.body.textContent ?? "";
  assert.match(text, /2 paired/);
  assert.match(text, /Never connected/);
  assert.match(text, /1 connected/);
  assert.match(text, /Live\./);

  click("[aria-labelledby='phone-devices-heading'] button.danger", 1);
  assert.deepEqual(calls.revoked, ["device-2"]);
});

test("a machine without Tailscale says so and cannot be switched on", () => {
  const remote: MobileServerState = {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    tailscale: { status: "missing", magicDnsName: null, serving: false, certs: false, error: null },
  };
  const calls = draw(remote);
  assert.match(document.body.textContent ?? "", /Not installed\. Install Tailscale/);
  const toggle = document.querySelector<HTMLButtonElement>("[data-route='tailscale'] [role='switch']");
  assert.equal(toggle?.disabled, true);

  click("[data-route='tailscale'] .setting-row-action button");
  assert.equal(calls.refreshes, 1);
});

test("a bridge that failed to start says why", () => {
  draw({ ...emptyMobileServerState(), enabled: true, status: "error", error: "listen EADDRINUSE: address already in use 127.0.0.1:7737" });
  assert.match(document.body.textContent ?? "", /Failed to start/);
  assert.match(document.querySelector("[role='alert']")?.textContent ?? "", /EADDRINUSE/);
});

test("a tailnet that issues no certificate says where to turn it on, and cannot be switched on", () => {
  const remote: MobileServerState = {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: false, certs: false, error: null },
  };
  draw(remote);
  assert.match(document.body.textContent ?? "", /issues no HTTPS certificate/);
  assert.match(document.body.textContent ?? "", /admin console, under DNS/);
  const toggle = document.querySelector<HTMLButtonElement>("[data-route='tailscale'] [role='switch']");
  assert.equal(toggle?.disabled, true, "the switch offered to turn on something that hangs");
});

test("each way in is told in one place, and neither is offered before the bridge is on", () => {
  const off: MobileServerState = { ...emptyMobileServerState(), enabled: false, status: "off" };
  draw(off);
  assert.equal(document.querySelector("[data-route='tailscale']"), null, "a route was offered with the bridge off");
  assert.equal(document.querySelector("[data-route='lan']"), null);
  assert.match(document.body.textContent ?? "", /Turn phone access on to choose a way in/);

  const on: MobileServerState = {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: false, certs: true, error: null },
  };
  draw(on);

  const tailnet = document.querySelector("[data-route='tailscale']");
  const lan = document.querySelector("[data-route='lan']");
  assert.ok(tailnet && lan, "both ways in should be drawn once the bridge is on");
  /** Each block carries its own switch, its own state and its own cost, so neither is read halfway. */
  for (const route of [tailnet, lan]) {
    assert.ok(route.querySelector("[role='switch']"), "a way in was drawn without its own switch");
    assert.ok(route.querySelector(".phone-route-note")?.textContent?.trim(), "a way in was drawn without saying what it costs");
  }
  assert.match(lan.textContent ?? "", /plain HTTP/, "the plain link should say what it leaks");
  assert.match(tailnet.textContent ?? "", /mobile data/, "Tailscale should say it works away from home");

  assert.equal(document.querySelector("[data-route='tailscale'] .phone-route-address"), null, "an address was shown for a way in that is off");
  assert.match(document.body.textContent ?? "", /No way in is on/);
  assert.match(document.body.textContent ?? "", /only this Mac can open/);
});
