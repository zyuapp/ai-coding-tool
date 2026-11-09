/** Builds the dictation helper on Apple silicon Macs. Elsewhere, or without Swift, there is nothing to build. */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = path.join(root, "native", "dictation");
const output = path.join(root, "dist", "native", "aic-dictation");
/** What a source build runs; packaging leaves it out. */
const devOutput = path.join(root, "dist", "native", "aic-dictation-dev");

function newest(folder: string): number {
  return Math.max(...readdirSync(folder, { withFileTypes: true }).map((entry) => {
    const at = path.join(folder, entry.name);
    return entry.isDirectory() ? newest(at) : statSync(at).mtimeMs;
  }));
}

if (process.platform !== "darwin" || process.arch !== "arm64") process.exit(0);
const sources = Math.max(newest(path.join(pkg, "Sources")), statSync(path.join(pkg, "Package.swift")).mtimeMs);
if (existsSync(output) && statSync(output).mtimeMs >= sources) {
  if (!existsSync(devOutput)) copyFileSync(output, devOutput);
  process.exit(0);
}

let swift: string;
try {
  swift = execFileSync("xcrun", ["-f", "swift"], { encoding: "utf8" }).trim();
} catch {
  console.warn("Skipping the dictation helper: Xcode is not installed.");
  process.exit(0);
}

execFileSync(swift, ["build", "-c", "release", "--arch", "arm64", "--package-path", pkg], { stdio: "inherit" });
const bin = execFileSync(swift, ["build", "-c", "release", "--arch", "arm64", "--package-path", pkg, "--show-bin-path"], { encoding: "utf8" }).trim();
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(path.join(bin, "aic-dictation"), output);
copyFileSync(output, devOutput);
// @ts-expect-error The notice writer is plain JavaScript so the legal check can run it directly.
const { writeDictationNotices } = await import("./legal/dictation-notices.mjs");
await writeDictationNotices();
