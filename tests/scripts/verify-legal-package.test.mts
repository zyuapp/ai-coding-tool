import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, test } from "vitest";

// @ts-expect-error Electron Builder loads this plain-JavaScript hook directly.
const { default: afterPack, verifyLegalPackage } = await import("../../scripts/verify-legal-package.mjs");
// @ts-expect-error Packaging hooks share these plain-JavaScript lockfile helpers.
const { ANTHROPIC_AGENT_SDK_VERSION, lockedPackageVersion } = await import("../../scripts/cua-driver-version.mjs");

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("release packaging installs and reuses the Electron distribution that supplies its notices", async () => {
  const project = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(project.scripts["prepare:electron"], "install-electron");
  for (const script of ["start", "package:mac", "package:linux"]) {
    assert.match(project.scripts[script], /^npm run prepare:electron &&/);
  }
  assert.equal(project.build.electronDist, "node_modules/electron/dist");
});

async function writeAsar(resources: string, forbiddenPackage?: string, sdkVersion = ANTHROPIC_AGENT_SDK_VERSION) {
  const source = path.join(resources, "app-source");
  await rm(source, { recursive: true, force: true });
  const sdk = path.join(source, "node_modules/@anthropic-ai/claude-agent-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-agent-sdk",
    version: sdkVersion,
    license: "SEE LICENSE IN README.md",
  }));
  await writeFile(path.join(sdk, "LICENSE.md"), "© Anthropic PBC. All rights reserved.");
  await mkdir(path.join(source, "dist/mobile"), { recursive: true });
  await writeFile(path.join(source, "dist/mobile/index.html"), '<template id="third-party-licenses">## react-markdown - </template>');
  if (forbiddenPackage) {
    const forbidden = path.join(source, "node_modules", forbiddenPackage);
    await mkdir(forbidden, { recursive: true });
    await writeFile(path.join(forbidden, "package.json"), "{}");
  }
  const archive = path.join(resources, "app.asar");
  await rm(archive, { force: true });
  await createPackage(source, archive);
  await rm(source, { recursive: true, force: true });
}

async function packageFixture() {
  const resources = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-legal-package-"));
  roots.push(resources);
  await cp(path.resolve("assets/legal"), path.join(resources, "legal"), { recursive: true });
  await cp(path.resolve("node_modules/electron/dist/LICENSE"), path.join(resources, "legal/ELECTRON-MIT.txt"));
  await cp(path.resolve("node_modules/electron/dist/LICENSES.chromium.html"), path.join(resources, "legal/ELECTRON-THIRD-PARTY-NOTICES.html"));
  await writeFile(path.join(resources, "legal/RENDERER-THIRD-PARTY-LICENSES.md"), [
    ...["@hello-pangea/dnd", "@xterm/xterm", "mermaid", "react", "shiki"]
      .map((name) => `## ${name} - ${lockedPackageVersion(name)} (MIT)`),
  ].join("\n"));
  await writeFile(path.join(resources, "legal/MOBILE-THIRD-PARTY-LICENSES.md"), [
    ...["react-markdown", "react", "remark-gfm"]
      .map((name) => `## ${name} - ${lockedPackageVersion(name)} (MIT)`),
  ].join("\n"));
  const driver = path.join(resources, "cua-driver");
  await writeFile(driver, "driver");
  await chmod(driver, 0o755);
  const packages = [
    ["@trycua/cua-driver", "0.23.2", "MIT"],
    ["@trycua/cua-driver-darwin-arm64", "0.23.2", "MIT AND MPL-2.0"],
    ["@ubjs/core", "0.31.0-3", "MPL-2.0"],
    ["@ubjs/node", "0.31.0-3", "MPL-2.0"],
  ];
  for (const [name, version, license] of packages) {
    const folder = path.join(resources, "cua-sdk", "node_modules", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "package.json"), JSON.stringify({ name, version, license }));
  }
  await writeAsar(resources);
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
  await assert.rejects(verifyLegalPackage(resources), /notices cover 0\.23\.2/);

  await writeFile(manifest, JSON.stringify({ name: "@trycua/cua-driver", version: "0.23.2", license: "MIT" }));
  await mkdir(path.join(resources, "cua-sdk/node_modules/@ubjs/node-darwin-arm64"));
  await assert.rejects(verifyLegalPackage(resources), /expected core, node/);
});

test("the package hook rejects a bundled Anthropic executable", async () => {
  const resources = await packageFixture();
  await writeAsar(resources, "@anthropic-ai/claude-agent-sdk-darwin-arm64");
  await assert.rejects(verifyLegalPackage(resources), /app\.asar unexpectedly contains/);
});

test("the package hook rejects Anthropic SDK version drift", async () => {
  const resources = await packageFixture();
  await writeAsar(resources, undefined, "0.4.0");
  await assert.rejects(verifyLegalPackage(resources), /notices cover 0\.3\.252/);
});
