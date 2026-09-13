import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { cliConfiguration } from "../../src/domain/cli.ts";
import { registerAppImageUpdateRepair } from "../../src/main/appimage-update.ts";
import { appImageDesktopEntry, LINUX_DESKTOP_FILE } from "../../src/main/linux-protocol.ts";

for (const customDataHome of [false, true]) {
  test(`an update repairs launchers before exiting without starting the new app (XDG override: ${customDataHome})`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aic-update-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const dataHome = customDataHome ? path.join(home, "custom data") : undefined;
    const desktop = path.join(dataHome ?? path.join(home, ".local/share"), "applications", LINUX_DESKTOP_FILE);
    const oldImage = path.join(home, "AI Coding Tool-0.5.6.AppImage");
    const newImage = path.join(home, 'AI Coding Tool "100%"-0.5.7.AppImage');
    const cli = cliConfiguration("linux", home, oldImage)!;
    await mkdir(path.dirname(desktop), { recursive: true });
    await mkdir(path.dirname(cli.installPath), { recursive: true });
    await writeFile(oldImage, "app");
    await writeFile(desktop, appImageDesktopEntry(oldImage));
    await writeFile(cli.installPath, cli.script, { mode: 0o755 });
    const updater = new EventEmitter();
    registerAppImageUpdateRepair(updater, { home, dataHome, appImage: oldImage });

    // Match AppImageUpdater: move the executable, emit, then quit. No new app repairs it.
    await rename(oldImage, newImage);
    updater.emit("appimage-filename-updated", newImage);
    assert.equal(existsSync(oldImage), false);
    assert.equal(readFileSync(desktop, "utf8"), appImageDesktopEntry(newImage));
    assert.equal(readFileSync(cli.installPath, "utf8"), cliConfiguration("linux", home, newImage)!.script);
    assert.equal(statSync(cli.installPath).mode & 0o777, 0o755);
  });
}

for (const kind of ["missing", "unrelated", "symlink", "other-install"] as const) {
  test(`an update preserves ${kind} launchers`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "aic-update-preserve-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const desktop = path.join(home, ".local/share/applications", LINUX_DESKTOP_FILE);
    const oldImage = path.join(home, "old.AppImage");
    const cli = cliConfiguration("linux", home, oldImage)!;
    await mkdir(path.dirname(desktop), { recursive: true });
    await mkdir(path.dirname(cli.installPath), { recursive: true });
    const external = path.join(home, "external");
    await writeFile(external, "keep");
    for (const target of [desktop, cli.installPath]) {
      if (kind === "symlink") await symlink(external, target);
      if (kind === "unrelated") await writeFile(target, "keep");
      if (kind === "other-install") await writeFile(target, target === desktop
        ? appImageDesktopEntry("/other/app.AppImage")
        : cliConfiguration("linux", home, "/other/app.AppImage")!.script);
    }
    const before = [desktop, cli.installPath].map((target) => existsSync(target) ? readFileSync(target, "utf8") : null);
    const updater = new EventEmitter();
    registerAppImageUpdateRepair(updater, { home, appImage: oldImage });
    updater.emit("appimage-filename-updated", path.join(home, "new.AppImage"));
    assert.deepEqual([desktop, cli.installPath].map((target) => existsSync(target) ? readFileSync(target, "utf8") : null), before);
    assert.equal(readFileSync(external, "utf8"), "keep");
  });
}
