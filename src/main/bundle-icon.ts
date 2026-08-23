import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** An `.icns` starts with its magic and total length, then one record per size. */
const ICNS_MAGIC = "icns";
const ICNS_HEADER = 8;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The smallest icon worth taking for a 16 point row, which a Retina screen draws at 32 pixels. */
const WANTED_WIDTH = 32;

function isPng(record: Buffer) {
  return record.length > 24 && PNG_MAGIC.every((byte, index) => record[index] === byte);
}

/** A PNG says how wide it is in the IHDR chunk, which always comes first. */
function pngWidth(record: Buffer) {
  return record.readUInt32BE(16);
}

/**
 * The PNG inside an `.icns` that suits a menu row: the smallest one at least {@link WANTED_WIDTH}
 * across, else the widest there is. An `.icns` also holds older packed formats, which are skipped.
 */
export function pngInIcns(data: Buffer): Buffer | null {
  if (data.length < ICNS_HEADER || data.toString("latin1", 0, 4) !== ICNS_MAGIC) return null;
  let best: Buffer | null = null;
  let offset = ICNS_HEADER;
  while (offset + ICNS_HEADER <= data.length) {
    const length = data.readUInt32BE(offset + 4);
    if (length < ICNS_HEADER) break;
    const record = data.subarray(offset + ICNS_HEADER, offset + length);
    offset += length;
    if (!isPng(record)) continue;
    if (!best) { best = record; continue; }
    const width = pngWidth(record);
    const chosen = pngWidth(best);
    const better = chosen < WANTED_WIDTH ? width > chosen : width >= WANTED_WIDTH && width < chosen;
    if (better) best = record;
  }
  return best;
}

/** The icon a bundle names for itself. The extension is left off often enough to add it back. */
function namedIcon(plist: string) {
  const named = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
  if (!named) return null;
  return named.toLowerCase().endsWith(".icns") ? named : `${named}.icns`;
}

/**
 * The icon file to read. A bundle that names one is taken at its word; one that does not, or whose
 * property list is binary, gives up its only `.icns` when it has exactly one.
 */
async function iconPath(bundle: string) {
  const resources = path.join(bundle, "Contents", "Resources");
  const plist = await readFile(path.join(bundle, "Contents", "Info.plist"), "utf8").catch(() => "");
  const named = namedIcon(plist);
  if (named) return path.join(resources, named);
  const found = (await readdir(resources).catch(() => [])).filter((entry) => entry.toLowerCase().endsWith(".icns"));
  return found.length === 1 ? path.join(resources, found[0]) : null;
}

/** A macOS bundle's own icon as a data URL, or null when it keeps one nothing here can read. */
export async function bundleIcon(bundle: string) {
  const target = await iconPath(bundle);
  if (!target) return null;
  const data = await readFile(target).catch(() => null);
  const png = data && pngInIcns(data);
  return png ? `data:image/png;base64,${png.toString("base64")}` : null;
}
