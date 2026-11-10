import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { AppUpdate } from "../../src/domain/app-update.ts";
import { createServeUpdater, type UpdateTarget } from "../../src/main/serve-updates.ts";

const RELEASES = "https://releases.test";

function release(name: string, body: Buffer, sha = createHash("sha512").update(body).digest("base64")) {
  const manifest = `version: 0.2.0\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha}\nreleaseDate: '2026-11-10T00:00:00.000Z'\n`;
  const fetched: string[] = [];
  const fake = (async (url: string | URL) => {
    fetched.push(String(url));
    if (String(url).endsWith(".yml")) return new Response(manifest);
    if (String(url) === `${RELEASES}/download/v0.2.0/${name}`) return new Response(new Uint8Array(body));
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetch: fake, fetched };
}

function updater(target: UpdateTarget, get: typeof globalThis.fetch, platform: NodeJS.Platform) {
  const states: AppUpdate[] = [];
  let restarts = 0;
  const updates = createServeUpdater({
    version: "0.1.0",
    target,
    platform,
    arch: "x64",
    releases: RELEASES,
    fetch: get,
    verifyBundle: async () => {},
    onState: (update) => states.push(update),
    restart: () => { restarts += 1; },
    say: () => {},
  });
  return { updates, states, restarts: () => restarts };
}

test("a server replaces its AppImage with the checked download, under the new version's name, then restarts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-serve-update-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, "AICodingTool-0.1.0-x86_64.AppImage");
  await writeFile(image, "old build", { mode: 0o755 });
  const body = Buffer.from("new build");
  const { fetch, fetched } = release("AICodingTool-0.2.0-x86_64.AppImage", body);
  const { updates, states, restarts } = updater({ kind: "appimage", image }, fetch, "linux");

  await updates.check();
  assert.ok(fetched[0]?.endsWith("/latest/download/latest-linux.yml"));
  assert.deepEqual(updates.state(), { status: "available", version: "0.2.0" });
  await updates.download();
  assert.ok(states.some((state) => state.status === "downloading" && state.percent === 100));
  assert.deepEqual(updates.state(), { status: "ready", version: "0.2.0" });
  await updates.install();

  assert.equal(restarts(), 1);
  assert.deepEqual(await readdir(root), ["AICodingTool-0.2.0-x86_64.AppImage"]);
  assert.equal(await readFile(path.join(root, "AICodingTool-0.2.0-x86_64.AppImage"), "utf8"), "new build");
});

test("a download that does not match its checksum is thrown away and offered again", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-serve-update-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, "AICodingTool.AppImage");
  await writeFile(image, "old build", { mode: 0o755 });
  const { fetch } = release("AICodingTool-0.2.0-x86_64.AppImage", Buffer.from("tampered"), createHash("sha512").update("new build").digest("base64"));
  const { updates, restarts } = updater({ kind: "appimage", image }, fetch, "linux");

  await updates.check();
  await updates.download();
  await updates.install();

  assert.deepEqual(updates.state(), { status: "available", version: "0.2.0" });
  assert.equal(restarts(), 0);
  assert.deepEqual(await readdir(root), ["AICodingTool.AppImage"]);
  assert.equal(await readFile(image, "utf8"), "old build");
});

test.skipIf(process.platform !== "darwin")("a macOS server swaps its bundle for the one in the downloaded archive", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-serve-update-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "Applications", "AI Coding Tool.app");
  const binary = path.join(bundle, "Contents", "MacOS", "AI Coding Tool");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "old build");
  const built = path.join(root, "build", "AI Coding Tool.app", "Contents", "MacOS", "AI Coding Tool");
  await mkdir(path.dirname(built), { recursive: true });
  await writeFile(built, "new build");
  const archive = path.join(root, "update.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", path.join(root, "build", "AI Coding Tool.app"), archive]);
  const { fetch, fetched } = release("AICodingTool-0.2.0-arm64.zip", await readFile(archive));
  const { updates, restarts } = updater({ kind: "bundle", bundle }, fetch, "darwin");

  await updates.check();
  assert.ok(fetched[0]?.endsWith("/latest-mac.yml"));
  await updates.download();
  await updates.install();

  assert.equal(restarts(), 1);
  assert.equal(await readFile(binary, "utf8"), "new build");
  assert.deepEqual(await readdir(path.dirname(bundle)), ["AI Coding Tool.app"]);
});
