import assert from "node:assert/strict";
import { test } from "vitest";
import {
  parseTailscaleJson,
  reachesMobileServer,
  tailscaleCommandCandidates,
} from "../../../src/main/mobile/tailscale.mts";

test("the PATH command is preferred over known Tailscale CLI entry points", () => {
  assert.deepEqual(
    tailscaleCommandCandidates("/custom/bin/tailscale"),
    [
      "/custom/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
    ],
  );
});

test("a known PATH command is not tried twice", () => {
  assert.deepEqual(tailscaleCommandCandidates("/usr/local/bin/tailscale"), [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/tailscale",
  ]);
});

test("Tailscale JSON responses are parsed", () => {
  assert.deepEqual(parseTailscaleJson('{"BackendState":"Running"}'), { BackendState: "Running" });
});

test("a plain-text Tailscale response is reported instead of a JSON parser failure", () => {
  assert.throws(
    () => parseTailscaleJson("The Tailscale CLI failed to start: Failed to load preferences.\n"),
    /The Tailscale CLI failed to start: Failed to load preferences\./,
  );
});

test("the saved tailnet name proves when Tailscale still reaches this server", async () => {
  const request = async (input: string | URL | Request) => {
    assert.equal(String(input), "https://mac.tail1234.ts.net/m/health");
    return new Response("aicodingtool-mobile-v1");
  };
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", request), true);
});

test("another service cannot satisfy the Tailscale health probe", async () => {
  const request = async () => new Response("not this app");
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", request), false);
});
