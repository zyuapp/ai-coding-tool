/** Builds the simulator panel's native helper on macOS. Elsewhere, or without Xcode, there is nothing to build. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "native", "simulator", "aic-simulator.m");
const output = path.join(root, "dist", "native", "aic-simulator");
const frameworks = ["Foundation", "AppKit", "CoreAudio", "CoreImage", "CoreMedia", "CoreVideo", "ImageIO", "IOSurface", "VideoToolbox"];

function xcrun(...args: string[]) {
  return execFileSync("xcrun", ["--sdk", "macosx", ...args], { encoding: "utf8" }).trim();
}

if (process.platform !== "darwin") process.exit(0);
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0);

let clang: string;
let sdk: string;
try {
  clang = xcrun("-f", "clang");
  sdk = xcrun("--show-sdk-path");
} catch {
  console.warn("Skipping the simulator helper: Xcode is not installed.");
  process.exit(0);
}

mkdirSync(path.dirname(output), { recursive: true });
execFileSync(clang, [
  "-isysroot", sdk, "-arch", "arm64", "-mmacosx-version-min=13.0", "-fobjc-arc", "-O2", "-Wall", "-Werror",
  ...frameworks.flatMap((framework) => ["-framework", framework]),
  source, "-o", output,
], { stdio: "inherit" });
