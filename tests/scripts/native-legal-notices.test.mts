import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

// @ts-expect-error Legal generation and packaging use plain JavaScript.
const { checkNativeReports, legalDirectory, readReceipt, reportDefinitions, reusableReport, sha256 } = await import("../../scripts/legal/native-reports.mjs");
// @ts-expect-error Legal generation and packaging use plain JavaScript.
const { generateNativeReports } = await import("../../scripts/generate-native-legal-notices.mjs");
// @ts-expect-error Legal generation and packaging use plain JavaScript.
const { download } = await import("../../scripts/legal/native-tools.mjs");

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aic-native-licenses-"));
  roots.push(root);
  return root;
}

test("unchanged verified reports work without creating a tooling or download cache", async () => {
  const cache = path.join(await temporaryRoot(), "empty-cache");
  await generateNativeReports({ cache });
  await assert.rejects(stat(cache), { code: "ENOENT" });
});

test("reuse rejects changed sources, graph settings, license recipes, or report content", async () => {
  const [definition] = await reportDefinitions();
  const record = (await readReceipt()).reports.cua;
  const report = await readFile(path.join(legalDirectory, definition.file), "utf8");
  assert.ok(reusableReport(definition, record, report));
  for (const change of [
    { commit: "a".repeat(40) }, { target: "x86_64-unknown-linux-gnu" },
    { features: ["new-native-dependency"] }, { recipeSha256: "b".repeat(64) },
  ]) {
    const inputs = { ...definition.inputs, ...change };
    const updated = { ...definition, inputs, inputSha256: sha256(JSON.stringify(inputs)) };
    assert.equal(reusableReport(updated, record, report), false);
  }
  assert.equal(reusableReport(definition, record, report.replace("Permission is hereby granted", "Altered permission")), false);
  assert.equal(reusableReport(definition, { ...record, inputs: { ...record.inputs, commit: "a".repeat(40) } }, report), false);
});

test("offline validation detects removed license text even when all version labels remain", async () => {
  const directory = path.join(await temporaryRoot(), "legal");
  await cp(legalDirectory, directory, { recursive: true });
  await checkNativeReports(directory);
  const file = path.join(directory, "CUA-RUST-DEPENDENCIES.html");
  const report = await readFile(file, "utf8");
  await writeFile(file, report.replace(/<pre class="license-text">[\s\S]*?<\/pre>/, ""));
  await assert.rejects(checkNativeReports(directory), /unverified inputs or content/);
});

test("downloads reuse verified bytes, repair corrupt cache, and reject mismatched archives", async () => {
  const root = await temporaryRoot();
  const source = path.join(root, "source");
  const cached = path.join(root, "cached");
  const good = "verified source archive";
  const digest = sha256(good);
  await writeFile(cached, good);
  // A missing origin proves a valid cache entry requires no request.
  await download(pathToFileURL(source).href, cached, digest);
  await writeFile(source, good);
  await writeFile(cached, "corrupted");
  await download(pathToFileURL(source).href, cached, digest);
  assert.equal(await readFile(cached, "utf8"), good);
  await writeFile(source, "unexpected upstream bytes");
  await assert.rejects(download(pathToFileURL(source).href, cached, "a".repeat(64)), /Checksum mismatch/);
  assert.equal(await readFile(cached, "utf8"), good);
});
