import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bundleIcon, pngInIcns } from "../../src/main/bundle-icon.ts";

/** A PNG that is only a header: an IHDR wide enough to sort by, which is all the reader looks at. */
function png(width: number) {
  const data = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  return data;
}

/** An `.icns` holding the records given, in the order given. */
function icns(records: Array<[string, Buffer]>) {
  const parts = records.map(([type, payload]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32BE(payload.length + 8, 4);
    return Buffer.concat([header, payload]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  const body = Buffer.concat(parts);
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

test("the reader takes the smallest icon a menu row can use", () => {
  const chosen = pngInIcns(icns([["ic13", png(256)], ["ic11", png(32)], ["ic07", png(128)]]));

  assert.equal(chosen?.readUInt32BE(16), 32);
});

test("a bundle with nothing that big gives up its widest icon", () => {
  const chosen = pngInIcns(icns([["icp4", png(16)], ["icp5", png(24)]]));

  assert.equal(chosen?.readUInt32BE(16), 24);
});

test("the packed formats an icns also holds are skipped", () => {
  assert.equal(pngInIcns(icns([["ic04", Buffer.alloc(64, 7)], ["TOC ", Buffer.alloc(32, 1)]])), null);
  assert.equal(pngInIcns(Buffer.from("not an icns at all")), null, "a file that is not an icns has no icon");
  assert.equal(pngInIcns(Buffer.alloc(4)), null, "and neither has one too short to hold a header");
});

/** Builds a bundle on disk: the property list, the resources folder, and the icon it names. */
async function bundle(options: { plist: string; icons: Record<string, Buffer> }) {
  const root = await mkdtemp(path.join(tmpdir(), "aicodingtool-bundle-"));
  const app = path.join(root, "Example.app");
  await mkdir(path.join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(path.join(app, "Contents", "Info.plist"), options.plist);
  for (const [name, data] of Object.entries(options.icons)) {
    await writeFile(path.join(app, "Contents", "Resources", name), data);
  }
  return app;
}

const PLIST = (icon: string) => `<?xml version="1.0"?>\n<plist><dict><key>CFBundleIconFile</key><string>${icon}</string></dict></plist>`;

test("a bundle is read at its word about which icon is its own", async () => {
  const app = await bundle({
    plist: PLIST("Example.icns"),
    icons: { "Example.icns": icns([["ic11", png(32)]]), "other.icns": icns([["ic11", png(64)]]) },
  });

  const url = await bundleIcon(app);
  assert.ok(url);
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.equal(Buffer.from(url.split(",")[1], "base64").readUInt32BE(16), 32, "the named icon wins over the other one");
});

test("an icon named without its extension is still found", async () => {
  const app = await bundle({ plist: PLIST("Example"), icons: { "Example.icns": icns([["ic11", png(32)]]) } });

  assert.ok(await bundleIcon(app));
});

test("a bundle that names none gives up its only icon, and never one of several", async () => {
  const alone = await bundle({ plist: "<plist><dict/></plist>", icons: { "Example.icns": icns([["ic11", png(32)]]) } });
  assert.ok(await bundleIcon(alone));

  const many = await bundle({
    plist: "<plist><dict/></plist>",
    icons: { "a.icns": icns([["ic11", png(32)]]), "b.icns": icns([["ic11", png(32)]]) },
  });
  assert.equal(await bundleIcon(many), null, "guessing between file-type icons would show the wrong one");
});

test("a bundle whose icon is missing or unreadable simply has none", async () => {
  const gone = await bundle({ plist: PLIST("Missing.icns"), icons: {} });
  assert.equal(await bundleIcon(gone), null);

  const broken = await bundle({ plist: PLIST("Example.icns"), icons: { "Example.icns": Buffer.from("rubbish") } });
  assert.equal(await bundleIcon(broken), null);

  assert.equal(await bundleIcon("/no/such/bundle.app"), null);
});
