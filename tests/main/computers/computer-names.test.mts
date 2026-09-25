import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { emptyWorkspaceState } from "../../../src/application/workspace-state.ts";
import type { ComputerLink } from "../../../src/domain/computers.ts";
import { MobileServer, WORKSPACE_SOCKET_PATH } from "../../../src/main/mobile/mobile-server.mts";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { createComputerClient } from "../../../src/main/computers/computer-client.mts";
import { createComputerLinks } from "../../../src/main/computers/computer-links.mts";

async function until<T>(check: () => T | null | false | undefined, message: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** A host with a name of its own to give the computers that dial it. */
async function host(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-names-"));
  await writeFile(path.join(folder, "index.html"), "<!doctype html><title>phone</title>");
  const devices = new PairingStore(path.join(folder, "mobile-devices.v1.json"));
  let name = "linux-box";
  const server = new MobileServer({
    devices,
    staticRoot: folder,
    port: 0,
    allowedOrigins: () => [],
    snapshot: async () => { throw new Error("no phones here"); },
    command: async () => {},
    query: async () => null,
    onChange: () => {},
    workspace: {
      name: () => name,
      snapshot: () => ({ revision: 0, state: emptyWorkspaceState() }),
      subscribe: () => () => {},
      input: async () => ({ ok: true, revision: 0 }),
      query: async () => null,
    },
  });
  await server.start("127.0.0.1");
  t.onTestFinished(async () => {
    await server.stop();
    await rm(folder, { recursive: true, force: true });
  });
  return {
    url: `ws://127.0.0.1:${server.port}${WORKSPACE_SOCKET_PATH}`,
    mint: () => devices.mint(Date.now()).code,
    rename: (next: string) => {
      name = next;
      server.announceName();
    },
  };
}

async function links(t: { onTestFinished(callback: () => void | Promise<void>): void }, url: string, folder: string, onChanged: (links: ComputerLink[]) => void = () => {}) {
  const held = createComputerLinks({
    file: path.join(folder, "computers.v1.json"),
    deviceName: "zhuo-mac",
    onChanged,
    onState: () => {},
    onNotice: () => {},
    connect: (options) => createComputerClient({ ...options, url }),
  });
  t.onTestFinished(() => held.stop());
  held.start();
  return held;
}

const stored = async (folder: string) => JSON.parse(await readFile(path.join(folder, "computers.v1.json"), "utf8")) as { name?: string; computers: Array<{ name: string; label?: string }> };

test("this computer's name starts as the machine's, and a chosen one is kept on disk until it is cleared", async (t) => {
  const served = await host(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-names-links-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const changes: number[] = [];
  const first = await links(t, served.url, folder, (held) => changes.push(held.length));
  assert.equal(first.name(), "zhuo-mac");
  first.rename("  Studio  ");
  assert.equal(first.name(), "Studio");
  assert.equal((await stored(folder)).name, "Studio");
  assert.equal(changes.length, 2, "a new name is announced like any other change");
  first.rename("Studio");
  assert.equal(changes.length, 2, "the same name again is not");
  first.stop();

  const again = await links(t, served.url, folder);
  assert.equal(again.name(), "Studio", "the name outlives the process");
  again.rename("");
  assert.equal(again.name(), "zhuo-mac");
  assert.equal((await stored(folder)).name, undefined);
});

test("a paired computer's own name arrives as the line opens and follows its renames, unless the user here labelled it", async (t) => {
  const served = await host(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-names-links-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const names: string[] = [];
  const held = await links(t, served.url, folder, (links) => names.push(links.map((link) => link.name).join()));
  await held.pair("127.0.0.1", "127.0.0.1", served.mint());
  await until(() => held.links()[0]?.name === "linux-box", "the computer's own name replacing the address it was paired by");
  assert.equal((await stored(folder)).computers[0]?.name, "linux-box");
  const id = held.links()[0]!.id;

  served.rename("Build box");
  await until(() => held.links()[0]?.name === "Build box", "the rename crossing the live line");
  assert.equal((await stored(folder)).computers[0]?.name, "Build box");

  held.label(id, " The Linux one ");
  assert.equal(held.links()[0]?.name, "The Linux one");
  assert.equal(names.at(-1), "The Linux one");
  const labelled = (await stored(folder)).computers[0];
  assert.equal(labelled?.name, "Build box");
  assert.equal(labelled?.label, "The Linux one");
  served.rename("Renamed there");
  const underneath = () => (JSON.parse(readFileSync(path.join(folder, "computers.v1.json"), "utf8")) as { computers: Array<{ name: string }> }).computers[0]?.name;
  await until(() => underneath() === "Renamed there", "what that computer calls itself kept underneath");
  assert.equal(held.links()[0]?.name, "The Linux one", "the label stands over the rename");
  assert.equal(names.at(-1), "The Linux one", "and nothing on screen moved");

  held.label(id, "");
  assert.equal(held.links()[0]?.name, "Renamed there", "clearing the label goes back to what that computer calls itself");
  assert.equal((await stored(folder)).computers[0]?.label, undefined);
  held.label(id, "Renamed there");
  assert.equal((await stored(folder)).computers[0]?.label, undefined, "a label that is the computer's own name is no label");
});
