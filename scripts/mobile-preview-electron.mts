import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A separate macOS bundle identity keeps preview recovery dialogs and saved windows independent
 * of the desktop's Electron. The dependency stays untouched; this copy is cached per version. */
export async function previewElectron(root: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const executable: string = require("electron");
  if (process.platform !== "darwin") return executable;
  const version: string = require("electron/package.json").version;
  const cache = path.join(root, "node_modules/.cache/mobile-preview");
  const target = path.join(cache, `${version}-2`);
  const ready = path.join(target, "ready");
  const binary = path.join(target, "Mobile Preview.app/Contents/MacOS/Electron");
  if (await access(ready).then(() => true, () => false)) return binary;

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, "prepare-"));
  try {
    const bundle = path.join(staging, "Mobile Preview.app");
    await cp(path.resolve(executable, "../../.."), bundle, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const plist = path.join(bundle, "Contents/Info.plist");
    await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier com.zyuapp.aicodingtool.mobile-preview", plist]);
    await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Mobile Preview", plist]);
    // ICNS supports a PNG record directly; the shared app artwork is 256 × 256.
    const png = await readFile(path.join(root, "assets/icon.png"));
    const header = Buffer.alloc(16);
    header.write("icns", 0);
    header.writeUInt32BE(png.length + 16, 4);
    header.write("ic08", 8);
    header.writeUInt32BE(png.length + 8, 12);
    await writeFile(path.join(bundle, "Contents/Resources/mobile-preview.icns"), Buffer.concat([header, png]));
    await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIconFile mobile-preview.icns", plist]);
    await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
    await writeFile(path.join(staging, "ready"), version);
    try {
      await rename(staging, target);
    } catch (error) {
      // Another launcher may have finished preparing the same version while this one copied it.
      if (!await access(ready).then(() => true, () => false)) throw error;
    }
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
