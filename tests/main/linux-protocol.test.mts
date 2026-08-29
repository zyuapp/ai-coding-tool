import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { appImageDesktopEntry, LINUX_DESKTOP_FILE, registerAppImageProtocol } from "../../src/main/linux-protocol.ts";

test("the AppImage desktop entry opens protocol URLs in the portable executable", () => {
  const entry = appImageDesktopEntry('/home/me/Apps/AI Coding Tool "daily" 100%.AppImage');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /Exec="\/home\/me\/Apps\/AI Coding Tool \\"daily\\" 100%%\.AppImage" %U/);
  assert.match(entry, /MimeType=x-scheme-handler\/aicodingtool;/);
  assert.match(entry, /StartupWMClass=com\.zyuapp\.aicodingtool/);
});

test("AppImage registration writes only user-local integration and associates the scheme", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const icon = path.join(home, "source.png");
  await writeFile(icon, "png");
  const associations: string[] = [];
  const result = await registerAppImageProtocol({
    appImage: "/opt/apps/AI Coding Tool.AppImage",
    home,
    iconSource: icon,
    associate: async (desktopFile) => { associations.push(desktopFile); },
  });

  assert.equal(result.desktopPath, path.join(home, ".local/share/applications", LINUX_DESKTOP_FILE));
  assert.match(await readFile(result.desktopPath, "utf8"), /Exec="\/opt\/apps\/AI Coding Tool\.AppImage" %U/);
  assert.equal(await readFile(result.iconPath, "utf8"), "png");
  assert.deepEqual(associations, [LINUX_DESKTOP_FILE]);
});

test("AppImage registration replaces integration symlinks without writing through them", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-links-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, ".local", "share");
  const desktopPath = path.join(dataHome, "applications", LINUX_DESKTOP_FILE);
  const iconPath = path.join(dataHome, "icons", "hicolor", "256x256", "apps", "com.zyuapp.aicodingtool.png");
  await Promise.all([mkdir(path.dirname(desktopPath), { recursive: true }), mkdir(path.dirname(iconPath), { recursive: true })]);
  const protectedDesktop = path.join(home, "desktop-user-data");
  const protectedIcon = path.join(home, "icon-user-data");
  const sourceIcon = path.join(home, "source.png");
  await Promise.all([
    writeFile(protectedDesktop, "keep desktop", "utf8"),
    writeFile(protectedIcon, "keep icon", "utf8"),
    writeFile(sourceIcon, "new icon", "utf8"),
  ]);
  await Promise.all([symlink(protectedDesktop, desktopPath), symlink(protectedIcon, iconPath)]);

  await registerAppImageProtocol({
    appImage: "/opt/AI Coding Tool.AppImage",
    home,
    iconSource: sourceIcon,
    associate: async () => undefined,
  });

  assert.equal(await readFile(protectedDesktop, "utf8"), "keep desktop");
  assert.equal(await readFile(protectedIcon, "utf8"), "keep icon");
  assert.equal((await lstat(desktopPath)).isFile(), true);
  assert.equal((await lstat(iconPath)).isFile(), true);
});
