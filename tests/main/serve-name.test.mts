import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createComputerLinks, storedComputerName } from "../../src/main/computers/computer-links.mts";

/** A served host goes by the name the app kept, the same way the window does, and by the machine's until one is kept. */
test("a served host reads the name chosen in the app from the links file, and falls back to the machine's own", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-serve-name-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "computers.v1.json");
  assert.equal(storedComputerName(file, "zhuo-mac"), "zhuo-mac", "no file yet");

  const links = createComputerLinks({ file, deviceName: "zhuo-mac", onChanged: () => {}, onState: () => {}, onNotice: () => {} });
  links.rename("Studio");
  assert.equal(storedComputerName(file, "zhuo-mac"), "Studio");
  links.rename("");
  assert.equal(storedComputerName(file, "zhuo-mac"), "zhuo-mac", "a cleared name is the machine's again");

  await writeFile(file, "not json");
  assert.equal(storedComputerName(file, "zhuo-mac"), "zhuo-mac", "an unreadable file is no name");
  await writeFile(file, JSON.stringify({ version: 1, name: "", computers: [] }));
  assert.equal(storedComputerName(file, "zhuo-mac"), "zhuo-mac", "an empty name is no name");
});
