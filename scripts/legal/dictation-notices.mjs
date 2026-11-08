/**
 * The notices for the Swift packages linked into the dictation helper. Written from the checked-out
 * sources when the helper is built, and checked against the pinned versions without them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const resolvedFile = path.join(root, "native", "dictation", "Package.resolved");
const checkouts = path.join(root, "native", "dictation", ".build", "checkouts");
export const DICTATION_NOTICES = "DICTATION-SWIFT-DEPENDENCIES.txt";
const noticesFile = path.join(root, "assets", "legal", DICTATION_NOTICES);

async function pins() {
  const { pins: list } = JSON.parse(await readFile(resolvedFile, "utf8"));
  return list.map((pin) => ({ identity: pin.identity, location: pin.location, version: pin.state.version ?? pin.state.revision }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
}

function heading(pin) {
  return `${pin.identity} ${pin.version}`;
}

/** The checkout SwiftPM made for a pin, whose folder keeps the repository's own capitalisation. */
function checkoutOf(pin) {
  const name = readdirSync(checkouts).find((entry) => entry.toLowerCase() === pin.identity);
  if (!name) throw new Error(`Build the dictation helper first: no checkout of ${pin.identity}.`);
  return path.join(checkouts, name);
}

export async function writeDictationNotices() {
  if (!existsSync(checkouts)) return;
  let output = `Dictation helper Swift packages
===============================

The aic-dictation helper links the Swift packages below, at the versions in
native/dictation/Package.resolved. Each package's license and notice files
follow its name.
`;
  for (const pin of await pins()) {
    const folder = checkoutOf(pin);
    const files = readdirSync(folder).filter((entry) => /^(LICENSE|COPYING|NOTICE)/i.test(entry)).sort();
    if (!files.some((file) => /^(LICENSE|COPYING)/i.test(file))) throw new Error(`${pin.identity} has no license file.`);
    output += `\n${heading(pin)}\n${"-".repeat(heading(pin).length)}\n\nSource: ${pin.location}\n`;
    for (const file of files) output += `\n${(await readFile(path.join(folder, file), "utf8")).trim()}\n`;
  }
  await writeFile(noticesFile, output);
}

export async function checkDictationNotices() {
  const value = await readFile(noticesFile, "utf8").catch(() => "");
  const missing = (await pins()).filter((pin) => !value.includes(`\n${heading(pin)}\n`));
  if (missing.length) throw new Error(`${DICTATION_NOTICES} is stale: ${missing.map(heading).join(", ")}. Build the dictation helper to rewrite it.`);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) await writeDictationNotices();
