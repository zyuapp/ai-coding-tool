import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cookieOnSite } from "../domain/browser-import.js";

/** One cookie as another browser stored it, already decrypted. `expires` is in Unix seconds, null for a session cookie. */
export type StoredCookie = {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires: number | null;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

export type CookieFamily = "chromium" | "firefox";

/** The passwords a Chromium cookie of each version may be encrypted under, read only when one is needed. */
export type ChromiumKeys = (version: "v10" | "v11") => Promise<Buffer[]>;

/** Seconds between 1601, where Chromium counts from, and 1970. */
const CHROMIUM_EPOCH_OFFSET = 11_644_473_600;
const SAME_SITE = ["no_restriction", "lax", "strict"] as const;
/** Chromium prefixes a value with the SHA-256 of its host from this cookie database version on. */
const HASHED_VALUES_VERSION = 24;
const CBC_IV = Buffer.alloc(16, 0x20);

/** A Chromium key from the password its keyring holds. */
export function chromiumKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/**
 * The browser keeps its database open and may be writing to it, so the file and its write-ahead log
 * are read from a private copy that is removed afterwards.
 */
async function withCopy<T>(file: string, read: (database: DatabaseSync) => T): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), "aic-cookies-"));
  try {
    const copy = path.join(folder, "cookies.sqlite");
    await copyFile(file, copy);
    for (const suffix of ["-wal", "-journal"]) await copyFile(`${file}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
    const database = new DatabaseSync(copy);
    try {
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function columns(database: DatabaseSync, table: string) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

/** Chromium's microsecond times are past what a JavaScript number holds exactly, so SQLite turns them into Unix seconds. */
const CHROMIUM_EXPIRY = `CASE WHEN expires_utc = 0 THEN 0 ELSE expires_utc / 1000000 - ${CHROMIUM_EPOCH_OFFSET} END`;

function chromiumFilter(database: DatabaseSync) {
  /** Cookies partitioned under another site's frame have nowhere to go in a session without partitions. */
  const partitioned = columns(database, "cookies").has("top_frame_site_key") ? "AND top_frame_site_key = ''" : "";
  return `WHERE (expires_utc = 0 OR ${CHROMIUM_EXPIRY} > ?) ${partitioned}`;
}

/** Firefox stored expiry in seconds and later moved to milliseconds. */
function firefoxExpiry(expiry: number) {
  return expiry > 100_000_000_000 ? expiry / 1000 : expiry;
}

/** How many unexpired cookies each host holds, which is all listing sites needs: nothing is decrypted. */
export function readCookieHosts(family: CookieFamily, file: string, now = Date.now() / 1000): Promise<Array<{ host: string; cookies: number }>> {
  return withCopy(file, (database) => {
    if (family === "firefox") {
      const rows = database.prepare("SELECT host, expiry FROM moz_cookies WHERE originAttributes = ''").all();
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (firefoxExpiry(Number(row.expiry)) <= now) continue;
        counts.set(String(row.host), (counts.get(String(row.host)) ?? 0) + 1);
      }
      return [...counts].map(([host, cookies]) => ({ host, cookies }));
    }
    return database.prepare(`SELECT host_key AS host, COUNT(*) AS cookies FROM cookies ${chromiumFilter(database)} GROUP BY host_key`).all(now)
      .map((row) => ({ host: String(row.host), cookies: Number(row.cookies) }));
  });
}

type ChromiumRow = { host: string; name: string; value: string; encrypted: Uint8Array; path: string; expires: number; secure: number; httpOnly: number; sameSite: number };

/** Decrypts one Chromium value, or null when none of the keys open it. */
export function decryptChromiumValue(encrypted: Buffer, host: string, keys: Buffer[], hashed: boolean): string | null {
  const body = encrypted.subarray(3);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV);
      let plain = Buffer.concat([decipher.update(body), decipher.final()]);
      if (hashed) {
        if (plain.length < 32 || !plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())) continue;
        plain = plain.subarray(32);
      }
      const value = plain.toString("utf8");
      /** A wrong key can still unpad cleanly; what it yields is not text a cookie could hold. */
      if (/[\x00-\x1f\x7f�]/.test(value)) continue;
      return value;
    } catch {
      continue;
    }
  }
  return null;
}

/** Every unexpired cookie for the given sites. Ones no key opens are counted rather than returned. */
export async function readCookies(family: CookieFamily, file: string, sites: string[], keys: ChromiumKeys, now = Date.now() / 1000): Promise<{ cookies: StoredCookie[]; skipped: number }> {
  if (family === "firefox") {
    const rows = await withCopy(file, (database) => database.prepare(
      "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''",
    ).all());
    const cookies = rows
      .filter((row) => sites.some((site) => cookieOnSite(String(row.host), site)) && firefoxExpiry(Number(row.expiry)) > now)
      .map((row): StoredCookie => ({
        host: String(row.host),
        name: String(row.name),
        value: String(row.value),
        path: String(row.path || "/"),
        secure: Boolean(row.isSecure),
        httpOnly: Boolean(row.isHttpOnly),
        expires: Math.floor(firefoxExpiry(Number(row.expiry))),
        sameSite: SAME_SITE[Number(row.sameSite)] ?? "unspecified",
      }));
    return { cookies, skipped: 0 };
  }
  const { rows, version } = await withCopy(file, (database) => {
    const meta = database.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const rows = database.prepare(
      `SELECT host_key AS host, name, value, encrypted_value AS encrypted, path, ${CHROMIUM_EXPIRY} AS expires, is_secure AS secure, is_httponly AS httpOnly, samesite AS sameSite FROM cookies ${chromiumFilter(database)}`,
    ).all(now) as unknown as ChromiumRow[];
    return { rows: rows.filter((row) => sites.some((site) => cookieOnSite(row.host, site))), version: Number(meta?.value ?? 0) };
  });
  const keyring = new Map<string, Promise<Buffer[]>>();
  const cookies: StoredCookie[] = [];
  let skipped = 0;
  for (const row of rows) {
    const encrypted = Buffer.from(row.encrypted ?? []);
    let value: string | null = row.value;
    if (encrypted.length) {
      const prefix = encrypted.subarray(0, 3).toString("latin1");
      if (prefix !== "v10" && prefix !== "v11") { skipped += 1; continue; }
      if (!keyring.has(prefix)) keyring.set(prefix, keys(prefix));
      value = decryptChromiumValue(encrypted, row.host, await keyring.get(prefix)!, version >= HASHED_VALUES_VERSION);
    }
    if (value === null) { skipped += 1; continue; }
    cookies.push({
      host: row.host,
      name: row.name,
      value,
      path: row.path || "/",
      secure: Boolean(row.secure),
      httpOnly: Boolean(row.httpOnly),
      expires: row.expires || null,
      sameSite: SAME_SITE[Number(row.sameSite)] ?? "unspecified",
    });
  }
  return { cookies, skipped };
}
