import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { chromiumKey, readCookieHosts, readCookies } from "../../src/main/browser-cookies.ts";

const NOW = 1_800_000_000;
const CHROMIUM_EPOCH = 11_644_473_600;
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function folder() {
  const created = await mkdtemp(path.join(tmpdir(), "aic-cookie-test-"));
  folders.push(created);
  return created;
}

function encrypt(value: string, host: string, key: Buffer, version = "v10") {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from(version), cipher.update(plain), cipher.final()]);
}

function chromiumTime(seconds: number) {
  return (seconds + CHROMIUM_EPOCH) * 1_000_000;
}

async function chromiumStore(key: Buffer) {
  const file = path.join(await folder(), "Cookies");
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);
  `);
  const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)");
  insert.run(".github.com", "", "logged_in", encrypt("yes", ".github.com", key), "/", chromiumTime(NOW + 3600), 1, 1, 1);
  insert.run("github.com", "", "user_session", encrypt("abc123", "github.com", key), "/", 0, 1, 1, 2);
  insert.run("github.com", "", "stale", encrypt("old", "github.com", key), "/", chromiumTime(NOW - 10), 1, 0, 0);
  insert.run("github.com", "https://other.example", "partitioned", encrypt("p", "github.com", key), "/", 0, 1, 0, 0);
  insert.run("example.com", "", "theme", encrypt("dark", "example.com", key), "/", 0, 0, 0, -1);
  database.close();
  return file;
}

test("listing a Chromium profile counts live cookies per host without decrypting anything", async () => {
  const file = await chromiumStore(chromiumKey("secret", 1003));
  const hosts = await readCookieHosts("chromium", file, NOW);

  assert.deepEqual(hosts.sort((left, right) => left.host.localeCompare(right.host)), [
    { host: ".github.com", cookies: 1 },
    { host: "example.com", cookies: 1 },
    { host: "github.com", cookies: 1 },
  ]);
});

test("Chromium cookies for the chosen sites come back decrypted, and only those", async () => {
  const key = chromiumKey("secret", 1003);
  const file = await chromiumStore(key);
  const asked: string[] = [];
  const { cookies, skipped } = await readCookies("chromium", file, ["github.com"], async (version) => {
    asked.push(version);
    return [chromiumKey("wrong", 1003), key];
  }, NOW);

  assert.equal(skipped, 0);
  assert.deepEqual(asked, ["v10"], "the key is fetched once, however many cookies need it");
  assert.deepEqual(cookies.sort((left, right) => left.name.localeCompare(right.name)), [
    { host: ".github.com", name: "logged_in", value: "yes", path: "/", secure: true, httpOnly: true, expires: NOW + 3600, sameSite: "lax" },
    { host: "github.com", name: "user_session", value: "abc123", path: "/", secure: true, httpOnly: true, expires: null, sameSite: "strict" },
  ]);
});

test("a cookie no key opens is counted as skipped rather than copied wrong", async () => {
  const file = await chromiumStore(chromiumKey("secret", 1003));
  const { cookies, skipped } = await readCookies("chromium", file, ["github.com"], async () => [chromiumKey("wrong", 1003)], NOW);

  assert.deepEqual(cookies, []);
  assert.equal(skipped, 2);
});

test("Firefox cookies are read as stored, leaving container cookies behind", async () => {
  const file = path.join(await folder(), "cookies.sqlite");
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE moz_cookies (originAttributes TEXT, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)`);
  const insert = database.prepare("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("", "sid", "firefox-value", ".wikipedia.org", "/", NOW + 60, 1, 1, 0);
  insert.run("", "ms", "millis", "en.wikipedia.org", "/wiki", (NOW + 60) * 1000, 0, 0, 1);
  insert.run("^userContextId=2", "work", "container", ".wikipedia.org", "/", NOW + 60, 1, 1, 0);
  insert.run("", "gone", "expired", ".wikipedia.org", "/", NOW - 60, 1, 1, 0);
  database.close();

  assert.deepEqual(await readCookieHosts("firefox", file, NOW), [{ host: ".wikipedia.org", cookies: 1 }, { host: "en.wikipedia.org", cookies: 1 }]);
  const { cookies } = await readCookies("firefox", file, ["wikipedia.org"], async () => [], NOW);
  assert.deepEqual(cookies, [
    { host: ".wikipedia.org", name: "sid", value: "firefox-value", path: "/", secure: true, httpOnly: true, expires: NOW + 60, sameSite: "no_restriction" },
    { host: "en.wikipedia.org", name: "ms", value: "millis", path: "/wiki", secure: false, httpOnly: false, expires: NOW + 60, sameSite: "lax" },
  ]);
});
