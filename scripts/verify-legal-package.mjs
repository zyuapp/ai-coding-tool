import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { extractFile, listPackage } from "@electron/asar";
import {
  ANTHROPIC_AGENT_SDK_VERSION,
  CUA_DRIVER_VERSION,
  CUA_RELEASE,
  ELECTRON_VERSION,
  lockedPackageVersion,
  UBJS_VERSION,
} from "./cua-driver-version.mjs";
import { runtimeLicenseEntries } from "./generate-legal-notices.mjs";

const legalFiles = [
  "AI-CODING-TOOL-MIT.txt",
  "CUA-MIT.txt",
  "CUA-RUST-DEPENDENCIES.html",
  "ELECTRON-MIT.txt",
  "ELECTRON-THIRD-PARTY-NOTICES.html",
  "INTER-OFL-1.1.txt",
  "LIBFFI-MIT.txt",
  "MANTLE-LICENSE.md",
  "MPL-2.0.txt",
  "MOBILE-THIRD-PARTY-LICENSES.md",
  "NPM-RUNTIME-LICENSES.txt",
  "REACTIVEOBJC-MIT.md",
  "RENDERER-THIRD-PARTY-LICENSES.md",
  "THIRD-PARTY-NOTICES.txt",
  "UBJS-NATIVE-DEPENDENCIES.html",
];

const legalNeedles = {
  "AI-CODING-TOOL-MIT.txt": ["Copyright (c) 2026 zyuapp", "Permission is hereby granted"],
  "CUA-MIT.txt": ["Copyright (c) 2025 Cua AI, Inc.", "Permission is hereby granted"],
  "INTER-OFL-1.1.txt": ["Copyright 2020 The Inter Project Authors", "SIL OPEN FONT LICENSE Version 1.1"],
  "LIBFFI-MIT.txt": ["Copyright (c) 1996-2025", "Permission is hereby granted"],
  "MANTLE-LICENSE.md": ["Copyright (c) 2012 - 2013, GitHub, Inc.", "Proton is copyright (c) 2012, Bitswift, Inc."],
  "MPL-2.0.txt": ["Mozilla Public License Version 2.0", "3.3. Distribution of a Larger Work", "Exhibit B - \"Incompatible With Secondary Licenses\" Notice"],
  "REACTIVEOBJC-MIT.md": ["Copyright (c) 2012 - 2016, GitHub, Inc.", "Permission is hereby granted"],
};

const shippedPackages = [
  ["@trycua/cua-driver", CUA_DRIVER_VERSION, "MIT"],
  ["@trycua/cua-driver-darwin-arm64", CUA_DRIVER_VERSION, "MIT AND MPL-2.0"],
  ["@ubjs/core", UBJS_VERSION, "MPL-2.0"],
  ["@ubjs/node", UBJS_VERSION, "MPL-2.0"],
];

async function requireText(file, needles) {
  const value = await readFile(file, "utf8");
  if (!value.trim()) throw new Error(`Legal file is empty: ${file}`);
  for (const needle of needles) {
    if (!value.includes(needle)) throw new Error(`Legal file ${file} does not mention ${needle}.`);
  }
}

