import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { CUA_DRIVER_VERSION, UBJS_VERSION } from "./cua-driver-version.mjs";

const legalFiles = [
  "AI-CODING-TOOL-MIT.txt",
  "CUA-MIT.txt",
  "CUA-RUST-DEPENDENCIES.html",
  "INTER-OFL-1.1.txt",
  "LIBFFI-MIT.txt",
  "MPL-2.0.txt",
  "THIRD-PARTY-NOTICES.txt",
  "UBJS-NATIVE-DEPENDENCIES.html",
];

const legalNeedles = {
  "AI-CODING-TOOL-MIT.txt": ["Copyright (c) 2026 zyuapp", "Permission is hereby granted"],
  "CUA-MIT.txt": ["Copyright (c) 2025 Cua AI, Inc.", "Permission is hereby granted"],
  "INTER-OFL-1.1.txt": ["Copyright 2020 The Inter Project Authors", "SIL OPEN FONT LICENSE Version 1.1"],
  "LIBFFI-MIT.txt": ["Copyright (c) 1996-2025", "Permission is hereby granted"],
  "MPL-2.0.txt": ["Mozilla Public License Version 2.0", "3.3. Distribution of a Larger Work", "Exhibit B - \"Incompatible With Secondary Licenses\" Notice"],
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
    "0.31.0-3",
    "d114f35fec05ecd37bf529e5587be86852205b64",
    "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449",
    "309762f55db3f0548194a9ceba3027fa64b18a93",
    "libffi 3.5.2",
    "removes the x86_64 architecture slice",
    "Node runtime",
  ]);
  await requireText(path.join(legalPath, "CUA-RUST-DEPENDENCIES.html"), ["CUA Driver 0.22.2 for macOS arm64", "uniffi 0.31.0"]);
  await requireText(path.join(legalPath, "UBJS-NATIVE-DEPENDENCIES.html"), ["UniFFI JavaScript runtime 0.31.0-3", "libffi-sys 4.1.0"]);

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
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await verifyLegalPackage(path.join(appPath, "Contents", "Resources"));
}
