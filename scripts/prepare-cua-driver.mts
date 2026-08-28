import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const version = "0.22.2";
const archiveName = `cua-driver-rs-${version}-darwin-arm64.tar.gz`;
const expectedArchiveHash = "ac05a34ff2416830ec56f44d9986cf04ffb1f6a15a5df6f4dd9bec13ac198d63";
const marker = `${version}-darwin-arm64-v4`;
const targetDir = path.resolve("vendor/cua-driver");
const binaryPath = path.join(targetDir, "cua-driver");
const markerPath = path.join(targetDir, "version");

async function hash(data: NodeJS.ArrayBufferView) {
  return createHash("sha256").update(data).digest("hex");
}

/** The Cua releases ship both architectures, and half of every one can never run on the app's target. */
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

/** The SDK the app loads in process ships beside the driver, and carries the same second architecture. */
const sdkRoot = path.dirname(createRequire(import.meta.url).resolve("@trycua/cua-driver-darwin-arm64/package.json"));
await thin(path.join(sdkRoot, "libcua_driver_sdk.dylib"));

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
await run("tar", ["-xzf", archivePath, "-C", targetDir, "--strip-components=1", `${archiveName.slice(0, -7)}/cua-driver`]);
await rm(archivePath, { force: true });
await thin(binaryPath);
await chmod(binaryPath, 0o755);
await writeFile(markerPath, `${marker}\n`);
