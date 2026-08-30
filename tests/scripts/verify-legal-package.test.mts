import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

// @ts-expect-error Electron Builder loads this plain-JavaScript hook directly.
const { default: afterPack, verifyLegalPackage } = await import("../../scripts/verify-legal-package.mjs");

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function packageFixture() {
  const resources = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-legal-package-"));
  roots.push(resources);
  await cp(path.resolve("assets/legal"), path.join(resources, "legal"), { recursive: true });
  const driver = path.join(resources, "cua-driver");
  await writeFile(driver, "driver");
  await chmod(driver, 0o755);
  const packages = [
    ["@trycua/cua-driver", "0.22.2", "MIT"],
    ["@trycua/cua-driver-darwin-arm64", "0.22.2", "MIT AND MPL-2.0"],
    ["@ubjs/core", "0.31.0-3", "MPL-2.0"],
    ["@ubjs/node", "0.31.0-3", "MPL-2.0"],
  ];
  for (const [name, version, license] of packages) {
    const folder = path.join(resources, "cua-sdk", "node_modules", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version, license }));
  }
  return resources;
}

test("the package hook accepts the pinned legal bundle and ignores future non-mac targets", async () => {
  const resources = await packageFixture();
  await verifyLegalPackage(resources);
  await afterPack({ electronPlatformName: "linux" });
});

test("the package hook rejects truncated licenses, version drift, and unexpected native packages", async () => {
  const resources = await packageFixture();
  const legal = path.join(resources, "legal");
  await writeFile(path.join(legal, "MPL-2.0.txt"), "");
  await assert.rejects(verifyLegalPackage(resources), /Legal file is empty/);

  await cp(path.resolve("assets/legal/MPL-2.0.txt"), path.join(legal, "MPL-2.0.txt"));
  const manifest = path.join(resources, "cua-sdk/node_modules/@trycua/cua-driver/package.json");
  await writeFile(manifest, JSON.stringify({ name: "@trycua/cua-driver", version: "0.23.0", license: "MIT" }));
  await assert.rejects(verifyLegalPackage(resources), /notices cover 0\.22\.2/);

  await writeFile(manifest, JSON.stringify({ name: "@trycua/cua-driver", version: "0.22.2", license: "MIT" }));
  await mkdir(path.join(resources, "cua-sdk/node_modules/@ubjs/node-darwin-arm64"));
  await assert.rejects(verifyLegalPackage(resources), /expected core, node/);
});
