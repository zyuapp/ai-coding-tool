import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CUA_DRIVER_VERSION, CUA_RELEASE, UBJS_VERSION } from "../cua-driver-version.mjs";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const receiptPath = path.join(projectRoot, "scripts/legal/native-reports.lock.json");
export const legalDirectory = path.join(projectRoot, "assets/legal");
export const target = "aarch64-apple-darwin";
export const toolchain = "1.97.1";
export const cargoAboutVersion = "0.9.2";
// This transformation changes buffer ownership, not the native dependency graph.
// A changed transformation needs review before the upstream UBJS graph can be reused.
export const ubjsBuildScriptSha256 = "db02ec1345edbf6090f0093ddae3bd41d624d2984af58bcdce3a66cfcad373dc";
export const ubjsBuildScript = "libs/cua-driver/scripts/build-node-runtime.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const normalized = (text) => `${text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim()}\n`;

export async function reportDefinitions() {
  const commonFiles = [
    "scripts/generate-native-legal-notices.mjs", "scripts/legal/native-reports.mjs",
    "scripts/legal/native-tools.mjs", "scripts/legal/native/report.hbs",
  ];
  const common = await Promise.all(commonFiles.map(async (file) => [file, sha256(await readFile(path.join(projectRoot, file)))]));
  const definitions = [
    {
      id: "cua", file: "CUA-RUST-DEPENDENCIES.html", repository: "trycua/cua",
      commit: CUA_RELEASE.sourceCommit, version: CUA_DRIVER_VERSION,
      manifest: "libs/cua-driver/rust/crates/cua-driver/Cargo.toml", lock: "libs/cua-driver/rust/Cargo.lock",
      description: `This page lists the licenses of the Rust projects linked into CUA Driver ${CUA_DRIVER_VERSION} for macOS arm64.`,
    },
    {
      id: "ubjs", file: "UBJS-NATIVE-DEPENDENCIES.html", repository: "jhugman/uniffi-bindgen-react-native",
      commit: CUA_RELEASE.ubjsCommit, version: UBJS_VERSION,
      manifest: "runtimes/napi/Cargo.toml", lock: "Cargo.lock",
      description: `Rust and C projects linked into UniFFI JavaScript runtime ${UBJS_VERSION} for macOS arm64.`,
    },
  ];
  return Promise.all(definitions.map(async (definition) => {
    const config = await readFile(path.join(projectRoot, `scripts/legal/native/${definition.id}.toml`), "utf8");
    const inputs = {
      repository: definition.repository, commit: definition.commit, version: definition.version,
      manifest: definition.manifest, target, defaultFeatures: true, features: [],
      ignoreBuildDependencies: true, ignoreDevDependencies: true,
      toolchain, cargoAboutVersion,
      uniffiCommit: CUA_RELEASE.uniffiCommit, uniffiVersion: CUA_RELEASE.uniffiVersion,
      ...(definition.id === "ubjs" ? {
        libffiVersion: CUA_RELEASE.libffiVersion, libffiSysVersion: CUA_RELEASE.libffiSysVersion,
        buildScriptSha256: ubjsBuildScriptSha256,
        mplSha256: sha256(await readFile(path.join(legalDirectory, "MPL-2.0.txt"))),
      } : {}),
      recipeSha256: sha256(JSON.stringify([...common, ["config", sha256(config)]])),
    };
    return { ...definition, config, inputs, inputSha256: sha256(JSON.stringify(inputs)) };
  }));
}

export function reusableReport(definition, record, text) {
  return Boolean(record && record.inputSha256 === definition.inputSha256
    && sha256(JSON.stringify(record.inputs)) === definition.inputSha256
    && /^[a-f0-9]{64}$/.test(record.sourceArchiveSha256)
    && /^[a-f0-9]{64}$/.test(record.lockSha256)
    && typeof text === "string" && text.length > 0 && sha256(text) === record.reportSha256);
}

export async function readReceipt(file = receiptPath) {
  try {
    const receipt = JSON.parse(await readFile(file, "utf8"));
    return receipt.schema === 1 ? receipt : { schema: 1, reports: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { schema: 1, reports: {} };
    throw error;
  }
}

/** Fast, offline validation, shared by development and packaged-artifact checks. */
export async function checkNativeReports(directory = legalDirectory) {
  const receipt = await readReceipt();
  for (const definition of await reportDefinitions()) {
    const text = await readFile(path.join(directory, definition.file), "utf8").catch(() => null);
    const record = receipt.reports[definition.id];
    if (!reusableReport(definition, record, text) || record.verifiedCuaCommit !== CUA_RELEASE.sourceCommit) {
      throw new Error(`${definition.file} has unverified inputs or content. Run npm run generate:native-licenses.`);
    }
  }
}
