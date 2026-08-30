import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  assert.match(entry, /X-AICodingTool-AppImageIntegration=true/);
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

test("an unchanged AppImage registration does not rewrite files or reassociate the scheme", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-current-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const icon = path.join(home, "source.png");
  await writeFile(icon, "same icon", "utf8");
  let associated = false;
  let associationWrites = 0;
  const options = {
    appImage: "/opt/AI Coding Tool.AppImage",
    home,
    iconSource: icon,
    isAssociated: async () => associated,
    associate: async () => { associated = true; associationWrites += 1; },
  };

  const first = await registerAppImageProtocol(options);
  const firstDesktop = await stat(first.desktopPath);
  const firstIcon = await stat(first.iconPath);
  const second = await registerAppImageProtocol(options);

  assert.equal(second.filesChanged, false);
  assert.equal(second.associationChanged, false);
  assert.equal((await stat(second.desktopPath)).ino, firstDesktop.ino);
  assert.equal((await stat(second.iconPath)).ino, firstIcon.ino);
  assert.equal(associationWrites, 1);
});

test("moving an AppImage repairs only its owned desktop entry", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-moved-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const icon = path.join(home, "source.png");
  await writeFile(icon, "same icon", "utf8");
  const options = {
    home,
    iconSource: icon,
    isAssociated: async () => true,
    associate: async () => assert.fail("an unchanged desktop-file association must not be rewritten"),
  };
  const first = await registerAppImageProtocol({ ...options, appImage: "/opt/old.AppImage" });
  const firstDesktop = await stat(first.desktopPath);
  const firstIcon = await stat(first.iconPath);
  const second = await registerAppImageProtocol({ ...options, appImage: "/home/me/Apps/new.AppImage" });

  assert.match(await readFile(second.desktopPath, "utf8"), /Exec="\/home\/me\/Apps\/new\.AppImage" %U/);
  assert.notEqual((await stat(second.desktopPath)).ino, firstDesktop.ino);
  assert.equal((await stat(second.iconPath)).ino, firstIcon.ino);
  assert.equal(second.filesChanged, true);
  assert.equal(second.associationChanged, false);
});

test("AppImage registration refuses to overwrite unrelated regular files", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-unrelated-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, ".local", "share");
  const desktopPath = path.join(dataHome, "applications", LINUX_DESKTOP_FILE);
  const iconPath = path.join(dataHome, "icons", "hicolor", "256x256", "apps", "com.zyuapp.aicodingtool.png");
  const sourceIcon = path.join(home, "source.png");
  await Promise.all([
    mkdir(path.dirname(desktopPath), { recursive: true }),
    mkdir(path.dirname(iconPath), { recursive: true }),
    writeFile(sourceIcon, "new icon", "utf8"),
  ]);
  await Promise.all([
    writeFile(desktopPath, "somebody else's desktop entry", "utf8"),
    writeFile(iconPath, "somebody else's icon", "utf8"),
  ]);

  await assert.rejects(registerAppImageProtocol({
    appImage: "/opt/AI Coding Tool.AppImage",
    home,
    iconSource: sourceIcon,
    associate: async () => assert.fail("unsafe files must fail before association"),
  }), /unrelated desktop entry/);
  assert.equal(await readFile(desktopPath, "utf8"), "somebody else's desktop entry");
  assert.equal(await readFile(iconPath, "utf8"), "somebody else's icon");
});

test("AppImage registration repairs an orphaned icon at its reverse-DNS path", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aic-linux-protocol-orphaned-icon-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, ".local", "share");
  const desktopPath = path.join(dataHome, "applications", LINUX_DESKTOP_FILE);
  const iconPath = path.join(dataHome, "icons", "hicolor", "256x256", "apps", "com.zyuapp.aicodingtool.png");
  const sourceIcon = path.join(home, "source.png");
  await mkdir(path.dirname(iconPath), { recursive: true });
  await Promise.all([
    writeFile(sourceIcon, "new icon", "utf8"),
    writeFile(iconPath, "old app icon", "utf8"),
  ]);

  const associations: string[] = [];
  const result = await registerAppImageProtocol({
    appImage: "/opt/AI Coding Tool.AppImage",
    home,
    iconSource: sourceIcon,
    associate: async (desktopFile) => { associations.push(desktopFile); },
  });
  assert.equal(result.desktopPath, desktopPath);
  assert.match(await readFile(desktopPath, "utf8"), /Exec="\/opt\/AI Coding Tool\.AppImage" %U/);
  assert.equal(await readFile(iconPath, "utf8"), "new icon");
  assert.deepEqual(associations, [LINUX_DESKTOP_FILE]);
});
