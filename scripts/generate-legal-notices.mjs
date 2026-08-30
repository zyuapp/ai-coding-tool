import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ANTHROPIC_AGENT_SDK_VERSION,
  CUA_DRIVER_VERSION,
  CUA_RELEASE,
  ELECTRON_VERSION,
  UBJS_VERSION,
} from "./cua-driver-version.mjs";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const legalDirectory = path.join(root, "assets", "legal");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const fontPackages = [
  "@fontsource-variable/fira-code",
  "@fontsource-variable/geist",
  "@fontsource-variable/ibm-plex-sans",
  "@fontsource-variable/inter",
  "@fontsource-variable/jetbrains-mono",
  "@fontsource-variable/source-code-pro",
];
const excludedPackages = new Set([
  "@trycua/cua-driver",
  "@trycua/cua-driver-darwin-arm64",
  "@ubjs/core",
  "@ubjs/node",
  "@ubjs/node-darwin-arm64",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
]);
const pinnedSourceReportNeedles = new Map([
  ["CUA-RUST-DEPENDENCIES.html", () => [
    `CUA Driver ${CUA_DRIVER_VERSION} for macOS arm64`,
    `uniffi ${CUA_RELEASE.uniffiVersion}`,
  ]],
  ["UBJS-NATIVE-DEPENDENCIES.html", () => [
    `UniFFI JavaScript runtime ${UBJS_VERSION}`,
    `libffi-sys ${CUA_RELEASE.libffiSysVersion}`,
  ]],
]);
const sharedLicensePackages = new Map([
  // The headless package is published without a license file. It is released
  // from the same xterm.js repository and version as @xterm/xterm.
  ["@xterm/headless", "@xterm/xterm"],
]);
const packagedLicenseOmissions = new Map([
  ["lazy-val", {
    license: "MIT",
    author: "Vladimir Krivosheev",
    text: `Copyright (c) Vladimir Krivosheev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  }],
]);

function normalized(text) {
  return `${text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim()}\n`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolvePackage(name, from) {
  let directory = from;
  while (directory.startsWith(root)) {
    const candidate = path.join(directory, "node_modules", name);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

async function licenseText(directory, manifest) {
  const files = (await readdir(directory)).sort();
  const license = files.find((file) => /^(?:licen[cs]e|copying|notice)(?:[.\-_]|$)/i.test(file));
  if (license) return normalized(await readFile(path.join(directory, license), "utf8"));

  const sharedPackage = sharedLicensePackages.get(manifest.name);
  if (!sharedPackage) {
    const omission = packagedLicenseOmissions.get(manifest.name);
    if (omission?.license !== manifest.license || omission.author !== manifest.author) {
      throw new Error(`${manifest.name}@${manifest.version} has no packaged license or notice file.`);
    }
    return normalized(omission.text);
  }
  const sharedDirectory = await resolvePackage(sharedPackage, root);
  if (!sharedDirectory) throw new Error(`${manifest.name}@${manifest.version} shares its license with missing ${sharedPackage}.`);
  const sharedManifest = JSON.parse(await readFile(path.join(sharedDirectory, "package.json"), "utf8"));
  if (sharedManifest.version !== manifest.version || sharedManifest.repository !== manifest.repository) {
    throw new Error(`${manifest.name}@${manifest.version} no longer matches the verified ${sharedPackage} release.`);
  }
  return licenseText(sharedDirectory, sharedManifest);
}

export async function runtimeLicenseEntries() {
  const queue = [];
  for (const name of [...Object.keys(project.dependencies ?? {}), ...fontPackages]) {
    if (excludedPackages.has(name)) continue;
    const directory = await resolvePackage(name, root);
    if (!directory) throw new Error(`${name} is declared for the app but is not installed.`);
    queue.push(directory);
  }

  const visitedDirectories = new Set();
  const packages = new Map();
  while (queue.length) {
    const directory = queue.shift();
    if (visitedDirectories.has(directory)) continue;
    visitedDirectories.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    if (excludedPackages.has(manifest.name)) continue;
    const relative = path.relative(root, directory).split(path.sep).join("/");
    const locked = lock.packages?.[relative];
    if (locked?.version !== manifest.version) {
      throw new Error(`${manifest.name} is ${manifest.version} on disk but ${locked?.version ?? "missing"} in package-lock.json.`);
    }
    const key = `${manifest.name}@${manifest.version}`;
    if (!packages.has(key)) {
      packages.set(key, {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? "UNSPECIFIED",
        text: await licenseText(directory, manifest),
      });
    }
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      if (excludedPackages.has(name)) continue;
      const dependency = await resolvePackage(name, directory);
      if (dependency) queue.push(dependency);
    }
  }
  return [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function npmLicenses(entries) {
  let output = `AI Coding Tool npm runtime and font licenses
================================================

Generated from package-lock.json and the exact installed package manifests.
Do not edit this file by hand. It covers ${entries.length} packages loaded by
the Electron main process or bundled as font assets. CUA and UBJS notices are
kept in the dedicated CUA files. JavaScript compiled into the desktop and
phone interfaces has separate build-generated notice files.
`;
  for (const entry of entries) {
    output += `
${entry.name}@${entry.version}
${"-".repeat(entry.name.length + entry.version.length + 1)}

License: ${entry.license}

${entry.text}`;
  }
  return normalized(output);
}

async function thirdPartyNotice() {
  const template = await readFile(path.join(root, "scripts", "legal", "THIRD-PARTY-NOTICES.template.txt"), "utf8");
  const values = {
    ANTHROPIC_SDK_VERSION: ANTHROPIC_AGENT_SDK_VERSION,
    CUA_COMMIT: CUA_RELEASE.sourceCommit,
    CUA_VERSION: CUA_DRIVER_VERSION,
    ELECTRON_VERSION,
    LIBFFI_SYS_VERSION: CUA_RELEASE.libffiSysVersion,
    LIBFFI_VERSION: CUA_RELEASE.libffiVersion,
    UBJS_COMMIT: CUA_RELEASE.ubjsCommit,
    UBJS_VERSION,
    UNIFFI_COMMIT: CUA_RELEASE.uniffiCommit,
    UNIFFI_VERSION: CUA_RELEASE.uniffiVersion,
  };
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`Unknown legal notice token: ${key}`);
    return values[key];
  });
  if (rendered.includes("{{")) throw new Error("An unresolved legal notice token remains.");
  return normalized(rendered);
}

export async function generatedLegalNotices() {
  return new Map([
    ["NPM-RUNTIME-LICENSES.txt", npmLicenses(await runtimeLicenseEntries())],
    ["THIRD-PARTY-NOTICES.txt", await thirdPartyNotice()],
  ]);
}

async function checkPinnedSourceReports() {
  for (const [name, expectedNeedles] of pinnedSourceReportNeedles) {
    const value = await readFile(path.join(legalDirectory, name), "utf8");
    for (const needle of expectedNeedles()) {
      if (!value.includes(needle)) throw new Error(`${name} is stale: expected ${needle}.`);
    }
  }
}

export async function writeLegalNotices() {
  await mkdir(legalDirectory, { recursive: true });
  for (const [name, expected] of await generatedLegalNotices()) {
    const file = path.join(legalDirectory, name);
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === expected) continue;
    await writeFile(file, expected);
  }
  await checkPinnedSourceReports();
}

export async function checkLegalNotices() {
  const stale = [];
  for (const [name, expected] of await generatedLegalNotices()) {
    const actual = await readFile(path.join(legalDirectory, name), "utf8").catch(() => null);
    if (actual !== expected) stale.push(name);
  }
  if (stale.length) {
    throw new Error(`Generated legal notices are stale: ${stale.join(", ")}. Run npm run prepare:cua.`);
  }
  await checkPinnedSourceReports();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  if (process.argv.includes("--write")) await writeLegalNotices();
  else if (process.argv.includes("--check")) await checkLegalNotices();
  else throw new Error("Use --write or --check.");
}