export async function verifyLegalPackage(resourcesPath) {
  const legalPath = path.join(resourcesPath, "legal");
  for (const file of legalFiles) {
    const asset = path.join(legalPath, file);
    await access(asset, constants.R_OK);
    if (!(await stat(asset)).isFile()) throw new Error(`Legal asset is not a file: ${asset}`);
  }
  for (const [file, needles] of Object.entries(legalNeedles)) await requireText(path.join(legalPath, file), needles);

  await requireText(path.join(legalPath, "THIRD-PARTY-NOTICES.txt"), [
    `Version: ${CUA_DRIVER_VERSION}`,
    CUA_RELEASE.sourceCommit,
    CUA_RELEASE.ubjsCommit,
    CUA_RELEASE.uniffiCommit,
    `libffi ${CUA_RELEASE.libffiVersion}`,
    `Electron ${ELECTRON_VERSION}`,
    `@anthropic-ai/claude-agent-sdk@${ANTHROPIC_AGENT_SDK_VERSION}`,
    "proprietary software",
    "https://code.claude.com/docs/en/legal-and-compliance",
    "https://www.anthropic.com/legal/commercial-terms",
    "does not redistribute the Claude Code executable",
    "user's CLI use is authenticated",
    "Names and trademarks",
    "removes the x86_64 architecture slice",
    "Node runtime",
  ]);
  await requireText(path.join(legalPath, "CUA-RUST-DEPENDENCIES.html"), [
    `CUA Driver ${CUA_DRIVER_VERSION} for macOS arm64`,
    `uniffi ${CUA_RELEASE.uniffiVersion}`,
  ]);
  await requireText(path.join(legalPath, "UBJS-NATIVE-DEPENDENCIES.html"), [
    `UniFFI JavaScript runtime ${UBJS_VERSION}`,
    `libffi-sys ${CUA_RELEASE.libffiSysVersion}`,
  ]);

  const npmLicense = path.join(legalPath, "NPM-RUNTIME-LICENSES.txt");
  const npmLicenseText = await readFile(npmLicense, "utf8");
  const runtimePackages = new Set();
  for (const entry of await runtimeLicenseEntries()) {
    const id = `${entry.name}@${entry.version}`;
    runtimePackages.add(id);
    if (!npmLicenseText.includes(`\n${id}\n`)) throw new Error(`Runtime license bundle does not mention ${id}.`);
  }
  const licenseHeading = (name) => `## ${name} - ${lockedPackageVersion(name)} (`;
  await requireText(path.join(legalPath, "RENDERER-THIRD-PARTY-LICENSES.md"),
    ["@hello-pangea/dnd", "@xterm/xterm", "mermaid", "react", "shiki"].map(licenseHeading));
  await requireText(path.join(legalPath, "MOBILE-THIRD-PARTY-LICENSES.md"),
    ["react-markdown", "react", "remark-gfm"].map(licenseHeading));
  for (const [packaged, source] of [
    ["ELECTRON-MIT.txt", "LICENSE"],
    ["ELECTRON-THIRD-PARTY-NOTICES.html", "LICENSES.chromium.html"],
  ]) {
    const expected = await readFile(path.resolve("node_modules/electron/dist", source));
    const actual = await readFile(path.join(legalPath, packaged));
    if (!actual.equals(expected)) throw new Error(`${packaged} does not match Electron ${ELECTRON_VERSION}.`);
  }

  const executable = path.join(resourcesPath, "cua-driver");
  await access(executable, constants.R_OK | constants.X_OK);
  if (!(await stat(executable)).isFile()) throw new Error(`Bundled CUA driver is not a file: ${executable}`);

  const modulesPath = path.join(resourcesPath, "cua-sdk", "node_modules");
  for (const [name, version, license] of shippedPackages) {
    const manifest = JSON.parse(await readFile(path.join(modulesPath, name, "package.json"), "utf8"));
    if (manifest.version !== version) throw new Error(`${name} is ${manifest.version}; notices cover ${version}.`);
    if (manifest.license !== license) throw new Error(`${name} has license ${manifest.license}; expected ${license}.`);
  }

  for (const [scope, expected] of [["@trycua", ["cua-driver", "cua-driver-darwin-arm64"]], ["@ubjs", ["core", "node"]]]) {
    const actual = (await readdir(path.join(modulesPath, scope), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (actual.join("\n") !== expected.join("\n")) {
      throw new Error(`${scope} package set is ${actual.join(", ")}; expected ${expected.join(", ")}.`);
    }
  }

  const archive = path.join(resourcesPath, "app.asar");
  await access(archive, constants.R_OK);
  const archivedFiles = listPackage(archive, { isPack: false });
  const includes = (fragment) => archivedFiles.some((file) => file.includes(fragment));
  const anthropicManifestPath = "node_modules/@anthropic-ai/claude-agent-sdk/package.json";
  if (!includes(anthropicManifestPath)) {
    throw new Error("The packaged Anthropic SDK is missing from app.asar.");
  }
  const anthropicManifest = JSON.parse(extractFile(archive, anthropicManifestPath).toString());
  if (anthropicManifest.version !== ANTHROPIC_AGENT_SDK_VERSION) {
    throw new Error(`Packaged Anthropic SDK is ${anthropicManifest.version}; notices cover ${ANTHROPIC_AGENT_SDK_VERSION}.`);
  }
  if (anthropicManifest.license !== "SEE LICENSE IN README.md" || !includes("node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md")) {
    throw new Error("The packaged Anthropic SDK license metadata or license file is missing.");
  }
  for (const forbidden of [
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "node_modules/@openai/codex",
    "node_modules/fast-uri/benchmark/",
    "dist/renderer/legal/",
    "dist/mobile/legal/",
  ]) {
    if (includes(forbidden)) throw new Error(`app.asar unexpectedly contains ${forbidden}.`);
  }
  const mobileHtml = extractFile(archive, "dist/mobile/index.html").toString();
  if (!mobileHtml.includes('id="third-party-licenses"') || !mobileHtml.includes("## react-markdown - ")) {
    throw new Error("The phone page does not carry its third-party license notices.");
  }
  for (const file of archivedFiles.filter((file) => file.endsWith("/package.json") && file.includes("node_modules/"))) {
    const manifest = JSON.parse(extractFile(archive, file.replace(/^\//, "")).toString());
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
    const afterNodeModules = file.slice(file.lastIndexOf("node_modules/") + "node_modules/".length);
    if (afterNodeModules !== `${manifest.name}/package.json`) continue;
    const id = `${manifest.name}@${manifest.version}`;
    if (!runtimePackages.has(id)) throw new Error(`Packaged npm dependency ${id} has no runtime license entry.`);
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await verifyLegalPackage(path.join(appPath, "Contents", "Resources"));
}
