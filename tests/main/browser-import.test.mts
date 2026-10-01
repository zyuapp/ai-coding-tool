import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { cookieDetails, discover, firefoxProfileEntries } from "../../src/main/browser-import.ts";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function home() {
  const created = await mkdtemp(path.join(tmpdir(), "aic-import-home-"));
  folders.push(created);
  return created;
}

async function file(at: string, contents = "") {
  await mkdir(path.dirname(at), { recursive: true });
  await writeFile(at, contents);
}

test("macOS profiles are found under each browser's own folder, named the way the browser names them", async () => {
  const root = await home();
  const support = path.join(root, "Library", "Application Support");
  const brave = path.join(support, "BraveSoftware", "Brave-Browser");
  await file(path.join(brave, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" }, "Profile 2": { name: "Empty" } } } }));
  await file(path.join(brave, "Default", "Network", "Cookies"));
  await file(path.join(brave, "Profile 1", "Cookies"));
  await file(path.join(support, "com.operasoftware.Opera", "Network", "Cookies"));
  await file(path.join(support, "Firefox", "profiles.ini"), "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n");
  await file(path.join(support, "Firefox", "Profiles", "abc.default-release", "cookies.sqlite"));

  const sources = (await discover("darwin", root)).map(({ id, browser, profile, file }) => ({ id, browser, profile, file: path.relative(support, file) }));

  assert.deepEqual(sources, [
    { id: "brave:0:Default", browser: "Brave", profile: "Personal", file: "BraveSoftware/Brave-Browser/Default/Network/Cookies" },
    { id: "brave:0:Profile 1", browser: "Brave", profile: "Work", file: "BraveSoftware/Brave-Browser/Profile 1/Cookies" },
    { id: "opera:0:.", browser: "Opera", profile: "Default", file: "com.operasoftware.Opera/Network/Cookies" },
    { id: "firefox:0:Profiles/abc.default-release", browser: "Firefox", profile: "default-release", file: "Firefox/Profiles/abc.default-release/cookies.sqlite" },
  ]);
});

test("Linux profiles are found in the config folder and in Snap and Flatpak installs", async () => {
  const root = await home();
  await file(path.join(root, ".config", "google-chrome", "Default", "Cookies"));
  await file(path.join(root, ".var", "app", "com.brave.Browser", "config", "BraveSoftware", "Brave-Browser", "Default", "Cookies"));
  const snap = path.join(root, "snap", "firefox", "common", ".mozilla", "firefox");
  await file(path.join(snap, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=xyz.default\n");
  await file(path.join(snap, "xyz.default", "cookies.sqlite"));

  const sources = (await discover("linux", root, undefined)).map(({ id, browser }) => ({ id, browser }));

  assert.deepEqual(sources, [
    { id: "chrome:0:Default", browser: "Chrome" },
    { id: "brave:1:Default", browser: "Brave" },
    { id: "firefox:2:xyz.default", browser: "Firefox" },
  ]);
});

test("Linux finds Flatpak Vivaldi and Firefox's XDG profile, and asks each keyring under the name the browser stores its key by", async () => {
  const root = await home();
  await file(path.join(root, ".var", "app", "com.vivaldi.Vivaldi", "config", "vivaldi", "Default", "Cookies"));
  await file(path.join(root, ".config", "microsoft-edge", "Default", "Cookies"));
  await file(path.join(root, ".config", "opera", "Default", "Cookies"));
  const xdg = path.join(root, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox");
  await file(path.join(xdg, "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\n");
  await file(path.join(xdg, "abc.default", "cookies.sqlite"));

  const sources = (await discover("linux", root, undefined)).map(({ browser, kind }) => ({ browser, libsecret: kind.libsecret, kwallet: kind.kwallet }));

  assert.deepEqual(sources, [
    { browser: "Microsoft Edge", libsecret: "chromium", kwallet: "Chromium" },
    { browser: "Vivaldi", libsecret: "chrome", kwallet: "Chrome" },
    { browser: "Opera", libsecret: "chromium", kwallet: "Chromium" },
    { browser: "Firefox", libsecret: undefined, kwallet: undefined },
  ]);
});

test("Firefox's own default profile is offered first", () => {
  const entries = firefoxProfileEntries([
    "[Profile1]", "Name=old", "IsRelative=1", "Path=Profiles/old",
    "[Profile0]", "Name=current", "IsRelative=1", "Path=Profiles/current",
    "[Install4F96D1932A9F858E]", "Default=Profiles/current",
  ].join("\n"));

  assert.deepEqual(entries.map((entry) => entry.Name), ["current", "old"]);
});

test("a cookie keeps its scope: a dotted host is a domain cookie, a bare host stays host-only", () => {
  assert.deepEqual(cookieDetails({ host: ".github.com", name: "a", value: "1", path: "/", secure: true, httpOnly: true, expires: 1_900_000_000, sameSite: "lax" }), {
    url: "https://github.com/", name: "a", value: "1", domain: ".github.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000,
  });
  assert.deepEqual(cookieDetails({ host: "example.com", name: "b", value: "2", path: "/app", secure: false, httpOnly: false, expires: null, sameSite: "unspecified" }), {
    url: "http://example.com/app", name: "b", value: "2", path: "/app", secure: false, httpOnly: false, sameSite: "unspecified",
  });
});
