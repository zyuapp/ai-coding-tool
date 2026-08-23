import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const version = "0.21.0";
const archiveName = `cua-driver-rs-${version}-darwin-arm64.tar.gz`;
const expectedArchiveHash = "5788b7a4d863db822c65c4b9c3e3adfab787d41f4643539a9df66975e240613c";
const marker = `${version}-darwin-arm64-v3`;
const targetDir = path.resolve("vendor/cua-driver");
const binaryPath = path.join(targetDir, "cua-driver");
const markerPath = path.join(targetDir, "version");

async function hash(data: NodeJS.ArrayBufferView) {
  return createHash("sha256").update(data).digest("hex");
}

async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

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
await chmod(binaryPath, 0o755);
await writeFile(markerPath, `${marker}\n`);
