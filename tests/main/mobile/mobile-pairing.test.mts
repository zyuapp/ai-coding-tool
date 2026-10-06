import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { PairingStore } from "../../../src/main/mobile/pairing.mts";
import { MAX_PAIRED_DEVICES, MAX_PAIRING_FAILURES, PAIRING_CODE_TTL_MS, PAIRING_LOCKOUT_MS } from "../../../src/domain/mobile.ts";

const AT = 1_700_000_000_000;
const PHONE = "10.0.0.9";

async function store(t: { onTestFinished(callback: () => void | Promise<void>): void }) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-pairing-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, "mobile-devices.v1.json");
  return { file, devices: new PairingStore(file), reopen: () => new PairingStore(file) };
}

test("a pairing code is worth one phone, and only while it is on screen", async (t) => {
  const { devices } = await store(t);

  const stale = devices.mint(AT);
  const expired = devices.redeem(stale.code, "iPhone", PHONE, AT + PAIRING_CODE_TTL_MS + 1);
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.code, "expired-code");
  assert.equal(devices.list().length, 0);

  const code = devices.mint(AT);
  const paired = devices.redeem(code.code, "iPhone", PHONE, AT + 1_000);
  assert.equal(paired.ok, true);
  assert.ok(paired.ok && /^[0-9a-f]{64}$/.test(paired.token));

  const second = devices.redeem(code.code, "iPad", PHONE, AT + 2_000);
  assert.equal(second.ok, false, "a spent code buys nothing a second time");
  assert.equal(devices.pending(AT + 2_000), null);
});

test("a code is traded for a token the Mac keeps only the hash of", async (t) => {
  const { file, devices, reopen } = await store(t);
  const code = devices.mint(AT);
  const paired = devices.redeem(code.code, "  iPhone  ", PHONE, AT);
  assert.ok(paired.ok);

  assert.equal(devices.authenticate(paired.token)?.id, paired.device.id);
  /** Changed, not set: a last digit that was already the replacement would be the same token. */
  const wrong = `${paired.token.slice(0, 63)}${paired.token.endsWith("0") ? "1" : "0"}`;
  assert.notEqual(wrong, paired.token);
  assert.equal(devices.authenticate(wrong), null);
  assert.equal(devices.authenticate(""), null);
  assert.equal(paired.device.name, "iPhone");

  const written = await readFile(file, "utf8");
  assert.equal(written.includes(paired.token), false, "the token itself is never written down");
  assert.equal(reopen().authenticate(paired.token)?.id, paired.device.id, "a restart still knows the phone");
});

test("a revoked phone is forgotten, on disk as well as in memory", async (t) => {
  const { devices, reopen } = await store(t);
  const paired = devices.redeem(devices.mint(AT).code, "iPhone", PHONE, AT);
  assert.ok(paired.ok);

  assert.equal(devices.revoke("not-a-device"), false);
  assert.equal(devices.revoke(paired.device.id), true);
  assert.equal(devices.authenticate(paired.token), null);
  assert.deepEqual(devices.views(), []);
  assert.deepEqual(reopen().list(), []);
});

test("wrong codes shut the door on the phone that keeps trying", async (t) => {
  const { devices } = await store(t);
  devices.mint(AT);

  for (let attempt = 0; attempt < MAX_PAIRING_FAILURES; attempt += 1) {
    const refused = devices.redeem("WRONGONE", "iPhone", PHONE, AT);
    assert.equal(refused.ok === false && refused.code, "expired-code");
  }
  assert.equal(devices.locked(PHONE, AT), true);

  const code = devices.mint(AT);
  const locked = devices.redeem(code.code, "iPhone", PHONE, AT);
  assert.equal(locked.ok === false && locked.code, "rate-limited", "even the right code waits out the lockout");
  assert.equal(devices.locked("192.168.1.20", AT), false, "another phone is not punished for this one");

  const elsewhere = devices.redeem(code.code, "iPad", "192.168.1.20", AT);
  assert.equal(elsewhere.ok, true);
});

test("a scan with no code on screen is not a guess, so it never shuts the door", async (t) => {
  const { devices, file } = await store(t);
  for (let attempt = 0; attempt < MAX_PAIRING_FAILURES * 2; attempt += 1) devices.redeem("K7M2P9QX", "iPhone", PHONE, AT);
  assert.equal(devices.locked(PHONE, AT), false);
  const code = devices.mint(AT);
  assert.equal(devices.redeem(code.code, "iPhone", PHONE, AT).ok, true);
  assert.equal(await readFile(`${file}.tmp`, "utf8").catch(() => null), null, "the staging file was left behind");
});

test("a wrong guess leaves the code the user is looking at standing", async (t) => {
  const { devices } = await store(t);
  const code = devices.mint(AT);
  assert.equal(devices.redeem("WRONGONE", "iPhone", PHONE, AT).ok, false);
  assert.equal(devices.pending(AT)?.code, code.code, "one guess from anywhere cannot cancel a pairing");
  assert.equal(devices.redeem(code.code, "iPhone", "192.168.1.30", AT).ok, true);
  assert.equal(devices.pending(AT), null, "the code that bought a device is spent");
});

