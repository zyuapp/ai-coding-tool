import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppImageUpdater } from "electron-updater";
import { DownloadedUpdateHelper } from "electron-updater/out/DownloadedUpdateHelper.js";
import { test } from "vitest";
import { cliConfiguration } from "../../src/domain/cli.ts";
import { registerAppImageUpdateRepair } from "../../src/main/appimage-update.ts";
import { appImageDesktopEntry, LINUX_DESKTOP_FILE } from "../../src/main/linux-protocol.ts";

class FixtureUpdater extends AppImageUpdater {
  async stage(file: string) {
    this.downloadedUpdateHelper = new DownloadedUpdateHelper(path.dirname(file));
    const info = { url: path.basename(file), sha512: "fixture" };
    await this.downloadedUpdateHelper.setDownloadedFile(file, null,
      { version: "0.5.7", releaseDate: "2026-09-13T00:00:00Z", files: [info], path: info.url, sha512: info.sha512 },
      { url: new URL(`file://${file}`), info }, path.basename(file), false);
    this.addQuitHandler();
  }
}

for (const scenario of ["quit without restart", "restart", "failed restart"] as const) {
  test.skipIf(process.platform !== "linux")(`real AppImageUpdater repairs launchers on ${scenario}`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aic-real-update-"));
    const previousImage = process.env.APPIMAGE;
    t.onTestFinished(async () => {
      if (previousImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = previousImage;
      await rm(home, { recursive: true, force: true });
    });
    const oldImage = path.join(home, "AI Coding Tool-0.5.6.AppImage");
    const newImage = path.join(home, "AI Coding Tool-0.5.7.AppImage");
    const downloaded = path.join(home, "pending", path.basename(newImage));
    const desktop = path.join(home, ".local/share/applications", LINUX_DESKTOP_FILE);
    const cli = cliConfiguration("linux", home, oldImage)!;
    const marker = path.join(home, "installer-ran.json");
    await Promise.all([path.dirname(desktop), path.dirname(cli.installPath), path.dirname(downloaded)].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(oldImage, "old executable");
    await writeFile(desktop, appImageDesktopEntry(oldImage));
    await writeFile(cli.installPath, cli.script, { mode: 0o755 });
    // A harmless executable replaces the AppImage payload. The installer, filesystem moves,
    // filename event, and child launch are real; the child never repairs its own launchers.
    await writeFile(downloaded, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync(${JSON.stringify(desktop)}, 'utf8'), ${JSON.stringify(appImageDesktopEntry(newImage))});
assert.equal(fs.readFileSync(${JSON.stringify(cli.installPath)}, 'utf8'), ${JSON.stringify(cliConfiguration("linux", home, newImage)!.script)});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ exitAfterInstall: process.env.APPIMAGE_EXIT_AFTER_INSTALL === 'true' }));
process.exit(${scenario === "failed restart" ? 42 : 0});
`, { mode: 0o755 });
    process.env.APPIMAGE = oldImage;
    let quitHandler: ((exitCode: number) => void) | undefined;
    const updater = new FixtureUpdater(null, {
      version: "0.5.6",
      onQuit: (handler: (exitCode: number) => void) => { quitHandler = handler; },
    });
    updater.logger = console;
    registerAppImageUpdateRepair(updater, { home, appImage: oldImage });
    await updater.stage(downloaded);
    if (scenario === "quit without restart") {
      assert.ok(quitHandler);
      quitHandler(0);
    } else {
      assert.equal(updater.install(false, true), true);
    }
    // Synchronous assertions: no event loop turn or new-app startup is required for repair.
    assert.equal(existsSync(oldImage), false);
    assert.equal(existsSync(downloaded), false);
    assert.equal(existsSync(newImage), true);
    assert.equal(readFileSync(desktop, "utf8"), appImageDesktopEntry(newImage));
    assert.equal(readFileSync(cli.installPath, "utf8"), cliConfiguration("linux", home, newImage)!.script);
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readFileSync(marker, "utf8"), JSON.stringify({ exitAfterInstall: scenario === "quit without restart" }));
  });
}
