import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "vitest";
import { MOBILE_INSTANCE, MOBILE_INSTANCE_HEADER } from "../../../src/main/mobile/addresses.mts";
import {
  anotherInstanceListens,
  heldByAnotherInstance,
  OPERATOR_NEEDED,
  parseTailscaleJson,
  reachesMobileServer,
  servedPorts,
  serveFailure,
  tailscaleCommandCandidates,
} from "../../../src/main/mobile/tailscale.mts";

test("the PATH command is preferred over known Tailscale CLI entry points", () => {
  assert.deepEqual(
    tailscaleCommandCandidates("/custom/bin/tailscale"),
    [
      "/custom/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
    ],
  );
});

test("a known PATH command is not tried twice", () => {
  assert.deepEqual(tailscaleCommandCandidates("/usr/local/bin/tailscale"), [
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
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
    return new Response("aicodingtool-mobile-v1", { headers: { [MOBILE_INSTANCE_HEADER]: MOBILE_INSTANCE } });
  };
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", request), true);
});

test("another copy of the app behind the same name is not this server", async () => {
  const other = async () => new Response("aicodingtool-mobile-v1", { headers: { [MOBILE_INSTANCE_HEADER]: "someone-else" } });
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", other), false);
  const older = async () => new Response("aicodingtool-mobile-v1");
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", older), false, "a copy from before the header is not this one either");
});

test("another service cannot satisfy the Tailscale health probe", async () => {
  const request = async () => new Response("not this app");
  assert.equal(await reachesMobileServer("mac.tail1234.ts.net", request), false);
});

test("only the handlers on 443 that proxy to a local port are read", () => {
  const config = {
    TCP: { "443": { HTTPS: true } },
    Web: {
      "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7737" }, "/docs": { Path: "/var/www" } } },
      "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      "other.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:51234/" } } },
    },
  };
  assert.deepEqual(servedPorts(config), [7737, 51234]);
  assert.deepEqual(servedPorts({}), []);
  assert.deepEqual(servedPorts(null), []);
});

/** A local server answering the health probe the way some copy of the app would. */
async function healthServer(t: { onTestFinished(callback: () => void | Promise<void>): void }, instance: string | null, body = "aicodingtool-mobile-v1") {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, instance === null ? {} : { [MOBILE_INSTANCE_HEADER]: instance });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

test("a port answering as another copy of the app is that copy, and anything else is not", async (t) => {
  assert.equal(await anotherInstanceListens(await healthServer(t, "someone-else")), true);
  assert.equal(await anotherInstanceListens(await healthServer(t, null)), true, "an older copy without the header still counts");
  assert.equal(await anotherInstanceListens(await healthServer(t, MOBILE_INSTANCE)), false, "this process is not another copy");
  assert.equal(await anotherInstanceListens(await healthServer(t, "someone-else", "a web app")), false, "something else entirely is not a copy");
});

test("443 held by a live copy is left alone, and a handler to a port nothing answers on is free to take", async (t) => {
  const other = await healthServer(t, "someone-else");
  const served = (port: number) => ({ Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
  assert.equal(await heldByAnotherInstance(served(other), 7737), true);
  assert.equal(await heldByAnotherInstance(served(7737), 7737), false, "our own port is ours to keep");

  const gone = createServer();
  await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", resolve));
  const address = gone.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  assert.equal(await heldByAnotherInstance(served(port), 7737), false);
});

test("Linux refusing a user who is not Tailscale's operator says what to run", () => {
  const refused = Object.assign(new Error("Command failed: tailscale serve --bg"), {
    stderr: "sending serve config: Access denied: serve config denied\n\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n",
  });
  assert.equal(serveFailure(refused), OPERATOR_NEEDED);
  assert.equal(serveFailure(Object.assign(new Error("Command failed"), { stderr: "Error: timed out\n" })), "timed out");
});
