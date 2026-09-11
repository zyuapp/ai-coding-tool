import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { CUA_RELEASE } from "./cua-driver-version.mjs";
import {
  checkNativeReports, legalDirectory, normalized, projectRoot, readReceipt, receiptPath,
  reportDefinitions, reusableReport, sha256, target, ubjsBuildScript, ubjsBuildScriptSha256,
} from "./legal/native-reports.mjs";
import { atomicWrite, nativeTools, privateCache, run, sourceTree } from "./legal/native-tools.mjs";

async function verifyBuildInputs(cua) {
  if (sha256(await readFile(path.join(cua.directory, ubjsBuildScript))) !== ubjsBuildScriptSha256) {
    throw new Error("CUA's UBJS build transformation changed. Review its dependency/feature/license effects before updating ubjsBuildScriptSha256 in scripts/legal/native-reports.mjs.");
  }
  const manifest = JSON.parse(await readFile(path.join(cua.directory, "libs/cua-driver/typescript/package.json"), "utf8"));
  if (manifest.dependencies?.["@ubjs/core"] !== CUA_RELEASE.ubjsVersion
    || manifest.dependencies?.["@ubjs/node"] !== CUA_RELEASE.ubjsVersion
    || manifest.devDependencies?.["uniffi-bindgen-react-native"] !== CUA_RELEASE.ubjsVersion) {
    throw new Error("The CUA source and release pins disagree about the UBJS runtime version.");
  }
}

async function verifySourceVersions(definition, source) {
  const lock = parse(await readFile(path.join(source.directory, definition.lock), "utf8"));
  const version = definition.id === "cua"
    ? parse(await readFile(path.join(source.directory, "libs/cua-driver/rust/Cargo.toml"), "utf8")).workspace.package.version
    : JSON.parse(await readFile(path.join(source.directory, "package.json"), "utf8")).version;
  if (version !== definition.version) throw new Error(`${definition.id} source version ${version} differs from pin ${definition.version}.`);
  for (const [name, expected] of [["uniffi", CUA_RELEASE.uniffiVersion],
    ...(definition.id === "ubjs" ? [["libffi-sys", CUA_RELEASE.libffiSysVersion]] : [])]) {
    if (!lock.package.some((entry) => entry.name === name && entry.version === expected)) {
      throw new Error(`${definition.id} source does not lock ${name} ${expected}. Review release metadata.`);
    }
  }
}

async function reportConfig(definition, source, scratch) {
  if (definition.id === "ubjs" && sha256(await readFile(path.join(source.directory, "LICENSE")))
    !== "d1cc4c0ada218e8a336dc8c3d8bb7d5b1c8dedfa31f5b25c9ea1759d21b8b62d") {
    throw new Error("UBJS's source license changed. Review it before reusing the MPL clarification.");
  }
  const config = definition.config.replaceAll("{{MPL_PATH}}", path.join(legalDirectory, "MPL-2.0.txt"));
  const parsed = parse(config);
  // cargo-about may fall back after an invalid clarification. Our reviewed
  // exceptions must still match their source before any fallback is possible.
  for (const [crate, entry] of Object.entries(parsed)) {
    if (!entry?.clarify) continue;
    const directory = definition.id === "cua"
      ? path.join(source.directory, "libs/cua-driver/rust/crates", crate)
      : path.join(source.directory, "runtimes", crate === "uniffi-runtime-core" ? "core" : "napi");
    for (const file of entry.clarify.files) {
      if (sha256(await readFile(path.resolve(directory, file.path))) !== file.checksum) {
        throw new Error(`License clarification changed for ${crate}. Inspect its source license and update scripts/legal/native/${definition.id}.toml.`);
      }
    }
  }
  const configFile = path.join(scratch, `${definition.id}.toml`);
  await atomicWrite(configFile, config);
  return configFile;
}