test("a part-count that has gone stale is forgotten rather than held for ever", async (t) => {
  const { devices } = await store(t);
  devices.mint(AT);
  for (let attempt = 0; attempt < MAX_PAIRING_FAILURES - 1; attempt += 1) devices.redeem("WRONGONE", "iPhone", PHONE, AT);
  assert.equal(devices.locked(PHONE, AT), false);

  const later = AT + PAIRING_LOCKOUT_MS + 1;
  devices.mint(later);
  devices.redeem("WRONGONE", "iPad", "10.0.0.99", later);
  devices.redeem("WRONGONE", "iPhone", PHONE, later);
  assert.equal(devices.locked(PHONE, later), false, "the count started again once it was as old as a lockout");
});

test("a phone that pairs clears whatever the failures before it counted", async (t) => {
  const { devices } = await store(t);
  const code = devices.mint(AT);
  devices.redeem("WRONGONE", "iPhone", PHONE, AT);
  devices.redeem("WRONGTWO", "iPhone", PHONE, AT);

  assert.equal(devices.redeem(code.code, "iPhone", PHONE, AT).ok, true);
  devices.mint(AT);
  for (let attempt = 0; attempt < MAX_PAIRING_FAILURES - 1; attempt += 1) devices.redeem("WRONGONE", "iPhone", PHONE, AT);
  assert.equal(devices.locked(PHONE, AT), false, "the count started again from the phone that got in");
  devices.redeem("WRONGONE", "iPhone", PHONE, AT);
  assert.equal(devices.locked(PHONE, AT), true, "the fresh code starts a full allowance of guesses");
});

function storedDevice(index: number) {
  return { id: `device-${index}`, kind: "phone", name: `Phone ${index}`, tokenHash: index.toString(16).padStart(64, "0"), pairedAt: AT, lastSeenAt: null };
}

test("a full computer says so and keeps the code standing for when a device is revoked", async (t) => {
  const { file, reopen } = await store(t);
  await writeFile(file, JSON.stringify({ version: 1, devices: Array.from({ length: MAX_PAIRED_DEVICES }, (_, index) => storedDevice(index)) }));
  const devices = reopen();
  const code = devices.mint(AT);

  const full = devices.redeem(code.code, "iPhone", PHONE, AT);
  assert.equal(full.ok, false);
  assert.match(full.ok === false ? full.message : "", /already paired with 16 devices/);
  assert.equal(devices.pending(AT)?.code, code.code, "the code is not spent on a pairing that could not happen");

  assert.equal(devices.revoke("device-0"), true);
  assert.equal(devices.redeem(code.code, "iPhone", PHONE, AT).ok, true);
});

test("a list that cannot be read is never written over, and is read again when a device knocks", async (t) => {
  const { file, reopen } = await store(t);
  /** A folder where the file should be fails the read with something other than "no such file". */
  await mkdir(file);
  const devices = reopen();
  assert.equal(devices.unreadable, true);
  const now = Date.now();
  const code = devices.mint(now);
  const refused = devices.redeem(code.code, "iPhone", PHONE, now);
  assert.equal(refused.ok === false && refused.code, "internal");
  assert.equal(devices.pending(now)?.code, code.code, "the code survives a list that could not be read");

  await rm(file, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, devices: [storedDevice(1)] }));
  const token = "x";
  assert.equal(devices.authenticate(token, Date.now()), null, "the list is not read again on every knock");
  devices.authenticate(token, Date.now() + 10_000);
  assert.equal(devices.unreadable, false);
  assert.deepEqual(devices.list().map((device) => device.id), ["device-1"]);
});

test("a damaged list is set aside rather than lost", async (t) => {
  const { file, reopen } = await store(t);
  await writeFile(file, "{ not json");
  const devices = reopen();
  assert.equal(devices.unreadable, false);
  assert.equal(await readFile(`${file}.damaged`, "utf8"), "{ not json");
  assert.equal(devices.redeem(devices.mint(AT).code, "iPhone", PHONE, AT).ok, true);
});

test("records this version cannot read are written back as they were", async (t) => {
  const { file, reopen } = await store(t);
  const future = { id: "tablet-1", kind: "tablet", name: "Tablet", tokenHash: "f".repeat(64), pairedAt: AT, lastSeenAt: null, extra: { kept: true } };
  await writeFile(file, JSON.stringify({ version: 1, devices: [storedDevice(1), future], note: "from a newer version" }));
  const devices = reopen();
  assert.deepEqual(devices.list().map((device) => device.id), ["device-1"]);
  assert.equal(devices.redeem(devices.mint(AT).code, "iPhone", PHONE, AT).ok, true);

  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written.devices.find((device: { id: string }) => device.id === "tablet-1"), future);
  assert.equal(written.note, "from a newer version");
  assert.equal(written.devices.length, 3);
});
