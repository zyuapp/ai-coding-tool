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
  "0.25.0": {
    sourceCommit: "45d78fedcf2c7033ba33f10dd30f8af8ba31ec3f",
    archiveSha256: "48fb4c329987f66ea9b76d47e6fc19bf8618309afb96d53755e1a6a937025d5c",
    // Linux preparation downloads the -binary archives, not the full platform archives.
    linuxX64ArchiveSha256: "7468132a7830bec8a0369aa04bf548a1f0a64caef0c284e9b2b3938e7cf16d86",
    linuxArm64ArchiveSha256: "e8556a6c8dbf1b2531206465bacb02a541bee859bb1cd16cc8db56593e2313cf",
    ubjsVersion: "0.31.0-3",
    ubjsCommit: "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449",
    uniffiVersion: "0.31.0",
    uniffiCommit: "309762f55db3f0548194a9ceba3027fa64b18a93",
    libffiVersion: "3.5.2",
    libffiSysVersion: "4.1.0",
  },
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
    linuxX64ArchiveSha256: "01bf8339ec129cc00f4b4b2c6056ef1a7c5b52df39ff83ad17c9b16818aec500",
    linuxArm64ArchiveSha256: "be22768a207796a4bc1de50c52f32f9ef680b5e86e58c059e02eec2caba2e7bb",
    ubjsVersion: "0.31.0-3",
    ubjsCommit: "dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449",
    uniffiVersion: "0.31.0",
    uniffiCommit: "309762f55db3f0548194a9ceba3027fa64b18a93",
    libffiVersion: "3.5.2",
    libffiSysVersion: "4.1.0",
  },
  "0.24.0": {
    sourceCommit: "4b3396d9fe4bd3cf723b0eb8db83c18a8764b520",
    archiveSha256: "fd0cf565db831ad34d44a3c2321439575e02a6ce3ca97d04f267db1da7883685",
    linuxX64ArchiveSha256: "b3b8ff52595feb111219aa0ac90e3b36618cc686aa8205aed4f3e7e1a67c7b64",
    linuxArm64ArchiveSha256: "2c526bf14fb81a46db19d242ddd2e0be766bc1ce1082ed8a708ad235de74a28e",
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
