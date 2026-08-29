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

type Calls = { enabled: boolean[]; revoked: string[]; codes: number; refreshes: number };

function draw(remote: MobileServerState) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const calls: Calls = { enabled: [], revoked: [], codes: 0, refreshes: 0 };
  act(() => void createRoot(host).render(React.createElement(MobileSettings, {
    remote,
    remoteChecking: false,
    onSetEnabled: (value: boolean) => calls.enabled.push(value),
    onCreatePairingCode: () => { calls.codes += 1; },
    onRevokeDevice: (id: string) => calls.revoked.push(id),
    onRefreshTailscale: () => { calls.refreshes += 1; },
  })));
  return calls;
}

function click(selector: string, index = 0) {
  const node = document.querySelectorAll(selector)[index];
  assert.ok(node, `no ${selector} at ${index}`);
  act(() => void node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
}

/** A bridge that is on and served over the tailnet, which is the only state a phone can reach. */
function served(overrides: Partial<MobileServerState> = {}): MobileServerState {
  return {
    ...emptyMobileServerState(),
    enabled: true,
    status: "listening",
    port: 7737,
    addresses: [TAILNET, LOOPBACK],
    primary: TAILNET,
    tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: true, certs: true, error: null },
    ...overrides,
  };
}

function text() {
  return document.body.textContent ?? "";
}

test("a bridge that is off says so and offers nothing to pair with", () => {
  const calls = draw(emptyMobileServerState());
  assert.match(text(), /Off/);
  assert.match(text(), /Turn phone access on and finish the Tailscale steps/);
  assert.match(text(), /No phone has paired/);
  assert.equal(document.querySelector<HTMLButtonElement>("[aria-labelledby='phone-pairing-heading'] button")?.disabled, true);
  assert.equal(calls.codes, 0, "a code was asked for with nothing to reach it by");

  click("[aria-labelledby='phone-availability-heading'] [role='switch']");
  assert.deepEqual(calls.enabled, [true]);
});

test("a served bridge draws the QR of the code on screen, and the address it is served at", async () => {
  const at = Date.now();
  const calls = draw(served({ pairing: { code: "K7M2P9QX", expiresAt: at + 90_000, address: TAILNET, url: pairingUrl(TAILNET, "K7M2P9QX") } }));
  await settleUntil(() => document.querySelector("img.phone-qr") !== null, "no QR was ever drawn");

  assert.match(text(), /On/);
  assert.match(text(), /https:\/\/mac\.tail1234\.ts\.net/);
  assert.match(text(), /K7M2P9QX/);
  assert.match(text(), /Expires in 1:3\d/);
  assert.equal(calls.codes, 0, "a code was asked for while one was still live");

  const qr = document.querySelector<HTMLImageElement>("img.phone-qr");
  assert.ok(qr, "no QR was drawn");
  assert.match(qr.src, /^data:image\/png;base64,/);
  assert.equal(qr.alt, "QR code for https://mac.tail1234.ts.net/m/#pair=K7M2P9QX");
  assert.equal(qr.alt.includes("?"), false, "the code rides the fragment, where no proxy sees it");

  click("[aria-labelledby='phone-pairing-heading'] button");
  assert.equal(calls.codes, 1);
});

test("a code is asked for the moment a phone could scan one, and again once it runs out", () => {
  const calls = draw(served());
  assert.equal(calls.codes, 1, "the page should mint a code rather than wait to be asked");
  assert.match(text(), /Making a code/);

  const expired = served({ pairing: { code: "OLDCODE1", expiresAt: Date.now() - 1, address: TAILNET, url: pairingUrl(TAILNET, "OLDCODE1") } });
  const again = draw(expired);
  assert.equal(again.codes, 1, "an expired code should be replaced without a press");
  assert.match(text(), /This code has expired/);
});

test("paired phones are listed once each, with what they are doing and a way to cut each one off", () => {
  const calls = draw(served({
    devices: [
      { id: "device-1", name: "iPhone", pairedAt: 1, lastSeenAt: Date.now() },
      { id: "device-2", name: "iPad", pairedAt: 1, lastSeenAt: null },
    ],
    sessions: [
      { id: "s1", deviceId: "device-1", startedAt: 1, lastSeenAt: 2, sequence: 9, connection: "offline", deviceName: "iPhone" },
      { id: "s2", deviceId: "device-1", startedAt: 3, lastSeenAt: 4, sequence: 2, connection: "live", deviceName: "iPhone" },
    ],
  }));
  assert.match(text(), /1 of 2 connected/);
  assert.equal(document.querySelectorAll("[data-device]").length, 2, "a phone with two sessions was listed twice");
  assert.match(document.querySelector("[data-device='device-1']")?.textContent ?? "", /Connected/);
  assert.match(document.querySelector("[data-device='device-2']")?.textContent ?? "", /Never connected/);

  click("[aria-labelledby='phone-devices-heading'] button.danger", 1);
  assert.deepEqual(calls.revoked, ["device-2"]);
});

test("a machine without Tailscale is told to install it, and nothing to scan is drawn", () => {
  const calls = draw(served({
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    tailscale: { status: "missing", magicDnsName: null, serving: false, certs: false, error: null },
  }));
  assert.match(text(), /Waiting for Tailscale/);
  assert.match(document.querySelector("[data-step='installed']")?.textContent ?? "", /Install Tailscale/);
  assert.equal(document.querySelector("[data-step='installed']")?.classList.contains("needed"), true);
  assert.equal(document.querySelector("[data-step='signed-in']")?.classList.contains("needed"), false, "only the next step is asked for");
  assert.equal(document.querySelector(".phone-pairing"), null, "a QR was drawn that no phone could use");
  assert.equal(calls.codes, 0);

  click("[aria-labelledby='phone-tailscale-heading'] button");
  assert.equal(calls.refreshes, 1);
});

test("a tailnet that issues no certificate says where to turn it on", () => {
  draw(served({
    addresses: [LOOPBACK],
    primary: LOOPBACK,
    tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: false, certs: false, error: null },
  }));
  const step = document.querySelector("[data-step='https']");
  assert.match(step?.textContent ?? "", /admin console, under DNS/);
  assert.equal(step?.classList.contains("needed"), true);
  assert.match(document.querySelector("[data-step='signed-in']")?.textContent ?? "", /Signed in as mac\.tail1234\.ts\.net/);
});

test("a bridge that failed to start says why", () => {
  draw({ ...emptyMobileServerState(), enabled: true, status: "error", error: "listen EADDRINUSE: address already in use 127.0.0.1:7737" });
  assert.match(text(), /Failed to start/);
  assert.match(document.querySelector("[role='alert']")?.textContent ?? "", /EADDRINUSE/);
});

test("the Tailscale checklist is drawn with the bridge off, so the user knows what it takes before turning it on", () => {
  draw({ ...emptyMobileServerState(), tailscale: { status: "ready", magicDnsName: TAILNET.host, serving: false, certs: true, error: null } });
  assert.equal(document.querySelectorAll("[data-step]").length, 4);
  assert.match(document.querySelector("[data-step='serving']")?.textContent ?? "", /Turns on with phone access/);
  assert.equal(document.querySelector(".phone-check.needed"), null, "nothing is asked of the user while access is off");
});
