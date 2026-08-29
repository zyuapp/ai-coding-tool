import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const version = "0.22.2";
const targets = {
  "darwin-arm64": {
    archiveName: `cua-driver-rs-${version}-darwin-arm64.tar.gz`,
    archiveHash: "ac05a34ff2416830ec56f44d9986cf04ffb1f6a15a5df6f4dd9bec13ac198d63",
    archiveEntry: `cua-driver-rs-${version}-darwin-arm64/cua-driver`,
    sdkPackage: "@trycua/cua-driver-darwin-arm64",
    thin: true,
  },
  "linux-x64": {
    archiveName: `cua-driver-rs-${version}-linux-x86_64-binary.tar.gz`,
    archiveHash: "cc66abc3344f7573f6af36e741f7e82a43fd24c5cbf9d71d83dffb33a0e32506",
    archiveEntry: "cua-driver",
    sdkPackage: "@trycua/cua-driver-linux-x64-gnu",
    thin: false,
  },
  "linux-arm64": {
    archiveName: `cua-driver-rs-${version}-linux-arm64-binary.tar.gz`,
    archiveHash: "8c481feb732845186249272e6df16ccf64e56bb40b2d3a73f110785d0fcd0ea1",
    archiveEntry: "cua-driver",
    sdkPackage: "@trycua/cua-driver-linux-arm64-gnu",
    thin: false,
  },
} as const;

/** macOS packaging remains Apple Silicon-only; Linux follows the build host's native architecture. */
const platformTarget = (process.platform === "darwin" ? "darwin-arm64" : `${process.platform}-${process.arch}`) as keyof typeof targets;
const target = targets[platformTarget];
/** Computer use ships with supported macOS and Linux builds; other hosts can still run the client. */
if (!target) process.exit(0);

const { archiveName, archiveHash: expectedArchiveHash, archiveEntry, sdkPackage } = target;
const marker = `${version}-${platformTarget}-v5`;
const targetDir = path.resolve("vendor/cua-driver");
const binaryPath = path.join(targetDir, "cua-driver");
const markerPath = path.join(targetDir, "version");

async function hash(data: NodeJS.ArrayBufferView) {
  return createHash("sha256").update(data).digest("hex");
}

/** The macOS Cua release and SDK ship both architectures, and the app currently targets Apple Silicon. */
async function thin(file: string) {
  const { stdout } = await promisify(execFile)("lipo", ["-archs", file]);
  if (stdout.trim() === "arm64") return;
  const thinned = `${file}.arm64`;
  await run("lipo", ["-thin", "arm64", file, "-output", thinned]);
  await rename(thinned, file);
}

async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

/** Fail before packaging when npm did not install the native SDK matching this build host. */
const sdkRoot = path.dirname(createRequire(import.meta.url).resolve(`${sdkPackage}/package.json`));
if (target.thin) await thin(path.join(sdkRoot, "libcua_driver_sdk.dylib"));

try {
  if ((await readFile(markerPath, "utf8")).trim() === marker) {
    await chmod(binaryPath, 0o755);
    process.exit(0);
  }
} catch {}

await mkdir(targetDir, { recursive: true });
const response = await fetch(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archiveName}`);
if (!response.ok) throw new Error(`Cua Driver download failed: ${response.status} ${response.statusText}`);
const archive = Buffer.from(await response.arrayBuffer());
if (await hash(archive) !== expectedArchiveHash) throw new Error("Cua Driver archive checksum mismatch.");
const archivePath = path.join(targetDir, archiveName);
await writeFile(archivePath, archive);
await run("tar", ["-xzf", archivePath, "-C", targetDir, `--strip-components=${archiveEntry.split("/").length - 1}`, archiveEntry]);
await rm(archivePath, { force: true });
if (target.thin) await thin(binaryPath);
await chmod(binaryPath, 0o755);
await writeFile(markerPath, `${marker}\n`);
