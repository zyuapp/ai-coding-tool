/** Builds the window backdrop addon on macOS. Elsewhere, or without Xcode or Node's headers, there is nothing to build. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "native", "glass", "aic-glass.m");
const output = path.join(root, "dist", "native", "aic-glass.node");
const headers = path.resolve(process.execPath, "..", "..", "include", "node");

function xcrun(...args: string[]) {
  return execFileSync("xcrun", ["--sdk", "macosx", ...args], { encoding: "utf8" }).trim();
}

if (process.platform !== "darwin") process.exit(0);
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0);
if (!existsSync(path.join(headers, "node_api.h"))) {
  console.warn(`Skipping the window backdrop: Node's headers are not at ${headers}.`);
  process.exit(0);
}

let clang: string;
let sdk: string;
try {
  clang = xcrun("-f", "clang");
  sdk = xcrun("--show-sdk-path");
} catch {
  console.warn("Skipping the window backdrop: Xcode is not installed.");
  process.exit(0);
}

mkdirSync(path.dirname(output), { recursive: true });
execFileSync(clang, [
  "-isysroot", sdk, "-arch", "arm64", "-mmacosx-version-min=13.0", "-fobjc-arc", "-O2", "-Wall", "-Werror",
  "-bundle", "-undefined", "dynamic_lookup", "-I", headers, "-framework", "AppKit",
  source, "-o", output,
], { stdio: "inherit" });
