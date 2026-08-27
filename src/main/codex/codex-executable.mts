import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type PlatformPackage = { name: string; triple: string };

/** The `@openai/codex` platform packages this app ships, keyed by Node's `${platform}-${arch}`. */
const PLATFORM_PACKAGES: Partial<Record<string, PlatformPackage>> = {
  "darwin-arm64": { name: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
};

export function codexPlatformPackage(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): PlatformPackage {
  const found = PLATFORM_PACKAGES[`${platform}-${arch}`];
  if (!found) throw new Error(`Codex is not bundled for ${platform} ${arch}.`);
  return found;
}

/** Where the binary sits inside its platform package. */
function binaryWithin({ triple }: PlatformPackage) {
  return path.join("vendor", triple, "bin", "codex");
}

/** The binary electron-builder unpacked from the asar, or nothing when running unpackaged. */
export function packagedCodexExecutable(resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath) {
  if (!resourcesPath) return undefined;
  const platformPackage = codexPlatformPackage();
  const executable = path.join(resourcesPath, "app.asar.unpacked", "node_modules", platformPackage.name, binaryWithin(platformPackage));
  return existsSync(executable) ? executable : undefined;
}

function installedCodexExecutable() {
  const platformPackage = codexPlatformPackage();
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve(`${platformPackage.name}/package.json`));
  return path.join(packageRoot, binaryWithin(platformPackage));
}

export function codexExecutable(resourcesPath?: string) {
  return packagedCodexExecutable(resourcesPath) ?? installedCodexExecutable();
}
