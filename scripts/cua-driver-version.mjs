import { readFileSync } from "node:fs";

const project = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

export function lockedPackageVersion(name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (typeof version !== "string") throw new Error(`${name} is missing from package-lock.json.`);
  return version;
}

export const CUA_DRIVER_VERSION = lockedPackageVersion("@trycua/cua-driver");
export const UBJS_VERSION = lockedPackageVersion("@ubjs/core");
export const ANTHROPIC_AGENT_SDK_VERSION = lockedPackageVersion("@anthropic-ai/claude-agent-sdk");
export const ELECTRON_VERSION = lockedPackageVersion("electron");

if (project.dependencies?.["@trycua/cua-driver"] !== CUA_DRIVER_VERSION) {
  throw new Error("@trycua/cua-driver must stay exactly pinned to the resolved version.");
}
if (lockedPackageVersion("@ubjs/node") !== UBJS_VERSION) throw new Error("The UBJS packages must resolve to the same version.");

const releases = {
  "0.22.2": {
    sourceCommit: "d114f35fec05ecd37bf529e5587be86852205b64",
    archiveSha256: "ac05a34ff2416830ec56f44d9986cf04ffb1f6a15a5df6f4dd9bec13ac198d63",
    ubjsVersion: "0.31.0-3",
    ubjsCommit: "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449",
    uniffiVersion: "0.31.0",
    uniffiCommit: "309762f55db3f0548194a9ceba3027fa64b18a93",
    libffiVersion: "3.5.2",
    libffiSysVersion: "4.1.0",
  },
  "0.23.2": {
    sourceCommit: "e88e9d899ac5effaeae38619527ebaa46b26ce72",
    archiveSha256: "c606a0410eb1bf59ee81d697f6fbf8b7126b2e9a3f802272a34807b45b6ecd6f",
    ubjsVersion: "0.31.0-3",
    ubjsCommit: "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449",
    uniffiVersion: "0.31.0",
    uniffiCommit: "309762f55db3f0548194a9ceba3027fa64b18a93",
    libffiVersion: "3.5.2",
    libffiSysVersion: "4.1.0",
  },
};

export const CUA_RELEASE = releases[CUA_DRIVER_VERSION];
if (!CUA_RELEASE) throw new Error(`Add verified release metadata before packaging CUA ${CUA_DRIVER_VERSION}.`);
if (CUA_RELEASE.ubjsVersion !== UBJS_VERSION) {
  throw new Error(`CUA ${CUA_DRIVER_VERSION} expects UBJS ${CUA_RELEASE.ubjsVersion}, not ${UBJS_VERSION}.`);
}