async function generateReport(definition, source, tools, scratch) {
  await verifySourceVersions(definition, source);
  const config = await reportConfig(definition, source, scratch);
  const template = (await readFile(path.join(projectRoot, "scripts/legal/native/report.hbs"), "utf8"))
    .replace("{{REPORT_DESCRIPTION}}", definition.description);
  const templateFile = path.join(scratch, `${definition.id}.hbs`);
  await atomicWrite(templateFile, template);
  console.log(`Generating ${definition.file} from ${definition.commit}.`);
  const report = normalized(await run(tools.binary, [
    "generate", "--locked", "--fail", "--target", target,
    "--manifest-path", path.join(source.directory, definition.manifest),
    "--config", config, templateFile,
  ], { env: tools.env, cwd: source.directory }));
  if (!report.includes(definition.description) || !report.includes('<pre class="license-text">')) {
    throw new Error(`Incomplete output for ${definition.file}.`);
  }
  return {
    report,
    record: {
      inputs: definition.inputs, inputSha256: definition.inputSha256,
      sourceArchiveSha256: source.sourceArchiveSha256,
      lockSha256: sha256(await readFile(path.join(source.directory, definition.lock))),
      reportSha256: sha256(report), verifiedCuaCommit: CUA_RELEASE.sourceCommit,
    },
  };
}

export async function generateNativeReports({ force = false, cache = path.join(homedir(), ".cache", "ai-coding-tool", "native-licenses") } = {}) {
  const definitions = await reportDefinitions();
  const receipt = await readReceipt();
  const current = new Map(await Promise.all(definitions.map(async (definition) => [
    definition.id, await readFile(path.join(legalDirectory, definition.file), "utf8").catch(() => null),
  ])));
  if (!force && definitions.every((definition) => reusableReport(definition, receipt.reports[definition.id], current.get(definition.id))
    && receipt.reports[definition.id].verifiedCuaCommit === CUA_RELEASE.sourceCommit)) {
    console.log("Native reports verified; both reused without downloads or Rust tooling.");
    return;
  }
  cache = await privateCache(cache);
  const scratch = await mkdtemp(path.join(cache, "run-"));
  const next = { schema: 1, reports: {} };
  const results = new Map();
  let tools;
  try {
    const cua = await sourceTree(definitions[0], cache, scratch, receipt.reports.cua);
    await verifyBuildInputs(cua);
    for (const definition of definitions) {
      const old = receipt.reports[definition.id];
      if (!force && reusableReport(definition, old, current.get(definition.id))) {
        next.reports[definition.id] = { ...old, verifiedCuaCommit: CUA_RELEASE.sourceCommit };
        console.log(`Reusing ${definition.file}; source, build transformation, recipe, and report checksum match.`);
        continue;
      }
      const cachedDirectory = path.join(cache, "reports", definition.inputSha256);
      const cachedRecord = await readFile(path.join(cachedDirectory, "receipt.json"), "utf8").then(JSON.parse).catch(() => null);
      const cachedReport = await readFile(path.join(cachedDirectory, "report.html"), "utf8").catch(() => null);
      if (!force && reusableReport(definition, cachedRecord, cachedReport)) {
        results.set(definition.id, cachedReport);
        next.reports[definition.id] = { ...cachedRecord, verifiedCuaCommit: CUA_RELEASE.sourceCommit };
        console.log(`Restoring verified ${definition.file} from cache.`);
        continue;
      }
      const source = definition.id === "cua" ? cua : await sourceTree(definition, cache, scratch, old);
      tools ??= await nativeTools(cache);
      const { report, record } = await generateReport(definition, source, tools, scratch);
      results.set(definition.id, report);
      next.reports[definition.id] = record;
      await atomicWrite(path.join(cachedDirectory, "report.html"), report);
      await atomicWrite(path.join(cachedDirectory, "receipt.json"), `${JSON.stringify(record, null, 2)}\n`);
    }
    // Resolve both reports successfully before changing any checked-in output.
    for (const definition of definitions) {
      const report = results.get(definition.id);
      if (report && report !== current.get(definition.id)) await atomicWrite(path.join(legalDirectory, definition.file), report);
    }
    await atomicWrite(receiptPath, `${JSON.stringify(next, null, 2)}\n`);
    await checkNativeReports();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--force")) throw new Error("Usage: npm run generate:native-licenses -- [--force]");
  await generateNativeReports({ force: process.argv.includes("--force"), ...(process.env.NATIVE_LICENSE_CACHE ? { cache: path.resolve(process.env.NATIVE_LICENSE_CACHE) } : {}) });
}
